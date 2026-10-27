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

test('协作显示：指针移动按帧只发最后一个位置，离开文档发 left（v1.32）', async () => {
  const p = preview(SCREEN);
  const move = (x: number, y: number) => p.win.document.body.dispatchEvent(new p.win.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  move(10, 20); move(30, 40);
  await new Promise((r) => setTimeout(r, 60));
  p.win.document.body.dispatchEvent(new p.win.MouseEvent('pointerout', { bubbles: true }));
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  assert.deepEqual(p.sent.filter((m) => (m as { type: string }).type === 'quilt:pointer'), [{ type: 'quilt:pointer', x: 30, y: 40 }, { type: 'quilt:pointer', left: true }]);
  await p.close();
});

test('选元素：指针下最上面是全透明的遮罩、不画东西的空容器时往下取，画了东西的装饰层照样选得中（源自缺陷 TC-CORE-158）', async () => {
  const p = preview(`<div data-qid="q1"><h1 data-qid="q2">本月账单</h1>
<div data-qid="q3" style="position:fixed;inset:0;pointer-events:none"><div data-qid="q4" style="position:absolute;inset:0;background:rgba(0,0,0,.4);opacity:0"></div></div>
<div data-qid="q5" style="position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(red,blue)"></div></div>`);
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  const at = (...qids: string[]) => { (p.win.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => qids.map((q) => p.$(`[data-qid="${q}"]`)); };
  // 遮罩（全透明）→ 空容器（本来不可点、不画东西）→ 标题：选中标题
  // 真实的指针点击：detail 1、带坐标
  const tap = (q: string) => p.$(`[data-qid="${q}"]`).dispatchEvent(new p.win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 }));
  at('q4', 'q3', 'q2', 'q1');
  tap('q4');
  assert.deepEqual(boxes(p), ['q2=h1 · q2']);
  // 渐变装饰层（本来不可点，但画了东西）盖在标题上：选中装饰层
  at('q5', 'q2', 'q1');
  tap('q5');
  assert.deepEqual(boxes(p), ['q5=div · q5']);
  await p.close();
});

test('选元素：没有指针位置的点击（脚本 click()、键盘触发，detail 为 0）按事件目标取，不按坐标找', async () => {
  const p = preview('<div data-qid="q1"><h1 data-qid="q2">标题</h1><p data-qid="q3">正文</p></div>');
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  // (0, 0) 处最上面是根：按坐标找就会选成它
  (p.win.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => [p.$('[data-qid="q1"]')];
  p.$('[data-qid="q2"]').click();
  assert.deepEqual(boxes(p), ['q2=h1 · q2']);
  await p.close();
});

test('选元素：只悬停不点时滚动，悬停框跟到指针下此刻的元素（源自缺陷 TC-CORE-160）', async () => {
  const p = preview('<div data-qid="q1"><p data-qid="q2">第 1 行</p><p data-qid="q3">第 2 行</p></div>');
  p.post({ type: 'quilt:mode', mode: 'inspect', marks: LIGHT });
  const at = (q: string, top: number) => {
    (p.win.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => [p.$(`[data-qid="${q}"]`), p.$('[data-qid="q1"]')];
    (p.$(`[data-qid="${q}"]`) as unknown as HTMLElement).getBoundingClientRect = () => ({ top, left: 10, width: 200, height: 40, right: 210, bottom: top + 40, x: 10, y: top, toJSON: () => ({}) }) as DOMRect;
  };
  const hover = () => [...p.win.document.querySelectorAll('[data-quilt-ui]')].find((e) => (e as unknown as HTMLElement).style.borderStyle === 'dashed' || (e as unknown as HTMLElement).style.border.includes('dashed')) as unknown as HTMLElement;
  at('q2', 100);
  p.win.document.body.dispatchEvent(new p.win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 120 }));
  assert.equal(hover().style.top, '98px');
  // 滚动之后指针下换成了 q3（在 70 处），浏览器不发 mousemove
  at('q3', 70);
  p.win.dispatchEvent(new p.win.Event('scroll'));
  assert.equal(hover().style.top, '68px');
  await p.close();
});

