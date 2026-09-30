import { and, eq, lt, isNull, isNotNull, sql, inArray, notInArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { jobQueue, shotQueue } from '../services/jobs.ts';
import { emitJobEvent, emitProjectEvent } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { storeRevisionShot, pointCurrentToFirstCandidate, deriveLinks } from '../services/screens.ts';
import { screenshotHtml } from '../lib/screenshot.ts';
import { DEVICE_SIZE, failureText, type DeviceType, type JobKind } from '@quilt/core';
import { runJob } from './pipeline.ts';
import { startAgentDelivery, deliverAgentJob } from './agentDelivery.ts';
import { settleByJob } from '../services/annotations.ts';

export async function renderRevisionScreenshot(revisionId: string): Promise<boolean> {
  const [r] = await db.select({ id: schema.screenRevisions.id, htmlKey: schema.screenRevisions.htmlKey, screenshotKey: schema.screenRevisions.screenshotKey, screenId: schema.screens.id, presentation: schema.screens.presentation, projectId: schema.projects.id, deviceType: schema.projects.deviceType })
    .from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.screens.projectId))
    .where(eq(schema.screenRevisions.id, revisionId));
  if (!r || r.screenshotKey) return false;
  const html = (await storage.get(r.htmlKey)).toString('utf8');
  const png = await screenshotHtml(html, DEVICE_SIZE[r.deviceType as DeviceType], { overlay: r.presentation === 'overlay' });
  if (!(await storeRevisionShot(r.projectId, r.screenId, r.id, png))) return false;
  // 截图就绪：非作业路径（MCP 回写、直改）没有 screen_screenshot_ready 事件，项目频道补一条让卡片换图
  await emitProjectEvent(r.projectId, 'screen_changed', { screenId: r.screenId, revisionId: r.id, screenshot: true }).catch(() => {});
  return true;
}

// screenshot.retry（§17）：补扫缺截图的修订（创建超过 30 s、每轮最多 50 条），各屏当前版先扫——历史版与候选缺图只影响修订面板。
// 同一修订失败第 n 次后 5 min × 2^(n−1) 内不再扫（封顶 6 h，进程内计数）：永久拍不成的修订（对象丢了、页面本身坏了）
// 不能占满每轮的 50 个名额、把别的修订挤出去
const shotFailures = new Map<string, { n: number; until: number }>();
let retrying = false;
export async function retryScreenshots(): Promise<number> {
  if (retrying) return 0;
  retrying = true;
  try {
    const now = Date.now();
    const waiting = [...shotFailures].filter(([, f]) => f.until > now).map(([id]) => id);
    const rows = await db.select({ id: schema.screenRevisions.id })
      .from(schema.screenRevisions)
      .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
      .where(and(isNull(schema.screenRevisions.screenshotKey), lt(schema.screenRevisions.createdAt, new Date(now - 30_000)), waiting.length ? notInArray(schema.screenRevisions.id, waiting) : undefined))
      .orderBy(sql`(${schema.screens.currentRevisionId} = ${schema.screenRevisions.id}) is true desc`, desc(schema.screenRevisions.createdAt))
      .limit(50);
    let n = 0;
    for (const r of rows) {
      // 与 screenshot.render 同一条路：拍成后推 screen_changed，已打开的画布换图
      try { if (await renderRevisionScreenshot(r.id)) n++; shotFailures.delete(r.id); }
      catch (e) {
        const k = (shotFailures.get(r.id)?.n ?? 0) + 1;
        shotFailures.set(r.id, { n: k, until: Date.now() + Math.min(5 * 60_000 * 2 ** (k - 1), 6 * 3600_000) });
        console.warn(`[screenshot.retry] ${r.id}: ${(e as Error).message}`);
      }
    }
    if (n) console.log(`[screenshot.retry] backfilled ${n}`);
    return n;
  } finally { retrying = false; }
}

// 进程在造屏 / 改屏中途退出时，runGenerate / runEditScreens 在 finally 里的收尾没跑（进程被杀时 finally 不执行）：按作业自己的
// screen_planned 事件与修订补做——候选批让 current 指向第 1 版（改屏候选只在 current 仍是它的基线时），一版都没落的新屏删掉
// （空屏占着路由，指向它的链接也不再显示为断链），再重派生应用地图
async function settleInterrupted(job: { id: string; projectId: string }) {
  const planned = (await db.select({ data: schema.jobEvents.data }).from(schema.jobEvents).where(and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.type, 'screen_planned'))))
    .map((e) => (e.data as { screenId?: string }).screenId).filter((id): id is string => !!id);
  const batches = await db.selectDistinct({ screenId: schema.screenRevisions.screenId, base: schema.screenRevisions.parentRevisionId }).from(schema.screenRevisions)
    .where(and(eq(schema.screenRevisions.jobId, job.id), isNotNull(schema.screenRevisions.candidateIndex)));
  const produced = await db.select({ id: schema.screenRevisions.id }).from(schema.screenRevisions).where(eq(schema.screenRevisions.jobId, job.id)).limit(1);
  if (!planned.length && !produced.length) return;
  await db.transaction(async (tx) => {
    for (const b of batches) await pointCurrentToFirstCandidate(tx, b.screenId, job.id, b.base ?? undefined);
    if (planned.length) await tx.delete(schema.screens).where(and(inArray(schema.screens.id, planned), isNull(schema.screens.currentRevisionId)));
    await deriveLinks(tx, job.projectId);
  });
}

