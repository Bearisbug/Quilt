import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuiltBlocks, quiltBlock, quiltBlocks, subtreeBlockIssues, subtreeBlocksUserPrompt, subtreeBlocksRetryNote, SUBTREE_BLOCKS_HEADER } from '@quilt/core';

// 一次改几块（REQ-EDIT-002 v1.26）：模型每块回一段 <quilt-block qid="…">，按选中的 qids 收
const QIDS = ['q3', 'q7'];
const ok = (r: ReturnType<typeof parseQuiltBlocks>) => { assert.ok('blocks' in r, 'error' in r ? r.error : ''); return r.blocks; };
const err = (r: ReturnType<typeof parseQuiltBlocks>) => { assert.ok('error' in r, '应当对不上'); return r.error; };

test('parseQuiltBlocks：正常——每块一段，块外的说明不管，按 qids 的顺序返回', () => {
  const text = `好的，改成红色：\n${quiltBlock('q7', '<button class="text-red-600">播放</button>')}\n\n${quiltBlock('q3', '<p class="text-red-600">夜航星</p>')}\n完成。`;
  assert.deepEqual(ok(parseQuiltBlocks(text, QIDS)), [
    { qid: 'q3', html: '<p class="text-red-600">夜航星</p>' },
    { qid: 'q7', html: '<button class="text-red-600">播放</button>' },
  ]);
  // 单引号、块头多余空白也认
  assert.equal(ok(parseQuiltBlocks(`<quilt-block  qid='q3' ><p>a</p></quilt-block><quilt-block qid="q7"><p>b</p></quilt-block>`, QIDS))[0].html, '<p>a</p>');
});

test('parseQuiltBlocks：多余块——不在选中里的 qid、同一块回两段都算对不上', () => {
  const extra = err(parseQuiltBlocks(`${quiltBlock('q3', '<p>a</p>')}${quiltBlock('q7', '<p>b</p>')}${quiltBlock('q9', '<p>c</p>')}`, QIDS));
  assert.match(extra, /expected 2 blocks \(q3, q7\), got 3/);
  assert.match(extra, /qid="q9" is not one of the selected elements/);
  assert.match(err(parseQuiltBlocks(`${quiltBlock('q3', '<p>a</p>')}${quiltBlock('q3', '<p>a2</p>')}${quiltBlock('q7', '<p>b</p>')}`, QIDS)), /q3 appears more than once/);
});

test('parseQuiltBlocks：缺块与空块', () => {
  assert.match(err(parseQuiltBlocks(quiltBlock('q3', '<p>a</p>'), QIDS)), /got 1: no block for q7$/);
  assert.match(err(parseQuiltBlocks('<div>整屏</div>', QIDS)), /got 0: no block for q3, q7$/);
  assert.match(err(parseQuiltBlocks(`${quiltBlock('q3', '<p>a</p>')}<quilt-block qid="q7">  </quilt-block>`, QIDS)), /empty block for q7/);
});

test('parseQuiltBlocks：qid 对不上——写错编号时既报多余的那块，也报缺的那块', () => {
  const e = err(parseQuiltBlocks(`${quiltBlock('q3', '<p>a</p>')}<quilt-block qid="7"><p>b</p></quilt-block>`, QIDS));
  assert.match(e, /qid="7" is not one of the selected elements; no block for q7/);
});

test('parseQuiltBlocks：代码围栏——整段包在围栏里、块里再包一层都认', () => {
  const fenced = '```html\n' + `${quiltBlock('q3', '<p>a</p>')}\n${quiltBlock('q7', '<p>b</p>')}` + '\n```';
  assert.deepEqual(ok(parseQuiltBlocks(fenced, QIDS)).map((b) => b.html), ['<p>a</p>', '<p>b</p>']);
  const inner = `<quilt-block qid="q3">\n\`\`\`html\n<p>a</p>\n\`\`\`\n</quilt-block>${quiltBlock('q7', '<p>b</p>')}`;
  assert.deepEqual(ok(parseQuiltBlocks(inner, QIDS)).map((b) => b.html), ['<p>a</p>', '<p>b</p>']);
});

test('subtreeBlockIssues：不在这一版里的块、一块包着另一块（[外, 里]）', () => {
  const body = '<div data-qid="q1"><div data-qid="q2"><p data-qid="q3">a</p><button data-qid="q4">b</button></div><p data-qid="q5">c</p></div>';
  assert.deepEqual(subtreeBlockIssues(body, ['q3', 'q4', 'q5']), { missing: [], nested: [] });
  assert.deepEqual(subtreeBlockIssues(body, ['q3', 'q99']), { missing: ['q99'], nested: [] });
  assert.deepEqual(subtreeBlockIssues(body, ['q4', 'q2', 'q5']), { missing: [], nested: [['q2', 'q4']] });
});

test('subtreeBlocksUserPrompt：列出每块的原 HTML 与 qid、要求按序每块一段；补问的说明点出上次哪里不对', () => {
  const blocks = [{ qid: 'q3', html: '<p>夜航星</p>' }, { qid: 'q7', html: '<button>播放</button>' }];
  const p = subtreeBlocksUserPrompt('Player', '/draft-1', blocks, '都改成红色', ['此前一条']);
  assert.ok(p.includes('都改成红色') && p.includes('此前一条') && p.includes('exactly 2 blocks') && p.includes('(q3, q7)'));
  // 原 HTML 在最后，用回包同一种块写
  const listed = p.split(`\n${SUBTREE_BLOCKS_HEADER}\n`);
  assert.equal(listed.length, 2);
  assert.deepEqual(quiltBlocks(listed[1]), blocks);
  const retry = subtreeBlocksRetryNote(['q3', 'q7'], 'expected 2 blocks (q3, q7), got 1: no block for q7');
  assert.ok(retry.includes('rejected: expected 2 blocks') && retry.includes('no block for q7') && retry.includes('qid q3, q7'));
  assert.deepEqual(quiltBlocks(retry), []);
});
