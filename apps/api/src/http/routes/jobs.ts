import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { adoptGroupSchema } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { parseBody, requireUser, type Env } from '../app.ts';
import { ownedJob, cancelJob } from '../../services/jobs.ts';
import { jobDto, ownedProject } from '../../services/projects.ts';
import { listCandidates, adoptCandidate, deriveLinks } from '../../services/screens.ts';
import { listJobEvents, subscribeJob } from '../../lib/events.ts';
import { problems, Problem } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';

export const jobRoutes = new Hono<Env>();

// API-CORE-026：候选覆盖层的数据（REQ-CORE-015）
jobRoutes.get('/v1/jobs/:jobId/candidates', async (c) => {
  const user = requireUser(c);
  const job = await ownedJob(user.id, c.req.param('jobId'));
  const project = await ownedProject(user.id, job.projectId);
  c.header('Cache-Control', 'no-store');
  return c.json(await listCandidates(project, job.id));
});

// API-CORE-025（整组）：把该作业产出候选的每一屏 current 都指向同 index 的修订；某屏没有该 index 或已不属同批则跳过
jobRoutes.post('/v1/jobs/:jobId/candidates/adopt', async (c) => {
  const user = requireUser(c);
  const job = await ownedJob(user.id, c.req.param('jobId'));
  const project = await ownedProject(user.id, job.projectId);
  const { index } = await parseBody(c, adoptGroupSchema);
  const cands = await listCandidates(project, job.id);
  const adopted: string[] = []; const skipped: string[] = [];
  for (const s of cands.screens) {
    const rev = s.revisions.find((r) => r.index === index);
    const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, s.screenId));
    if (!rev || !screen) { skipped.push(s.screenId); continue; }
    try { await db.transaction((tx) => adoptCandidate(tx, screen, rev.id)); adopted.push(s.screenId); }
    catch (e) { if (e instanceof Problem) skipped.push(s.screenId); else throw e; }
  }
  if (adopted.length) await db.transaction((tx) => deriveLinks(tx, project.id));
  return c.json({ adopted, skipped });
});

// API-PROTO-002：导出作业完成后下载单文件原型
jobRoutes.get('/v1/jobs/:jobId/export', async (c) => {
  const user = requireUser(c);
  const job = await ownedJob(user.id, c.req.param('jobId'));
  const key = (job.output as { exportKey?: string } | null)?.exportKey;
  if (job.kind !== 'export_prototype' || job.status !== 'succeeded' || !key) throw problems.jobNotFinished();
  if (c.req.query('inline') === '1') return c.redirect(await storage.signedUrl(key), 302);
  const body = await storage.get(key);
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="quilt-prototype-${job.projectId.slice(0, 8)}.html"`);
  c.header('Cache-Control', 'private, no-store');
  return c.body(new Uint8Array(body));
});

// API-CORE-007
jobRoutes.get('/v1/jobs/:jobId', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ job: jobDto(await ownedJob(user.id, c.req.param('jobId'))) });
});

// API-CORE-009
jobRoutes.post('/v1/jobs/:jobId/cancel', async (c) => {
  const user = requireUser(c);
  const job = await ownedJob(user.id, c.req.param('jobId'));
  return c.json({ job: jobDto(await cancelJob(job)) });
});

// API-CORE-008：SSE，事件带 seq，支持 Last-Event-ID 续传；终态事件后关闭。
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
jobRoutes.get('/v1/jobs/:jobId/events', async (c) => {
  const user = requireUser(c);
  const job = await ownedJob(user.id, c.req.param('jobId'));
  let last = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0) || 0;
  return streamSSE(c, async (stream) => {
    let open = true;
    let unsubscribe = () => {};
    stream.onAbort(() => { open = false; unsubscribe(); });
    const flush = async () => {
      const rows = await listJobEvents(job.id, last);
      for (const e of rows) {
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify({ seq: e.seq, type: e.type, data: e.data, at: e.createdAt.toISOString() }) });
        if (TERMINAL.has(e.type)) { open = false; }
      }
    };
    let pending = false;
    unsubscribe = await subscribeJob(job.id, () => { pending = true; });
    await flush();
    let idle = 0;
    while (open) {
      await stream.sleep(250);
      if (pending) { pending = false; idle = 0; await flush(); continue; }
      idle += 250;
      if (idle >= 15_000) { idle = 0; await stream.writeSSE({ event: 'ping', data: '' }); await flush(); }
    }
    unsubscribe();
  });
});
