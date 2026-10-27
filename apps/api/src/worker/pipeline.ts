import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, ne, sql, isNull, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { loadForModel } from '../services/attachments.ts';
import { assetsForPrompt } from '../services/assets.ts';
import { resolveChannelSpec } from '../services/channels.ts';
import { completeWithRetry, ProviderError, type LlmDriver, type LlmEffort } from '../lib/llm.ts';
import { emitJobEvent } from '../lib/events.ts';
import { countEn, listJoin, outsideRequest, tr } from '../lib/locale.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { screenshotHtml, extractTailwindCss } from '../lib/screenshot.ts';
import { recordUsage } from '../services/usage.ts';
import { recordModelCall, archiveDrafts, type ModelCallAttempt } from '../services/record.ts';
import { createRevision, deriveLinks, pointCurrentToFirstCandidate, priorInstructions, exemplarBody, currentBody, storeRevisionShot } from '../services/screens.ts';
import { screenDtos } from '../services/projects.ts';
import { timeoutFor, modelAborts, enqueueScreenshot } from '../services/jobs.ts';
import { runChatTurn, ChatFailure } from './chat.ts';
import { failJob } from './failJob.ts';
import { sharedComponentsOf, componentCards, reflowComponent, componentInstructions } from '../services/components.ts';
import { surfacesOf, type SurfaceRow } from '../services/surfaces.ts';
import { nextDraftRoute, draftReference, DRAFT_LINT_REPORT } from '../services/sketchbook.ts';
import {
  buildPrelude, lintScreenBody, injectQids, reconcileQids, applyEdits, parseEditBlocks, assembleDocument, extractBody, stripFences, buildPrototypeDocument, replaceSubtree, extractLinks,
  expandComponents, validateComponentHtml, classifyComponentHtml, componentSummary, componentSystemPrompt, componentUserPrompt,
  type ProjectAsset, type SketchReference,
  OVERLAY_SCREEN_NOTE, screenSystemPrompt, planSystemPrompt, planUserPrompt, planOneScreenSystemPrompt, planOneScreenUserPrompt, screenUserPrompt, editUserPrompt, editPatchUserPrompt, subtreeUserPrompt, subtreeBlocksUserPrompt, subtreeBlocksRetryNote, NEEDS_OUTER_RE, parseQuiltBlocks, type QuiltBlock, linkRepairPrompt,
  proposeDesignSystemSystemPrompt, proposeDesignSystemUserPrompt, parseConventions, REFERENCE_IMAGE_NOTE, FONT_FAMILIES, RADIUS_SCALES, MAX_CONVENTIONS,
  proposeStatesSystemPrompt, proposeStatesUserPrompt, type StatesProposalDto, type SurfaceStates, type OtherSurface, MAX_DIM_VALUES, MIN_DIM_VALUES, EVENT_MS,
  sketchSystemPrompt, SKETCH_REFERENCE_IMAGE_NOTE, draftNameFromPrompt, frameFromBody, shotSpecFor, withSurfaceStates,
  VENDOR, inputOf, jobInputSchemas, type ModelCallPurpose, withUiLanguage, jobLocale, DEVICE_SIZE, type DeviceType, type Tokens, type ComponentRecipe, type Plan, type PlannedScreen, type LintReport, type ErrorClass, type RegistryEntry, type ReferenceScreen, type DesignProposalDto, type CreateJobInput, type JobKind, type JobInputOf, type Presentation, type DraftFrame, failureText,
} from '@quilt/core';

// 导出件内联的 lucide 取仓库里与屏同版本的副本（§17 v1.06），不走外网
let lucideCache: string | null = null;
async function lucideJs(): Promise<string> {
  lucideCache ??= await readFile(path.join(config.vendorDir, VENDOR[1].file), 'utf8');
  return lucideCache;
}

// REQ-PROTO-004：导出单文件原型（确定性，不调 LLM）
// 端（REQ-CORE-049）：只导出这一端的屏（缺省第一端），状态维度按缺省取值（API-PROTO-002）
async function runExportPrototype(ctx: Ctx): Promise<string> {
  const screens = await db.select().from(schema.screens).where(screensOf(ctx)).orderBy(schema.screens.createdAt);
  const exportScreens: { route: string; name: string; body: string; presentation: 'push' | 'overlay' }[] = [];
  for (const s of screens) {
    if (!s.currentRevisionId) continue;
    const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
    // 变体不导出（v0.62）：与默认屏同路由，hash 路由容不下两份
    if (s.variantOf) continue;
    exportScreens.push({ route: s.route, name: s.name, body: extractBody((await storage.get(rev.htmlKey)).toString('utf8')), presentation: s.presentation as 'push' | 'overlay' });
  }
  if (!exportScreens.length) throw new JobFailure('validation', 'project has no screens to export');
  const [tailwindCss, lucide] = await Promise.all([extractTailwindCss(ctx.prelude, exportScreens.map((s) => s.body)), lucideJs()]);
  const html = buildPrototypeDocument({ title: `${ctx.project.name}${ctx.surface && (await surfacesOf(ctx.project.id)).length > 1 ? ` · ${ctx.surface.name}` : ''} · prototype`, tokens: ctx.tokens, screens: exportScreens, tailwindCss, lucideJs: lucide, states: (ctx.surface?.states as SurfaceStates | undefined) ?? null });
  const key = objectKeys.exportHtml(ctx.project.id, ctx.job.id);
  await storage.put(key, html, 'text/html; charset=utf-8');
  await emitJobEvent(ctx.job.id, 'progress', { stage: 'exported', screens: exportScreens.length, bytes: Buffer.byteLength(html) });
  return key;
}

type JobRow = typeof schema.generationJobs.$inferSelect;
type Ctx = {
  job: JobRow; project: typeof schema.projects.$inferSelect; ds: typeof schema.designSystems.$inferSelect;
  device: DeviceType; tokens: Tokens; prelude: string; signal: AbortSignal;
  // 这一轮落在哪一端（REQ-CORE-049）：造屏取 input.surfaceId，改屏取目标屏所在的端；草稿本为 null。device 取它的设备
  surface: SurfaceRow | null;
  usage: { tokensIn: number; tokensOut: number; screens: number; cacheRead: number; cacheWrite: number };
  // 本作业用哪个驱动 / 模型 / 凭据（REQ-CORE-011 / 013）；缺省取 .env 的 LLM_DRIVER 与凭据
  runner: { driver?: LlmDriver; model?: string; apiKey?: string; baseUrl?: string };
  // 本作业的参考图（REQ-CORE-012），整轮只读一次对象存储
  images: { mediaType: string; dataBase64: string }[];
  // 本项目的素材清单（REQ-CORE-019），整轮只读一次，进每屏的 system 前缀
  assets: ProjectAsset[];
  produced: { screenId: string; revisionId: string; lintPassed: boolean }[];
  // 这个作业计划落几版修订（造屏 / 改屏 / 重生成一块）：全部落库后被时限中止不判失败（§11 v1.03）
  planned?: number;
  // 反向连线（REQ-CORE-014）：造一组屏后对入口屏跑了一次补链，回执里点名
  entryRepair: { name: string; added: string[] } | null;
  // 草稿这一轮按参照项目写（REQ-CORE-042 / ADR-033）：参考图说明换回守设计系统的那一句
  draftReferenced?: boolean;
  // 本作业已发出几次模型调用：使用记录的 model_calls.seq（REQ-CORE-047）
  calls: number;
};

class JobFailure extends Error { constructor(public errorClass: ErrorClass, msg: string) { super(msg); } }

// 这一轮看得到的屏：有端时只是这一端的（路由、注册表、排版、lint 都按端，INV-CORE-010），草稿本是整个草稿本
const screensOf = (ctx: Ctx) => (ctx.surface ? eq(schema.screens.surfaceId, ctx.surface.id) : eq(schema.screens.projectId, ctx.project.id));
const surfaceStates = (ctx: Ctx): SurfaceStates | null => (ctx.surface ? ctx.surface.states as SurfaceStates : null);

// 取消或超时之后回来的模型产出不落库（§11 running→cancelled）：屏锁此刻已释放，用户可能已在这屏上继续改了。
// 每处写修订 / 组件行之前都要过这一道——模型调用本身不一定理会中止（stub、重试退避里的调用）
function assertNotAborted(ctx: Ctx) {
  if (ctx.signal.aborted) throw new JobFailure('timeout', 'job aborted before its output was written');
}

// 共享组件占位（REQ-EDIT-006）在落修订前一刻按最新组件展开：模型一跑几分钟，这期间改的组件在回刷时跳过了这屏（它有在跑作业），
// 拿作业开跑时的组件快照展开，这屏就永久停在旧版
async function expandLatest(ctx: Ctx, body: string, route: string): Promise<string> {
  return expandComponents(body, await sharedComponentsOf(ctx.project.id), route).html;
}

