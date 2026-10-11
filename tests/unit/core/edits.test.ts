import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, parseEditBlocks, editPatchUserPrompt, editUserPrompt, reconcileQids, EDIT_BLOCK } from '@quilt/core';

const block = (find: string, replace: string) => `${EDIT_BLOCK.find}\n${find}\n${EDIT_BLOCK.sep}\n${replace}\n${EDIT_BLOCK.replace}`;

// 改屏的补丁块（ADR-007 v1.05）：块与块之间有空行或说明也认；替换可以为空（= 删掉）；一块都没有时返回 null，按整屏处理
test('parseEditBlocks：多块、空替换、没有补丁块', () => {
  const text = `${block('<h1 data-qid="q2">A</h1>', '<h1 data-qid="q2">B</h1>')}\n\n${block('<p data-qid="q5">x</p>\n<p data-qid="q6">y</p>', '')}`;
  assert.deepEqual(parseEditBlocks(text), [
    { find: '<h1 data-qid="q2">A</h1>', replace: '<h1 data-qid="q2">B</h1>' },
    { find: '<p data-qid="q5">x</p>\n<p data-qid="q6">y</p>', replace: '' },
  ]);
  assert.equal(parseEditBlocks('<div class="min-h-dvh">whole screen</div>'), null);
});

// 套用规则与 quilt.patch_screen 同一个函数：按序套、恰好一处，找不到或多处匹配就报出是哪一块、匹配了几处
test('applyEdits：按序套用；找不到、有歧义整批报错；all=true 全换', () => {
  const body = '<ul><li data-qid="q1">a</li><li data-qid="q2">a</li></ul>';
  assert.deepEqual(applyEdits(body, [{ find: '<li data-qid="q1">a</li>', replace: '<li data-qid="q1">A</li>' }, { find: '>A<', replace: '>AA<' }]),
    { body: '<ul><li data-qid="q1">AA</li><li data-qid="q2">a</li></ul>', errors: [] });
  assert.deepEqual(applyEdits(body, [{ find: 'nope', replace: 'x' }, { find: '>a<', replace: '>b<' }]).errors, [{ index: 0, matches: 0 }, { index: 1, matches: 2 }]);
  assert.equal(applyEdits(body, [{ find: '>a<', replace: '>b<', all: true }]).body, '<ul><li data-qid="q1">b</li><li data-qid="q2">b</li></ul>');
  assert.deepEqual(applyEdits(body, [{ find: '', replace: 'x' }]).errors, [{ index: 0, matches: 0 }]);
});

test('editPatchUserPrompt：要补丁块、FIND 带 data-qid、可回整屏；CURRENT HTML 原样在最后；退回用的整屏提示词不提补丁', () => {
  const p = editPatchUserPrompt('Home', '/home', '<div data-qid="q1">x</div>', '标题改成「你好」', ['此前一条']);
  assert.ok(p.includes(EDIT_BLOCK.find) && p.includes(EDIT_BLOCK.sep) && p.includes(EDIT_BLOCK.replace));
  assert.ok(p.includes('data-qid') && p.includes('complete revised root element HTML instead of blocks') && p.includes('此前一条'));
  assert.ok(p.endsWith('CURRENT HTML:\n<div data-qid="q1">x</div>'));
  assert.ok(!editUserPrompt('Home', '/home', '<div>x</div>', 'y').includes(EDIT_BLOCK.find));
});

// 改屏落库前对齐 qid（ADR-007 v1.05）：补丁里没动的元素保住原号，新元素从现有最大号之后续编
test('补丁套上后 reconcileQids：没改的元素 qid 不变', () => {
  const body = '<div data-qid="q1"><h1 data-qid="q2">A</h1><p data-qid="q3">t</p></div>';
  const { body: patched } = applyEdits(body, [{ find: '<h1 data-qid="q2">A</h1>', replace: '<h1 data-qid="q2">A</h1><span>new</span>' }]);
  assert.equal(reconcileQids(patched), '<div data-qid="q1"><h1 data-qid="q2">A</h1><span data-qid="q4">new</span><p data-qid="q3">t</p></div>');
});
