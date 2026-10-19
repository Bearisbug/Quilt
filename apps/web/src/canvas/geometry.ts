import { getViewportForBounds, type Viewport } from '@xyflow/system';

// 画布的几何（v1.07 从 CanvasView.tsx 抽出）：镜头怎么摆、哪些卡用原图、框选圈住了谁，都是纯算式，由 tests/unit/web/geometry.test.ts 锁住。
// 坐标系两套：世界坐标（卡片的 x / y，世界层 transform 之前）与视口坐标（相对画布视口左上角的屏幕像素）；镜头 v 把前者映到后者：
// 视口 = 世界 × v.zoom + (v.x, v.y)。可用区（area）是视口坐标里没被浮层遮住的那块
type Rect = { x: number; y: number; w: number; h: number };

// 缩放下限（v0.76）：25 张桌面屏横排约 34000 px，下限取 0.1 的话适配视图有 6 屏整张在视口外。
// 适配视图、画布与屏内捏合、存储镜头校验都用它
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 2;

/** 视口坐标 → 世界坐标 */
export const toWorld = (v: Viewport, sx: number, sy: number) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });

// 卡片截图的档位（v1.02 ADR-029）：缩略图是原图（2 倍屏）的 1/4，即卡片 CSS 宽的一半个像素；
// 缩放 × 像素比 ≤ 0.5 时卡片在屏幕上占的像素不多于它，用缩略图不虚
export const wantsThumb = (zoom: number, dpr: number) => zoom * dpr <= 0.5;

/** 哪些屏用原图：缩放 × 像素比 ≤ 0.5 时一张都不用；大于时只给此刻与视口相交的屏（size = 视口宽高） */
export function fullShotIds(screens: { id: string; x: number; y: number; width: number; height: number }[], v: Viewport, size: { w: number; h: number }, dpr: number): Set<string> {
  if (wantsThumb(v.zoom, dpr)) return new Set();
  const x0 = -v.x / v.zoom; const y0 = -v.y / v.zoom; const x1 = x0 + size.w / v.zoom; const y1 = y0 + size.h / v.zoom;
  return new Set(screens.filter((s) => s.x < x1 && s.x + s.width > x0 && s.y < y1 && s.y + s.height > y0).map((s) => s.id));
}

/** 框选：视口坐标里从 (x0, y0) 拖到 (x1, y1) 的选框，与它相交的那些卡（世界矩形）的 id */
export function inMarquee(items: (Rect & { id: string })[], v: Viewport, box: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const a = toWorld(v, Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
  const b = toWorld(v, Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
  return items.filter((r) => r.x < b.x && a.x < r.x + r.w && r.y < b.y && a.y < r.y + r.h).map((r) => r.id);
}

/** 装下全部卡（含风格指南卡）的镜头；上沿多留 40 给卡片标签。fits = 缩到 MIN_ZOOM 装不装得下 */
export function fitViewport(rects: Rect[], area: Rect): { v: Viewport; fits: boolean } {
  const x0 = Math.min(...rects.map((r) => r.x)); const y0 = Math.min(...rects.map((r) => r.y)) - 40;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)); const y1 = Math.max(...rects.map((r) => r.y + r.h));
  const b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 + 40 };
  const v = getViewportForBounds(b, area.w, area.h, MIN_ZOOM, 1.5, 0.08);
  return { v: { x: v.x + area.x, y: v.y + area.y, zoom: v.zoom }, fits: b.width * v.zoom <= area.w + 1 && b.height * v.zoom <= area.h + 1 };
}

/**
 * 聚焦一屏的镜头（REQ-CORE-005）：缩放不超过 1:1（也是 iframe 内点击坐标不偏的前提）；横向让开左右浮层，纵向只让开顶栏——
 * 底部输入框是浮层，让它压住屏底也不能把整屏缩小（viewportH = 视口高）。纵向落点按可用区（已让开输入框）居中，屏比可用区高时
 * 顶到可用区上沿，把不可避免的遮挡全部留在屏底：居中到整个视口高会把屏往下推，底部 CTA 正好塞进输入框底下点不到（RUN-045 实证）
 */
export function focusViewport(card: Rect, area: Rect, viewportH: number): Viewport {
  const fh = viewportH - area.y;
  const zoom = Math.min(1, (area.w - 40) / card.w, (fh - 80) / card.h);
  const top = Math.max(0, (area.h - card.h * zoom) / 2);
  return { x: area.x + (area.w - card.w * zoom) / 2 - card.x * zoom, y: area.y + top - card.y * zoom, zoom };
}

/** 把一张卡摆到可用区中央（找屏、屏列表，REQ-CORE-024）：缩放取「装得下」与 1:1 的较小者，不低于 0.1 */
export function revealViewport(card: Rect, area: Rect): Viewport {
  const zoom = Math.max(0.1, Math.min(1, (area.w - 80) / card.w, (area.h - 80) / card.h));
  return { x: area.x + (area.w - card.w * zoom) / 2 - card.x * zoom, y: area.y + (area.h - card.h * zoom) / 2 - card.y * zoom, zoom };
}

/** 镜头中心平移到世界坐标 (x, y)，缩放不变（小地图） */
export const panToViewport = (x: number, y: number, zoom: number, area: Rect): Viewport => ({ x: area.x + area.w / 2 - x * zoom, y: area.y + area.h / 2 - y * zoom, zoom });

/** 键盘把焦点移到一张卡上（v0.80）：它完整在可用区里时 null（镜头不动），否则把它的中心平移到可用区中心，缩放不变 */
export function ensureVisibleViewport(card: Rect, v: Viewport, area: Rect): Viewport | null {
  const sx = v.x + card.x * v.zoom; const sy = v.y + card.y * v.zoom;
  if (sx >= area.x && sy >= area.y && sx + card.w * v.zoom <= area.x + area.w && sy + card.h * v.zoom <= area.y + area.h) return null;
  return panToViewport(card.x + card.w / 2, card.y + card.h / 2, v.zoom, area);
}

/** 围绕视口坐标 (px, py) 按滚轮缩放（捏合；系数同 d3-zoom 的 ctrl+wheel），钳在 [MIN_ZOOM, MAX_ZOOM] */
export function zoomAround(v: Viewport, px: number, py: number, deltaY: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.pow(2, -deltaY * 0.02)));
  const k = zoom / v.zoom;
  return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom };
}