// 参考图只跟第一次出屏 / 改屏的调用走；修复轮是「按 lint 违规改你上一版 HTML」，
// 再把图塞一遍既多花 token 又会把模型往复刻方向带（REQ-CORE-012）
// effort：按调用类型定思考深度（ADR-012 v1.05）——规划与提炼 low、改屏补丁 medium，其余不传（驱动缺省）
// 草稿本（REQ-CORE-040）换一句参考图说明：没有设计系统要守，参考图可以照着取色；草稿按参照项目写时仍守它的设计系统
// 网页端建的写屏作业带界面语言（REQ-CORE-046）：系统提示末尾补一句「请求没说语言时屏上文字用 <语言>」，预热与正式调用同一份前缀
// 使用记录（REQ-CORE-047 / ADR-035）：这里是所有模型调用的唯一出口，每次调用按 purpose 记一条 model_calls（成败、错误原文、试了几次、token、参考图键），
// 正文是拼好的提示词与原始回复；开关关着不记，记不上不影响作业
async function llmCall(ctx: Ctx, purpose: ModelCallPurpose, systemPrompt: string, prompt: string, model?: string, withImages = false, opts: { effort?: LlmEffort; maxTokens?: number } = {}) {
  const system = withUiLanguage(systemPrompt, ctx.job);
  const images = withImages ? ctx.images : undefined;
  const spec = ctx.runner.driver ? { driver: ctx.runner.driver, apiKey: ctx.runner.apiKey, baseUrl: ctx.runner.baseUrl } : undefined;
  const imageNote = ctx.project.kind === 'sketchbook' && !ctx.draftReferenced ? SKETCH_REFERENCE_IMAGE_NOTE : REFERENCE_IMAGE_NOTE;
  const fullPrompt = withImages && images?.length ? `${imageNote}\n\n${prompt}` : prompt;
  const seq = ++ctx.calls; const startedAt = new Date();
  const attempts: ModelCallAttempt[] = [];
  const record = (ok: boolean, r: { text: string; tokensIn: number; tokensOut: number; model: string } | null, error: string | null) => recordModelCall({
    userId: ctx.job.createdBy, jobId: ctx.job.id, projectId: ctx.project.id, seq, purpose, runner: ctx.job.runner, driver: ctx.runner.driver ?? config.llmDriver, model: r?.model ?? ctx.runner.model ?? model ?? config.model,
    ok, error, attempts, tokensIn: r?.tokensIn ?? 0, tokensOut: r?.tokensOut ?? 0, imageKeys: images?.length ? ((ctx.job.input as { imageKeys?: string[] }).imageKeys ?? []) : [],
    system, prompt: fullPrompt, response: r?.text ?? null, startedAt, finishedAt: new Date(),
  });
  let r: Awaited<ReturnType<typeof completeWithRetry>>;
  try {
    r = await completeWithRetry({ system, prompt: fullPrompt, images, model: ctx.runner.model ?? model, spec, signal: ctx.signal, ...opts }, (n, err) => {
      attempts.push({ attempt: n, ok: false, error: err.message, at: new Date().toISOString() });
      void emitJobEvent(ctx.job.id, 'progress', { stage: 'retry', attempt: n, error: err.message }).catch(() => {});
    });
  } catch (e) {
    attempts.push({ attempt: attempts.length + 1, ok: false, error: (e as Error).message, at: new Date().toISOString() });
    await record(false, null, (e as Error).message);
    throw e;
  }
  attempts.push({ attempt: attempts.length + 1, ok: true, at: new Date().toISOString() });
  await record(true, r, null);
  ctx.usage.tokensIn += r.tokensIn; ctx.usage.tokensOut += r.tokensOut;
  ctx.usage.cacheRead += r.cacheRead ?? 0; ctx.usage.cacheWrite += r.cacheWrite ?? 0;
  return r.text;
}

// 扇出（ADR-012 v1.05）：一个作业内并行 ≤ min(6, max(4, 调用数))——6 个调用以内一波发完，不让第 5、6 屏等第一波连同截图跑完。
// 走 API Key 的 Anthropic 通道先用同一系统提示发一次 max_tokens 0 写缓存：缓存要等第一个响应开始返回才能被读到，不预热的话首波各按全价写一次
const fanOut = (calls: number) => Math.min(6, Math.max(config.screenConcurrency, calls));
async function warmPrefix(ctx: Ctx, system: string, calls: number, model?: string) {
  if (calls < 2 || (ctx.runner.driver ?? config.llmDriver) !== 'anthropic') return;
  try { await llmCall(ctx, 'warmup', system, 'Warm-up: reply with nothing.', model, false, { maxTokens: 0 }); }
  catch (e) { console.warn(`[job ${ctx.job.id}] cache warm-up skipped: ${(e as Error).message}`); }
}

// 改一屏（ADR-007 v1.05）：先要补丁块，按序套在当前 body 上；任一块对不上就整批作废，同一轮改用整屏提示词再要一次。
// 产出里没有补丁块（模型判断改动占了大半屏、直接回整屏）时按整屏处理。返回的 body 还没对齐 qid，由 produceScreen 做
async function editBody(ctx: Ctx, args: { system: string; name: string; route: string; body: string; instruction: string; prior: string[] }): Promise<string> {
  const raw = await llmCall(ctx, 'edit', args.system, editPatchUserPrompt(args.name, args.route, args.body, args.instruction, args.prior), undefined, true, { effort: 'medium' });
  const edits = parseEditBlocks(raw);
  if (!edits) return stripFences(raw);
  const applied = applyEdits(args.body, edits);
  if (!applied.errors.length) return applied.body;
  console.warn(`[job ${ctx.job.id}] patch for ${args.route} did not apply (${applied.errors.map((e) => `#${e.index}:${e.matches}`).join(' ')}), rewriting the whole screen`);
  return stripFences(await llmCall(ctx, 'edit', args.system, editUserPrompt(args.name, args.route, args.body, args.instruction, args.prior), undefined, true));
}

function parseJsonObject<T>(text: string): T {
  const s = stripFences(text);
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object');
  return JSON.parse(s.slice(start, end + 1)) as T;
}
function parsePlan(text: string): Plan {
  const plan = parseJsonObject<Plan>(text);
  if (!Array.isArray(plan.screens) || plan.screens.length === 0) throw new Error('empty plan');
  return { ...plan, screens: plan.screens.map((p) => ({ ...p, presentation: p.presentation === 'overlay' ? 'overlay' as const : 'push' as const })) };
}
function parseOne(text: string): PlannedScreen & { entryFrom?: string | null } {
  const o = parseJsonObject<Partial<PlannedScreen> & { entryFrom?: string | null }>(text);
  if (!o.route || !o.name) throw new Error('plan missing name/route');
  return { presentation: o.presentation === 'overlay' ? 'overlay' as const : 'push' as const, name: o.name, route: o.route.startsWith('/') ? o.route : `/${o.route}`, purpose: o.purpose ?? '', links: Array.isArray(o.links) ? o.links : [], sections: Array.isArray(o.sections) && o.sections.length ? o.sections : ['header', 'main content', 'primary action'], entryFrom: o.entryFrom ?? null };
}

// ---- 上下文（ADR-012 v0.31）：稳定前缀里的屏注册表 + 情境层的参考屏 ----
// projectId 缺省是本作业的项目；草稿取的是参照项目的（REQ-CORE-042）
async function registry(ctx: Ctx, projectId = ctx.project.id): Promise<RegistryEntry[]> {
  // 变体不进注册表（v0.62）：路由已由默认屏占着，列两份只会让规划器与 ALLOWED ROUTES 重复；有端时只取这一端（REQ-CORE-049）
  const scope = projectId === ctx.project.id ? screensOf(ctx) : eq(schema.screens.projectId, projectId);
  const rows = await db.select({ route: schema.screens.route, name: schema.screens.name, purpose: schema.screens.purpose }).from(schema.screens).where(and(scope, isNull(schema.screens.variantOf))).orderBy(schema.screens.createdAt);
  return rows.map((r) => ({ route: r.route, name: r.name, purpose: r.purpose || undefined }));
}
// 参考屏合计 ≤ 40 KB（≈ 10K token 预算里给参考屏的份额），超了先丢排在后面的：一般是来源屏；
// 出变体时默认屏排第一、样板屏在后——变体要照着默认屏改状态，丢了它模型就只能照样板屏重画整屏
const REF_BUDGET = 40 * 1024;
// omitScreenId（ADR-012 v1.05）：只改样板屏这一屏时，它的当前 HTML 已在用户提示的 CURRENT HTML 里，参考屏里不重复放
async function references(ctx: Ctx, opts: { sourceScreenId?: string | null; variant?: boolean; omitScreenId?: string } = {}): Promise<ReferenceScreen[]> {
  const out: ReferenceScreen[] = [];
  const ex = await referenceScreen(ctx);
  if (ex && ex.screenId !== opts.omitScreenId) out.push({ label: ex.elsewhere ? 'exemplar screen from ANOTHER surface of this product (possibly another device): match its visual language only — colours, type, density — and do not copy its layout' : 'exemplar screen (the project\'s style anchor)', body: ex.body });
  if (opts.sourceScreenId && opts.sourceScreenId !== ex?.screenId) {
    const b = await currentBody(opts.sourceScreenId);
    if (b && opts.variant) out.unshift({ label: 'default screen (the new screen is this same screen in another state)', body: b });
    else if (b) out.push({ label: 'source screen (the screen that links into the new one)', body: b });
  }
  while (out.reduce((n, r) => n + r.body.length, 0) > REF_BUDGET && out.length > 1) out.pop();
  return out;
}
const app = (ctx: Ctx, description: string) => ({ name: ctx.project.name, description, brief: ctx.project.brief });

// 参考屏（API-CORE-006 端条目）：样板屏在这一端时照旧取它；不在时取这一端最早的一张整屏默认屏；这一端还没有屏时用样板屏，注明只学视觉
async function referenceScreen(ctx: Ctx): Promise<{ screenId: string; body: string; elsewhere: boolean } | null> {
  if (!ctx.surface) { const ex = await exemplarBody(ctx.project); return ex && { ...ex, elsewhere: false }; }
  if (ctx.project.exemplarScreenId) {
    const [pinned] = await db.select({ surfaceId: schema.screens.surfaceId }).from(schema.screens).where(eq(schema.screens.id, ctx.project.exemplarScreenId));
    if (pinned?.surfaceId === ctx.surface.id) { const ex = await exemplarBody(ctx.project); if (ex) return { ...ex, elsewhere: false }; }
  }
  const [row] = await db.select({ htmlKey: schema.screenRevisions.htmlKey, screenId: schema.screenRevisions.screenId })
    .from(schema.screens).innerJoin(schema.screenRevisions, eq(schema.screenRevisions.id, schema.screens.currentRevisionId))
    .where(and(eq(schema.screens.surfaceId, ctx.surface.id), isNull(schema.screens.variantOf), eq(schema.screens.presentation, 'push')))
    .orderBy(schema.screens.createdAt).limit(1);
  if (row) return { screenId: row.screenId, body: extractBody((await storage.get(row.htmlKey)).toString('utf8')), elsewhere: false };
  const ex = await exemplarBody(ctx.project);
  return ex && { ...ex, elsewhere: true };
}

// 规划器的参照（REQ-CORE-049 / REQ-CORE-050）：这一端已有的分组名，与其他端的页面表（只作参照、不连线）
async function planContext(ctx: Ctx, rows: (typeof schema.screens.$inferSelect)[]) {
  const groups = Array.from(new Set(rows.map((r) => r.groupName).filter((g): g is string => !!g)));
  if (!ctx.surface) return { groups };
  const others: OtherSurface[] = [];
  for (const f of (await surfacesOf(ctx.project.id)).filter((f) => f.id !== ctx.surface!.id)) {
    const list = await db.select({ route: schema.screens.route, name: schema.screens.name, purpose: schema.screens.purpose, group: schema.screens.groupName }).from(schema.screens)
      .where(and(eq(schema.screens.surfaceId, f.id), isNull(schema.screens.variantOf))).orderBy(schema.screens.createdAt);
    others.push({ name: f.name, device: f.deviceType as DeviceType, registry: list.map((r) => ({ route: r.route, name: r.name, purpose: r.purpose || undefined, group: r.group ?? undefined })) });
  }
  return { groups, others, surface: ctx.surface.name };
}
// 规划器给的分组名：去掉首尾空白，截到 20 字；空的当没给
const cleanGroup = (g: unknown): string | null => (typeof g === 'string' && g.trim() ? Array.from(g.trim()).slice(0, 20).join('') : null);

// 改草稿与只改一块的系统提示词（REQ-CORE-040 / REQ-CORE-045）：草稿规则 + 这张草稿的画框；有参照项目时（REQ-CORE-042 / ADR-033）
// 再带它的 DESIGN.md、token 类、组件配方与路由表，这一轮落库也换成它的 prelude。参照项目已被删就按自由风格
async function draftSystem(ctx: Ctx, draft: { frame: string | null; refProjectId: string | null }): Promise<string> {
  const found = await draftReference(draft.refProjectId);
  let ref: SketchReference | undefined;
  if (found) {
    ctx.prelude = found.prelude;
    ctx.draftReferenced = true;
    ref = { app: { name: found.project.name, description: 'existing app', brief: found.project.brief }, tokens: found.ds.tokens as Tokens, designMd: found.ds.designMd, components: found.ds.components as ComponentRecipe[], registry: await registry(ctx, found.project.id) };
  }
  return sketchSystemPrompt((draft.frame as DraftFrame | null) ?? 'auto', ref);
}

// 单屏单版：生成/编辑 → 展开共享组件 → lint（只报告）→ 注入 qid → 落修订 → 截图
// 出屏给 prompt（调一次模型）；改屏给已经套好补丁的 body（editBody），qid 用 reconcileQids 对齐——没改的元素保住原来的 qid（ADR-007 v1.05）
async function produceScreen(ctx: Ctx, args: { screenId: string; system: string; prompt?: string; body?: string; sourceKind: 'generate' | 'edit'; expectedRevisionId?: string | null; parentRevisionId?: string | null; candidateIndex?: number | null; advanceCurrent?: boolean; model?: string }) {
  const raw = args.body ?? await llmCall(ctx, 'screen', args.system, args.prompt!, args.model, true);
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, args.screenId));
  // 共享组件占位在这里展开成正式 HTML，再 lint、再打 qid——模型手写的副本也会被盖成正式版
  const body = await expandLatest(ctx, stripFences(raw), screen.route);
  const sketch = ctx.project.kind === 'sketchbook';
  const withQids = args.sourceKind === 'edit' ? reconcileQids(body) : injectQids(body);
  // v0.43：偏离设计契约不再触发修复回合，也不再让作业失败——token 是共享词汇表，不是判分标准。
  // 报告照算，进 lintReport 与 screen_html_ready 事件，画布逐屏显示偏离了什么。
  // 草稿（REQ-CORE-040）没有设计契约可偏离，记空报告
  let report: LintReport = DRAFT_LINT_REPORT;
  if (!sketch) {
    const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(screensOf(ctx))).map((r) => r.route);
    report = lintScreenBody(body, routes, true);
    report = lintScreenBody(withQids, routes, report.firstTry); // 违规带上 qid
  }
  const html = assembleDocument(withQids, ctx.prelude, `${ctx.project.name} · ${screen.name}`);
  assertNotAborted(ctx);
  const rev = await db.transaction(async (tx) => {
    const created = await createRevision(tx, { projectId: ctx.project.id, screenId: args.screenId, html, sourceKind: args.sourceKind, jobId: ctx.job.id, lintReport: report, expectedRevisionId: args.expectedRevisionId, parentRevisionId: args.parentRevisionId, candidateIndex: args.candidateIndex, advanceCurrent: args.advanceCurrent });
    // 画框选「自动」的新草稿：与第一版同一事务按根元素的 data-frame 定下 screens.frame（缺失或不认识按 component），
    // 草稿本页收到 screen_html_ready 重取时画框已在
    if (created && sketch && !screen.frame) {
      await tx.update(schema.screens).set({ frame: frameFromBody(withQids) ?? 'component' }).where(and(eq(schema.screens.id, args.screenId), isNull(schema.screens.frame)));
    }
    return created;
  });
  if (!rev) throw new JobFailure('validation', 'revision conflict');
  ctx.usage.screens += 1;
  ctx.produced.push({ screenId: args.screenId, revisionId: rev.id, lintPassed: report.passed });
  await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: args.screenId, revisionId: rev.id, candidateIndex: args.candidateIndex ?? null, lintPassed: report.passed, violations: report.violations.length, dangling: report.danglingRoutes });
  await screenshotRevision(ctx, args.screenId, rev.id, html);
  return { rev, report, body: withQids };
}

