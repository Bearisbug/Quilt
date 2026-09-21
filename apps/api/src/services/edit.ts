import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { applyElementOps, extractBody, assembleDocument, buildPrelude, lintScreenBody, tokensFromSeed, withConventions, RADIUS_SCALES, type ElementOp, type Tokens, type RevisionDto, type Palette, type ColorMode, type FontSource } from '@quilt/core';
import { ownedScreen, hasActiveJob, createRevision, deriveLinks, revisionDto } from './screens.ts';
import { ownedProject, designSystemDto } from './projects.ts';
import { enqueueScreenshot } from './jobs.ts';
import { assertNotLocked } from './components.ts';

// API-EDIT-001：元素直改（零 token）：确定性 DOM 变换 → lint → 新修订 → 异步截图
export async function applyElementEdit(ownerId: string, screenId: string, qid: string, ops: ElementOp[], expectedRevisionId: string): Promise<RevisionDto> {
  const { screen, project } = await ownedScreen(ownerId, screenId);
  if (!screen.currentRevisionId) throw problems.elementNotFound();
  if (screen.currentRevisionId !== expectedRevisionId) throw problems.revisionConflict();
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
  const html = (await storage.get(rev.htmlKey)).toString('utf8');
  const before = extractBody(html);
  // 共享组件实例里的元素不能直改（REQ-EDIT-006）：改组件或先「脱离共享」——脱离本身是唯一放行的 op
  await assertNotLocked(project.id, before, qid, ops);
  const body = applyElementOps(before, qid, ops);
  if (body === null) throw problems.elementNotFound();
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, project.id))).map((r) => r.route);
  const report = lintScreenBody(body, routes, true);
  // 偏离不阻断（ADR-005 v0.43）：直改的结果照样落修订，违规项记进 lintReport 供画布提示
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  const doc = assembleDocument(body, buildPrelude(ds.tokens as Tokens), `${project.name} · ${screen.name}`);
  const created = await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
    const r = await createRevision(tx, { projectId: project.id, screenId: screen.id, html: doc, sourceKind: 'manual', lintReport: report, expectedRevisionId });
    if (!r) throw problems.revisionConflict();
    await deriveLinks(tx, project.id);
    return r;
  });
  await enqueueScreenshot(created.id);
  return revisionDto(created);
}

// API-EDIT-002：设计系统更新（乐观锁 version）；调色板由种子色重新算出，DESIGN.md 可整篇替换；
// conventions 整体替换「## 约定」节（REQ-EDIT-003：预览确认后的唯一写入口）
export async function updateDesignSystem(ownerId: string, projectId: string, patch: { seedColor?: string; fontFamily?: string; fontSource?: FontSource; fontUrl?: string | null; radiusScale?: keyof typeof RADIUS_SCALES; palette?: Palette | null; colorMode?: ColorMode; designMd?: string; conventions?: string[]; expectedVersion: number }) {
  const project = await ownedProject(ownerId, projectId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  if (ds.version !== patch.expectedVersion) throw problems.versionConflict();
  const current = ds.tokens as Tokens;
  const seedColor = patch.seedColor ?? ds.seedColor;
  const fontFamily = patch.fontFamily ?? current.typography.fontFamily;
  // 字体来源（v0.44）：换成 url 来源时链接得同批给到，否则 prelude 发不出 <link>，屏静默退回系统字体
  const fontSource = patch.fontSource ?? current.typography.fontSource ?? 'google';
  const fontUrl = fontSource === 'url' ? (patch.fontUrl === undefined ? (current.typography.fontUrl ?? null) : patch.fontUrl) : null;
  if (fontSource === 'url' && !fontUrl) throw problems.validation([{ path: 'fontUrl', message: '来源为自定义链接时要给字体样式表地址' }]);
  const radiusScale = patch.radiusScale ?? (Object.entries(RADIUS_SCALES).find(([, v]) => v.md === current.radius.md)?.[0] as keyof typeof RADIUS_SCALES | undefined) ?? 'default';
  // 品牌色板（REQ-EDIT-005）：给对象整份替换、给 null 清空、不给沿用；tokens 是「派生 + 覆盖」的成品
  const patched = patch.palette === undefined ? (ds.palette as Palette | null) : patch.palette;
  // 零个覆盖键的暗色色板与「没有暗色色板」是同一件事：留着 `dark:{}` 会让 dark 可选而色值全是派生值
  const palette = patched && !Object.keys(patched.dark ?? {}).length ? { light: patched.light } : patched;
  // 400 只针对「请求里选了 dark 却没有 dark 色板」；清空色板这类请求没碰 colorMode，不该被存量模式连带拒掉
  if (patch.colorMode === 'dark' && !palette?.dark) throw problems.validation([{ path: 'colorMode', message: '没有暗色色板可切——先给 palette.dark' }]);
  // 暗色色板被这次请求撤掉时回落 light：dark 没了还留在 dark 模式，面板的亮 / 暗段控（挂在 palette.dark 上）也就消失了
  const colorMode: ColorMode = palette?.dark ? (patch.colorMode ?? (ds.colorMode as ColorMode)) : 'light';
  const tokens = tokensFromSeed(seedColor, { fontFamily, fontSource, fontUrl, radiusScale, colorMode, palette: palette?.[colorMode] });
  const designMd = patch.conventions ? withConventions(patch.designMd ?? ds.designMd, patch.conventions) : (patch.designMd ?? ds.designMd);
  const [updated] = await db.update(schema.designSystems)
    .set({ seedColor, tokens, palette, colorMode, designMd, version: ds.version + 1, updatedAt: new Date() })
    .where(eq(schema.designSystems.id, ds.id)).returning();
  return designSystemDto(updated);
}
