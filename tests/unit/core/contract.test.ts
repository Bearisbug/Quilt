import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConventions, withConventions, estimateJob, type CreateJobInput } from '@quilt/core';

test('parseConventions / withConventions 往返：追加、替换、清空、只吃到下一节', () => {
  const md = '# D\n\nintro\n\n## 组件\n- x\n';
  assert.deepEqual(parseConventions(md), []);
  const w = withConventions(md, ['A', ' B ']);
  assert.ok(w.endsWith('\n## 约定\n- A\n- B\n'), w);
  assert.deepEqual(parseConventions(w), ['A', 'B']);
  const w2 = withConventions(w, ['C']);
  assert.deepEqual(parseConventions(w2), ['C']);
  assert.equal((w2.match(/## 约定/g) ?? []).length, 1);
  assert.equal(withConventions(w2, []), md);
  assert.deepEqual(parseConventions('## 约定\n- one\n\n## 后面\n- not'), ['one']);
});

test('estimateJob：造 / 改 / 局部 / 聊天 / 改组件 / 回刷', () => {
  const job = (j: unknown) => estimateJob(j as CreateJobInput, 10);
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 'auto', versions: 1 } }), { calls: 11, screens: 5 });
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 2, versions: 3 } }), { calls: 13, screens: 6 });
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 1, versions: 1, route: '/x' } }), { calls: 2, screens: 1 });
  assert.deepEqual(job({ kind: 'edit_screens', input: { screenIds: ['a', 'b'], prompt: 'p', versions: 2 } }), { calls: 8, screens: 4 });
  assert.deepEqual(job({ kind: 'regenerate_subtree', input: {} }), { calls: 2, screens: 1 });
  assert.deepEqual(job({ kind: 'chat', input: {} }), { calls: 8, screens: 0 });
  assert.deepEqual(job({ kind: 'edit_component', input: {} }), { calls: 1, screens: 0 });
  assert.deepEqual(job({ kind: 'apply_design_system', input: {} }), { calls: 0, screens: 0 });
});

test('estimateJob：造变体按钉死路由算（1 屏、不占规划）', () => {
  assert.deepEqual(estimateJob({ kind: 'generate', input: { prompt: 'p', count: 'auto', versions: 2, variantOf: 'x', variantName: '空态' } } as unknown as CreateJobInput, 10), { calls: 4, screens: 2 });
});
