import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeArrangement, LAYOUT_GAP } from '../../../apps/web/src/canvas/arrange.ts';

const box = (id: string, x: number, y: number, width = 390, height = 844) => ({ id, x, y, width, height });
const at = (r: NonNullable<ReturnType<typeof computeArrangement>>, id: string) => { const p = r.next.get(id)!; return [p.x, p.y]; };

test('少于 2 屏不排；等距少于 3 屏不排', () => {
  assert.equal(computeArrangement('left', [box('a', 0, 0)]), null);
  assert.equal(computeArrangement('hspace', [box('a', 0, 0), box('b', 900, 0)]), null);
  assert.ok(computeArrangement('hrow', [box('a', 0, 0), box('b', 900, 0)]));
});

test('六种对齐按选中集合的外接框算', () => {
  const sel = [box('a', 100, 0), box('b', 300, 50)];
  assert.deepEqual([at(computeArrangement('left', sel)!, 'b'), computeArrangement('left', sel)!.label], [[100, 50], '对齐']);
  assert.deepEqual(at(computeArrangement('right', sel)!, 'a'), [300, 0]);
  assert.deepEqual(at(computeArrangement('hcenter', sel)!, 'a'), [200, 0]);
  assert.deepEqual(at(computeArrangement('top', sel)!, 'b'), [300, 0]);
  assert.deepEqual(at(computeArrangement('bottom', sel)!, 'a'), [100, 50]);
  assert.deepEqual(at(computeArrangement('vcenter', sel)!, 'a'), [100, 25]);
});

test('等距保住首尾两屏，中间按间隙均分', () => {
  const r = computeArrangement('hspace', [box('a', 0, 0), box('b', 500, 0), box('c', 2000, 0)])!;
  assert.equal(r.label, '等距');
  assert.deepEqual([at(r, 'a'), at(r, 'b'), at(r, 'c')], [[0, 0], [1000, 0], [2000, 0]]);
  const v = computeArrangement('vspace', [box('a', 0, 0), box('b', 0, 900), box('c', 0, 3000)])!;
  // 纵向跨度 3844、三屏共 2532 高，两段间隙各 656：b 落在 844 + 656
  assert.deepEqual(at(v, 'b'), [0, 1500]);
});

test('排成一行 / 一列：顺序按当前位置，起点是外接框左上角，间距固定 80', () => {
  const sel = [box('c', 1905, 1600), box('a', 1900, -80), box('b', 1900, 764)];
  const row = computeArrangement('hrow', sel)!;
  assert.equal(row.label, '排列');
  assert.deepEqual([at(row, 'a'), at(row, 'b'), at(row, 'c')], [[1900, -80], [1900 + 390 + LAYOUT_GAP, -80], [1900 + 2 * (390 + LAYOUT_GAP), -80]]);
  const col = computeArrangement('vcol', sel)!;
  assert.deepEqual([at(col, 'a'), at(col, 'b'), at(col, 'c')], [[1900, -80], [1900, 844], [1900, 1768]]);
});
