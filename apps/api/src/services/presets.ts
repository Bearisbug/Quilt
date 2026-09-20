import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { MAX_ASSETS_PER_PROJECT, RADIUS_SCALES, tokensFromSeed, type ColorMode, type DesignPresetDto, type FontSource, type Palette, type Tokens } from '@quilt/core';
import { db, schema } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { ownedProject } from './projects.ts';
import { assetKey } from './assets.ts';

// 设计预设（REQ-CORE-021 / API-CORE-033）：账号级，存设计系统的**输入**而不是算好的 tokens——
// 套用时按当时的 token 引擎重算，引擎补了新色键（如 v0.35 的语义色）老预设跟着受益。
// 素材是二进制，只能按值复制：预设存一份、套用再复制一份到项目，此后三边各改各的。
const presetAssetKey = (presetId: string, id: string, mediaType: string) =>
  `presets/${presetId}/assets/${id}.${({ 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mediaType] ?? 'bin'}`;

const radiusOf = (tokens: Tokens) =>
  (Object.entries(RADIUS_SCALES).find(([, v]) => v.md === tokens.radius.md)?.[0] as keyof typeof RADIUS_SCALES | undefined) ?? 'default';

export const presetDto = (p: typeof schema.designPresets.$inferSelect, assetCount: number): DesignPresetDto => ({
  id: p.id, name: p.name, seedColor: p.seedColor, fontFamily: p.fontFamily, fontSource: p.fontSource as FontSource, fontUrl: p.fontUrl,
  radiusScale: p.radiusScale as DesignPresetDto['radiusScale'],
  palette: (p.palette as Palette | null) ?? null, colorMode: p.colorMode as ColorMode,
  designMd: p.designMd, assetCount, createdAt: p.createdAt.toISOString(),
});

export async function listPresets(ownerId: string): Promise<DesignPresetDto[]> {
  const rows = await db.select().from(schema.designPresets).where(eq(schema.designPresets.ownerId, ownerId)).orderBy(desc(schema.designPresets.createdAt));
  if (!rows.length) return [];
  const counts = await db.select({ presetId: schema.presetAssets.presetId, n: sql<number>`count(*)::int` })
    .from(schema.presetAssets).where(inArray(schema.presetAssets.presetId, rows.map((r) => r.id)))
    .groupBy(schema.presetAssets.presetId);
  const byId = new Map(counts.map((c) => [c.presetId, Number(c.n)]));
  return rows.map((r) => presetDto(r, byId.get(r.id) ?? 0));
}

/** 把一个项目的设计系统快照成预设（API-CORE-033） */
export async function createPreset(ownerId: string, input: { projectId: string; name: string; includeAssets?: boolean }): Promise<DesignPresetDto> {
  const project = await ownedProject(ownerId, input.projectId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  const tokens = ds.tokens as Tokens;
  const [preset] = await db.insert(schema.designPresets).values({
    ownerId, name: input.name.trim().slice(0, 80),
    seedColor: ds.seedColor, fontFamily: tokens.typography.fontFamily, radiusScale: radiusOf(tokens),
    fontSource: tokens.typography.fontSource ?? 'google', fontUrl: tokens.typography.fontSource === 'url' ? (tokens.typography.fontUrl ?? null) : null,
    palette: ds.palette, colorMode: ds.colorMode, designMd: ds.designMd, components: ds.components,
  }).returning();

  let assetCount = 0;
  if (input.includeAssets !== false) {
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, project.id)).orderBy(asc(schema.assets.createdAt));
    for (const a of assets.slice(0, MAX_ASSETS_PER_PROJECT)) {
      const body = await storage.get(assetKey(project.id, a.id, a.mediaType)).catch(() => null);
      if (!body) continue; // 对象丢了就跳过这一个，不让整份预设存不下来
      const [row] = await db.insert(schema.presetAssets).values({
        presetId: preset.id, name: a.name, mediaType: a.mediaType, bytes: a.bytes, width: a.width, height: a.height,
      }).returning();
      await storage.put(presetAssetKey(preset.id, row.id, row.mediaType), body, row.mediaType);
      assetCount += 1;
    }
  }
  return presetDto(preset, assetCount);
}

