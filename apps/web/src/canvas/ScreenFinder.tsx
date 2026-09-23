import { useMemo, useState } from 'react';
import type { ScreenDto, ComponentDto, LinkDto } from '@quilt/core';
import { Button, Input } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';

// 跳屏面板（REQ-CORE-024 v0.61）：⌘K 打开，按名字 / 路由 / 用途做不区分大小写的子串匹配——名字命中排最前、路由次之、用途最后，
// 共享组件按名字排在屏之后。↑↓ 选、Enter 跳、Esc 关（Esc / 焦点陷阱 / 背景 inert 由 useModal 管）。
export type FinderPick = { kind: 'screen' | 'component'; id: string };
type Row = FinderPick & { title: string; sub: string; badges: string[]; score: number };
const MAX_ROWS = 12;

export function screenBadges(s: ScreenDto, links: LinkDto[], busy: Set<string>): string[] {
  const dangling = links.filter((l) => l.fromScreenId === s.id && !l.toScreenId).length;
  const out: string[] = [];
  if (dangling) out.push(`断链 ${dangling}`);
  if (s.pendingCandidates) out.push(`${s.pendingCandidates.count} 版待选`);
  if (s.deviations) out.push(`${s.deviations} 处偏离`);
  if (busy.has(s.id)) out.push('正在改');
  return out;
}

export function ScreenFinder({ screens, components, links, busy, onPick, onClose }: {
  screens: ScreenDto[]; components: ComponentDto[]; links: LinkDto[]; busy: Set<string>;
  onPick: (pick: FinderPick) => void; onClose: () => void;
}) {
  const ref = useModal<HTMLDivElement>(onClose);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: string) => !!q && s.toLowerCase().includes(q);
    const all: Row[] = [
      ...screens.map((s) => ({
        kind: 'screen' as const, id: s.id, title: s.name, sub: s.route, badges: screenBadges(s, links, busy),
        score: !q ? 1 : hit(s.name) ? 3 : hit(s.route) ? 2 : hit(s.purpose) ? 1 : 0,
      })),
      ...components.map((c) => ({ kind: 'component' as const, id: c.id, title: c.name, sub: `组件 · 用于 ${c.usedBy.length} 屏`, badges: [], score: !q ? 0.5 : hit(c.name) ? 1.5 : 0 })),
    ];
    return all.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, MAX_ROWS);
  }, [query, screens, components, links, busy]);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const pick = (r: Row | undefined) => { if (r) onPick({ kind: r.kind, id: r.id }); };
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="跳到屏" tabIndex={-1} data-testid="screen-finder"
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl fade-up outline-none">
        <div className="border-b border-line p-2">
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }} placeholder="输入屏名、路由或用途…" aria-label="搜索屏与组件" autoComplete="off" spellCheck={false} data-testid="finder-input"
            role="combobox" aria-expanded aria-controls="finder-list" aria-activedescendant={rows[at] ? `finder-${rows[at].id}` : undefined}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(rows[at]); }
            }} />
        </div>
        <ul id="finder-list" role="listbox" aria-label="匹配结果" className="scroll max-h-[50dvh] p-1" data-testid="finder-list">
          {rows.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">没有匹配的屏或组件</li>}
          {rows.map((r, i) => (
            <li key={`${r.kind}:${r.id}`} id={`finder-${r.id}`} role="option" aria-selected={i === at} data-testid="finder-row" data-id={r.id} data-kind={r.kind}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${i === at ? 'bg-accent/15' : 'hover:bg-panel-2'}`}
              onMouseEnter={() => setCursor(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
              <span className="min-w-0 truncate"><b className="text-fg">{r.title}</b> <span className="text-muted">{r.sub}</span></span>
              {r.badges.length > 0 && <span className="shrink-0 text-[11px] text-muted">{r.badges.join(' · ')}</span>}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted"><span>↑↓ 选择</span><span>Enter 跳过去</span><span>Esc 关闭</span><Button size="sm" className="ml-auto" data-testid="finder-close" onClick={onClose}>关闭</Button></div>
      </div>
    </Overlay>
  );
}
