import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectQids, reconcileQids, extractBody, assembleDocument, replaceSubtree, applyElementOps, describeElement, stripFences } from '@quilt/core';
import { norm } from '../lib.ts';

test('injectQids 按文档顺序从 q1 起编号，重打时覆盖旧号', () => {
  assert.equal(norm(injectQids('<div><a href="/x">A</a><span>B</span></div>')), norm('<div data-qid="q1"><a href="/x" data-qid="q2">A</a><span data-qid="q3">B</span></div>'));
  assert.equal(injectQids('<p data-qid="q9">x</p>'), '<p data-qid="q1">x</p>');
});

test('assembleDocument / extractBody 往返：标题转义，body 两侧空白不累积', () => {
  const doc = assembleDocument('\n<main data-qid="q1">hi</main>\n', '<meta charset="utf-8">', 'A & B <c>');
  assert.ok(doc.includes('<title>A &amp; B &lt;c&gt;</title>'));
  assert.equal(extractBody(doc).trim(), '<main data-qid="q1">hi</main>');
  assert.equal(extractBody(assembleDocument(extractBody(doc), '', 't')), extractBody(doc));
});

test('replaceSubtree：根沿用被换元素的 qid，新子孙从最大 qid 之后编号，兄弟不动', () => {
  const body = '<div data-qid="q1"><p data-qid="q2">old</p><p data-qid="q3">sib</p></div>';
  const r = replaceSubtree(body, 'q2', '<section><b>new</b><i>x</i></section>');
  assert.ok(r);
  assert.deepEqual(r.newQids, ['q4', 'q5']);
  assert.ok(norm(r.body).includes('<section data-qid="q2"><b data-qid="q4">new</b><i data-qid="q5">x</i></section><p data-qid="q3">sib</p>'), r.body);
  assert.equal(replaceSubtree(body, 'q99', '<b></b>'), null);
  assert.equal(replaceSubtree(body, 'q2', 'just text'), null);
});

test('applyElementOps：text / classes / style / link / remove / detach', () => {
  const body = '<nav data-component="TabBar" data-qid="q1"><a href="/home" class="a b" data-qid="q2">Home <span data-qid="q3">·</span></a><button data-qid="q4">Go</button></nav>';
  assert.ok(applyElementOps(body, 'q2', [{ type: 'text', value: 'Start' }])!.includes('>Start<span data-qid="q3">·</span></a>'), '只换直接文本节点，子元素保留');
  const c = applyElementOps(body, 'q2', [{ type: 'classes', value: '  x y ' }, { type: 'style', value: 'color:red' }])!;
  assert.ok(c.includes('class="x y"') && c.includes('style="color:red"'));
  assert.ok(applyElementOps(body, 'q2', [{ type: 'link', value: null }])!.includes('href="#"'), '<a> 不跳转保留 href="#"');
  const b = applyElementOps(body, 'q4', [{ type: 'link', value: '/next' }])!;
  assert.ok(b.includes('data-href="/next"'), '非 a / form 用 data-href');
  assert.ok(!applyElementOps(b, 'q4', [{ type: 'link', value: null }])!.includes('data-href'));
  assert.ok(applyElementOps('<form data-qid="q1"></form>', 'q1', [{ type: 'link', value: '/done' }])!.includes('action="/done"'));
  assert.ok(!applyElementOps(body, 'q4', [{ type: 'remove' }, { type: 'classes', value: 'ignored' }])!.includes('<button'), 'remove 之后的 op 不再执行');
  assert.ok(!applyElementOps(body, 'q3', [{ type: 'detach' }])!.includes('data-component'), 'detach 摘掉所在实例根的 data-component');
  assert.equal(applyElementOps(body, 'q42', [{ type: 'remove' }]), null);
});

test('改文案时联动无障碍名：只在 aria-label / title 与旧文案逐字符相等时改（v0.59）', () => {
  const body = '<label data-qid="q1"><input aria-label="附近" title="附近" data-qid="q2"><span data-qid="q3">附近</span></label><button aria-label="关闭对话框" data-qid="q4">×</button>';
  const out = applyElementOps(body, 'q3', [{ type: 'text', value: '同城' }])!;
  assert.ok(out.includes('aria-label="同城"') && out.includes('title="同城"'), '同一 label 里挂在兄弟节点上的名字跟着改');
  assert.ok(!out.includes('"附近"'));
  assert.ok(applyElementOps(body, 'q4', [{ type: 'text', value: '✕' }])!.includes('aria-label="关闭对话框"'), '原本就不同的 aria-label 一个字都不动');
});

test('describeElement 只取直接文本；stripFences 去掉 ``` 围栏', () => {
  assert.deepEqual(describeElement('<a href="/x" class="c" data-qid="q1">Hi <b data-qid="q2">there</b></a>', 'q1'), { tag: 'a', text: 'Hi', classes: 'c', href: '/x' });
  assert.equal(describeElement('<p data-qid="q1"></p>', 'q2'), null);
  assert.equal(stripFences('```html\n<div></div>\n```'), '<div></div>');
  assert.equal(stripFences('  plain  '), 'plain');
});

test('reconcileQids：保留合法且唯一的旧 qid，新元素与重复号从最大号之后续编（v0.65）', () => {
  const out = norm(reconcileQids('<div data-qid="q1"><p data-qid="q5">a</p><p>new</p><p data-qid="q5">dup</p><i data-qid="x9">bad</i></div>'));
  assert.equal(out, norm('<div data-qid="q1"><p data-qid="q5">a</p><p data-qid="q6">new</p><p data-qid="q7">dup</p><i data-qid="q8">bad</i></div>'));
  assert.equal(norm(reconcileQids('<a>x</a><b>y</b>')), norm('<a data-qid="q1">x</a><b data-qid="q2">y</b>'), '没有 qid 时等同 injectQids');
});
