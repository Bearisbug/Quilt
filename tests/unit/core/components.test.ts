import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm } from '../lib.ts';
import { overwrittenInstances, validateComponentHtml, componentSlots, componentPlacement, componentSummary, componentNamesIn, componentOf, expandComponents, classifyComponentHtml, extractComponent, findComponentMatch, replaceWithPlaceholder, injectQids } from '@quilt/core';

const TAB_BAR = '<nav class="bar"><a href="/home" class="tab active" aria-current="page">Home</a><a href="/me" class="tab">Me</a><span data-slot="badge">0</span></nav>';

test('validateComponentHtml：单根、无 script / style、不套组件、不超 64 KB', () => {
  assert.deepEqual(validateComponentHtml(TAB_BAR), { ok: true, tag: 'nav' });
  assert.equal(validateComponentHtml('<a>1</a><a>2</a>').ok, false);
  assert.equal(validateComponentHtml('<div><script>1</script></div>').ok, false);
  assert.equal(validateComponentHtml('<div><nav data-component="X"></nav></div>').ok, false);
  assert.equal(validateComponentHtml(`<div>${'x'.repeat(64 * 1024)}</div>`).ok, false);
});

test('slots / placement / summary / namesIn / componentOf', () => {
  assert.deepEqual(componentSlots(TAB_BAR), ['badge']);
  assert.equal(componentPlacement('TabBar', 'nav', ['badge']), '<nav data-component="TabBar"><span data-slot="badge">badge</span></nav>');
  const s = componentSummary(TAB_BAR);
  assert.ok(s.startsWith('nav · links: Home→/home, Me→/me') && s.endsWith('slots: badge'), s);
  const body = '<main data-qid="q1"><nav data-component="TabBar" data-qid="q2"><a data-qid="q3">x</a></nav><footer data-component="Footer" data-qid="q4"></footer></main>';
  assert.deepEqual(componentNamesIn(body), ['TabBar', 'Footer']);
  assert.deepEqual(componentOf(body, 'q3'), { name: 'TabBar', rootQid: 'q2' });
  assert.equal(componentOf(body, 'q1'), null);
});

test('expandComponents：占位换正式 HTML、槽位填入、按路由算激活态、根沿用 qid、新子树接着编号', () => {
  const comp = { name: 'TabBar', html: TAB_BAR, activeClass: 'active', inactiveClass: null };
  const body = '<main data-qid="q1"><nav data-component="TabBar" data-qid="q2"><span data-slot="badge">7</span></nav><p data-qid="q3">t</p></main>';
  const r = expandComponents(body, [comp], '/me');
  const { used } = r; const html = norm(r.html);
  assert.deepEqual(used, ['TabBar']);
  assert.ok(html.includes(norm('<nav class="bar" data-component="TabBar" data-qid="q2">')), html);
  assert.ok(html.includes(norm('<a href="/me" class="tab active" aria-current="page" data-qid="q5">')), '当前路由的链接激活');
  assert.ok(html.includes(norm('<a href="/home" class="tab" data-qid="q4">Home</a>')), '其它链接去掉激活类与 aria-current');
  assert.ok(html.includes(norm('<span data-slot="badge" data-qid="q6">7<')), '槽位内容来自实例；新子树从 q4 起编号');
  assert.ok(html.includes('<p data-qid="q3">t</p>'), '兄弟不动');
  assert.equal(norm(expandComponents(body, [{ ...comp, name: 'Other' }], '/me').html), norm(body), '不认识的名字原样保留');
  assert.equal(expandComponents(body, [], '/me').html, body);
  assert.deepEqual(expandComponents(body, [{ ...comp, name: 'Tabs' }], '/me', { rename: { from: 'TabBar', to: 'Tabs' } }).used, ['Tabs'], '改名回刷把旧名实例当新名');
});

