import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenInstructionHistory, componentInstructionHistory, MAX_PRIOR_INSTRUCTIONS, MAX_PRIOR_INSTRUCTION_CHARS,
  editUserPrompt, subtreeUserPrompt, componentUserPrompt, presetPrompt, variantPrompt, missingPagePrompt, annotationsPrompt,
  LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, type HistoryJob, type HistoryRevision,
} from '@quilt/core';

// 一条线性修订链：每版一个作业，最后一版是 current
function chain(jobs: HistoryJob[]): { revisions: HistoryRevision[]; current: string } {
  const revisions = jobs.map((j, i) => ({ id: `r${i}`, parentRevisionId: i ? `r${i - 1}` : null, jobId: j.id }));
  return { revisions, current: `r${jobs.length - 1}` };
}
const edit = (id: string, prompt: string): HistoryJob => ({ id, kind: 'edit_screens', input: { prompt, screenIds: ['s'] } });

test('屏：最多 18 条、从新到旧', () => {
  const jobs = Array.from({ length: 20 }, (_, i) => edit(`e${i}`, `第 ${i} 轮`));
  const { revisions, current } = chain(jobs);
  const out = screenInstructionHistory(current, revisions, jobs);
  assert.equal(MAX_PRIOR_INSTRUCTIONS, 18);
  assert.equal(out.length, 18);
  assert.equal(out[0], '第 19 轮');
  assert.equal(out[17], '第 2 轮');
});

test('单条超过 500 字截到 499 字加省略号；连续空白并成一个空格', () => {
  const long = '字'.repeat(600);
  const jobs = [edit('a', long), edit('b', '  第一行\n\n第二行\t 结尾  ')];
  const { revisions, current } = chain(jobs);
  const [b, a] = screenInstructionHistory(current, revisions, jobs);
  assert.equal(MAX_PRIOR_INSTRUCTION_CHARS, 500);
  assert.equal([...a].length, 500);
  assert.ok(a.endsWith('…') && a.startsWith('字字'));
  assert.equal(b, '第一行 第二行 结尾');
  // 按字符（码点）数，不按 UTF-16 码元：emoji 不被劈成半个
  const emoji = '😀'.repeat(501);
  const e = screenInstructionHistory('r0', [{ id: 'r0', parentRevisionId: null, jobId: 'x' }], [edit('x', emoji)])[0];
  assert.equal([...e].length, 500);
  assert.equal(e, `${'😀'.repeat(499)}…`);
});

test('系统动作不进：设计系统回刷、组件回流、入口屏补链、ingest；预设轮次只取附加要求', () => {
  const jobs: HistoryJob[] = [
    { id: 'g', kind: 'generate', input: { prompt: '一个外卖应用的首页', count: 1 } },
    edit('e1', '把标题改成「我的订单」'),
    { id: 'ds', kind: 'apply_design_system', input: { screenIds: 'all' } },
    { id: 'c', kind: 'edit_component', input: { componentId: 'k', prompt: '底栏去掉圆点' } },
    { id: 'g2', kind: 'generate', input: { prompt: '加一个设置页', count: 1 } }, // 造别的屏时顺手改了这屏的跳转（非链根）
    { id: 'in', kind: 'ingest_screen', input: { name: 'x', route: '/x', html: '<div></div>' } },
    edit('lr', LINK_REPAIR_PROMPT),
    edit('cv', presetPrompt(CONVENTIONS_REGENERATE_PROMPT, '按钮统一用胶囊形')),
  ];
  const { revisions, current } = chain(jobs);
  assert.deepEqual(screenInstructionHistory(current, revisions, jobs), ['按钮统一用胶囊形', '把标题改成「我的订单」', '一个外卖应用的首页']);
});

