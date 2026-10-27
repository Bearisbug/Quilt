import { and, eq, inArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { Problem, problems, isUniqueViolation } from '../lib/errors.ts';
import { emitJobEvent } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { InProcessQueue } from '../lib/queue.ts';
import { toolAvailable } from '../lib/agentCli.ts';
import { findSession } from '../lib/claudeSessions.ts';
import { findCodexThread } from '../lib/codexSessions.ts';
import { runnerCatalog, listChannels } from './channels.ts';
import { driverSupportsVision } from '../lib/llm.ts';
import { hasActiveJob } from './screens.ts';
import { surfaceFor } from './surfaces.ts';
import { estimateJob, createJobSchema, L, subtreeBlockIssues, extractBody, type CreateJobInput, type JobRunner, type Locale, type Runner } from '@quilt/core';
import { requestUiLocale, tr } from '../lib/locale.ts';
import type { UserRow } from './user.ts';
import type { JobRow } from './projects.ts';

// 进程内队列（ADR-010 v0.32）：job.run 跑 worker 作业，screenshot.render 按 revisionId 去重
export const jobQueue = new InProcessQueue<{ jobId: string }>('job.run', config.workerConcurrency);
export const shotQueue = new InProcessQueue<{ revisionId: string }>('screenshot.render', 4);
export async function enqueueScreenshot(revisionId: string): Promise<void> {
  shotQueue.push({ revisionId }, { key: revisionId, retries: 2, retryDelayMs: 5000 });
}

// 本机 agent 的投递挂钩（REQ-AGENT-003）：worker/agentDelivery 启动时注册，避免 services → worker 的循环依赖
type AgentHooks = { run: (jobId: string) => void; cancel: (jobId: string) => void };
let agentHooks: AgentHooks | null = null;
export const registerAgentHooks = (h: AgentHooks) => { agentHooks = h; };
// 在跑的模型作业各自的中止器：worker 起跑时登记、结束时摘除；取消时由这里中止，未发出的 LLM 调用不再发、已写到一半的产出不再落库
export const modelAborts = new Map<string, AbortController>();

// §15 限流：作业创建 ≤ 10 次/分钟（进程内滑动窗口；本地版保留，挡住 agent 失控循环）
const windows = new Map<string, number[]>();
// 返回退还函数：同一幂等键的并发请求最后拿到的是首次作业，没建新作业就不该占名额
function assertRate(userId: string): () => void {
  const now = Date.now();
  const arr = (windows.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= config.rateLimitJobsPerMinute) throw problems.rateLimited(60);
  arr.push(now); windows.set(userId, arr);
  return () => { const a = windows.get(userId) ?? []; const i = a.indexOf(now); if (i >= 0) a.splice(i, 1); };
}

export function targetScreenOf(input: CreateJobInput): string | null {
  switch (input.kind) {
    case 'edit_screens': return input.input.screenIds.length === 1 ? input.input.screenIds[0] : null;
    case 'regenerate_subtree': return input.input.screenId;
    case 'ingest_screen': return input.input.screenId ?? null;
    default: return null;
  }
}

// 作业超时随预估调用数伸缩（REQ-CORE-008）：基数 + 每次调用一分钟 + 每屏确定性回刷 5 s（回刷 / 改组件逐屏落修订并截图）
// + 改屏整屏重写的输出时间（outputChars = 目标屏正文长度 × 版数，§11 v1.03），封顶
export function timeoutFor(input: CreateJobInput, repaintScreens = 0, outputChars = 0): number {
  const { calls } = estimateJob(input, 0);
  const t = config.jobTimeoutMs;
  if (t.total) return t.total;
  return Math.min(t.max, t.base + calls * t.perCall + repaintScreens * t.perScreen + Math.ceil(outputChars / t.outputCharsPerSec) * 1000);
}

// regenerate_subtree 创建前校验：目标屏得在这个项目里（草稿本里即目标是草稿，REQ-CORE-045），qid 必须在当前修订里（TC-EDIT-004 → 404），
// expectedRevisionId 必须是当前版；带 qids（v1.26）时这几块都要在这一版里、互不包含，否则 400
async function assertSubtreeTarget(projectId: string, input: { screenId: string; qid: string; qids?: string[]; expectedRevisionId: string }) {
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, input.screenId));
  if (screen && screen.projectId !== projectId) throw problems.notFound();
  if (!screen?.currentRevisionId) throw problems.elementNotFound();
  if (screen.currentRevisionId !== input.expectedRevisionId) throw problems.revisionConflict();
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
  const html = (await storage.get(rev.htmlKey)).toString('utf8');
  if (input.qids) {
    const { missing, nested } = subtreeBlockIssues(extractBody(html), input.qids);
    if (missing.length) throw problems.validation([{ path: 'input.qids', message: L(`这几块不在这一版里：${missing.join('、')}`, `Not in this revision: ${missing.join(', ')}`) }]);
    if (nested.length) throw problems.validation(nested.map(([outer, inner]) => ({ path: 'input.qids', message: L(`${outer} 包住了 ${inner}，只留外面那一块`, `${outer} contains ${inner}; keep only the outer one`) })));
    return;
  }
  if (!html.includes(`data-qid="${input.qid}"`)) throw problems.elementNotFound();
}

