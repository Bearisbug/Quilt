import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { settleByJob } from '../services/annotations.ts';
import { loadForModel } from '../services/attachments.ts';
import { assetsForPrompt } from '../services/assets.ts';
import { resolveChannelSpec } from '../services/channels.ts';
import { completeWithRetry, ProviderError, type LlmDriver } from '../lib/llm.ts';
import { emitJobEvent } from '../lib/events.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { screenshotHtml, extractTailwindCss } from '../lib/screenshot.ts';
import { recordUsage } from '../services/usage.ts';
import { createRevision, deriveLinks, pointCurrentToFirstCandidate, priorInstructions, exemplarBody, currentBody } from '../services/screens.ts';
import { screenDtos } from '../services/projects.ts';
import { timeoutFor } from '../services/jobs.ts';
import { runChatTurn, ChatFailure } from './chat.ts';
import {
  buildPrelude, lintScreenBody, injectQids, assembleDocument, extractBody, stripFences, buildPrototypeDocument, replaceSubtree, extractLinks,
  type ProjectAsset,
  screenSystemPrompt, planSystemPrompt, planUserPrompt, planOneScreenSystemPrompt, planOneScreenUserPrompt, screenUserPrompt, editUserPrompt, subtreeUserPrompt, linkRepairPrompt,
  proposeDesignSystemSystemPrompt, proposeDesignSystemUserPrompt, parseConventions, REFERENCE_IMAGE_NOTE, FONT_FAMILIES, RADIUS_SCALES, MAX_CONVENTIONS,
  DEVICE_SIZE, type DeviceType, type Tokens, type ComponentRecipe, type Plan, type PlannedScreen, type LintReport, type ErrorClass, type RegistryEntry, type ReferenceScreen, type DesignProposalDto, type CreateJobInput,
} from '@quilt/core';

let lucideCache: string | null = null;
async function lucideJs(): Promise<string> {
  if (lucideCache) return lucideCache;
  const res = await fetch('https://unpkg.com/lucide@latest/dist/umd/lucide.min.js');
  if (!res.ok) throw new JobFailure('system', `lucide fetch ${res.status}`);
  lucideCache = await res.text();
  return lucideCache;
}

// REQ-PROTO-004：导出单文件原型（确定性，不调 LLM）
async function runExportPrototype(ctx: Ctx): Promise<string> {
  const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id)).orderBy(schema.screens.createdAt);
  const exportScreens: { route: string; name: string; body: string }[] = [];
  for (const s of screens) {
    if (!s.currentRevisionId) continue;
    const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
    exportScreens.push({ route: s.route, name: s.name, body: extractBody((await storage.get(rev.htmlKey)).toString('utf8')) });
  }
  if (!exportScreens.length) throw new JobFailure('validation', 'project has no screens to export');
  const [tailwindCss, lucide] = await Promise.all([extractTailwindCss(ctx.prelude, exportScreens.map((s) => s.body)), lucideJs()]);
  const html = buildPrototypeDocument({ title: `${ctx.project.name} · prototype`, tokens: ctx.tokens, screens: exportScreens, tailwindCss, lucideJs: lucide });
  const key = objectKeys.exportHtml(ctx.project.id, ctx.job.id);
  await storage.put(key, html, 'text/html; charset=utf-8');
  await emitJobEvent(ctx.job.id, 'progress', { stage: 'exported', screens: exportScreens.length, bytes: Buffer.byteLength(html) });
  return key;
}

type JobRow = typeof schema.generationJobs.$inferSelect;
type Ctx = {
  job: JobRow; project: typeof schema.projects.$inferSelect; ds: typeof schema.designSystems.$inferSelect;
  device: DeviceType; tokens: Tokens; prelude: string; signal: AbortSignal;
  usage: { tokensIn: number; tokensOut: number; screens: number };
  // 本作业用哪个驱动 / 模型 / 凭据（REQ-CORE-011 / 013）；缺省取 .env 的 LLM_DRIVER 与凭据
  runner: { driver?: LlmDriver; model?: string; apiKey?: string; baseUrl?: string };
  // 本作业的参考图（REQ-CORE-012），整轮只读一次对象存储
  images: { mediaType: string; dataBase64: string }[];
  // 本项目的素材清单（REQ-CORE-019），整轮只读一次，进每屏的 system 前缀
  assets: ProjectAsset[];
  produced: { screenId: string; revisionId: string; lintPassed: boolean }[];
  // 反向连线（REQ-CORE-014）：造一组屏后对入口屏跑了一次补链，回执里点名
  entryRepair: { name: string; added: string[] } | null;
};

