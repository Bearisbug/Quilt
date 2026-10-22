import type { JobKind, UsageByModel, UsageRange, UsageStatsDto } from '@quilt/core';

// 用量看板的汇总（API-CORE-052，ADR-036）：纯函数，不碰库——SQL 取回这个用户的全部台账行，在这里切天、归模型、排行。
// 本机台账是千级行，全量取回比按范围拼几条聚合 SQL 简单，也让切天与归并规则能单测

export type UsageRow = {
  at: Date; tokensIn: number; tokensOut: number; screens: number;
  driver: string | null; model: string | null;
  projectId: string | null; projectName: string | null; kind: string | null; channelId: string | null; channelLabel: string | null;
};
/** 通道表里的一行；`kind` 与驱动名一一相同（anthropic / gemini / openai / agent-sdk / codex） */
export type ChannelRef = { id: string; label: string; kind: string; model: string };
export type ProjectRef = { id: string; name: string; kind: string };

const DAY_MS = 86_400_000;
/** 某一时刻在 utcOffset（分钟，东正西负）那个时区的自然日，YYYY-MM-DD */
export const dayOf = (at: Date, utcOffset: number): string => new Date(at.getTime() + utcOffset * 60_000).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
/** 这一天所在那周的周一 */
export const mondayOf = (day: string): string => addDays(day, -((new Date(Date.parse(day)).getUTCDay() + 6) % 7));

/** 「全部」的自然日数超过它就按周汇总 */
export const WEEKLY_AFTER_DAYS = 60;
export const ACTIVITY_DAYS = 90;

/** 所选范围：7d / 30d 含今天；all 从第一条台账那天到今天（没有台账时只有今天） */
export function rangeSpan(range: UsageRange, today: string, firstDay: string | null): { from: string; to: string; unit: 'day' | 'week' } {
  if (range === '7d') return { from: addDays(today, -6), to: today, unit: 'day' };
  if (range === '30d') return { from: addDays(today, -29), to: today, unit: 'day' };
  const from = firstDay && firstDay < today ? firstDay : today;
  return { from, to: today, unit: daysBetween(from, today) + 1 > WEEKLY_AFTER_DAYS ? 'week' : 'day' };
}

/** 范围里的格子：按天一天一格，按周从周一起、每格七天；没有用量的日子也给一格 */
export function bucketSlots(from: string, to: string, unit: 'day' | 'week'): { from: string; to: string }[] {
  const step = unit === 'day' ? 1 : 7;
  const slots: { from: string; to: string }[] = [];
  for (let d = unit === 'day' ? from : mondayOf(from); d <= to; d = addDays(d, step)) slots.push({ from: d, to: addDays(d, step - 1) });
  return slots;
}

/** 模型键：有通道 id 就是它；没有时（作业走服务端缺省驱动）恰有一个现存通道同驱动同模型就归它，否则 `driver:model` */
export function modelKeyOf(row: Pick<UsageRow, 'channelId' | 'driver' | 'model'>, channels: ChannelRef[]): string {
  if (row.channelId) return row.channelId;
  const same = channels.filter((c) => c.kind === row.driver && c.model === row.model);
  return same.length === 1 ? same[0].id : `${row.driver ?? ''}:${row.model ?? ''}`;
}

const add = (m: UsageByModel, key: string | null, n: number) => { if (key && n) m[key] = (m[key] ?? 0) + n; };
/** 没调过模型的作业：台账没记驱动；v1.28 之前的导出与套用设计系统记成了缺省驱动，按 kind 认出来。计入次数与任务类型，不归任何模型 */
const NO_MODEL_KINDS = new Set(['export_prototype', 'apply_design_system']);
const usedModel = (r: Pick<UsageRow, 'driver' | 'kind'>) => !!r.driver && !NO_MODEL_KINDS.has(r.kind ?? '');
const tokensOf = (r: UsageRow) => r.tokensIn + r.tokensOut;

