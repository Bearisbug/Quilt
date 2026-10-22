import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RadioGroup } from 'radix-ui';
import { USAGE_RANGES, type UsageRange, type UsageStatsDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { Button, cn } from '@/ui/ui';
import { getLocale, useT } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import commonMessages from '@/i18n/locales/common';
import { DailyChart, DeletedTag, KindTable, ModelLogo, ModelTable, ProjectTable, Tip, type DayLabel } from '@/settings/UsageCharts';
import { activityStats, buildCalendar, daysBetween, fmtAvg, fmtInt, fmtPct, fmtTokens, modelColors, parseDay, weekdayName } from '@/settings/usageModel';

// 设置「用量」一节（FLOW-USAGE S2–S4，§13 设置弹层「用量」①–⑦）：数据只来自 API-CORE-052 的一份 UsageStatsDto。
// 数据与范围放在弹层这一级（useUsageStats）：换到别的节再回来，读取失败的状态与「重试」还在，不会自己重取

const RANGE_KEY = 'quilt:usage-range';
const readRange = (): UsageRange => {
  try { const v = window.localStorage.getItem(RANGE_KEY); return USAGE_RANGES.find((r) => r === v) ?? '7d'; } catch { return '7d'; }
};

export type UsageState = ReturnType<typeof useUsageStats>;
export function useUsageStats() {
  // 范围记在本机（INT-021：惰性初值，首帧就是记下的那一项）
  const [range, setRangeState] = useState<UsageRange>(readRange);
  const [data, setData] = useState<UsageStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 只认最后一次请求的结果：连点几个范围时，先发的晚到不能盖掉后发的（DATA-006）
  const seq = useRef(0);
  const load = useCallback((r: UsageRange) => {
    const n = ++seq.current;
    setLoading(true); setError(null);
    api.usageStats(r).then(
      (d) => { if (seq.current === n) { setData(d); setLoading(false); } },
      (e: unknown) => { if (seq.current === n) { setError(e instanceof ApiError ? e.problem.title : e instanceof Error ? e.message : ''); setLoading(false); } },
    );
  }, []);
  useEffect(() => { load(range); }, [load, range]);
  const setRange = useCallback((r: UsageRange) => {
    setRangeState(r);
    try { window.localStorage.setItem(RANGE_KEY, r); } catch { /* 存不下就只对这次打开生效 */ }
  }, []);
  return { range, setRange, data, error, loading, retry: () => load(range) };
}

export function UsageSection({ state }: { state: UsageState }) {
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
  const { data, error } = state;
  return (
    <div className="@container" data-testid="usage-section">
      <h3 className="type-heading3 font-semibold">{t('sections.usage')}</h3>
      <p className="mt-1 type-label text-text-secondary">{t('usage.hint')}</p>
      {error !== null ? (
        <div role="alert" data-testid="usage-error" className="tint-error mt-5 flex items-center justify-between gap-3 rounded-md px-3 py-2.5 type-label">
          <span className="min-w-0 [overflow-wrap:anywhere]">{error ? `${t('usage.loadFailed')}：${error}` : t('usage.loadFailed')}</span>
          <Button size="sm" onClick={state.retry}>{tc('retry')}</Button>
        </div>
      ) : !data ? <UsageSkeleton /> : <Board state={state} data={data} />}
    </div>
  );
}

function Board({ state, data }: { state: UsageState; data: UsageStatsDto }) {
  const t = useT(settingsMessages);
  const colorOf = useMemo(() => modelColors(data.models), [data.models]);
  const labelOf = useMemo(() => {
    const byKey = new Map(data.models.map((m) => [m.key, m]));
    return (k: string) => byKey.get(k) ?? { key: k, label: k, deleted: true };
  }, [data.models]);
  const dayLabel: DayLabel = (d) => t('usage.day', { month: getLocale() === 'en' ? new Intl.DateTimeFormat('en', { month: 'short' }).format(d) : d.getMonth() + 1, day: d.getDate() });
  const { totals } = data;
  const days = daysBetween(data.from, data.to);
  const tokens = totals.tokensIn + totals.tokensOut;
  return (
    <>
      <Activity data={data} dayLabel={dayLabel} />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h4 className="type-body font-semibold">{t('usage.stats')}</h4>
        <RangeSeg value={state.range} onChange={state.setRange} />
      </div>
      {/* 换范围时旧数据留着、等新数据到了再换（只有这一块在取数），不闪骨架 */}
      <div aria-busy={state.loading || undefined}>
        <dl className="mt-3 grid grid-cols-2 gap-2 @xl:grid-cols-4" data-testid="usage-totals">
          <Kpi label={t('usage.kpi.jobs')} value={fmtInt(totals.jobs)} sub={t('usage.kpi.perDay', { n: fmtAvg(totals.jobs / days) })} testId="usage-kpi-jobs" />
          <Kpi label={t('usage.kpi.tokens')} value={fmtTokens(tokens)} sub={t('usage.kpi.tokensSub', { in: fmtTokens(totals.tokensIn), out: fmtTokens(totals.tokensOut) })} testId="usage-kpi-tokens" />
          <Kpi label={t('usage.kpi.screens')} value={fmtInt(totals.screens)} sub={t('usage.kpi.sketch', { count: totals.sketchScreens })} testId="usage-kpi-screens" />
          <Kpi label={t('usage.kpi.avg')} value={fmtTokens(totals.jobs ? Math.round(tokens / totals.jobs) : 0)} sub={t('usage.kpi.max', { n: fmtTokens(totals.maxJobTokens) })} testId="usage-kpi-avg" />
        </dl>
        {/* 正在跑的作业不计入看板，单独一行说 */}
        {data.inflight.calls > 0 && <p data-testid="usage-inflight" className="mt-2 type-label text-text-secondary">{t('usage.inflight', { count: data.inflight.calls })}</p>}
        <DailyChart data={data} colorOf={colorOf} labelOf={labelOf} dayLabel={dayLabel} />
        <ModelTable data={data} colorOf={colorOf} dayLabel={dayLabel} />
        <ProjectTable data={data} colorOf={colorOf} labelOf={labelOf} />
        <KindTable data={data} colorOf={colorOf} labelOf={labelOf} />
      </div>
    </>
  );
}

function Kpi({ label, value, sub, testId }: { label: string; value: string; sub: string; testId: string }) {
  return (
    <div className="fill min-w-0 rounded-md px-3 py-2.5" data-testid={testId}>
      <dt className="type-caption text-text-secondary">{label}</dt>
      <dd className="mt-1 type-heading2 font-semibold tabular-nums">{value}</dd>
      <dd className="mt-0.5 truncate type-caption text-text-secondary">{sub}</dd>
    </div>
  );
}

// ② 统计范围：分段控件，选中项下面一块白色滑块 200 ms 滑过去（Radix RadioGroup：整组一个 Tab 停靠点，方向键换项）
function RangeSeg({ value, onChange }: { value: UsageRange; onChange: (r: UsageRange) => void }) {
  const t = useT(settingsMessages);
  const i = USAGE_RANGES.indexOf(value);
  return (
    <RadioGroup.Root value={value} onValueChange={(v) => onChange(v as UsageRange)} orientation="horizontal" aria-label={t('usage.rangeLabel')} data-testid="usage-range"
      className="seg-slider" style={{ '--n': USAGE_RANGES.length, '--i': i } as CSSProperties}>
      <span aria-hidden="true" className="seg-thumb" data-testid="usage-range-thumb" />
      {USAGE_RANGES.map((r) => (
        <RadioGroup.Item key={r} value={r} data-testid={`usage-range-${r}`} className="state-layer focus-ring h-7 whitespace-nowrap px-3 type-label font-medium">
          {t(`usage.range.${r}`)}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

// ① 活动卡：近 90 天的日历（与范围无关）+ 活跃天数、最长连续、作业次数、按星期的日均、90 天里 Token 最多的模型
function Activity({ data, dayLabel }: { data: UsageStatsDto; dayLabel: DayLabel }) {
  const t = useT(settingsMessages);
  const days = data.activity.days;
  const { weeks, months } = useMemo(() => buildCalendar(days), [days]);
  const s = useMemo(() => activityStats(days), [days]);
  const top = data.activity.topModel ? data.models.find((m) => m.key === data.activity.topModel) : undefined;
  const maxAvg = Math.max(...s.avg);
  return (
    <section aria-labelledby="usage-activity" className="fill mt-5 rounded-lg p-4" data-testid="usage-activity">
      <div className="flex items-baseline justify-between gap-3">
        <h4 id="usage-activity" className="type-body font-semibold">{t('usage.activity.title')}<span className="ml-2 type-caption font-normal text-text-secondary">{t('usage.activity.window')}</span></h4>
        <div aria-hidden="true" className="flex items-center gap-[3px] type-caption text-text-secondary">
          <span className="mr-1">{t('usage.activity.less')}</span>
          {[0, 1, 2, 3, 4].map((l) => <i key={l} className={cn('size-2.5 rounded-inner-min', `heat-${l}`)} />)}
          <span className="ml-1">{t('usage.activity.more')}</span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-4">
        {/* 日历：列是周、行是周一到周日；悬停一格出「10 月 18 日 · 12 次」 */}
        <div aria-hidden="true" className="flex gap-2 type-caption text-text-secondary">
          <div className="grid grid-rows-[repeat(7,1rem)] gap-[3px] pt-[1.1875rem]">
            {[0, 1, 2, 3, 4, 5, 6].map((wd) => <span key={wd} className="leading-4">{wd % 2 === 0 && wd < 6 ? weekdayName(wd, 'short') : ''}</span>)}
          </div>
          <div>
            <div className="mb-1 grid h-3.5 auto-cols-[1rem] grid-flow-col gap-[3px] whitespace-nowrap leading-[0.875rem]">
              {months.map((m, i) => <span key={i}>{m ?? ''}</span>)}
            </div>
            <div className="grid grid-flow-col grid-rows-[repeat(7,1rem)] auto-cols-[1rem] gap-[3px]" data-testid="usage-calendar">
              {weeks.flatMap((col, c) => col.map((cell, r) => cell ? (
                <div key={cell.date} data-testid="usage-day" data-date={cell.date} data-level={cell.level}
                  className={cn('usage-hover relative rounded-inner-min outline-offset-1 hover:outline hover:outline-1 hover:outline-(--semantic-color-text-secondary)', `heat-${cell.level}`)}>
                  <Tip align={c < 3 ? 'left' : c > weeks.length - 4 ? 'right' : 'center'}>
                    <p className="whitespace-nowrap font-medium leading-[18px]">{t('usage.activity.cell', { date: dayLabel(parseDay(cell.date)), count: cell.jobs })}</p>
                  </Tip>
                </div>
              ) : <span key={`${c}-${r}`} />))}
            </div>
          </div>
        </div>
        <div className="min-w-[15rem] flex-1 type-caption text-text-secondary">
          <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <ActStat label={t('usage.activity.active')} value={fmtInt(s.active)} unit={t('usage.activity.activeUnit')} testId="usage-active-days" />
            <ActStat label={t('usage.activity.streak')} value={fmtInt(s.best)} unit={t('usage.activity.streakUnit')} testId="usage-streak" />
            <ActStat label={t('usage.activity.jobs')} value={fmtInt(s.total)} unit={t('usage.activity.jobsUnit')} testId="usage-activity-jobs" />
          </dl>
          <div className="mt-4 flex items-baseline justify-between gap-2">
            <span>{t('usage.activity.byWeekday')}</span>
            {s.busiest >= 0 && <span className="text-text-primary">{t('usage.activity.busiest', { day: weekdayName(s.busiest, 'short') })}</span>}
          </div>
          <div aria-hidden="true" className="mt-2 flex h-[3.25rem] items-end gap-1.5">
            {s.avg.map((a, wd) => (
              <div key={wd} className="usage-hover relative flex h-full flex-1 items-end">
                <div className={cn('w-full rounded-inner-min', a === 0 ? 'heat-0' : wd === s.busiest ? 'heat-4' : 'heat-2')} style={{ height: `${maxAvg ? Math.max(4, (a / maxAvg) * 100) : 4}%` }} />
                <Tip align={wd < 2 ? 'left' : wd > 4 ? 'right' : 'center'}><p className="whitespace-nowrap leading-[18px]">{t('usage.activity.weekdayTip', { day: weekdayName(wd, 'short'), avg: fmtAvg(a) })}</p></Tip>
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="mt-1 flex gap-1.5 text-center">{s.avg.map((_, wd) => <span key={wd} className="flex-1">{weekdayName(wd, 'narrow')}</span>)}</div>
          {top && (
            <p className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3" data-testid="usage-top-model">
              <ModelLogo driver={top.driver} deleted={top.deleted} size={16} />
              <span>{t('usage.activity.topModel')}</span>
              <span className="min-w-0 truncate font-medium text-text-primary">{top.label}</span>
              {top.deleted && <DeletedTag />}
              {data.activity.topShare !== null && <span className="ml-auto shrink-0 tabular-nums">{t('usage.activity.topShare', { pct: fmtPct(data.activity.topShare, 1) })}</span>}
            </p>
          )}
        </div>
      </div>
      {/* 读屏用：有作业的日子与作业数（日历本身对读屏隐藏） */}
      <div className="sr-only">
        <table>
          <caption>{t('usage.activity.caption')}</caption>
          <thead><tr><th scope="col">{t('usage.activity.colDate')}</th><th scope="col">{t('usage.activity.colJobs')}</th></tr></thead>
          <tbody>{days.filter((d) => d.jobs > 0).map((d) => <tr key={d.date}><th scope="row">{dayLabel(parseDay(d.date))}</th><td>{d.jobs}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function ActStat({ label, value, unit, testId }: { label: string; value: string; unit: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd className="mt-0.5 type-heading2 font-semibold tabular-nums text-text-primary">{value}{unit && <span className="ml-1 type-caption font-normal text-text-secondary">{unit}</span>}</dd>
    </div>
  );
}

// 加载骨架按真实结构占位：活动卡、四张看板、柱图（IA-006）；只呼吸透明度，减弱动态时不动
function UsageSkeleton() {
  const t = useT(settingsMessages);
  const pulse = 'animate-pulse motion-reduce:animate-none';
  return (
    <div role="status" aria-label={t('usage.loading')} data-testid="usage-loading">
      <div aria-hidden="true" className={cn('fill mt-5 h-56 rounded-lg', pulse)} />
      <div aria-hidden="true" className="mt-6 flex items-center justify-between"><span className={cn('fill h-4 w-12 rounded-sm', pulse)} /><span className={cn('fill h-8 w-56 rounded-md', pulse)} /></div>
      <div aria-hidden="true" className="mt-3 grid grid-cols-2 gap-2 @xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className={cn('fill h-[4.75rem] rounded-md', pulse)} />)}</div>
      <div aria-hidden="true" className={cn('fill mt-8 h-44 rounded-md', pulse)} />
    </div>
  );
}
