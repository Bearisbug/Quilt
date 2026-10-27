import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stateKeyFrom, assignStateKeys, parseStates, shadowedStateKeys, missingValues, withSurfaceStates, surfaceStatesSchema, pageStatesSchema,
  screenSystemPrompt, planUserPrompt, buildPrototypeDocument, tokensFromSeed, EMPTY_STATES, type SurfaceStates,
} from '@quilt/core';

// 端上的状态维度（REQ-CORE-051，ADR-041）：键从名字转出、改名不动键、删掉的维度标 retired；屏里的写法在落修订时解析

test('stateKeyFrom：名字转 kebab-case，转不出 ASCII 用前缀加序号，撞了加序号', () => {
  assert.equal(stateKeyFrom('Network', [], 'd'), 'network');
  assert.equal(stateKeyFrom('Signed in', [], 'd'), 'signed-in');
  assert.equal(stateKeyFrom('Café', [], 'v'), 'cafe');
  assert.equal(stateKeyFrom('网络', [], 'd'), 'd1');
  assert.equal(stateKeyFrom('网络', ['d1'], 'd'), 'd2');
  assert.equal(stateKeyFrom('Network', ['network'], 'd'), 'network-2');
  assert.equal(stateKeyFrom('3G only', [], 'v'), 'g-only');
});

test('assignStateKeys：已有的键不变、新加的补键，缺省可给序号，没提交的维度标 retired', () => {
  const first = assignStateKeys({ dims: [{ name: '网络', values: [{ name: '在线' }, { name: '离线' }] }], events: [{ name: 'Saved', ms: 1200 }] }, EMPTY_STATES);
  assert.deepEqual(first.dims[0], { key: 'd1', name: '网络', values: [{ key: 'v1', name: '在线' }, { key: 'v2', name: '离线' }], default: 'v1' });
  assert.deepEqual(first.events, [{ key: 'saved', name: 'Saved', ms: 1200 }]);
  // 改名、加一维、缺省换成第二个：d1 的键不变
  const second = assignStateKeys({
    dims: [
      { key: 'd1', name: '连接', values: [{ key: 'v1', name: '正常' }, { key: 'v2', name: '断开' }], default: 1 },
      { name: 'Plan', values: [{ name: 'Free' }, { name: 'Pro' }] },
    ],
    events: [],
  }, first);
  assert.equal(second.dims[0].key, 'd1');
  assert.equal(second.dims[0].default, 'v2');
  assert.equal(second.dims[1].key, 'plan');
  assert.ok(surfaceStatesSchema.safeParse(second).success);
  // 删掉 d1：留着、标 retired，运行时仍按它原来的缺省算
  const third = assignStateKeys({ dims: [second.dims[1]], events: [] }, second);
  assert.deepEqual(third.dims.map((d) => [d.key, !!d.retired]), [['plan', false], ['d1', true]]);
  assert.equal(third.dims[1].default, 'v2');
});

test('surfaceStatesSchema：缺省要在取值里、键不能重复，退役的维度不计入上限', () => {
  const dim = (key: string) => ({ key, name: key, values: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }], default: 'a' });
  assert.ok(!surfaceStatesSchema.safeParse({ dims: [{ ...dim('x'), default: 'c' }], events: [] }).success);
  assert.ok(!surfaceStatesSchema.safeParse({ dims: [dim('x'), dim('x')], events: [] }).success);
  const seven = Array.from({ length: 7 }, (_, i) => dim(`d${i}`));
  const r = surfaceStatesSchema.safeParse({ dims: seven, events: [] });
  assert.ok(!r.success && r.error.issues.some((i) => i.message === '至多 6 个维度'));
  assert.ok(surfaceStatesSchema.safeParse({ dims: seven.map((d, i) => ({ ...d, retired: i === 0 })), events: [] }).success);
  assert.ok(!pageStatesSchema.safeParse({ dims: seven.slice(0, 5), events: [] }).success);
});

test('parseStates：声明块、data-when 与 data-s-* 选择器都记进 uses；声明块不合规当没有', () => {
  const decl = '<script type="application/json" data-quilt-states>{"dims":[{"key":"list","name":"List","values":[{"key":"full","name":"Full"},{"key":"empty","name":"Empty"}],"default":"full"}],"events":[]}</script>';
  const body = `<div>${decl}<p data-when="net:offline|weak">离线</p><p data-when='list:empty login:guest'>空</p><span data-when="@saved">已保存</span>
<style>html[data-s-plan="pro"] .badge{display:block}</style></div>`;
  const s = parseStates(body);
  assert.equal(s.dims[0].key, 'list');
  assert.deepEqual(s.uses, { list: ['empty'], login: ['guest'], net: ['offline', 'weak'], plan: ['pro'] });
  assert.deepEqual(parseStates('<div><script type="application/json" data-quilt-states>{not json</script></div>').dims, []);
  assert.deepEqual(parseStates('<div><p>普通屏</p></div>'), { dims: [], events: [], uses: {} });
});

