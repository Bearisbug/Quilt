import type { ChannelVendor, UsageStatsDto } from '@quilt/core/browser';
import { intlLocale } from '@/i18n';

// 用量看板（FLOW-USAGE）的纯计算：日期、颜色、数字格式、日历格子。数据只来自 API-CORE-052 的一份 UsageStatsDto。
export type UsageModel = UsageStatsDto['models'][number];

// ---- 日期（接口给的是按浏览器时区切好的自然日 YYYY-MM-DD，这里一律按本地日期读写，不经 UTC） ----
export const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** 周一 = 0 … 周日 = 6 */
export const weekdayOf = (d: Date) => (d.getDay() + 6) % 7;
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000) + 1;
/** 2026-10-05 是周一：取它往后数的日子拿星期名 */
const MONDAY = new Date(2026, 9, 5);
export const weekdayName = (wd: number, style: 'short' | 'narrow') => new Intl.DateTimeFormat(intlLocale(), { weekday: style }).format(addDays(MONDAY, wd));
export const monthName = (d: Date) => new Intl.DateTimeFormat(intlLocale(), { month: 'short' }).format(d);
/** 横轴短日期：10/18 */
export const shortDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

// ---- 数字 ----
// Token 用 K / M 记（中英文一样，与样稿一致）；次数按界面语言分组
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
export const fmtTokens = (n: number) => COMPACT.format(n);
export const fmtInt = (n: number) => n.toLocaleString(intlLocale());
export const fmtAvg = (n: number) => n.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
/** 占比：大于 0 却不到 1% 的写「<1%」，不写成 0% */
export const fmtPct = (part: number, total: number) => {
  if (!total || !part) return '0%';
  const p = (part / total) * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
};
export const sumValues = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
export const tokensOf = (m: UsageModel) => m.tokensIn + m.tokensOut;

// ---- 颜色：设计系统的图表色号按 models 的顺序分配（全部时间的 Token 降序，换范围不变色），删掉的模型一律中性灰 ----
// 每号两档：line 是系列色（描边），fill 是填充色（柱段、分段条、胶囊、色块）
const SERIES = 6;
export type SeriesColor = { line: string; fill: string };
export const NEUTRAL = 'var(--semantic-color-data-viz-axis)';
export const NEUTRAL_COLOR: SeriesColor = { line: NEUTRAL, fill: NEUTRAL };
export function modelColors(models: UsageModel[]) {
  const map = new Map<string, SeriesColor>();
  let i = 0;
  for (const m of models) {
    if (m.deleted) { map.set(m.key, NEUTRAL_COLOR); continue; }
    const n = (i++ % SERIES) + 1;
    map.set(m.key, { line: `var(--semantic-color-data-viz-series-${n})`, fill: `var(--semantic-color-data-viz-series-fill-${n})` });
  }
  return (key: string) => map.get(key) ?? NEUTRAL_COLOR;
}

// 台账只有 driver，没有厂商：按 driver 取 logo；OpenAI 兼容端点可能是任何一家，用通用图标
const DRIVER_VENDOR: Record<string, ChannelVendor> = { anthropic: 'anthropic', 'agent-sdk': 'claude-subscription', codex: 'codex-subscription', gemini: 'google' };
export const vendorOfDriver = (driver: string): ChannelVendor => DRIVER_VENDOR[driver] ?? 'custom';

// ---- 活动日历：列是周（周一起）、行是周一到周日；范围外的格子留空 ----
export type HeatCell = { date: string; jobs: number; level: number } | null;
export function buildCalendar(days: { date: string; jobs: number }[]) {
  const byDate = new Map(days.map((d) => [d.date, d.jobs]));
  // 0 次是第 0 档；有作业的日子按四分位分到 1～4 档
  const nz = days.map((d) => d.jobs).filter((n) => n > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => nz[Math.floor(nz.length * f)] ?? 0);
  const level = (n: number) => (n === 0 ? 0 : 1 + q.filter((t) => n > t).length);
  if (!days.length) return { weeks: [] as HeatCell[][], months: [] as (string | null)[] };
  const first = parseDay(days[0].date);
  const last = parseDay(days[days.length - 1].date);
  const weeks: HeatCell[][] = [];
  const months: (string | null)[] = [];
  for (let start = addDays(first, -weekdayOf(first)); start <= last; start = addDays(start, 7)) {
    const col: HeatCell[] = [];
    let monthStart: Date | null = null;
    for (let w = 0; w < 7; w++) {
      const d = addDays(start, w);
      const k = dayKey(d);
      const jobs = byDate.get(k);
      col.push(jobs === undefined ? null : { date: k, jobs, level: level(jobs) });
      if (jobs !== undefined && d.getDate() === 1) monthStart = d;
    }
    weeks.push(col);
    months.push(monthStart ? monthName(monthStart) : null);
  }
  // 第一列没有 1 号时也标上它的月份，但离下一个月份标签不到 3 列就不标，免得两个标签挤在一起
  if (months[0] === null) {
    const next = months.findIndex((m) => m !== null);
    if (next === -1 || next >= 3) months[0] = monthName(first);
  }
  return { weeks, months };
}

/** 近 90 天的统计：活跃天数、最长连续、作业合计、按星期的日均 */
export function activityStats(days: { date: string; jobs: number }[]) {
  let streak = 0; let best = 0; let active = 0; let total = 0;
  const sum = [0, 0, 0, 0, 0, 0, 0]; const cnt = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) {
    total += d.jobs;
    if (d.jobs > 0) { active++; streak++; best = Math.max(best, streak); } else streak = 0;
    const wd = weekdayOf(parseDay(d.date));
    sum[wd] += d.jobs; cnt[wd]++;
  }
  const avg = sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
  const top = Math.max(...avg);
  return { active, best, total, avg, busiest: top > 0 ? avg.indexOf(top) : -1 };
}

/** 纵轴上沿取一个整齐的数：1、2、5 的倍数一类，至少比最高的柱子高 */
export function niceMax(top: number) {
  if (top <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(top));
  const coarse = Math.ceil(top / step) * step;
  return coarse / step <= 3 ? Math.ceil(top / (step / 2)) * (step / 2) : coarse;
}
