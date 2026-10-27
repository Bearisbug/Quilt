import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import { Check, ChevronDown, Monitor, MoreHorizontal, Plus, Smartphone, X } from 'lucide-react';
import { MAX_SURFACES, type SurfaceDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, cn } from '@/ui/ui';
import { SurfaceDialog } from '@/project/SurfaceDialog';
import { useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';
import commonMessages from '@/i18n/locales/common';

// 端切换器（FLOW-SURFACE，PAGE-CANVAS「端」）：项目切换器后面一枚 chip，写当前端的名字；点开列各端（名字、设备、屏数），
// 每端行尾「…」里有改名与删除，底部「加一端…」。删除就地确认（ui-constraints SHADCN-006）：那一行换成后果与取消、删除，焦点落取消。
// 锚定浮层用 Radix Popover（Esc、点外面关闭、焦点归还），行内的「…」是嵌在里面的 Radix DropdownMenu
const ROW_CLS = 'state-layer focus-ring flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 text-left type-body text-text-secondary aria-[current=true]:bg-(--semantic-color-surface-selected) aria-[current=true]:text-text-primary';
const MENU_ITEM_CLS = 'state-layer relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:text-text-primary';
const DeviceIcon = ({ d }: { d: SurfaceDto['deviceType'] }) => (d === 'desktop' ? <Monitor size={14} aria-hidden="true" /> : <Smartphone size={14} aria-hidden="true" />);

type RowMode = { id: string; kind: 'rename'; draft: string; error: string | null; pending: boolean } | { id: string; kind: 'delete'; error: string | null; pending: boolean } | null;

export function SurfaceSwitcher({ projectId, surfaces, current, screenCounts, onSwitch, onChanged }: {
  projectId: string; surfaces: SurfaceDto[]; current: SurfaceDto; screenCounts: Record<string, number>;
  onSwitch: (id: string) => void; onChanged: () => Promise<unknown>;
}) {
  const t = useT(fullviewMessages);
  const tc = useT(commonMessages);
  const toast = useToast();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<RowMode>(null);
  useEffect(() => { if (!open) setMode(null); }, [open]);
  // 删除确认收起时（取消 / Esc）焦点还给那一行的「…」
  const moreRefs = useRef(new Map<string, HTMLButtonElement>());
  const endMode = (id: string) => { setMode(null); requestAnimationFrame(() => moreRefs.current.get(id)?.focus()); };
  const count = (id: string) => screenCounts[id] ?? 0;
  const full = surfaces.length >= MAX_SURFACES;

  const rename = async (s: SurfaceDto, raw: string) => {
    const name = raw.trim();
    if (!name || name === s.name) { endMode(s.id); return; }
    setMode({ id: s.id, kind: 'rename', draft: raw, error: null, pending: true });
    try {
      await api.surfaces.patch(s.id, { name, expectedVersion: s.version });
      toast(t('surface.renamed', { name }));
      void onChanged();
      endMode(s.id);
    } catch (e) {
      const error = e instanceof ApiError && e.type === '/errors/surface-name-taken' ? t('surface.nameTaken')
        : e instanceof ApiError && e.type === '/errors/version-conflict' ? t('surface.conflict')
          : e instanceof ApiError && e.type === '/errors/validation' ? (e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title
            : t('surface.failed');
      if (e instanceof ApiError && e.type === '/errors/version-conflict') void onChanged();
      setMode({ id: s.id, kind: 'rename', draft: raw, error, pending: false });
    }
  };
  const remove = async (s: SurfaceDto) => {
    setMode({ id: s.id, kind: 'delete', error: null, pending: true });
    try {
      await api.surfaces.remove(s.id);
      toast(t('surface.deleted', { name: s.name }));
      setMode(null);
      // 删的是正在看的这一端：切到剩下的第一端（useSurface 在详情刷新后自己落到第一端，这里先切过去免得闪一下空画布）
      if (s.id === current.id) { const next = surfaces.find((x) => x.id !== s.id); if (next) onSwitch(next.id); }
      void onChanged();
    } catch (e) {
      const error = e instanceof ApiError && e.type === '/errors/screen-busy' ? t('surface.busy')
        : e instanceof ApiError && e.type === '/errors/validation' ? (e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title
          : t('surface.deleteFailed');
      setMode({ id: s.id, kind: 'delete', error, pending: false });
    }
  };
  // 行与行之间用 ↑ ↓ 走（列表不是 Radix 菜单，方向键自己接）；改名框与确认里不接
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if ((e.target as HTMLElement).closest('[data-row-mode]')) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-surface-row], [data-surface-add]') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
    if (next) { e.preventDefault(); next.focus(); }
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger ref={triggerRef} data-testid="surface-switcher" aria-label={t('surface.trigger', { name: current.name })}
          className="chrome state-layer focus-ring group flex h-8 min-w-0 max-w-[min(14rem,calc(100vw-7rem))] items-center gap-1.5 rounded-md px-3 type-body font-medium text-text-primary">
          <span className="flex shrink-0 text-text-secondary"><DeviceIcon d={current.deviceType} /></span>
          <span className="truncate">{current.name}</span>
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-text-secondary transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} data-testid="surface-switcher-list"
            onOpenAutoFocus={(e) => { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus(); }}
            style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
            className="menu z-50 w-[min(19rem,calc(100vw-1.5rem))] p-1.5">
            <div ref={listRef} onKeyDown={onListKey}>
              <p className="px-2.5 pb-1 pt-1.5 type-overline font-semibold text-text-secondary">{t('surface.listLabel')}</p>
              <ul className="flex flex-col gap-0.5">
                {surfaces.map((s) => {
                  const m = mode?.id === s.id ? mode : null;
                  if (m?.kind === 'delete') return (
                    <li key={s.id} data-row-mode role="group" aria-label={t('surface.delete')} data-testid="surface-delete-confirm"
                      onKeyDown={(e) => { if (e.key === 'Escape' && !m.pending) { e.preventDefault(); e.stopPropagation(); endMode(s.id); } }}
                      className="rounded-sm px-2.5 py-2">
                      <p className="type-label text-text-primary">{count(s.id) ? t('surface.deleteQuestion', { name: s.name, count: count(s.id) }) : t('surface.deleteEmpty', { name: s.name })}</p>
                      {m.error && <p role="alert" className="mt-1 type-label text-error">{m.error}</p>}
                      <div className="mt-2 flex justify-end gap-2">
                        <Button size="sm" autoFocus onClick={() => endMode(s.id)} aria-disabled={m.pending || undefined}>{tc('cancel')}</Button>
                        <Button size="sm" variant="danger" data-testid="surface-delete-yes" aria-disabled={m.pending || undefined} onClick={() => { if (!m.pending) void remove(s); }}>{m.pending ? t('surface.deleting') : t('surface.delete')}</Button>
                      </div>
                    </li>
                  );
                  if (m?.kind === 'rename') return (
                    <li key={s.id} data-row-mode className="rounded-sm px-1.5 py-1">
                      <div className="flex items-center gap-1">
                        <input autoFocus data-testid="surface-rename-input" aria-label={t('surface.renameInput', { name: s.name })} value={m.draft} maxLength={20}
                          aria-invalid={m.error ? true : undefined} aria-describedby={m.error ? `sr-err-${s.id}` : undefined}
                          onChange={(e) => setMode({ ...m, draft: e.target.value, error: null })}
                          onKeyDown={(e) => {
                            // 输入法选字的那次回车不提交（INT-023）
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!m.pending) void rename(s, m.draft); }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endMode(s.id); }
                          }}
                          className="focus-ring fill min-w-0 flex-1 rounded-sm px-2 py-1 type-body text-text-primary" />
                        <button type="button" aria-label={t('surface.renameSave', { name: m.draft.trim() })} data-testid="surface-rename-save" aria-disabled={!m.draft.trim() || m.pending || undefined}
                          onClick={() => { if (m.draft.trim() && !m.pending) void rename(s, m.draft); }}
                          className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-success"><Check size={14} aria-hidden="true" /></button>
                        <button type="button" aria-label={t('surface.renameCancel')} onClick={() => endMode(s.id)}
                          className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-error"><X size={14} aria-hidden="true" /></button>
                      </div>
                      {m.error && <p id={`sr-err-${s.id}`} role="alert" className="mt-1 px-0.5 type-label text-error">{m.error}</p>}
                    </li>
                  );
                  return (
                    <li key={s.id} className="group flex items-center gap-0.5">
                      <button type="button" data-surface-row data-testid="surface-option" data-surface-id={s.id} aria-current={s.id === current.id}
                        onClick={() => { setOpen(false); if (s.id !== current.id) onSwitch(s.id); }} className={ROW_CLS}>
                        <span className="flex w-4 shrink-0 justify-center">{s.id === current.id && <Check size={14} aria-hidden="true" />}</span>
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="flex shrink-0 items-center gap-1 type-caption text-text-secondary"><DeviceIcon d={s.deviceType} />{t(s.deviceType === 'desktop' ? 'surface.desktop' : 'surface.mobile')}</span>
                        <span className="w-10 shrink-0 text-right type-caption text-text-secondary tabular-nums">{t('surface.screens', { count: count(s.id) })}</span>
                      </button>
                      <DropdownMenu.Root modal={false}>
                        <DropdownMenu.Trigger asChild>
                          <button ref={(el) => { if (el) moreRefs.current.set(s.id, el); else moreRefs.current.delete(s.id); }} type="button" aria-label={t('surface.more', { name: s.name })} data-testid="surface-more"
                            className="state-layer focus-ring grid size-8 shrink-0 place-items-center rounded-sm text-text-secondary data-[state=open]:text-text-primary">
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content side="right" align="start" sideOffset={4} collisionPadding={12} onKeyDown={(e) => e.stopPropagation()}
                            // 菜单收起时焦点不还给「…」：改名框或删除确认马上要接走焦点
                            onCloseAutoFocus={(e) => { if (mode?.id === s.id) e.preventDefault(); }}
                            style={{ transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }} className="menu z-50 min-w-32 p-1.5">
                            <DropdownMenu.Item className={MENU_ITEM_CLS} data-testid="surface-rename" onSelect={() => setMode({ id: s.id, kind: 'rename', draft: s.name, error: null, pending: false })}>{t('surface.rename')}</DropdownMenu.Item>
                            <DropdownMenu.Item className={cn(MENU_ITEM_CLS, 'text-error data-[highlighted]:text-error')} data-testid="surface-delete" onSelect={() => setMode({ id: s.id, kind: 'delete', error: null, pending: false })}>{t('surface.delete')}</DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </li>
                  );
                })}
              </ul>
              <div className="my-1.5 h-px bg-border-subtle" />
              <button type="button" data-surface-add data-testid="surface-add" aria-disabled={full || undefined} aria-describedby={full ? 'surface-full' : undefined}
                onClick={() => { if (full) return; setOpen(false); setAdding(true); }}
                className={cn(ROW_CLS, 'w-full flex-none aria-disabled:cursor-not-allowed')}>
                <span className="flex w-4 shrink-0 justify-center"><Plus size={14} aria-hidden="true" /></span>
                <span>{t('surface.add')}</span>
              </button>
              {full && <p id="surface-full" className="px-2.5 pb-1 pt-1 type-caption text-text-secondary">{t('surface.full', { max: MAX_SURFACES })}</p>}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {adding && <SurfaceDialog projectId={projectId} returnTo={triggerRef} onClose={() => setAdding(false)}
        // 先等详情里有了新的一端再切过去：切早了地址指向一个详情里还没有的端，会被当成已删的端改回第一端
        onCreated={async (s) => { setAdding(false); toast(t('dialog.added', { name: s.name })); await onChanged(); onSwitch(s.id); }} />}
    </>
  );
}
