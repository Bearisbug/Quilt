import { and, eq, desc, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { db, schema, type Db } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { config } from '../config.ts';
import { signPreview, stableExpiry } from '../lib/signing.ts';
import { extractLinks, extractBody, outlineBody, type RevisionDto, type SourceKind, type CandidatesDto, DEVICE_SIZE, type DeviceType } from '@quilt/core';
import { ownedProject, type ScreenRow, type RevisionRow, type ProjectRow } from './projects.ts';

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function ownedScreen(ownerId: string, screenId: string): Promise<{ screen: ScreenRow; project: Awaited<ReturnType<typeof ownedProject>> }> {
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
  if (!screen) throw problems.notFound();
  const project = await ownedProject(ownerId, screen.projectId);
  return { screen, project };
}

export async function hasActiveJob(tx: Tx, projectId: string, screenId: string): Promise<boolean> {
  const rows = await tx.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.targetScreenId, screenId), inArray(schema.generationJobs.status, ['queued', 'running'])));
  return rows.length > 0;
}

// 新修订（ADR-014 修订树）：先锁屏行再取号——并行落候选时两笔事务会算出同一 seq 撞唯一键（RUN-059）。
// parentRevisionId 默认取此刻的 current；候选批要显式传同一个父版（第 1 版落库后 current 已变）。
// advanceCurrent=false 只落修订不推进 current（候选批由调用方在全部落完后统一指向第 1 版）。
// 返回 null 表示 expectedRevisionId 已过期。
export async function createRevision(tx: Tx, args: {
  projectId: string; screenId: string; html: string; sourceKind: SourceKind; jobId?: string | null; lintReport: unknown;
  expectedRevisionId?: string | null; parentRevisionId?: string | null; candidateIndex?: number | null; advanceCurrent?: boolean;
}): Promise<RevisionRow | null> {
  const [screen] = await tx.select().from(schema.screens).where(eq(schema.screens.id, args.screenId)).for('update');
  if (!screen) return null;
  if (args.expectedRevisionId !== undefined && (screen.currentRevisionId ?? null) !== args.expectedRevisionId) return null;
  const [{ seq }] = await tx.select({ seq: sql<number>`coalesce(max(${schema.screenRevisions.seq}), 0) + 1` }).from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, args.screenId));
  const id = crypto.randomUUID();
  const htmlKey = objectKeys.revisionHtml(args.projectId, args.screenId, id);
  await storage.put(htmlKey, args.html, 'text/html; charset=utf-8');
  const [rev] = await tx.insert(schema.screenRevisions).values({
    id, screenId: args.screenId, seq, htmlKey, sourceKind: args.sourceKind, jobId: args.jobId ?? null, lintReport: args.lintReport as object,
    parentRevisionId: args.parentRevisionId === undefined ? screen.currentRevisionId : args.parentRevisionId,
    candidateIndex: args.candidateIndex ?? null,
  }).returning();
  if (args.advanceCurrent !== false) await tx.update(schema.screens).set({ currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(schema.screens.id, args.screenId));
  return rev;
}

// 候选批落完后把 current 指向序号最小的那一版（REQ-CORE-015：current 默认第 1 版，不选也不阻塞连线 / 导出）
export async function pointCurrentToFirstCandidate(tx: Tx, screenId: string, jobId: string): Promise<void> {
  const [first] = await tx.select({ id: schema.screenRevisions.id }).from(schema.screenRevisions)
    .where(and(eq(schema.screenRevisions.screenId, screenId), eq(schema.screenRevisions.jobId, jobId), isNotNull(schema.screenRevisions.candidateIndex)))
    .orderBy(schema.screenRevisions.candidateIndex).limit(1);
  if (first) await tx.update(schema.screens).set({ currentRevisionId: first.id, updatedAt: new Date() }).where(eq(schema.screens.id, screenId));
}