test('批注轮次写成「批注：「锚点」→ 说明」，不带 qid；锚点为空只写说明', () => {
  const items = [{ qid: 'q12', note: '按钮圆角改小', anchorText: 'Primary action' }, { qid: 'q3', note: '标题加粗', anchorText: '' }];
  const jobs: HistoryJob[] = [{ id: 'a', kind: 'edit_screens', input: { prompt: annotationsPrompt(items), screenIds: ['s'], annotations: items.map(({ note, anchorText }) => ({ note, anchorText })) } }];
  const out = screenInstructionHistory('r0', chain(jobs).revisions, jobs);
  assert.deepEqual(out, ['批注：「Primary action」→ 按钮圆角改小；标题加粗']);
  assert.ok(!out[0].includes('q12') && !out[0].includes('data-qid'));
});

test('回溯：父修订是被回溯到的那一版，已放弃分支上的指令不在；没有作业的修订跳过、链照常往上走', () => {
  const jobs: HistoryJob[] = [{ id: 'g', kind: 'generate', input: { prompt: '首页', count: 1 } }, edit('e1', '加搜索框'), edit('e2', '加促销横幅'), edit('e3', '标题居中')];
  const revisions: HistoryRevision[] = [
    { id: 'r1', parentRevisionId: null, jobId: 'g' },
    { id: 'r2', parentRevisionId: 'r1', jobId: 'e1' },
    { id: 'r3', parentRevisionId: 'r2', jobId: 'e2' },
    { id: 'r4', parentRevisionId: 'r2', jobId: null }, // 回溯到 r2
    { id: 'r5', parentRevisionId: 'r4', jobId: null }, // 元素直改
    { id: 'r6', parentRevisionId: 'r5', jobId: 'e3' },
  ];
  assert.deepEqual(screenInstructionHistory('r4', revisions, jobs), ['加搜索框', '首页']);
  assert.deepEqual(screenInstructionHistory('r6', revisions, jobs), ['标题居中', '加搜索框', '首页']);
  assert.deepEqual(screenInstructionHistory('r3', revisions, jobs), ['加促销横幅', '加搜索框', '首页']);
  assert.deepEqual(screenInstructionHistory(null, revisions, jobs), []);
});

test('候选：同一作业的兄弟版只算一次；局部重生成、聊天、造变体 / 补缺失页的原话', () => {
  const jobs: HistoryJob[] = [
    { id: 'v', kind: 'generate', input: { prompt: variantPrompt('空态'), count: 1, variantOf: 'd', variantName: '空态' } },
    { id: 'c', kind: 'edit_screens', input: { prompt: '换成卡片', screenIds: ['s'], versions: 2 } },
    { id: 'sub', kind: 'regenerate_subtree', input: { prompt: '标题字号加大', screenId: 's', qid: 'q1', expectedRevisionId: 'x' } },
    { id: 'chat', kind: 'chat', input: { prompt: '这屏太挤了，留白多一点' } },
  ];
  const revisions: HistoryRevision[] = [
    { id: 'r1', parentRevisionId: null, jobId: 'v' },
    { id: 'c0', parentRevisionId: 'r1', jobId: 'c' },
    { id: 'c1', parentRevisionId: 'r1', jobId: 'c' },
    { id: 'r3', parentRevisionId: 'c1', jobId: 'sub' },
    { id: 'r4', parentRevisionId: 'r3', jobId: 'chat' },
  ];
  assert.deepEqual(screenInstructionHistory('r4', revisions, jobs), ['这屏太挤了，留白多一点', '局部重生成：标题字号加大', '换成卡片']);
  const named: HistoryJob[] = [{ id: 'v', kind: 'generate', input: { prompt: '列表为空时给一个插画和「去逛逛」按钮', count: 1, variantOf: 'd', variantName: '空态' } }];
  assert.deepEqual(screenInstructionHistory('r1', [revisions[0]], named), ['列表为空时给一个插画和「去逛逛」按钮']);
  const missing: HistoryJob[] = [{ id: 'v', kind: 'generate', input: { prompt: presetPrompt(missingPagePrompt('/cart'), '要有优惠券入口'), count: 1, route: '/cart' } }];
  assert.deepEqual(screenInstructionHistory('r1', [revisions[0]], missing), ['要有优惠券入口']);
  const bare: HistoryJob[] = [{ id: 'v', kind: 'generate', input: { prompt: missingPagePrompt('/cart'), count: 1, route: '/cart' } }];
  assert.deepEqual(screenInstructionHistory('r1', [revisions[0]], bare), []);
});

