import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintScreenBody, extractLinks } from '@quilt/core';

test('lintScreenBody：合规屏 passed，断链单列不计违规', () => {
  const ok = lintScreenBody('<main data-qid="q1"><a href="/a" data-qid="q2">a</a><a href="#" data-qid="q3">dead</a><form action="/go" data-qid="q4"></form><button data-href="/b" data-qid="q5">b</button></main>', ['/a']);
  assert.equal(ok.passed, true);
  assert.deepEqual([...ok.danglingRoutes].sort(), ['/b', '/go']);
});

test('lintScreenBody：九条规则各报一次', () => {
  const bad = lintScreenBody('<div class="bg-blue-500 text-[#123456]" style="color:#fff"></div><script></script><style></style><a href="https://x.com">x</a><form></form>', []);
  const rules = new Set(bad.violations.map((v) => v.rule));
  for (const r of ['single-root', 'no-script', 'no-style', 'no-raw-hex', 'no-arbitrary', 'token-colors-only', 'no-inline-style', 'internal-links-only', 'form-action']) assert.ok(rules.has(r), r);
  assert.equal(bad.passed, false);
  assert.equal(bad.firstTry, true);
});

test('extractLinks：href / data-href / form action 三种来源，只收 / 开头的', () => {
  assert.deepEqual(extractLinks('<a href="/a" data-qid="q1"></a><a href="#" data-qid="q2"></a><div data-href="/d" data-qid="q3"></div><form action="/f" data-qid="q4"></form><a href="https://x" data-qid="q5"></a>'), [{ qid: 'q1', href: '/a' }, { qid: 'q3', href: '/d' }, { qid: 'q4', href: '/f' }]);
});
