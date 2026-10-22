import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, bucketSlots, dayOf, modelKeyOf, mondayOf, rangeSpan, summarizeUsage, type ChannelRef, type ProjectRef, type UsageRow } from '../../../apps/api/src/services/usageStats.ts';

// 用量看板的汇总（API-CORE-052，ADR-036）：按 utcOffset 切自然日、按周从周一起、模型键归并、删掉的项目与模型

const row = (at: string, over: Partial<UsageRow> = {}): UsageRow => ({
  at: new Date(at), tokensIn: 60, tokensOut: 40, screens: 1, driver: 'gemini', model: 'g-flash',
  projectId: null, projectName: null, kind: null, channelId: null, channelLabel: null, ...over,
});
const CH_A = '00000000-0000-4000-8000-00000000000a';
const CH_GONE = '00000000-0000-4000-8000-0000000000ff';
const P_LIVE = '00000000-0000-4000-8000-000000000001';
const P_SKETCH = '00000000-0000-4000-8000-000000000002';
const P_GONE = '00000000-0000-4000-8000-000000000003';
const channels: ChannelRef[] = [{ id: CH_A, label: 'Flash Now', kind: 'gemini', model: 'g-flash' }];
const projects: ProjectRef[] = [{ id: P_LIVE, name: 'Live Now', kind: 'app' }, { id: P_SKETCH, name: '草稿本', kind: 'sketchbook' }];
// 2026-10-21 是周三；北京时间（+480）当天 10:00
const NOW = new Date('2026-10-21T02:00:00Z');

test('dayOf：按 utcOffset 切自然日，正负偏移都跨得过午夜', () => {
  assert.equal(dayOf(new Date('2026-10-20T16:30:00Z'), 480), '2026-10-21');
  assert.equal(dayOf(new Date('2026-10-20T16:30:00Z'), 0), '2026-10-20');
  assert.equal(dayOf(new Date('2026-10-21T03:00:00Z'), -300), '2026-10-20');
  assert.equal(dayOf(new Date('2026-10-21T10:00:00Z'), 840), '2026-10-22');
  assert.equal(dayOf(new Date('2026-10-21T10:00:00Z'), -840), '2026-10-20');
});

