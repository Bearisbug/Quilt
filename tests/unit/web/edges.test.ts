import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_LIMIT, mergeEdges, shownEdges, edgeCurves, drawEdges, type Box } from '../../../apps/web/src/canvas/edges.ts';

const link = (from: string, to: string | null) => ({ fromScreenId: from, toScreenId: to, qid: 'q1', href: '/x' }) as Parameters<typeof mergeEdges>[0][number];
const boxes: Record<string, Box> = { a: { x: 0, y: 0, w: 390, h: 844 }, b: { x: 1000, y: 0, w: 390, h: 844 }, c: { x: -2000, y: 0, w: 390, h: 100 } };

test('同一对屏合并计数；断链与自环不画', () => {
  const e = mergeEdges([link('a', 'b'), link('a', 'b'), link('a', 'b'), link('b', 'a'), link('a', null), link('a', 'a')]);
  assert.deepEqual(e, [{ from: 'a', to: 'b', count: 3 }, { from: 'b', to: 'a', count: 1 }]);
});

test(`不超过 ${EDGE_LIMIT} 条全画；超过时只画选中屏进出的`, () => {
  const many = Array.from({ length: EDGE_LIMIT + 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, count: 1 }));
  assert.equal(shownEdges(many.slice(0, EDGE_LIMIT), new Set()).length, EDGE_LIMIT);
  assert.equal(shownEdges(many, new Set()).length, 0);
  assert.deepEqual(shownEdges(many, new Set(['s5'])).map((e) => `${e.from}>${e.to}`), ['s4>s5', 's5>s6']);
});

test('几何与 SVG 时一致：侧边出发、高卡取上 240 的中点、双向错开 36、箭头朝目标', () => {
  const all = [{ from: 'a', to: 'b', count: 2 }, { from: 'b', to: 'a', count: 1 }, { from: 'a', to: 'c', count: 1 }];
  const [ab, ba, ac] = edgeCurves(all, all, (id) => boxes[id]);
  assert.deepEqual([ab.x1, ab.y1, ab.x2, ab.y2, ab.dir], [390, 120 + ('a' < 'b' ? -36 : 36), 1000, 120 + ('a' < 'b' ? -36 : 36), 1]);
  assert.deepEqual([ba.x1, ba.x2, ba.dir, ba.y1], [1000, 390, -1, 156]);
  // a → c：c 在左边，从 a 的左侧出发到 c 的右侧；c 只有 100 高，取它自己的中点
  assert.deepEqual([ac.x1, ac.x2, ac.y2, ac.dir], [0, -1610, 50, -1]);
  // 控制点水平偏移 = max(60, 水平距离的一半)
  assert.equal(ab.c1x, 390 + 305); assert.equal(ab.c2x, 1000 - 305);
  assert.ok(ab.minX <= 390 && ab.maxX >= 1000);
});

test('只画包围框落在视口里的曲线；全部在外时不设变换不描边', () => {
  const calls: string[] = [];
  const g = new Proxy({ canvas: { width: 100, height: 100 } } as unknown as CanvasRenderingContext2D, {
    get: (t, k) => (k in t ? (t as unknown as Record<string, unknown>)[k as string] : (...a: unknown[]) => { calls.push(`${String(k)}(${a.slice(0, 2).join(',')})`); }),
    set: () => true,
  });
  const all = [{ from: 'a', to: 'b', count: 2 }];
  const curves = edgeCurves(all, all, (id) => boxes[id]);
  const colors = { line: '#000', badge: '#000', badgeText: '#fff', font: 'sans-serif' };
  drawEdges(g, curves, { x: 0, y: 0, zoom: 1 }, { w: 1440, h: 900 }, 2, colors);
  assert.ok(calls.includes('stroke()') && calls.some((c) => c.startsWith('fillText(2')), calls.join(' '));
  calls.length = 0;
  drawEdges(g, curves, { x: 0, y: -5000, zoom: 1 }, { w: 1440, h: 900 }, 2, colors);
  assert.ok(!calls.includes('stroke()'), calls.join(' '));
});
