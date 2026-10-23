import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import type { JobKind } from '@quilt/core/browser';
import { cn, IconButton } from '@/ui/ui';
import { useT } from '@/i18n';
import composerMessages from '@/i18n/locales/composer';
import commonMessages from '@/i18n/locales/common';
import { cssMs } from '@/canvas/edges';

/** 作业 chip（PAGE-CANVAS「作业 chip」v1.17，REQ-CORE-020 / REQ-CORE-026）：在跑的写在做什么与进度；失败的写原因、可重试；成功的原地转成「任务完成」，10 s 后淡出（v1.33） */
export type JobChip = { id: string; createdAt: string; label: string } & (
  | { state: 'running'; progress: string }
  | { state: 'failed'; reason: string; retryable: boolean }
  | { state: 'succeeded' }
);
/** 页面交来的在跑作业：label = 它在做什么，progress = 当前阶段 */
export type RunningJob = { id: string; createdAt: string; label: string; progress: string };
/** 已结束、还要留一会儿的作业：失败的留到用户关掉，成功的留到它自己淡出或用户关掉 */
export type EndedJob = { id: string; createdAt: string; label: string; kind: JobKind } & ({ state: 'failed'; reason: string } | { state: 'succeeded' });

// 能原样再发一轮的作业种类：与 API-CORE-034 服务端的口径一致（其余种类没有可重发的那一轮，回原入口再点一次）
const RETRYABLE: readonly JobKind[] = ['generate', 'edit_screens', 'edit_component', 'chat'];
/** 最多摆几枚，其余折成一枚「还有 N 个」 */
const MAX_CHIPS = 3;
// 成功的 chip（v1.33）：原地转成「任务完成」停 10 s，悬停、键盘获焦与页面在后台时暂停计时（COMP-009：按截止时刻算剩余）；
// 到点用 200 ms 淡出（styles.css 的 .job-chip-leaving），淡完撤掉。折进「还有 N 个」的没有挂载、计不了时，30 s 后由 useEndedJobs 兜底撤掉
const DONE_MS = 10_000;
const FADE_MS = 200;
const FOLDED_MS = 30_000;

/** 页面上已结束作业的那一份状态：end 在作业终态事件里调，dismiss 是失败 chip 的 ×、或重试发出去之后撤掉旧的那枚 */
export function useEndedJobs() {
  const [ended, setEnded] = useState<EndedJob[]>([]);
  const timers = useRef(new Set<number>());
  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);
  const dismiss = useCallback((id: string) => setEnded((xs) => xs.filter((x) => x.id !== id)), []);
  const end = useCallback((job: EndedJob) => {
    setEnded((xs) => [...xs.filter((x) => x.id !== job.id), job]);
    if (job.state !== 'succeeded') return;
    const t = window.setTimeout(() => { timers.current.delete(t); dismiss(job.id); }, FOLDED_MS);
    timers.current.add(t);
  }, [dismiss]);
  return { ended, end, dismiss };
}

