import { useMemo, useState } from 'react';
import type { ScreenDto, LinkDto } from '@quilt/core/browser';
import { Button, EmptyState, Panel } from '@/ui/ui';
import { screenBadges } from '@/canvas/ScreenFinder';
import { useT } from '@/i18n';
import inspectMessages from '@/i18n/locales/panels-inspect';
import commonMessages from '@/i18n/locales/common';

// 屏列表面板（REQ-CORE-024 v0.61）：按画布阅读顺序（先上后左）列全部屏，变体紧跟默认屏、缩进一级；
// 筛选片带计数，点行把镜头摆过去并单选。数据全来自项目详情，零 token。
// 筛选片的名字与各筛选的空态在 panels-inspect 命名空间的 screens.filter.<key> / screens.empty.<key>
type Filter = 'all' | 'dangling' | 'candidates' | 'deviations' | 'busy';
const FILTERS: Filter[] = ['all', 'dangling', 'candidates', 'deviations', 'busy'];

export function ScreensPanel({ screens, links, busy, onPick, onClose }: { screens: ScreenDto[]; links: LinkDto[]; busy: Set<string>; onPick: (id: string) => void; onClose: () => void }) {
  const t = useT(inspectMessages);
  const tc = useT(commonMessages);
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
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, screens.filter((s) => matches(s, f)).length])) as Record<Filter, number>, [screens, danglingOf, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = ordered.filter((o) => matches(o.s, filter));
  return (
    <Panel title={t('screens.title', { n: screens.length })} className="h-full" actions={<Button size="sm" onClick={onClose}>{tc('close')}</Button>}>
      <div className="flex flex-wrap gap-1 border-b border-border-subtle p-2" role="group" aria-label={t('screens.filterLabel')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} data-testid={`screens-filter-${f}`} onClick={() => setFilter(f)}
            className={`rounded-pill px-2.5 py-0.5 type-label tabular-nums focus-ring ${filter === f ? 'tint-link font-medium' : 'fill text-text-secondary state-layer'}`}>
            {t(`screens.filter.${f}`)} {counts[f]}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <EmptyState title={filter === 'all' ? t('screens.emptyTitle') : t(`screens.empty.${filter}`)} hint={filter === 'all' ? t('screens.emptyHint') : undefined} /> : (
        <ul className="scroll flex-1 p-1" data-testid="screens-list">
          {rows.map(({ s, depth }) => (
            <li key={s.id}>
              <button type="button" data-testid="screens-row" data-id={s.id} onClick={() => onPick(s.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left type-body state-layer focus-ring"
                style={depth ? { paddingLeft: `${0.5 + depth * 1}rem` } : undefined}>
                <span className="min-w-0 truncate">
                  {depth > 0 && <span className="fill mr-1 rounded-sm px-1 type-caption text-text-secondary">{t('screens.variant')}</span>}
                  {s.presentation === 'overlay' && <span className="fill mr-1 rounded-sm px-1 type-caption text-text-secondary">{t('screens.overlay')}</span>}
                  <b className="text-text-primary">{s.name}</b> <span className="text-text-secondary">{s.route}</span>
                </span>
                {(() => { const b = screenBadges(s, links, busy); return b.length ? <span className="shrink-0 type-caption text-text-secondary">{b.join(' · ')}</span> : null; })()}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
