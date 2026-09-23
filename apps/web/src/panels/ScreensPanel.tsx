import { useMemo, useState } from 'react';
import type { ScreenDto, LinkDto } from '@quilt/core';
import { Button, EmptyState, Panel } from '@/ui/ui';
import { screenBadges } from '@/canvas/ScreenFinder';

// 屏列表面板（REQ-CORE-024 v0.61）：按画布阅读顺序（先上后左）列全部屏，变体紧跟默认屏、缩进一级；
// 筛选片带计数，点行把镜头摆过去并单选。数据全来自项目详情，零 token。
type Filter = 'all' | 'dangling' | 'candidates' | 'deviations' | 'busy';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'dangling', label: '断链' }, { key: 'candidates', label: '待选候选' }, { key: 'deviations', label: '有偏离' }, { key: 'busy', label: '正在改' },
];
const EMPTY: Record<Exclude<Filter, 'all'>, string> = { dangling: '没有断链的屏', candidates: '没有待采用的候选', deviations: '没有偏离设计契约的屏', busy: '没有正在改的屏' };

export function ScreensPanel({ screens, links, busy, onPick, onClose }: { screens: ScreenDto[]; links: LinkDto[]; busy: Set<string>; onPick: (id: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const danglingOf = useMemo(() => { const m = new Map<string, number>(); for (const l of links) if (!l.toScreenId) m.set(l.fromScreenId, (m.get(l.fromScreenId) ?? 0) + 1); return m; }, [links]);
  const matches = (s: ScreenDto, f: Filter) => f === 'all' || (f === 'dangling' ? !!danglingOf.get(s.id) : f === 'candidates' ? !!s.pendingCandidates : f === 'deviations' ? s.deviations > 0 : busy.has(s.id));
  // 阅读顺序：默认屏按 y 再 x；每个默认屏后面跟它的变体（同样按位置）
  const ordered = useMemo(() => {
    const byPos = (a: ScreenDto, b: ScreenDto) => a.y - b.y || a.x - b.x;
    const bases = screens.filter((s) => !s.variantOf).sort(byPos);
    const out: { s: ScreenDto; depth: number }[] = [];
    for (const b of bases) { out.push({ s: b, depth: 0 }); for (const v of screens.filter((s) => s.variantOf === b.id).sort(byPos)) out.push({ s: v, depth: 1 }); }
    // 默认屏已删而变体还在（不该发生，级联删除）——兜底列在末尾
    for (const s of screens) if (!out.some((o) => o.s.id === s.id)) out.push({ s, depth: 0 });
    return out;
  }, [screens]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, screens.filter((s) => matches(s, f.key)).length])) as Record<Filter, number>, [screens, danglingOf, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = ordered.filter((o) => matches(o.s, filter));
  return (
    <Panel title={`屏 · ${screens.length}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      <div className="flex flex-wrap gap-1 border-b border-line p-2" role="group" aria-label="筛选">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} data-testid={`screens-filter-${f.key}`} onClick={() => setFilter(f.key)}
            className={`rounded-full border px-2 py-0.5 text-xs tabular-nums ${filter === f.key ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'}`}>
            {f.label} {counts[f.key]}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <EmptyState title={filter === 'all' ? '还没有屏' : EMPTY[filter]} hint={filter === 'all' ? '在下方输入框描述这个 APP，造出第一批屏' : undefined} /> : (
        <ul className="scroll flex-1 p-1" data-testid="screens-list">
          {rows.map(({ s, depth }) => (
            <li key={s.id}>
              <button type="button" data-testid="screens-row" data-id={s.id} onClick={() => onPick(s.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent"
                style={depth ? { paddingLeft: `${0.5 + depth * 1}rem` } : undefined}>
                <span className="min-w-0 truncate">
                  {depth > 0 && <span className="mr-1 rounded-full border border-line px-1 text-[10px] text-muted">变体</span>}
                  {s.presentation === 'overlay' && <span className="mr-1 rounded-full border border-line px-1 text-[10px] text-muted">叠层</span>}
                  <b className="text-fg">{s.name}</b> <span className="text-muted">{s.route}</span>
                </span>
                {(() => { const b = screenBadges(s, links, busy); return b.length ? <span className="shrink-0 text-[11px] text-muted">{b.join(' · ')}</span> : null; })()}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
