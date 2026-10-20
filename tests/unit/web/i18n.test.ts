import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { defineMessages, tOf, getLocale, setLocale, type Bundle, type Messages } from '@/i18n';

// 界面文案（REQ-CORE-046，ui-constraints I18N-006）：每个命名空间文件中英两边键一致、插值变量一致、复数成对，文件名就是命名空间名。
// defineMessages 在编译期已挡住缺键与多键；这里在运行时再对一遍（包括类型挡不住的插值变量）
const DIR = path.resolve(import.meta.dirname, '../../../apps/web/src/i18n/locales');
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort();
const bundles = await Promise.all(files.map(async (f) => ({ file: f.slice(0, -3), bundle: (await import(path.join(DIR, f))).default as Bundle })));

const leaves = (m: Messages, prefix = ''): [string, string][] =>
  Object.entries(m).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
const vars = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();

test('命名空间文件：文件名即命名空间名，中英键一致', () => {
  assert.ok(files.length > 0);
  for (const { file, bundle } of bundles) {
    assert.equal(bundle.ns, file, `${file}.ts 应 defineMessages('${file}', …)`);
    assert.deepEqual(leaves(bundle.en).map(([k]) => k), leaves(bundle.zh).map(([k]) => k), `${file}：英文与中文的键不一致`);
  }
});

test('命名空间文件：每个键中英两边的 {{变量}} 一致，复数键 _one / _other 成对', () => {
  for (const { file, bundle } of bundles) {
    const en = new Map(leaves(bundle.en));
    for (const [k, zh] of leaves(bundle.zh)) {
      assert.deepEqual(vars(en.get(k) ?? ''), vars(zh), `${file}:${k} 的插值变量中英不一致`);
      assert.ok(zh.trim() && (en.get(k) ?? '').trim(), `${file}:${k} 有空文案`);
      const plural = k.match(/^(.*)_(one|other)$/);
      if (plural) assert.ok(en.has(`${plural[1]}_one`) && en.has(`${plural[1]}_other`), `${file}:${plural[1]} 的复数要 _one 与 _other 都写`);
    }
  }
});

test('tOf：按当时的界面语言取文案，插值与复数（单测里缺省中文）', () => {
  const b = defineMessages('unitTestNs', { hi: '你好，{{name}}', screens_one: '{{count}} 屏', screens_other: '{{count}} 屏', n: { deep: '深' } },
    { hi: 'Hi, {{name}}', screens_one: '{{count}} screen', screens_other: '{{count}} screens', n: { deep: 'Deep' } });
  const t = tOf(b);
  assert.equal(getLocale(), 'zh');
  assert.equal(t('hi', { name: '阿 Q' }), '你好，阿 Q');
  assert.equal(t('screens', { count: 1 }), '1 屏');
  assert.equal(t('n.deep'), '深');
  setLocale('en');
  try {
    assert.equal(getLocale(), 'en');
    assert.equal(t('hi', { name: 'Q' }), 'Hi, Q');
    assert.equal(t('screens', { count: 1 }), '1 screen');
    assert.equal(t('screens', { count: 3 }), '3 screens');
    assert.equal(t('n.deep'), 'Deep');
  } finally { setLocale('zh'); }
  assert.equal(t('hi', { name: 'x' }), '你好，x');
});