test('shadowedStateKeys 与 missingValues：页内与端上重名的键、这一屏没写到的取值', () => {
  const surface: SurfaceStates = { dims: [{ key: 'net', name: 'Net', values: [{ key: 'online', name: 'On' }, { key: 'offline', name: 'Off' }, { key: 'weak', name: 'Weak' }], default: 'online' }], events: [{ key: 'saved', name: 'Saved' }] };
  const page: SurfaceStates = { dims: [{ key: 'net', name: 'X', values: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }], default: 'a' }], events: [{ key: 'saved', name: 'S' }, { key: 'ok', name: 'OK' }] };
  assert.deepEqual(shadowedStateKeys(page, surface), ['net', 'saved']);
  assert.deepEqual(missingValues(surface.dims[0], { net: ['offline'] }), { written: true, missing: ['weak'] });
  assert.deepEqual(missingValues(surface.dims[0], null), { written: false, missing: ['offline', 'weak'] });
});

test('withSurfaceStates：有维度时在 head 里放 JSON 块并转义 <，没有时原样', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  assert.equal(withSurfaceStates(html, EMPTY_STATES), html);
  const states: SurfaceStates = { dims: [{ key: 'net', name: '</script>', values: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }], default: 'a' }], events: [] };
  const out = withSurfaceStates(html, states);
  assert.ok(out.includes('<script type="application/json" data-quilt-surface-states>'));
  assert.ok(out.indexOf('data-quilt-surface-states') < out.indexOf('</head>'));
  assert.ok(!out.includes('"</script>"') && out.includes('\\u003c/script>'));
});

test('出屏提示词带这一端的维度与写法；规划器拿到其他端的页面表与已有分组', () => {
  const states: SurfaceStates = { dims: [{ key: 'net', name: 'Network', values: [{ key: 'online', name: 'Online' }, { key: 'offline', name: 'Offline' }], default: 'online' }], events: [{ key: 'saved', name: 'Saved toast', ms: 2000 }] };
  const tokens = tokensFromSeed('#3B5BDB');
  const app = { name: 'Shop', description: 'shop', brief: '' };
  const withStates = screenSystemPrompt(app, 'mobile', tokens, '', [], [], [], [], [], states);
  assert.ok(withStates.includes('STATES') && withStates.includes('dimension "net"') && withStates.includes('online (Online) [default]') && withStates.includes('"@saved"'));
  assert.ok(withStates.includes('data-when'));
  assert.ok(!screenSystemPrompt(app, 'mobile', tokens, '', [], [], [], [], []).includes('STATES (switched live'));
  const plan = planUserPrompt(app, 'orders', [], { groups: ['Main'], surface: 'App', others: [{ name: 'Admin', device: 'desktop', registry: [{ route: '/orders', name: 'Orders', group: 'Ops' }] }] });
  assert.ok(plan.includes('EXISTING GROUPS: Main'));
  assert.ok(plan.includes('OTHER SURFACES') && plan.includes('Admin (desktop): /orders (Orders, group Ops)') && plan.includes('never link'));
});

test('导出原型：端上的维度放进 head，data-when 按缺省取值显示的规则在样式里', () => {
  const states: SurfaceStates = { dims: [{ key: 'net', name: 'Network', values: [{ key: 'online', name: 'Online' }, { key: 'offline', name: 'Offline' }], default: 'online' }], events: [] };
  const doc = buildPrototypeDocument({ title: 'Shop · App · prototype', tokens: tokensFromSeed('#3B5BDB'), screens: [{ route: '/home', name: 'Home', body: '<div><p data-when="net:offline">离线</p></div>' }], tailwindCss: '', lucideJs: '', states });
  assert.ok(doc.includes('data-quilt-surface-states'));
  assert.ok(doc.includes('[data-when]:not([data-quilt-on]){display:none!important}'));
  // 模板里的 JSON 声明块不能被包成块作用域
  assert.ok(doc.includes("s.type !== 'application/json'"));
});
