import { eq, and, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { problems, isUniqueViolation } from '../lib/errors.ts';
import { config } from '../config.ts';
import { storage } from '../lib/storage.ts';
import { assembleDocument, buildPrelude, extractBody, injectQids, reconcileQids, overwrittenInstances, lintScreenBody, expandComponents, OVERLAY_SCREEN_NOTE, COLOR_CLASS_NAMES, DEVICE_SIZE, type DeviceType, type Tokens, type LintReport, type Presentation } from '@quilt/core';
import { assetsForPrompt } from './assets.ts';
import { ownedProject } from './projects.ts';
import { createRevision, deriveLinks, hasActiveJob } from './screens.ts';
import { enqueueScreenshot } from './jobs.ts';
import { emitProjectEvent } from '../lib/events.ts';
import { sharedComponentsOf, contractComponents } from './components.ts';

// MCP 底层原语（REQ-AGENT-002）：agent 自带 HTML 推进画布——同步执行：去旧 qid → 注入 → lint → 修订 → 截图队列。
// 带 jobId（派活任务载荷里的作业，ADR-015）时修订即算该工单产出；改既有屏时 expectedRevisionId 必填——
// 租约过期期间用户可能已改过这张屏，旧基线回写会顶掉他的改动，所以用 409 兜底。
export async function ingestScreen(ownerId: string, projectId: string, input: { name: string; route: string; html?: string; uploadId?: string; screenId?: string; expectedRevisionId?: string; jobId?: string; presentation?: Presentation }) {
  const project = await ownedProject(ownerId, projectId);
  if (input.jobId) {
    const [job] = await db.select({ id: schema.generationJobs.id, status: schema.generationJobs.status }).from(schema.generationJobs).where(and(eq(schema.generationJobs.id, input.jobId), eq(schema.generationJobs.projectId, project.id)));
    if (!job) throw problems.notFound();
    // 已结束的作业不再收产出：取消之后屏锁已释放，用户可能已在这屏上继续改了（§11 cancelled 是终态）
    if (job.status !== 'running') throw problems.jobFinished();
    if (input.screenId && !input.expectedRevisionId) throw problems.validation([{ path: 'expectedRevisionId', message: '带 jobId 更新既有屏时必须传 expectedRevisionId（取任务载荷 screens[].revisionId）' }]);
  }
  const raw = input.html ?? (input.uploadId ? (await storage.get(`uploads/${input.uploadId}.html`).catch(() => null))?.toString('utf8') : null);
  if (!raw) throw problems.validation([{ path: 'html', message: 'html or a valid uploadId is required' }]);
  // 单屏上限（§15）：模型生成那条路在 pipeline 里查，agent 写入同样要查——超了截图与导出都会被拖垮
  if (Buffer.byteLength(raw) > config.maxScreenHtmlBytes) throw problems.unprocessable([{ path: 'html', message: `screen html is ${Buffer.byteLength(raw)} bytes, the limit is ${config.maxScreenHtmlBytes}` }]);
  // 共享组件（REQ-EDIT-006）：agent 写进来的占位（或它手抄的副本）在这里展开成正式 HTML。
  // qid 对齐而不是全部重编（v0.65）：没动的元素保留原号，连续局部修改的锚点与挂在元素上的批注都还对得上
  const shared = await sharedComponentsOf(project.id);
  const incoming = raw.includes('<body') ? extractBody(raw) : raw;
  const componentsOverwritten = overwrittenInstances(incoming, shared, input.route);
  const body = reconcileQids(expandComponents(incoming, shared, input.route).html);
  const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, project.id));
  const routes = Array.from(new Set([...screens.map((s) => s.route), input.route]));
  // 偏离设计契约不阻断写入（ADR-005 v0.43）：报告随修订存下来、随返回值给 agent，取舍由写的人做
  const report: LintReport = lintScreenBody(body, routes, true);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  const html = assembleDocument(body, buildPrelude(ds.tokens as Tokens), `${project.name} · ${input.name}`);
  const size = DEVICE_SIZE[project.deviceType as DeviceType];
  const result = await db.transaction(async (tx) => {
    try {
    let screenId = input.screenId;
    if (screenId) {
      const s = screens.find((x) => x.id === screenId);
      if (!s) throw problems.notFound();
      // 自己那张工单占着的屏不算「忙」；别的作业占着才拒
      if (await hasActiveJob(tx, project.id, screenId)) {
        const [holder] = await tx.select({ id: schema.generationJobs.id }).from(schema.generationJobs).where(and(eq(schema.generationJobs.targetScreenId, screenId), eq(schema.generationJobs.projectId, project.id), eq(schema.generationJobs.status, 'running')));
        if (!input.jobId || holder?.id !== input.jobId) throw problems.screenBusy();
      }
      // 变体的路由属于默认屏（v0.62）：经这条路改 route 一律拒；呈现方式（v0.63）随写入一起改
      if (s.variantOf && input.route !== s.route) throw problems.unprocessable([{ path: 'route', message: '变体与默认屏同路由，改路由请改默认屏' }]);
      if (input.route !== s.route || input.name !== s.name || (input.presentation && input.presentation !== s.presentation)) await tx.update(schema.screens).set({ route: input.route, name: input.name, ...(input.presentation ? { presentation: input.presentation } : {}) }).where(eq(schema.screens.id, screenId));
      // 默认屏改路由，它的变体跟着改（v0.62 变体与默认屏同路由）
      if (input.route !== s.route) await tx.update(schema.screens).set({ route: input.route }).where(eq(schema.screens.variantOf, screenId));
    } else {
      if (screens.some((s) => s.route === input.route)) throw problems.routeTaken();
      const x = screens.reduce((m, s) => Math.max(m, s.x + size.w + 80), 0);
      const [s] = await tx.insert(schema.screens).values({ projectId: project.id, name: input.name, route: input.route, x, y: 0, presentation: input.presentation ?? 'push' }).returning();
      screenId = s.id;
    }
    const rev = await createRevision(tx, { projectId: project.id, screenId, html, sourceKind: 'agent_ingest', jobId: input.jobId ?? null, lintReport: report, expectedRevisionId: input.screenId ? (input.expectedRevisionId ?? screens.find((x) => x.id === input.screenId)?.currentRevisionId ?? null) : null });
    if (!rev) throw problems.revisionConflict();
    await deriveLinks(tx, project.id);
    return { screenId, revisionId: rev.id };
    } catch (e) { if (isUniqueViolation(e)) throw problems.routeTaken(); throw e; }
  });
  // 用过的上传位清掉：不清的话同一个 uploadId 再 append 会拼到上一屏后面
  if (input.uploadId) await storage.delete(`uploads/${input.uploadId}.html`).catch(() => {});
  await enqueueScreenshot(result.revisionId);
  // 本机会话 / 外部 agent 经 MCP 写进来的屏没有作业事件可订阅，项目级事件让画布立刻刷新（API-CORE-030）
  await emitProjectEvent(project.id, 'screen_changed', { screenId: result.screenId, revisionId: result.revisionId, jobId: input.jobId ?? null }).catch(() => {});
  // componentsOverwritten：写进来的共享组件实例里改过的内容已被组件正式 HTML 盖回，要改它得改组件本身（quilt.update_component）
  return { ...result, lintReport: report, danglingRoutes: report.danglingRoutes, ...(componentsOverwritten.length ? { componentsOverwritten } : {}) };
}

