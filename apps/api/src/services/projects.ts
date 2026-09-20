import { and, eq, desc, inArray, lt, sql, isNull, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { signPreview, stableExpiry } from '../lib/signing.ts';
import { assetsOf } from './assets.ts';
import { copyPresetAssets, presetSeed } from './presets.ts';
import { tokensFromSeed, defaultDesignMd, DEFAULT_COMPONENTS, DEVICE_SIZE, type DeviceType, type ProjectDto, type ProjectDetailDto, type DesignSystemDto, type ScreenDto, type LinkDto, type JobDto, type JobRunner, RADIUS_SCALES, type Palette, type ColorMode, type FontSource } from '@quilt/core';

export type ProjectRow = typeof schema.projects.$inferSelect;
export type ScreenRow = typeof schema.screens.$inferSelect;
export type RevisionRow = typeof schema.screenRevisions.$inferSelect;
export type JobRow = typeof schema.generationJobs.$inferSelect;

const DEFAULT_SEED = '#3B5BDB';

// REQ-CORE-002：建项目并由种子色算出设计系统（ADR-005）。
export async function createProject(ownerId: string, input: { name: string; deviceType: DeviceType; seedColor?: string; presetId?: string }) {
  // 按设计预设开局（v0.40 REQ-CORE-021）：预设存的是输入，tokens 这里现算；素材在事务外复制（要读写对象存储）
  const preset = input.presetId ? await presetSeed(ownerId, input.presetId) : null;
  const seedColor = preset?.seedColor ?? input.seedColor ?? DEFAULT_SEED;
  const created = await db.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ ownerId, name: input.name, deviceType: input.deviceType }).returning();
    const palette = (preset?.palette as Palette | null) ?? null;
    const colorMode = (preset?.colorMode as ColorMode) ?? 'light';
    const tokens = preset
      ? tokensFromSeed(seedColor, { fontFamily: preset.fontFamily, fontSource: preset.fontSource as FontSource, fontUrl: preset.fontUrl, radiusScale: preset.radiusScale as keyof typeof RADIUS_SCALES, palette: palette?.[colorMode], colorMode })
      : tokensFromSeed(seedColor);
    const [ds] = await tx.insert(schema.designSystems).values({
      projectId: project.id, seedColor, tokens, palette, colorMode,
      designMd: preset?.designMd ?? defaultDesignMd(input.name, seedColor, input.deviceType),
      components: preset?.components ?? DEFAULT_COMPONENTS,
    }).returning();
    return { project, designSystem: ds };
  });
  if (preset) await copyPresetAssets(preset.id, created.project.id).catch(() => {});
  return created;
}

export async function ownedProject(ownerId: string, projectId: string): Promise<ProjectRow> {
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId)));
  if (!p) throw problems.notFound();
  return p;
}

// API-CORE-027：应用简介 / 样板屏 / 改名（REQ-CORE-016）
export async function updateProject(ownerId: string, projectId: string, patch: { name?: string; brief?: string; exemplarScreenId?: string | null }): Promise<ProjectRow> {
  const project = await ownedProject(ownerId, projectId);
  if (patch.exemplarScreenId) {
    const [s] = await db.select({ id: schema.screens.id }).from(schema.screens).where(and(eq(schema.screens.id, patch.exemplarScreenId), eq(schema.screens.projectId, project.id)));
    if (!s) throw problems.validation([{ path: 'exemplarScreenId', message: '样板屏必须是本项目的屏' }]);
  }
  const [updated] = await db.update(schema.projects).set({ ...patch, updatedAt: new Date() }).where(eq(schema.projects.id, project.id)).returning();
  return updated;
}

// API-CORE-031：删项目——行级联（屏 / 修订 / 作业 / 消息 / 连线 / 批注 / 设计系统都挂在 projects 上），对象文件按前缀清；
// 有进行中的作业先拒（worker 还在往里写，删了它会撞外键）
export async function deleteProject(ownerId: string, projectId: string): Promise<void> {
  const project = await ownedProject(ownerId, projectId);
  const [active] = await db.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.projectId, project.id), inArray(schema.generationJobs.status, ['queued', 'running']))).limit(1);
  if (active) throw problems.projectBusy();
  await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  await storage.deletePrefix(`projects/${project.id}/`).catch((e) => console.warn(`[project ${project.id}] 对象文件清理失败：${(e as Error).message}`));
}

export async function listProjects(ownerId: string, cursor?: string, limit = 50): Promise<{ items: ProjectDto[]; nextCursor: string | null }> {
  const where = cursor ? and(eq(schema.projects.ownerId, ownerId), lt(schema.projects.updatedAt, new Date(cursor))) : eq(schema.projects.ownerId, ownerId);
  const rows = await db.select().from(schema.projects).where(where).orderBy(desc(schema.projects.updatedAt)).limit(limit + 1);
  const items = rows.slice(0, limit).map(projectDto);
  return { items, nextCursor: rows.length > limit ? rows[limit - 1].updatedAt.toISOString() : null };
}

