import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEdges, focusWires, cubicBezier, cssMs, drawWires, type Box } from '../../../apps/web/src/canvas/edges.ts';

const link = (from: string, to: string | null) => ({ fromScreenId: from, toScreenId: to, qid: 'q1', href: '/x' }) as Parameters<typeof mergeEdges>[0][number];
const boxes: Record<string, Box> = { a: { x: 0, y: 0, w: 390, h: 844 }, b: { x: 1000, y: 0, w: 390, h: 844 }, c: { x: -2000, y: 0, w: 390, h: 100 }, d: { x: 1000, y: 2000, w: 390, h: 844 } };
const boxOf = (id: string) => boxes[id];

test('同一对屏合并计数；断链与自环不画', () => {
  const e = mergeEdges([link('a', 'b'), link('a', 'b'), link('a', 'b'), link('b', 'a'), link('a', null), link('a', 'a')]);
  assert.deepEqual(e, [{ from: 'a', to: 'b', count: 3 }, { from: 'b', to: 'a', count: 1 }]);
});

test('只画正显示的那一屏进出的；它那一端接在聚焦卡上；另一端也是聚焦卡的不画', () => {
  const all = mergeEdges([link('a', 'b'), link('b', 'a'), link('c', 'a'), link('b', 'd'), link('c', 'd')]);
  // 聚焦 a、显示 a：a→b、b→a、c→a 三条；c→d、b→d 与 a 无关
  assert.deepEqual(focusWires(all, 'a', 'a', boxOf).map((w) => [w.x1, w.x2]), [[390, 1000], [1000, 390], [-1610, 0]]);
  // 聚焦 a、屏内跳到 b：b→d 从聚焦卡 a 的位置画出去；a→b、b→a 的另一端是聚焦卡自己，不画
  const fromB = focusWires(all, 'b', 'a', boxOf);
  assert.equal(fromB.length, 1);
  assert.deepEqual([fromB[0].x1, fromB[0].y1, fromB[0].x2, fromB[0].y2], [390, 120, 1000, 2120]);
});

test('几何：侧边出发、高卡取上 240 的中点、双向错开 36、dir 指向终点卡；控制点偏移 = max(60, 水平距离的一半)', () => {
  const all = mergeEdges([link('a', 'b'), link('b', 'a'), link('a', 'c')]);
  const [ab, ba, ac] = focusWires(all, 'a', 'a', boxOf);
  const off = 'a' < 'b' ? -36 : 36;
  assert.deepEqual([ab.x1, ab.y1, ab.x2, ab.y2, ab.dir], [390, 120 + off, 1000, 120 + off, 1]);
  assert.deepEqual([ba.x1, ba.x2, ba.dir, ba.y1], [1000, 390, -1, 156]);
  assert.deepEqual([ac.x1, ac.x2, ac.y2, ac.dir], [0, -1610, 50, -1]);
  assert.equal(ab.c1x, 390 + 305); assert.equal(ab.c2x, 1000 - 305);
});

test('颜色按另一端的屏在画布上的阅读顺序取，往返两条同色', () => {
  const all = mergeEdges([link('a', 'd'), link('a', 'b'), link('b', 'a'), link('c', 'a')]);
  const w = focusWires(all, 'a', 'a', boxOf);
  const color = (pick: (k: (typeof w)[number]) => boolean) => w.find(pick)!.color;
  // 阅读顺序（y 再 x）：c(-2000, 0)、b(1000, 0)、d(1000, 2000)
  assert.equal(color((k) => k.x1 === -1610), 0, 'c → a');
  assert.equal(color((k) => k.x1 === 390 && k.y2 < 200), 1, 'a → b');
  assert.equal(color((k) => k.x1 === 1000), 1, 'b → a 与 a → b 同色');
  assert.equal(color((k) => k.y2 > 2000), 2, 'a → d');
});

test('cssMs：毫秒与秒两种写法都认（构建压缩把 320ms 写成 .32s），读不出给缺省', () => {
  assert.equal(cssMs('320ms', 1), 320); assert.equal(cssMs('.32s', 1), 320); assert.equal(cssMs(' 0.2s ', 1), 200); assert.equal(cssMs('', 320), 320);
});

test('cubicBezier 与 CSS 的曲线一致：端点 0 与 1，标准缓动前快后慢', () => {
  const ease = cubicBezier(0.22, 1, 0.36, 1);
  assert.equal(ease(0), 0); assert.equal(ease(1), 1);
  assert.ok(ease(0.25) > 0.6 && ease(0.5) > 0.9, `${ease(0.25)} ${ease(0.5)}`);
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1)(0.3) - 0.3) < 1e-4);
});

test('画一帧：视口外的跳过；长到之前不画终点端口，长到之后画终点端口与波纹', () => {
  const calls: string[] = [];
  const g = new Proxy({ canvas: { width: 100, height: 100 } } as unknown as CanvasRenderingContext2D, {
    get: (t, k) => (k in t ? (t as unknown as Record<string, unknown>)[k as string] : (...a: unknown[]) => { calls.push(`${String(k)}(${a.slice(0, 2).join(',')})`); }),
    set: () => true,
  });
  const wires = focusWires(mergeEdges([link('a', 'b')]), 'a', 'a', boxOf);
  const view = { x: 0, y: 0, zoom: 1 }; const size = { w: 1440, h: 900 };
  drawWires(g, wires, view, size, 2, ['#0C7CF4'], { grow: 0.5, ripple: 0 });
  assert.ok(calls.includes('stroke()'), calls.join(' '));
  assert.ok(calls.some((c) => c.startsWith('arc(390,')) && !calls.some((c) => c.startsWith('arc(1000,')), `长到一半：只有起点端口 ${calls.join(' ')}`);
  calls.length = 0;
  drawWires(g, wires, view, size, 2, ['#0C7CF4'], { grow: 1, ripple: 0.5 });
  assert.equal(calls.filter((c) => c.startsWith('arc(1000,')).length, 3, `长到之后：终点端口、细环、波纹 ${calls.join(' ')}`);
  calls.length = 0;
  drawWires(g, wires, { x: 0, y: -5000, zoom: 1 }, size, 2, ['#0C7CF4'], { grow: 1, ripple: 1 });
  assert.ok(!calls.includes('stroke()'), calls.join(' '));
});
