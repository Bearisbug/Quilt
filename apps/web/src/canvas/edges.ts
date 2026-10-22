import type { LinkDto } from '@quilt/core/browser';

// 页面地图连线（REQ-PROTO-002；v1.02 ADR-029 画在视口里一块等大的 canvas 上；v1.29 只在一屏进入交互时画，PAGE-CANVAS「连线」）。
// 只画聚焦卡里正显示的那一屏进出的线，这一端都接在聚焦卡上。几何按世界坐标：从卡片侧边纵向居中处（高于 240 的卡取上 240 的中点）出发的三次贝塞尔，
// 双向互链上下错开 36；线宽、端口、柔光按屏幕像素，不随缩放变粗变细
type Edge = { from: string; to: string; count: number };
export type Box = { x: number; y: number; w: number; h: number };
/** (x1, y1) 在链接起点那张卡上、(x2, y2) 在终点那张卡上；dir 是终点卡在 x2 的哪一侧；color 是数据可视化色的序号；reach 是 y2 到终点卡上下边缘较近的那段（世界坐标），卡边透光不超出它 */
export type Wire = { x1: number; y1: number; c1x: number; c2x: number; x2: number; y2: number; dir: 1 | -1; color: number; count: number; reach: number; minX: number; minY: number; maxX: number; maxY: number };
/** grow：线从起点长到终点的进度；ripple：长到之后终点波纹的进度。都是 0–1，减弱动态时都给 1 */
export type WireFrame = { grow: number; ripple: number };

/** 同一对屏合并为一条并计数；断链与自环不画 */
export function mergeEdges(links: LinkDto[]): Edge[] {
  const m = new Map<string, Edge>();
  for (const l of links) {
    if (!l.toScreenId || l.toScreenId === l.fromScreenId) continue;
    const k = `${l.fromScreenId}>${l.toScreenId}`;
    const e = m.get(k) ?? { from: l.fromScreenId, to: l.toScreenId, count: 0 };
    e.count += 1; m.set(k, e);
  }
  return Array.from(m.values());
}

/**
 * 正显示的那一屏（shownId）进出的线，它那一端画在聚焦卡（focusedId）上；另一端也是聚焦卡的不画（屏内跳转后，正显示的屏链回卡片自己那一屏时）。
 * 颜色按另一端的屏在画布上的阅读顺序（y 再 x）依次取，同一对屏的往返两条同色
 */
export function focusWires(edges: Edge[], shownId: string, focusedId: string, boxOf: (id: string) => Box | undefined): Wire[] {
  const focus = boxOf(focusedId);
  if (!focus) return [];
  const pairs = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const other = (e: Edge) => (e.from === shownId ? e.to : e.from);
  const kept = edges.filter((e) => (e.from === shownId || e.to === shownId) && other(e) !== focusedId && boxOf(other(e)));
  const order = [...new Set(kept.map(other))].sort((a, b) => { const p = boxOf(a)!; const q = boxOf(b)!; return p.y - q.y || p.x - q.x; });
  return kept.map((e) => {
    const a = e.from === shownId ? focus : boxOf(e.from)!;
    const b = e.to === shownId ? focus : boxOf(e.to)!;
    const offset = pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? -36 : 36) : 0;
    const ltr = a.x + a.w / 2 <= b.x + b.w / 2;
    const x1 = ltr ? a.x + a.w : a.x; const y1 = a.y + Math.min(a.h, 240) / 2 + offset;
    const x2 = ltr ? b.x : b.x + b.w; const y2 = b.y + Math.min(b.h, 240) / 2 + offset;
    const dx = Math.max(60, Math.abs(x2 - x1) / 2) * (ltr ? 1 : -1);
    const c1x = x1 + dx; const c2x = x2 - dx;
    // 包围框按控制点取（曲线一定在控制点的凸包里），外扩端口波纹与卡边透光
    const pad = 80;
    return { x1, y1, c1x, c2x, x2, y2, dir: ltr ? 1 : -1, color: order.indexOf(other(e)), count: e.count, reach: Math.max(0, Math.min(y2 - b.y, b.y + b.h - y2) - 8),
      minX: Math.min(x1, c1x, c2x, x2) - pad, maxX: Math.max(x1, c1x, c2x, x2) + pad, minY: Math.min(y1, y2) - pad, maxY: Math.max(y1, y2) + pad };
  });
}

/** CSS 时长换成毫秒：构建时压缩会把 `320ms` 写成 `.32s`，两种都认；读不出给 fallback */
export function cssMs(v: string, fallback: number): number {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.trim().endsWith('ms') ? n : n * 1000;
}

