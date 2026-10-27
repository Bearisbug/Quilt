import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, ChevronRight, MoreHorizontal, Plus, X } from 'lucide-react';
import type { LinkDto, ScreenDto } from '@quilt/core/browser';
import { cn } from '@/ui/ui';
import { useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';

// 屏目录（PAGE-FULLVIEW「屏目录」，FLOW-FULLVIEW S2 / S4）：从入口屏顺着链接点得到的屏收成最上面一条，可展开；其余的屏按分组分节，
// 节按组里第一屏在画布上的阅读顺序排，「未分组」放最后；节内按画布阅读顺序，变体缩进跟在默认屏下面。
// 点一项或焦点在目录里时按 ↑ ↓ 换屏（收着的那一条算一项）；每项「…」里有改名，分组里的屏还能移到分组（API-CORE-012 的 group）
const MENU_ITEM_CLS = 'state-layer relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:text-text-primary';
// 画布阅读顺序：先上后下、同一行从左到右（同一行 = 上沿差不到半屏高）
const readingOrder = (a: ScreenDto, b: ScreenDto) => (Math.abs(a.y - b.y) < Math.min(a.height, b.height) / 2 ? a.x - b.x : a.y - b.y);

type DirItem = { screen: ScreenDto; variant: boolean };
const withVariants = (s: ScreenDto, variants: ScreenDto[]): DirItem[] => [
  { screen: s, variant: !!s.variantOf },
  ...variants.filter((v) => v.variantOf === s.id).sort(readingOrder).map((v) => ({ screen: v, variant: true })),
];

export type DirChain = { entry: ScreenDto; items: DirItem[]; count: number; ids: Set<string> };
/**
 * 收成一条的屏：入口屏是这一端最早建的、已生成的整屏（与导出原型的起点同一口径，API-PROTO-002；screens 按建屏先后排），
 * 从它顺着链接（API-PROTO-001）一步步点得到的默认屏按步数排、同一步按画布阅读顺序；入口屏链不到别的屏时为 null
 */
export function directoryChain(screens: ScreenDto[], links: LinkDto[]): DirChain | null {
  const entry = screens.find((s) => !s.variantOf && s.presentation !== 'overlay' && s.currentRevisionId);
  if (!entry) return null;
  const byId = new Map(screens.map((s) => [s.id, s]));
  const seen = new Set([entry.id]);
  const reached: ScreenDto[] = [];
  for (let step = [entry]; step.length;) {
    reached.push(...step);
    const next: ScreenDto[] = [];
    for (const from of step) {
      for (const l of links) {
        const to = l.fromScreenId === from.id && l.toScreenId ? byId.get(l.toScreenId) : undefined;
        if (to && !to.variantOf && !seen.has(to.id)) { seen.add(to.id); next.push(to); }
      }
    }
    step = next.sort(readingOrder);
  }
  if (reached.length < 2) return null;
  const variants = screens.filter((s) => s.variantOf);
  const items = reached.flatMap((s) => withVariants(s, variants));
  return { entry, items, count: reached.length, ids: new Set(items.map((i) => i.screen.id)) };
}

export type DirSection = { group: string | null; items: DirItem[] };
/** 分组的分节与排序，chained 里的屏（收成一条的那些）不进分组；导出给页面算 ↑ ↓ 的顺序与「同一节下一屏」 */
export function directorySections(screens: ScreenDto[], chained?: ReadonlySet<string>): DirSection[] {
  const bases = screens.filter((s) => !s.variantOf && !chained?.has(s.id)).sort(readingOrder);
  const variants = screens.filter((s) => s.variantOf);
  const groups = new Map<string | null, ScreenDto[]>();
  for (const s of bases) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  // 默认屏已不在（只剩变体）的变体归进它自己的分组，排在节尾
  const orphans = variants.filter((v) => !chained?.has(v.id) && !bases.some((b) => b.id === v.variantOf)).sort(readingOrder);
  for (const v of orphans) groups.set(v.group, [...(groups.get(v.group) ?? []), v]);
  const keys = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));
  return keys.map((group) => ({ group, items: (groups.get(group) ?? []).flatMap((s) => withVariants(s, variants)) }));
}

type Edit = { id: string; kind: 'rename' | 'group'; draft: string } | null;