test('mondayOf：周一是自己，周日回到前一个周一，跨月跨年照算', () => {
  assert.equal(mondayOf('2026-10-26'), '2026-10-26');
  assert.equal(mondayOf('2026-10-21'), '2026-10-19');
  assert.equal(mondayOf('2026-11-01'), '2026-10-26');
  assert.equal(mondayOf('2026-03-01'), '2026-02-23');
  assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('rangeSpan：7d / 30d 含今天；all 从第一天起，超过 60 个自然日按周', () => {
  assert.deepEqual(rangeSpan('7d', '2026-10-21', '2026-01-01'), { from: '2026-10-15', to: '2026-10-21', unit: 'day' });
  assert.deepEqual(rangeSpan('30d', '2026-10-21', null), { from: '2026-09-22', to: '2026-10-21', unit: 'day' });
  assert.deepEqual(rangeSpan('all', '2026-10-21', null), { from: '2026-10-21', to: '2026-10-21', unit: 'day' });
  assert.equal(rangeSpan('all', '2026-10-21', addDays('2026-10-21', -59)).unit, 'day');
  assert.equal(rangeSpan('all', '2026-10-21', addDays('2026-10-21', -60)).unit, 'week');
});

test('bucketSlots：按周时每格从周一起、七天一格，最后一格含今天；按天时一天一格', () => {
  const weeks = bucketSlots('2026-07-13', '2026-10-21', 'week');
  for (const w of weeks) { assert.equal(mondayOf(w.from), w.from); assert.equal(w.to, addDays(w.from, 6)); }
  assert.equal(weeks[0].from, '2026-07-13');
  assert.ok(weeks.at(-1)!.from <= '2026-10-21' && weeks.at(-1)!.to >= '2026-10-21');
  assert.equal(bucketSlots('2026-07-15', '2026-10-21', 'week')[0].from, '2026-07-13');
  const days = bucketSlots('2026-10-15', '2026-10-21', 'day');
  assert.deepEqual(days.map((d) => d.from), ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
  assert.ok(days.every((d) => d.from === d.to));
});

test('modelKeyOf：有通道 id 用它；恰有一个同驱动同模型的通道就归它；没有或不止一个时是 driver:model', () => {
  assert.equal(modelKeyOf({ channelId: CH_GONE, driver: 'gemini', model: 'g-flash' }, channels), CH_GONE);
  assert.equal(modelKeyOf({ channelId: null, driver: 'gemini', model: 'g-flash' }, channels), CH_A);
  assert.equal(modelKeyOf({ channelId: null, driver: 'openai', model: 'g-flash' }, channels), 'openai:g-flash');
  const two = [...channels, { id: 'b', label: 'Flash 2', kind: 'gemini', model: 'g-flash' }];
  assert.equal(modelKeyOf({ channelId: null, driver: 'gemini', model: 'g-flash' }, two), 'gemini:g-flash');
});

test('空台账：格子照给、排行为空、日历 90 天全 0、topModel 为 null', () => {
  for (const range of ['7d', '30d', 'all'] as const) {
    const s = summarizeUsage({ rows: [], channels, projects, range, utcOffset: 480, now: NOW });
    assert.equal(s.buckets.length, range === '7d' ? 7 : range === '30d' ? 30 : 1);
    assert.ok(s.buckets.every((b) => b.jobs === 0 && Object.keys(b.tokens).length === 0));
    assert.deepEqual([s.models, s.projects, s.kinds], [[], [], []]);
    assert.deepEqual(s.totals, { jobs: 0, tokensIn: 0, tokensOut: 0, screens: 0, sketchScreens: 0, maxJobTokens: 0 });
    assert.equal(s.activity.days.length, 90);
    assert.equal(s.activity.to, '2026-10-21');
    assert.equal(s.activity.topModel, null);
  }
});

const rows: UsageRow[] = [
  // 100 天前、没有任何快照的旧记录
  row('2026-07-13T04:00:00Z', { driver: 'stub', model: 'old-model', tokensIn: 5000, tokensOut: 0 }),
  // 走服务端缺省驱动、与通道 A 同驱动同模型：归到 A；UTC 是 10-20，北京时间已是 10-21
  row('2026-10-20T17:00:00Z', { projectId: P_LIVE, projectName: 'Live Old', kind: 'generate' }),
  row('2026-10-21T01:00:00Z', { projectId: P_LIVE, projectName: 'Live Old', kind: 'generate', channelId: CH_A, channelLabel: 'Flash Then', tokensIn: 300, tokensOut: 100, screens: 3 }),
  row('2026-10-18T01:00:00Z', { projectId: P_SKETCH, projectName: '草稿本', kind: 'generate', channelId: CH_A, screens: 2 }),
  // 删掉的项目与通道：用快照；同一项目后一条快照的名字为准
  row('2026-10-10T01:00:00Z', { projectId: P_GONE, projectName: 'Gone Before', kind: 'edit_screens', channelId: CH_GONE, channelLabel: 'Old Label', driver: 'anthropic', model: 'sonnet' }),
  row('2026-10-21T00:30:00Z', { projectId: P_GONE, projectName: 'Gone', kind: 'edit_screens', channelId: CH_GONE, channelLabel: 'Old Model', driver: 'anthropic', model: 'sonnet', screens: 0 }),
];

test('7d：今天的格子含按 utcOffset 算进来的那条；模型、项目、任务类型按范围数', () => {
  const s = summarizeUsage({ rows, channels, projects, range: '7d', utcOffset: 480, now: NOW });
  assert.equal(s.unit, 'day');
  assert.deepEqual([s.from, s.to], ['2026-10-15', '2026-10-21']);
  assert.equal(s.buckets.length, 7);
  const today = s.buckets.at(-1)!;
  assert.equal(today.from, '2026-10-21');
  assert.equal(today.jobs, 3);
  assert.deepEqual(today.tokens, { [CH_A]: 500, [CH_GONE]: 100 });
  assert.equal(s.buckets.find((b) => b.from === '2026-10-18')!.jobs, 1);
  assert.equal(s.totals.jobs, 4);
  assert.equal(s.totals.screens, 6);
  assert.equal(s.totals.sketchScreens, 2);
  assert.equal(s.totals.maxJobTokens, 400);
  // 按全部时间的 Token 排：旧模型 5000 排第一，尽管 7 天里它是 0
  assert.deepEqual(s.models.map((m) => m.key), ['stub:old-model', CH_A, CH_GONE]);
  const [old, a, gone] = s.models;
  assert.deepEqual({ label: old.label, modelId: old.modelId, deleted: old.deleted, jobs: old.jobs, lastAt: old.lastAt }, { label: 'old-model', modelId: 'old-model', deleted: true, jobs: 0, lastAt: null });
  assert.deepEqual({ label: a.label, modelId: a.modelId, driver: a.driver, deleted: a.deleted, jobs: a.jobs, tokensIn: a.tokensIn, tokensOut: a.tokensOut }, { label: 'Flash Now', modelId: 'g-flash', driver: 'gemini', deleted: false, jobs: 3, tokensIn: 420, tokensOut: 180 });
  assert.equal(a.lastAt, '2026-10-21T01:00:00.000Z');
  assert.deepEqual({ label: gone.label, modelId: gone.modelId, driver: gone.driver, deleted: gone.deleted, jobs: gone.jobs }, { label: 'Old Model', modelId: 'sonnet', driver: 'anthropic', deleted: true, jobs: 1 });
  assert.deepEqual(s.projects.map((p) => [p.id, p.name, p.deleted, p.sketchbook, p.tokens, p.screens]), [
    [P_LIVE, 'Live Now', false, false, 500, 4],
    [P_SKETCH, '草稿本', false, true, 100, 2],
    [P_GONE, 'Gone', true, false, 100, 0],
  ]);
  assert.deepEqual(s.projects[0].byModel, { [CH_A]: 500 });
  assert.deepEqual(s.kinds.map((k) => [k.kind, k.jobs]), [['generate', 3], ['edit_screens', 1]]);
  assert.deepEqual(s.kinds[0].byModel, { [CH_A]: 3 });
});

test('同一批台账换 utcOffset：那条 UTC 17:00 的落到前一天', () => {
  const s = summarizeUsage({ rows, channels, projects, range: '7d', utcOffset: -300, now: NOW });
  assert.equal(s.to, '2026-10-20');
  assert.equal(s.buckets.at(-1)!.jobs, 3);
  assert.equal(s.buckets.at(-1)!.from, '2026-10-20');
});

test('all：超过 60 天按周，每格从周一起、最后一格含今天；没有快照的记录归 id 为 null 的项目与 other', () => {
  const s = summarizeUsage({ rows, channels, projects, range: 'all', utcOffset: 480, now: NOW });
  assert.equal(s.unit, 'week');
  assert.equal(s.from, '2026-07-13');
  assert.ok(s.buckets.every((b) => mondayOf(b.from) === b.from));
  assert.ok(s.buckets.at(-1)!.from <= '2026-10-21' && s.buckets.at(-1)!.to >= '2026-10-21');
  assert.equal(s.buckets.reduce((n, b) => n + b.jobs, 0), rows.length);
  assert.equal(s.buckets.reduce((n, b) => n + Object.values(b.tokens).reduce((x, y) => x + y, 0), 0), rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0));
  // 第一周（7-13 那周）只有那条旧记录；中间没有用量的周也给格子
  assert.deepEqual(s.buckets[0], { from: '2026-07-13', to: '2026-07-19', jobs: 1, tokens: { 'stub:old-model': 5000 } });
  assert.equal(s.buckets[1].jobs, 0);
  const orphan = s.projects.find((p) => p.id === null)!;
  assert.deepEqual({ name: orphan.name, deleted: orphan.deleted, tokens: orphan.tokens }, { name: null, deleted: true, tokens: 5000 });
  assert.deepEqual(s.kinds.map((k) => k.kind).sort(), ['edit_screens', 'generate', 'other']);
  const gone = s.projects.find((p) => p.id === P_GONE)!;
  assert.equal(gone.name, 'Gone');
  assert.equal(gone.tokens, 200);
  // 日历与 range 无关：90 天，旧记录在窗外
  assert.equal(s.activity.days.length, 90);
  assert.equal(s.activity.from, '2026-07-24');
  assert.equal(s.activity.days.reduce((n, d) => n + d.jobs, 0), rows.length - 1);
  assert.equal(s.activity.topModel, CH_A);
});

test('all 跨度不到 60 天时按天，从第一条那天起', () => {
  const s = summarizeUsage({ rows: rows.slice(1), channels, projects, range: 'all', utcOffset: 480, now: NOW });
  assert.equal(s.unit, 'day');
  assert.equal(s.from, '2026-10-10');
  assert.equal(s.buckets.length, 12);
});

test('同驱动同模型的通道没有了：缺省驱动的那几条不再归通道，是 driver:model 且算删了；有两个时不算删', () => {
  const none = summarizeUsage({ rows: rows.slice(1, 2), channels: [], projects, range: '7d', utcOffset: 480, now: NOW });
  assert.deepEqual(none.models.map((m) => [m.key, m.label, m.deleted]), [['gemini:g-flash', 'g-flash', true]]);
  const two = [...channels, { id: 'b', label: 'Flash 2', kind: 'gemini', model: 'g-flash' }];
  const both = summarizeUsage({ rows: rows.slice(1, 2), channels: two, projects, range: '7d', utcOffset: 480, now: NOW });
  assert.deepEqual(both.models.map((m) => [m.key, m.deleted]), [['gemini:g-flash', false]]);
});

test('没调过模型的作业：计入次数、任务类型与日历，不归任何模型（v1.28）', () => {
  const at = '2026-10-21T01:00:00Z';
  const rows = [
    row(at, { kind: 'edit_screens', projectId: P_LIVE }), row(at, { kind: 'edit_screens', projectId: P_LIVE }), row(at, { kind: 'edit_screens', projectId: P_LIVE }),
    // v1.28 之前的导出记成了缺省驱动，0 token
    row(at, { kind: 'export_prototype', projectId: P_LIVE, tokensIn: 0, tokensOut: 0, screens: 0 }),
    row(at, { kind: 'export_prototype', projectId: P_LIVE, tokensIn: 0, tokensOut: 0, screens: 0 }),
    // v1.28 起不记驱动与模型
    row(at, { kind: 'export_prototype', projectId: P_LIVE, tokensIn: 0, tokensOut: 0, screens: 0, driver: null, model: null }),
  ];
  const s = summarizeUsage({ rows, channels, projects, range: '7d', utcOffset: 480, now: NOW });
  assert.equal(s.totals.jobs, 6);
  assert.deepEqual(s.models.map((m) => [m.key, m.jobs]), [[CH_A, 3]], '只有真调过模型的 3 次归到通道，没有空名的模型');
  const exp = s.kinds.find((k) => k.kind === 'export_prototype')!;
  assert.equal(exp.jobs, 3);
  assert.deepEqual(exp.byModel, {});
  assert.equal(s.activity.days.at(-1)!.jobs, 6);
  assert.equal(s.activity.topModel, CH_A);
});