/** CSS 的 cubic-bezier(x1, y1, x2, y2)：按 x 求 t（二分）再取 y；画布动画的缓动取 brand 的 token，与界面同一条曲线 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0; let hi = 1; let t = x;
    for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; if (at(x1, x2, t) < x) lo = t; else hi = t; }
    return at(y1, y2, t);
  };
}

// 三次贝塞尔在 t 处截断，返回 [0, t] 那一段的四个控制点（de Casteljau）
function head(k: Wire, t: number): [number, number, number, number, number, number, number, number] {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const ax = lerp(k.x1, k.c1x); const ay = k.y1;
  const bx = lerp(k.c1x, k.c2x); const by = lerp(k.y1, k.y2);
  const cx = lerp(k.c2x, k.x2); const cy = k.y2;
  const dx = lerp(ax, bx); const dy = lerp(ay, by);
  const ex = lerp(bx, cx); const ey = lerp(by, cy);
  return [k.x1, k.y1, ax, ay, dx, dy, lerp(dx, ex), lerp(dy, ey)];
}

// 屏幕像素：线宽、端口、终点细环、波纹最大半径、线的柔光、卡边透光的模糊与半长
const PX = { line: 3, port: 5, ring: 9, ripple: 16, glow: 10, edgeGlow: 24, edgeHalf: 48 };

/** 按镜头画一帧：卡边透光在最底下（卡片盖住里面那一半），再画线（先柔光一遍、再实线一遍），最后端口与波纹；包围框不在视口里的跳过 */
export function drawWires(g: CanvasRenderingContext2D, wires: Wire[], view: { x: number; y: number; zoom: number }, size: { w: number; h: number }, dpr: number, series: string[], f: WireFrame) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  const z = view.zoom;
  const vx0 = -view.x / z; const vy0 = -view.y / z; const vx1 = (size.w - view.x) / z; const vy1 = (size.h - view.y) / z;
  const vis = wires.filter((k) => k.maxX >= vx0 && k.minX <= vx1 && k.maxY >= vy0 && k.minY <= vy1);
  if (!vis.length || !series.length) return;
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.x, dpr * view.y);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const u = 1 / z;   // 一个屏幕像素在世界坐标里的长度；shadowBlur 不随变换缩放，按设备像素给
  const color = (k: Wire) => series[k.color % series.length];
  if (f.grow >= 1) {
    // 缩小时透光跟着收：长度不超出终点卡的上下边缘，模糊按倍率缩，否则会从缩小了的卡片上下冒出来
    const shrink = Math.min(1, Math.max(0.3, z));
    for (const k of vis) {
      g.save();
      g.strokeStyle = color(k); g.shadowColor = color(k); g.shadowBlur = PX.edgeGlow * shrink * dpr; g.globalAlpha = 0.45 * Math.min(1, f.ripple * 2); g.lineWidth = 4 * u;
      // 透光的那道线本身压在终点卡里面 4 px，卡片盖住它，只露出往卡外散开的那一半
      const x = k.x2 + k.dir * 4 * u;
      const half = Math.min(PX.edgeHalf * u, k.reach);
      g.beginPath(); g.moveTo(x, k.y2 - half); g.lineTo(x, k.y2 + half); g.stroke();
      g.restore();
    }
  }
  for (const glow of [true, false]) {
    for (const k of vis) {
      const [x0, y0, ax, ay, bx, by, x3, y3] = f.grow >= 1 ? [k.x1, k.y1, k.c1x, k.y1, k.c2x, k.y2, k.x2, k.y2] : head(k, f.grow);
      g.save();
      g.strokeStyle = color(k); g.lineWidth = PX.line * u;
      if (glow) { g.shadowColor = color(k); g.shadowBlur = PX.glow * dpr; g.globalAlpha = 0.5; }
      g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(ax, ay, bx, by, x3, y3); g.stroke();
      g.restore();
    }
  }
  for (const k of vis) {
    g.fillStyle = color(k); g.strokeStyle = color(k);
    g.beginPath(); g.arc(k.x1, k.y1, PX.port * u, 0, Math.PI * 2); g.fill();
    if (f.grow < 1) continue;
    g.beginPath(); g.arc(k.x2, k.y2, PX.port * u, 0, Math.PI * 2); g.fill();
    g.save(); g.lineWidth = 1.5 * u; g.globalAlpha = 0.45;
    g.beginPath(); g.arc(k.x2, k.y2, PX.ring * u, 0, Math.PI * 2); g.stroke();
    g.restore();
    if (f.ripple > 0 && f.ripple < 1) {
      g.save(); g.lineWidth = 2 * u; g.globalAlpha = 0.6 * (1 - f.ripple);
      g.beginPath(); g.arc(k.x2, k.y2, (PX.port + (PX.ripple - PX.port) * f.ripple) * u, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
  }
}
