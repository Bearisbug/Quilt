import { useEffect, useRef } from 'react';
import { COLLAB_ON, collabColor, type Peer, type Presence } from '@/lib/collab';
import { useT } from '@/i18n';
import collabMessages from '@/i18n/locales/collab';

type Rect = { x: number; y: number; w: number; h: number };
const IDLE_MS = 30_000;
const LERP_MS = 100;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// 协作层（v1.32 REQ-CORE-048，PAGE-CANVAS「协作者」）：画在世界层里、全部卡片之上，坐标就是世界坐标，
// 光标、标签与描边宽度按 --canvas-zoom 反算成屏幕像素。描边与标签随低频状态（选中、聚焦、作业）重渲染；
// 光标不走 React：收到位置就记下目标，rAF 在 100 ms 里插值过去，直接改元素的 transform；30 s 没动淡出
export function PresenceLayer({ presence, peers, rectOf, jobTargets, cursorOf }: {
  presence: Presence | null;
  peers: Peer[];
  rectOf: (id: string) => Rect | null;
  /** 一个作业覆盖了哪些屏与组件卡 */
  jobTargets: (jobId: string) => string[];
  /** 把别人发来的光标换成这一层的坐标；画布上原样返回，草稿本里按画框换算。null = 这里不画 */
  cursorOf?: (p: Peer) => { x: number; y: number } | null;
}) {
  const t = useT(collabMessages);
  const els = useRef(new Map<string, HTMLDivElement>());
  const anim = useRef(new Map<string, { from: { x: number; y: number }; to: { x: number; y: number }; t0: number; moved: number }>());
  const frame = useRef(0);
  const cursorRef = useRef(cursorOf); cursorRef.current = cursorOf;
  // 新来的人：第一条位置到的时候他的光标元素还没挂上（低频通知先排一次重渲染），挂上时按他此刻的位置补放一次
  const placeRef = useRef<((p: Peer) => void) | null>(null);

  useEffect(() => {
    if (!presence) return;
    const paint = () => {
      frame.current = 0;
      const now = performance.now(); let again = false;
      for (const [id, a] of anim.current) {
        const el = els.current.get(id);
        if (!el) continue;
        const k = reduced() ? 1 : Math.min(1, (now - a.t0) / LERP_MS);
        if (k < 1) again = true;
        el.style.transform = `translate(${a.from.x + (a.to.x - a.from.x) * k}px, ${a.from.y + (a.to.y - a.from.y) * k}px)`;
        el.dataset.idle = Date.now() - a.moved > IDLE_MS ? 'true' : 'false';
      }
      if (again) frame.current = requestAnimationFrame(paint);
    };
    const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(paint); };
    const place = (p: Peer) => {
      const el = els.current.get(p.clientId);
      const at = (cursorRef.current ?? ((x: Peer) => x.state.cursor ?? null))(p);
      if (!el) return;
      if (!at) { el.hidden = true; anim.current.delete(p.clientId); return; }
      const a = anim.current.get(p.clientId);
      const now = performance.now();
      if (a && el.hidden === false) {
        const k = Math.min(1, (now - a.t0) / LERP_MS);
        const cur = { x: a.from.x + (a.to.x - a.from.x) * k, y: a.from.y + (a.to.y - a.from.y) * k };
        if (cur.x !== at.x || cur.y !== at.y || a.to.x !== at.x || a.to.y !== at.y) anim.current.set(p.clientId, { from: cur, to: at, t0: now, moved: a.to.x !== at.x || a.to.y !== at.y ? Date.now() : a.moved });
      } else anim.current.set(p.clientId, { from: at, to: at, t0: now - LERP_MS, moved: Date.now() });
      el.hidden = false;
      schedule();
    };
    placeRef.current = place;
    for (const p of presence.getPeers()) place(p);
    const off = presence.onPeer((p) => {
      if (p) { place(p); return; }
      for (const id of anim.current.keys()) if (!presence.peer(id)) anim.current.delete(id);
    });
    // 淡出靠这一下：没有新位置时也每 5 s 看一眼谁已经 30 s 没动
    const idle = setInterval(schedule, 5_000);
    return () => { off(); clearInterval(idle); cancelAnimationFrame(frame.current); frame.current = 0; placeRef.current = null; };
  }, [presence]);

  // 每张卡上要挂的协作者标签：正在改 > 聚焦 > 选中，同一个人在同一张卡上只挂一个；描边只给选中的
  const chips = new Map<string, { key: string; text: string; color: number }[]>();
  const outlines: { key: string; r: Rect; color: number }[] = [];
  const add = (id: string, key: string, text: string, color: number) => {
    const list = chips.get(id) ?? [];
    if (!list.some((c) => c.key === key)) list.push({ key, text, color });
    chips.set(id, list);
  };
  for (const p of peers) {
    const { name, color } = p.person; const s = p.state;
    for (const j of s.jobs ?? []) for (const id of jobTargets(j)) add(id, p.clientId, t('card.working', { name }), color);
    if (s.focus) add(s.focus.id, p.clientId, s.focus.mode === 'inspect' ? t('card.inspect', { name }) : t('card.interact', { name, route: s.focus.route ?? '' }).trim(), color);
    for (const id of s.selected ?? []) {
      const r = rectOf(id);
      if (r) outlines.push({ key: `${p.clientId}:${id}`, r, color });
      add(id, p.clientId, name, color);
    }
  }

  return (
    <div className="presence-layer" data-testid="presence-layer" aria-hidden="true">
      {outlines.map((o) => (
        <div key={o.key} className="peer-outline" data-testid="peer-outline" style={{ transform: `translate(${o.r.x}px, ${o.r.y}px)`, width: o.r.w, height: o.r.h, ['--c' as string]: collabColor(o.color) }} />
      ))}
      {[...chips].map(([id, list]) => {
        const r = rectOf(id);
        if (!r) return null;
        return (
          <div key={id} className="peer-chips" data-card={id} style={{ transform: `translate(${r.x + r.w}px, ${r.y}px)` }}>
            <div className="peer-chips-row">
              {list.map((c) => <span key={c.key} className="peer-chip" data-testid="peer-chip" style={{ background: collabColor(c.color), color: COLLAB_ON }}>{c.text}</span>)}
            </div>
          </div>
        );
      })}
      {peers.map((p) => (
        <div key={p.clientId} ref={(el) => {
          if (!el) { els.current.delete(p.clientId); return; }
          els.current.set(p.clientId, el);
          const peer = anim.current.has(p.clientId) ? null : presence?.peer(p.clientId);
          if (peer) placeRef.current?.(peer);
        }} hidden
          className="peer-cursor" data-testid="peer-cursor" data-name={p.person.name} style={{ ['--c' as string]: collabColor(p.person.color) }}>
          <div className="peer-cursor-body">
            <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M1.5 1.5v13.2l3.6-3.4 2.4 5.2 2.4-1.1-2.4-5.1h5z" /></svg>
            <span className="peer-cursor-name" style={{ background: collabColor(p.person.color), color: COLLAB_ON }}>{p.person.name}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
