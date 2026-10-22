import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { RECORD_EVENT_MAX_BYTES } from '@quilt/core';
import {
  BUFFER_MAX, RecordQueue, buildEvent, clickable, describeChange, describeClick, describePreview, keyCombo, placeOf, recordOff, retryable,
  sanitize, stripSigned, targetName, textField,
} from '../../../apps/web/src/lib/recordRules.ts';

// 本机使用记录的浏览器端规则（REQ-CORE-047，§9 record_events.*，INV-CORE-006）
const dom = (html: string) => {
  const win = new Window({ url: 'http://localhost:6688/p/x' });
  win.document.body.innerHTML = html;
  return win.document as unknown as Document;
};
const $ = (d: Document, sel: string) => d.querySelector(sel)!;
const PID = '3f2b8c1e-5d4a-4b6f-9a2e-1c7d8e9f0a1b';
const SID = '7a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const place = placeOf(`/p/${PID}`, '');

test('元素取名：data-testid > aria-label > 「标签名:可见文字前 40 字」，空白压成一个', () => {
  const d = dom(`
    <button data-testid="toggle-screens" aria-label="屏列表">x</button>
    <button aria-label="  关闭  "><svg></svg></button>
    <a href="/p/1">  打开
       项目   设置 </a>
    <button>${'很长的按钮文字'.repeat(10)}</button>`);
  const [a, b, c, e] = [...d.querySelectorAll('button, a')];
  assert.equal(targetName(a), 'toggle-screens');
  assert.equal(targetName(b), '关闭');
  assert.equal(targetName(c), 'a:打开 项目 设置');
  assert.equal(targetName(e), `button:${'很长的按钮文字'.repeat(10).slice(0, 40)}`);
});

test('文本框与单选框的名字取标签或占位，从不取值；textarea 里的初始文字不算界面文字', () => {
  const d = dom(`
    <label>需求 <textarea id="t">做一个登录页</textarea></label>
    <input id="k" placeholder="搜索屏" value="secret-ish">
    <label for="r">深色</label><input id="r" type="radio" name="theme" value="dark">`);
  assert.equal(targetName($(d, '#t')), 'textarea:需求');
  assert.equal(targetName($(d, '#k')), 'input:搜索屏');
  assert.equal(targetName($(d, '#r')), 'input:深色');
});

test('点击：找最近的可点元素；改取值的角色记 change 并带按下之后的值；禁用的照样记、带 disabled；包着复选框的 label 交给 change', () => {
  const d = dom(`
    <button data-testid="send"><svg><path id="icon"></path></svg></button>
    <button role="switch" aria-checked="false" data-testid="rec-switch"></button>
    <div role="tab" aria-selected="false" data-testid="tab-models">模型</div>
    <button data-testid="off" aria-disabled="true">导出</button>
    <label id="lb"><input type="checkbox"> 带素材</label>
    <a href="/v1/objects/x?exp=1&sig=abc" data-testid="dl">下载</a>
    <div id="plain">空白</div>`);
  assert.equal(clickable($(d, '#icon')), $(d, '[data-testid="send"]'));
  assert.equal(clickable($(d, '#plain')), null);
  assert.deepEqual(describeClick($(d, '[data-testid="send"]')), { type: 'click', target: 'send', data: undefined });
  assert.deepEqual(describeClick($(d, '[role="switch"]')), { type: 'change', target: 'rec-switch', data: { role: 'switch', checked: true } });
  assert.deepEqual(describeClick($(d, '[role="tab"]')), { type: 'change', target: 'tab-models', data: { role: 'tab' } });
  assert.deepEqual(describeClick($(d, '[data-testid="off"]')), { type: 'click', target: 'off', data: { disabled: true } });
  assert.equal(describeClick($(d, '#lb')), null);
  // href 原样交出去，签名在成形时去掉（buildEvent → sanitize）
  const dl = describeClick($(d, '[data-testid="dl"]'))!;
  assert.deepEqual(buildEvent(1, '2026-10-21T00:00:00.000Z', place, dl.type, dl.target, dl.data).event.data, { href: '/v1/objects/x?exp=-&sig=-' });
});

test('密码框与 [data-record="off"] 里的一切都不记', () => {
  const d = dom(`
    <div data-record="off"><label>API Key <input id="key" type="text"></label><button id="eye">显示</button></div>
    <input id="pw" type="password"><input id="name" type="text">`);
  assert.ok(recordOff($(d, '#key')));
  assert.ok(recordOff($(d, '#eye')));
  assert.ok(recordOff($(d, '#pw')));
  assert.ok(!recordOff($(d, '#name')));
  // 取别处元素的名字时也不把关掉的子树里的字带出来
  const wrap = d.createElement('button');
  wrap.innerHTML = '确定 <span data-record="off">sk-test-SECRET-123</span>';
  assert.equal(targetName(wrap), 'button:确定');
});

