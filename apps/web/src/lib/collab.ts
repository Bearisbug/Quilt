import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { COLLAB_COLORS, presencePersonSchema, type PresenceEventDto, type PresencePerson, type PresenceState } from '@quilt/core/browser';
import { uuid } from '@/lib/uuid';
import { getLocale } from '@/i18n';

// 协作显示（v1.32 REQ-CORE-048，API-CORE-053，ADR-038）：每个浏览器一个协作者身份（名字、颜色、随机 id，记在 localStorage），
// 每个标签页一个 clientId。自己的状态变了就发、每秒至多 15 次，没变化每 5 s 发一次当心跳，关页面或转到后台发 left；
// 别人的状态从项目事件流来。低频的（选中、聚焦、拖动、作业、草稿）变了才通知 React，光标与视野走单独的高频通知，不触发重渲染

export type Person = PresencePerson;
export type Peer = { clientId: string; person: Person; state: PresenceState; at: number };

const ME_KEY = 'quilt:me';
const SEND_MS = 66;
const HEARTBEAT_MS = 5_000;
// 事件流重连后服务端先补发此刻在线的人：这么久还没重新出现的才算离开
const RECONNECT_GRACE_MS = 2_000;

const meListeners = new Set<() => void>();
let meCache: Person | null | undefined;
// 同一浏览器的别的标签页填了或改了名字：这里跟着换
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key !== ME_KEY) return; meCache = undefined; for (const fn of meListeners) fn(); });
function readMe(): Person | null {
  if (meCache !== undefined) return meCache;
  try { const r = presencePersonSchema.safeParse(JSON.parse(localStorage.getItem(ME_KEY) ?? 'null')); meCache = r.success ? r.data : null; } catch { meCache = null; }
  return meCache;
}
export function saveMe(p: Person) {
  meCache = p;
  try { localStorage.setItem(ME_KEY, JSON.stringify(p)); } catch { /* 无痕模式写不了：只本次有效 */ }
  for (const fn of meListeners) fn();
}
/** 这个浏览器的协作者身份；还没填过名字时为 null */
export function useMe(): Person | null {
  return useSyncExternalStore((cb) => { meListeners.add(cb); return () => { meListeners.delete(cb); }; }, readMe);
}
/** 新身份的颜色：在线的人里还没被用的第一个；都用了就按序号轮 */
export function pickColor(taken: number[]): number {
  for (let c = 1; c <= COLLAB_COLORS; c++) if (!taken.includes(c)) return c;
  return (taken.length % COLLAB_COLORS) + 1;
}
export const newPerson = (name: string, color: number): Person => ({ id: uuid(), name: name.trim(), color });
/** 协作者色与压在它上面的字（§13.1，tokens 里的 collab.1–8 与 collab.on） */
export const collabColor = (n: number) => `var(--semantic-color-collab-${n})`;
export const COLLAB_ON = 'var(--semantic-color-collab-on)';

// 低频比较只看会改界面结构的几项；光标与视野不算
const coarseKey = (p: Peer) => JSON.stringify([p.person, p.state.selected, p.state.focus, p.state.drag, p.state.jobs, p.state.draft, p.state.blocks, p.state.following]);

export class Presence {
  readonly clientId = uuid();
  private state: PresenceState = {};
  private peers = new Map<string, Peer>();
  private snapshot: Peer[] = [];
  private coarse = new Set<() => void>();
  private fine = new Set<(p: Peer | null) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private lastSent = 0;
  private stopped = false;
  private stale = new Set<string>();
  private readonly onHide = () => this.leave();
  // 后台标签页的计时器会被压到一分钟一次，比服务端 15 s 的过期时间长：转到后台就离开，回来再发
  private readonly onVisibility = () => { if (document.hidden) this.leave(); else this.send(); };

