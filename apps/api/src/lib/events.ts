import { and, eq, gt, asc } from 'drizzle-orm';
import { db, query, subscribe, schema } from '../db/client.ts';
import type { JobEventType, ProjectEventDto } from '@quilt/core';

// 作业事件（API-CORE-008 SSE）：落表保证可续传（Last-Event-ID），NOTIFY 保证低延迟。
const CHANNEL = 'quilt_job_events';
// 项目级事件（API-CORE-030 v0.34）：本机会话经 MCP 回写、别的入口建的作业、截图就绪——凡是画布该刷新的都从这里通知。
// 不落表、不续传：只是「有变化」的提示，画布收到就整体刷新一次（聚焦中的屏走热更新），断线重连也只是再刷一次。
const PROJECT_CHANNEL = 'quilt_project_events';
export async function emitProjectEvent(projectId: string, type: ProjectEventDto['type'], data: unknown = {}): Promise<void> {
  const at = new Date().toISOString();
  let payload = JSON.stringify({ projectId, type, data: data ?? {}, at });
  // pg_notify 的上限是 8000 字节，超了整条通知发不出去——宁可丢掉 data 只报「有变化」，让画布整体重取
  if (payload.length > 7000) {
    const keep = (data ?? {}) as Record<string, unknown>;
    payload = JSON.stringify({ projectId, type, data: { jobId: keep.jobId, type: keep.type, seq: keep.seq, truncated: true }, at });
  }
  await query('select pg_notify($1, $2)', [PROJECT_CHANNEL, payload]);
}

// 投影给项目频道的负载：只留画布要用的字段。succeeded 的原始负载带全量屏 DTO（含签名 URL），
// 直接透传会超出 pg_notify 的 8000 字节上限、让整条通知发不出去，所以终态只送屏 id；
// 要完整产出的场景（设计系统提案）由画布另取作业详情。
function projectProjection(type: JobEventType, data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
  switch (type) {
    case 'progress': return pick('stage', 'attempt', 'step', 'screens');
    case 'screen_planned': return pick('name', 'route', 'screenId');
    case 'screen_html_ready': return pick('screenId', 'revisionId', 'lintPassed');
    case 'screen_screenshot_ready': return pick('screenId', 'revisionId');
    default: {
      const ids = Array.isArray(d.screens) ? (d.screens as { id?: string }[]).map((x) => x.id).filter(Boolean)
        : Array.isArray(d.screenIds) ? (d.screenIds as string[]) : undefined;
      // message 可能是模型回的长文，截断——它在这里只用于 toast 一行
      const msg = typeof d.message === 'string' ? d.message.slice(0, 300) : undefined;
      return { ...(d.errorClass ? { errorClass: d.errorClass } : {}), ...(msg ? { message: msg } : {}), ...(ids ? { screenIds: ids } : {}) };
    }
  }
}

// 同一作业内的事件串行写入（并行生成多屏时 seq 不冲突）
const chains = new Map<string, Promise<unknown>>();

export function emitJobEvent(jobId: string, type: JobEventType, data: unknown = {}): Promise<number> {
  const prev = chains.get(jobId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const { rows } = await query<{ seq: number }>(
      `insert into job_events (job_id, seq, type, data)
       values ($1, (select coalesce(max(seq), 0) + 1 from job_events where job_id = $1), $2, $3::jsonb)
       returning seq`,
      [jobId, type, JSON.stringify(data ?? {})],
    );
    await query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ jobId, seq: rows[0].seq })]);
    // 投影到项目频道（API-CORE-030）：画布只订这一条流，作业进度也从这里来——
    // 每个在跑作业各开一条 SSE 会撞满浏览器同源 6 条连接的上限，而那份额度是所有标签页共用的
    const p = await query<{ project_id: string }>('select project_id from generation_jobs where id = $1', [jobId]);
    if (p.rows[0]) await emitProjectEvent(p.rows[0].project_id, 'job_changed', { jobId, type, seq: Number(rows[0].seq), data: projectProjection(type, data) }).catch(() => {});
    return Number(rows[0].seq);
  });
  chains.set(jobId, next);
  // 清理链表项时不能用 .finally()：它派生出的是一条新 promise，next 失败时那条没人接，
  // 于是一次写事件失败（例如作业刚被删、外键不成立）就以未捕获拒绝把整个进程带走。
  // 用 then(cb, cb) 派生出的 promise 总是 resolve，错误只沿 next 交给调用方。
  const cleanup = () => { if (chains.get(jobId) === next) chains.delete(jobId); };
  next.then(cleanup, cleanup);
  return next;
}

export async function listJobEvents(jobId: string, afterSeq = 0) {
  return db.select().from(schema.jobEvents).where(and(eq(schema.jobEvents.jobId, jobId), gt(schema.jobEvents.seq, afterSeq))).orderBy(asc(schema.jobEvents.seq));
}

// 单订阅按 jobId 分发（驱动层负责 LISTEN：pg 用专用连接，PGlite 用内建 listen）
type Listener = (seq: number) => void;
const listeners = new Map<string, Set<Listener>>();
let unsubscribeChannel: (() => void) | null = null;

async function ensureListening() {
  if (unsubscribeChannel) return;
  unsubscribeChannel = await subscribe(CHANNEL, (payload) => {
    try {
      const { jobId, seq } = JSON.parse(payload || '{}') as { jobId: string; seq: number };
      listeners.get(jobId)?.forEach((fn) => fn(seq));
    } catch { /* ignore malformed payload */ }
  });
}

export async function subscribeJob(jobId: string, fn: Listener): Promise<() => void> {
  await ensureListening();
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(fn);
  return () => { listeners.get(jobId)?.delete(fn); if (listeners.get(jobId)?.size === 0) listeners.delete(jobId); };
}

type ProjectListener = (e: ProjectEventDto) => void;
const projectListeners = new Map<string, Set<ProjectListener>>();
let unsubscribeProjectChannel: (() => void) | null = null;
export async function subscribeProject(projectId: string, fn: ProjectListener): Promise<() => void> {
  if (!unsubscribeProjectChannel) {
    unsubscribeProjectChannel = await subscribe(PROJECT_CHANNEL, (payload) => {
      try {
        const { projectId: pid, ...e } = JSON.parse(payload || '{}') as ProjectEventDto & { projectId: string };
        projectListeners.get(pid)?.forEach((f) => f(e));
      } catch { /* ignore malformed payload */ }
    });
  }
  if (!projectListeners.has(projectId)) projectListeners.set(projectId, new Set());
  projectListeners.get(projectId)!.add(fn);
  return () => { projectListeners.get(projectId)?.delete(fn); if (projectListeners.get(projectId)?.size === 0) projectListeners.delete(projectId); };
}
