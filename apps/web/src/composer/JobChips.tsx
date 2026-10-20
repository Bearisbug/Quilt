import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, TriangleAlert, X } from 'lucide-react';
import type { JobKind } from '@quilt/core/browser';
import { cn, IconButton } from '@/ui/ui';

/** 作业 chip（PAGE-CANVAS「作业 chip」v1.17，REQ-CORE-020 / REQ-CORE-026）：在跑的写在做什么与进度；失败的写原因、可重试；成功的写「完成」后淡出 */
export type JobChip = { id: string; createdAt: string; label: string } & (
  | { state: 'running'; progress: string }
  | { state: 'failed'; reason: string; retryable: boolean }
  | { state: 'succeeded' }
);
/** 页面交来的在跑作业：label = 它在做什么，progress = 当前阶段 */
export type RunningJob = { id: string; createdAt: string; label: string; progress: string };
/** 已结束、还要留一会儿的作业：失败的留到用户关掉，成功的留到淡出完 */
export type EndedJob = { id: string; createdAt: string; label: string; kind: JobKind } & ({ state: 'failed'; reason: string } | { state: 'succeeded' });

// 能原样再发一轮的作业种类：与 API-CORE-034 服务端的口径一致（其余种类没有可重发的那一轮，回原入口再点一次）
const RETRYABLE: readonly JobKind[] = ['generate', 'edit_screens', 'edit_component', 'chat'];
/** 最多摆几枚，其余折成一枚「还有 N 个」 */
const MAX_CHIPS = 3;
// 成功的 chip：写「完成」停 1 s，再用 200 ms 淡出（styles.css 的 .job-chip-out），淡完撤掉
const DONE_MS = 1200;

/** 页面上已结束作业的那一份状态：end 在作业终态事件里调，dismiss 是失败 chip 的 ×、或重试发出去之后撤掉旧的那枚 */
export function useEndedJobs() {
  const [ended, setEnded] = useState<EndedJob[]>([]);
  const timers = useRef(new Set<number>());
  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);
  const dismiss = useCallback((id: string) => setEnded((xs) => xs.filter((x) => x.id !== id)), []);
  const end = useCallback((job: EndedJob) => {
    setEnded((xs) => [...xs.filter((x) => x.id !== job.id), job]);
    if (job.state !== 'succeeded') return;
    const t = window.setTimeout(() => { timers.current.delete(t); dismiss(job.id); }, DONE_MS);
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
  if (!chips.length) return null;
  const escId = chips.find((c) => c.state === 'running')?.id;
  let shown = chips.slice(0, MAX_CHIPS);
  if (escId && !shown.some((c) => c.id === escId)) shown = [...shown.slice(0, MAX_CHIPS - 1), chips.find((c) => c.id === escId)!];
  const more = chips.length - shown.length;
  // DOM 里由远及近排（「还有 N 个」在最上，最新的在最后）：后画的盖住先画的，每枚往上探出的按钮提示才不会被上面那枚压住
  return (
    <ul aria-label="作业" data-testid="job-chips" className="flex flex-col gap-1.5">
      {more > 0 && <li data-testid="job-chips-more" className="chrome pointer-events-auto rounded-pill px-3.5 py-2 type-label text-text-secondary">还有 {more} 个</li>}
      {[...shown].reverse().map((c) => <Chip key={c.id} chip={c} esc={escCancels && c.id === escId} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />)}
    </ul>
  );
}

// chip 上有「重试」按钮时，失败文案末尾那句「点「重试」…」是同一件事说两遍：只留前面的原因（句号后那一句去掉）
const dropNext = (reason: string) => { const i = reason.lastIndexOf('。'); return i > 0 ? reason.slice(0, i + 1) : reason; };

// 一枚 chip。结果句写在同一个 role=status 节点里：它从在跑起就在（在跑时是空的 sr-only），失败或成功时填进文字，读屏读一次；
// 在跑的进度写在它旁边另一个节点，不进播报
function Chip({ chip: c, esc, onCancel, onRetry, onDismiss }: { chip: JobChip; esc: boolean; onCancel: (id: string) => void; onRetry: (id: string) => Promise<void>; onDismiss: (id: string) => void }) {
  // 重试在途：ref 挡住同一帧里的连点（state 要到下一次渲染才生效），state 给按钮转圈
  const [retrying, setRetrying] = useState(false);
  const inflight = useRef(false);
  const retry = async () => {
    if (inflight.current) return;
    inflight.current = true; setRetrying(true);
    try { await onRetry(c.id); } finally { inflight.current = false; setRetrying(false); }
  };
  const shape = c.state === 'failed'
    ? 'tint-warning items-start rounded-lg py-0.5 pl-3 pr-0.5 shadow-(--semantic-elevation-panel)'
    : cn('chrome h-9 items-center rounded-pill pl-3', c.state === 'running' ? 'pr-0.5' : 'job-chip-out pr-3');
  return (
    <li data-testid="job-chip" data-job-id={c.id} data-state={c.state} className={cn('fade-up pointer-events-auto flex gap-2 type-label', shape)}>
      {c.state === 'running' ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
        : c.state === 'failed' ? <TriangleAlert size={14} className="mt-[9px] shrink-0" aria-hidden="true" />
        : <Check size={14} className="shrink-0 text-success" aria-hidden="true" />}
      {c.state === 'running' && (
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-text-primary">{c.label}</span>
          <span className="text-text-secondary"> · {c.progress}</span>
        </span>
      )}
      <span role="status" className={c.state === 'running' ? 'sr-only' : c.state === 'failed' ? 'min-w-0 flex-1 py-1.5 [overflow-wrap:anywhere]' : 'min-w-0 flex-1 truncate'}>
        {c.state === 'failed' && <><span className="font-medium">{c.label}</span> · {c.retryable ? dropNext(c.reason) : c.reason}</>}
        {c.state === 'succeeded' && <><span className="font-medium text-text-primary">{c.label}</span><span className="text-text-secondary"> · 完成</span></>}
      </span>
      {c.state === 'running' && (
        // 画布上按 Esc（没有更近的一层可关时）取消的正是最新的在跑作业，它的 × 提示标出 Esc
        <IconButton size="xs" tip="top-end" label={`取消${c.label}`} hint={esc ? 'Esc' : undefined} className="rounded-pill" data-testid="cancel-job" onClick={() => onCancel(c.id)}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      )}
      {c.state === 'failed' && (
        <span className="flex shrink-0 items-center gap-0.5">
          {c.retryable && (
            <button type="button" data-testid="retry-job" aria-label={`重试${c.label}`} aria-busy={retrying || undefined} onClick={() => void retry()}
              className="fill state-layer focus-ring inline-flex h-8 items-center gap-1.5 rounded-pill px-3 font-medium text-text-primary">
              {retrying && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />}重试
            </button>
          )}
          <IconButton size="xs" tip="top-end" label={`关掉「${c.label}」的失败提示`} className="rounded-pill" data-testid="dismiss-job" onClick={() => onDismiss(c.id)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </li>
  );
}
