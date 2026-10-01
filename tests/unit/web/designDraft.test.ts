import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConventions } from '@quilt/core';
import { rebase, sameFields, type Fields } from '../../../apps/web/src/panels/designDraft.ts';

// 设计系统面板的草稿（REQ-EDIT-003 v0.78）：已保存的那份变了，只同步没动过的格子
const md0 = withConventions('# App\n\nIntro', ['按钮一律圆角胶囊', '标题一律 text-xl']);
const base: Fields = { seed: '#3B5BDB', font: 'Inter', fontSource: 'google', fontUrl: '', radius: 'default', md: md0, palette: null, colorMode: 'light', brief: '一个记账 APP' };

test('没动过的格子跟上新值，动过的留着草稿', () => {
  const form = { ...base, seed: '#123456' };
  const next = { ...base, font: 'Manrope', radius: 'round' as const };
  const out = rebase(form, base, next, []);
  assert.equal(out.seed, '#123456');
  assert.equal(out.font, 'Manrope');
  assert.equal(out.radius, 'round');
});

test('删了一条约定：DESIGN.md 草稿里的约定节换成新的，草稿其余部分不动', () => {
  const form = { ...base, md: md0.replace('Intro', 'Intro，草稿里改过') };
  const next = { ...base, md: withConventions('# App\n\nIntro', ['标题一律 text-xl']) };
  const out = rebase(form, base, next, []);
  assert.ok(out.md.includes('Intro，草稿里改过'));
  assert.ok(out.md.includes('- 标题一律 text-xl'));
  assert.ok(!out.md.includes('按钮一律圆角胶囊'));
});

test('约定没变、别的内容变了：DESIGN.md 草稿原样留着', () => {
  const form = { ...base, md: `${md0}\n草稿` };
  const next = { ...base, md: md0.replace('Intro', '别处改的') };
  assert.equal(rebase(form, base, next, []).md, form.md);
});

test('刚保存的那几格强制取服务端的值（种子色被转成大写）', () => {
  const form = { ...base, seed: '#abcdef', md: `${md0}\n改了` };
  const next = { ...base, seed: '#ABCDEF', md: `${md0}\n改了` };
  const out = rebase(form, base, next, ['seed', 'md']);
  assert.equal(out.seed, '#ABCDEF');
  assert.deepEqual(out, next);
});

// v0.83：比较前按保存时的同一规则规范化——种子色不分大小写、字体族名与样式表地址去首尾空格
test('只差大小写 / 首尾空格的两份算同一份，真改了的不算', () => {
  assert.ok(sameFields({ ...base, seed: '#3b5bdb', font: '  Inter ', fontUrl: ' https://fonts.example/a.css ' }, { ...base, fontUrl: 'https://fonts.example/a.css' }));
  assert.ok(!sameFields({ ...base, seed: '#3b5bdc' }, base));
  assert.ok(!sameFields({ ...base, md: `${base.md} ` }, base));
});

test('只差大小写 / 空格的格子算没动过：已保存的那份变了照样跟上新值', () => {
  const form = { ...base, seed: '#3b5bdb', font: 'Inter ' };
  const next = { ...base, seed: '#123456', font: 'Manrope' };
  const out = rebase(form, base, next, []);
  assert.equal(out.seed, '#123456');
  assert.equal(out.font, 'Manrope');
});
