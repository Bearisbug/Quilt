import type { LinkDto } from '@quilt/core/browser';

// 页面地图连线（REQ-PROTO-002；v1.02 ADR-029 画在视口里一块等大的 canvas 上；v1.29 只在一屏进入交互时画，PAGE-CANVAS「连线」）。
// 只画聚焦卡里正显示的那一屏进出的线，这一端都接在聚焦卡上。几何按世界坐标：起止点取两张卡相对的那一侧（左右分得开连侧边、上下叠着连上下边），
// 三次贝塞尔，双向互链错开 36；线宽、圆点、箭头按屏幕像素，不随缩放变粗变细（v1.31 苹果式细线）
type Edge = { from: string; to: string; count: number };
export type Box = { x: number; y: number; w: number; h: number };
/**
 * (x1, y1) 在链接起点那张卡的边上、(x2, y2) 在终点那张卡的边上，(c1x, c1y)、(c2x, c2y) 是两个控制点；
 * (ux, uy) 是离开起点卡、进入终点卡的方向（单位向量，沿着连的那条边的法线）；out 是正显示的那一屏链出去的（否则是链进来的）
 */
export type Wire = { x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number; ux: number; uy: number; out: boolean; count: number; minX: number; minY: number; maxX: number; maxY: number };
/** 链去的线、链进来的线、起点圆点外圈的颜色 */
export type WireColors = { out: string; in: string; halo: string };

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