async function screenshotRevision(ctx: Ctx, screenId: string, revisionId: string, html: string) {
  try {
    const [row] = await db.select({ presentation: schema.screens.presentation, frame: schema.screens.frame, device: schema.surfaces.deviceType, states: schema.surfaces.states })
      .from(schema.screens).leftJoin(schema.surfaces, eq(schema.surfaces.id, schema.screens.surfaceId)).where(eq(schema.screens.id, screenId));
    const presentation = (row?.presentation ?? 'push') as Presentation;
    // 尺寸按项目类型与画框（REQ-CORE-040）：草稿按画框拍，组件画框只拍根元素的框；普通屏按它所在端的设备形态，状态取缺省（API-CORE-016）
    const shot = shotSpecFor({ kind: ctx.project.kind, deviceType: row?.device ?? ctx.project.deviceType }, { frame: row?.frame ?? null });
    const png = await screenshotHtml(withSurfaceStates(html, row?.states as SurfaceStates | null), shot.size, { overlay: presentation === 'overlay', rootOnly: shot.rootOnly });
    const key = await storeRevisionShot(ctx.project.id, screenId, revisionId, png, presentation, row?.frame ?? null);
    if (!key) return;
    await emitJobEvent(ctx.job.id, 'screen_screenshot_ready', { screenId, revisionId, screenshotUrl: await storage.signedUrl(key) });
  } catch (e) {
    // 拍失败不影响作业（修订已落库）：交给 screenshot.render 队列重试，拍成后由它推 screen_changed 让画布换图
    console.warn(`[job ${ctx.job.id}] screenshot failed for ${revisionId}: ${(e as Error).message}`);
    await enqueueScreenshot(revisionId);
  }
}

// 一个任务失败就不再领新任务，但要等已在跑的都结束再抛第一个错：直接 Promise.all 会让作业先判失败、其余任务在它身后继续落修订
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0; let first: unknown = null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && first === null) { try { await fn(items[i++]); } catch (e) { first ??= e; } }
  }));
  if (first !== null) throw first;
}

async function uniqueRoute(ctx: Ctx, route: string): Promise<string> {
  const taken = new Set((await db.select({ route: schema.screens.route }).from(schema.screens).where(screensOf(ctx))).map((r) => r.route));
  if (!taken.has(route)) return route;
  for (let k = 2; k < 100; k++) if (!taken.has(`${route}-${k}`)) return `${route}-${k}`;
  throw new JobFailure('validation', 'route space exhausted');
}