  constructor(private projectId: string, private me: () => Person | null) {
    this.heartbeat = setInterval(() => this.send(), HEARTBEAT_MS);
    window.addEventListener('pagehide', this.onHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** 改自己的状态：值为 undefined 的项删掉；变了才排一次发送 */
  set(patch: Partial<PresenceState>) {
    const next: PresenceState = { ...this.state, ...patch };
    for (const k of Object.keys(patch) as (keyof PresenceState)[]) if (patch[k] === undefined) delete next[k];
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.send(); }, Math.max(0, this.lastSent + SEND_MS - Date.now()));
  }

  /** 不管状态变没变，马上发一次（改了名字或颜色时） */
  touch() { this.send(); }

  private send() {
    const person = this.me();
    if (this.stopped || !person || document.hidden) return;
    this.lastSent = Date.now();
    void fetch(`/v1/projects/${this.projectId}/presence`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ clientId: this.clientId, person, state: this.state }) }).catch(() => {});
  }

  private leave() {
    if (this.stopped) return;
    void fetch(`/v1/projects/${this.projectId}/presence`, { method: 'POST', keepalive: true, headers: this.headers(), body: JSON.stringify({ clientId: this.clientId, left: true }) }).catch(() => {});
  }

  // 同 lib/api.ts：每个请求带界面语言（REQ-CORE-046）
  private headers() { return { 'Content-Type': 'application/json', 'X-Quilt-Locale': getLocale() }; }

  /** 事件流里的协作事件；自己这个标签页、以及同一个人别的标签页都不算协作者 */
  handle(e: PresenceEventDto) {
    if (e.type === 'presence_left') {
      this.stale.delete(e.data.clientId);
      if (this.peers.delete(e.data.clientId)) this.changed();
      for (const fn of this.fine) fn(null);
      return;
    }
    const { clientId, person, state } = e.data;
    if (clientId === this.clientId || person.id === this.me()?.id) return;
    const prev = this.peers.get(clientId);
    this.stale.delete(clientId);
    const peer = { clientId, person, state, at: Date.now() };
    this.peers.set(clientId, peer);
    if (!prev || coarseKey(prev) !== coarseKey(peer)) this.changed();
    for (const fn of this.fine) fn(peer);
  }

  /** 事件流重连：服务端会重发此刻在线的人，断线期间离开的不会再有 presence_left——宽限一会儿，没重新出现的再删 */
  reset() {
    this.stale = new Set(this.peers.keys());
    if (!this.stale.size) return;
    const mark = this.stale;
    setTimeout(() => {
      if (this.stale !== mark || this.stopped) return;
      let gone = false;
      for (const id of mark) gone = this.peers.delete(id) || gone;
      this.stale = new Set();
      if (gone) { this.changed(); for (const fn of this.fine) fn(null); }
    }, RECONNECT_GRACE_MS);
  }

  private changed() { this.snapshot = [...this.peers.values()]; for (const fn of this.coarse) fn(); }
  readonly subscribe = (fn: () => void) => { this.coarse.add(fn); return () => { this.coarse.delete(fn); }; };
  readonly getPeers = () => this.snapshot;
  /** 高频通知：某个人的光标或视野动了（null = 有人离开） */
  onPeer(fn: (p: Peer | null) => void) { this.fine.add(fn); return () => { this.fine.delete(fn); }; }
  peer(clientId: string) { return this.peers.get(clientId); }

  dispose() {
    this.leave();
    this.stopped = true;
    clearInterval(this.heartbeat);
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener('pagehide', this.onHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

/** 这个项目的协作通道：还没填名字时只收不发（填名字的对话框要知道别人用了哪些颜色）；切项目或卸载时离开 */
export function usePresence(projectId: string | null, me: Person | null) {
  const [presence, setPresence] = useState<Presence | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const p = new Presence(projectId, readMe);
    setPresence(p);
    return () => { p.dispose(); setPresence(null); };
  }, [projectId]);
  // 改了名字或颜色：马上发一次，别人那边跟着换
  useEffect(() => { presence?.touch(); }, [presence, me?.name, me?.color]);
  const empty = useMemo(() => () => () => {}, []);
  const peers = useSyncExternalStore(presence?.subscribe ?? empty, presence?.getPeers ?? (() => NONE));
  return { presence, peers };
}
const NONE: Peer[] = [];