export const projectDto = (p: ProjectRow): ProjectDto => ({ id: p.id, name: p.name, deviceType: p.deviceType as DeviceType, status: p.status as 'active' | 'archived', brief: p.brief, exemplarScreenId: p.exemplarScreenId, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() });
export const designSystemDto = (d: typeof schema.designSystems.$inferSelect): DesignSystemDto => ({ id: d.id, projectId: d.projectId, seedColor: d.seedColor, tokens: d.tokens, palette: (d.palette as DesignSystemDto['palette']) ?? null, colorMode: d.colorMode as DesignSystemDto['colorMode'], designMd: d.designMd, components: d.components, version: d.version });
export const jobDto = (j: JobRow): JobDto => ({ id: j.id, projectId: j.projectId, kind: j.kind as JobDto['kind'], status: j.status as JobDto['status'], runner: j.runner as JobRunner, input: j.input, output: j.output, createdAt: j.createdAt.toISOString(), startedAt: j.startedAt?.toISOString() ?? null, finishedAt: j.finishedAt?.toISOString() ?? null });

export async function screenDtos(project: ProjectRow, rows: ScreenRow[]): Promise<ScreenDto[]> {
  const revIds = rows.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length ? await db.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.id, revIds)) : [];
  const byId = new Map(revs.map((r) => [r.id, r]));
  // 待采用的候选批（REQ-CORE-015）：current 是未结清的候选 → 数同批有几版
  const pending = revs.filter((r) => r.candidateIndex !== null && !r.candidateSettledAt && r.jobId);
  const counts = new Map<string, number>();
  if (pending.length) {
    const rowsC = await db.select({ screenId: schema.screenRevisions.screenId, jobId: schema.screenRevisions.jobId, n: sql<number>`count(*)::int` }).from(schema.screenRevisions)
      .where(and(inArray(schema.screenRevisions.jobId, pending.map((r) => r.jobId!)), isNotNull(schema.screenRevisions.candidateIndex), isNull(schema.screenRevisions.candidateSettledAt)))
      .groupBy(schema.screenRevisions.screenId, schema.screenRevisions.jobId);
    for (const c of rowsC) counts.set(`${c.screenId}|${c.jobId}`, c.n);
  }
  const size = DEVICE_SIZE[project.deviceType as DeviceType];
  const previewToken = signPreview(project.id, stableExpiry(config.previewTokenMinutes));
  return Promise.all(rows.map(async (s) => {
    const rev = s.currentRevisionId ? byId.get(s.currentRevisionId) : undefined;
    const n = rev?.jobId && rev.candidateIndex !== null && !rev.candidateSettledAt ? counts.get(`${s.id}|${rev.jobId}`) ?? 0 : 0;
    return {
      id: s.id, projectId: s.projectId, name: s.name, route: s.route, purpose: s.purpose, x: s.x, y: s.y, width: size.w, height: size.h,
      currentRevisionId: rev?.id ?? null, currentRevisionSeq: rev?.seq ?? null,
      screenshotUrl: rev?.screenshotKey ? await storage.signedUrl(rev.screenshotKey) : null,
      previewUrl: rev ? `${config.previewOrigin}/p/${project.id}/${s.id}?rev=${rev.id}&t=${previewToken}` : null,
      lintPassed: rev ? (rev.lintReport as { passed?: boolean }).passed ?? null : null,
      // 偏离条数（v0.43）：契约是透镜不是闸门，画布只报「偏离了几处」，取舍由设计师做
      deviations: rev ? ((rev.lintReport as { violations?: unknown[] }).violations ?? []).length : 0,
      pendingCandidates: n >= 2 && rev?.jobId ? { jobId: rev.jobId, count: n } : null,
      updatedAt: s.updatedAt.toISOString(),
    };
  }));
}

export async function getProjectDetail(ownerId: string, projectId: string): Promise<ProjectDetailDto> {
  const project = await ownedProject(ownerId, projectId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, projectId));
  const rows = await db.select().from(schema.screens).where(eq(schema.screens.projectId, projectId)).orderBy(schema.screens.createdAt);
  const linkRows = await db.select().from(schema.links).where(eq(schema.links.projectId, projectId));
  const activeJobs = await db.select().from(schema.generationJobs).where(and(eq(schema.generationJobs.projectId, projectId), inArray(schema.generationJobs.status, ['queued', 'running'])));
  const links: LinkDto[] = linkRows.map((l) => ({ fromScreenId: l.fromScreenId, qid: l.elementQid, href: l.href, toScreenId: l.toScreenId }));
  const { listOpenForProject } = await import('./annotations.ts');
  // 素材随详情一起给（v0.35 REQ-CORE-019）：风格指南卡片与设计系统面板用的是同一份，分两次取会各刷各的
  return { project: projectDto(project), designSystem: designSystemDto(ds), screens: await screenDtos(project, rows), links, activeJobs: activeJobs.map(jobDto), annotations: await listOpenForProject(projectId), assets: await assetsOf(project.id) };
}