class JobFailure extends Error { constructor(public errorClass: ErrorClass, msg: string) { super(msg); } }

// 参考图只跟第一次出屏 / 改屏的调用走；修复轮是「按 lint 违规改你上一版 HTML」，
// 再把图塞一遍既多花 token 又会把模型往复刻方向带（REQ-CORE-012）
async function llmCall(ctx: Ctx, system: string, prompt: string, model?: string, withImages = false) {
  const images = withImages ? ctx.images : undefined;
  const spec = ctx.runner.driver ? { driver: ctx.runner.driver, apiKey: ctx.runner.apiKey, baseUrl: ctx.runner.baseUrl } : undefined;
  const r = await completeWithRetry({ system, prompt: withImages && images?.length ? `${REFERENCE_IMAGE_NOTE}\n\n${prompt}` : prompt, images, model: ctx.runner.model ?? model, spec, signal: ctx.signal }, (n, err) => { void emitJobEvent(ctx.job.id, 'progress', { stage: 'retry', attempt: n, error: err.message }).catch(() => {}); });
  ctx.usage.tokensIn += r.tokensIn; ctx.usage.tokensOut += r.tokensOut;
  return r.text;
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
  return plan;
}
function parseOne(text: string): PlannedScreen & { entryFrom?: string | null } {
  const o = parseJsonObject<Partial<PlannedScreen> & { entryFrom?: string | null }>(text);
  if (!o.route || !o.name) throw new Error('plan missing name/route');
  return { name: o.name, route: o.route.startsWith('/') ? o.route : `/${o.route}`, purpose: o.purpose ?? '', links: Array.isArray(o.links) ? o.links : [], sections: Array.isArray(o.sections) && o.sections.length ? o.sections : ['header', 'main content', 'primary action'], entryFrom: o.entryFrom ?? null };
}

// ---- 上下文（ADR-012 v0.31）：稳定前缀里的屏注册表 + 情境层的参考屏 ----
async function registry(ctx: Ctx): Promise<RegistryEntry[]> {
  const rows = await db.select({ route: schema.screens.route, name: schema.screens.name, purpose: schema.screens.purpose }).from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id)).orderBy(schema.screens.createdAt);
  return rows.map((r) => ({ route: r.route, name: r.name, purpose: r.purpose || undefined }));
}
// 参考屏合计 ≤ 40 KB（≈ 10K token 预算里给参考屏的份额），超了先丢来源屏
const REF_BUDGET = 40 * 1024;
async function references(ctx: Ctx, opts: { sourceScreenId?: string | null } = {}): Promise<ReferenceScreen[]> {
  const out: ReferenceScreen[] = [];
  const ex = await exemplarBody(ctx.project);
  if (ex) out.push({ label: 'exemplar screen (the project\'s style anchor)', body: ex.body });
  if (opts.sourceScreenId && opts.sourceScreenId !== ex?.screenId) {
    const b = await currentBody(opts.sourceScreenId);
    if (b) out.push({ label: 'source screen (the screen that links into the new one)', body: b });
  }
  while (out.reduce((n, r) => n + r.body.length, 0) > REF_BUDGET && out.length > 1) out.pop();
  return out;
}
const app = (ctx: Ctx, description: string) => ({ name: ctx.project.name, description, brief: ctx.project.brief });

