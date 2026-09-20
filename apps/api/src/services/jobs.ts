import { and, eq, inArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { problems, isUniqueViolation } from '../lib/errors.ts';
import { emitJobEvent } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { InProcessQueue } from '../lib/queue.ts';
import { toolAvailable } from '../lib/agentCli.ts';
import { findSession } from '../lib/claudeSessions.ts';
import { runnerCatalog } from './channels.ts';
import { hasActiveJob } from './screens.ts';
import { estimateJob, type CreateJobInput, type JobRunner } from '@quilt/core';
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

// §15 限流：作业创建 ≤ 10 次/分钟（进程内滑动窗口；本地版保留，挡住 agent 失控循环）
const windows = new Map<string, number[]>();
function assertRate(userId: string) {
  const now = Date.now();
  const arr = (windows.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= config.rateLimitJobsPerMinute) throw problems.rateLimited(60);
  arr.push(now); windows.set(userId, arr);
}

export function targetScreenOf(input: CreateJobInput): string | null {
  switch (input.kind) {
    case 'edit_screens': return input.input.screenIds.length === 1 ? input.input.screenIds[0] : null;
    case 'regenerate_subtree': return input.input.screenId;
    case 'ingest_screen': return input.input.screenId ?? null;
    default: return null;
  }
}

// 作业超时随预估调用数伸缩（REQ-CORE-008）：基数 + 每次调用一分钟，封顶
export function timeoutFor(input: CreateJobInput): number {
  const { calls } = estimateJob(input, 0);
  return Math.min(config.jobTimeoutMs.max, config.jobTimeoutMs.base + calls * config.jobTimeoutMs.perCall);
}

// regenerate_subtree 创建前校验：qid 必须在当前修订里（TC-EDIT-004 → 404），expectedRevisionId 必须是当前版
async function assertSubtreeTarget(input: { screenId: string; qid: string; expectedRevisionId: string }) {
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, input.screenId));
  if (!screen?.currentRevisionId) throw problems.elementNotFound();
  if (screen.currentRevisionId !== input.expectedRevisionId) throw problems.revisionConflict();
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
  const html = (await storage.get(rev.htmlKey)).toString('utf8');
  if (!html.includes(`data-qid="${input.qid}"`)) throw problems.elementNotFound();
}

// 作业创建（状态机 [*]→queued）：幂等 → 限流 → 目标屏占用 → 落库 → 入队（model）或投递到本机会话（agent）。
export async function createJob(args: { user: UserRow; projectId: string; input: CreateJobInput; idempotencyKey: string | null; requestId: string; runner?: JobRunner; withMessage?: { content: string; attachments?: unknown[] } }): Promise<{ job: JobRow; userMessage?: typeof schema.messages.$inferSelect; assistantMessage?: typeof schema.messages.$inferSelect; reused: boolean }> {
  const { user, projectId, input, idempotencyKey } = args;
  const runner: JobRunner = args.runner ?? 'model';
  if (idempotencyKey) {
    const [existing] = await db.select().from(schema.generationJobs).where(and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.idempotencyKey, idempotencyKey)));
    if (existing) return { job: existing, reused: true };
  }
  assertRate(user.id);
  // 没带通道的 LLM 作业（MCP 建的、辅助作业）用用户自己配的默认通道；一条都没有才回落到 .env 的驱动
  if (runner === 'model' && ['generate', 'edit_screens', 'regenerate_subtree', 'propose_design_system'].includes(input.kind)) {
    const inp = input.input as { runner?: unknown };
    if (!inp.runner) {
      const cat = await runnerCatalog(user);
      const d = cat.items.find((i) => i.id === cat.default);
      if (d && d.runner.kind === 'channel') inp.runner = d.runner;
    }
  }
  if (runner === 'agent') {
    // 投递到本机会话（v0.34）：claude 得装着，选中的会话得还活着——建作业前就拒，不让作业带着死目标进 running
    const r = (input.input as { runner?: { tool?: string; sessionId?: string } }).runner;
    const a = toolAvailable(r?.tool);
    if (!a.ok) throw problems.validation([{ path: 'runner', message: a.hint }]);
    if (!r?.sessionId || !(await findSession(r.sessionId))) throw problems.validation([{ path: 'runner.sessionId', message: '会话已关闭或不存在，重新选一个' }]);
  }
  if (input.kind === 'regenerate_subtree') await assertSubtreeTarget(input.input);
  const targetScreenId = targetScreenOf(input);
  const multi = input.kind === 'edit_screens' ? input.input.screenIds : input.kind === 'apply_design_system' && input.input.screenIds !== 'all' ? input.input.screenIds : [];

  const result = await db.transaction(async (tx) => {
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
  await emitJobEvent(result.job.id, 'progress', { stage: 'queued' });
  if (runner === 'model') jobQueue.push({ jobId: result.job.id });
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
  await db.update(schema.messages).set({ content: '已取消' }).where(and(eq(schema.messages.jobId, job.id), eq(schema.messages.role, 'assistant'), eq(schema.messages.content, '')));
  if (job.runner === 'agent') agentHooks?.cancel(job.id);
  await emitJobEvent(job.id, 'cancelled', {});
  return updated;
}