// 目标在建作业之前复核（API-CORE-006 / 010 / 034 v0.77）：改屏的目标屏得还在本项目里，造变体的 variantOf 得是本项目的默认屏——
// 不查就建的话，作业会「成功」更新 0 屏，或在 worker 里以英文原因失败
async function assertTargets(projectId: string, input: CreateJobInput) {
  if (input.kind === 'edit_screens') {
    const ids = Array.from(new Set(input.input.screenIds));
    const found = await db.select({ id: schema.screens.id }).from(schema.screens).where(and(eq(schema.screens.projectId, projectId), inArray(schema.screens.id, ids)));
    if (found.length !== ids.length) throw new Problem(404, '/errors/not-found', L('目标屏不存在或已被删除', 'Some target screens do not exist or were deleted'));
  }
  if (input.kind === 'generate' && input.input.variantOf) {
    const [base] = await db.select({ variantOf: schema.screens.variantOf }).from(schema.screens).where(and(eq(schema.screens.id, input.input.variantOf), eq(schema.screens.projectId, projectId)));
    if (!base || base.variantOf) throw problems.unprocessable([{ path: 'variantOf', message: L('变体只能从本项目的默认屏出', 'State variants can only be made from a default screen in this project') }]);
  }
  // 端（REQ-CORE-049）：普通项目的造屏、导出与建议状态都落在一端——变体随默认屏、懒生成没指定端时随来源屏，其余缺省第一端；
  // 定下来写回 input.surfaceId，worker 只认它。草稿本没有端（assertSketchbookJob 已拒带端的输入）
  if (input.kind === 'generate' || input.kind === 'export_prototype' || input.kind === 'propose_states') {
    const [project] = await db.select({ kind: schema.projects.kind }).from(schema.projects).where(eq(schema.projects.id, projectId));
    if (project?.kind !== 'app') return;
    const inp = input.input as { surfaceId?: string; variantOf?: string; fromScreenId?: string };
    const from = inp.variantOf ?? (inp.surfaceId ? undefined : inp.fromScreenId);
    if (from) {
      const [s] = await db.select({ surfaceId: schema.screens.surfaceId }).from(schema.screens).where(and(eq(schema.screens.id, from), eq(schema.screens.projectId, projectId)));
      if (s?.surfaceId) inp.surfaceId = s.surfaceId;
    }
    inp.surfaceId = (await surfaceFor(projectId, inp.surfaceId)).id;
  }
}

const jobByKey = async (projectId: string, key: string): Promise<JobRow | undefined> =>
  (await db.select().from(schema.generationJobs).where(and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.idempotencyKey, key))))[0];

// 作业创建（状态机 [*]→queued）：幂等 → 目标存在 → 限流 → 目标屏占用 → 落库 → 入队（model）或投递到本机会话（agent）。
// 建作业的入口校验（CH-2 v1.06）：POST /jobs、发消息、重试、MCP 四个入口共用这一份——输入按作业种类过 schema
// （重试拼回去的旧输入也过）；草稿本只受理单屏单版的造与改、画框只给草稿本（REQ-CORE-040）；
// 账号自建通道要属于本人；带参考图时通道要支持视觉（REQ-CORE-012，不支持就说清楚，不静默丢图）
async function assertInput(user: UserRow, projectId: string, input: CreateJobInput) {
  const checked = createJobSchema.safeParse(input);
  if (!checked.success) throw problems.validation(checked.error.issues.map((i) => ({ path: ['input', ...i.path].join('.'), message: i.message })));
  const [project] = await db.select({ kind: schema.projects.kind }).from(schema.projects).where(eq(schema.projects.id, projectId));
  // 动态引入：sketchbook.ts 放进项目时反过来要用 createJob
  const { assertSketchbookJob } = await import('./sketchbook.ts');
  if (project) assertSketchbookJob(project, checked.data);
  const { runner, imageKeys } = input.input as { runner?: Runner; imageKeys?: string[] };
  if (runner?.kind === 'channel' && !(await listChannels(user.id)).some((c) => c.id === runner.channelId)) throw problems.notFound();
  if (imageKeys?.length && runner?.kind === 'model' && !driverSupportsVision(runner.driver)) {
    throw problems.validation([{ path: 'runner', message: L(`「${runner.driver}」模型不支持参考图，换一个支持视觉的模型再发`, `The “${runner.driver}” model does not support reference images; switch to a model with vision and send again`) }]);
  }
}

