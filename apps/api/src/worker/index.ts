import { and, eq, lt, isNull, isNotNull, sql, inArray, notInArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { jobQueue, shotQueue } from '../services/jobs.ts';
import { emitProjectEvent, notifyCanvas } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { storeRevisionShot, storeThumb } from '../services/screens.ts';
import { screenshotHtml } from '../lib/screenshot.ts';
import { shotSpecFor, type Presentation } from '@quilt/core';
import { runJob } from './pipeline.ts';
import { startAgentDelivery, deliverAgentJob } from './agentDelivery.ts';
import { finishFailed } from './failJob.ts';

export async function renderRevisionScreenshot(revisionId: string): Promise<boolean> {
  const [r] = await db.select({ id: schema.screenRevisions.id, htmlKey: schema.screenRevisions.htmlKey, screenshotKey: schema.screenRevisions.screenshotKey, screenId: schema.screens.id, presentation: schema.screens.presentation, frame: schema.screens.frame, projectId: schema.projects.id, deviceType: schema.projects.deviceType, kind: schema.projects.kind })
    .from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.screens.projectId))
    .where(eq(schema.screenRevisions.id, revisionId));
  if (!r || r.screenshotKey) return false;
  const html = (await storage.get(r.htmlKey)).toString('utf8');
  // 尺寸同出屏时（REQ-CORE-040）：草稿按画框拍，组件画框只拍根元素的框
  const shot = shotSpecFor({ kind: r.kind, deviceType: r.deviceType }, { frame: r.frame });
  const png = await screenshotHtml(html, shot.size, { overlay: r.presentation === 'overlay', rootOnly: shot.rootOnly });
  if (!(await storeRevisionShot(r.projectId, r.screenId, r.id, png, r.presentation as Presentation, r.frame))) return false;
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
    await backfillThumbs();
    return n;
  } finally { retrying = false; }
}

// 缩略图补扫（ADR-029 §25）：各屏当前修订先补（画布卡片用），再按新到旧补历史修订（v1.03 起修订面板与候选展开也用）。每轮最多 200 条；
// 回填带上截图键做条件，补的途中截图被作废（换呈现方式）就不写。做不出来的修订本进程内不再试（坏图不会自己变好），
// 补完一个项目推一条 screen_changed，开着的画布重取详情换上缩略图
const thumbFailed = new Set<string>();
async function backfillThumbs() {
  const rows = await db.select({ id: schema.screenRevisions.id, screenshotKey: schema.screenRevisions.screenshotKey, screenId: schema.screens.id, projectId: schema.screens.projectId })
    .from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .where(and(isNotNull(schema.screenRevisions.screenshotKey), isNull(schema.screenRevisions.thumbKey), thumbFailed.size ? notInArray(schema.screenRevisions.id, [...thumbFailed]) : undefined))
    .orderBy(sql`(${schema.screens.currentRevisionId} = ${schema.screenRevisions.id}) is true desc`, desc(schema.screenRevisions.createdAt))
    .limit(200);
  const touched = new Set<string>();
  let n = 0;
  for (const r of rows) {
    try {
      // 呈现方式与画框按截图键认：键里带 .overlay 的就是按叠层拍的（§16 v1.03；之前的叠层截图键不带，按整屏命名缩略图），草稿的键带画框（REQ-CORE-040）
      const [, overlay, frame] = r.screenshotKey!.match(/(\.overlay)?(?:\.(component|mobile|desktop))?\.png$/) ?? [];
      const thumbKey = await storeThumb(r.projectId, r.screenId, r.id, await storage.get(r.screenshotKey!), overlay ? 'overlay' : 'push', frame ?? null);
      const done = await db.update(schema.screenRevisions).set({ thumbKey })
        .where(and(eq(schema.screenRevisions.id, r.id), eq(schema.screenRevisions.screenshotKey, r.screenshotKey!))).returning({ id: schema.screenRevisions.id });
      if (done.length) { touched.add(r.projectId); n++; }
    } catch (e) {
      thumbFailed.add(r.id);
      console.warn(`[thumbnail.retry] ${r.id}: ${(e as Error).message}`);
    }
  }
  for (const projectId of touched) await notifyCanvas(projectId, { reason: 'thumbnail' });
  if (rows.length) console.log(`[thumbnail.retry] backfilled ${n}/${rows.length}`);
}