test('classifyComponentHtml：激活项独有的类是 activeClass，其余共有而它没有的是 inactiveClass；组件自己的 qid 从 q1 起', () => {
  assert.equal(classifyComponentHtml('<nav><a href="/a" class="tab on">A</a><a href="/b" class="tab off">B</a></nav>').activeClass, null, '没有 aria-current 认不出激活项');
  const r = classifyComponentHtml('<nav><a href="/a" class="tab on" aria-current="page">A</a><a href="/b" class="tab off">B</a><a href="/c" class="tab off">C</a></nav>');
  assert.deepEqual([r.activeClass, r.inactiveClass], ['on', 'off']);
  assert.ok(r.html.includes('data-qid="q1"') && r.html.includes('data-qid="q4"'));
});

test('extractComponent：去 qid、算深度、按本屏路由分出激活类；在存活组件里 / 包着存活组件不可提取', () => {
  const body = injectQids('<main><header><nav><a href="/a" class="t on">A</a><a href="/b" class="t">B</a></nav></header><section data-component="Card"><b>x</b></section></main>');
  const ex = extractComponent(body, 'q3', '/a', []);
  assert.ok('html' in ex, JSON.stringify(ex));
  assert.deepEqual([ex.tag, ex.depth, ex.classes, ex.activeClass, ex.inactiveClass], ['nav', 2, '', 'on', '']);
  assert.ok(!ex.html.includes('data-qid') && ex.html.includes('aria-current="page"'));
  assert.ok('error' in extractComponent(body, 'q7', '/a', ['Card']), '在存活组件里');
  assert.ok('error' in extractComponent(body, 'q1', '/a', ['Card']), '包着存活组件');
  assert.ok('html' in extractComponent(body, 'q7', '/a', []), '组件已删 = 实例脱离，可提取');
  assert.ok('error' in extractComponent(body, 'q99', '/a', []));
});

test('findComponentMatch：同标签同深度；唯一候选直接取，多个按类名相似度取最高且 ≥ 0.3', () => {
  const body = injectQids('<main><nav class="bar x">1</nav><div><nav class="other">deep</nav></div><nav class="bar y">2</nav></main>');
  assert.equal(findComponentMatch(body, 'nav', 1, 'bar x', []), 'q2');
  assert.equal(findComponentMatch(body, 'nav', 1, 'zzz', []), null);
  assert.equal(findComponentMatch(body, 'nav', 2, 'nothing-alike', []), 'q4');
  assert.equal(findComponentMatch(injectQids('<main><nav data-component="TabBar">x</nav></main>'), 'nav', 1, '', ['TabBar']), null, '已在存活组件里的不算');
});

test('replaceWithPlaceholder：换成占位根并保留 qid', () => {
  const body = '<main data-qid="q1"><nav data-qid="q2"><a data-qid="q3">x</a></nav></main>';
  assert.equal(norm(replaceWithPlaceholder(body, 'q2', 'TabBar', 'nav')!), norm('<main data-qid="q1"><nav data-component="TabBar" data-qid="q2"></nav></main>'));
  assert.equal(replaceWithPlaceholder(body, 'q9', 'TabBar', 'nav'), null);
});

test('overwrittenInstances：只放占位 / 只填槽位 / 原样抄回展开结果都不算，改了副本才报（v0.65）', () => {
  const comp = { name: 'TabBar', html: TAB_BAR, activeClass: 'active', inactiveClass: null };
  assert.deepEqual(overwrittenInstances('<main><nav data-component="TabBar"></nav></main>', [comp], '/home'), []);
  assert.deepEqual(overwrittenInstances('<main><nav data-component="TabBar"><span data-slot="badge">3</span></nav></main>', [comp], '/home'), []);
  const expanded = expandComponents('<main><nav data-component="TabBar"></nav></main>', [comp], '/home').html;
  assert.deepEqual(overwrittenInstances(expanded, [comp], '/home'), [], '原样抄回');
  assert.deepEqual(overwrittenInstances(expanded.replace('>Me<', '>Profile<'), [comp], '/home'), ['TabBar'], '改了副本里的文案');
  assert.deepEqual(overwrittenInstances('<main><nav data-component="Gone"><a>x</a></nav></main>', [comp], '/home'), [], '不认识的组件不算');
});