export function summarizeUsage(input: { rows: UsageRow[]; channels: ChannelRef[]; projects: ProjectRef[]; range: UsageRange; utcOffset: number; now: Date }): Omit<UsageStatsDto, 'inflight'> {
  const { channels, range, utcOffset } = input;
  const rows = [...input.rows].sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((r) => ({ ...r, day: dayOf(r.at, utcOffset), key: usedModel(r) ? modelKeyOf(r, channels) : null }));
  const today = dayOf(input.now, utcOffset);
  const span = rangeSpan(range, today, rows[0]?.day ?? null);
  const inRange = rows.filter((r) => r.day >= span.from && r.day <= span.to);
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const sketchbook = (id: string | null) => !!id && projectById.get(id)?.kind === 'sketchbook';

  // 模型：全部时间里出现过的都列，按全部时间的 Token 排序（界面按这个顺序配色，换范围不变色）；数是范围内的
  const all = new Map<string, { tokens: number; last: (typeof rows)[number]; label: string | null }>();
  for (const r of rows) {
    if (!r.key) continue;
    const m = all.get(r.key) ?? { tokens: 0, last: r, label: null };
    m.tokens += tokensOf(r); m.last = r; m.label = r.channelLabel ?? m.label;
    all.set(r.key, m);
  }
  const models = [...all.entries()].sort(([ka, a], [kb, b]) => b.tokens - a.tokens || ka.localeCompare(kb)).map(([key, m]) => {
    const ch = channelById.get(key);
    const mine = inRange.filter((r) => r.key === key);
    const counts = { tokensIn: mine.reduce((s, r) => s + r.tokensIn, 0), tokensOut: mine.reduce((s, r) => s + r.tokensOut, 0), jobs: mine.length, lastAt: mine.at(-1)?.at.toISOString() ?? null };
    if (ch) return { key, label: ch.label, modelId: ch.model, driver: ch.kind, deleted: false, ...counts };
    const modelId = m.last.model ?? '';
    // 通道已删：用快照里的显示名；没有通道 id 的键（同驱动同模型的通道没有或不止一个）：没有这样的通道才算删了
    const deleted = m.last.channelId ? true : !channels.some((c) => c.kind === m.last.driver && c.model === m.last.model);
    return { key, label: m.label ?? modelId, modelId, driver: m.last.driver ?? '', deleted, ...counts };
  });

  const slots = bucketSlots(span.from, span.to, span.unit);
  const buckets = slots.map((s) => ({ ...s, jobs: 0, tokens: {} as UsageByModel }));
  for (const r of inRange) {
    const b = buckets[Math.floor(daysBetween(slots[0].from, r.day) / (span.unit === 'day' ? 1 : 7))];
    b.jobs += 1; add(b.tokens, r.key, tokensOf(r));
  }

  // 项目：还在的用现在的名字，删了用最近一条快照；没有项目快照的旧记录合成 id 为 null 的一项
  const snapName = new Map<string, string>();
  for (const r of rows) if (r.projectId && r.projectName) snapName.set(r.projectId, r.projectName);
  const byProject = new Map<string | null, UsageStatsDto['projects'][number]>();
  for (const r of inRange) {
    let p = byProject.get(r.projectId);
    if (!p) {
      const live = r.projectId ? projectById.get(r.projectId) : undefined;
      p = live ? { id: live.id, name: live.name, deleted: false, sketchbook: live.kind === 'sketchbook', tokens: 0, screens: 0, byModel: {} }
        : { id: r.projectId, name: r.projectId ? snapName.get(r.projectId) ?? null : null, deleted: true, sketchbook: false, tokens: 0, screens: 0, byModel: {} };
      byProject.set(r.projectId, p);
    }
    p.tokens += tokensOf(r); p.screens += r.screens; add(p.byModel, r.key, tokensOf(r));
  }
  const projects = [...byProject.values()].sort((a, b) => b.tokens - a.tokens || b.screens - a.screens);

  const byKind = new Map<string, UsageStatsDto['kinds'][number]>();
  for (const r of inRange) {
    const kind = (r.kind ?? 'other') as JobKind | 'other';
    const k = byKind.get(kind) ?? { kind, jobs: 0, byModel: {} };
    k.jobs += 1; add(k.byModel, r.key, 1);
    byKind.set(kind, k);
  }
  const kinds = [...byKind.values()].sort((a, b) => b.jobs - a.jobs || a.kind.localeCompare(b.kind));

  // 活动日历：固定含今天的近 90 天，与 range 无关
  const actFrom = addDays(today, -(ACTIVITY_DAYS - 1));
  const days = Array.from({ length: ACTIVITY_DAYS }, (_, i) => ({ date: addDays(actFrom, i), jobs: 0 }));
  const actTokens: UsageByModel = {};
  for (const r of rows) {
    if (r.day < actFrom || r.day > today) continue;
    days[daysBetween(actFrom, r.day)].jobs += 1; add(actTokens, r.key, tokensOf(r));
  }
  const topModel = Object.entries(actTokens).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
  const actTotal = Object.values(actTokens).reduce((s, n) => s + n, 0);
  const topShare = topModel && actTotal ? actTokens[topModel] / actTotal : null;

  return {
    range, from: span.from, to: span.to, unit: span.unit,
    totals: {
      jobs: inRange.length,
      tokensIn: inRange.reduce((s, r) => s + r.tokensIn, 0), tokensOut: inRange.reduce((s, r) => s + r.tokensOut, 0),
      screens: inRange.reduce((s, r) => s + r.screens, 0), sketchScreens: inRange.reduce((s, r) => s + (sketchbook(r.projectId) ? r.screens : 0), 0),
      maxJobTokens: inRange.reduce((s, r) => Math.max(s, tokensOf(r)), 0),
    },
    models, buckets, projects, kinds,
    activity: { from: actFrom, to: today, days, topModel, topShare },
  };
}