export async function deletePreset(ownerId: string, presetId: string): Promise<void> {
  const [row] = await db.select().from(schema.designPresets).where(eq(schema.designPresets.id, presetId));
  if (!row || row.ownerId !== ownerId) throw problems.notFound();
  await db.delete(schema.designPresets).where(eq(schema.designPresets.id, presetId));
  await storage.deletePrefix(`presets/${presetId}/`).catch(() => {});
}

/** 预设 → 项目：写设计系统（tokens 现算）+ 把预设素材复制成项目素材。返回复制了几个素材 */
export async function applyPreset(ownerId: string, projectId: string, input: { presetId: string; expectedVersion: number }): Promise<{ assetsCopied: number; skipped: number }> {
  const project = await ownedProject(ownerId, projectId);
  const [preset] = await db.select().from(schema.designPresets).where(eq(schema.designPresets.id, input.presetId));
  if (!preset || preset.ownerId !== ownerId) throw problems.notFound();

  const palette = (preset.palette as Palette | null) ?? null;
  const colorMode = preset.colorMode as ColorMode;
  const tokens = tokensFromSeed(preset.seedColor, {
    fontFamily: preset.fontFamily, fontSource: preset.fontSource as FontSource, fontUrl: preset.fontUrl,
    radiusScale: preset.radiusScale as keyof typeof RADIUS_SCALES,
    palette: palette?.[colorMode],
    colorMode,
  });
  const [updated] = await db.update(schema.designSystems)
    .set({ seedColor: preset.seedColor, tokens, palette, colorMode, designMd: preset.designMd, components: preset.components, version: input.expectedVersion + 1, updatedAt: new Date() })
    .where(sql`${schema.designSystems.projectId} = ${project.id} and ${schema.designSystems.version} = ${input.expectedVersion}`)
    .returning();
  if (!updated) throw problems.versionConflict();

  // 素材是新增不是替换：同名不合并，用户要的是「把这套 logo 也带过来」，删旧的该由他自己决定
  const total = await db.$count(schema.presetAssets, eq(schema.presetAssets.presetId, preset.id));
  const copied = await copyPresetAssets(preset.id, project.id);
  return { assetsCopied: copied, skipped: total - copied };
}

/** 把预设素材复制成某个项目的素材（建项目与套用预设共用） */
export async function copyPresetAssets(presetId: string, projectId: string): Promise<number> {
  const have = await db.$count(schema.assets, eq(schema.assets.projectId, projectId));
  const rows = await db.select().from(schema.presetAssets).where(eq(schema.presetAssets.presetId, presetId)).orderBy(asc(schema.presetAssets.createdAt));
  let copied = 0;
  for (const a of rows) {
    if (have + copied >= MAX_ASSETS_PER_PROJECT) break;
    const body = await storage.get(presetAssetKey(presetId, a.id, a.mediaType)).catch(() => null);
    if (!body) continue;
    const [row] = await db.insert(schema.assets).values({
      projectId, name: a.name, mediaType: a.mediaType, bytes: a.bytes, width: a.width, height: a.height,
    }).returning();
    await storage.put(assetKey(projectId, row.id, row.mediaType), body, row.mediaType);
    copied += 1;
  }
  return copied;
}

/** 建项目时按预设初始化（createProject 用）：拿不到预设就回 null，让建项目照默认值走 */
export async function presetSeed(ownerId: string, presetId: string) {
  const [preset] = await db.select().from(schema.designPresets).where(eq(schema.designPresets.id, presetId));
  if (!preset || preset.ownerId !== ownerId) throw problems.notFound();
  return preset;
}

export { presetAssetKey };