// 造（REQ-CORE-003 / REQ-CORE-014 / REQ-PROTO-003 三合一）：
// route 钉死 = 懒生成（跳过规划器）；count=1 走单屏规划；count 2–4 / auto 走整组规划（空项目首轮顺手扩写应用简介）。
// 每张新屏 × versions 版并行出屏；versions>1 时落为候选、current 指向第 1 版。
// 规划器声明了入口屏（entryFrom）就对它跑一次补链——反向连线。
async function runGenerate(ctx: Ctx) {
  const input = inputOf(ctx.job, 'generate');
  if (ctx.project.kind === 'sketchbook') return runGenerateDraft(ctx, input);
  const versions = Math.max(1, input.versions ?? 1);
  const existingRows = await db.select().from(schema.screens).where(screensOf(ctx)).orderBy(schema.screens.createdAt);
  const planCtx = await planContext(ctx, existingRows);
  const existing: RegistryEntry[] = existingRows.filter((s) => !s.variantOf).map((s) => ({ route: s.route, name: s.name, purpose: s.purpose || undefined }));
  const existingRoutes = new Set(existing.map((r) => r.route));
  const empty = existingRows.length === 0;
  const a = app(ctx, input.prompt);
  let planned: PlannedScreen[];
  let entryFrom: string | null = null;
  // 造变体（v0.62 REQ-CORE-025）：钉死默认屏的路由、跳过规划器、默认屏作参考屏；变体只有一层
  const base = input.variantOf ? existingRows.find((s) => s.id === input.variantOf) : undefined;
  if (input.variantOf && (!base || base.variantOf)) throw new JobFailure('validation', 'variantOf must be a default screen of this project');
  if (base && input.variantName) {
    const baseLinks = (await db.select({ href: schema.links.href }).from(schema.links).where(eq(schema.links.fromScreenId, base.id))).map((l) => l.href);
    planned = [{ name: `${base.name} · ${input.variantName}`, route: base.route, purpose: `The "${input.variantName}" state of "${base.name}"${base.purpose ? ` (${base.purpose})` : ''}`, links: Array.from(new Set(baseLinks.filter((h) => existingRoutes.has(h)))), sections: [], presentation: base.presentation as 'push' | 'overlay', group: base.groupName ?? undefined }];
  } else if (input.route) {
    if (existingRoutes.has(input.route)) throw new JobFailure('validation', 'route already exists');
    const from = existingRows.find((s) => s.id === input.fromScreenId);
    const name = input.name ?? (input.route.split('/').filter(Boolean).map((p) => p.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())).join(' ') || 'Screen');
    planned = [{ name, route: input.route, purpose: `Screen reached from "${from?.name ?? 'another screen'}" via link ${input.route}`, links: from ? [from.route] : [], sections: ['header with back arrow', 'main content matching the route name', 'primary action'], presentation: input.presentation ?? 'push', group: from?.groupName ?? undefined }];
    entryFrom = from?.route ?? null;
  } else if (input.count === 1) {
    const planPrompt = planOneScreenUserPrompt(a, input.prompt, existing, planCtx);
    let one: ReturnType<typeof parseOne>;
    try { one = parseOne(await llmCall(ctx, 'plan', planOneScreenSystemPrompt(), planPrompt, undefined, false, { effort: 'low' })); }
    catch { one = parseOne(await llmCall(ctx, 'plan', planOneScreenSystemPrompt(), planPrompt + '\nReturn strictly valid JSON.', undefined, false, { effort: 'low' })); }
    planned = [one];
    entryFrom = one.entryFrom ?? null;
  } else {
    const system = planSystemPrompt({ count: input.count, empty });
    const planPrompt = planUserPrompt(a, input.prompt, existing, planCtx);
    let plan: Plan;
    try { plan = parsePlan(await llmCall(ctx, 'plan', system, planPrompt, undefined, false, { effort: 'low' })); }
    catch { plan = parsePlan(await llmCall(ctx, 'plan', system, planPrompt + '\nReturn strictly valid JSON.', undefined, false, { effort: 'low' })); }
    planned = plan.screens.slice(0, input.count === 'auto' ? 6 : input.count);
    entryFrom = empty ? null : (plan.entryFrom ?? null);
    // 应用简介（REQ-CORE-016）：只在空项目首轮、且用户没写过时落库
    if (empty && plan.brief && !ctx.project.brief.trim()) {
      const brief = String(plan.brief).slice(0, 2000);
      await db.update(schema.projects).set({ brief }).where(eq(schema.projects.id, ctx.project.id));
      ctx.project = { ...ctx.project, brief };
    }
  }
  if (entryFrom && !existingRoutes.has(entryFrom)) entryFrom = null;
  const plannedRoutes = new Set(planned.map((p) => p.route));
  planned = planned.map((p) => ({ ...p, links: (p.links ?? []).filter((l) => existingRoutes.has(l) || plannedRoutes.has(l)) }));

  const created: { screenId: string; s: PlannedScreen }[] = [];
  for (const s of planned) {
    const route = base ? s.route : await uniqueRoute(ctx, s.route);
    // 新屏落在这一端（INV-CORE-009），分组取请求给的、否则规划器给的；变体与默认屏同一端同一组
    const groupName = base ? base.groupName : input.group ?? cleanGroup(s.group);
    const [screen] = await db.insert(schema.screens).values({ projectId: ctx.project.id, surfaceId: ctx.surface?.id ?? null, groupName, name: s.name, route, purpose: s.purpose ?? '', x: 0, y: 0, presentation: s.presentation ?? 'push', variantOf: base?.id ?? null, variantName: base ? input.variantName ?? null : null }).returning();
    created.push({ screenId: screen.id, s: { ...s, route } });
    await emitJobEvent(ctx.job.id, 'screen_planned', { screenId: screen.id, name: s.name, route, purpose: s.purpose });
  }
  if (base) await layoutVariant(ctx, created[0].screenId, base.id); else await layoutNewScreens(ctx, created.map((c) => c.screenId), input.anchor);

  const all = created.map((c) => c.s);
  const reg = await registry(ctx);
  const sourceId = base?.id ?? input.fromScreenId ?? existingRows.find((s) => s.route === entryFrom)?.id ?? null;
  // 共享组件卡（REQ-EDIT-006）：每个组件一张卡，框选的那些附完整 HTML
  const system = screenSystemPrompt(a, ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], reg, await references(ctx, { sourceScreenId: sourceId, variant: !!base }), ctx.assets, await componentCards(ctx.project.id, { ids: input.componentIds }), surfaceStates(ctx));
  const tasks = created.flatMap((c) => Array.from({ length: versions }, (_, i) => ({ c, i })));
  ctx.planned = tasks.length;
  try {
    await warmPrefix(ctx, system, tasks.length, empty ? config.modelInitial : undefined);
    await pool(tasks, fanOut(tasks.length), async ({ c, i }) => {
      if (ctx.signal.aborted) return;
      await produceScreen(ctx, {
        screenId: c.screenId, system, prompt: screenUserPrompt(c.s, all, base ? { variant: { ofName: base.name, name: input.variantName! } } : {}), sourceKind: 'generate', model: empty ? config.modelInitial : undefined,
        expectedRevisionId: versions === 1 ? null : undefined, parentRevisionId: null,
        candidateIndex: versions > 1 ? i : null, advanceCurrent: versions === 1,
      });
    });
  } finally {
    // 失败或取消也要收尾：已出的候选让 current 指过去；一版都没出的新屏删掉，不让空屏占着路由（它还会让指向该路由的链接不显示为断链）
    if (versions > 1) for (const c of created) await db.transaction((tx) => pointCurrentToFirstCandidate(tx, c.screenId, ctx.job.id));
    const blank = (await db.select({ id: schema.screens.id }).from(schema.screens).where(and(inArray(schema.screens.id, created.map((c) => c.screenId)), isNull(schema.screens.currentRevisionId)))).map((r) => r.id);
    if (blank.length) await db.delete(schema.screens).where(inArray(schema.screens.id, blank));
  }
  // 后面还要对入口屏跑反向连线时，新屏一落地先派生一次应用地图：懒生成补的那张屏此刻已能解析断链，不必等反向连线跑完。
  // 没有反向连线时，收尾的那次派生紧接着就到，这里不重复（REL-5）
  const entry = entryFrom ? existingRows.find((s) => s.route === entryFrom) : null;
  if (ctx.produced.length && entry?.currentRevisionId && !ctx.signal.aborted) await db.transaction((tx) => deriveLinks(tx, ctx.project.id));
  // 样板屏（REQ-CORE-016）：没钦定过就以本次第 1 张整屏默认屏为默认——变体是某个状态、叠层是透明弹层，都当不了风格锚点
  const pin = base ? undefined : created.find((c) => c.s.presentation !== 'overlay');
  if (!ctx.project.exemplarScreenId && pin) {
    await db.update(schema.projects).set({ exemplarScreenId: pin.screenId }).where(and(eq(schema.projects.id, ctx.project.id), sql`${schema.projects.exemplarScreenId} is null`));
  }
  // 反向连线（REQ-CORE-014）：对入口屏跑一次接上跳转（补丁，ADR-007 v1.05）；入口屏此刻被用户改了（修订冲突）就跳过，不让整个造屏失败
  if (entry?.currentRevisionId && !ctx.signal.aborted) {
    try {
      const before = (await currentBody(entry.id)) ?? '';
      const patched = await editBody(ctx, { system, name: entry.name, route: entry.route, body: before, instruction: linkRepairPrompt(created.map((c) => c.s.route)), prior: await priorInstructions(entry.id, entry.currentRevisionId) });
      const { body } = await produceScreen(ctx, { screenId: entry.id, system, body: patched, sourceKind: 'edit', expectedRevisionId: entry.currentRevisionId });
      const had = new Set(extractLinks(before).map((l) => l.href));
      const added = Array.from(new Set(extractLinks(body).map((l) => l.href).filter((h) => !had.has(h))));
      ctx.entryRepair = { name: entry.name, added };
    } catch (e) {
      console.warn(`[job ${ctx.job.id}] entry link repair skipped: ${(e as Error).message}`);
    }
  }
}

// 新草稿（REQ-CORE-040 / INV-CORE-003）：单屏单版，用户这句话原样作提示词（参考图照带）；不走规划器、不排版、不钉样板屏、不跑反向连线——
// 草稿之间没有路由关系，也没有风格锚点。用户选定了画框就建屏时写好；auto 留空，第一版落库时按根元素的 data-frame 定（produceScreen）
async function runGenerateDraft(ctx: Ctx, input: JobInputOf<'generate'>) {
  const frame = input.frame ?? 'auto';
  const name = draftNameFromPrompt(input.prompt);
  const route = nextDraftRoute((await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id))).map((r) => r.route));
  // 带参照项目时（REQ-CORE-042）第一版就按它写、按它的 prelude 落库；建作业之后它被删了就按自由风格出，草稿也不记参照
  const system = await draftSystem(ctx, { frame: frame === 'auto' ? null : frame, refProjectId: input.refProjectId ?? null });
  const refProjectId = ctx.draftReferenced ? input.refProjectId! : null;
  // 建屏的同时把它记成本作业的目标屏：删屏、改屏、回溯靠 target_screen_id 判忙（§16），生成中的新草稿要和改屏中的屏一样挡住（FLOW-SKETCH S9）
  const screen = await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.screens).values({ projectId: ctx.project.id, name, route, purpose: '', x: 0, y: 0, frame: frame === 'auto' ? null : frame, refProjectId }).returning();
    await tx.update(schema.generationJobs).set({ targetScreenId: row.id }).where(eq(schema.generationJobs.id, ctx.job.id));
    return row;
  });
  // screenId 随 screen_planned 投影到项目频道（API-CORE-030），草稿本页据此把本页发出的新草稿摆上看板
  await emitJobEvent(ctx.job.id, 'screen_planned', { screenId: screen.id, name, route, purpose: '' });
  ctx.planned = 1;
  try {
    if (!ctx.signal.aborted) await produceScreen(ctx, { screenId: screen.id, system, prompt: input.prompt, sourceKind: 'generate', expectedRevisionId: null, parentRevisionId: null, candidateIndex: null, advanceCurrent: true });
  } finally {
    // 同 runGenerate：失败或取消时没出内容的新草稿删掉（进程中途退出的由 failJob.ts 的 settleInterrupted 按 screen_planned 补删）；
    // 使用记录开着时它也留一份归档（API-CORE-018）
    const gone = await db.delete(schema.screens).where(and(eq(schema.screens.id, screen.id), isNull(schema.screens.currentRevisionId))).returning();
    await archiveDrafts(ctx.project.id, gone);
  }
}

