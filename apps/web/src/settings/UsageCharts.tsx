import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { UsageStatsDto } from '@quilt/core/browser';
import { VendorIcon } from '@/ui/VendorIcon';
import { cn } from '@/ui/ui';
import { useResolvedMode } from '@/lib/theme';
import { useT } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import { NEUTRAL, NEUTRAL_COLOR, fmtInt, fmtPct, fmtTokens, niceMax, parseDay, shortDay, sumValues, tokensOf, vendorOfDriver, weekdayName, weekdayOf, type SeriesColor, type UsageModel } from '@/settings/usageModel';

// 用量看板的图与表（§13 设置弹层「用量」④–⑦）：每日 Token 堆叠柱、模型表、项目表、按任务类型。
// 颜色由调用方按 models 的顺序算好传进来（colorOf），这里只画；悬停提示 aria-hidden，读屏走每张图旁边的表格。

type Stats = UsageStatsDto;
type ColorOf = (key: string) => SeriesColor;
type Labeled = { key: string; label: string; deleted: boolean };
export type DayLabel = (d: Date) => string;

// ---- 小件 ----
/** 填充标记（柱段、分段条、胶囊、色块）：底色取填充色，四周一圈系列色描边（.usage-mark） */
const mark = (c: SeriesColor) => ({ '--mark-fill': c.fill, '--mark-line': c.line }) as CSSProperties;

export function Dot({ color, className }: { color: SeriesColor; className?: string }) {
  return <i aria-hidden="true" className={cn('usage-mark inline-block size-2.5 shrink-0 rounded-inner-min', className)} style={mark(color)} />;
}

export function DeletedTag() {
  const t = useT(settingsMessages);
  return <span className="fill inline-flex h-4 shrink-0 items-center rounded-pill px-1.5 type-caption text-text-secondary">{t('usage.deleted')}</span>;
}

/** 模型的 logo（不垫底色）；删掉的模型压一档透明度 */
export function ModelLogo({ driver, deleted, size = 24 }: { driver: string; deleted?: boolean; size?: number }) {
  return <VendorIcon vendor={vendorOfDriver(driver)} size={size} className={cn('shrink-0', deleted && 'opacity-60')} />;
}

/** 悬停提示：挂在 .usage-hover 的元素里；align 决定贴左还是贴右展开，免得贴边的提示被滚动区裁掉 */
export function Tip({ align = 'left', children }: { align?: 'left' | 'right' | 'center'; children: ReactNode }) {
  return (
    <div aria-hidden="true" className={cn('usage-tip type-caption', align === 'left' && 'left-0', align === 'right' && 'right-0', align === 'center' && 'left-1/2 -translate-x-1/2')}>
      {children}
    </div>
  );
}
/** 提示里的一行：色块 · 名字 · 数 */
function TipRow({ color, label, deleted, value }: { color?: SeriesColor; label: ReactNode; deleted?: boolean; value: string }) {
  const t = useT(settingsMessages);
  return (
    <p className="flex items-center gap-2 leading-[18px]">
      {color && <Dot color={color} />}
      <span className="min-w-0 flex-1 truncate">{label}{deleted && <span className="ml-1 opacity-70">{t('usage.deleted')}</span>}</span>
      <b className="font-medium tabular-nums">{value}</b>
    </p>
  );
}
function TipTotal({ label, value }: { label: string; value: string }) {
  return <p className="mt-1 flex items-center gap-2 border-t border-current/15 pt-1 leading-[18px] opacity-80"><span className="flex-1">{label}</span><b className="font-medium tabular-nums">{value}</b></p>;
}

/** 表头一行：灰色小字，读屏跳过（每行的文字自己说得清是什么） */
function HeadRow({ cols, children }: { cols: string; children: ReactNode }) {
  return <div aria-hidden="true" className={cn(cols, 'mt-2 pb-2 type-label text-text-secondary')}>{children}</div>;
}