/** 在跑的与已结束的并成一叠，按创建时间排、最新的在前（贴着输入框） */
export function jobChips(running: RunningJob[], ended: EndedJob[]): JobChip[] {
  const done = new Set(ended.map((x) => x.id));
  const chips: JobChip[] = [
    ...running.filter((j) => !done.has(j.id)).map((j) => ({ ...j, state: 'running' as const })),
    ...ended.map((x): JobChip => (x.state === 'failed'
      ? { id: x.id, createdAt: x.createdAt, label: x.label, state: 'failed', reason: x.reason, retryable: RETRYABLE.includes(x.kind) }
      : { id: x.id, createdAt: x.createdAt, label: x.label, state: 'succeeded' })),
  ];
  return chips.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 叠在输入框（收起时是胶囊）上方的那一叠：最新的贴着输入框，往上依次更早；超过 3 枚时其余折成「还有 N 个」，
// 最新的在跑作业永不被折进去（画布上 Esc 取消的就是它，escCancels 时它的 × 提示标出 Esc；草稿本的 Esc 是收起看板，不标）。
// 整叠不挂 aria-live——N 个作业各自每几秒一次进度会把读屏刷爆，每枚只在成功或失败时用它自己的 role=status 读一句结果
export function JobChips({ chips, escCancels, onCancel, onRetry, onDismiss }: { chips: JobChip[]; escCancels: boolean; onCancel: (id: string) => void; onRetry: (id: string) => Promise<void>; onDismiss: (id: string) => void }) {
  const t = useT(composerMessages);
  if (!chips.length) return null;
  const escId = chips.find((c) => c.state === 'running')?.id;
  let shown = chips.slice(0, MAX_CHIPS);
  if (escId && !shown.some((c) => c.id === escId)) shown = [...shown.slice(0, MAX_CHIPS - 1), chips.find((c) => c.id === escId)!];
  const more = chips.length - shown.length;
  // DOM 里由远及近排（「还有 N 个」在最上，最新的在最后）：后画的盖住先画的，每枚往上探出的按钮提示才不会被上面那枚压住
  return (
    <ul aria-label={t('jobs.label')} data-testid="job-chips" className="flex flex-col gap-1.5">
      {more > 0 && <li data-testid="job-chips-more" className="chrome pointer-events-auto rounded-pill px-3.5 py-2 type-label text-text-secondary">{t('jobs.more', { count: more })}</li>}
      {[...shown].reverse().map((c) => <Chip key={c.id} chip={c} esc={escCancels && c.id === escId} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />)}
    </ul>
  );
}

// chip 上有「重试」按钮时，失败文案末尾那句「点「重试」…」是同一件事说两遍：只留前面的原因（句号后那一句去掉）。
// 英文文案没有「。」，句号是「. 」：没有「。」时按最后一个「. 」断
const dropNext = (reason: string) => { const zh = reason.lastIndexOf('。'); const i = zh > 0 ? zh : reason.lastIndexOf('. '); return i > 0 ? reason.slice(0, i + 1) : reason; };

// 一枚 chip。结果句写在同一个 role=status 节点里：它从在跑起就在（在跑时是空的 sr-only），失败或成功时填进文字，读屏读一次；
// 在跑的进度写在它旁边另一个节点，不进播报
function Chip({ chip: c, esc, onCancel, onRetry, onDismiss }: { chip: JobChip; esc: boolean; onCancel: (id: string) => void; onRetry: (id: string) => Promise<void>; onDismiss: (id: string) => void }) {
  const t = useT(composerMessages);
  const tc = useT(commonMessages);
  // 重试在途：ref 挡住同一帧里的连点（state 要到下一次渲染才生效），state 给按钮转圈
  const [retrying, setRetrying] = useState(false);
  const inflight = useRef(false);
  const retry = async () => {
    if (inflight.current) return;
    inflight.current = true; setRetrying(true);
    try { await onRetry(c.id); } finally { inflight.current = false; setRetrying(false); }
  };
  const leaving = useDoneTimer(c.state === 'succeeded', () => onDismiss(c.id));
  const ref = useRef<HTMLLIElement>(null);
  useShrinkOnDone(ref, c.state);
  const shape = c.state === 'failed'
    ? 'tint-warning items-start rounded-lg py-0.5 pl-3 pr-0.5 shadow-(--semantic-elevation-panel)'
    : cn('chrome h-9 items-center rounded-pill pl-3 pr-0.5', c.state === 'succeeded' && 'job-chip-done max-w-full self-start', leaving.on && 'job-chip-leaving');
  return (
    <li ref={ref} data-testid="job-chip" data-job-id={c.id} data-state={c.state} className={cn('fade-up pointer-events-auto flex gap-2 type-label', shape)} {...leaving.hold}>
      {c.state === 'running' ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
        : c.state === 'failed' ? <TriangleAlert size={14} className="mt-[9px] shrink-0" aria-hidden="true" />
        : <CircleCheck size={16} className="job-done-icon shrink-0 text-success" aria-hidden="true" />}
      {c.state === 'running' && (
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-text-primary">{c.label}</span>
          <span className="text-text-secondary"> · {c.progress}</span>
        </span>
      )}
      <span role="status" className={c.state === 'running' ? 'sr-only' : c.state === 'failed' ? 'min-w-0 flex-1 py-1.5 [overflow-wrap:anywhere]' : 'min-w-0 flex-1 truncate pr-0.5'}>
        {c.state === 'failed' && <><span className="font-medium">{c.label}</span> · {c.retryable ? dropNext(c.reason) : c.reason}</>}
        {c.state === 'succeeded' && <span className="job-done-text"><span className="font-medium text-text-primary">{t('jobs.done')}</span><span className="text-text-secondary"> · {c.label}</span></span>}
      </span>
      {c.state === 'running' && (
        // 画布上按 Esc（没有更近的一层可关时）取消的正是最新的在跑作业，它的 × 提示标出 Esc
        <IconButton size="xs" tip="top-end" label={t('jobs.cancel', { label: c.label })} hint={esc ? 'Esc' : undefined} className="rounded-pill" data-testid="cancel-job" onClick={() => onCancel(c.id)}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      )}
      {c.state === 'failed' && (
        <span className="flex shrink-0 items-center gap-0.5">
          {c.retryable && (
            <button type="button" data-testid="retry-job" aria-label={t('jobs.retry', { label: c.label })} aria-busy={retrying || undefined} onClick={() => void retry()}
              className="fill state-layer focus-ring inline-flex h-8 items-center gap-1.5 rounded-pill px-3 font-medium text-text-primary">
              {retrying && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />}{tc('retry')}
            </button>
          )}
          <IconButton size="xs" tip="top-end" label={t('jobs.dismiss', { label: c.label })} className="rounded-pill" data-testid="dismiss-job" onClick={() => onDismiss(c.id)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </span>
      )}
      {c.state === 'succeeded' && (
        // 完成态的 ×：平时不占位，悬停或键盘获焦时槽位展开、chip 向右长出它（.job-done-slot / .job-done-close）
        <span className="job-done-slot">
          <IconButton size="xs" tip="top-end" label={t('jobs.dismissDone', { label: c.label })} className="job-done-close rounded-pill" data-testid="dismiss-job" onClick={() => onDismiss(c.id)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </li>
  );
}

// 转成完成态时收窄（v1.36）：完成态的 chip 宽度只包住对勾与文字，左缘不动；转的那一帧量出在跑时的宽度，
// 用 motion.duration.slow 与 motion.easing.emphasized 从旧宽度过渡到新宽度（只动这一枚浮层的宽度，保住圆角、描边与阴影）。减弱动态时直接到位
function useShrinkOnDone(ref: React.RefObject<HTMLLIElement | null>, state: JobChip['state']) {
  const running = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (state === 'running') { running.current = el.getBoundingClientRect().width; return; }
    const from = running.current;
    running.current = null;
    if (state !== 'succeeded' || from === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = el.getBoundingClientRect().width;
    if (from <= to + 1) return;
    const root = getComputedStyle(document.documentElement);
    el.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: cssMs(root.getPropertyValue('--semantic-motion-duration-slow'), 320),
      easing: root.getPropertyValue('--semantic-motion-easing-emphasized').trim() || 'ease-out',
    });
  });
}

// 完成态的计时（v1.33）：开始时算出截止时刻，悬停、获焦、页面在后台时停表、折回剩余时长，恢复时按新的此刻重算（COMP-009）；
// 到点先标 leaving 淡出 200 ms，再撤掉
function useDoneTimer(active: boolean, onGone: () => void) {
  const [on, setOn] = useState(false);
  const goneRef = useRef(onGone); goneRef.current = onGone;
  const ctl = useRef<{ hold: (why: string, held: boolean) => void }>({ hold: () => {} });
  useEffect(() => {
    if (!active) return;
    let left = DONE_MS; let due = 0; let timer = 0; let fading = false;
    const held = new Set<string>();
    const fire = () => { fading = true; setOn(true); timer = window.setTimeout(() => goneRef.current(), FADE_MS); };
    const run = () => { if (held.size || timer || fading) return; due = Date.now() + left; timer = window.setTimeout(() => { timer = 0; fire(); }, left); };
    const stop = () => { if (!timer || fading) return; window.clearTimeout(timer); timer = 0; left = Math.max(1000, due - Date.now()); };
    const c = ctl.current;
    c.hold = (why, on) => { if (on) { held.add(why); stop(); } else { held.delete(why); run(); } };
    const vis = () => c.hold('hidden', document.hidden);
    vis();
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); window.clearTimeout(timer); c.hold = () => {}; };
  }, [active]);
  return {
    on,
    hold: active ? {
      onPointerEnter: () => ctl.current.hold('hover', true), onPointerLeave: () => ctl.current.hold('hover', false),
      onFocus: () => ctl.current.hold('focus', true),
      onBlur: (e: React.FocusEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctl.current.hold('focus', false); },
    } : {},
  };
}