// 改（REQ-CORE-006）：目标屏当前 HTML + 本次指令 + 祖先链上的历史指令；versions>1 落为候选
async function runEditScreens(ctx: Ctx) {
  const input = inputOf(ctx.job, 'edit_screens');
  const versions = Math.max(1, input.versions ?? 1);
  const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id));
  const targets = screens.filter((s) => input.screenIds.includes(s.id) && s.currentRevisionId);
  // 建作业时屏都在（createJob 已查），排队期间被删光的不能报「已更新 0 屏」成功（API-CORE-006 v0.77）；
  // 屏还在但没有当前修订的（它的造屏作业还没落第一版）同样改不了，原因照实说
  if (!targets.length) {
    const alive = screens.filter((s) => input.screenIds.includes(s.id)).length;
    throw new JobFailure('validation', !alive ? '目标屏都已被删除' : alive < new Set(input.screenIds).size ? '目标屏有的已被删除，其余还没有生成出内容' : '目标屏还没有生成出内容');
  }
  // 共享组件卡（REQ-EDIT-006）：框选的与目标屏本来就用的附完整 HTML。
  // 草稿（REQ-CORE-040）换草稿提示词，不带屏注册表、参考屏与组件卡；草稿本的改恰好一张（INV-CORE-003），画框与参照项目取这张的
  const system = ctx.project.kind === 'sketchbook'
    ? await draftSystem(ctx, targets[0])
    : screenSystemPrompt(app(ctx, 'existing app being revised'), ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], await registry(ctx), await references(ctx, { omitScreenId: targets.length === 1 ? targets[0].id : undefined }), ctx.assets, await componentCards(ctx.project.id, { ids: input.componentIds, screenIds: targets.map((s) => s.id) }), surfaceStates(ctx));
  const prepared = await Promise.all(targets.map(async (screen) => {
    const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId!));
    const body = extractBody((await storage.get(rev.htmlKey)).toString('utf8'));
    const prior = await priorInstructions(screen.id, screen.currentRevisionId);
    // 叠层屏（v0.63）：改屏时也提醒它是压在别的屏上的弹层，否则模型会把它改回整页
    const instruction = screen.presentation === 'overlay' ? `${input.prompt}\n${OVERLAY_SCREEN_NOTE}` : input.prompt;
    return { screen, base: screen.currentRevisionId!, body, instruction, prior };
  }));
  const tasks = prepared.flatMap((p) => Array.from({ length: versions }, (_, i) => ({ p, i })));
  ctx.planned = tasks.length;
  try {
    await warmPrefix(ctx, system, tasks.length);
    await pool(tasks, fanOut(tasks.length), async ({ p, i }) => {
      if (ctx.signal.aborted) return;
      const body = await editBody(ctx, { system, name: p.screen.name, route: p.screen.route, body: p.body, instruction: p.instruction, prior: p.prior });
      await produceScreen(ctx, {
        screenId: p.screen.id, system, body, sourceKind: 'edit',
        expectedRevisionId: versions === 1 ? p.base : undefined, parentRevisionId: p.base,
        candidateIndex: versions > 1 ? i : null, advanceCurrent: versions === 1,
      });
    });
  } finally {
    // 失败或取消也要收尾（同 runGenerate）：已落的候选让 current 指过去，否则它们既不在卡片上也没有角标；
    // current 已不是这批的基线（用户在这之后自己写过）就不顶掉
    if (versions > 1) for (const p of prepared) await db.transaction((tx) => pointCurrentToFirstCandidate(tx, p.screen.id, ctx.job.id, p.base));
  }
}

// 设计系统提炼（REQ-EDIT-003）：只产出提案，写入由用户在预览里确认
async function runProposeDesignSystem(ctx: Ctx): Promise<DesignProposalDto> {
  const input = inputOf(ctx.job, 'propose_design_system');
  const existing = parseConventions(ctx.ds.designMd);
  const sampleBody = input.screenId ? await currentBody(input.screenId) : null;
  const system = proposeDesignSystemSystemPrompt(FONT_FAMILIES);
  const user = proposeDesignSystemUserPrompt({ instruction: input.instruction, designMd: ctx.ds.designMd, tokens: ctx.tokens, existing, sampleBody: sampleBody ?? undefined });
  let raw: Partial<DesignProposalDto> & { tokens?: Record<string, unknown> };
  try { raw = parseJsonObject(await llmCall(ctx, 'propose', system, user, undefined, false, { effort: 'low' })); }
  catch { raw = parseJsonObject(await llmCall(ctx, 'propose', system, user + '\nReturn strictly valid JSON.', undefined, false, { effort: 'low' })); }
  const conventions = (Array.isArray(raw.conventions) ? raw.conventions : existing).map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_CONVENTIONS);
  const tokens: DesignProposalDto['tokens'] = {};
  const t = raw.tokens ?? {};
  if (typeof t.seedColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.seedColor) && t.seedColor.toUpperCase() !== ctx.ds.seedColor.toUpperCase()) tokens.seedColor = t.seedColor.toUpperCase();
  if (typeof t.fontFamily === 'string' && (FONT_FAMILIES as readonly string[]).includes(t.fontFamily) && t.fontFamily !== ctx.tokens.typography.fontFamily) tokens.fontFamily = t.fontFamily as (typeof FONT_FAMILIES)[number];
  if (typeof t.radiusScale === 'string' && t.radiusScale in RADIUS_SCALES && RADIUS_SCALES[t.radiusScale as keyof typeof RADIUS_SCALES].md !== ctx.tokens.radius.md) tokens.radiusScale = t.radiusScale as 'sharp' | 'default' | 'round';
  const changedConventions = JSON.stringify(conventions) !== JSON.stringify(existing);
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    conventions,
    ...(Object.keys(tokens).length ? { tokens } : {}),
    regenerate: !!raw.regenerate && changedConventions,
  };
}

// REQ-CORE-051：按这一端的屏注册表与应用简介建议维度与事件，只产出提案，不落库（用户勾选后经 API-CORE-054 保存）
async function runProposeStates(ctx: Ctx): Promise<StatesProposalDto> {
  const surface = ctx.surface!;
  const existing = surface.states as SurfaceStates;
  const system = proposeStatesSystemPrompt();
  const user = proposeStatesUserPrompt({ app: app(ctx, 'existing app'), surface: surface.name, device: ctx.device, registry: await registry(ctx), existing });
  let raw: { summary?: unknown; dims?: unknown; events?: unknown };
  try { raw = parseJsonObject(await llmCall(ctx, 'propose', system, user, undefined, false, { effort: 'low' })); }
  catch { raw = parseJsonObject(await llmCall(ctx, 'propose', system, user + '\nReturn strictly valid JSON.', undefined, false, { effort: 'low' })); }
  const name = (v: unknown) => (typeof v === 'string' ? Array.from(v.trim()).slice(0, 20).join('') : '');
  // 已有的维度与事件不再建议（按名字比，大小写不敏感）；名字空的、取值不够两个的丢掉
  const taken = new Set([...existing.dims.filter((d) => !d.retired).map((d) => d.name.toLowerCase()), ...existing.events.map((e) => e.name.toLowerCase())]);
  const dims = (Array.isArray(raw.dims) ? raw.dims : []).flatMap((d: { name?: unknown; values?: unknown }) => {
    const n = name(d?.name);
    const values = Array.from(new Set((Array.isArray(d?.values) ? d.values : []).map(name).filter(Boolean))).slice(0, MAX_DIM_VALUES);
    return n && !taken.has(n.toLowerCase()) && values.length >= MIN_DIM_VALUES ? [{ name: n, values }] : [];
  }).slice(0, 4);
  const events = (Array.isArray(raw.events) ? raw.events : []).flatMap((e: { name?: unknown; ms?: unknown }) => {
    const n = name(e?.name);
    if (!n || taken.has(n.toLowerCase())) return [];
    const ms = typeof e?.ms === 'number' ? Math.min(EVENT_MS.max, Math.max(EVENT_MS.min, Math.round(e.ms))) : undefined;
    return [{ name: n, ...(ms !== undefined ? { ms } : {}) }];
  }).slice(0, 3);
  return { summary: typeof raw.summary === 'string' ? raw.summary : '', dims, events };
}