// 进程重启的收口（ADR-010 v0.32）：queued 的作业补上——model 的入队、agent 的投递（deliverAgentJob 自己校验会话，不在就收成 failed）；
// running 的 model 作业标失败——上次进程没跑完，并补做它的收尾。running 的 agent 作业不动：活在外面的会话手里，agentDelivery 启动时按 startedAt 重新计时
async function recoverJobs() {
  const stale = await db.update(schema.generationJobs)
    .set({ status: 'failed', finishedAt: new Date(), output: sql`coalesce(${schema.generationJobs.output}, '{}'::jsonb) || '{"errorClass":"system","message":"Quilt 重启时作业未完成"}'::jsonb` })
    .where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'model'))).returning({ id: schema.generationJobs.id, kind: schema.generationJobs.kind, projectId: schema.generationJobs.projectId });
  for (const r of stale) {
    await db.update(schema.messages).set({ content: failureText(r.kind as JobKind, 'system', 'Quilt 重启时作业未完成') }).where(and(eq(schema.messages.jobId, r.id), eq(schema.messages.role, 'assistant'), eq(schema.messages.content, '')));
    await settleInterrupted(r).catch((e) => console.error(`[worker] settle ${r.id}`, e));
    await emitJobEvent(r.id, 'failed', { errorClass: 'system', message: 'Quilt 重启时作业未完成' }).catch(() => {});
    await settleByJob(r.id, false);
  }
  const queued = await db.select({ id: schema.generationJobs.id, runner: schema.generationJobs.runner }).from(schema.generationJobs).where(inArray(schema.generationJobs.status, ['queued']));
  for (const j of queued) {
    if (j.runner === 'model') jobQueue.push({ jobId: j.id });
    else await deliverAgentJob(j.id).catch((e) => console.error(`[agent ${j.id}]`, e));
  }
  if (stale.length || queued.length) console.log(`[worker] recovered: ${queued.length} re-queued, ${stale.length} marked failed`);
}

// 作业 Worker（§17 内部任务 job.claim / job.timeout / screenshot.render / screenshot.retry）
export async function startWorker() {
  await startAgentDelivery();
  jobQueue.work(async ({ jobId }) => { await runJob(jobId); });
  shotQueue.work(async ({ revisionId }) => { await renderRevisionScreenshot(revisionId); });
  await recoverJobs();
  // job.timeout：每分钟补扫超时的 running 作业（本进程之外的孤儿）。runner=agent 的作业由 agentDelivery 自己计时，不扫
  setInterval(async () => {
    try {
      const limit = new Date(Date.now() - config.jobTimeoutMs.max - 60_000);
      const rows = await db.update(schema.generationJobs)
        .set({ status: 'failed', finishedAt: new Date(), output: sql`coalesce(${schema.generationJobs.output}, '{}'::jsonb) || '{"errorClass":"timeout","message":"swept by job.timeout"}'::jsonb` })
        .where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'model'), lt(schema.generationJobs.startedAt, limit))).returning({ id: schema.generationJobs.id });
      for (const r of rows) { await emitJobEvent(r.id, 'failed', { errorClass: 'timeout', message: 'swept by job.timeout' }); await settleByJob(r.id, false); }
      // 投递是建作业后立即做的：agent 作业排队超过 1 分钟，就是投递在抢占之前出了错（它不会自己重来），再投一次
      const stuck = await db.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
        .where(and(eq(schema.generationJobs.status, 'queued'), eq(schema.generationJobs.runner, 'agent'), lt(schema.generationJobs.createdAt, new Date(Date.now() - 60_000))));
      for (const r of stuck) await deliverAgentJob(r.id);
    } catch (e) { console.error('[job.timeout]', e); }
  }, 60_000).unref();
  setTimeout(() => retryScreenshots().catch(() => {}), 3_000);
  setInterval(() => retryScreenshots().catch(() => {}), 5 * 60_000).unref();
  console.log(`[worker] in-process queues ready (concurrency ${config.workerConcurrency}, llm=${config.llmDriver}, screenshot=${config.screenshotChannel || 'auto'})`);
}
