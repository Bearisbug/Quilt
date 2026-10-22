import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows } from '../../../apps/api/src/lib/rowDiff.ts';

// 连线与组件引用按内容差量写（v1.29 §16「应用地图」）：没变的行不动，只删消失的、只插新增的，并发插重的多余行顺手删掉
type Link = { from: string; qid: string; to: string | null };
const key = (r: Link) => `${r.from}\n${r.qid}\n${r.to ?? ''}`;
const row = (id: string, from: string, qid: string, to: string | null): Link & { id: string } => ({ id, from, qid, to });

test('内容没变：一行不删、一行不插', () => {
  const existing = [row('1', 'a', 'q1', 'b'), row('2', 'a', 'q2', null)];
  assert.deepEqual(diffRows(existing, [{ from: 'a', qid: 'q2', to: null }, { from: 'a', qid: 'q1', to: 'b' }], key), { drop: [], add: [] });
});

test('改了去向（路由改名）：删旧的那条、插新的那条，其余不动', () => {
  const existing = [row('1', 'a', 'q1', 'b'), row('2', 'a', 'q2', 'c')];
  assert.deepEqual(diffRows(existing, [{ from: 'a', qid: 'q1', to: 'b' }, { from: 'a', qid: 'q2', to: null }], key), { drop: ['2'], add: [{ from: 'a', qid: 'q2', to: null }] });
});

test('同一条重复了：按条数配对，多出来的删掉；算出来就有两条的留两条', () => {
  const existing = [row('1', 'a', 'q1', 'b'), row('2', 'a', 'q1', 'b'), row('3', 'a', 'q1', 'b')];
  assert.deepEqual(diffRows(existing, [{ from: 'a', qid: 'q1', to: 'b' }, { from: 'a', qid: 'q1', to: 'b' }], key), { drop: ['3'], add: [] });
});

test('全删与全新：现有为空时全部插入，算出来为空时全部删掉', () => {
  assert.deepEqual(diffRows([], [{ from: 'a', qid: 'q1', to: 'b' }], key), { drop: [], add: [{ from: 'a', qid: 'q1', to: 'b' }] });
  assert.deepEqual(diffRows([row('1', 'a', 'q1', 'b')], [], key), { drop: ['1'], add: [] });
});