test('文本框快照的对象：textarea、文本类 input、contenteditable 的编辑根；复选框、密码之外的取值走 change', () => {
  const d = dom(`
    <textarea id="t"></textarea><input id="s" type="search"><input id="c" type="checkbox" checked>
    <div contenteditable="true" id="ce"><b id="in">粗</b></div><div contenteditable="false"><i id="no">x</i></div>
    <select id="sel"><option value="a">A</option><option value="b" selected>B</option></select>
    <input id="r" type="range" value="3">`);
  assert.equal(textField($(d, '#t')), $(d, '#t'));
  assert.equal(textField($(d, '#s')), $(d, '#s'));
  assert.equal(textField($(d, '#c')), null);
  assert.equal(textField($(d, '#in')), $(d, '#ce'));
  assert.equal(textField($(d, '#no')), null);
  assert.deepEqual(describeChange($(d, '#c'))?.data, { checked: true });
  assert.deepEqual(describeChange($(d, '#sel'))?.data, { value: 'b' });
  assert.deepEqual(describeChange($(d, '#r'))?.data, { value: '3' });
  assert.equal(describeChange($(d, '#t')), null);
  assert.equal(describeChange($(d, '#s')), null);
});

test('快捷键：不在打字时每个键都记；打字时只记 ⌘ / Ctrl 组合、Esc 与 Enter；长按重复、组字、单按修饰键不记', () => {
  const k = (key: string, o: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing: boolean }> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  assert.deepEqual(keyCombo(k('f', { code: 'KeyF' }), false), { key: 'f', code: 'KeyF' });
  assert.deepEqual(keyCombo(k('ArrowLeft', { code: 'ArrowLeft', altKey: true }), false), { key: 'ArrowLeft', code: 'ArrowLeft', mods: 'alt' });
  assert.equal(keyCombo(k('a'), true), null);
  assert.equal(keyCombo(k('A', { shiftKey: true }), true), null);
  assert.equal(keyCombo(k('å', { altKey: true }), true), null);
  assert.deepEqual(keyCombo(k('k', { code: 'KeyK', metaKey: true }), true), { key: 'k', code: 'KeyK', mods: 'meta' });
  assert.deepEqual(keyCombo(k('Enter'), true), { key: 'Enter' });
  assert.equal(keyCombo(k('Enter', { shiftKey: true }), true), null);
  assert.deepEqual(keyCombo(k('Escape'), true), { key: 'Escape' });
  assert.equal(keyCombo(k('ArrowDown', { repeat: true }), false), null);
  assert.equal(keyCombo(k('Enter', { isComposing: true }), true), null);
  assert.equal(keyCombo(k('Meta', { metaKey: true }), false), null);
});

test('签名地址只留问号之前：对象 / 上传签名（exp、sig）与预览 token（t）；普通查询参数原样', () => {
  assert.equal(stripSigned('http://localhost:3100/v1/objects/projects%2Fa%2Fb.png?exp=1761000000&sig=deadbeef'), 'http://localhost:3100/v1/objects/projects%2Fa%2Fb.png?exp=-&sig=-');
  assert.equal(stripSigned(`http://preview.localhost:3101/p/${PID}/${SID}?rev=r1&t=tok`), `http://preview.localhost:3101/p/${PID}/${SID}?rev=r1&t=-`);
  assert.equal(stripSigned('/v1/attachments/p/a?exp=1&sig=x&mt=image%2Fpng'), '/v1/attachments/p/a?exp=-&sig=-&mt=image%2Fpng');
  assert.equal(stripSigned(`/p/${PID}?settings=models&panel=design`), `/p/${PID}?settings=models&panel=design`);
  assert.equal(stripSigned('参考 https://cdn.example/a.png?sig=1 这张'), '参考 https://cdn.example/a.png?sig=- 这张');
  assert.equal(stripSigned('没有地址'), '没有地址');
});

test('data 里超过 2000 字的字符串只记长度；嵌套的照样处理，undefined 丢掉', () => {
  const long = 'x'.repeat(2500);
  assert.deepEqual(sanitize({ value: long, ok: 'y'.repeat(2000), n: 1, none: undefined, list: [long, 'a'], nest: { href: '/v1/objects/k?exp=1&sig=2' } }),
    { value: 2500, ok: 'y'.repeat(2000), n: 1, list: [2500, 'a'], nest: { href: '/v1/objects/k?exp=-&sig=-' } });
});

test('页面名、路径与地址里的 id：不合格的 uuid 不带（带了整批 400）', () => {
  assert.deepEqual(placeOf(`/p/${PID}`, '?settings=system'), { page: 'canvas', path: `/p/${PID}?settings=system`, projectId: PID, screenId: undefined });
  assert.deepEqual(placeOf('/p/not-a-uuid', ''), { page: 'canvas', path: '/p/not-a-uuid', projectId: undefined, screenId: undefined });
  assert.deepEqual(placeOf('/sketch', `?d=${SID}`), { page: 'sketch', path: `/sketch?d=${SID}`, projectId: undefined, screenId: SID });
  assert.equal(placeOf('/', '').page, 'first');
  assert.equal(placeOf('/nope', '').page, 'other');
});

