import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

// 小地图（REQ-CORE-024 v0.61）：按全部卡片的外接框等比缩放，画屏（实心）、组件（描边）、风格指南卡（虚线）与当前视口框。
// 视图变换每帧都在变，所以不经父组件 props 走：自己订阅 CanvasView 的视图流、rAF 合帧后只重画这一块。
// 画在 <canvas> 上而不是 SVG：SVG 每帧改一次，Chrome 就要把整页（上百张卡片）重新分层，100 屏时平移掉帧；canvas 内容更新不牵动分层。
export type MiniRect = { id: string; kind: 'screen' | 'component' | 'guide'; x: number; y: number; w: number; h: number };
export type ViewInfo = { x: number; y: number; zoom: number; w: number; h: number };

const W = 176; const H = 112; const PAD = 8;

type Box = { x0: number; y0: number; scale: number; ox: number; oy: number };
type Rect = { x: number; y: number; w: number; h: number };

// 视口在世界坐标里的框：世界层 transform 是 translate(x, y) scale(zoom)，屏幕点 (0,0) 对应世界 (−x/zoom, −y/zoom)
const worldView = (v: ViewInfo): Rect => ({ x: -v.x / v.zoom, y: -v.y / v.zoom, w: v.w / v.zoom, h: v.h / v.zoom });
function boxOf(rects: Rect[]): Box {
  if (!rects.length) return { x0: 0, y0: 0, scale: 1, ox: 0, oy: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const scale = Math.min((W - 2 * PAD) / Math.max(1, x1 - x0), (H - 2 * PAD) / Math.max(1, y1 - y0));
  // 短边居中
  return { x0, y0, scale, ox: (W - 2 * PAD - (x1 - x0) * scale) / 2, oy: (H - 2 * PAD - (y1 - y0) * scale) / 2 };
}
const toMini = (b: Box, x: number, y: number) => [PAD + b.ox + (x - b.x0) * b.scale, PAD + b.oy + (y - b.y0) * b.scale] as const;
// 冻结的外接框装不下视口时只向外扩到刚好装下（v0.83）：这一幅小地图（含内边距）对应的世界矩形并上视口，按小地图宽高等比放进去、居中。
// 视口框刚碰到边时扩出来的正是原来那一幅，之后随镜头连续变化，不跳
function grow(b: Box, v: ViewInfo): Box {
  const mx = b.x0 - (PAD + b.ox) / b.scale; const my = b.y0 - (PAD + b.oy) / b.scale;
  const r = worldView(v);
  const x0 = Math.min(mx, r.x); const y0 = Math.min(my, r.y);
  const x1 = Math.max(mx + W / b.scale, r.x + r.w); const y1 = Math.max(my + H / b.scale, r.y + r.h);
  if (x0 === mx && y0 === my && x1 === mx + W / b.scale && y1 === my + H / b.scale) return b;
  const scale = Math.min(W / (x1 - x0), H / (y1 - y0));
  return { x0, y0, scale, ox: (W - (x1 - x0) * scale) / 2 - PAD, oy: (H - (y1 - y0) * scale) / 2 - PAD };
}

export function Minimap({ rects, onView, onPanTo, onMoveView }: {
  rects: MiniRect[]; onView: (cb: (v: ViewInfo) => void) => () => void;
  onPanTo: (x: number, y: number) => void; onMoveView: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<ViewInfo | null>(null);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;
  // 拖视口框期间外接框冻结：它把视口框也算在内，视口一移出内容区外接框就跟着变大、比例跟着变，
  // 按实时外接框换算的话同一个指针位置对应的世界坐标一直在漂，镜头会自己越跑越远。
  // 松手之后也一直用冻结的那幅（v0.83）：之后的平移缩放只在视口框要出小地图时让它向外扩到刚好装下（grow）——一有镜头变化就按新视口重算的话，
  // 那一下整幅重新缩放、框跳 11–14 px。卡片变了（新屏落地、卡片挪动）才按新内容重算，
  // 不重算的话冻结的外接框装不下它，画出小地图外
  const drag = useRef<{ mx: number; my: number; vx: number; vy: number; zoom: number } | null>(null);
  const frozen = useRef<Box | null>(null);
  const box = useCallback(() => frozen.current ?? boxOf(view.current ? [...rectsRef.current, worldView(view.current)] : rectsRef.current), []);

  const draw = useCallback(() => {
    const el = ref.current; const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== W * dpr) { el.width = W * dpr; el.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(el);
    const fg = css.getPropertyValue('--color-fg').trim(); const accent = css.getPropertyValue('--color-accent').trim();
    const b = box();
    ctx.lineWidth = 1;
    for (const r of rectsRef.current) {
      const [x, y] = toMini(b, r.x, r.y); const w = Math.max(2, r.w * b.scale); const h = Math.max(2, r.h * b.scale);
      if (r.kind === 'screen') { ctx.globalAlpha = 0.55; ctx.fillStyle = fg; ctx.fillRect(x, y, w, h); }
      else { ctx.globalAlpha = r.kind === 'guide' ? 0.35 : 0.55; ctx.strokeStyle = fg; ctx.setLineDash(r.kind === 'guide' ? [2, 2] : []); ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
    }
    ctx.setLineDash([]);
    const v = view.current;
    if (v) {
      const wv = worldView(v); const [x, y] = toMini(b, wv.x, wv.y); const w = Math.max(4, wv.w * b.scale); const h = Math.max(4, wv.h * b.scale);
      ctx.globalAlpha = 0.12; ctx.fillStyle = accent; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = accent; ctx.strokeRect(x, y, w, h);
      // 给 e2e 读视口框位置（小地图坐标）：canvas 里的图形没有 DOM 可查
      el.dataset.view = [x, y, w, h].map((n) => n.toFixed(1)).join(' ');
    }
    ctx.globalAlpha = 1;
  }, [box]);

  useEffect(() => {
    let raf = 0;
    const off = onView((v) => { if (!drag.current && frozen.current) frozen.current = grow(frozen.current, v); view.current = v; if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [onView, draw]);
  // 按卡片的几何判断「变了」：每次重取项目详情 rects 都是新数组，按引用判的话一次与卡片无关的重取（截图就绪、签名续取）也会让外接框重算、框跳一下
  const rectsKey = rects.map((r) => `${r.id}:${r.x},${r.y},${r.w},${r.h}`).join('|');
  useEffect(() => { if (!drag.current) frozen.current = null; draw(); }, [rectsKey, draw]);

  const at = (e: ReactPointerEvent<HTMLCanvasElement>) => { const r = ref.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  // 点空白处镜头平移到那一点（缩放不变）；按在视口框上是抓住它拖：从抓住的那一点起按位移 1:1 平移，框不跳到指针下（MOTION-017）。
  // 指针事件截在这里，不让画布把它当成框选 / 平移
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation(); e.preventDefault();
    const [mx, my] = at(e);
    const v = view.current; if (!v) return;
    const b = box(); const wv = worldView(v);
    const [fx, fy] = toMini(b, wv.x, wv.y);
    const inFrame = mx >= fx && mx <= fx + wv.w * b.scale && my >= fy && my <= fy + wv.h * b.scale;
    if (!inFrame) { onPanTo(b.x0 + (mx - PAD - b.ox) / b.scale, b.y0 + (my - PAD - b.oy) / b.scale); return; }
    ref.current?.setPointerCapture(e.pointerId);
    // 拖动期间画布里的 iframe 不接指针（v0.80）：指针移出小地图、经过候选格的活 iframe 时照样跟手（见 CanvasView 框选）
    ref.current?.closest('.viewport')?.toggleAttribute('data-pointer-drag', true);
    frozen.current = b;
    drag.current = { mx, my, vx: v.x, vy: v.y, zoom: v.zoom };
  };
  const endDrag = () => { drag.current = null; ref.current?.closest('.viewport')?.toggleAttribute('data-pointer-drag', false); draw(); };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    // 指针在视口框上是抓手、在空白处是十字：抓得住的地方要看得出来
    if (!d) { const v = view.current; if (v && ref.current) { const [mx, my] = at(e); const b = box(); const wv = worldView(v); const [fx, fy] = toMini(b, wv.x, wv.y); ref.current.style.cursor = mx >= fx && mx <= fx + wv.w * b.scale && my >= fy && my <= fy + wv.h * b.scale ? 'grab' : ''; } return; }
    // 松开发生在捕获丢失的地方时收不到 pointerup：没按键就当拖完了（MOTION-028）
    if (e.buttons === 0) { endDrag(); return; }
    const [mx, my] = at(e);
    const b = box(); const v = view.current!;
    // 视口框限在小地图之内（v0.80）：按冻结的外接框把框的世界矩形夹在小地图四边以内，拖到边上就停
    const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
    const x0 = b.x0 - (PAD + b.ox) / b.scale; const y0 = b.y0 - (PAD + b.oy) / b.scale;
    const wx = clamp(-d.vx / d.zoom + (mx - d.mx) / b.scale, x0, x0 + W / b.scale - v.w / d.zoom);
    const wy = clamp(-d.vy / d.zoom + (my - d.my) / b.scale, y0, y0 + H / b.scale - v.h / d.zoom);
    onMoveView(-wx * d.zoom, -wy * d.zoom);
  };
  const screens = rects.filter((r) => r.kind === 'screen').length;
  return (
    <canvas ref={ref} className="minimap chrome nopan nowheel" style={{ width: W, height: H }} role="img" aria-label={`小地图：${screens} 屏，点击平移画布、拖视口框移动视图`} data-testid="minimap" data-screens={screens}
      onPointerDown={onDown} onPointerMove={onMove}
      onPointerUp={(e) => { if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId); endDrag(); }}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => e.stopPropagation()} />
  );
}
