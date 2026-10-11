import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobDto } from '@quilt/core';
import { reconcileJobs, settleJob, progressText } from '../../../apps/web/src/canvas/jobTracker.ts';

const job = (id: string, runner: 'model' | 'agent' = 'model') => ({ id, kind: 'edit_screens', runner, status: 'running', input: {}, createdAt: '' }) as unknown as JobDto;
const empty = { seen: new Set<string>(), finished: new Set<string>(), trackedAt: new Map<string, number>() };

// 画布作业对账（REQ-CORE-020）：v0.76 / v0.88 记录过的几种时序
test('比作业先发出的 GET 没列出它：不撤（不闪）；之后发出的 GET 没列出它：撤（事件流假死时也能收掉，v0.88）', () => {
  const a = job('a');
  const tracked = { ...empty, trackedAt: new Map([['a', 5]]) };
  assert.deepEqual(reconcileJobs([a], tracked, [], 4).gone, [], '序号 4 的 GET 早于开始跟踪（5）');
  const r = reconcileJobs([a], tracked, [], 6);
  assert.deepEqual(r.gone, ['a']);
  assert.ok(!r.trackedAt.has('a') && !r.seen.has('a'));
});

test('别处建的作业：列出过一次之后不再列出就撤；没被跟踪过的进行中作业被认领，本机 agent 的不认领', () => {
  const r1 = reconcileJobs([], empty, [job('b'), job('c', 'agent')], 1);
  assert.deepEqual(r1.claim.map((j) => j.id), ['b']);
  assert.ok(r1.seen.has('b'));
  const r2 = reconcileJobs([job('b')], { ...empty, seen: r1.seen }, [], 2);
  assert.deepEqual(r2.gone, ['b']);
});

test('已宣告终态的作业：晚到的 GET 还列着它也不重新认领；GET 不再列出后白名单收缩', () => {
  const settled = settleJob({ ...empty, seen: new Set(['d']), trackedAt: new Map([['d', 3]]) }, 'd');
  assert.ok(settled.finished.has('d') && !settled.seen.has('d') && !settled.trackedAt.has('d'));
  const late = reconcileJobs([], settled, [job('d')], 4);
  assert.deepEqual(late.claim, [], '死作业不能被认领回来');
  assert.ok(late.finished.has('d'));
  assert.ok(!reconcileJobs([], late, [], 5).finished.has('d'));
});

test('progressText：聊天的工具调用、重试、组件回刷、各类作业开跑、打包完成、缺省排队中', () => {
  assert.equal(progressText('chat', { stage: 'chat', step: '读了 Home 的大纲' }), '读了 Home 的大纲');
  assert.equal(progressText('generate', { stage: 'retry', attempt: 2 }), '供应商波动，正在重试（第 2 次）…');
  assert.equal(progressText('edit_component', { stage: 'component_synced', screens: 3 }), '已同步 3 屏，正在截图…');
  assert.equal(progressText('regenerate_subtree', { stage: 'running' }), '正在改屏…');
  assert.equal(progressText('generate', { stage: 'running' }), '正在规划屏幕…');
  assert.equal(progressText('export_prototype', { stage: 'exported' }), '打包完成');
  assert.equal(progressText('generate', {}), '排队中…');
});
