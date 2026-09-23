import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineBody, injectQids } from '@quilt/core';

test('outlineBody：根与直接子元素、地标、叶子入选；列表只展开前 2 项；script 跳过', () => {
  const body = injectQids('<main><header><h1>Title</h1></header><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul><form action="/go"><input type="email" name="mail" placeholder="you@x"><button>Send <i data-lucide="send"></i></button></form><img src="x.png" alt="pic"><nav data-component="TabBar"></nav><script>1</script></main>');
  const out = outlineBody(body);
  const lines = out.split('\n');
  assert.equal(lines[0], 'main#q1');
  assert.ok(lines.includes('    h1#q3 "Title"'), out);
  assert.ok(lines.some((l) => l.endsWith('a#q6 "A" → /a')), out);
  assert.ok(lines.some((l) => l.includes('… +1 more items')), out);
  assert.ok(lines.some((l) => l.includes('form#q11 → /go')), out);
  assert.ok(lines.some((l) => l.includes('input#q12 [email mail you@x]')), out);
  assert.ok(lines.some((l) => l.includes('button#q13 "Send" icon:send')), out);
  assert.ok(lines.some((l) => l.includes('img#q15 alt="pic"')), out);
  assert.ok(lines.some((l) => l.includes('nav#q16 [shared component: TabBar]')), out);
  assert.ok(!out.includes('script'));
});

test('outlineBody 40 行封顶，末尾报溢出数', () => {
  const o = outlineBody(injectQids(`<main>${'<a href="/x">l</a>'.repeat(60)}</main>`), 40).split('\n');
  assert.equal(o.length, 41);
  assert.ok(o[40].startsWith('… +21 more elements'), o[40]);
});
