import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import { db, schema, type Db } from '../db/client.ts';
import { problems, isUniqueViolation } from '../lib/errors.ts';
import { notifyCanvas } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { assignStateKeys, surfaceStatesSchema, L, MAX_SURFACES, type DeviceType, type SurfaceDto, type SurfaceStates, type SurfaceStatesInput } from '@quilt/core';
import { archiveSurface, saveArchive } from './record.ts';

// 端（REQ-CORE-049 / API-CORE-054，ADR-040）：项目下的一端有自己的名字、设备与一组屏；端上的维度与事件（REQ-CORE-051）也记在这一行。
// 普通项目至少一端（INV-CORE-008），草稿本没有端。
// 项目与屏的服务反过来要用这里的读取（详情、建项目），所以它们在写操作里动态引入，静态 import 图不成环
const ownedProject = async (ownerId: string, projectId: string) => (await import('./projects.ts')).ownedProject(ownerId, projectId);

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
export type SurfaceRow = typeof schema.surfaces.$inferSelect;

export const surfaceDto = (s: SurfaceRow): SurfaceDto => ({ id: s.id, projectId: s.projectId, name: s.name, deviceType: s.deviceType as DeviceType, position: s.position, states: s.states as SurfaceStates, version: s.version });

export const surfacesOf = (projectId: string, tx: Tx = db): Promise<SurfaceRow[]> =>
  tx.select().from(schema.surfaces).where(eq(schema.surfaces.projectId, projectId)).orderBy(asc(schema.surfaces.position), asc(schema.surfaces.createdAt));

/** 新屏落在哪一端：给了就得是本项目的（否则 404），没给取第一端 */
export async function surfaceFor(projectId: string, surfaceId?: string | null, tx: Tx = db): Promise<SurfaceRow> {
  if (surfaceId) {
    const [s] = await tx.select().from(schema.surfaces).where(and(eq(schema.surfaces.id, surfaceId), eq(schema.surfaces.projectId, projectId)));
    if (!s) throw problems.notFound();
    return s;
  }
  const [first] = await surfacesOf(projectId, tx);
  if (!first) throw problems.notFound();
  return first;
}

/** 建项目时的第一端（API-CORE-003）：手机叫 App、桌面叫 Web */
export async function insertFirstSurface(tx: Tx, projectId: string, deviceType: DeviceType): Promise<SurfaceRow> {
  const [s] = await tx.insert(schema.surfaces).values({ projectId, name: deviceType === 'desktop' ? 'Web' : 'App', deviceType, position: 0 }).returning();
  return s;
}

async function ownedSurface(ownerId: string, surfaceId: string): Promise<SurfaceRow> {
  const [s] = await db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId));
  if (!s) throw problems.notFound();
  await ownedProject(ownerId, s.projectId);
  return s;
}

export async function createSurface(ownerId: string, projectId: string, input: { name: string; deviceType: DeviceType }): Promise<SurfaceRow> {
  const project = await ownedProject(ownerId, projectId);
  if (project.kind !== 'app') throw problems.notFound();
  let created: SurfaceRow;
  try {
    created = await db.transaction(async (tx) => {
      // 锁项目行：两个请求同时加端时数到的是同一个数，第 7 端就会漏过上限
      await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
      const all = await surfacesOf(project.id, tx);
      if (all.length >= MAX_SURFACES) throw problems.validation([{ path: 'name', message: L(`一个项目最多 ${MAX_SURFACES} 端`, `A project can have at most ${MAX_SURFACES} surfaces`) }]);
      const position = all.reduce((m, s) => Math.max(m, s.position + 1), 0);
      const [s] = await tx.insert(schema.surfaces).values({ projectId: project.id, name: input.name, deviceType: input.deviceType, position }).returning();
      await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, project.id));
      return s;
    });
  } catch (e) { if (isUniqueViolation(e)) throw problems.surfaceNameTaken(); throw e; }
  await notifyCanvas(project.id, { reason: 'surfaces' });
  return created;
}

