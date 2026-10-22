import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Window, type HTMLElement as HappyElement } from 'happy-dom';
import { RUNTIME_JS, previewMessageSchema, isPreviewMessage, type ParentToPreview } from '@quilt/core';

// 预览运行时（packages/core/src/preview-runtime.js，v1.06）：在 happy-dom 里真跑一遍，运行时发给父页的每条消息都要过 previewMessageSchema——
// 字段名拼错、漏字段在这里就失败，不必等 e2e 里「点了没反应」

test('runtime.ts 由 preview-runtime.js 生成且是最新的', () => {
  const r = spawnSync('node', [path.resolve(import.meta.dirname, '../../../packages/core/scripts/gen-runtime.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// head 里先放一块 token 样式（同真实 prelude）：换屏按它判断设计系统变没变，没有它运行时自己加的滚动条样式会被当成设计系统，每次都整份重写
const HEAD = '<style>:root{--color-primary:59 91 219}</style>';
type KeyInit = ConstructorParameters<Window['KeyboardEvent']>[1];
type WheelInit = ConstructorParameters<Window['WheelEvent']>[1] & { clientX?: number; clientY?: number; ctrlKey?: boolean };
function preview(body: string, opts: { component?: boolean } = {}) {
  const win = new Window({ url: 'http://preview.localhost/p/x', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const sent: unknown[] = [];
  // 消息对象出自 happy-dom 的 VM，原型链与本进程的不是同一个，deepStrictEqual 会判不等：按结构化克隆的样子转一遍再记
  Object.defineProperty(win, 'parent', { configurable: true, value: { postMessage: (m: unknown) => sent.push(JSON.parse(JSON.stringify(m))) } });
  win.document.head.innerHTML = HEAD;
  win.document.body.innerHTML = body;
  if (opts.component) (win as unknown as { __quiltComponent: boolean }).__quiltComponent = true;
  (win as unknown as { eval: (s: string) => void }).eval(RUNTIME_JS);
  win.dispatchEvent(new win.Event('DOMContentLoaded'));
  const $ = (sel: string) => win.document.querySelector(sel) as HappyElement;
  const post = (data: ParentToPreview) => win.dispatchEvent(new win.MessageEvent('message', { data }));
  const key = (init: KeyInit, target = win.document.body) => target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  // happy-dom 的 WheelEvent 不带 MouseEvent 的 clientX / clientY / ctrlKey，补上
  const wheel = (init: WheelInit, target = win.document.body) => {
    const ev = new win.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(ev, { clientX: { value: init.clientX ?? 0 }, clientY: { value: init.clientY ?? 0 }, ctrlKey: { value: !!init.ctrlKey } });
    return target.dispatchEvent(ev);
  };
  return { win, sent, $, post, key, wheel, close: () => win.happyDOM.close() };
}

// 画布标记色（v1.08）：父页取当前外观的 tokens 变量随 quilt:mode 发来，运行时不写颜色。两套取 brand/ 的浅、深色值
const LIGHT = { line: '#C64A0B', onLine: '#FFFFFF', halo: '#FFFFFF', success: '#14713A' };
const DARK = { line: '#E05A24', onLine: '#0E0D0B', halo: '#0E0D0B', success: '#5FD3A4' };

const SCREEN = '<main data-qid="q1"><section data-qid="q2"><a data-qid="q3" href="/next">去下一屏</a><a data-qid="q4" href="#">还没设计</a></section><form action="/done"><input name="n"><button>提交</button></form></main>';

test('屏：就绪、跳转、死链、表单、快捷键、捏合，每条都合协议', async () => {
  const p = preview(SCREEN);
  p.$('a[href="/next"]').click();
  p.$('a[href="#"]').click();
  p.$('form').dispatchEvent(new p.win.Event('submit', { bubbles: true, cancelable: true }));
  p.key({ key: 'Escape', code: 'Escape' });
  p.key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
  p.key({ key: 'k', code: 'KeyK', metaKey: true });
  p.key({ key: 'a', code: 'KeyA' });   // 不是画布快捷键，不转发
  p.wheel({ ctrlKey: true, deltaY: 12, clientX: 30, clientY: 40 });
  p.wheel({ deltaY: 12 });             // 屏里的普通滚轮归屏自己
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  assert.deepEqual(p.sent.map((m) => (m as { type: string }).type), ['quilt:ready', 'quilt:navigate', 'quilt:dead', 'quilt:navigate', 'quilt:key', 'quilt:key', 'quilt:key', 'quilt:wheel']);
  assert.deepEqual(p.sent[3], { type: 'quilt:navigate', href: '/done' });
  await p.close();
});

test('选择元素态：点选、逐级选、重选、取消，select 带祖先路径', async () => {
  const p = preview(SCREEN);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  p.$('[data-qid="q3"]').click();
  p.key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true });   // 上一级
  p.post({ type: 'quilt:reselect', qid: 'q2' });
  p.post({ type: 'quilt:reselect', qid: 'q99' });
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  const [first, climbed, again, gone] = p.sent.slice(1) as Record<string, unknown>[];
  assert.equal(first.qid, 'q3');
  assert.deepEqual(first.path, [{ qid: 'q1', tag: 'main' }, { qid: 'q2', tag: 'section' }, { qid: 'q3', tag: 'a' }]);
  assert.equal(first.href, '/next');
  assert.equal(climbed.qid, 'q2');
  assert.equal(again.qid, 'q2');
  assert.deepEqual(gone, { type: 'quilt:deselect', qid: 'q99' });
  await p.close();
});

// 多选（v1.26）：两个列表项各自到底的链，互不包含
const LIST = '<main data-qid="q1"><ul data-qid="q2"><li data-qid="q3"><span data-qid="q4">一</span></li><li data-qid="q5"><span data-qid="q6">二</span></li></ul></main>';
const boxes = (p: ReturnType<typeof preview>) => Array.from(p.win.document.querySelectorAll('[data-quilt-selection]')).map((b) => `${b.getAttribute('data-qid')}=${b.textContent}`);

test('多选：Shift 点带 additive，父页的 quilt:highlight{ qids } 画全部选中框，逐级选只移动最后点中的那一块', async () => {
  const p = preview(LIST);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  p.$('[data-qid="q4"]').click();
  p.$('[data-qid="q6"]').dispatchEvent(new p.win.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  // 按着 Shift 点的那一块由父页定去留：父页回话之前运行时不动框
  assert.deepEqual(boxes(p), ['q4=span · q4']);
  p.post({ type: 'quilt:highlight', qid: 'q6', qids: ['q4', 'q6'] });
  assert.deepEqual(boxes(p), ['q4=span · q4', 'q6=span · q6']);
  p.key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true });   // 最后点中的 q6 上移到 q5，q4 不动
  assert.deepEqual(boxes(p), ['q4=span · q4', 'q5=li · q5']);
  p.post({ type: 'quilt:climb', dir: 'down' });              // 沿 q6 那条链回到 q6
  p.post({ type: 'quilt:pick', qid: 'q2' });                 // 路径点选同样只换最后那一块
  assert.deepEqual(boxes(p), ['q4=span · q4', 'q2=ul · q2']);
  p.post({ type: 'quilt:highlight', qid: 'q4' });            // 只选一块：不带 qids
  assert.deepEqual(boxes(p), ['q4=span · q4']);
  p.post({ type: 'quilt:highlight', qid: null });
  assert.deepEqual(boxes(p), []);
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  const sel = (p.sent.slice(1) as Record<string, unknown>[]).map(({ qid, additive, replace }) => ({ qid, additive, replace }));
  assert.deepEqual(sel, [
    { qid: 'q4', additive: undefined, replace: undefined },
    { qid: 'q6', additive: true, replace: undefined },
    { qid: 'q5', additive: undefined, replace: 'q6' },
    { qid: 'q6', additive: undefined, replace: 'q5' },
    { qid: 'q2', additive: undefined, replace: 'q6' },
  ]);
  // 逐级选的路径仍到最后点中那一块的锚点
  assert.deepEqual((p.sent[3] as { path: unknown }).path, [{ qid: 'q1', tag: 'main' }, { qid: 'q2', tag: 'ul' }, { qid: 'q5', tag: 'li' }, { qid: 'q6', tag: 'span' }]);
  await p.close();
});

test('多选：热更新后逐块重选（replace 是它自己）、框一块块接回；Shift 按下时不划选文字；检查器悬停已选中的一块照样框出', async () => {
  const p = preview(LIST);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  p.post({ type: 'quilt:swap', html: `<html><head>${HEAD}</head><body>${LIST}</body></html>`, route: '/s1', keepScroll: true });
  p.post({ type: 'quilt:reselect', qid: 'q4' });
  p.post({ type: 'quilt:reselect', qid: 'q6' });
  p.post({ type: 'quilt:reselect', qid: 'q9' });
  assert.deepEqual(boxes(p), ['q4=span · q4', 'q6=span · q6']);
  const replies = p.sent.filter((m) => (m as { type: string }).type !== 'quilt:swapped' && (m as { type: string }).type !== 'quilt:ready') as Record<string, unknown>[];
  assert.deepEqual(replies.map((m) => [m.type, m.qid, m.replace]), [['quilt:select', 'q4', 'q4'], ['quilt:select', 'q6', 'q6'], ['quilt:deselect', 'q9', undefined]]);
  const down = new p.win.MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true });
  p.$('[data-qid="q4"]').dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  const hover = () => Array.from(p.win.document.querySelectorAll<HappyElement>('div[data-quilt-ui]')).find((d) => d.style.borderStyle === 'dashed');
  p.post({ type: 'quilt:highlight', qid: 'q6', qids: ['q4', 'q6'] });
  p.post({ type: 'quilt:peek', qid: 'q4' });
  assert.equal(hover()?.style.display, 'block');
  p.post({ type: 'quilt:highlight', qid: 'q4' });
  p.post({ type: 'quilt:peek', qid: 'q4' });   // 只选一块时悬停它不再叠一层（与 v1.00 一致）
  assert.equal(hover()?.style.display, 'none');
  await p.close();
});

test('标记颜色由父页给：选中框、标签、修改标记用 marks 的颜色，外观切换后当场换色', async () => {
  const p = preview(SCREEN);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  p.$('[data-qid="q3"]').click();
  p.post({ type: 'quilt:mark', working: ['q2'], done: ['q4'] });
  const sel = () => p.$('[data-quilt-selection]');
  const css = (el: HappyElement) => el.getAttribute('style') ?? '';
  assert.match(css(sel()), /border[^;]*#C64A0B/i);
  assert.match(css(sel()), /box-shadow: 0 0 0 1px #FFFFFF,\s*inset 0 0 0 1px #FFFFFF/i);
  assert.match(css(sel().firstElementChild as HappyElement), /background: #C64A0B/i);
  assert.match(css(p.$('[data-qid="q2"]')), /outline-color: #C64A0B; outline-style: dashed/i);
  assert.match(css(p.$('[data-qid="q4"]')), /outline-color: #14713A; outline-style: solid/i);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: DARK });
  assert.match(css(sel()), /border[^;]*#E05A24/i);
  assert.match(css(sel().firstElementChild as HappyElement), /color: #0E0D0B/i);
  assert.match(css(p.$('[data-qid="q2"]')), /outline-color: #E05A24; outline-style: dashed/i);
  assert.match(css(p.$('[data-quilt-mark][data-kind="done"]')), /background: #5FD3A4/i);
  await p.close();
});

test('运行时源码里没有写死的颜色（叠层遮罩那一处除外，它是用户原型的遮罩）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../packages/core/src/preview-runtime.js'), 'utf8');
  const colors = src.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  assert.deepEqual(colors, ['rgba(0,0,0,0.45)']);
});

test('换屏与叠层：swapped 带路由，点遮罩报 overlay-dismiss', async () => {
  const p = preview(SCREEN);
  p.post({ type: 'quilt:swap', html: `<html><head>${HEAD}</head><body><main data-qid="q1">第二屏</main></body></html>`, route: '/next' });
  p.post({ type: 'quilt:overlay', html: '<div data-qid="q1">弹层</div>', route: '/sheet' });
  p.$('[data-quilt-overlay-layer]').click();
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  assert.deepEqual(p.sent.slice(1), [{ type: 'quilt:swapped', route: '/next', title: '' }, { type: 'quilt:overlay-dismiss' }]);
  await p.close();
});

test('组件预览：链接惰性，落在不可滚处的普通滚轮转成 pan', async () => {
  const p = preview('<div data-component="Tab"><a href="/x">去</a></div>', { component: true });
  p.$('a').click();
  p.wheel({ deltaY: 8, deltaX: 2, clientX: 5, clientY: 6 });
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  assert.deepEqual(p.sent.slice(1), [{ type: 'quilt:wheel', pan: true, deltaX: 2, deltaY: 8, x: 5, y: 6 }]);
  await p.close();
});

test('isPreviewMessage：形状不对的 quilt:* 消息一律不认（屏脚本可以伪造）', () => {
  assert.equal(isPreviewMessage({ type: 'quilt:wheel', x: 1, y: 2 }), false);
  assert.equal(isPreviewMessage({ type: 'quilt:wheel', deltaY: Number.NaN, x: 1, y: 2 }), false);
  assert.equal(isPreviewMessage({ type: 'quilt:wheel', deltaY: Infinity, x: 1, y: 2 }), false);
  assert.equal(isPreviewMessage({ type: 'quilt:select', qid: 'q1' }), false);
  assert.equal(isPreviewMessage({ type: 'quilt:whatever' }), false);
  assert.equal(isPreviewMessage(null), false);
  assert.equal(isPreviewMessage({ type: 'quilt:wheel', deltaY: -3, x: 1, y: 2 }), true);
  assert.equal(isPreviewMessage({ type: 'quilt:component-size', componentId: 'c1', x: 0, y: 0, w: 320, h: 64 }), true);
});
