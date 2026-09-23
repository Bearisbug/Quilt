import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensFromSeed, TOKEN_COLOR_KEYS, fontFace, buildPrelude, withCurrentRuntime, withOverlayStyle, rgbTriplet, colorVarsCss, RUNTIME_JS } from '@quilt/core';

test('tokensFromSeed：26 个色键齐全、品牌色板逐键覆盖、暗色底座、圆角档位、字体来源', () => {
  const t = tokensFromSeed('#3B5BDB');
  assert.deepEqual(Object.keys(t.colors), [...TOKEN_COLOR_KEYS]);
  for (const v of Object.values(t.colors)) assert.match(v, /^#[0-9a-f]{6}$/i);
  assert.deepEqual([t.radius.md, t.typography.fontFamily, t.typography.fontSource, t.typography.fontUrl], ['12px', 'Inter', 'google', null]);
  const p = tokensFromSeed('#3B5BDB', { palette: { primary: '#123456' }, radiusScale: 'round', fontFamily: 'Manrope', fontSource: 'url', fontUrl: 'https://x/f.css' });
  assert.equal(p.colors.primary, '#123456');
  assert.equal(p.colors.secondary, t.colors.secondary, '没覆盖的键仍走派生');
  assert.deepEqual([p.radius.md, p.typography.fontUrl], ['18px', 'https://x/f.css']);
  assert.notEqual(tokensFromSeed('#3B5BDB', { colorMode: 'dark' }).colors.background, t.colors.background);
  assert.equal(tokensFromSeed('#3B5BDB', { fontSource: 'google', fontUrl: 'https://x' }).typography.fontUrl, null, '非 url 来源不带链接');
});

test('fontFace：google 发 fonts.googleapis；system 不发外链带本机栈；url 发用户样式表并转义；关键字不加引号', () => {
  const g = fontFace({ fontFamily: 'DM Sans', scale: [] });
  assert.ok(g.link.includes('fonts.googleapis.com/css2?family=DM%20Sans'));
  assert.equal(g.families[0], '"DM Sans"');
  const s = fontFace({ fontFamily: 'PingFang SC', fontSource: 'system', scale: [] });
  assert.equal(s.link, '');
  assert.ok(s.stack.startsWith('"PingFang SC",-apple-system'), s.stack);
  assert.ok(!s.families.slice(1).includes('"PingFang SC"'), '栈里不重复');
  assert.equal(fontFace({ fontFamily: 'X', fontSource: 'url', fontUrl: 'https://a/b.css?x=1&y="2"', scale: [] }).link, '<link href="https://a/b.css?x=1&amp;y=&quot;2&quot;" rel="stylesheet">');
  assert.equal(fontFace({ fontFamily: 'system-ui', fontSource: 'system', scale: [] }).families[0], 'system-ui');
});

test('buildPrelude 带 token 变量、Tailwind 映射与运行时；withCurrentRuntime 只换运行时块', () => {
  const pre = buildPrelude(tokensFromSeed('#3B5BDB'));
  assert.ok(pre.includes('--color-on-primary:') && pre.includes("'on-primary':'rgb(var(--color-on-primary-rgb) / <alpha-value>)'") && pre.includes('<script data-quilt-runtime>'));
  const old = '<html><head><script data-quilt-runtime>OLD</script></head><body></body></html>';
  const fresh = withCurrentRuntime(old);
  assert.ok(fresh.includes(RUNTIME_JS) && !fresh.includes('>OLD<'));
  assert.equal(withCurrentRuntime('<p>no runtime</p>'), '<p>no runtime</p>');
});

test('withOverlayStyle：只在第一个 </head> 前注入透明背景，没有 head 就放最前', () => {
  const out = withOverlayStyle('<html><head><title>t</title></head><body></body></html>');
  assert.ok(out.includes('<style data-quilt-overlay>html,body{background:transparent}</style>\n</head>'));
  assert.equal((out.match(/data-quilt-overlay/g) ?? []).length, 1);
  assert.ok(withOverlayStyle('<p>x</p>').startsWith('<style data-quilt-overlay>'));
});

test('token 色带 RGB 三元组，Tailwind 颜色走 <alpha-value>，透明度修饰符（bg-primary/40）才生效（v0.65）', () => {
  assert.equal(rgbTriplet('#3052D2'), '48 82 210');
  assert.equal(colorVarsCss({ primary: '#000000', onPrimary: '#ffffff' }), '--color-primary:#000000;--color-primary-rgb:0 0 0;--color-on-primary:#ffffff;--color-on-primary-rgb:255 255 255');
  const pre = buildPrelude(tokensFromSeed('#3B5BDB'));
  assert.ok(pre.includes("'primary':'rgb(var(--color-primary-rgb) / <alpha-value>)'") && pre.includes('--color-primary-rgb:'), pre.slice(0, 300));
});