// 采用候选（API-CORE-025）：只改 current 指针、结清同批；current 已不属同批（用户在某版上继续改了）则拒绝，不顶掉他的改动
export async function adoptCandidate(tx: Tx, screen: ScreenRow, revisionId: string): Promise<void> {
  const [rev] = await tx.select().from(schema.screenRevisions).where(and(eq(schema.screenRevisions.id, revisionId), eq(schema.screenRevisions.screenId, screen.id)));
  if (!rev || rev.candidateIndex === null || !rev.jobId) throw problems.notFound();
  const [cur] = screen.currentRevisionId ? await tx.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId)) : [];
  if (!cur || cur.jobId !== rev.jobId || cur.candidateIndex === null) throw problems.revisionConflict();
  if (await hasActiveJob(tx, screen.projectId, screen.id)) throw problems.screenBusy();
  await tx.update(schema.screens).set({ currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
  await tx.update(schema.screenRevisions).set({ candidateSettledAt: new Date() }).where(and(eq(schema.screenRevisions.screenId, screen.id), eq(schema.screenRevisions.jobId, rev.jobId)));
}

// 候选就地展开的数据（API-CORE-026）：按屏分组、按 candidateIndex 排版；每版带预览 URL，展开层里每格是活 iframe
export async function listCandidates(project: ProjectRow, jobId: string): Promise<CandidatesDto> {
  const rows = await db.select({ r: schema.screenRevisions, s: schema.screens }).from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .where(and(eq(schema.screenRevisions.jobId, jobId), isNotNull(schema.screenRevisions.candidateIndex), eq(schema.screens.projectId, project.id)))
    .orderBy(schema.screens.createdAt, schema.screenRevisions.candidateIndex);
  const size = DEVICE_SIZE[project.deviceType as DeviceType];
  const byScreen = new Map<string, CandidatesDto['screens'][number]>();
  const previewToken = signPreview(project.id, stableExpiry(config.previewTokenMinutes));
  let versions = 0;
  for (const { r, s } of rows) {
    if (!byScreen.has(s.id)) byScreen.set(s.id, { screenId: s.id, name: s.name, route: s.route, width: size.w, height: size.h, currentRevisionId: s.currentRevisionId, settled: false, revisions: [] });
    const e = byScreen.get(s.id)!;
    e.revisions.push({ id: r.id, index: r.candidateIndex!, seq: r.seq, screenshotUrl: r.screenshotKey ? await storage.signedUrl(r.screenshotKey) : null, htmlUrl: await storage.signedUrl(r.htmlKey), previewUrl: `${config.previewOrigin}/p/${project.id}/${s.id}?rev=${r.id}&t=${previewToken}` });
    if (r.candidateSettledAt) e.settled = true;
    versions = Math.max(versions, r.candidateIndex! + 1);
  }
  return { jobId, versions, screens: [...byScreen.values()] };
}

// 应用地图派生（ADR-008 / REQ-PROTO-002）：扫全部屏当前修订的链接，按 route 匹配。
export async function deriveLinks(tx: Tx, projectId: string): Promise<void> {
  const screens = await tx.select().from(schema.screens).where(eq(schema.screens.projectId, projectId));
  const byRoute = new Map(screens.map((s) => [s.route, s.id]));
  const revIds = screens.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length ? await tx.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.id, revIds)) : [];
  const rows: (typeof schema.links.$inferInsert)[] = [];
  for (const rev of revs) {
    const html = (await storage.get(rev.htmlKey)).toString('utf8');
    for (const l of extractLinks(extractBody(html))) rows.push({ projectId, fromScreenId: rev.screenId, elementQid: l.qid, href: l.href, toScreenId: byRoute.get(l.href) ?? null });
  }
  await tx.delete(schema.links).where(eq(schema.links.projectId, projectId));
  if (rows.length) await tx.insert(schema.links).values(rows);
}

export async function listRevisions(screenId: string): Promise<RevisionDto[]> {
  const rows = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, screenId)).orderBy(desc(schema.screenRevisions.seq));
  return Promise.all(rows.map(revisionDto));
}

export async function revisionDto(r: RevisionRow): Promise<RevisionDto> {
  return {
    id: r.id, screenId: r.screenId, seq: r.seq, sourceKind: r.sourceKind as SourceKind, jobId: r.jobId,
    parentRevisionId: r.parentRevisionId, candidateIndex: r.candidateIndex, candidateSettledAt: r.candidateSettledAt?.toISOString() ?? null,
    htmlUrl: await storage.signedUrl(r.htmlKey), screenshotUrl: r.screenshotKey ? await storage.signedUrl(r.screenshotKey) : null, lintReport: r.lintReport, createdAt: r.createdAt.toISOString(),
  };
}