// 单屏单版：生成/编辑 → lint → 修复一回合 → 注入 qid → 落修订 → 截图
async function produceScreen(ctx: Ctx, args: { screenId: string; system: string; prompt: string; sourceKind: 'generate' | 'edit'; expectedRevisionId?: string | null; parentRevisionId?: string | null; candidateIndex?: number | null; advanceCurrent?: boolean; model?: string }) {
  const raw = await llmCall(ctx, args.system, args.prompt, args.model, true);
  const body = stripFences(raw);
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id))).map((r) => r.route);
  // v0.43：偏离设计契约不再触发修复回合，也不再让作业失败——token 是共享词汇表，不是判分标准。
  // 报告照算，进 lintReport 与 screen_html_ready 事件，画布逐屏显示偏离了什么
  let report: LintReport = lintScreenBody(body, routes, true);
  const withQids = injectQids(body);
  report = lintScreenBody(withQids, routes, report.firstTry); // 违规带上 qid
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, args.screenId));
  const html = assembleDocument(withQids, ctx.prelude, `${ctx.project.name} · ${screen.name}`);
  if (Buffer.byteLength(html) > config.maxScreenHtmlBytes) throw new JobFailure('validation', `screen html too large (${Buffer.byteLength(html)} bytes)`);
  const rev = await db.transaction((tx) => createRevision(tx, { projectId: ctx.project.id, screenId: args.screenId, html, sourceKind: args.sourceKind, jobId: ctx.job.id, lintReport: report, expectedRevisionId: args.expectedRevisionId, parentRevisionId: args.parentRevisionId, candidateIndex: args.candidateIndex, advanceCurrent: args.advanceCurrent }));
  if (!rev) throw new JobFailure('validation', 'revision conflict');
  ctx.usage.screens += 1;
  ctx.produced.push({ screenId: args.screenId, revisionId: rev.id, lintPassed: report.passed });
  await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: args.screenId, revisionId: rev.id, candidateIndex: args.candidateIndex ?? null, lintPassed: report.passed, violations: report.violations.length, dangling: report.danglingRoutes });
  await screenshotRevision(ctx, args.screenId, rev.id, html);
  return { rev, report, body: withQids };
}

async function screenshotRevision(ctx: Ctx, screenId: string, revisionId: string, html: string) {
  try {
    const png = await screenshotHtml(html, DEVICE_SIZE[ctx.device]);
    const key = objectKeys.revisionShot(ctx.project.id, screenId, revisionId);
    await storage.put(key, png, 'image/png');
    await db.update(schema.screenRevisions).set({ screenshotKey: key }).where(eq(schema.screenRevisions.id, revisionId));
    await emitJobEvent(ctx.job.id, 'screen_screenshot_ready', { screenId, revisionId, screenshotUrl: await storage.signedUrl(key) });
  } catch (e) {
    console.warn(`[job ${ctx.job.id}] screenshot failed for ${revisionId}: ${(e as Error).message}`);
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function uniqueRoute(projectId: string, route: string): Promise<string> {
  const taken = new Set((await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, projectId))).map((r) => r.route));
  if (!taken.has(route)) return route;
  for (let k = 2; k < 100; k++) if (!taken.has(`${route}-${k}`)) return `${route}-${k}`;
  throw new JobFailure('validation', 'route space exhausted');
}