// 进程重启的收口（ADR-010 v0.32）：queued 的作业补上——model 的入队、agent 的投递（deliverAgentJob 自己校验会话，不在就收成 failed）；
// running 的 model 作业标失败——上次进程没跑完，并补做它的收尾。running 的 agent 作业不动：活在外面的会话手里，agentDelivery 启动时按 startedAt 重新计时
async function recoverJobs() {
  const stale = await db.update(schema.generationJobs)
    .set({ status: 'failed', finishedAt: new Date(), output: sql`coalesce(${schema.generationJobs.output}, '{}'::jsonb) || '{"errorClass":"system","message":"Quilt 重启时作业未完成"}'::jsonb` })
    .where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'model'))).returning({ id: schema.generationJobs.id, kind: schema.generationJobs.kind, projectId: schema.generationJobs.projectId, input: schema.generationJobs.input });
  for (const r of stale) await finishFailed(r, 'system', 'Quilt 重启时作业未完成');
  const queued = await db.select({ id: schema.generationJobs.id, runner: schema.generationJobs.runner }).from(schema.generationJobs).where(inArray(schema.generationJobs.status, ['queued']));
  for (const j of queued) {
    if (j.runner === 'model') jobQueue.push({ jobId: j.id }, { key: j.id });
    else await deliverAgentJob(j.id).catch((e) => console.error(`[agent ${j.id}]`, e));
  }
  if (stale.length || queued.length) console.log(`[worker] recovered: ${queued.length} re-queued, ${stale.length} marked failed`);
}

// upload.gc（§17 v0.82）：上传位最后一次写入后闲置超过签名 PUT 地址的有效期即删——签发了没用的空位、写了一半被丢下的都在这里收。
// 按最后一次写入算而不是签发时刻：分块写大屏的 agent 每段都是一轮模型输出，按签发时刻删会让写到一半的屏断掉
async function sweepUploads() {
  const before = Date.now() - config.uploadUrlMinutes * 60_000;
  for (const o of await storage.list('uploads/')) if (o.modifiedAt.getTime() < before) await storage.delete(o.key);
}

// storage.gc（§17 v1.03）：删超过 24 小时的导出产物（画布导出成功即下载，get_export 的地址 5 分钟过期）；
// 删上传超过 24 小时、没被任何消息或作业输入引用的参考图附件。删失败的下一轮再扫
const DAY = 24 * 3600_000;
export async function sweepStorage(now = Date.now()) {
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
  let removed = 0;
  for (const p of projects) {
    for (const o of await storage.list(`projects/${p.id}/exports/`)) if (o.modifiedAt.getTime() < now - DAY) { await storage.delete(o.key); removed++; }
    const stale = (await storage.list(`projects/${p.id}/attachments/`)).filter((o) => o.modifiedAt.getTime() < now - DAY);
    if (!stale.length) continue;
    const msgs = await db.select({ a: schema.messages.attachments }).from(schema.messages).where(eq(schema.messages.projectId, p.id));
    const jobs = await db.select({ input: schema.generationJobs.input }).from(schema.generationJobs).where(eq(schema.generationJobs.projectId, p.id));
    const used = new Set([...msgs.flatMap((m) => ((m.a ?? []) as { key: string }[]).map((x) => x.key)), ...jobs.flatMap((j) => ((j.input as { imageKeys?: string[] }).imageKeys ?? []))]);
    for (const o of stale) if (!used.has(o.key)) { await storage.delete(o.key); removed++; }
  }
  if (removed) console.log(`[storage.gc] removed ${removed} object(s)`);
  return removed;
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
        .where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'model'), lt(schema.generationJobs.startedAt, limit))).returning({ id: schema.generationJobs.id, kind: schema.generationJobs.kind, projectId: schema.generationJobs.projectId, input: schema.generationJobs.input });
      for (const r of rows) await finishFailed(r, 'timeout', 'swept by job.timeout');
      // 排队超过 1 分钟的 model 作业重新入队（v1.03）：建作业时入队那一步之前出过错就不会自己再来；领取是条件更新，重复入队无害
      const waiting = await db.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
        .where(and(eq(schema.generationJobs.status, 'queued'), eq(schema.generationJobs.runner, 'model'), lt(schema.generationJobs.createdAt, new Date(Date.now() - 60_000))));
      for (const r of waiting) jobQueue.push({ jobId: r.id }, { key: r.id });
      // 投递是建作业后立即做的：agent 作业排队超过 1 分钟，就是投递在抢占之前出了错（它不会自己重来），再投一次
      const stuck = await db.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
        .where(and(eq(schema.generationJobs.status, 'queued'), eq(schema.generationJobs.runner, 'agent'), lt(schema.generationJobs.createdAt, new Date(Date.now() - 60_000))));
      for (const r of stuck) await deliverAgentJob(r.id);
    } catch (e) { console.error('[job.timeout]', e); }
  }, 60_000).unref();
  setTimeout(() => retryScreenshots().catch(() => {}), 3_000);
  setInterval(() => retryScreenshots().catch(() => {}), 5 * 60_000).unref();
  setInterval(() => sweepUploads().catch((e) => console.error('[upload.gc]', e)), 60_000).unref();
  setTimeout(() => sweepStorage().catch((e) => console.error('[storage.gc]', e)), 60_000).unref();
  setInterval(() => sweepStorage().catch((e) => console.error('[storage.gc]', e)), 3600_000).unref();
  console.log(`[worker] in-process queues ready (concurrency ${config.workerConcurrency}, llm=${config.llmDriver}, screenshot=${config.screenshotChannel || 'auto'})`);
}