// REQ-EDIT-002：子树重生成——只发选中元素（+ 这屏的历史指令，ADR-012 v0.87），整段替换，兄弟节点 qid 不变（ADR-007）。
// 草稿里只改一块（REQ-CORE-045）：提示词换成草稿规则与参照项目，落库不做 lint
async function runRegenerateSubtree(ctx: Ctx) {
  const input = inputOf(ctx.job, 'regenerate_subtree');
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, input.screenId));
  if (!screen?.currentRevisionId || screen.currentRevisionId !== input.expectedRevisionId) throw new JobFailure('validation', 'revision conflict');
  ctx.planned = 1;
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
  const body = extractBody((await storage.get(rev.htmlKey)).toString('utf8'));
  const sketch = ctx.project.kind === 'sketchbook';
  const reg = sketch ? [] : await registry(ctx);
  const routes = reg.map((r) => r.route);
  const system = sketch
    ? await draftSystem(ctx, screen)
    : screenSystemPrompt(app(ctx, 'existing app being revised'), ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], reg, [], ctx.assets, await componentCards(ctx.project.id, { screenIds: [screen.id] }), surfaceStates(ctx));
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const qids = input.qids ?? [input.qid];
  const current: QuiltBlock[] = [];
  for (const qid of qids) {
    const el = document.querySelector(`[data-qid="${qid}"]`);
    if (!el) throw new JobFailure('validation', 'element not found');
    current.push({ qid, html: el.outerHTML.replace(/ data-qid="q\d+"/g, '') });
  }
  const prior = await priorInstructions(screen.id, screen.currentRevisionId);
  // 模型说这一改要动选中几块外面的东西（v1.50）：一块都不换，作业失败，chip 上提示选到外层；不补问——同一句话再问一遍还是要动外面
  const call = async (prompt: string) => {
    const text = await llmCall(ctx, 'subtree', system, prompt, undefined, true);
    if (NEEDS_OUTER_RE.test(text)) throw new JobFailure('validation', 'needs outer element');
    return text;
  };
  let fresh: QuiltBlock[];
  if (!input.qids) fresh = [{ qid: input.qid, html: stripFences(await call(subtreeUserPrompt(screen.name, screen.route, current[0].html, input.prompt, prior))) }];
  else {
    // 几块一次改完（v1.26）：一次调用、每块回一段；块数或 qid 对不上补问一轮并说明上次哪里不对，仍不对作业失败、这一屏不变
    const prompt = subtreeBlocksUserPrompt(screen.name, screen.route, current, input.prompt, prior);
    let parsed = parseQuiltBlocks(await call(prompt), qids);
    if ('error' in parsed) parsed = parseQuiltBlocks(await call(prompt + subtreeBlocksRetryNote(qids, parsed.error)), qids);
    if ('error' in parsed) throw new JobFailure('validation', `blocks did not match the selected elements: ${parsed.error}`);
    fresh = parsed.blocks;
  }
  // 逐块换：选中的几块互不包含（建作业时查过），换掉一块不影响其余几块的定位；每块换进去的根沿用原 qid
  let replaced = { body, newQids: [] as string[] };
  for (const b of fresh) {
    const r = replaceSubtree(replaced.body, b.qid, b.html);
    if (!r) throw new JobFailure('validation', 'replacement produced no element');
    replaced = { body: r.body, newQids: [...replaced.newQids, ...r.newQids] };
  }
  // 共享组件（REQ-EDIT-006）：新片段里放的占位在这里展开；实例根沿用 qid、新子树接着编号
  const expanded = await expandLatest(ctx, replaced.body, screen.route);
  // v0.43：同 produceScreen——偏离只记录，不为它再烧一次调用；草稿没有设计契约可偏离，记空报告
  const report = sketch ? DRAFT_LINT_REPORT : lintScreenBody(expanded, routes, true);
  const html = assembleDocument(expanded, ctx.prelude, `${ctx.project.name} · ${screen.name}`);
  assertNotAborted(ctx);
  const created = await db.transaction((tx) => createRevision(tx, { projectId: ctx.project.id, screenId: screen.id, html, sourceKind: 'subtree', jobId: ctx.job.id, lintReport: report, expectedRevisionId: input.expectedRevisionId }));
  if (!created) throw new JobFailure('validation', 'revision conflict');
  ctx.usage.screens += 1;
  ctx.produced.push({ screenId: screen.id, revisionId: created.id, lintPassed: report.passed });
  await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: screen.id, revisionId: created.id, lintPassed: report.passed, newQids: replaced.newQids.length });
  await screenshotRevision(ctx, screen.id, created.id, html);
}

// REQ-EDIT-003：设计系统回刷——确定性：旧 body + 新 prelude，不调 LLM
async function runApplyDesignSystem(ctx: Ctx) {
  const input = inputOf(ctx.job, 'apply_design_system');
  const screens = (await db.select().from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id))).filter((s) => input.screenIds === 'all' || input.screenIds.includes(s.id));
  await pool(screens, config.screenConcurrency, async (screen) => {
    if (!screen.currentRevisionId || ctx.signal.aborted) return;
    const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
    const body = extractBody((await storage.get(rev.htmlKey)).toString('utf8'));
    const html = assembleDocument(body, ctx.prelude, `${ctx.project.name} · ${screen.name}`);
    const created = await db.transaction((tx) => createRevision(tx, { projectId: ctx.project.id, screenId: screen.id, html, sourceKind: 'apply_ds', jobId: ctx.job.id, lintReport: rev.lintReport, expectedRevisionId: screen.currentRevisionId }));
    if (!created) return;
    ctx.produced.push({ screenId: screen.id, revisionId: created.id, lintPassed: (rev.lintReport as { passed?: boolean }).passed !== false });
    await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: screen.id, revisionId: created.id, lintPassed: true });
    await screenshotRevision(ctx, screen.id, created.id, html);
  });
}

// 改共享组件（REQ-EDIT-006）：一次模型调用只产出组件的单根元素（上下文带这个组件此前改成功的指令，ADR-012 v0.87）→ 校验 → 升版落库 → 所有用它的屏确定性回刷（零 LLM）
async function runEditComponent(ctx: Ctx): Promise<{ component: string; applied: number; skipped: string[] }> {
  const input = inputOf(ctx.job, 'edit_component');
  const [comp] = await db.select().from(schema.components).where(and(eq(schema.components.id, input.componentId), eq(schema.components.projectId, ctx.project.id)));
  if (!comp) throw new JobFailure('validation', 'component not found');
  const uses = await db.select({ name: schema.screens.name }).from(schema.componentUses).innerJoin(schema.screens, eq(schema.screens.id, schema.componentUses.screenId))
    .where(and(eq(schema.componentUses.projectId, ctx.project.id), eq(schema.componentUses.name, comp.name)));
  const system = componentSystemPrompt({ app: app(ctx, 'existing app being revised'), device: ctx.device, tokens: ctx.tokens, designMd: ctx.ds.designMd, registry: await registry(ctx) });
  const prompt = componentUserPrompt({ name: comp.name, instruction: input.prompt, currentHtml: comp.html, usedBy: uses.map((u) => u.name), prior: await componentInstructions(ctx.project.id, comp.id) });
  let out = stripFences(await llmCall(ctx, 'component', system, prompt, undefined, true));
  let v = validateComponentHtml(out);
  // 结构不对（多根 / 带 script）修一回合：这是硬要求，不是设计偏离
  if (!v.ok) { out = stripFences(await llmCall(ctx, 'component', system, `${prompt}\n\nYour previous output was rejected: ${v.error}. Return exactly ONE root element, no <script>/<style>.`, undefined, true)); v = validateComponentHtml(out); }
  if (!v.ok) throw new JobFailure('validation', v.error);
  const c = classifyComponentHtml(out);
  // 取消只在组件行升版之前生效：升版之后回刷必须做完，屏里的实例要与组件一致
  assertNotAborted(ctx);
  const [updated] = await db.update(schema.components)
    .set({ html: c.html, summary: componentSummary(c.html), activeClass: c.activeClass, inactiveClass: c.inactiveClass, version: comp.version + 1, updatedAt: new Date() })
    .where(and(eq(schema.components.id, comp.id), eq(schema.components.version, comp.version))).returning();
  if (!updated) throw new JobFailure('validation', '组件在这一轮里被别处改过，重新发一次');
  const { applied, skipped } = await reflowComponent(ctx.project.id, updated, { jobId: ctx.job.id });
  await emitJobEvent(ctx.job.id, 'progress', { stage: 'component_synced', screens: applied.length });
  for (const a of applied) {
    ctx.produced.push({ screenId: a.screenId, revisionId: a.revisionId, lintPassed: true });
    await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: a.screenId, revisionId: a.revisionId, lintPassed: true });
  }
  await pool(applied, 4, (a) => screenshotRevision(ctx, a.screenId, a.revisionId, a.html));
  return { component: updated.name, applied: applied.length, skipped: skipped.map((s) => s.name) };
}

// 聊天回合（REQ-CORE-023 / ADR-018）：借 Agent SDK 的回路，只对「本机 Claude 订阅」通道开放（SDK 只认 Claude）。
// 助手回写的修订经 MCP 落库时已带本作业 jobId，这里只认领回 produced；回执 = 它最后一段文字
async function runChat(ctx: Ctx): Promise<{ reply: string }> {
  if ((ctx.runner.driver ?? config.llmDriver) !== 'agent-sdk') throw new JobFailure('validation', '聊天只能用「本机 Claude 订阅」的模型');
  let r: Awaited<ReturnType<typeof runChatTurn>>;
  // 使用记录（REQ-CORE-047）：聊天不经 llmCall，整个回合记一条 purpose=chat；系统提示在 chat.ts 里拼，这里只有用户这句话与回执
  const startedAt = new Date();
  const record = (ok: boolean, response: string | null, error: string | null, tokens = { tokensIn: 0, tokensOut: 0 }) => recordModelCall({
    userId: ctx.job.createdBy, jobId: ctx.job.id, projectId: ctx.project.id, seq: ++ctx.calls, purpose: 'chat', runner: ctx.job.runner, driver: 'agent-sdk', model: ctx.runner.model ?? null,
    ok, error, attempts: [{ attempt: 1, ok, ...(error ? { error } : {}), at: new Date().toISOString() }], ...tokens, imageKeys: ctx.images.length ? ((ctx.job.input as { imageKeys?: string[] }).imageKeys ?? []) : [],
    system: null, prompt: String((ctx.job.input as { prompt?: string }).prompt ?? ''), response, startedAt, finishedAt: new Date(),
  });
  try {
    r = await runChatTurn({
      job: ctx.job, project: ctx.project, designMd: ctx.ds.designMd, designVersion: ctx.ds.version, model: ctx.runner.model, images: ctx.images, signal: ctx.signal,
      onStep: (step) => { void emitJobEvent(ctx.job.id, 'progress', { stage: 'chat', step }).catch(() => {}); },
    });
  } catch (e) {
    await record(false, null, (e as Error).message);
    if (e instanceof ChatFailure) throw new JobFailure(e.errorClass, e.message);
    throw e;
  }
  await record(true, r.reply, null, { tokensIn: r.tokensIn, tokensOut: r.tokensOut });
  ctx.usage.tokensIn += r.tokensIn; ctx.usage.tokensOut += r.tokensOut;
  for (const p of r.produced) ctx.produced.push({ screenId: p.screenId, revisionId: p.revisionId, lintPassed: true });
  return { reply: r.reply };
}

