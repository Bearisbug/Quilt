import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZOOM, toWorld, wantsThumb, fullShotIds, inMarquee, fitViewport, focusViewport, revealViewport, panToViewport, ensureVisibleViewport, zoomAround } from '../../../apps/web/src/canvas/geometry.ts';

// 画布几何（v1.07）：镜头、截图档位与框选的算式
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('wantsThumb：缩放 × 像素比 ≤ 0.5 用缩略图', () => {
  assert.equal(wantsThumb(0.25, 2), true);
  assert.equal(wantsThumb(0.26, 2), false);
  assert.equal(wantsThumb(0.5, 1), true);
  assert.equal(wantsThumb(1, 1), false);
});

test('fullShotIds：只给与视口相交的屏，缩略图档位时一张都不给', () => {
  const screens = [
    { id: 'in', x: 100, y: 100, width: 390, height: 844 },
    { id: 'edge', x: 1999, y: 0, width: 390, height: 844 },     // 左缘差 1 px 进视口
    { id: 'out', x: 2000, y: 0, width: 390, height: 844 },      // 左缘正好在视口右缘上：不相交
    { id: 'above', x: 0, y: -900, width: 390, height: 844 },
  ];
  const size = { w: 1000, h: 500 };
  // zoom 0.5、平移 0：视口在世界里是 [0, 2000) × [0, 1000)
  assert.deepEqual([...fullShotIds(screens, { x: 0, y: 0, zoom: 0.5 }, size, 2)].sort(), ['edge', 'in']);
  // 平移 (-500, 0) 后视口是 [1000, 3000)：in 出去、out 进来
  assert.deepEqual([...fullShotIds(screens, { x: -500, y: 0, zoom: 0.5 }, size, 2)].sort(), ['edge', 'out']);
  assert.equal(fullShotIds(screens, { x: 0, y: 0, zoom: 0.5 }, size, 1).size, 0);
});

test('toWorld 与 inMarquee：选框按世界坐标求交，反着拖同样算', () => {
  const v = { x: 100, y: 50, zoom: 0.5 };
  assert.deepEqual(toWorld(v, 100, 50), { x: 0, y: 0 });
  assert.deepEqual(toWorld(v, 300, 150), { x: 400, y: 200 });
  const items = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 500, y: 0, w: 100, h: 100 },
    { id: 'c', x: 390, y: 190, w: 10, h: 10 },   // 落在选框右下角里那 10 px：算；选框收一点就不算
  ];
  // 视口 (100,50)-(300,150) = 世界 (0,0)-(400,200)
  assert.deepEqual(inMarquee(items, v, { x0: 100, y0: 50, x1: 300, y1: 150 }), ['a', 'c']);
  assert.deepEqual(inMarquee(items, v, { x0: 300, y0: 150, x1: 100, y1: 50 }), ['a', 'c']);
  assert.deepEqual(inMarquee(items, v, { x0: 100, y0: 50, x1: 290, y1: 140 }), ['a']);
});

test('fitViewport：上下各留 40 给标签，装得下才 fits', () => {
  const area = { x: 20, y: 60, w: 1000, h: 600 };
  const { v, fits } = fitViewport([{ x: 0, y: 0, w: 390, h: 844 }, { x: 500, y: 0, w: 390, h: 844 }], area);
  assert.equal(fits, true);
  // 外框 890 × 924（844 + 上下各 40）：按高定缩放，四周留白后整块在可用区里
  assert.ok(v.zoom > 0 && 924 * v.zoom <= area.h && 890 * v.zoom <= area.w, JSON.stringify(v));
  const left = v.x + 0 * v.zoom; const top = v.y + -40 * v.zoom;
  assert.ok(left >= area.x && top >= area.y && left + 890 * v.zoom <= area.x + area.w && top + 924 * v.zoom <= area.y + area.h, JSON.stringify(v));
  // 缩到下限也装不下
  const wide = fitViewport([{ x: 0, y: 0, w: 1_000_000, h: 100 }], area);
  assert.equal(wide.fits, false);
  assert.equal(wide.v.zoom, MIN_ZOOM);
});

test('focusViewport：不超过 1:1，横向居中，纵向在可用区里居中、屏太高就顶到上沿', () => {
  const area = { x: 100, y: 64, w: 1000, h: 700 };
  // 手机屏 390 × 844、视口高 1000：可用高 936，(936 - 80) / 844 > 1 → 1:1；比可用区（700）高 → 顶到上沿
  const v = focusViewport({ x: 200, y: 300, w: 390, h: 844 }, area, 1000);
  assert.equal(v.zoom, 1);
  near(v.x, 100 + (1000 - 390) / 2 - 200);
  near(v.y, 64 - 300);
  // 视口矮（600）：(536 - 80) / 844 定缩放，纵向居中
  const s = focusViewport({ x: 0, y: 0, w: 390, h: 844 }, area, 600);
  near(s.zoom, 456 / 844);
  near(s.y, 64 + (700 - 844 * s.zoom) / 2);
  // 桌面屏 1440 宽、可用宽 1000：按 (1000 - 40) / 1440 缩
  near(focusViewport({ x: 0, y: 0, w: 1440, h: 900 }, area, 2000).zoom, 960 / 1440);
});

test('revealViewport / panToViewport / ensureVisibleViewport', () => {
  const area = { x: 0, y: 0, w: 1000, h: 800 };
  const r = revealViewport({ x: 1000, y: 2000, w: 390, h: 844 }, area);
  near(r.zoom, (800 - 80) / 844);
  near(r.x + (1000 + 195) * r.zoom, 500);   // 卡片中心落在可用区中心
  near(r.y + (2000 + 422) * r.zoom, 400);
  assert.equal(revealViewport({ x: 0, y: 0, w: 100_000, h: 100 }, area).zoom, 0.1);
  assert.deepEqual(panToViewport(100, 50, 0.5, area), { x: 450, y: 375, zoom: 0.5 });
  const v = { x: 0, y: 0, zoom: 0.5 };
  assert.equal(ensureVisibleViewport({ x: 100, y: 100, w: 390, h: 844 }, v, area), null);   // 完整在里面：不动
  assert.deepEqual(ensureVisibleViewport({ x: 3000, y: 0, w: 400, h: 800 }, v, area), panToViewport(3200, 400, 0.5, area));
});

test('zoomAround：指针下的世界点不动；每个事件按 2^(−deltaY × 0.01)、最多 ±25%；钳在上下限', () => {
  const v = { x: 100, y: 100, zoom: 1 };
  const z = zoomAround(v, 400, 300, -20);
  near(z.zoom, Math.pow(2, 0.2));
  const before = toWorld(v, 400, 300); const after = toWorld(z, 400, 300);
  near(before.x, after.x); near(before.y, after.y);
  near(zoomAround(v, 400, 300, -200).zoom, 1.25);
  near(zoomAround(v, 400, 300, 200).zoom, 0.8);
  assert.equal(zoomAround({ x: 0, y: 0, zoom: 1.9 }, 0, 0, -100).zoom, 2);
  assert.equal(zoomAround({ x: 0, y: 0, zoom: 0.021 }, 0, 0, 100).zoom, MIN_ZOOM);
});
