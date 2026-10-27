import { eq, and, or, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { problems, isUniqueViolation } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { assembleDocument, buildPrelude, extractBody, injectQids, reconcileQids, overwrittenInstances, lintScreenBody, expandComponents, OVERLAY_SCREEN_NOTE, PICSUM_PHOTO_NOTE, craftRules, statesSection, COLOR_CLASS_NAMES, DEVICE_SIZE, L, type DeviceType, type Tokens, type LintReport, type Presentation, type SurfaceStates } from '@quilt/core';
import { surfaceFor } from './surfaces.ts';
import { assetsForPrompt } from './assets.ts';
import { ownedProject } from './projects.ts';
import { createRevision, deriveLinks, hasActiveJob, setFamilyPresentation } from './screens.ts';
import { enqueueScreenshot } from './jobs.ts';
import { emitProjectEvent } from '../lib/events.ts';
import { requestLocale } from '../lib/locale.ts';
import { sharedComponentsOf, contractComponents } from './components.ts';
import { isSketchbook, nextDraftRoute, draftFrame, draftReference, DRAFT_LINT_REPORT } from './sketchbook.ts';

// MCP 底层原语（REQ-AGENT-002）：agent 自带 HTML 推进画布——同步执行：去旧 qid → 注入 → lint → 修订 → 截图队列。
// 带 jobId（派活任务载荷里的作业，ADR-015）时修订即算该工单产出；改既有屏时 expectedRevisionId 必填——
// 租约过期期间用户可能已改过这张屏，旧基线回写会顶掉他的改动，所以用 409 兜底。
// 草稿本（REQ-CORE-040）：新草稿的路由可省（服务端取 /draft-<n>），不做设计契约 lint，画框按作业选定的或根元素的 data-frame 定
export async function ingestScreen(ownerId: string, projectId: string, input: { name: string; route?: string; html?: string; uploadId?: string; screenId?: string; expectedRevisionId?: string; jobId?: string; presentation?: Presentation; surfaceId?: string; group?: string | null }) {
  const project = await ownedProject(ownerId, projectId);
  const sketch = isSketchbook(project);
  if (sketch && (input.surfaceId || input.group)) throw problems.validation([{ path: input.surfaceId ? 'surfaceId' : 'group', message: L('草稿本没有端与分组', 'The Sketchbook has no surfaces or groups') }]);
  let jobFrame: string | undefined;
  if (input.jobId) {
    const [job] = await db.select({ id: schema.generationJobs.id, status: schema.generationJobs.status, input: schema.generationJobs.input }).from(schema.generationJobs).where(and(eq(schema.generationJobs.id, input.jobId), eq(schema.generationJobs.projectId, project.id)));
    if (!job) throw problems.notFound();
    // 已结束的作业不再收产出：取消之后屏锁已释放，用户可能已在这屏上继续改了（§11 cancelled 是终态）
    if (job.status !== 'running') throw problems.jobFinished();
    if (input.screenId && !input.expectedRevisionId) throw problems.validation([{ path: 'expectedRevisionId', message: L('带 jobId 更新既有屏时必须传 expectedRevisionId（取任务载荷 screens[].revisionId）', 'Updating an existing screen with jobId requires expectedRevisionId (take it from screens[].revisionId in the job payload)') }]);
    // 草稿本里一个作业只出一张草稿（INV-CORE-003）：这个作业已写出过一张，再建就拒——改那一张走 update / patch
    if (sketch && !input.screenId) {
      const [made] = await db.select({ screenId: schema.screenRevisions.screenId }).from(schema.screenRevisions).where(eq(schema.screenRevisions.jobId, job.id)).limit(1);
      if (made) throw problems.validation([{ path: 'jobId', message: L(`这个作业已写出草稿 ${made.screenId}，草稿本里一个作业只出一张；要改它用 quilt.update_screen 或 quilt.patch_screen`, `This job already wrote draft ${made.screenId}; a job in the Sketchbook makes only one draft. To change it, use quilt.update_screen or quilt.patch_screen`) }]);
    }
    jobFrame = (job.input as { frame?: string }).frame;
  }
  const raw = input.html ?? (input.uploadId ? (await storage.get(`uploads/${input.uploadId}.html`).catch(() => null))?.toString('utf8') : null);
  if (!raw) throw problems.validation([{ path: 'html', message: 'html or a valid uploadId is required' }]);
  const all = await db.select().from(schema.screens).where(eq(schema.screens.projectId, project.id));
  // 端（REQ-CORE-049）：改既有屏落在它自己的端（屏不能换端）；新屏落在给定的端，缺省第一端。路由、lint 与排位只看这一端的屏
  const own = input.screenId ? all.find((x) => x.id === input.screenId) : undefined;
  if (input.screenId && !own) throw problems.notFound();
  if (own && input.surfaceId && input.surfaceId !== own.surfaceId) throw problems.unprocessable([{ path: 'surfaceId', message: L('屏不能换端：删了重造，或从草稿本搬进来', 'A screen cannot change surface: delete and recreate it, or move it in from the Sketchbook') }]);
  if (own?.variantOf && input.group !== undefined) throw problems.unprocessable([{ path: 'group', message: L('变体跟默认屏在同一组，改分组请改默认屏', 'A variant stays in the group of its default screen; change the group on the default screen') }]);
  const surface = sketch ? null : own ? (own.surfaceId ? await surfaceFor(project.id, own.surfaceId) : null) : await surfaceFor(project.id, input.surfaceId);
  const screens = surface ? all.filter((s) => s.surfaceId === surface.id) : all;
  const route = input.route ?? (sketch && !input.screenId ? nextDraftRoute(screens.map((s) => s.route)) : undefined);
  if (!route) throw problems.validation([{ path: 'route', message: 'route is required' }]);
  // 共享组件（REQ-EDIT-006）：agent 写进来的占位（或它手抄的副本）在这里展开成正式 HTML。
  // qid 对齐而不是全部重编（v0.65）：没动的元素保留原号，连续局部修改的锚点还对得上
  const shared = await sharedComponentsOf(project.id);
  const incoming = raw.includes('<body') ? extractBody(raw) : raw;
  const componentsOverwritten = overwrittenInstances(incoming, shared, route);
  const body = reconcileQids(expandComponents(incoming, shared, route).html);
  const routes = Array.from(new Set([...screens.map((s) => s.route), route]));
  // 偏离设计契约不阻断写入（ADR-005 v0.43）：报告随修订存下来、随返回值给 agent，取舍由写的人做；草稿不套设计系统，不 lint（ADR-030）
  const report: LintReport = sketch ? DRAFT_LINT_REPORT : lintScreenBody(body, routes, true);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  // 改的是有参照项目的草稿（REQ-CORE-042 / ADR-033）：按参照项目的 prelude 拼装，与模型通道改稿落库一致；参照项目已被删就用草稿本自己的
  const ref = sketch && input.screenId ? await draftReference(screens.find((x) => x.id === input.screenId)?.refProjectId ?? null) : null;
  const html = assembleDocument(body, ref?.prelude ?? buildPrelude(ds.tokens as Tokens), `${project.name} · ${input.name}`);
  const size = DEVICE_SIZE[(surface?.deviceType ?? project.deviceType) as DeviceType];
  let reshoot: string[] = [];
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
      // 变体的路由与呈现方式属于默认屏（v0.62 / v0.63）：经这条路改一律拒；默认屏改呈现方式，整个家族跟着改
      if (s.variantOf && route !== s.route) throw problems.unprocessable([{ path: 'route', message: L('变体与默认屏同路由，改路由请改默认屏', 'A variant shares the route of its default screen; change the route on the default screen') }]);
      if (s.variantOf && input.presentation && input.presentation !== s.presentation) throw problems.unprocessable([{ path: 'presentation', message: L('变体随默认屏的呈现方式，改呈现方式请改默认屏', 'A variant follows the presentation of its default screen; change it on the default screen') }]);
      if (route !== s.route || input.name !== s.name) await tx.update(schema.screens).set({ route, name: input.name }).where(eq(schema.screens.id, screenId));
      if (input.group !== undefined && input.group !== s.groupName) await tx.update(schema.screens).set({ groupName: input.group }).where(or(eq(schema.screens.id, screenId), eq(schema.screens.variantOf, screenId)));
      if (input.presentation && input.presentation !== s.presentation) reshoot = await setFamilyPresentation(tx, screenId, input.presentation);
      // 默认屏改路由，它的变体跟着改（v0.62 变体与默认屏同路由）
      if (route !== s.route) await tx.update(schema.screens).set({ route }).where(eq(schema.screens.variantOf, screenId));
      // 还没定画框的草稿（新草稿第一版）：作业选定的优先，否则按这一版根元素上的 data-frame 定
      if (sketch && !s.frame) await tx.update(schema.screens).set({ frame: draftFrame(jobFrame, body) }).where(eq(schema.screens.id, screenId));
    } else {
      if (screens.some((s) => s.route === route)) throw problems.routeTaken();
      const x = screens.reduce((m, s) => Math.max(m, s.x + size.w + 80), 0);
      const [s] = await tx.insert(schema.screens).values({ projectId: project.id, surfaceId: surface?.id ?? null, groupName: input.group ?? null, name: input.name, route, x, y: 0, presentation: input.presentation ?? 'push', frame: sketch ? draftFrame(jobFrame, body) : null }).returning();
      screenId = s.id;
    }
    const rev = await createRevision(tx, { projectId: project.id, screenId, html, sourceKind: 'agent_ingest', jobId: input.jobId ?? null, lintReport: report, expectedRevisionId: input.screenId ? (input.expectedRevisionId ?? screens.find((x) => x.id === input.screenId)?.currentRevisionId ?? null) : null });
    if (!rev) throw problems.revisionConflict();
    await deriveLinks(tx, project.id);
    // 回存进修订的那份：落修订时可能多记一条（页内状态与端上维度重名）
    return { screenId, revisionId: rev.id, lintReport: rev.lintReport as LintReport };
    } catch (e) { if (isUniqueViolation(e)) throw problems.routeTaken(); throw e; }
  });
  // 用过的上传位清掉：不清的话同一个 uploadId 再 append 会拼到上一屏后面
  if (input.uploadId) await storage.delete(`uploads/${input.uploadId}.html`).catch(() => {});
  // 改了呈现方式的话，家族里其他屏的当前修订也要按新方式重拍（本屏的新修订本来就要拍）
  for (const id of new Set([result.revisionId, ...reshoot])) await enqueueScreenshot(id);
  // 本机会话 / 外部 agent 经 MCP 写进来的屏没有作业事件可订阅，项目级事件让画布立刻刷新（API-CORE-030）
  await emitProjectEvent(project.id, 'screen_changed', { screenId: result.screenId, revisionId: result.revisionId, jobId: input.jobId ?? null }).catch(() => {});
  // componentsOverwritten：写进来的共享组件实例里改过的内容已被组件正式 HTML 盖回，要改它得改组件本身（quilt.update_component）
  return { ...result, danglingRoutes: report.danglingRoutes, ...(componentsOverwritten.length ? { componentsOverwritten } : {}) };
}