test('协作者选中的块：每块一个他颜色的框加名字，空数组撤掉（v1.32）', async () => {
  const p = preview(SCREEN);
  p.post({ type: 'quilt:peers', blocks: [{ qid: 'q1', name: '乙', color: 'rgb(1, 2, 3)', on: 'rgb(255, 255, 255)' }, { qid: 'nope', name: '丙', color: 'red', on: 'white' }] });
  const boxes = () => [...p.win.document.querySelectorAll('[data-quilt-peer]')] as unknown as HTMLElement[];
  assert.equal(boxes().length, 1, '找不到的 qid 不画');
  assert.equal(boxes()[0].getAttribute('data-quilt-peer'), '乙');
  assert.match(boxes()[0].style.border, /rgb\(1, 2, 3\)/);
  assert.equal(boxes()[0].textContent, '乙');
  // 名字标签：块贴着页面顶时收进框里，下面有空就挂在框外（滚动时重摆）
  const tag = () => boxes()[0].firstChild as HTMLElement;
  assert.equal(tag().style.top, '2px');
  const q1 = p.win.document.querySelector('[data-qid="q1"]') as unknown as HTMLElement;
  q1.getBoundingClientRect = () => ({ top: 120, left: 10, width: 100, height: 40, right: 110, bottom: 160, x: 10, y: 120, toJSON: () => ({}) }) as DOMRect;
  p.win.dispatchEvent(new p.win.Event('scroll'));
  assert.equal(tag().style.top, '-20px');
  p.post({ type: 'quilt:peers', blocks: [] });
  assert.equal(boxes().length, 0);
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

// 端上的状态维度（REQ-CORE-051，ADR-041）：缺省取值下 data-when 不成立的元素隐藏，quilt:states 切取值不建修订、不重载；
// 页内与端上重名的维度不生效；quilt:event 播一次就收回
test('状态：缺省取值、切取值、页内维度、重名不生效、事件播完收回', async () => {
  const surface = '<script type="application/json" data-quilt-surface-states>{"dims":[{"key":"net","name":"Net","values":[{"key":"online","name":"On"},{"key":"offline","name":"Off"}],"default":"online"}],"events":[{"key":"saved","name":"Saved"}]}</script>';
  const page = '<script type="application/json" data-quilt-states>{"dims":[{"key":"list","name":"List","values":[{"key":"full","name":"Full"},{"key":"empty","name":"Empty"}],"default":"full"},{"key":"net","name":"Shadow","values":[{"key":"x","name":"X"},{"key":"y","name":"Y"}],"default":"x"}],"events":[]}</script>';
  const p = preview(`${surface}<main data-qid="q1">${page}<p id="off" data-when="net:offline">离线</p><p id="empty" data-when="list:empty net:offline">空</p><p id="toast" data-when="@saved">已保存</p><p id="plain">正文</p></main>`);
  const on = (id: string) => p.$(`#${id}`).hasAttribute('data-quilt-on');
  const html = p.win.document.documentElement;
  assert.equal(html.getAttribute('data-s-net'), 'online', '端上的缺省');
  assert.equal(html.getAttribute('data-s-list'), 'full', '页内的缺省');
  assert.deepEqual([on('off'), on('empty'), on('toast')], [false, false, false]);
  let heard: unknown = null;
  p.win.addEventListener('quilt:states', (e) => { heard = JSON.parse(JSON.stringify((e as unknown as { detail: unknown }).detail)); });
  p.post({ type: 'quilt:states', values: { net: 'offline', list: 'empty', nope: 'x' } });
  assert.equal(html.getAttribute('data-s-net'), 'offline');
  assert.deepEqual([on('off'), on('empty')], [true, true]);
  assert.deepEqual(heard, { values: { net: 'offline', list: 'empty' } }, '重名的页内维度不生效，不认识的键丢掉');
  // 取值不在维度里：回到缺省
  p.post({ type: 'quilt:states', values: { net: 'mars' } });
  assert.equal(html.getAttribute('data-s-net'), 'online');
  assert.equal(on('off'), false);
  p.post({ type: 'quilt:event', key: 'saved', ms: 500 });
  assert.equal(on('toast'), true);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(on('toast'), false, '播完收回');
  for (const m of p.sent) assert.ok(previewMessageSchema.safeParse(m).success, JSON.stringify(m));
  await p.close();
});
