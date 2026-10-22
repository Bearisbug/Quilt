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
  // 聚焦 a、屏内跳到 b：b→d 从聚焦卡 a 的位置画出去（d 在下方，连 a 的下边到 d 的上边）；a→b、b→a 的另一端是聚焦卡自己，不画
  const fromB = focusWires(all, 'b', 'a', boxOf);
  assert.equal(fromB.length, 1);
  assert.deepEqual([fromB[0].x1, fromB[0].y1, fromB[0].x2, fromB[0].y2, fromB[0].uy], [195, 844, 1195, 2000, 1]);
});

test('几何：左右分得开连侧边、高卡取上 240 的中点、双向错开 36、ux 指向终点卡；控制点偏移 = max(60, 两端距离的一半)', () => {
  const all = mergeEdges([link('a', 'b'), link('b', 'a'), link('a', 'c')]);
  const [ab, ba, ac] = focusWires(all, 'a', 'a', boxOf);
  const off = 'a' < 'b' ? -36 : 36;
  assert.deepEqual([ab.x1, ab.y1, ab.x2, ab.y2, ab.ux, ab.uy], [390, 120 + off, 1000, 120 + off, 1, 0]);
  assert.deepEqual([ba.x1, ba.x2, ba.ux, ba.y1], [1000, 390, -1, 156]);
  assert.deepEqual([ac.x1, ac.x2, ac.y2, ac.ux], [0, -1610, 50, -1]);
  assert.equal(ab.c1x, 390 + 305); assert.equal(ab.c2x, 1000 - 305);
});

test('上下叠着连上下边：从上面那张的下边中点到下面那张的上边中点，控制点沿竖直方向伸出', () => {
  const stacked: Record<string, Box> = { a: { x: 0, y: 0, w: 390, h: 844 }, e: { x: 40, y: 1000, w: 390, h: 844 } };
  const [up, down] = focusWires(mergeEdges([link('e', 'a'), link('a', 'e')]), 'a', 'a', (id) => stacked[id]);
  const off = 'a' < 'e' ? -36 : 36;
  assert.deepEqual([down.x1, down.y1, down.x2, down.y2, down.ux, down.uy], [195 + off, 844, 235 + off, 1000, 0, 1]);
  assert.deepEqual([down.c1y, down.c2y], [844 + 78, 1000 - 78]);
  assert.deepEqual([up.y1, up.y2, up.uy], [1000, 844, -1]);
});

test('方向：正显示的那一屏链出去的 out=true、链进来的 out=false', () => {
  const all = mergeEdges([link('a', 'b'), link('c', 'a')]);
  const w = focusWires(all, 'a', 'a', boxOf);
  assert.deepEqual(w.map((k) => [k.x1, k.out]), [[390, true], [-1610, false]]);
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

test('画一帧：视口外的跳过；画到一半只有线与起点圆点，画完才有箭头；链去与链进来用两种颜色', () => {
  const calls: string[] = [];
  const styles: string[] = [];
  const g = new Proxy({ canvas: { width: 100, height: 100 } } as unknown as CanvasRenderingContext2D, {
    get: (t, k) => (k in t ? (t as unknown as Record<string, unknown>)[k as string] : (...a: unknown[]) => { calls.push(`${String(k)}(${a.slice(0, 2).map((x) => Math.round(Number(x))).join(',')})`); }),
    set: (_t, k, v) => { if (k === 'strokeStyle' || k === 'fillStyle') styles.push(String(v)); return true; },
  });
  const colors = { out: '#0071E3', in: '#68686D', halo: '#FFFFFF' };
  const wires = focusWires(mergeEdges([link('a', 'b'), link('c', 'a')]), 'a', 'a', boxOf);
  // 世界坐标 −1700…1180 都在视口里：两条线都画
  const view = { x: 850, y: 0, zoom: 0.5 }; const size = { w: 1440, h: 900 };
  drawWires(g, wires, view, size, 2, colors, 0.5);
  assert.ok(calls.includes('stroke()') && calls.filter((c) => c.startsWith('arc(')).length === 4, `画到一半：两条线、两颗圆点（各带外圈） ${calls.join(' ')}`);
  assert.ok(!calls.some((c) => c.startsWith('closePath')), '画到一半不该有箭头');
  assert.ok(styles.includes(colors.out) && styles.includes(colors.in) && styles.includes(colors.halo), styles.join(' '));
  calls.length = 0;
  drawWires(g, wires, view, size, 2, colors, 1);
  assert.equal(calls.filter((c) => c.startsWith('closePath')).length, 2, `画完：每条线一个箭头 ${calls.join(' ')}`);
  calls.length = 0;
  drawWires(g, wires, { x: 0, y: -50000, zoom: 1 }, size, 2, colors, 1);
  assert.ok(!calls.includes('stroke()'), calls.join(' '));
});