// 变体落位（REQ-CORE-025）：默认屏那一行最右——这一行 = 与默认屏纵向范围相交的全部屏，变体排在它们右侧、与默认屏同 y，
// 所以不会压住已有的屏（只看这一家族时，默认屏右边紧挨着的别的屏会被整张盖住）
async function layoutVariant(ctx: Ctx, id: string, baseId: string) {
  const size = DEVICE_SIZE[ctx.device];
  const others = await db.select({ id: schema.screens.id, x: schema.screens.x, y: schema.screens.y }).from(schema.screens).where(and(screensOf(ctx), ne(schema.screens.id, id)));
  const b = others.find((s) => s.id === baseId)!;
  const x = others.filter((s) => s.y < b.y + size.h && b.y < s.y + size.h).reduce((m, s) => Math.max(m, s.x + size.w + 80), b.x + size.w + 80);
  await db.update(schema.screens).set({ x, y: b.y }).where(eq(schema.screens.id, id));
}

// 新屏摆放（REQ-CORE-014）：有锚点则一组屏自锚点向右排成一行（与既有屏相交整行下移）；无锚点接在最右一屏右侧
async function layoutNewScreens(ctx: Ctx, ids: string[], anchor?: { x: number; y: number }) {
  const size = DEVICE_SIZE[ctx.device];
  const gap = 80;
  // 画布一次只摆一端（PAGE-CANVAS 端），新屏只避开这一端的屏
  const existing = (await db.select({ x: schema.screens.x, y: schema.screens.y, id: schema.screens.id }).from(schema.screens).where(screensOf(ctx))).filter((e) => !ids.includes(e.id));
  let x: number; let y: number;
  if (anchor) {
    x = Math.round(anchor.x - size.w / 2); y = Math.round(anchor.y - size.h / 2);
    const rowW = ids.length * size.w + (ids.length - 1) * gap;
    const hits = (yy: number) => existing.some((e) => e.x < x + rowW && x < e.x + size.w && e.y < yy + size.h && yy < e.y + size.h);
    for (let tries = 0; tries < 50 && hits(y); tries++) y += size.h + gap;
  } else {
    x = existing.reduce((m, e) => Math.max(m, e.x + size.w + gap), 0); y = 0;
  }
  for (const id of ids) { await db.update(schema.screens).set({ x, y }).where(eq(schema.screens.id, id)); x += size.w + gap; }
}

// 回刷类作业逐屏落修订并截图，耗时随屏数走（实测 4 并发约 2.3 s / 屏）：超时按要回刷的屏数加（§11 超时一行）
async function repaintScreens(job: JobRow): Promise<number> {
  if (job.kind === 'apply_design_system') {
    const ids = (job.input as { screenIds: 'all' | string[] }).screenIds;
    const rows = await db.select({ id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.projectId, job.projectId));
    return ids === 'all' ? rows.length : rows.filter((r) => ids.includes(r.id)).length;
  }
  if (job.kind === 'edit_component') {
    const [comp] = await db.select({ name: schema.components.name }).from(schema.components).where(eq(schema.components.id, (job.input as { componentId: string }).componentId));
    if (!comp) return 0;
    return (await db.select({ id: schema.componentUses.screenId }).from(schema.componentUses).where(and(eq(schema.componentUses.projectId, job.projectId), eq(schema.componentUses.name, comp.name)))).length;
  }
  return 0;
}

// 改屏要整屏重写：时限按目标屏正文长度加时（§11 v1.03），版数各算一遍
async function editOutputChars(job: JobRow): Promise<number> {
  const input = job.input as { screenIds?: string[]; versions?: number };
  if (!input.screenIds?.length) return 0;
  const rows = await db.select({ key: schema.screenRevisions.htmlKey }).from(schema.screens)
    .innerJoin(schema.screenRevisions, eq(schema.screenRevisions.id, schema.screens.currentRevisionId))
    .where(inArray(schema.screens.id, input.screenIds));
  let chars = 0;
  for (const r of rows) chars += extractBody((await storage.get(r.key)).toString('utf8')).length;
  return chars * Math.max(1, input.versions ?? 1);
}

export async function runJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id, jobId));
  if (!job || job.status !== 'queued' || job.runner !== 'model') return;
  const [claimed] = await db.update(schema.generationJobs).set({ status: 'running', startedAt: new Date() })
    .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, 'queued'))).returning();
  if (!claimed) return;
  // 领取时按种类再校验一遍输入（CH-2 v1.06）：库里的行可能来自旧版本或手工写入，形状不对就以 validation 失败收尾，不在流水线中途出错
  const checked = jobInputSchemas[claimed.kind as keyof typeof jobInputSchemas]?.safeParse(claimed.input);
  if (checked && !checked.success) {
    const issue = checked.error.issues[0];
    await failJob(jobId, 'validation', `作业输入不合法：${issue.path.join('.') || 'input'} ${issue.message}`, ['running']).catch((x) => console.error(`[job ${jobId}] fail`, x));
    return;
  }
  // 领取之后的任何异常（查项目、落库事务里的数据库错误）都走统一失败收尾（§16 v1.03），不让作业停在 running。
  // 失败原因（output.message）是原始原因，一律中文，画布与助手消息由 failureText 按界面语言译（REQ-CORE-046）：
  // 进程内队列在建作业的请求里同步起跑，所以显式当作不在请求里，通道、本机工具的报错不跟着那个请求的语言
  try { await outsideRequest(() => runClaimed(claimed)); }
  catch (e) {
    console.error(`[job ${jobId}]`, e);
    await failJob(jobId, 'system', (e as Error).message, ['running']).catch((x) => console.error(`[job ${jobId}] fail`, x));
  }
}