export async function createJob(args: { user: UserRow; projectId: string; input: CreateJobInput; idempotencyKey: string | null; requestId: string; runner?: JobRunner; withMessage?: { content: string; attachments?: unknown[] } }): Promise<{ job: JobRow; userMessage?: typeof schema.messages.$inferSelect; assistantMessage?: typeof schema.messages.$inferSelect; reused: boolean }> {
  const { user, projectId, input, idempotencyKey } = args;
  const runner: JobRunner = args.runner ?? 'model';
  if (idempotencyKey) {
    const existing = await jobByKey(projectId, idempotencyKey);
    if (existing) return { job: existing, reused: true };
  }
  await assertInput(user, projectId, input);
  await assertTargets(projectId, input);
  // 界面语言（REQ-CORE-046）：网页端带 X-Quilt-Locale 建的作业都把它记进 input.locale（重试以这次请求的头为准）：
  // worker 的回执、进度与失败文案按它写，写屏上文字的那几种（LOCALE_JOB_KINDS）还据此给提示词补一句语言要求；MCP、脚本不带这个头，不记。
  // 没带头时要删掉输入里已有的 locale：请求体里自带的不认，重试拼回来的旧输入也不沿用旧作业的值
  const uiLocale = requestUiLocale();
  const withLocale = input.input as { locale?: Locale };
  if (uiLocale) withLocale.locale = uiLocale;
  else delete withLocale.locale;
  const releaseRate = assertRate(user.id);
  // 没带通道的 LLM 作业（MCP 建的、辅助作业）用用户自己配的默认通道；一条都没有才回落到 .env 的驱动
  if (runner === 'model' && ['generate', 'edit_screens', 'regenerate_subtree', 'propose_design_system', 'edit_component', 'propose_states'].includes(input.kind)) {
    const inp = input.input as { runner?: unknown };
    if (!inp.runner) {
      const cat = await runnerCatalog(user);
      const d = cat.items.find((i) => i.id === cat.default);
      if (d && d.runner.kind === 'channel') inp.runner = d.runner;
    }
  }
  if (runner === 'agent') {
    // 投递到本机会话（v0.34）：CLI 得装着，选中的会话得还在——建作业前就拒，不让作业带着死目标进 running。
    // Claude Code 要会话此刻活着；Codex（v0.68）只要线程还在线程库里，没打开的投递时由桌面版打开
    const r = (input.input as { runner?: { tool?: string; sessionId?: string } }).runner;
    const a = toolAvailable(r?.tool);
    if (!a.ok) throw problems.validation([{ path: 'runner', message: a.hint }]);
    const exists = !!r?.sessionId && !!(r.tool === 'codex' ? await findCodexThread(r.sessionId) : await findSession(r.sessionId));
    if (!exists) throw problems.validation([{ path: 'runner.sessionId', message: L('会话已关闭或不存在，重新选一个', 'The session is closed or gone; pick another') }]);
    // 本机会话拿到的是一段文字指令，钉死路由的懒生成、造变体、叠层屏这三种它没有对应的写法，与其静默当普通造屏做，不如当场拒
    if (input.kind === 'generate' && (input.input.route || input.input.variantOf || input.input.presentation)) throw problems.validation([{ path: 'runner', message: L('懒生成、出变体、叠层屏请换成一个模型，本机会话不接这类作业', 'Local sessions do not take missing pages, state variants or overlay screens; switch to a model') }]);
    if (input.kind === 'propose_states') throw problems.validation([{ path: 'runner', message: L('建议状态请换成一个模型，本机会话不接这类作业', 'Local sessions do not suggest states; switch to a model') }]);
  }
  if (input.kind === 'regenerate_subtree') await assertSubtreeTarget(projectId, input.input);
  const targetScreenId = targetScreenOf(input);
  const multi = input.kind === 'edit_screens' ? input.input.screenIds : input.kind === 'apply_design_system' && input.input.screenIds !== 'all' ? input.input.screenIds : [];

  const created = db.transaction(async (tx) => {
    for (const sid of [targetScreenId, ...multi].filter((x): x is string => !!x)) {
      if (await hasActiveJob(tx, projectId, sid)) throw problems.screenBusy();
    }
    // 聊天回合逐个串行（REQ-CORE-023）：一个项目一条 SDK 会话，两个进程不能同时 resume；部分唯一索引兜底并发
    if (input.kind === 'chat') {
      const [busy] = await tx.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
        .where(and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.kind, 'chat'), inArray(schema.generationJobs.status, ['queued', 'running']))).limit(1);
      if (busy) throw problems.screenBusy();
    }
    let job: JobRow;
    try {
      [job] = await tx.insert(schema.generationJobs).values({ projectId, createdBy: user.id, kind: input.kind, status: 'queued', runner, input: input.input, idempotencyKey, targetScreenId, requestId: args.requestId }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw problems.screenBusy();
      throw e;
    }
    let userMessage, assistantMessage;
    if (args.withMessage) {
      // 同事务内 now() 相同，显式错开 1ms 保证用户消息排在助手消息前
      const t = Date.now();
      [userMessage] = await tx.insert(schema.messages).values({ projectId, role: 'user', content: args.withMessage.content, attachments: args.withMessage.attachments ?? [], jobId: job.id, createdAt: new Date(t) }).returning();
      [assistantMessage] = await tx.insert(schema.messages).values({ projectId, role: 'assistant', content: '', jobId: job.id, createdAt: new Date(t + 1) }).returning();
    }
    return { job, userMessage, assistantMessage, reused: false };
  });
  let result: Awaited<typeof created>;
  try { result = await created; } catch (e) {
    // 同一幂等键并发到达（§16 v0.77）：上面那次幂等查询在事务外，后到的查不到、随后撞上首个作业的屏锁或唯一索引——
    // 这时首个已经提交，按键重查一次就是它；查不到才是真的屏忙
    if (idempotencyKey && e instanceof Problem && e.type === '/errors/screen-busy') {
      const existing = await jobByKey(projectId, idempotencyKey);
      if (existing) { releaseRate(); return { job: existing, reused: true }; }
    }
    throw e;
  }
  // 事件发不出去（库抖了一下）只记日志：作业已落库，入队这一步不能被它挡掉，否则只有重启才会再领（§16 v1.03）
  await emitJobEvent(result.job.id, 'progress', { stage: 'queued' }).catch((e) => console.warn(`[job ${result.job.id}] queued event: ${(e as Error).message}`));
  if (runner === 'model') jobQueue.push({ jobId: result.job.id }, { key: result.job.id });
  else agentHooks?.run(result.job.id);
  return result;
}