export async function validateScreenHtml(ownerId: string, projectId: string, html: string): Promise<LintReport> {
  const project = await ownedProject(ownerId, projectId);
  const body = injectQids((html.includes('<body') ? extractBody(html) : html).replace(/\sdata-qid="q\d+"/g, ''));
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, project.id))).map((r) => r.route);
  // 当场返回给调用方，按请求的语言写偏离说明（REQ-CORE-046）；落进修订的 lintReport 保持中文
  return lintScreenBody(body, routes, true, requestLocale());
}

// 设计契约的机器可判定投影（quilt.get_design_contract / resources）
export async function designContract(ownerId: string, projectId: string, surfaceId?: string) {
  const project = await ownedProject(ownerId, projectId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  // 按端给（REQ-CORE-049，ADR-041）：设备形态、路由表与维度都是这一端的，缺省第一端；草稿本没有端
  const surface = project.kind === 'app' ? await surfaceFor(project.id, surfaceId) : null;
  const device = (surface?.deviceType ?? project.deviceType) as DeviceType;
  const states = (surface?.states ?? null) as SurfaceStates | null;
  // 变体不进契约的路由表（v0.62）：路由已由默认屏占着，agent 看到两份只会撞路由
  const screens = await db.select({ id: schema.screens.id, name: schema.screens.name, route: schema.screens.route, purpose: schema.screens.purpose, presentation: schema.screens.presentation, group: schema.screens.groupName }).from(schema.screens)
    .where(and(surface ? eq(schema.screens.surfaceId, surface.id) : eq(schema.screens.projectId, project.id), isNull(schema.screens.variantOf)));
  // 素材清单随契约走（REQ-CORE-019）：本机会话这条链只读契约，不读 prompt 里的 PROJECT ASSETS 段，
  // 契约不给素材就只能拿 picsum 占位块糊品牌位
  const assets = await assetsForPrompt(project.id);
  // 共享组件（REQ-EDIT-006）：agent 按 placement 放占位、不手写副本；改外观走 quilt.update_component
  const sharedComponents = await contractComponents(project.id);
  return {
    projectId: project.id, name: project.name, brief: project.brief, deviceType: device, viewport: DEVICE_SIZE[device],
    ...(surface ? { surfaceId: surface.id, surface: surface.name, states } : {}),
    tokens: ds.tokens, colorClasses: COLOR_CLASS_NAMES, components: ds.components, sharedComponents, designMd: ds.designMd, version: ds.version, assets,
    rules: [
      ...(sharedComponents.length ? [`Shared components (sharedComponents[]) are project-level fragments every screen places by reference: emit exactly the "placement" tag (empty except data-slot content) wherever that component belongs — Quilt fills in the HTML and overwrites any hand-written copy on the next write. To change how one looks everywhere, call quilt.update_component; to make a new one, quilt.create_component.`] : []),
      'REQUIRED: output ONLY the screen root element HTML — <div class="min-h-dvh flex flex-col bg-background text-on-background">…</div>, a single root, no <html>/<head>/<body> wrapper. Everything below is the default vocabulary, not a gate: deviations are recorded per screen, never rejected.',
      `Colors: prefer the token classes (bg-/text-/border-/ring- + one of: ${COLOR_CLASS_NAMES.join(', ')}) — they are what makes one theme change sweep every screen. Hex, rgb(), inline style, arbitrary values and your own <style> are allowed where the tokens cannot express the design; the price is that those values will NOT follow a later theme change.`,
      `Radius: rounded-sm/md/lg/full; icons via <i data-lucide="…">; images: ${assets.length ? 'wherever a logo or brand mark belongs use the exact url of the matching entry in assets[] (these are the project\'s real files), other photos via https://picsum.photos/seed/…' : 'via https://picsum.photos/seed/…'} in a fixed frame (w-*/h-*, aspect-square or aspect-video) — ${PICSUM_PHOTO_NOTE} Avatars are initials unless assets[] has the photo; logos come only from assets[], else the app name alone as a text wordmark (no letter tile); navigation via <a href="/route"> with routes from the app map, href="#" for destinations that have no screen yet.`,
      `Overlay screens (routes[].presentation = "overlay", or create_screen with presentation "overlay"): ${OVERLAY_SCREEN_NOTE}`,
      // 做工规则（ADR-027）：与出屏提示词同一段，本机会话与外部 agent 只读契约
      craftRules(device),
      ...(surface ? [statesSection(states).trim()] : []),
      'Component recipes are the house defaults — reuse them for consistency, diverge where the design calls for it. <script> tags and any https: CDN are allowed (Chart.js, ECharts, your own component library); keep the screen renderable when the CDN is slow.',
    ],
    routes: screens,
  };
}
