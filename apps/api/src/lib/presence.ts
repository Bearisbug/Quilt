import type { PresenceEventDto, PresencePerson, PresenceState } from '@quilt/core';

// 协作显示的在线状态（v1.32 REQ-CORE-048，API-CORE-053，ADR-038）：只存在这个进程的内存里，按项目分；
// 经项目事件流（API-CORE-030）推给同一项目的其他连接，不经 pg_notify——每秒十几条的光标会挤满通知队列，本地版只有一个进程。
// 15 s 收不到某个标签页的消息就当它离开
export const PRESENCE_TTL_MS = 15_000;

type Entry = { person: PresencePerson; state: PresenceState; at: number };
type Listener = (e: PresenceEventDto) => void;
const byProject = new Map<string, Map<string, Entry>>();
const listeners = new Map<string, Set<Listener>>();

const emit = (projectId: string, e: PresenceEventDto) => { for (const fn of listeners.get(projectId) ?? []) fn(e); };
const toEvent = (clientId: string, x: Entry): PresenceEventDto => ({ type: 'presence', data: { clientId, person: x.person, state: x.state, at: new Date(x.at).toISOString() } });

export function updatePresence(projectId: string, clientId: string, person: PresencePerson, state: PresenceState, now = Date.now()) {
  let m = byProject.get(projectId);
  if (!m) byProject.set(projectId, (m = new Map()));
  const x = { person, state, at: now };
  m.set(clientId, x);
  emit(projectId, toEvent(clientId, x));
}

export function leavePresence(projectId: string, clientId: string) {
  const m = byProject.get(projectId);
  if (!m?.delete(clientId)) return;
  if (!m.size) byProject.delete(projectId);
  emit(projectId, { type: 'presence_left', data: { clientId } });
}

/** 开流时先补上此刻在线的每个人 */
export const presenceSnapshot = (projectId: string): PresenceEventDto[] => [...(byProject.get(projectId) ?? [])].map(([id, x]) => toEvent(id, x));

export function subscribePresence(projectId: string, fn: Listener): () => void {
  let set = listeners.get(projectId);
  if (!set) listeners.set(projectId, (set = new Set()));
  set.add(fn);
  return () => { set.delete(fn); if (!set.size) listeners.delete(projectId); };
}

/** 清掉过期的（测试直接调，平时每 5 s 一次） */
export function sweepPresence(now = Date.now()) {
  for (const [projectId, m] of byProject) for (const [clientId, x] of m) if (now - x.at > PRESENCE_TTL_MS) leavePresence(projectId, clientId);
}
setInterval(() => sweepPresence(), 5_000).unref();