export async function ownedJob(ownerId: string, jobId: string): Promise<JobRow> {
  const [row] = await db.select({ job: schema.generationJobs }).from(schema.generationJobs)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.generationJobs.projectId))
    .where(and(eq(schema.generationJobs.id, jobId), eq(schema.projects.ownerId, ownerId)));
  if (!row) throw problems.notFound();
  return row.job;
}

// API-CORE-029：作业列表（agent 面板用）
export async function listJobs(projectId: string, opts: { runner?: JobRunner; limit: number }): Promise<JobRow[]> {
  const where = opts.runner ? and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.runner, opts.runner)) : eq(schema.generationJobs.projectId, projectId);
  return db.select().from(schema.generationJobs).where(where).orderBy(desc(schema.generationJobs.createdAt)).limit(opts.limit);
}

// 取消（queued→cancelled / running→cancelled）；worker 在落库前会复核状态；agent 作业只停计时器（会话那边的活由用户自己叫停）
export async function cancelJob(job: JobRow): Promise<JobRow> {
  const [updated] = await db.update(schema.generationJobs).set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(schema.generationJobs.id, job.id), inArray(schema.generationJobs.status, ['queued', 'running']))).returning();
  if (!updated) throw problems.jobFinished();
  // 先中止在跑的调用：worker 落库前看的是这个信号，库里已取消、信号还没发的那几步里它照样会写
  if (job.runner === 'agent') agentHooks?.cancel(job.id);
  else modelAborts.get(job.id)?.abort(new Error('cancelled'));
  await db.update(schema.messages).set({ content: tr('已取消', 'Cancelled') }).where(and(eq(schema.messages.jobId, job.id), eq(schema.messages.role, 'assistant'), eq(schema.messages.content, '')));
  await emitJobEvent(job.id, 'cancelled', {});
  return updated;
}