// 造（REQ-CORE-003 / REQ-CORE-014 / REQ-PROTO-003 三合一）：
// route 钉死 = 懒生成（跳过规划器）；count=1 走单屏规划；count 2–4 / auto 走整组规划（空项目首轮顺手扩写应用简介）。
// 每张新屏 × versions 版并行出屏；versions>1 时落为候选、current 指向第 1 版。
// 规划器声明了入口屏（entryFrom）就对它跑一次补链——反向连线。
async function runGenerate(ctx: Ctx) {
  const input = ctx.job.input as { prompt: string; count: number | 'auto'; versions: number; anchor?: { x: number; y: number }; route?: string; name?: string; fromScreenId?: string; imageKeys?: string[] };
  const versions = Math.max(1, input.versions ?? 1);
  const existingRows = await db.select().from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id)).orderBy(schema.screens.createdAt);
  const existing: RegistryEntry[] = existingRows.map((s) => ({ route: s.route, name: s.name, purpose: s.purpose || undefined }));
  const existingRoutes = new Set(existing.map((r) => r.route));
  const empty = existingRows.length === 0;
  const a = app(ctx, input.prompt);
  let planned: PlannedScreen[];
  let entryFrom: string | null = null;
  if (input.route) {
    if (existingRoutes.has(input.route)) throw new JobFailure('validation', 'route already exists');
    const from = existingRows.find((s) => s.id === input.fromScreenId);
    const name = input.name ?? (input.route.split('/').filter(Boolean).map((p) => p.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())).join(' ') || 'Screen');
    planned = [{ name, route: input.route, purpose: `Screen reached from "${from?.name ?? 'another screen'}" via link ${input.route}`, links: from ? [from.route] : [], sections: ['header with back arrow', 'main content matching the route name', 'primary action'] }];
    entryFrom = from?.route ?? null;
  } else if (input.count === 1) {
    const planPrompt = planOneScreenUserPrompt(a, input.prompt, existing);
    let one: ReturnType<typeof parseOne>;
    try { one = parseOne(await llmCall(ctx, planOneScreenSystemPrompt(), planPrompt)); }
    catch { one = parseOne(await llmCall(ctx, planOneScreenSystemPrompt(), planPrompt + '\nReturn strictly valid JSON.')); }
    planned = [one];
    entryFrom = one.entryFrom ?? null;
  } else {
    const system = planSystemPrompt({ count: input.count, empty });
    const planPrompt = planUserPrompt(a, input.prompt, existing);
    let plan: Plan;
    try { plan = parsePlan(await llmCall(ctx, system, planPrompt)); }
    catch { plan = parsePlan(await llmCall(ctx, system, planPrompt + '\nReturn strictly valid JSON.')); }
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
    const route = await uniqueRoute(ctx.project.id, s.route);
    const [screen] = await db.insert(schema.screens).values({ projectId: ctx.project.id, name: s.name, route, purpose: s.purpose ?? '', x: 0, y: 0 }).returning();
    created.push({ screenId: screen.id, s: { ...s, route } });
    await emitJobEvent(ctx.job.id, 'screen_planned', { screenId: screen.id, name: s.name, route, purpose: s.purpose });
  }
  await layoutNewScreens(ctx, created.map((c) => c.screenId), input.anchor);

  const all = created.map((c) => c.s);
  const reg = await registry(ctx);
  const sourceId = input.fromScreenId ?? existingRows.find((s) => s.route === entryFrom)?.id ?? null;
  const system = screenSystemPrompt(a, ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], reg, await references(ctx, { sourceScreenId: sourceId }), ctx.assets);
  const tasks = created.flatMap((c) => Array.from({ length: versions }, (_, i) => ({ c, i })));
  await pool(tasks, config.screenConcurrency, async ({ c, i }) => {
    if (ctx.signal.aborted) return;
    await produceScreen(ctx, {
      screenId: c.screenId, system, prompt: screenUserPrompt(c.s, all), sourceKind: 'generate', model: empty ? config.modelInitial : undefined,
      expectedRevisionId: versions === 1 ? null : undefined, parentRevisionId: null,
      candidateIndex: versions > 1 ? i : null, advanceCurrent: versions === 1,
    });
  });
  if (versions > 1) for (const c of created) await db.transaction((tx) => pointCurrentToFirstCandidate(tx, c.screenId, ctx.job.id));
  // 新屏一落地就派生应用地图：懒生成补的那张屏此刻已能解析断链，不必等后面的反向连线跑完
  if (ctx.produced.length) await db.transaction((tx) => deriveLinks(tx, ctx.project.id));
  // 样板屏（REQ-CORE-016）：没钦定过就以本次第 1 屏为默认
  if (!ctx.project.exemplarScreenId && created[0]) {
    await db.update(schema.projects).set({ exemplarScreenId: created[0].screenId }).where(and(eq(schema.projects.id, ctx.project.id), sql`${schema.projects.exemplarScreenId} is null`));
  }
  // 反向连线（REQ-CORE-014）：对入口屏跑一次补链；入口屏此刻被用户改了（修订冲突）就跳过，不让整个造屏失败
  const entry = entryFrom ? existingRows.find((s) => s.route === entryFrom) : null;
  if (entry?.currentRevisionId && !ctx.signal.aborted) {
    try {
      const before = (await currentBody(entry.id)) ?? '';
      const prompt = editUserPrompt(entry.name, entry.route, before, linkRepairPrompt(created.map((c) => c.s.route)));
      const { body } = await produceScreen(ctx, { screenId: entry.id, system, prompt, sourceKind: 'edit', expectedRevisionId: entry.currentRevisionId });
      const had = new Set(extractLinks(before).map((l) => l.href));
      const added = Array.from(new Set(extractLinks(body).map((l) => l.href).filter((h) => !had.has(h))));
      ctx.entryRepair = { name: entry.name, added };
    } catch (e) {
      console.warn(`[job ${ctx.job.id}] entry link repair skipped: ${(e as Error).message}`);
    }
  }
}