async function runClaimed(claimed: JobRow): Promise<void> {
  const job = claimed; const jobId = claimed.id;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, job.projectId));
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, job.projectId));
  // 这一轮落在哪一端（REQ-CORE-049）：造屏、导出、建议状态取输入里的 surfaceId（建作业时已定），改屏取目标屏所在的端；
  // 其余作业（套设计系统、改组件、聊天）不落在某一端。领取时端已被删 → 作业失败，不在别的端里造
  const surface = project.kind === 'app' ? await jobSurface(claimed) : null;
  const device = ((surface || null)?.deviceType ?? project.deviceType) as DeviceType;
  const tokens = ds.tokens as Tokens;
  const abort = new AbortController();
  const outputChars = job.kind === 'edit_screens' ? await editOutputChars(claimed) : 0;
  const timeoutMs = timeoutFor({ kind: job.kind, input: job.input } as CreateJobInput, await repaintScreens(claimed), outputChars);
  // 作业输入里带的通道（REQ-CORE-011）；kind=agent 的作业不会走到 worker（runner=agent 不入队）
  const jobRunner = (claimed.input as { runner?: { kind: string; driver?: LlmDriver; model?: string; channelId?: string } }).runner;
  let runner: Ctx['runner'] = {};
  let runnerError: string | null = null;
  if (jobRunner?.kind === 'model') runner = { driver: jobRunner.driver, model: jobRunner.model };
  else if (jobRunner?.kind === 'channel' && jobRunner.channelId) {
    // 账号自建通道：此刻才解密凭据（REQ-CORE-013）；通道被删或主密钥换了就让作业明确失败，而不是悄悄回落到 .env 的驱动
    try { const spec = await resolveChannelSpec(claimed.createdBy, jobRunner.channelId); runner = { driver: spec.driver, model: spec.model, apiKey: spec.apiKey, baseUrl: spec.baseUrl }; }
    catch (e) { runnerError = `模型不可用：${(e as Error).message}`; }
  }
  const images = await loadForModel((claimed.input as { imageKeys?: string[] }).imageKeys);
  const assets = await assetsForPrompt(project.id);
  const ctx: Ctx = { job: claimed, project, ds, device, surface: surface || null, tokens, prelude: buildPrelude(tokens), signal: abort.signal, usage: { tokensIn: 0, tokensOut: 0, screens: 0, cacheRead: 0, cacheWrite: 0 }, runner, images, assets, produced: [], entryRepair: null, calls: 0 };
  await emitJobEvent(jobId, 'progress', { stage: 'running' });
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);
  modelAborts.set(jobId, abort);
  let failure: { errorClass: ErrorClass; message: string } | null = null;
  let extraOutput: Record<string, unknown> = {};
  try {
    if (runnerError) throw new JobFailure('validation', runnerError);
    if (surface === false) throw new JobFailure('validation', 'surface not found');
    switch (job.kind) {
      case 'generate': await runGenerate(ctx); break;
      case 'edit_screens': await runEditScreens(ctx); break;
      case 'export_prototype': extraOutput = { exportKey: await runExportPrototype(ctx) }; break;
      case 'regenerate_subtree': await runRegenerateSubtree(ctx); break;
      case 'apply_design_system': await runApplyDesignSystem(ctx); break;
      case 'propose_design_system': extraOutput = { proposal: await runProposeDesignSystem(ctx) }; break;
      case 'chat': extraOutput = await runChat(ctx); break;
      case 'edit_component': extraOutput = await runEditComponent(ctx); break;
      case 'propose_states': extraOutput = { proposal: await runProposeStates(ctx) }; break;
      default: throw new JobFailure('validation', `${job.kind} is not available yet`);
    }
    // v0.43：偏离设计契约不再是作业失败的理由（ADR-005 修订）。产出照样落地，偏离逐屏可见
  } catch (e) {
    if (abort.signal.aborted) failure = { errorClass: 'timeout', message: `job exceeded ${timeoutMs / 1000}s` };
    else if (e instanceof JobFailure) failure = { errorClass: e.errorClass, message: e.message };
    else if (e instanceof ProviderError) failure = { errorClass: 'provider', message: e.message };
    else { failure = { errorClass: 'system', message: (e as Error).message }; console.error(`[job ${jobId}]`, e); }
  } finally { clearTimeout(timer); modelAborts.delete(jobId); }
  // 计划的修订全部落库后才被时限中止（多半卡在截图或入口屏补链上）：修订已经生效，不判失败（§11 v1.03）
  const landedAll = !!ctx.planned && ctx.produced.length >= ctx.planned;
  if (failure?.errorClass === 'timeout' && landedAll) failure = null;
  // 超时中止后没轮到的屏在并发池里直接跳过、不抛错：不在这里补判，作业会带着一半没做的活报 succeeded（取消另有状态复核，见下）
  if (!failure && abort.signal.aborted && !landedAll) failure = { errorClass: 'timeout', message: `job exceeded ${timeoutMs / 1000}s` };

  // 落库前复核取消（§16 竞态：worker vs cancel）
  const [fresh] = await db.select({ status: schema.generationJobs.status }).from(schema.generationJobs).where(eq(schema.generationJobs.id, jobId));
  // 没调过模型的作业（导出、套用设计系统、第一次调用前就取消或失败的）不记驱动与模型：用量看板不把它们算给任何模型（API-CORE-052，v1.28）
  const called = ctx.calls > 0;
  await recordUsage(job.createdBy, jobId, ctx.usage.tokensIn, ctx.usage.tokensOut, ctx.usage.screens, called ? ctx.runner.driver ?? config.llmDriver : undefined, called ? ctx.runner.model ?? config.model : undefined, { read: ctx.usage.cacheRead, write: ctx.usage.cacheWrite });
  if (fresh.status === 'cancelled') { await deriveIfProduced(ctx); return; }
  // 测试钩子，只在 stub 驱动时认：复核取消之后、落库之前停一会，造「取消与落库同时到达」（TEST.md §3）
  const finalizeHold = config.llmDriver === 'stub' ? Number(/\[stub-finalize-hold:(\d+)\]/.exec(String((job.input as { prompt?: string }).prompt ?? ''))?.[1] ?? 0) : 0;
  if (finalizeHold) await new Promise((r) => setTimeout(r, finalizeHold));

  const screenIds = Array.from(new Set(ctx.produced.map((p) => p.screenId)));
  const output = { screenIds, revisionIds: ctx.produced.map((p) => p.revisionId), tokensIn: ctx.usage.tokensIn, tokensOut: ctx.usage.tokensOut, ...extraOutput, ...(failure ? { errorClass: failure.errorClass, message: failure.message } : {}) };
  // 条件更新没改到（这一刻已被取消或被 job.timeout 扫走）就到此为止：那一方已经回写消息、发过终态事件（§16 v1.03）
  let updated = false;
  await db.transaction(async (tx) => {
    if (ctx.produced.length) await deriveLinks(tx, project.id);
    const [row] = await tx.update(schema.generationJobs).set({ status: failure ? 'failed' : 'succeeded', finishedAt: new Date(), output })
      .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, 'running'))).returning();
    if (!row) return;
    updated = true;
    const screens = screenIds.length ? await tx.select().from(schema.screens).where(and(eq(schema.screens.projectId, project.id), sql`${schema.screens.id} = any(${sql.raw(`array[${screenIds.map((s) => `'${s}'::uuid`).join(',')}]`)})`)) : [];
    const entryId = ctx.entryRepair ? screens.find((s) => s.name === ctx.entryRepair!.name)?.id : undefined;
    const fresh = screens.filter((s) => s.id !== entryId);
    // 回执与失败文案按作业的语言（REQ-CORE-046），没有时中文
    const locale = jobLocale(job) ?? 'zh';
    const names = listJoin(fresh.map((s) => s.name), locale);
    const versions = Number((job.input as { versions?: number }).versions ?? 1);
    const candidateNote = versions > 1 ? tr(`，每屏 ${versions} 版候选，点卡片角标选一版`, `, ${versions} candidates per screen; pick one with the badge on the card`, locale) : '';
    const entry = ctx.entryRepair;
    const entryNote = entry ? tr(`；已把「${entry.name}」接到新屏${entry.added.length ? `（${listJoin(entry.added, locale)}）` : ''}`, `; linked “${entry.name}” to the new screens${entry.added.length ? ` (${listJoin(entry.added, locale)})` : ''}`, locale) : '';
    const skipped = (extraOutput.skipped as string[] | undefined) ?? [];
    const proposal = extraOutput.proposal as DesignProposalDto | StatesProposalDto | undefined;
    const content = failure
      ? failureText(job.kind as JobKind, failure.errorClass, failure.message, screenIds.length, locale)
      // 聊天回执就是助手最后一段文字；它只动手没说话时至少报出改了哪几屏
      : job.kind === 'chat' ? ((extraOutput.reply as string | undefined) || (screens.length ? tr(`已更新 ${screens.length} 屏：${names}`, `Updated ${countEn(screens.length, 'screen')}: ${names}`, locale) : tr('（助手没有回话）', '(The assistant did not reply)', locale)))
      : job.kind === 'export_prototype' ? tr('原型已导出', 'Prototype exported', locale)
      // 改组件的回执点名同步了哪几屏；有屏因作业在跑没同步上也说出来（它落地时会自己用上新版）
      : job.kind === 'edit_component' ? tr(`已更新组件「${extraOutput.component}」，同步 ${screens.length} 屏${names ? `：${names}` : ''}${skipped.length ? `；${listJoin(skipped, locale)} 正在改、落地后自动用新版` : ''}`,
        `Updated component “${extraOutput.component}” and synced ${countEn(screens.length, 'screen')}${names ? `: ${names}` : ''}${skipped.length ? `; ${listJoin(skipped, locale)} ${skipped.length === 1 ? 'is' : 'are'} being edited and will use the new version when done` : ''}`, locale)
      : job.kind === 'apply_design_system' ? tr(`设计系统已回刷 ${screens.length} 屏`, `Re-applied the design system to ${countEn(screens.length, 'screen')}`, locale)
      : job.kind === 'propose_states' ? ((n) => n ? tr(`建议了 ${n} 项状态${proposal?.summary ? `：${proposal.summary}` : ''}，在右栏勾选后保存`, `Suggested ${countEn(n, 'state')}${proposal?.summary ? `: ${proposal.summary}` : ''}; tick the ones you want in the right panel and save`, locale) : tr('没有可建议的新状态', 'No new states to suggest', locale))((proposal as StatesProposalDto).dims.length + (proposal as StatesProposalDto).events.length)
      : job.kind === 'propose_design_system' ? tr(`设计系统提案已生成${proposal?.summary ? `：${proposal.summary}` : ''}，在设计系统面板预览后确认写入`, `Design system proposal ready${proposal?.summary ? `: ${proposal.summary}` : ''}; preview it in the design system panel, then confirm to write it`, locale)
      : job.kind === 'regenerate_subtree' ? ((n) => n > 1 ? tr(`已重生成「${names}」的 ${n} 块`, `Regenerated ${n} blocks of “${names}”`, locale) : tr(`已重生成「${names}」的一块`, `Regenerated one block of “${names}”`, locale))((job.input as { qids?: string[] }).qids?.length ?? 1)
      : job.kind === 'edit_screens' ? tr(`已更新 ${screens.length} 屏：${names}${candidateNote}`, `Updated ${countEn(screens.length, 'screen')}: ${names}${candidateNote}`, locale)
      : tr(`已生成 ${fresh.length} 屏：${names}${candidateNote}${entryNote}`, `Generated ${countEn(fresh.length, 'screen')}: ${names}${candidateNote}${entryNote}`, locale);
    await tx.update(schema.messages).set({ content, affectedScreenIds: screenIds }).where(and(eq(schema.messages.jobId, jobId), eq(schema.messages.role, 'assistant')));
    await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, project.id));
  });
  if (!updated) return;
  const rows = screenIds.length ? await db.select().from(schema.screens).where(and(eq(schema.screens.projectId, project.id), sql`${schema.screens.id} = any(${sql.raw(`array[${screenIds.map((s) => `'${s}'::uuid`).join(',')}]`)})`)) : [];
  const [projectNow] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
  await emitJobEvent(jobId, failure ? 'failed' : 'succeeded', { errorClass: failure?.errorClass, message: failure?.message, screens: await screenDtos(projectNow, rows), ...(extraOutput.proposal ? { proposal: extraOutput.proposal } : {}) });
}

// 作业落在哪一端：null 是不落在某一端，false 是落的那一端已被删
async function jobSurface(job: JobRow): Promise<SurfaceRow | null | false> {
  const input = job.input as { surfaceId?: string; screenIds?: unknown; screenId?: string };
  let id = input.surfaceId;
  if (!id && ['edit_screens', 'regenerate_subtree'].includes(job.kind)) {
    const target = job.kind === 'regenerate_subtree' ? input.screenId : Array.isArray(input.screenIds) ? input.screenIds[0] as string : undefined;
    if (!target) return null;
    const [s] = await db.select({ surfaceId: schema.screens.surfaceId }).from(schema.screens).where(eq(schema.screens.id, target));
    id = s?.surfaceId ?? undefined;
  }
  if (!id) return null;
  const [row] = await db.select().from(schema.surfaces).where(and(eq(schema.surfaces.id, id), eq(schema.surfaces.projectId, job.projectId)));
  return row ?? false;
}

async function deriveIfProduced(ctx: Ctx) {
  if (ctx.produced.length) await db.transaction((tx) => deriveLinks(tx, ctx.project.id));
}