export async function validateScreenHtml(ownerId: string, projectId: string, html: string): Promise<LintReport> {
  const project = await ownedProject(ownerId, projectId);
  const body = injectQids((html.includes('<body') ? extractBody(html) : html).replace(/\sdata-qid="q\d+"/g, ''));
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, project.id))).map((r) => r.route);
  return lintScreenBody(body, routes, true);
}

// 设计契约的机器可判定投影（quilt.get_design_contract / resources）
export async function designContract(ownerId: string, projectId: string) {
  const project = await ownedProject(ownerId, projectId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  // 变体不进契约的路由表（v0.62）：路由已由默认屏占着，agent 看到两份只会撞路由
  const screens = await db.select({ id: schema.screens.id, name: schema.screens.name, route: schema.screens.route, purpose: schema.screens.purpose, presentation: schema.screens.presentation }).from(schema.screens).where(and(eq(schema.screens.projectId, project.id), isNull(schema.screens.variantOf)));
  // 素材清单随契约走（REQ-CORE-019）：本机会话这条链只读契约，不读 prompt 里的 PROJECT ASSETS 段，
  // 契约不给素材就只能拿 picsum 占位块糊品牌位
  const assets = await assetsForPrompt(project.id);
  // 共享组件（REQ-EDIT-006）：agent 按 placement 放占位、不手写副本；改外观走 quilt.update_component
  const sharedComponents = await contractComponents(project.id);
  return {
    projectId: project.id, name: project.name, brief: project.brief, deviceType: project.deviceType, viewport: DEVICE_SIZE[project.deviceType as DeviceType],
    tokens: ds.tokens, colorClasses: COLOR_CLASS_NAMES, components: ds.components, sharedComponents, designMd: ds.designMd, version: ds.version, assets,
    rules: [
      ...(sharedComponents.length ? [`Shared components (sharedComponents[]) are project-level fragments every screen places by reference: emit exactly the "placement" tag (empty except data-slot content) wherever that component belongs — Quilt fills in the HTML and overwrites any hand-written copy on the next write. To change how one looks everywhere, call quilt.update_component; to make a new one, quilt.create_component.`] : []),
      'REQUIRED: output ONLY the screen root element HTML — <div class="min-h-dvh flex flex-col bg-background text-on-background">…</div>, a single root, no <html>/<head>/<body> wrapper. Everything below is the default vocabulary, not a gate: deviations are recorded per screen, never rejected.',
      `Colors: prefer the token classes (bg-/text-/border-/ring- + one of: ${COLOR_CLASS_NAMES.join(', ')}) — they are what makes one theme change sweep every screen. Hex, rgb(), inline style, arbitrary values and your own <style> are allowed where the tokens cannot express the design; the price is that those values will NOT follow a later theme change.`,
      `Radius: rounded-sm/md/lg/full; icons via <i data-lucide="…">; images: ${assets.length ? 'wherever a logo or brand mark belongs use the exact url of the matching entry in assets[] (these are the project\'s real files), other photos via https://picsum.photos/seed/…' : 'via https://picsum.photos/seed/…'}; navigation via <a href="/route"> with routes from the app map, href="#" for destinations that have no screen yet.`,
      `Overlay screens (routes[].presentation = "overlay", or create_screen with presentation "overlay"): ${OVERLAY_SCREEN_NOTE}`,
      'Component recipes are the house defaults — reuse them for consistency, diverge where the design calls for it. <script> tags and any https: CDN are allowed (Chart.js, ECharts, your own component library); keep the screen renderable when the CDN is slow.',
    ],
    routes: screens,
  };
}