test('组件：按 componentId 取此前成功的改组件作业，从新到旧、最多 18 条', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 22, m));
  const job = (id: string, componentId: string, prompt: string, status: string, m: number) => ({ id, kind: 'edit_component', status, createdAt: at(m), input: { componentId, prompt } });
  const jobs = [
    job('1', 'tab', '点击的背景高亮就行，不需要下面的那个圆点', 'succeeded', 45),
    job('2', 'tab', '切换加 200ms 过渡', 'failed', 46),
    job('3', 'nav', '顶栏标题居中', 'succeeded', 47),
    job('4', 'tab', '选中项文字加粗', 'succeeded', 48),
    job('5', 'tab', '还在跑', 'running', 49),
    job('6', 'tab', '被取消', 'cancelled', 49),
    { id: '7', kind: 'edit_screens', status: 'succeeded', createdAt: at(50), input: { prompt: '改屏', screenIds: ['s'] } },
  ];
  assert.deepEqual(componentInstructionHistory('tab', jobs), ['选中项文字加粗', '点击的背景高亮就行，不需要下面的那个圆点']);
  assert.deepEqual(componentInstructionHistory('nav', jobs), ['顶栏标题居中']);
  const many = Array.from({ length: 20 }, (_, i) => job(`m${i}`, 'tab', `第 ${i} 轮`, 'succeeded', i));
  const out = componentInstructionHistory('tab', many);
  assert.equal(out.length, 18);
  assert.equal(out[0], '第 19 轮');
});

test('提示词：有历史时带编号块（新到旧），没有时不出这一块', () => {
  const block = (s: string, subject: string) => s.slice(s.indexOf(`EARLIER INSTRUCTIONS ALREADY APPLIED TO ${subject}`)).split('\n').slice(0, 3);
  const e = editUserPrompt('首页', '/home', '<div></div>', '标题居中', ['加搜索框', '首页']);
  assert.deepEqual(block(e, 'THIS SCREEN'), ['EARLIER INSTRUCTIONS ALREADY APPLIED TO THIS SCREEN (most recent first; keep honoring them unless the new instruction overrides one):', '1. 加搜索框', '2. 首页']);
  assert.ok(e.indexOf('标题居中') < e.indexOf('EARLIER') && e.indexOf('EARLIER') < e.indexOf('CURRENT HTML'));
  const s = subtreeUserPrompt('首页', '/home', '<h1>Home</h1>', '字号加大', ['加搜索框']);
  assert.deepEqual(block(s, 'THIS SCREEN').slice(1, 2), ['1. 加搜索框']);
  assert.ok(s.indexOf('EARLIER') < s.indexOf('CURRENT ELEMENT'));
  const c = componentUserPrompt({ name: 'TabBar', instruction: '图标换成线性', currentHtml: '<nav></nav>', usedBy: ['首页'], prior: ['去掉圆点'] });
  assert.deepEqual(block(c, 'THIS COMPONENT').slice(1, 2), ['1. 去掉圆点']);
  assert.ok(c.indexOf('EARLIER') < c.indexOf('CURRENT HTML'));
  for (const p of [editUserPrompt('首页', '/home', '<div></div>', 'x'), subtreeUserPrompt('首页', '/home', '<h1></h1>', 'x'), componentUserPrompt({ name: 'T', instruction: 'x', currentHtml: '<nav></nav>', usedBy: [] })]) assert.ok(!p.includes('EARLIER'), p);
});
