import { and, eq, lt, isNull, sql, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { jobQueue, shotQueue } from '../services/jobs.ts';
import { emitJobEvent, emitProjectEvent } from '../lib/events.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { screenshotHtml } from '../lib/screenshot.ts';
import { DEVICE_SIZE, type DeviceType } from '@quilt/core';
import { runJob } from './pipeline.ts';
import { startAgentDelivery } from './agentDelivery.ts';

export async function renderRevisionScreenshot(revisionId: string): Promise<boolean> {
  const [r] = await db.select({ id: schema.screenRevisions.id, htmlKey: schema.screenRevisions.htmlKey, screenshotKey: schema.screenRevisions.screenshotKey, screenId: schema.screens.id, projectId: schema.projects.id, deviceType: schema.projects.deviceType })
    .from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.screens.projectId))
    .where(eq(schema.screenRevisions.id, revisionId));
  if (!r || r.screenshotKey) return false;
  const html = (await storage.get(r.htmlKey)).toString('utf8');
  const png = await screenshotHtml(html, DEVICE_SIZE[r.deviceType as DeviceType]);
  const key = objectKeys.revisionShot(r.projectId, r.screenId, r.id);
  await storage.put(key, png, 'image/png');
  await db.update(schema.screenRevisions).set({ screenshotKey: key }).where(eq(schema.screenRevisions.id, r.id));
  // 截图就绪：非作业路径（MCP 回写、直改）没有 screen_screenshot_ready 事件，项目频道补一条让卡片换图
  await emitProjectEvent(r.projectId, 'screen_changed', { screenId: r.screenId, revisionId: r.id, screenshot: true }).catch(() => {});
  return true;
}

// screenshot.retry（§17）：补扫缺截图的修订（创建超过 30 s、每轮最多 50 条）
let retrying = false;
export async function retryScreenshots(): Promise<number> {
  if (retrying) return 0;
  retrying = true;
  try {
    const rows = await db.select({ id: schema.screenRevisions.id, htmlKey: schema.screenRevisions.htmlKey, screenId: schema.screens.id, projectId: schema.projects.id, deviceType: schema.projects.deviceType })
      .from(schema.screenRevisions)
      .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.screens.projectId))
      .where(and(isNull(schema.screenRevisions.screenshotKey), lt(schema.screenRevisions.createdAt, new Date(Date.now() - 30_000))))
      .limit(50);
    let n = 0;
    for (const r of rows) {
      try {
        const html = (await storage.get(r.htmlKey)).toString('utf8');
        const png = await screenshotHtml(html, DEVICE_SIZE[r.deviceType as DeviceType]);
        const key = objectKeys.revisionShot(r.projectId, r.screenId, r.id);
        await storage.put(key, png, 'image/png');
        await db.update(schema.screenRevisions).set({ screenshotKey: key }).where(eq(schema.screenRevisions.id, r.id));
        n++;
      } catch (e) { console.warn(`[screenshot.retry] ${r.id}: ${(e as Error).message}`); }
    }
    if (n) console.log(`[screenshot.retry] backfilled ${n}`);
    return n;
  } finally { retrying = false; }
}

// 进程重启的收口（ADR-010 v0.32）：queued 的 model 作业补入队；running 的 model 作业标失败——上次进程没跑完。
// running 的 agent 作业不动：活在外面的 Claude Code 会话手里，agentDelivery 启动时按 startedAt 重新计时
async function recoverJobs() {
  const stale = await db.update(schema.generationJobs)
    .set({ status: 'failed', finishedAt: new Date(), output: sql`coalesce(${schema.generationJobs.output}, '{}'::jsonb) || '{"errorClass":"system","message":"Quilt 重启时作业未完成"}'::jsonb` })
    .where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'model'))).returning({ id: schema.generationJobs.id });
  for (const r of stale) {
    await db.update(schema.messages).set({ content: '生成失败（system）：Quilt 重启时作业未完成' }).where(and(eq(schema.messages.jobId, r.id), eq(schema.messages.role, 'assistant'), eq(schema.messages.content, '')));
    await emitJobEvent(r.id, 'failed', { errorClass: 'system', message: 'Quilt 重启时作业未完成' }).catch(() => {});
  }
  const queued = await db.select({ id: schema.generationJobs.id, runner: schema.generationJobs.runner }).from(schema.generationJobs).where(inArray(schema.generationJobs.status, ['queued']));
  for (const j of queued) if (j.runner === 'model') jobQueue.push({ jobId: j.id });
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
      for (const r of rows) await emitJobEvent(r.id, 'failed', { errorClass: 'timeout', message: 'swept by job.timeout' });
    } catch (e) { console.error('[job.timeout]', e); }
  }, 60_000).unref();
  setTimeout(() => retryScreenshots().catch(() => {}), 3_000);
  setInterval(() => retryScreenshots().catch(() => {}), 5 * 60_000).unref();
  console.log(`[worker] in-process queues ready (concurrency ${config.workerConcurrency}, llm=${config.llmDriver}, screenshot=${config.screenshotChannel || 'auto'})`);
}
