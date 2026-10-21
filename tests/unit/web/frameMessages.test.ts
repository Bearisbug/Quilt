import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction, toSelection } from '../../../apps/web/src/canvas/frameMessages.ts';

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