// 改（REQ-CORE-006）：目标屏当前 HTML + 本次指令 + 祖先链上的历史指令；versions>1 落为候选
async function runEditScreens(ctx: Ctx) {
  const input = ctx.job.input as { prompt: string; screenIds: string[]; versions?: number };
  const versions = Math.max(1, input.versions ?? 1);
  const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id));
  const targets = screens.filter((s) => input.screenIds.includes(s.id) && s.currentRevisionId);
  const system = screenSystemPrompt(app(ctx, 'existing app being revised'), ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], await registry(ctx), await references(ctx), ctx.assets);
  const prepared = await Promise.all(targets.map(async (screen) => {
    const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId!));
    const body = extractBody((await storage.get(rev.htmlKey)).toString('utf8'));
    const prior = await priorInstructions(screen.id, screen.currentRevisionId);
    return { screen, base: screen.currentRevisionId!, prompt: editUserPrompt(screen.name, screen.route, body, input.prompt, prior) };
  }));
  const tasks = prepared.flatMap((p) => Array.from({ length: versions }, (_, i) => ({ p, i })));
  await pool(tasks, config.screenConcurrency, async ({ p, i }) => {
    if (ctx.signal.aborted) return;
    await produceScreen(ctx, {
      screenId: p.screen.id, system, prompt: p.prompt, sourceKind: 'edit',
      expectedRevisionId: versions === 1 ? p.base : undefined, parentRevisionId: p.base,
      candidateIndex: versions > 1 ? i : null, advanceCurrent: versions === 1,
    });
  });
  if (versions > 1) for (const p of prepared) await db.transaction((tx) => pointCurrentToFirstCandidate(tx, p.screen.id, ctx.job.id));
}