export function ScreenDirectory({ chain, expanded, onExpand, sections, currentId, groups, onPick, onRename, onMoveGroup }: {
  chain: DirChain | null; expanded: boolean; onExpand: (open: boolean) => void;
  sections: DirSection[]; currentId: string | null; groups: string[];
  onPick: (id: string) => void;
  onRename: (s: ScreenDto, name: string) => Promise<boolean>;
  onMoveGroup: (s: ScreenDto, group: string | null) => Promise<boolean>;
}) {
  const t = useT(fullviewMessages);
  const listRef = useRef<HTMLDivElement>(null);
  const chainListId = useId();
  const [edit, setEdit] = useState<Edit>(null);
  const folded = !!chain && !expanded;
  // ↑ ↓ 走看得见的项：收着的那一条算一项，对应入口屏
  const order = useMemo(() => [
    ...(chain ? (expanded ? chain.items.map((i) => i.screen.id) : [chain.entry.id]) : []),
    ...sections.flatMap((x) => x.items.map((i) => i.screen.id)),
  ], [chain, expanded, sections]);
  // 正看的屏收在那一条里时，目录里代表它的是那一条
  const inside = !!currentId && !!chain?.ids.has(currentId);
  const at = chain && inside && !expanded ? chain.entry.id : currentId;
  const tabStop = at ?? order[0];
  const focusItem = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-dir-item="${id}"]`)?.focus());
  // ↑ ↓ 换屏并把焦点带过去（改名、新分组的输入框里不接）
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if ((e.target as HTMLElement).closest('input')) return;
    const i = at ? order.indexOf(at) : -1;
    const next = order[e.key === 'ArrowDown' ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1)];
    if (!next) return;
    e.preventDefault();
    if (next !== at) onPick(next);
    focusItem(next);
  };
  const toggle = () => {
    if (expanded && edit && chain?.ids.has(edit.id)) setEdit(null);
    onExpand(!expanded);
  };
  const finish = async (s: ScreenDto, save: boolean) => {
    const cur = edit;
    if (!cur) return;
    const v = cur.draft.trim();
    if (!save || !v) { setEdit(null); focusItem(s.id); return; }
    const ok = cur.kind === 'rename' ? (v === s.name ? true : await onRename(s, v)) : await onMoveGroup(s, v);
    if (ok) { setEdit(null); focusItem(s.id); }
  };
  const renderItem = ({ screen: s, variant }: DirItem, inChain: boolean) => {
    const e = edit?.id === s.id ? edit : null;
    if (e) return (
      <li key={s.id} className={cn('px-1.5 py-1', variant && 'pl-5')}>
        <div className="flex items-center gap-1">
          <input autoFocus aria-label={e.kind === 'rename' ? t('dir.renameInput', { name: s.name }) : t('dir.groupInput')} placeholder={e.kind === 'group' ? t('dir.groupPlaceholder') : undefined}
            data-testid={e.kind === 'rename' ? 'dir-rename-input' : 'dir-group-input'} value={e.draft} maxLength={e.kind === 'rename' ? 80 : 20}
            onChange={(ev) => setEdit({ ...e, draft: ev.target.value })}
            onKeyDown={(ev) => {
              // 输入法选字的那次回车不提交（INT-023）
              if (ev.key === 'Enter' && !ev.nativeEvent.isComposing && ev.keyCode !== 229) { ev.preventDefault(); void finish(s, true); }
              if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); void finish(s, false); }
            }}
            className="focus-ring fill min-w-0 flex-1 rounded-sm px-2 py-1 type-body text-text-primary" />
          <button type="button" aria-label={t('dir.save')} onClick={() => void finish(s, true)} className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-success"><Check size={14} aria-hidden="true" /></button>
          <button type="button" aria-label={t('dir.cancel')} onClick={() => void finish(s, false)} className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-error"><X size={14} aria-hidden="true" /></button>
        </div>
      </li>
    );
    return (
      <li key={s.id} className={cn('group flex items-center gap-0.5', variant && 'pl-4')}>
        <button type="button" data-dir-item={s.id} data-testid="dir-item" aria-current={s.id === currentId ? 'page' : undefined}
          tabIndex={s.id === tabStop ? 0 : -1}
          onClick={() => onPick(s.id)}
          className={cn('state-layer focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2.5 py-1.5 text-left', !inChain && 'aria-[current=page]:bg-(--semantic-color-surface-selected)')}>
          {variant && <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-text-secondary" />}
          {/* 那一条里的屏是第二层：正看的那屏不铺底色（那一条已经整行高亮），名字换强调色 */}
          <span className={cn('min-w-0 flex-1 truncate type-body', s.id !== currentId ? 'text-text-secondary' : inChain ? 'font-medium text-(--semantic-color-action-link)' : 'text-text-primary')}>{variant ? s.variantName ?? s.name : s.name}</span>
          {s.presentation === 'overlay' && <span className="fill shrink-0 rounded-sm px-1.5 type-caption text-text-secondary">{t('dir.overlay')}</span>}
        </button>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" tabIndex={-1} aria-label={t('dir.more', { name: s.name })} data-testid="dir-more"
              className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary opacity-0 transition-opacity duration-(--semantic-motion-duration-fast) group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="right" align="start" sideOffset={4} collisionPadding={12} onKeyDown={(ev) => ev.stopPropagation()}
              onCloseAutoFocus={(ev) => { if (edit) ev.preventDefault(); }}
              style={{ transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }} className="menu z-50 min-w-40 p-1.5">
              <DropdownMenu.Item className={MENU_ITEM_CLS} data-testid="dir-rename" onSelect={() => setEdit({ id: s.id, kind: 'rename', draft: s.name })}>{t('dir.rename')}</DropdownMenu.Item>
              {/* 变体跟着默认屏的分组走（API-CORE-012），只给默认屏移分组；收成一条的屏不按分组列，也不给移 */}
              {!s.variantOf && !inChain && (
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className={cn(MENU_ITEM_CLS, 'data-[state=open]:text-text-primary')} data-testid="dir-move">
                    <span className="flex-1">{t('dir.moveGroup')}</span><ChevronRight size={14} aria-hidden="true" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent sideOffset={4} collisionPadding={12} onKeyDown={(ev) => ev.stopPropagation()} className="menu z-50 min-w-40 p-1.5">
                      <DropdownMenu.RadioGroup value={s.group ?? ''} onValueChange={(v) => { if (v !== (s.group ?? '')) void onMoveGroup(s, v || null); }}>
                        {groups.map((g) => (
                          <DropdownMenu.RadioItem key={g} value={g} className={MENU_ITEM_CLS} data-testid="dir-group-option">
                            <span className="flex w-4 shrink-0 justify-center"><DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator></span>
                            <span className="min-w-0 flex-1 truncate">{g}</span>
                          </DropdownMenu.RadioItem>
                        ))}
                        <DropdownMenu.RadioItem value="" className={MENU_ITEM_CLS} data-testid="dir-group-none">
                          <span className="flex w-4 shrink-0 justify-center"><DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator></span>
                          <span className="min-w-0 flex-1 truncate">{t('dir.ungrouped')}</span>
                        </DropdownMenu.RadioItem>
                      </DropdownMenu.RadioGroup>
                      <DropdownMenu.Separator className="my-1.5 h-px bg-border-subtle" />
                      <DropdownMenu.Item className={MENU_ITEM_CLS} data-testid="dir-group-new" onSelect={() => setEdit({ id: s.id, kind: 'group', draft: '' })}>
                        <span className="flex w-4 shrink-0 justify-center"><Plus size={14} aria-hidden="true" /></span>{t('dir.newGroup')}
                      </DropdownMenu.Item>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </li>
    );
  };

  return (
    <div ref={listRef} onKeyDown={onKey} data-testid="screen-directory" className="flex flex-col gap-3 pb-2">
      {chain && (
        <section aria-label={t('dir.chain', { name: chain.entry.name })} data-testid="dir-chain" data-count={chain.count}>
          <div className="flex items-center gap-0.5">
            <button type="button" data-dir-item={folded ? chain.entry.id : undefined} data-testid="dir-chain-open"
              aria-current={inside ? 'true' : undefined} tabIndex={folded && tabStop === chain.entry.id ? 0 : -1}
              onClick={() => onPick(chain.entry.id)}
              className="state-layer focus-ring flex min-w-0 flex-1 items-center rounded-sm px-2.5 py-1.5 text-left aria-[current=true]:bg-(--semantic-color-surface-selected)">
              <span className={cn('min-w-0 flex-1 truncate type-body font-medium', inside ? 'text-text-primary' : 'text-text-secondary')}>{chain.entry.name}</span>
            </button>
            <button type="button" aria-expanded={expanded} aria-controls={expanded ? chainListId : undefined} data-testid="dir-chain-toggle"
              aria-label={expanded ? t('dir.collapse', { name: chain.entry.name }) : t('dir.expand', { name: chain.entry.name })} onClick={toggle}
              className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary">
              <ChevronDown size={16} aria-hidden="true" className={cn('transition-transform duration-(--semantic-motion-duration-fast) motion-reduce:transition-none', expanded && 'rotate-180')} />
            </button>
          </div>
          {expanded && (
            <ul id={chainListId} className="fade-up ml-2.5 mt-0.5 flex flex-col gap-0.5 border-l border-border-subtle pl-1">
              {chain.items.map((i) => renderItem(i, true))}
            </ul>
          )}
        </section>
      )}
      {sections.map((sec) => (
        <section key={sec.group ?? '\u0000'} aria-label={sec.group ?? t('dir.ungrouped')} data-testid="dir-section" data-group={sec.group ?? ''}>
          <h3 className="px-2.5 pb-1 type-overline font-semibold text-text-secondary">{sec.group ?? t('dir.ungrouped')}</h3>
          <ul className="flex flex-col gap-0.5">
            {sec.items.map((i) => renderItem(i, false))}
          </ul>
        </section>
      ))}
    </div>
  );
}