function SectionHead({ id, title, hint }: { id: string; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h4 id={id} className="shrink-0 type-body font-semibold">{title}</h4>
      {hint && <span className="min-w-0 truncate type-caption text-text-secondary">{hint}</span>}
    </div>
  );
}

export function EmptyLine({ text }: { text: string }) {
  return <p className="mt-2 rounded-md py-6 text-center type-label text-text-secondary fill">{text}</p>;
}

/** 胶囊右侧的百分比：看得见的是数，读屏念完整一句 */
function Share({ pct, label, strong }: { pct: string; label: string; strong?: boolean }) {
  return (
    <span className={cn('w-10 shrink-0 text-right type-body tabular-nums', strong ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
      <span aria-hidden="true">{pct}</span><span className="sr-only">{label}</span>
    </span>
  );
}

/** 20 px 胶囊：底是正文色 7% 的填充（brand 的图表轨道色在深色弹层上与底同色，看不出胶囊），填充按占比（不到 20 px 也画成一粒圆点）；strong 是实心填充、盖住的那段字反白，否则是 18% 的浅填充。
 *  第一次出现时从 0 长到占比（400 ms，减弱动态时直接到位） */
// 盖住的那段字要对填充有 4.5:1：「主按钮上的字」在有的填充色上不够，这时换成正文字色；两者取对比度高的那个
const ON_FILL = ['--semantic-color-text-on-action', '--semantic-color-text-primary'] as const;
const rgbOf = (c: string): number[] | null => {
  const hex = c.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = c.match(/rgba?\(([^)]+)\)/);
  return m ? m[1].split(/[\s,/]+/).slice(0, 3).map(Number) : null;
};
const luminance = ([r, g, b]: number[]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function useReadableOn(fill: React.RefObject<HTMLElement | null>, color: string): string {
  const mode = useResolvedMode();
  const [on, setOn] = useState<string>(ON_FILL[0]);
  useLayoutEffect(() => {
    const el = fill.current; if (!el) return;
    const bg = rgbOf(getComputedStyle(el).backgroundColor);
    const root = getComputedStyle(document.documentElement);
    const scored = ON_FILL.map((v) => { const fg = rgbOf(root.getPropertyValue(v)); return { v, c: bg && fg ? contrast(bg, fg) : 0 }; });
    setOn(scored[0].c >= 4.5 || scored[0].c >= scored[1].c ? ON_FILL[0] : ON_FILL[1]);
  }, [fill, color, mode]);
  return `var(${on})`;
}

function Capsule({ pct, color, text, strong }: { pct: number; color: SeriesColor; text: string; strong?: boolean }) {
  const w = 'max(1.25rem, var(--w))';
  const fill = useRef<HTMLElement>(null);
  const on = useReadableOn(fill, color.fill);
  return (
    <div className="fill relative h-5 min-w-0 flex-1 overflow-hidden rounded-pill type-caption font-medium tabular-nums" style={{ '--w': `${pct}%`, '--c': color.line } as CSSProperties}>
      <i ref={fill} aria-hidden="true" className={cn('usage-fill absolute inset-y-0 left-0 rounded-pill', strong ? 'usage-mark' : 'bg-[color-mix(in_srgb,var(--c)_18%,transparent)]')} style={{ width: w, ...(strong && mark(color)) }} />
      <span className={cn('absolute inset-0 flex items-center justify-center whitespace-nowrap text-text-secondary', strong && 'usage-fill-rest')} style={strong ? { clipPath: `inset(0 0 0 ${w})` } : undefined}>{text}</span>
      {strong && <span aria-hidden="true" className="usage-fill-on absolute inset-0 flex items-center justify-center whitespace-nowrap" style={{ clipPath: `inset(0 calc(100% - ${w}) 0 0)`, color: on }}>{text}</span>}
    </div>
  );
}

/** 按模型分段的横条：段间 2 px；太窄画不出的段不画（悬停提示里照样列出），一段都画不出时画最大的那段。整条第一次出现时从 0 长到占比。
 *  没调过模型的任务类型（导出、套用设计系统）没有分段，画一整条中性灰（API-CORE-052，v1.28） */
function StackBar({ parts, width, colorOf }: { parts: [string, number][]; width: number; colorOf: ColorOf }) {
  if (!parts.length) return <div className="usage-fill flex h-2" style={{ width: `${width}%` }}><i aria-hidden="true" className="block h-full flex-1 rounded-pill" style={{ background: NEUTRAL }} /></div>;
  const total = parts.reduce((a, [, v]) => a + v, 0);
  // 横条大约 300 px 宽：窄于 4 px 的段不画
  const drawn = parts.filter(([, v]) => (v / total) * (width / 100) * 300 >= 4);
  const show = drawn.length ? drawn : parts.slice(0, 1);
  return (
    <div className="usage-fill flex h-2 gap-[2px]" style={{ width: `${width}%` }}>
      {show.map(([k, v]) => <i key={k} aria-hidden="true" className="usage-mark block h-full min-w-1 basis-0 rounded-pill" style={{ flexGrow: v, ...mark(colorOf(k)) }} />)}
    </div>
  );
}

const sortedParts = (by: Record<string, number>) => Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

// ---- ④ 每日 Token ----
export function DailyChart({ data, colorOf, labelOf, dayLabel }: { data: Stats; colorOf: ColorOf; labelOf: (k: string) => Labeled; dayLabel: DayLabel }) {
  const t = useT(settingsMessages);
  const weekly = data.unit === 'week';
  const used = data.models.filter((m) => tokensOf(m) > 0);
  const order = data.models.map((m) => m.key);
  const totals = data.buckets.map((b) => sumValues(b.tokens));
  const ymax = niceMax(Math.max(0, ...totals));
  const n = data.buckets.length;
  const H = 152; // 柱区高度（px），只用来判断哪段太细画不出来
  const empty = data.models.length === 0 ? t('usage.empty') : data.totals.jobs === 0 ? t('usage.emptyRange') : null;
  // 首次显示与换范围时柱子从底部长出，逐根错开、错开合计不超过 150 ms
  const stagger = n > 1 ? 150 / (n - 1) : 0;
  const title = (b: Stats['buckets'][number]) => {
    const from = parseDay(b.from); const to = parseDay(b.to);
    return weekly ? t('usage.dayRange', { from: dayLabel(from), to: dayLabel(to) }) : `${dayLabel(from)} ${weekdayName(weekdayOf(from), 'short')}`;
  };
  const axisLabel = (b: Stats['buckets'][number], i: number) => {
    const from = parseDay(b.from);
    if (!weekly) return n <= 10 || weekdayOf(from) === 0 ? shortDay(from) : '';
    if (n > 8 && i % 2) return '';
    const to = parseDay(b.to);
    return from.getMonth() === to.getMonth() ? `${shortDay(from)}–${to.getDate()}` : `${shortDay(from)}–${shortDay(to)}`;
  };
  return (
    <section aria-labelledby="usage-daily" className="mt-8" data-testid="usage-daily">
      <div className="flex items-baseline justify-between gap-4">
        <h4 id="usage-daily" className="shrink-0 type-body font-semibold">{t(weekly ? 'usage.weekly' : 'usage.daily')}</h4>
        {!empty && (
          <ul aria-hidden="true" className="flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-1 type-caption text-text-primary">
            {used.map((m) => <li key={m.key} className="flex items-center gap-1.5"><Dot color={colorOf(m.key)} />{m.label}{m.deleted && <span className="text-text-secondary">（{t('usage.deleted')}）</span>}</li>)}
          </ul>
        )}
      </div>
      {empty ? <EmptyLine text={empty} /> : (
        <div aria-hidden="true" className="relative mb-7 ml-10 mt-3 type-caption text-chart-axis" style={{ height: H }}>
          {[0, 50, 100].map((p) => (
            <div key={p} className="absolute inset-x-0 border-t border-chart-gridline" style={{ bottom: `${p}%` }}>
              <span className="absolute right-full mr-2 -translate-y-1/2 tabular-nums">{p ? fmtTokens((ymax * p) / 100) : '0'}</span>
            </div>
          ))}
          <div key={`${data.range}:${data.from}`} className={cn('relative flex h-full items-end', n > 10 ? 'gap-[3px]' : 'gap-3')}>
            {data.buckets.map((b, i) => {
              const tot = totals[i];
              const parts = order.filter((k) => (b.tokens[k] ?? 0) > 0).map((k) => [k, b.tokens[k]] as [string, number]);
              const px = (tot / ymax) * H;
              const drawn = parts.filter(([, v]) => (v / tot) * px >= 3);
              const show = drawn.length ? drawn : [...parts].sort((a, c) => c[1] - a[1]).slice(0, 1);
              const rows = sortedParts(b.tokens);
              return (
                <div key={b.from} data-testid="usage-bar" className="usage-hover relative flex h-full flex-1 flex-col justify-end rounded-inner-min state-layer">
                  {tot > 0 ? (
                    <div className="usage-rise flex w-full flex-col-reverse gap-[2px]" style={{ height: `${(tot / ymax) * 100}%`, '--delay': `${Math.round(i * stagger)}ms` } as CSSProperties}>
                      {show.map(([k, v]) => <i key={k} className="usage-mark block min-h-px basis-0 rounded-inner-min" style={{ flexGrow: v, ...mark(colorOf(k)) }} />)}
                    </div>
                  ) : <div className="h-px w-full bg-chart-gridline" />}
                  <span className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap tabular-nums">{axisLabel(b, i)}</span>
                  <Tip align={i > n * 0.55 ? 'right' : 'left'}>
                    <p className="mb-1 font-semibold leading-[18px]">{title(b)}</p>
                    {tot > 0 ? rows.map(([k, v]) => { const l = labelOf(k); return <TipRow key={k} color={colorOf(k)} label={l.label} deleted={l.deleted} value={t('usage.share', { value: fmtTokens(v), pct: fmtPct(v, tot) })} />; })
                      : <p className="leading-[18px] opacity-80">{t('usage.none')}</p>}
                    {tot > 0 && <TipTotal label={t('usage.total')} value={fmtTokens(tot)} />}
                  </Tip>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* 读屏用的同一份数据：sr-only 挂在外层 div 上（挂在 table 上不生效，RESP-013） */}
      {!empty && (
        <div className="sr-only">
          <table>
            <caption>{t('usage.chartCaption')}</caption>
            <thead><tr><th scope="col">{t('usage.colPeriod')}</th>{used.map((m) => <th key={m.key} scope="col">{m.label}{m.deleted ? `（${t('usage.deleted')}）` : ''}</th>)}<th scope="col">{t('usage.total')}</th></tr></thead>
            <tbody>
              {data.buckets.map((b, i) => <tr key={b.from}><th scope="row">{title(b)}</th>{used.map((m) => <td key={m.key}>{fmtInt(b.tokens[m.key] ?? 0)}</td>)}<td>{fmtInt(totals[i])}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- ⑤ 模型表 ----
const COLS = 'grid grid-cols-[minmax(0,1.35fr)_minmax(0,1.6fr)_6.5rem] items-center gap-x-5';

export function ModelTable({ data, colorOf, dayLabel }: { data: Stats; colorOf: ColorOf; dayLabel: DayLabel }) {
  const t = useT(settingsMessages);
  const rows = data.models.filter((m) => tokensOf(m) > 0 || m.jobs > 0).sort((a, b) => tokensOf(b) - tokensOf(a));
  const T = rows.reduce((a, m) => a + tokensOf(m), 0);
  const J = rows.reduce((a, m) => a + m.jobs, 0);
  const empty = data.models.length === 0 ? t('usage.empty') : rows.length === 0 ? t('usage.emptyRange') : null;
  const today = new Date();
  const lastUsed = (m: UsageModel) => {
    if (!m.lastAt) return t('usage.models.never');
    const d = new Date(m.lastAt);
    return d.toDateString() === today.toDateString() ? t('usage.models.today') : t('usage.models.last', { date: dayLabel(d) });
  };
  return (
    <section aria-labelledby="usage-models" className="mt-9" data-testid="usage-models">
      <SectionHead id="usage-models" title={t('usage.models.title')} hint={empty ? undefined : t('usage.models.hint')} />
      {empty ? <EmptyLine text={empty} /> : (
        <>
        <HeadRow cols={COLS}><span>{t('usage.models.colName')}</span><span>{t('usage.models.colUsage')}</span><span>{t('usage.models.colStatus')}</span></HeadRow>
        <ul>
          {rows.map((m) => {
            const color = colorOf(m.key);
            return (
              <li key={m.key} data-testid="usage-model-row" data-deleted={m.deleted || undefined} className={cn(COLS, 'border-t border-border-subtle py-3.5')}>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center"><ModelLogo driver={m.driver} deleted={m.deleted} /></span>
                  <div className="min-w-0">
                    <p className={cn('truncate type-body font-medium', m.deleted ? 'text-text-secondary' : 'text-text-primary')}>{m.label}</p>
                    <p className="truncate font-mono type-caption text-text-secondary">{m.modelId}</p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center gap-3">
                    <Capsule pct={(tokensOf(m) / T) * 100} color={color} text={t('usage.models.tokens', { n: fmtTokens(tokensOf(m)) })} strong />
                    <Share pct={fmtPct(tokensOf(m), T)} label={t('usage.models.tokenShare', { pct: fmtPct(tokensOf(m), T) })} strong />
                  </div>
                  <div className="flex items-center gap-3">
                    <Capsule pct={J ? (m.jobs / J) * 100 : 0} color={color} text={t('usage.models.jobs', { count: m.jobs })} />
                    <Share pct={fmtPct(m.jobs, J)} label={t('usage.models.jobShare', { pct: fmtPct(m.jobs, J) })} />
                  </div>
                </div>
                <div className={cn('grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5', m.deleted ? 'text-text-secondary' : 'text-success')}>
                  <span aria-hidden="true" className="size-2 rounded-full bg-current" />
                  <p className="type-body font-medium">{m.deleted ? t('usage.deleted') : t('usage.models.inUse')}</p>
                  <p className="col-span-2 truncate type-label text-text-secondary">{lastUsed(m)}</p>
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </section>
  );
}

// ---- ⑥ 项目表 ----
export function ProjectTable({ data, colorOf, labelOf }: { data: Stats; colorOf: ColorOf; labelOf: (k: string) => Labeled }) {
  const t = useT(settingsMessages);
  const rows = data.projects.filter((p) => p.tokens > 0 || p.screens > 0);
  const T = rows.reduce((a, p) => a + p.tokens, 0);
  const empty = data.models.length === 0 ? t('usage.empty') : rows.length === 0 ? t('usage.emptyRange') : null;
  return (
    <section aria-labelledby="usage-projects" className="mt-7" data-testid="usage-projects">
      <SectionHead id="usage-projects" title={t('usage.projects.title')} hint={empty ? undefined : t('usage.projects.hint')} />
      {empty ? <EmptyLine text={empty} /> : (
        <>
        <HeadRow cols={COLS}><span>{t('usage.projects.colName')}</span><span>{t('usage.projects.colTokens')}</span><span>{t('usage.projects.colModels')}</span></HeadRow>
        <ul>
          {rows.map((p) => {
            const name = p.sketchbook ? t('usage.projects.sketchbook') : p.id === null ? t('usage.projects.gone') : p.name ?? '';
            const parts = sortedParts(p.byModel);
            const lead = parts[0]?.[0];
            return (
              <li key={p.id ?? '-'} data-testid="usage-project-row" className={cn(COLS, 'usage-hover relative border-t border-border-subtle py-3.5')}>
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="fill grid size-8 shrink-0 place-items-center rounded-full type-label font-semibold text-text-secondary">{(Array.from(name)[0] ?? '·').toUpperCase()}</span>
                  <div className="min-w-0">
                    <p className="flex min-w-0 items-center gap-1.5"><span className={cn('truncate type-body font-medium', p.deleted ? 'text-text-secondary' : 'text-text-primary')}>{name}</span>{p.deleted && p.id !== null && <DeletedTag />}</p>
                    <p className="truncate type-caption text-text-secondary">{t('usage.projects.screens', { count: p.screens })}</p>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-3">
                  <Capsule pct={T ? (p.tokens / T) * 100 : 0} color={lead ? colorOf(lead) : NEUTRAL_COLOR} text={t('usage.models.tokens', { n: fmtTokens(p.tokens) })} strong />
                  <Share pct={fmtPct(p.tokens, T)} label={t('usage.models.tokenShare', { pct: fmtPct(p.tokens, T) })} strong />
                </div>
                <div className="min-w-0">
                  <p aria-hidden="true" className="flex items-center gap-1">{parts.map(([k]) => <Dot key={k} color={colorOf(k)} />)}</p>
                  {lead && <p className="mt-1 truncate type-label text-text-secondary">{t('usage.projects.main', { name: labelOf(lead).label })}</p>}
                </div>
                {p.tokens > 0 && (
                  <Tip align="right">
                    <p className="mb-1 font-semibold leading-[18px]">{name}</p>
                    {parts.map(([k, v]) => { const l = labelOf(k); return <TipRow key={k} color={colorOf(k)} label={l.label} deleted={l.deleted} value={t('usage.share', { value: fmtTokens(v), pct: fmtPct(v, p.tokens) })} />; })}
                    <TipTotal label={t('usage.total')} value={fmtTokens(p.tokens)} />
                  </Tip>
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}
    </section>
  );
}

// ---- ⑦ 按任务类型 ----
export function KindTable({ data, colorOf, labelOf }: { data: Stats; colorOf: ColorOf; labelOf: (k: string) => Labeled }) {
  const t = useT(settingsMessages);
  const rows = data.kinds.filter((k) => k.jobs > 0);
  const total = rows.reduce((a, k) => a + k.jobs, 0);
  const max = Math.max(0, ...rows.map((k) => k.jobs));
  const empty = data.models.length === 0 ? t('usage.empty') : rows.length === 0 ? t('usage.emptyRange') : null;
  return (
    <section aria-labelledby="usage-kinds" className="mt-7" data-testid="usage-kinds">
      <SectionHead id="usage-kinds" title={t('usage.kinds.title')} hint={empty ? undefined : t('usage.kinds.hint', { count: total })} />
      {empty ? <EmptyLine text={empty} /> : (
        <ul className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)_max-content] gap-x-3 type-label text-text-secondary">
          {rows.map((k) => {
            const name = t(`usage.kinds.names.${k.kind}`);
            const parts = sortedParts(k.byModel);
            return (
              <li key={k.kind} data-testid="usage-kind-row" className="usage-hover relative col-span-3 grid grid-cols-subgrid items-center rounded-sm py-1 state-layer">
                <span className="text-text-primary">{name}</span>
                <StackBar parts={parts} width={(k.jobs / max) * 100} colorOf={colorOf} />
                <span className="text-right tabular-nums"><b className="font-medium text-text-primary">{fmtInt(k.jobs)}</b> {t('usage.kinds.unit', { count: k.jobs })} · {fmtPct(k.jobs, total)}</span>
                <Tip align="left">
                  <p className="mb-1 font-semibold leading-[18px]">{name}</p>
                  {parts.map(([m, v]) => { const l = labelOf(m); return <TipRow key={m} color={colorOf(m)} label={l.label} deleted={l.deleted} value={t('usage.kinds.tipCount', { count: v, pct: fmtPct(v, k.jobs) })} />; })}
                  <TipTotal label={t('usage.total')} value={t('usage.kinds.tipCount', { count: k.jobs, pct: fmtPct(k.jobs, total) })} />
                </Tip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

