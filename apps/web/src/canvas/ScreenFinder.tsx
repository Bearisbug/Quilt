import { useEffect, useMemo, useState } from 'react';
import type { ScreenDto, ComponentDto, LinkDto, SurfaceDto } from '@quilt/core/browser';
import { Button, Input } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { tOf, useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';
import commonMessages from '@/i18n/locales/common';

// 跳屏面板（REQ-CORE-024 v0.61）：⌘K 打开，按名字 / 路由 / 用途做不区分大小写的子串匹配——名字命中排最前、路由次之、用途最后，
// 共享组件按名字匹配、排在所有屏之后。命中项全部列出（v0.78），列表封顶 50dvh 内部滚动。↑↓ 选、Enter 跳、Esc 关（Esc / 焦点陷阱 / 背景 inert 由 useModal 管）。
// 项目有几端时（REQ-CORE-049）列全部端的屏、按端分节，当前这一端排最前；选了别的端的屏由页面切过去
export type FinderPick = { kind: 'screen' | 'component'; id: string };
type Row = FinderPick & { title: string; sub: string; badges: string[]; score: number; section: number };

// 角标在调用时按界面语言出字（屏列表面板也用它）
const tf = tOf(canvasMessages);
export function screenBadges(s: ScreenDto, links: LinkDto[], busy: Set<string>): string[] {
  const dangling = links.filter((l) => l.fromScreenId === s.id && !l.toScreenId).length;
  const out: string[] = [];
  if (dangling) out.push(tf('finder.dangling', { count: dangling }));
  if (s.pendingCandidates) out.push(tf('finder.candidates', { count: s.pendingCandidates.count }));
  if (s.deviations) out.push(tf('deviations', { count: s.deviations }));
  if (busy.has(s.id)) out.push(tf('finder.busy'));
  return out;
}

export function ScreenFinder({ screens, components, links, busy, surfaces = [], currentSurfaceId = null, onPick, onClose }: {
  screens: ScreenDto[]; components: ComponentDto[]; links: LinkDto[]; busy: Set<string>;
  surfaces?: SurfaceDto[]; currentSurfaceId?: string | null;
  onPick: (pick: FinderPick) => void; onClose: () => void;
}) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLDivElement>(onClose);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: string) => !!q && s.toLowerCase().includes(q);
    const order = [...surfaces].sort((a, b) => (a.id === currentSurfaceId ? -1 : b.id === currentSurfaceId ? 1 : a.position - b.position)).map((x) => x.id);
    const all: Row[] = [
      ...screens.map((s) => ({
        kind: 'screen' as const, id: s.id, title: s.name, sub: s.route, badges: screenBadges(s, links, busy),
        score: !q ? 1 : hit(s.name) ? 3 : hit(s.route) ? 2 : hit(s.purpose) ? 1 : 0,
        section: Math.max(0, order.indexOf(s.surfaceId ?? '')),
      })),
      ...components.map((c) => ({ kind: 'component' as const, id: c.id, title: c.name, sub: `${t('finder.component')} · ${t('usedIn', { count: c.usedBy.length })}`, badges: [], score: hit(c.name) || !q ? 0.5 : 0, section: order.length })),
    ];
    return all.filter((r) => r.score > 0).sort((a, b) => a.section - b.section || b.score - a.score || a.title.localeCompare(b.title));
  }, [query, screens, components, links, busy, surfaces, currentSurfaceId, t]);
  const sectioned = surfaces.length > 1;
  const orderedSurfaces = useMemo(() => [...surfaces].sort((a, b) => (a.id === currentSurfaceId ? -1 : b.id === currentSurfaceId ? 1 : a.position - b.position)), [surfaces, currentSurfaceId]);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const pick = (r: Row | undefined) => { if (r) onPick({ kind: r.kind, id: r.id }); };
  // 方向键移到列表可视区外的行时把它滚进来，Enter 跳的永远是看得见的那一行
  const activeId = rows[at]?.id;
  useEffect(() => { if (activeId) document.getElementById(`finder-${activeId}`)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('finder.title')} tabIndex={-1} data-testid="screen-finder"
        className="sheet flex w-full max-w-md flex-col overflow-hidden fade-up outline-none">
        <div className="border-b border-border-subtle p-3">
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }} placeholder={t('finder.placeholder')} aria-label={t('finder.search')} autoComplete="off" spellCheck={false} data-testid="finder-input"
            role="combobox" aria-expanded aria-controls="finder-list" aria-activedescendant={rows[at] ? `finder-${rows[at].id}` : undefined}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(rows[at]); }
            }} />
        </div>
        <ul id="finder-list" role="listbox" aria-label={t('finder.results')} className="scroll max-h-[50dvh] p-1" data-testid="finder-list">
          {rows.length === 0 && <li className="px-3 py-6 text-center type-label text-text-secondary">{t('finder.empty')}</li>}
          {rows.map((r, i) => [
            sectioned && r.kind === 'screen' && rows[i - 1]?.section !== r.section && (
              <li key={`section:${r.section}`} role="presentation" data-testid="finder-section" className="px-3 pb-1 pt-2 type-overline font-semibold text-text-secondary">{orderedSurfaces[r.section]?.name}</li>
            ),
            <li key={`${r.kind}:${r.id}`} id={`finder-${r.id}`} role="option" aria-selected={i === at} data-testid="finder-row" data-id={r.id} data-kind={r.kind}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 type-body ${i === at ? 'bg-(--semantic-color-surface-selected)' : 'state-layer'}`}
              onMouseEnter={() => setCursor(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
              <span className="min-w-0 truncate"><b className="font-medium text-text-primary">{r.title}</b> <span className="text-text-secondary">{r.sub}</span></span>
              {r.badges.length > 0 && <span className="shrink-0 type-caption text-text-secondary">{r.badges.join(' · ')}</span>}
            </li>,
          ])}
        </ul>
        <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 type-caption text-text-secondary"><span>{t('finder.keySelect')}</span><span>{t('finder.keyGo')}</span><span>{t('finder.keyClose')}</span><Button size="sm" className="ml-auto" data-testid="finder-close" onClick={onClose}>{tc('close')}</Button></div>
      </div>
    </Overlay>
  );
}