// 设计系统提炼（REQ-EDIT-003）：只产出提案，写入由用户在预览里确认
async function runProposeDesignSystem(ctx: Ctx): Promise<DesignProposalDto> {
  const input = ctx.job.input as { instruction: string; screenId?: string };
  const existing = parseConventions(ctx.ds.designMd);
  const sampleBody = input.screenId ? await currentBody(input.screenId) : null;
  const system = proposeDesignSystemSystemPrompt(FONT_FAMILIES);
  const user = proposeDesignSystemUserPrompt({ instruction: input.instruction, designMd: ctx.ds.designMd, tokens: ctx.tokens, existing, sampleBody: sampleBody ?? undefined });
  let raw: Partial<DesignProposalDto> & { tokens?: Record<string, unknown> };
  try { raw = parseJsonObject(await llmCall(ctx, system, user)); }
  catch { raw = parseJsonObject(await llmCall(ctx, system, user + '\nReturn strictly valid JSON.')); }
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

// REQ-EDIT-002：子树重生成——只发选中元素，整段替换，兄弟节点 qid 不变（ADR-007）
async function runRegenerateSubtree(ctx: Ctx) {
  const input = ctx.job.input as { screenId: string; qid: string; prompt: string; expectedRevisionId: string };
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, input.screenId));
  if (!screen?.currentRevisionId || screen.currentRevisionId !== input.expectedRevisionId) throw new JobFailure('validation', 'revision conflict');
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
  const body = extractBody((await storage.get(rev.htmlKey)).toString('utf8'));
  const reg = await registry(ctx);
  const routes = reg.map((r) => r.route);
  const system = screenSystemPrompt(app(ctx, 'existing app being revised'), ctx.device, ctx.tokens, ctx.ds.designMd, ctx.ds.components as ComponentRecipe[], reg, [], ctx.assets);
  const { parseHTML } = await import('linkedom');
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const el = document.querySelector(`[data-qid="${input.qid}"]`);
  if (!el) throw new JobFailure('validation', 'element not found');
  const exact = el.outerHTML.replace(/ data-qid="q\d+"/g, '');
  const newFrag = stripFences(await llmCall(ctx, system, subtreeUserPrompt(screen.name, screen.route, exact, input.prompt)));
  const replaced = replaceSubtree(body, input.qid, newFrag);
  if (!replaced) throw new JobFailure('validation', 'replacement produced no element');
  // v0.43：同 produceScreen——偏离只记录，不为它再烧一次调用
  const report = lintScreenBody(replaced.body, routes, true);
  const html = assembleDocument(replaced.body, ctx.prelude, `${ctx.project.name} · ${screen.name}`);
  const created = await db.transaction((tx) => createRevision(tx, { projectId: ctx.project.id, screenId: screen.id, html, sourceKind: 'subtree', jobId: ctx.job.id, lintReport: report, expectedRevisionId: input.expectedRevisionId }));
  if (!created) throw new JobFailure('validation', 'revision conflict');
  ctx.usage.screens += 1;
  ctx.produced.push({ screenId: screen.id, revisionId: created.id, lintPassed: report.passed });
  await emitJobEvent(ctx.job.id, 'screen_html_ready', { screenId: screen.id, revisionId: created.id, lintPassed: report.passed, newQids: replaced.newQids.length });
  await screenshotRevision(ctx, screen.id, created.id, html);
}

