import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobDto, ScreenDto, ComponentDto } from '@quilt/core';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, presetPrompt } from '@quilt/core';
import { coveredScreens, jobLabel, roundPreset, presetView } from '../../../apps/web/src/canvas/jobs.ts';

const job = (kind: string, input: Record<string, unknown>) => ({ id: 'j', kind, input, status: 'running', createdAt: '' }) as unknown as JobDto;
const screens = [{ id: 's1', name: '首页' }, { id: 's2', name: '详情' }] as ScreenDto[];
const components = [{ id: 'c1', name: 'TabBar', usedBy: ['s2'] }] as unknown as ComponentDto[];

test('coveredScreens：按作业类型从 input 反推会改到哪些屏', () => {
  assert.deepEqual(coveredScreens(job('edit_screens', { screenIds: 'all' }), ['s1', 's2']), ['s1', 's2']);
  assert.deepEqual(coveredScreens(job('edit_screens', { screenIds: ['s2'] }), ['s1', 's2']), ['s2']);
  assert.deepEqual(coveredScreens(job('apply_design_system', { screenIds: 'all' }), ['s1']), ['s1']);
  assert.deepEqual(coveredScreens(job('regenerate_subtree', { screenId: 's1' }), []), ['s1']);
  assert.deepEqual(coveredScreens(job('generate', { fromScreenId: 's1' }), []), ['s1'], '带来源屏的造屏占着入口屏');
  assert.deepEqual(coveredScreens(job('generate', {}), ['s1']), []);
  assert.deepEqual(coveredScreens(job('edit_component', { componentId: 'c1' }), [], components), ['s2']);
  assert.deepEqual(coveredScreens(job('export_prototype', {}), ['s1']), []);
});

test('jobLabel：在跑作业行的文案', () => {
  assert.equal(jobLabel(job('generate', { count: 'auto' }), screens, []), '造一组屏');
  assert.equal(jobLabel(job('generate', { count: 2, versions: 3 }), screens, []), '造 2 屏 × 3 版');
  assert.equal(jobLabel(job('edit_screens', { screenIds: ['s1'] }), screens, []), '改「首页」');
  assert.equal(jobLabel(job('edit_screens', { screenIds: 'all', versions: 2 }), screens, []), '改全部 2 屏 × 2 版');
  assert.equal(jobLabel(job('regenerate_subtree', { screenId: 'zz' }), screens, []), '重做「已删除的屏」的一块');
  assert.equal(jobLabel(job('chat', { prompt: 'x'.repeat(30) }), screens, []), `聊「${'x'.repeat(20)}…」`);
  assert.equal(jobLabel(job('edit_component', { componentId: 'c9' }), screens, components), '改组件「已删除的组件」');
});

test('roundPreset：系统代发轮次按作业输入还原隐藏参数与正文（REQ-CORE-026 v0.74）', () => {
  assert.deepEqual(roundPreset(job('generate', { prompt: 'spinner', variantOf: 's1', variantName: 'Loading' })), { preset: { kind: 'variant', variantOf: 's1', variantName: 'Loading' }, text: 'spinner' });
  assert.equal(roundPreset(job('generate', { prompt: 'The Loading state', variantOf: 's1', variantName: 'Loading' }))?.text, '', '弹层留空时用的默认提示填回为空');
  assert.deepEqual(roundPreset(job('generate', { prompt: 'Screen for route /help', route: '/help', fromScreenId: 's1' })), { preset: { kind: 'missing', route: '/help', fromScreenId: 's1' }, text: '' });
  assert.deepEqual(roundPreset(job('edit_screens', { prompt: LINK_REPAIR_PROMPT, screenIds: ['s1'] })), { preset: { kind: 'link_repair' }, text: '' });
  assert.deepEqual(roundPreset(job('edit_screens', { prompt: presetPrompt(CONVENTIONS_REGENERATE_PROMPT, '衬线'), screenIds: ['s1'] })), { preset: { kind: 'conventions' }, text: '衬线' });
  assert.equal(roundPreset(job('edit_screens', { prompt: '改成深色', screenIds: ['s1'] })), null);
  assert.equal(roundPreset(job('generate', { prompt: '做一个设置页', anchor: { x: 0, y: 0 } })), null);
});

test('presetView：胶囊文字、动词行', () => {
  const v = presetView({ kind: 'variant', variantOf: 's1', variantName: 'Loading' }, screens, 0, 2);
  assert.equal(v.label, '「首页」的 Loading 变体');
  assert.equal(v.verb, '出变体 1 屏 × 2 版');
  assert.equal(presetView({ kind: 'missing', route: '/help' }, screens, 0, 1).label, '缺失页 /help');
  assert.equal(presetView({ kind: 'missing', route: '/help' }, screens, 0, 1).verb, '造 1 屏 · /help');
  assert.equal(presetView({ kind: 'link_repair' }, screens, 3, 1).verb, '补链 3 屏');
  assert.equal(presetView({ kind: 'conventions' }, screens, 1, 2).verb, '按新约定重生成 1 屏 × 2 版');
});
