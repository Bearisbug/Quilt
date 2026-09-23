import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobDto, ScreenDto, ComponentDto } from '@quilt/core';
import { coveredScreens, jobLabel } from '../../../apps/web/src/canvas/jobs.ts';

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