// REQ-EDIT-003：设计系统回刷——确定性：旧 body + 新 prelude，不调 LLM
async function runApplyDesignSystem(ctx: Ctx) {
  const input = ctx.job.input as { screenIds: 'all' | string[] };
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

// 聊天回合（REQ-CORE-023 / ADR-018）：借 Agent SDK 的回路，只对「本机 Claude 订阅」通道开放（SDK 只认 Claude）。
// 助手回写的修订经 MCP 落库时已带本作业 jobId，这里只认领回 produced；回执 = 它最后一段文字
async function runChat(ctx: Ctx): Promise<{ reply: string }> {
  if ((ctx.runner.driver ?? config.llmDriver) !== 'agent-sdk') throw new JobFailure('validation', '聊天只能用「本机 Claude 订阅」通道');
  let r: Awaited<ReturnType<typeof runChatTurn>>;
  try {
    r = await runChatTurn({
      job: ctx.job, project: ctx.project, designMd: ctx.ds.designMd, designVersion: ctx.ds.version, model: ctx.runner.model, images: ctx.images, signal: ctx.signal,
      onStep: (step) => { void emitJobEvent(ctx.job.id, 'progress', { stage: 'chat', step }).catch(() => {}); },
    });
  } catch (e) {
    if (e instanceof ChatFailure) throw new JobFailure(e.errorClass, e.message);
    throw e;
  }
  ctx.usage.tokensIn += r.tokensIn; ctx.usage.tokensOut += r.tokensOut;
  for (const p of r.produced) ctx.produced.push({ screenId: p.screenId, revisionId: p.revisionId, lintPassed: true });
  return { reply: r.reply };
}

// 新屏摆放（REQ-CORE-014）：有锚点则一组屏自锚点向右排成一行（与既有屏相交整行下移）；无锚点接在最右一屏右侧
async function layoutNewScreens(ctx: Ctx, ids: string[], anchor?: { x: number; y: number }) {
  const size = DEVICE_SIZE[ctx.device];
  const gap = 80;
  const existing = (await db.select({ x: schema.screens.x, y: schema.screens.y, id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.projectId, ctx.project.id))).filter((e) => !ids.includes(e.id));
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

export async function runJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id, jobId));
  if (!job || job.status !== 'queued' || job.runner !== 'model') return;
  const [claimed] = await db.update(schema.generationJobs).set({ status: 'running', startedAt: new Date() })
    .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, 'queued'))).returning();
  if (!claimed) return;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, job.projectId));
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, job.projectId));
  const device = project.deviceType as DeviceType;
  const tokens = ds.tokens as Tokens;
  const abort = new AbortController();
  const timeoutMs = timeoutFor({ kind: job.kind, input: job.input } as CreateJobInput);
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);
  // 作业输入里带的通道（REQ-CORE-011）；kind=agent 的作业不会走到 worker（runner=agent 不入队）
  const jobRunner = (claimed.input as { runner?: { kind: string; driver?: LlmDriver; model?: string; channelId?: string } }).runner;
  let runner: Ctx['runner'] = {};
  let runnerError: string | null = null;
  if (jobRunner?.kind === 'model') runner = { driver: jobRunner.driver, model: jobRunner.model };
  else if (jobRunner?.kind === 'channel' && jobRunner.channelId) {
    // 账号自建通道：此刻才解密凭据（REQ-CORE-013）；通道被删或主密钥换了就让作业明确失败，而不是悄悄回落到 .env 的驱动
    try { const spec = await resolveChannelSpec(claimed.createdBy, jobRunner.channelId); runner = { driver: spec.driver, model: spec.model, apiKey: spec.apiKey, baseUrl: spec.baseUrl }; }
    catch (e) { runnerError = `通道不可用：${(e as Error).message}`; }
  }
  const images = await loadForModel((claimed.input as { imageKeys?: string[] }).imageKeys);
  const assets = await assetsForPrompt(project.id);
  const ctx: Ctx = { job: claimed, project, ds, device, tokens, prelude: buildPrelude(tokens), signal: abort.signal, usage: { tokensIn: 0, tokensOut: 0, screens: 0 }, runner, images, assets, produced: [], entryRepair: null };
  await emitJobEvent(jobId, 'progress', { stage: 'running' });
  let failure: { errorClass: ErrorClass; message: string } | null = null;
  let extraOutput: Record<string, unknown> = {};
  try {
    if (runnerError) throw new JobFailure('validation', runnerError);
    switch (job.kind) {
      case 'generate': await runGenerate(ctx); break;
      case 'edit_screens': await runEditScreens(ctx); break;
      case 'export_prototype': extraOutput = { exportKey: await runExportPrototype(ctx) }; break;
      case 'regenerate_subtree': await runRegenerateSubtree(ctx); break;
      case 'apply_design_system': await runApplyDesignSystem(ctx); break;
      case 'propose_design_system': extraOutput = { proposal: await runProposeDesignSystem(ctx) }; break;
      case 'chat': extraOutput = await runChat(ctx); break;
      default: throw new JobFailure('validation', `${job.kind} is not available yet`);
    }
    // v0.43：偏离设计契约不再是作业失败的理由（ADR-005 修订）。产出照样落地，偏离逐屏可见
  } catch (e) {
    if (abort.signal.aborted) failure = { errorClass: 'timeout', message: `job exceeded ${timeoutMs / 1000}s` };
    else if (e instanceof JobFailure) failure = { errorClass: e.errorClass, message: e.message };
    else if (e instanceof ProviderError) failure = { errorClass: 'provider', message: e.message };
    else { failure = { errorClass: 'system', message: (e as Error).message }; console.error(`[job ${jobId}]`, e); }
  } finally { clearTimeout(timer); }

  // 落库前复核取消（§16 竞态：worker vs cancel）
  const [fresh] = await db.select({ status: schema.generationJobs.status }).from(schema.generationJobs).where(eq(schema.generationJobs.id, jobId));
  await recordUsage(job.createdBy, jobId, ctx.usage.tokensIn, ctx.usage.tokensOut, ctx.usage.screens, ctx.runner.driver ?? config.llmDriver, ctx.runner.model ?? config.model);
  if (fresh.status === 'cancelled') { await deriveIfProduced(ctx); return; }

  const screenIds = Array.from(new Set(ctx.produced.map((p) => p.screenId)));
  const output = { screenIds, revisionIds: ctx.produced.map((p) => p.revisionId), tokensIn: ctx.usage.tokensIn, tokensOut: ctx.usage.tokensOut, ...extraOutput, ...(failure ? { errorClass: failure.errorClass, message: failure.message } : {}) };
  await db.transaction(async (tx) => {
    if (ctx.produced.length) await deriveLinks(tx, project.id);
    const [updated] = await tx.update(schema.generationJobs).set({ status: failure ? 'failed' : 'succeeded', finishedAt: new Date(), output })
      .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, 'running'))).returning();
    if (!updated) return;
    const screens = screenIds.length ? await tx.select().from(schema.screens).where(and(eq(schema.screens.projectId, project.id), sql`${schema.screens.id} = any(${sql.raw(`array[${screenIds.map((s) => `'${s}'::uuid`).join(',')}]`)})`)) : [];
    const entryId = ctx.entryRepair ? screens.find((s) => s.name === ctx.entryRepair!.name)?.id : undefined;
    const fresh = screens.filter((s) => s.id !== entryId);
    const names = fresh.map((s) => s.name).join('、');
    const versions = Number((job.input as { versions?: number }).versions ?? 1);
    const candidateNote = versions > 1 ? `，每屏 ${versions} 版候选，点卡片角标选一版` : '';
    const entryNote = ctx.entryRepair ? `；已把「${ctx.entryRepair.name}」接到新屏${ctx.entryRepair.added.length ? `（${ctx.entryRepair.added.join('、')}）` : ''}` : '';
    const proposal = extraOutput.proposal as DesignProposalDto | undefined;
    const content = failure
      ? `${job.kind === 'chat' ? '回答失败' : '生成失败'}（${failure.errorClass}）：${failure.message}${ctx.produced.length ? `；已保留 ${ctx.produced.length} 屏` : ''}`
      // 聊天回执就是助手最后一段文字；它只动手没说话时至少报出改了哪几屏
      : job.kind === 'chat' ? ((extraOutput.reply as string | undefined) || (screens.length ? `已更新 ${screens.length} 屏：${names}` : '（助手没有回话）'))
      : job.kind === 'export_prototype' ? '原型已导出'
      : job.kind === 'apply_design_system' ? `设计系统已回刷 ${screens.length} 屏`
      : job.kind === 'propose_design_system' ? `设计系统提案已生成${proposal?.summary ? `：${proposal.summary}` : ''}，在设计系统面板预览后确认写入`
      : job.kind === 'regenerate_subtree' ? `已重生成「${names}」中的选中区域`
      : job.kind === 'edit_screens' ? `已更新 ${screens.length} 屏：${names}${candidateNote}`
      : `已生成 ${fresh.length} 屏：${names}${candidateNote}${entryNote}`;
    await tx.update(schema.messages).set({ content, affectedScreenIds: screenIds }).where(and(eq(schema.messages.jobId, jobId), eq(schema.messages.role, 'assistant')));
    await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, project.id));
  });
  const rows = screenIds.length ? await db.select().from(schema.screens).where(and(eq(schema.screens.projectId, project.id), sql`${schema.screens.id} = any(${sql.raw(`array[${screenIds.map((s) => `'${s}'::uuid`).join(',')}]`)})`)) : [];
  // 批注随作业终态收口（REQ-EDIT-004）：成功标为已处理，失败 / 取消回落为未处理
  await settleByJob(jobId, !failure);
  const [projectNow] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
  await emitJobEvent(jobId, failure ? 'failed' : 'succeeded', { errorClass: failure?.errorClass, message: failure?.message, screens: await screenDtos(projectNow, rows), ...(extraOutput.proposal ? { proposal: extraOutput.proposal } : {}) });
}

async function deriveIfProduced(ctx: Ctx) {
  if (ctx.produced.length) await db.transaction((tx) => deriveLinks(tx, ctx.project.id));
}
