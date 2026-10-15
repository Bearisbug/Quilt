import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// 界面视觉接线（v1.08，DESIGN §13.1 / ui-constraints THEME-006）：只经 brand/ 的三份文件（在 apps/web/src/brand/ 的副本）进来，组件里不写 hover 色、ring 焦点环、
// 禁用透明度与 hex，外壳样式表不用渐变、背景模糊、文字阴影（brand meta.notUsed）
const WEB = path.resolve(import.meta.dirname, '../../../apps/web');
const SRC = path.join(WEB, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const sources = (() => {
  const out: string[] = [];
  (function walk(d: string) { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx|ts)$/.test(f)) out.push(p); } })(SRC);
  // 类名说明表与厂商图标里是用户屏的 Tailwind 词汇与第三方 SVG，不是外壳的样式
  return out.filter((p) => !/lib\/twClass\.ts$|ui\/vendorIcons\.ts$/.test(p));
})();

test('styles.css 只引 brand/ 副本里的 token 适配文件、状态层与字体，没有自写的 token 映射', () => {
  const css = read(path.join(SRC, 'styles.css'));
  const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['tailwindcss', './brand/tokens.tailwind.css', './brand/state-layer.css', './brand/fonts/fonts.css']);
  assert.doesNotMatch(css, /@theme\b/);
  // 旧的品牌变量层与映射层的变量名一个都不剩
  assert.doesNotMatch(css, /--brand-|var\(--color-/);
});

test('apps/web/src/brand/ 的副本与本机 brand/ 一致（本机没有 brand/ 时跳过比对）', () => {
  const r = spawnSync('node', [path.resolve(import.meta.dirname, '../../../scripts/sync-brand.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('外壳样式表不用渐变、背景模糊、文字阴影', () => {
  const css = read(path.join(SRC, 'styles.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /text-shadow/);
});

test('组件里没有 hover 色、ring 焦点环、禁用透明度、背景模糊类，也没有 hex 颜色', () => {
  const banned = /\b(hover:(bg|text|border|ring)-\S+|focus-visible:(ring|outline)\S*|focus-visible:border-ring|(aria-)?disabled:opacity-\S+|backdrop-blur\S*|bg-gradient-\S+)/;
  const hits: string[] = [];
  for (const p of sources) {
    read(p).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\{\/\*)/.test(line)) return;
      const m = line.match(banned);
      if (m) hits.push(`${path.relative(SRC, p)}:${i + 1} ${m[0]}`);
      // 种子色输入框的缺省值是用户设计系统的值，不是外壳的颜色
      const hex = line.replace(/'#000000'/g, '').match(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
      if (hex) hits.push(`${path.relative(SRC, p)}:${i + 1} ${hex[0]}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('首帧脚本与 lib/theme.ts 用同一个存储键与取值', () => {
  const html = read(path.join(WEB, 'index.html'));
  const lib = read(path.join(SRC, 'lib/theme.ts'));
  const key = lib.match(/const KEY = '([^']+)'/)?.[1];
  assert.equal(key, 'quilt:theme');
  assert.match(html, new RegExp(`localStorage\\.getItem\\('${key}'\\)`));
  assert.match(html, /t === 'light' \|\| t === 'dark'/);
  // 样式表用 <link> 引、排在首帧脚本之后：开发形态下也阻塞首帧
  assert.ok(html.indexOf("getItem('quilt:theme')") < html.indexOf('<link rel="stylesheet" href="/src/styles.css"'));
});