export async function getRevision(screenId: string, revisionId: string): Promise<RevisionRow> {
  const [r] = await db.select().from(schema.screenRevisions).where(and(eq(schema.screenRevisions.id, revisionId), eq(schema.screenRevisions.screenId, screenId)));
  if (!r) throw problems.notFound();
  return r;
}

// 屏级历史意图（ADR-012）：沿 current 的 parentRevisionId 祖先链回溯，经 jobId 反查那一轮的用户指令。
// 按祖先链而不是时间序——回溯掉的分支上的指令不该再带进来。
export async function priorInstructions(screenId: string, currentRevisionId: string | null, limit = 5): Promise<string[]> {
  if (!currentRevisionId) return [];
  const revs = await db.select({ id: schema.screenRevisions.id, parent: schema.screenRevisions.parentRevisionId, jobId: schema.screenRevisions.jobId }).from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, screenId));
  const byId = new Map(revs.map((r) => [r.id, r]));
  const jobIds: string[] = [];
  for (let cur = byId.get(currentRevisionId); cur && jobIds.length < limit * 2; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    if (cur.jobId && !jobIds.includes(cur.jobId)) jobIds.push(cur.jobId);
  }
  if (!jobIds.length) return [];
  const msgs = await db.select({ jobId: schema.messages.jobId, content: schema.messages.content }).from(schema.messages)
    .where(and(inArray(schema.messages.jobId, jobIds), eq(schema.messages.role, 'user')));
  const byJob = new Map(msgs.map((m) => [m.jobId!, m.content]));
  // 最近的在前；只保留用户真写的指令（补链 / 批注的固定指令也算意图，照带）
  return jobIds.map((j) => byJob.get(j)).filter((c): c is string => !!c).slice(0, limit);
}

// 样板屏（REQ-CORE-016）：projects.exemplarScreenId 的 current；没钦定或已删则回落到最早一张 lint 通过的屏
export async function exemplarBody(project: ProjectRow): Promise<{ screenId: string; body: string } | null> {
  if (project.exemplarScreenId) {
    const [s] = await db.select().from(schema.screens).where(and(eq(schema.screens.id, project.exemplarScreenId), eq(schema.screens.projectId, project.id)));
    if (s?.currentRevisionId) {
      const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
      if (rev) return { screenId: s.id, body: extractBody((await storage.get(rev.htmlKey)).toString('utf8')) };
    }
  }
  const [row] = await db.select({ htmlKey: schema.screenRevisions.htmlKey, screenId: schema.screenRevisions.screenId })
    .from(schema.screenRevisions).innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .where(and(eq(schema.screens.projectId, project.id), sql`(${schema.screenRevisions.lintReport}->>'passed')::boolean = true`))
    .orderBy(schema.screenRevisions.createdAt).limit(1);
  if (!row) return null;
  return { screenId: row.screenId, body: extractBody((await storage.get(row.htmlKey)).toString('utf8')) };
}

export async function currentBody(screenId: string): Promise<string | null> {
  const [s] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
  if (!s?.currentRevisionId) return null;
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
  return rev ? extractBody((await storage.get(rev.htmlKey)).toString('utf8')) : null;
}

// 项目大纲（REQ-CORE-023 / quilt.get_outline）：每屏当前修订 body 的结构摘要，确定性、零 LLM
export async function projectOutline(ownerId: string, projectId: string, screenIds?: string[]) {
  const project = await ownedProject(ownerId, projectId);
  const rows = (await db.select().from(schema.screens).where(eq(schema.screens.projectId, project.id)).orderBy(schema.screens.createdAt)).filter((s) => !screenIds || screenIds.includes(s.id));
  const screens = [];
  for (const s of rows) {
    const body = s.currentRevisionId ? await currentBody(s.id) : null;
    screens.push({ screenId: s.id, name: s.name, route: s.route, purpose: s.purpose, currentRevisionId: s.currentRevisionId, outline: body ? outlineBody(body) : '(no revision yet)' });
  }
  return { projectId: project.id, screens };
}

// 删屏时样板屏指针要跟着清（不建外键）
export async function clearExemplarIfDeleted(tx: Tx, projectId: string, screenId: string): Promise<void> {
  await tx.update(schema.projects).set({ exemplarScreenId: null }).where(and(eq(schema.projects.id, projectId), eq(schema.projects.exemplarScreenId, screenId)));
}

export const noSettledCandidates = isNull(schema.screenRevisions.candidateSettledAt);