/** 正显示的那一屏（shownId）进出的线，它那一端画在聚焦卡（focusedId）上；另一端也是聚焦卡的不画（屏内跳转后，正显示的屏链回卡片自己那一屏时） */
export function focusWires(edges: Edge[], shownId: string, focusedId: string, boxOf: (id: string) => Box | undefined): Wire[] {
  const focus = boxOf(focusedId);
  if (!focus) return [];
  const pairs = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const other = (e: Edge) => (e.from === shownId ? e.to : e.from);
  const kept = edges.filter((e) => (e.from === shownId || e.to === shownId) && other(e) !== focusedId && boxOf(other(e)));
  return kept.map((e) => {
    const a = e.from === shownId ? focus : boxOf(e.from)!;
    const b = e.to === shownId ? focus : boxOf(e.to)!;
    const offset = pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? -36 : 36) : 0;
    // 两张卡在 x、y 上的间隙（重叠时为负）：上下有间隙、且不比左右的小，就连上下边；否则连侧边
    const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    let x1: number; let y1: number; let x2: number; let y2: number; let ux = 0; let uy = 0;
    if (gapY > 0 && gapY >= gapX) {
      uy = a.y + a.h / 2 <= b.y + b.h / 2 ? 1 : -1;
      x1 = a.x + a.w / 2 + offset; y1 = uy > 0 ? a.y + a.h : a.y;
      x2 = b.x + b.w / 2 + offset; y2 = uy > 0 ? b.y : b.y + b.h;
    } else {
      // 侧边：纵向取卡片中点，高于 240 的卡取上 240 的中点
      ux = a.x + a.w / 2 <= b.x + b.w / 2 ? 1 : -1;
      x1 = ux > 0 ? a.x + a.w : a.x; y1 = a.y + Math.min(a.h, 240) / 2 + offset;
      x2 = ux > 0 ? b.x : b.x + b.w; y2 = b.y + Math.min(b.h, 240) / 2 + offset;
    }
    // 控制点沿法线伸出两端距离的一半（至少 60），线离开与进入卡片时都垂直于卡边
    const reach = Math.max(60, (ux ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) / 2);
    const c1x = x1 + ux * reach; const c1y = y1 + uy * reach; const c2x = x2 - ux * reach; const c2y = y2 - uy * reach;
    // 包围框按控制点取（曲线一定在控制点的凸包里），外扩圆点与箭头
    const pad = 20;
    return { x1, y1, c1x, c1y, c2x, c2y, x2, y2, ux, uy, out: e.from === shownId, count: e.count,
      minX: Math.min(x1, c1x, c2x, x2) - pad, maxX: Math.max(x1, c1x, c2x, x2) + pad, minY: Math.min(y1, c1y, c2y, y2) - pad, maxY: Math.max(y1, c1y, c2y, y2) + pad };
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
  const ax = lerp(k.x1, k.c1x); const ay = lerp(k.y1, k.c1y);
  const bx = lerp(k.c1x, k.c2x); const by = lerp(k.c1y, k.c2y);
  const cx = lerp(k.c2x, k.x2); const cy = lerp(k.c2y, k.y2);
  const dx = lerp(ax, bx); const dy = lerp(ay, by);
  const ex = lerp(bx, cx); const ey = lerp(by, cy);
  return [k.x1, k.y1, ax, ay, dx, dy, lerp(dx, ex), lerp(dy, ey)];
}

// 屏幕像素：线宽、起点圆点半径与外圈、箭头长与半宽、箭头底部内凹到哪
const PX = { line: 1.5, dot: 3, halo: 1.5, arrow: 9, arrowHalf: 4.5, notch: 6.5 };

/**
 * 按镜头画一帧（v1.31 苹果式细线）：先线，再起点圆点，长到终点再画箭头；t 是画出的进度（已按缓动换算），整体透明度同为 t，减弱动态时给 1。
 * 线压在卡片底下，起点圆点沿法线挪到卡外，箭头尖抵在目标卡边上，都不会被卡片盖住一半；包围框不在视口里的跳过
 */
export function drawWires(g: CanvasRenderingContext2D, wires: Wire[], view: { x: number; y: number; zoom: number }, size: { w: number; h: number }, dpr: number, c: WireColors, t: number) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  const z = view.zoom;
  const vx0 = -view.x / z; const vy0 = -view.y / z; const vx1 = (size.w - view.x) / z; const vy1 = (size.h - view.y) / z;
  const vis = wires.filter((k) => k.maxX >= vx0 && k.minX <= vx1 && k.maxY >= vy0 && k.minY <= vy1);
  if (!vis.length) return;
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.x, dpr * view.y);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.globalAlpha = t;
  const u = 1 / z;   // 一个屏幕像素在世界坐标里的长度
  const color = (k: Wire) => (k.out ? c.out : c.in);
  for (const k of vis) {
    const [x0, y0, ax, ay, bx, by, x3, y3] = t >= 1 ? [k.x1, k.y1, k.c1x, k.c1y, k.c2x, k.c2y, k.x2 - k.ux * PX.notch * u, k.y2 - k.uy * PX.notch * u] : head(k, t);
    g.strokeStyle = color(k); g.lineWidth = PX.line * u;
    g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(ax, ay, bx, by, x3, y3); g.stroke();
  }
  for (const k of vis) {
    // 起点圆点：圆心沿法线挪到卡外一个（半径 + 外圈）的距离，外圈用 halo 色把它和卡边、和别的线分开
    const r = (PX.dot + PX.halo) * u; const cx = k.x1 + k.ux * r; const cy = k.y1 + k.uy * r;
    g.fillStyle = c.halo; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = color(k); g.beginPath(); g.arc(cx, cy, PX.dot * u, 0, Math.PI * 2); g.fill();
    if (t < 1) continue;
    // 箭头：尖在 (x2, y2)、沿法线指进终点卡，底部内凹；终点处切线就是法线（第二个控制点在法线上）
    const bx = k.x2 - k.ux * PX.arrow * u; const by = k.y2 - k.uy * PX.arrow * u;
    const nx = k.x2 - k.ux * PX.notch * u; const ny = k.y2 - k.uy * PX.notch * u;
    const px = -k.uy * PX.arrowHalf * u; const py = k.ux * PX.arrowHalf * u;
    g.beginPath(); g.moveTo(k.x2, k.y2); g.lineTo(bx + px, by + py); g.lineTo(nx, ny); g.lineTo(bx - px, by - py); g.closePath(); g.fill();
  }
  g.globalAlpha = 1;
}
