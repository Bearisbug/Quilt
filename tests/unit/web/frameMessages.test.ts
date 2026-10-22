import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySelect, keyAction, toSelection, type SelectMessage } from '../../../apps/web/src/canvas/frameMessages.ts';

// 两类 iframe（聚焦屏、交互态组件卡）转发来的按键与选中（v1.07）
const key = (k: string, o: { code?: string; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => ({ type: 'quilt:key' as const, key: k, code: o.code, altKey: !!o.altKey, metaKey: o.metaKey, ctrlKey: o.ctrlKey });

test('keyAction：Esc 退出；⌥← 只有屏能后退；⌘ / Ctrl 组合与 ⌥ + 键交给键位表；Delete / Backspace 按 key', () => {
  assert.deepEqual(keyAction(key('Escape', { code: 'Escape' }), true), { kind: 'exit' });
  assert.deepEqual(keyAction(key('Escape', { code: 'Escape' }), false), { kind: 'exit' });
  assert.deepEqual(keyAction(key('ArrowLeft', { code: 'ArrowLeft', altKey: true }), true), { kind: 'back' });
  assert.deepEqual(keyAction(key('ArrowLeft', { code: 'ArrowLeft', altKey: true }), false), { kind: 'shortcut', code: 'ArrowLeft', alt: true });
  assert.deepEqual(keyAction(key('e', { code: 'KeyE', metaKey: true }), true), { kind: 'shortcut', code: 'KeyE' });
  assert.deepEqual(keyAction(key('k', { code: 'KeyK', ctrlKey: true }), false), { kind: 'shortcut', code: 'KeyK' });
  assert.deepEqual(keyAction(key('ñ', { code: 'KeyN', altKey: true }), true), { kind: 'shortcut', code: 'KeyN', alt: true });
  assert.deepEqual(keyAction(key('Backspace', { code: 'Backspace' }), true), { kind: 'shortcut', code: 'Backspace' });
  assert.deepEqual(keyAction(key('Delete', { code: 'Delete' }), false), { kind: 'shortcut', code: 'Delete' });
  assert.equal(keyAction(key('a', { code: 'KeyA' }), true), null);
});

test('toSelection：字段原样搬过去', () => {
  const m = { type: 'quilt:select' as const, qid: 'q3', tag: 'a', text: '去', classes: 'p-2', href: '/next', component: null, path: [{ qid: 'q1', tag: 'main' }, { qid: 'q3', tag: 'a' }] };
  assert.deepEqual(toSelection(m), { qid: 'q3', tag: 'a', text: '去', classes: 'p-2', href: '/next', component: null, path: m.path });
});

// 多选（v1.26 REQ-EDIT-002）：屏根 q1 › ul q2 › 两个 li（q3、q5）各带一个 span（q4、q6），另有 q10..q19 十个并排的 p
const chain = (...qs: string[]) => qs.map((qid) => ({ qid, tag: 't' }));
const PATHS: Record<string, string[]> = { q1: ['q1'], q2: ['q1', 'q2'], q3: ['q1', 'q2', 'q3'], q4: ['q1', 'q2', 'q3', 'q4'], q5: ['q1', 'q2', 'q5'], q6: ['q1', 'q2', 'q5', 'q6'] };
const msg = (qid: string, o: { additive?: boolean; replace?: string } = {}): SelectMessage =>
  ({ type: 'quilt:select', qid, tag: 't', text: qid, classes: '', href: null, component: null, path: chain(...(PATHS[qid] ?? ['q1', qid])), ...o });
const qids = (r: { list: { qid: string }[] }) => r.list.map((s) => s.qid);

test('applySelect：不按 Shift 只选这一个；Shift 点加选、点已选的减选，最后点中的排最后', () => {
  let r = applySelect([], msg('q4'));
  assert.deepEqual([qids(r), r.note], [['q4'], null]);
  r = applySelect(r.list, msg('q6', { additive: true }));
  assert.deepEqual([qids(r), r.note], [['q4', 'q6'], null]);
  r = applySelect(r.list, msg('q4', { additive: true }));
  assert.deepEqual([qids(r), r.note], [['q6'], null]);
  r = applySelect(r.list, msg('q4', { additive: true }));
  r = applySelect(r.list, msg('q5'));
  assert.deepEqual([qids(r), r.note], [['q5'], null]);
});

test('applySelect：互相包含时只留外面那一块并标 merged；满 8 块不再加并标 max', () => {
  const two = applySelect([toSelection(msg('q4'))], msg('q6', { additive: true })).list;
  // 加一块包住已选两块的：两块都并进它
  let r = applySelect(two, msg('q2', { additive: true }));
  assert.deepEqual([qids(r), r.note], [['q2'], 'merged']);
  // 加一块在已选块里面的：外层留着，不加
  r = applySelect(r.list, msg('q6', { additive: true }));
  assert.deepEqual([qids(r), r.note], [['q2'], 'merged']);
  const eight = Array.from({ length: 8 }, (_, i) => toSelection(msg(`q1${i}`)));
  r = applySelect(eight, msg('q18', { additive: true }));
  assert.deepEqual([r.list.length, r.note], [8, 'max']);
  r = applySelect(eight, msg('q10', { additive: true }));
  assert.deepEqual([r.list.length, r.note], [7, null]);
});

test('applySelect：replace 只换那一块（逐级选），换上来的包住别的块时只留外层；重选原地刷新；要换的已不在就不动', () => {
  const two = [toSelection(msg('q4')), toSelection(msg('q6'))];
  let r = applySelect(two, msg('q5', { replace: 'q6' }));
  assert.deepEqual([qids(r), r.note], [['q4', 'q5'], null]);
  r = applySelect(r.list, msg('q2', { replace: 'q5' }));
  assert.deepEqual([qids(r), r.note], [['q2'], 'merged']);
  r = applySelect(two, { ...msg('q4', { replace: 'q4' }), text: '新' });
  assert.deepEqual([qids(r), r.list[0].text, r.note], [['q4', 'q6'], '新', null]);
  r = applySelect(two, msg('q3', { replace: 'q9' }));
  assert.equal(r.list, two);
});
