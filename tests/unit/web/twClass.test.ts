import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RADIUS_SCALES, tokensFromSeed } from '@quilt/core';
import { explainClass, stepClass, withColorToken, sameClasses } from '../../../apps/web/src/lib/twClass.ts';

const sharp = { tokens: tokensFromSeed('#3B5BDB', { radiusScale: 'sharp' }) };
const round = { tokens: { ...sharp.tokens, radius: { ...RADIUS_SCALES.round } } };
const text = (cls: string, ctx = sharp) => explainClass(cls, ctx).text;

test('间距、尺寸按 Tailwind 刻度换算成 px，负值、分数、任意值照写', () => {
  assert.equal(text('px-6'), '左右内边距 24px');
  assert.equal(text('h-12'), '高度 48px');
  assert.equal(text('-mt-2'), '上外边距 -8px');
  assert.equal(text('w-1/2'), '宽度 50%');
  assert.equal(text('w-[120px]'), '宽度 120px');
  assert.equal(text('gap-x-3'), '列间隙 12px');
  assert.equal(text('min-w-0'), '最小宽度 0px');
  assert.equal(text('max-w-2xl'), '最大宽度 672px');
  assert.equal(text('mx-auto'), '左右外边距自动（水平居中）');
});

test('字号、字重、圆角与颜色：圆角四档与颜色按本项目设计系统取值', () => {
  assert.equal(text('text-sm'), '字号 14px（行高 20px）');
  assert.equal(text('font-semibold'), '字重 600');
  assert.equal(text('rounded-full'), '圆角：全圆');
  assert.equal(text('rounded-lg'), '圆角 8px（设计系统 lg 档）');
  assert.equal(text('rounded-lg', round), '圆角 28px（设计系统 lg 档）');
  assert.equal(text('rounded-xl'), '圆角 12px');
  assert.equal(text('rounded-none'), '无圆角');
  const bg = explainClass('bg-primary', sharp);
  assert.equal(bg.text, '背景色 primary');
  assert.deepEqual(bg.color, { prefix: 'bg', token: 'primary', swatch: sharp.tokens.colors.primary });
  assert.equal(text('text-on-primary'), '文字色 on-primary');
  assert.equal(text('border-outline-variant'), '边框色 outline-variant');
  assert.match(text('bg-blue-500'), /非 token 色/);
  assert.equal(explainClass('bg-blue-500', sharp).color?.token, null);
});

test('变体前缀写成条件，! 写强制，透明度修饰符写百分比', () => {
  assert.equal(text('hover:bg-primary/40'), '悬停时，背景色 primary，40% 不透明');
  assert.equal(text('md:px-4'), '宽度 ≥ 768px 时，左右内边距 16px');
  assert.equal(text('!p-2'), '内边距 8px（强制）');
  assert.equal(text('foo:p-2'), 'foo 时，内边距 8px');
});

test('对齐按同一元素有没有 flex-col 说成纵向或横向；边框宽度与边框色分开', () => {
  assert.equal(text('items-center'), '子元素纵向居中');
  assert.equal(explainClass('items-center', { ...sharp, column: true }).text, '子元素横向居中');
  assert.equal(text('justify-between'), '子元素横向两端对齐、间距均分');
  assert.equal(text('border'), '边框 1px');
  assert.equal(text('border-t-2'), '上边框 2px');
});

test('没收录的类写「未收录」', () => {
  const r = explainClass('foo-bar', sharp);
  assert.equal(r.known, false);
  assert.equal(r.text, '未收录');
});

test('换档：相邻一档，保留变体、! 与负号，到头返回 null', () => {
  assert.equal(stepClass('px-6', 1), 'px-7');
  assert.equal(stepClass('px-6', -1), 'px-5');
  assert.equal(stepClass('p-0', -1), null);
  assert.equal(stepClass('p-96', 1), null);
  assert.equal(stepClass('md:hover:px-6', 1), 'md:hover:px-7');
  assert.equal(stepClass('!-mt-2', 1), '!-mt-2.5');
  assert.equal(stepClass('text-sm', 1), 'text-base');
  assert.equal(stepClass('font-semibold', -1), 'font-medium');
  assert.equal(stepClass('shadow', 1), 'shadow-md');
  assert.equal(stepClass('shadow-sm', -1), 'shadow-none');
  assert.equal(stepClass('border', 1), 'border-2');
  assert.equal(stepClass('border-t-2', -1), 'border-t');
  assert.equal(stepClass('border-0', -1), null);
  assert.equal(stepClass('opacity-50', 1), 'opacity-55');
  assert.equal(stepClass('grid-cols-3', 1), 'grid-cols-4');
  assert.equal(stepClass('max-w-md', 1), 'max-w-lg');
  assert.equal(stepClass('bg-primary', 1), null);
  assert.equal(stepClass('flex', 1), null);
  assert.equal(stepClass('w-full', 1), null);
});

test('圆角按本项目的实际取值排序：round 档的 lg（28px）比 xl（12px）大', () => {
  assert.equal(stepClass('rounded-lg', 1, round), 'rounded-full');
  assert.equal(stepClass('rounded-xl', 1, round), 'rounded-2xl');
  assert.equal(stepClass('rounded-2xl', 1, round), 'rounded-md');
  assert.equal(stepClass('rounded-xl', -1, round), 'rounded-sm');
  assert.equal(stepClass('rounded-t-lg', 1, sharp), 'rounded-t-xl');
});

test('换 token 色保留前缀、变体与透明度；规范化后比较类名串', () => {
  assert.equal(withColorToken('hover:bg-primary/40', 'bg', 'secondary'), 'hover:bg-secondary/40');
  assert.equal(withColorToken('text-on-primary', 'text', 'on-surface'), 'text-on-surface');
  assert.equal(sameClasses('a  b', ' a b '), true);
  assert.equal(sameClasses('a b', 'b a'), false);
});