test('事件成形：data.screenId 提到顶层（不是 uuid 的丢掉）；超过 16 KB 的只留字节数', () => {
  const at = '2026-10-21T08:00:00.000Z';
  const { event } = buildEvent(7, at, place, 'preview', 'select', { qid: 'q3', screenId: SID });
  assert.deepEqual(event, { seq: 7, at, page: 'canvas', path: `/p/${PID}`, type: 'preview', target: 'select', projectId: PID, screenId: SID, data: { qid: 'q3' } });
  assert.equal(buildEvent(1, at, place, 'preview', 'dead', { screenId: 'x' }).event.screenId, undefined);
  assert.equal(buildEvent(1, at, place, 'view').event.data, undefined);
  // 九段各 1999 字的中文：单段不到 2000 字不截，合起来远超 16 KB
  const big = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, '中'.repeat(1999)]));
  const r = buildEvent(2, at, place, 'input', 'composer-input', big);
  assert.ok(r.bytes <= RECORD_EVENT_MAX_BYTES);
  assert.deepEqual(Object.keys(r.event.data!), ['bytes']);
  assert.ok((r.event.data!.bytes as number) > RECORD_EVENT_MAX_BYTES);
});

test('缓冲：seq 从 1 递增；超过 2000 条丢最旧的；发失败的放回队首按原顺序再发；清空之后编号接着走', () => {
  const q = new RecordQueue();
  const add = () => q.push(buildEvent(q.nextSeq(), '2026-10-21T08:00:00.000Z', place, 'click', 'b'));
  for (let i = 0; i < 3; i++) add();
  const batch = q.take(200);
  assert.deepEqual(batch.map((e) => e.seq), [1, 2, 3]);
  assert.equal(q.size, 0);
  add();   // 发送在途时又来一条
  q.restore(batch);
  assert.deepEqual(q.take(200).map((e) => e.seq), [1, 2, 3, 4]);
  for (let i = 0; i < BUFFER_MAX + 5; i++) add();
  assert.equal(q.size, BUFFER_MAX);
  const first = q.take(1)[0].seq;
  assert.equal(first, 4 + 5 + 1);
  q.clear();
  add();
  assert.equal(q.take(1)[0].seq, 4 + BUFFER_MAX + 5 + 1);
});

test('缓冲：一批至多 200 条；keepalive 按字节截（至少一条）；放回时同样受上限约束', () => {
  const q = new RecordQueue(10);
  for (let i = 0; i < 12; i++) q.push(buildEvent(q.nextSeq(), '2026-10-21T08:00:00.000Z', place, 'input', 't', { value: 'x'.repeat(1000) }));
  assert.equal(q.size, 10);
  const small = q.take(200, 2500);
  assert.equal(small.length, 2);
  assert.equal(q.take(200, 10).length, 1);
  q.restore([...small, ...small, ...small, ...small]);
  assert.equal(q.size, 10);
  const big = new RecordQueue();
  for (let i = 0; i < 450; i++) big.push(buildEvent(big.nextSeq(), '2026-10-21T08:00:00.000Z', place, 'click'));
  assert.equal(big.take().length, 200);
});

test('发送失败的去留：连不上、超时、限流、5xx 留着；4xx 丢掉', () => {
  assert.ok(retryable(null));
  assert.ok(retryable(503));
  assert.ok(retryable(429));
  assert.ok(retryable(408));
  assert.ok(!retryable(400));
  assert.ok(!retryable(403));
  assert.ok(!retryable(404));
});

test('预览消息：点选、跳转、死链记 preview，转发来的快捷键记 key，尺寸与就绪不记', () => {
  assert.deepEqual(describePreview({ type: 'quilt:select', qid: 'q1', tag: 'button', text: '登录', classes: 'px-4', href: null, component: null }),
    { type: 'preview', target: 'select', data: { qid: 'q1', tag: 'button', text: '登录', component: null, href: null } });
  assert.deepEqual(describePreview({ type: 'quilt:navigate', href: '/home' }), { type: 'preview', target: 'navigate', data: { href: '/home' } });
  assert.deepEqual(describePreview({ type: 'quilt:key', key: 'Escape', altKey: false }), { type: 'key', target: 'preview', data: { key: 'Escape' } });
  assert.deepEqual(describePreview({ type: 'quilt:key', key: 'e', code: 'KeyE', altKey: false, metaKey: true }), { type: 'key', target: 'preview', data: { key: 'e', code: 'KeyE', mods: 'meta' } });
  assert.equal(describePreview({ type: 'quilt:ready', title: 'x' }), null);
  assert.equal(describePreview({ type: 'quilt:draft-size', screenId: SID, w: 1, h: 1 }), null);
});
