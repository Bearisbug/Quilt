import type { LinkDto } from '@quilt/core/browser';

// 页面地图连线（REQ-PROTO-002，v1.02 ADR-029）：画在视口里一块等大的 canvas 上，每次镜头变化按当前镜头重画。
// 几何与 SVG 时一致：从卡片侧边纵向居中处（高于 240 的卡取上 240 的中点）出发的三次贝塞尔，双向互链上下错开 36，
// 线宽、箭头、徽标都按世界坐标随缩放变大变小
export type Edge = { from: string; to: string; count: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Curve = { x1: number; y1: number; c1x: number; c2x: number; x2: number; y2: number; mx: number; my: number; dir: 1 | -1; count: number; minX: number; minY: number; maxX: number; maxY: number };
export type EdgeColors = { line: string; badge: string; badgeText: string; font: string };

/** 超过这么多条（同一对屏合并后）只画选中屏进出的（v1.02 Owner 定） */
export const EDGE_LIMIT = 200;
const LINE_WIDTH = 2.5;
// SVG marker：viewBox 10、markerWidth 8、按线宽缩放 → 每个 viewBox 单位 = 8 × 2.5 / 10 = 2 个世界单位；尖在终点前 1 单位、底在后 9 单位
const ARROW_UNIT = (8 * LINE_WIDTH) / 10;

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

/** 超过 EDGE_LIMIT 条时只留选中屏进出的 */
export function shownEdges(edges: Edge[], selected: ReadonlySet<string>): Edge[] {
  return edges.length > EDGE_LIMIT ? edges.filter((e) => selected.has(e.from) || selected.has(e.to)) : edges;
}

export function edgeCurves(edges: Edge[], all: Edge[], boxOf: (id: string) => Box | undefined): Curve[] {
  const pairs = new Set(all.map((e) => `${e.from}>${e.to}`));
  const out: Curve[] = [];
  for (const e of edges) {
    const a = boxOf(e.from); const b = boxOf(e.to);
    if (!a || !b) continue;
    const offset = pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? -36 : 36) : 0;
    const ltr = a.x + a.w / 2 <= b.x + b.w / 2;
    const x1 = ltr ? a.x + a.w : a.x; const y1 = a.y + Math.min(a.h, 240) / 2 + offset;
    const x2 = ltr ? b.x : b.x + b.w; const y2 = b.y + Math.min(b.h, 240) / 2 + offset;
    const dx = Math.max(60, Math.abs(x2 - x1) / 2) * (ltr ? 1 : -1);
    const c1x = x1 + dx; const c2x = x2 - dx;
    // 包围框按控制点取（曲线一定在控制点的凸包里），外扩箭头与徽标的半宽
    const pad = 20;
    out.push({ x1, y1, c1x, c2x, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, dir: ltr ? 1 : -1, count: e.count,
      minX: Math.min(x1, c1x, c2x, x2) - pad, maxX: Math.max(x1, c1x, c2x, x2) + pad, minY: Math.min(y1, y2) - pad, maxY: Math.max(y1, y2) + pad });
  }
  return out;
}

/** 按镜头画一帧：先全部曲线、再箭头、最后徽标（徽标压在所有线上面）；包围框不在视口里的跳过 */
export function drawEdges(g: CanvasRenderingContext2D, curves: Curve[], view: { x: number; y: number; zoom: number }, size: { w: number; h: number }, dpr: number, c: EdgeColors) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  const z = view.zoom;
  // 视口在世界坐标里的范围
  const vx0 = -view.x / z; const vy0 = -view.y / z; const vx1 = (size.w - view.x) / z; const vy1 = (size.h - view.y) / z;
  const vis = curves.filter((k) => k.maxX >= vx0 && k.minX <= vx1 && k.maxY >= vy0 && k.minY <= vy1);
  if (!vis.length) return;
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.x, dpr * view.y);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = LINE_WIDTH;
  g.strokeStyle = c.line; g.globalAlpha = 0.85;
  g.beginPath();
  for (const k of vis) { g.moveTo(k.x1, k.y1); g.bezierCurveTo(k.c1x, k.y1, k.c2x, k.y2, k.x2, k.y2); }
  g.stroke();
  g.globalAlpha = 1; g.fillStyle = c.line;
  g.beginPath();
  for (const k of vis) {
    // 终点处切线是水平的（第二个控制点与终点同高），箭头沿 dir 指向目标卡
    const tip = k.x2 + k.dir * ARROW_UNIT; const base = k.x2 - k.dir * 9 * ARROW_UNIT;
    g.moveTo(tip, k.y2); g.lineTo(base, k.y2 - 5 * ARROW_UNIT); g.lineTo(base, k.y2 + 5 * ARROW_UNIT); g.closePath();
  }
  g.fill();
  g.font = `600 13px ${c.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const k of vis) {
    if (k.mx + 14 < vx0 || k.mx - 14 > vx1 || k.my + 11 < vy0 || k.my - 11 > vy1) continue;
    g.fillStyle = c.badge; g.beginPath(); g.roundRect(k.mx - 14, k.my - 11, 28, 22, 11); g.fill();
    g.fillStyle = c.badgeText; g.fillText(String(k.count), k.mx, k.my + 0.5);
  }
}