/** 同一个人开着几个标签页时，头像只算一个：按 person.id 去重，留最近更新的那个标签页 */
export function distinctPeople(peers: Peer[]): Peer[] {
  const m = new Map<string, Peer>();
  for (const p of peers) { const prev = m.get(p.person.id); if (!prev || prev.at < p.at) m.set(p.person.id, p); }
  return [...m.values()];
}

// ---- 跟随（PAGE-CANVAS「协作者」）：每个人的状态里带着自己在跟随谁（following），据此处理链式跟随与跟随连成一圈 ----
export type Follow = { id: string; since: number };

/**
 * 跟随链：从 targetId 顺着各人的 following 往下走，到不再跟随别人的那个人（领头人）为止；下一个人不在线就停在当前这个。
 * 走回自己或走进别人的圈时 loop = true：圈解开之前不跟镜头
 */
export function followLeader(people: Peer[], meId: string, targetId: string): { leader: Peer | null; loop: boolean } {
  const by = new Map(people.map((p) => [p.person.id, p]));
  let cur = by.get(targetId);
  if (!cur) return { leader: null, loop: false };
  const seen = new Set([meId, targetId]);
  for (;;) {
    const next: string | undefined = cur.state.following?.id;
    if (!next) return { leader: cur, loop: false };
    if (seen.has(next)) return { leader: cur, loop: true };
    const n = by.get(next);
    if (!n) return { leader: cur, loop: false };
    seen.add(next); cur = n;
  }
}

/**
 * 跟随连成一圈、而且圈里有自己时，该不该由自己停下：圈里最后开始跟随的人（since 最大，相同时 person.id 大的）留下，
 * 跟随他的那个人停下。各端拿同一份在线状态算，结论一致；不含自己的圈由圈里的人自己处理
 */
export function shouldYield(people: Peer[], meId: string, mine: Follow): boolean {
  const by = new Map(people.map((p) => [p.person.id, p]));
  const members: Follow[] = [{ id: meId, since: mine.since }];
  const seen = new Set([meId]);
  let id = mine.id;
  while (id !== meId) {
    const f = by.get(id)?.state.following;
    if (!f || seen.has(id)) return false;
    seen.add(id); members.push({ id, since: f.since }); id = f.id;
  }
  const newest = members.reduce((a, b) => (b.since > a.since || (b.since === a.since && b.id > a.id) ? b : a));
  return newest.id === mine.id;
}

/** 画布与草稿本共用的跟随状态：发出去、跟随的人离开或圈里该自己让时停下并说一声；leader 是该跟着看的人（圈没解开时为 null） */
export function useFollow(presence: Presence | null, peers: Peer[], me: Person | null, notify: { left: (name: string) => void; yielded: (name: string) => void }) {
  const [following, setFollowing] = useState<Follow | null>(null);
  const people = useMemo(() => distinctPeople(peers), [peers]);
  const name = useRef('');
  const notifyRef = useRef(notify); notifyRef.current = notify;
  useEffect(() => { presence?.set({ following: following ?? undefined }); }, [presence, following]);
  useEffect(() => {
    if (!following) return;
    if (!peers.some((x) => x.person.id === following.id)) { setFollowing(null); notifyRef.current.left(name.current); return; }
    if (me && shouldYield(people, me.id, following)) { setFollowing(null); notifyRef.current.yielded(name.current); }
  }, [peers, people, following, me]);
  const toggle = useCallback((personId: string) => {
    name.current = peers.find((x) => x.person.id === personId)?.person.name ?? '';
    setFollowing((cur) => (cur?.id === personId ? null : { id: personId, since: Date.now() }));
  }, [peers]);
  const stop = useCallback(() => setFollowing(null), []);
  const chain = following ? followLeader(people, me?.id ?? '', following.id) : null;
  return {
    following: following?.id ?? null,
    target: chain ? people.find((x) => x.person.id === following!.id) ?? null : null,
    leader: chain && !chain.loop ? chain.leader : null,
    toggle, stop,
  };
}