// 改名与改维度（API-CORE-054）：states 整份替换，缺的键由名字转出、已有的键不变，没提交的维度标 retired 留着（ADR-041）；不建修订。
// 条件更新 WHERE version = expectedVersion：两个标签页同时改，后到的 409（§16「两个标签页同时改同一端」）
export async function updateSurface(ownerId: string, surfaceId: string, patch: { name?: string; states?: SurfaceStatesInput; expectedVersion: number }): Promise<SurfaceRow> {
  const surface = await ownedSurface(ownerId, surfaceId);
  let states: SurfaceStates | undefined;
  if (patch.states) {
    const next = surfaceStatesSchema.safeParse(assignStateKeys(patch.states, surface.states as SurfaceStates));
    if (!next.success) throw problems.validation(next.error.issues.map((i) => ({ path: ['states', ...i.path].join('.'), message: i.message })));
    states = next.data;
  }
  let updated: SurfaceRow | undefined;
  try {
    [updated] = await db.update(schema.surfaces)
      .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(states ? { states } : {}), version: sql`${schema.surfaces.version} + 1`, updatedAt: new Date() })
      .where(and(eq(schema.surfaces.id, surface.id), eq(schema.surfaces.version, patch.expectedVersion))).returning();
  } catch (e) { if (isUniqueViolation(e)) throw problems.surfaceNameTaken(); throw e; }
  if (!updated) throw problems.versionConflict(L('这一端', 'Surface'));
  await notifyCanvas(surface.projectId, { reason: 'surfaces' });
  return updated;
}

// 这一端上在跑的作业：目标屏在这一端的改屏与只改一块、input.surfaceId 是它的造屏与建议状态（§16「删端时这一端有屏在改」）
async function surfaceBusy(tx: Tx, projectId: string, surfaceId: string, screenIds: string[]): Promise<boolean> {
  const active = await tx.select({ kind: schema.generationJobs.kind, input: schema.generationJobs.input, target: schema.generationJobs.targetScreenId }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.projectId, projectId), inArray(schema.generationJobs.status, ['queued', 'running'])));
  const mine = new Set(screenIds);
  return active.some((j) => {
    const input = (j.input ?? {}) as { surfaceId?: string; screenIds?: string[] | 'all'; screenId?: string };
    if (j.target && mine.has(j.target)) return true;
    if (input.surfaceId === surfaceId) return true;
    if (Array.isArray(input.screenIds) && input.screenIds.some((id) => mine.has(id))) return true;
    return j.kind === 'apply_design_system' && input.screenIds === 'all';
  });
}

// 删端（API-CORE-054）：连这一端的屏、修订与连线一起删（外键级联），对象按屏的前缀清；样板屏在这一端时清空。
// 同一事务里先锁端行再查在跑的作业；项目只剩这一端时拒绝（INV-CORE-008）
export async function deleteSurface(ownerId: string, surfaceId: string): Promise<void> {
  const surface = await ownedSurface(ownerId, surfaceId);
  const screenIds = (await db.select({ id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.surfaceId, surface.id))).map((r) => r.id);
  const archive = await archiveSurface(surface.projectId, surface, screenIds);
  const { clearExemplarIfDeleted, deriveLinks } = await import('./screens.ts');
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: schema.surfaces.id }).from(schema.surfaces).where(eq(schema.surfaces.id, surface.id)).for('update');
    if (!locked) throw problems.notFound();
    if ((await surfacesOf(surface.projectId, tx)).length <= 1) throw problems.validation([{ path: 'surfaceId', message: L('项目至少要有一端', 'A project needs at least one surface') }]);
    if (await surfaceBusy(tx, surface.projectId, surface.id, screenIds)) throw problems.screenBusy();
    await tx.delete(schema.surfaces).where(eq(schema.surfaces.id, surface.id));
    for (const id of screenIds) await clearExemplarIfDeleted(tx, surface.projectId, id);
    await deriveLinks(tx, surface.projectId);
    await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, surface.projectId));
  });
  await saveArchive(archive);
  for (const id of screenIds) await storage.deletePrefix(`projects/${surface.projectId}/screens/${id}/`).catch((e) => console.warn(`[delete surface] ${id}: ${(e as Error).message}`));
  await notifyCanvas(surface.projectId, { reason: 'surfaces' });
}
