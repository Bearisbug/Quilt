import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Select } from 'radix-ui';
import { Check, ChevronDown, NotebookPen, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ProjectDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { CreateProjectDialog } from '@/project/CreateProjectDialog';
import { ConfirmDialog } from '@/ui/modal';
import { useT } from '@/i18n';
import projectMessages from '@/i18n/locales/shellProject';
import commonMessages from '@/i18n/locales/common';

// 项目切换器（§13 导航 v0.28）：顶栏左上的项目名就是它——点开是按更新时间倒序的项目列表，当前项打勾，
// 底部固定「新建项目…」。底座与输入框的通道下拉同为 Radix Select：键盘导航、Esc、焦点归还、定位都由它负责。
// 列表在打开时才拉（项目多时不用每次进画布都请求），拉不到就只列当前项并 toast。
// 删项目（v0.34）：每行 hover / 键盘高亮时露出垃圾桶，或在高亮行按 Delete；先关下拉再弹确认，确认后级联删除。
// 草稿本（REQ-CORE-040）：菜单顶部固定一条「草稿本」去 /sketch；草稿本页上这枚 chip 写「草稿本」、那一条打勾，菜单里照常列项目（选一个回它的画布）
const NEW_ID = '__new_project__';
const SKETCH_ID = '__sketchbook__';
// 菜单行（brand/DESIGN.md「状态模型」）：指针与键盘高亮走状态层，当前项用选中高亮色
const ITEM_CLS = 'state-layer group relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:text-text-primary data-[state=checked]:bg-(--semantic-color-surface-selected) data-[state=checked]:text-text-primary data-[disabled]:pointer-events-none';

// current = null（v0.76）：画布页的项目还在加载或取不到，切换器照常可用（它是加载失败时的出口之一），触发器写 placeholder。
// sketchbook：这枚 chip 在草稿本页上，当前不是任何项目
export function ProjectSwitcher({ current, placeholder, onRenamed, sketchbook }: { current: ProjectDto | null; placeholder: string; onRenamed?: (id: string, name: string) => void; sketchbook?: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT(projectMessages);
  const tc = useT(commonMessages);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectDto | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const { items: list } = await api.projects.list();
      setItems([...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
    } catch { toast(t('switcher.loadFailed'), 'error'); setItems(null); }
    finally { setLoading(false); }
  };
  // 列表未到手时至少有当前项：Radix 靠它渲染选中态，触发器也不会闪成占位符
  const list = !current ? items ?? [] : items && items.some((p) => p.id === current.id) ? items : [current, ...(items ?? [])];

  useEffect(() => { if (!open) setRenaming(null); }, [open]);
  const askDelete = (p: ProjectDto) => { setOpen(false); setDeleting(p); };
  // 改名即存：空名或没改动就当放弃，不弹错——重命名是低风险动作，不值得为它立一道确认
  const commitRename = async (p: ProjectDto, raw: string) => {
    const name = raw.trim().slice(0, 80);
    setRenaming(null);
    if (!name || name === p.name) return;
    setItems((prev) => prev?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? prev);
    try { await api.projects.patch(p.id, { name }); toast(t('switcher.renamed', { name })); onRenamed?.(p.id, name); }
    catch { toast(t('switcher.renameFailed'), 'error'); void load(); }
  };
  const confirmDelete = async () => {
    const p = deleting!;
    try {
      await api.projects.remove(p.id);
      toast(t('switcher.deleted', { name: p.name }));
      setDeleting(null);
      setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? null);
      if (p.id === current?.id) navigate('/');   // 删的是当前项目：回到最近更新的那个（一个不剩就是 PAGE-FIRST）
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/project-busy' ? t('switcher.busy') : t('switcher.deleteFailed'), 'error');
      setDeleting(null);
    }
  };

  return (
    <>
      <Select.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) void load(); }} value={sketchbook ? SKETCH_ID : current?.id ?? ''} onValueChange={(v) => { if (v === NEW_ID) setCreating(true); else if (v === SKETCH_ID) { if (!sketchbook) navigate('/sketch'); } else if (v !== current?.id) navigate(`/p/${v}`); }}>
        <Select.Trigger ref={triggerRef} data-testid="project-switcher" aria-haspopup="listbox" aria-label={sketchbook ? t('switcher.triggerSketchbook') : current ? t('switcher.triggerProject', { name: current.name }) : t('switcher.triggerPlaceholder', { placeholder })}
          // 画布左上角的 chip（§13.1）：顶栏不铺底，chip 是一块毛玻璃浮层（.chrome），压在卡片上也读得出
          className="chrome state-layer focus-ring group flex h-8 min-w-0 max-w-[min(20rem,calc(100vw-7rem))] items-center gap-1.5 rounded-md px-3 type-body font-medium text-text-primary">
          <span className={current || sketchbook ? 'truncate' : 'truncate text-text-secondary'}>{sketchbook ? t('switcher.sketchbook') : current?.name ?? placeholder}</span>
          <Select.Icon className="flex shrink-0 text-text-secondary transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180"><ChevronDown size={14} aria-hidden="true" /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" side="bottom" align="start" sideOffset={6} collisionPadding={12} data-testid="project-switcher-list"
            // Esc / 方向键 / 字母检索归下拉自己，不冒泡给画布快捷键；高亮行上 F2 改名、Delete / Backspace 删（两个行内按钮的键盘等价物）
            onKeyDown={(e) => {
              e.stopPropagation();
              const rename = e.key === 'F2';
              if (!rename && e.key !== 'Delete' && e.key !== 'Backspace') return;
              const id = (e.currentTarget as HTMLElement).querySelector('[data-highlighted][data-project-id]')?.getAttribute('data-project-id');
              const p = id ? list.find((x) => x.id === id) : undefined;
              if (!p) return;
              e.preventDefault();
              if (rename) { setDraft(p.name); setRenaming(p.id); } else askDelete(p);
            }}
            className="menu z-50 max-h-[min(24rem,70vh)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5">
            <Select.Viewport>
              <Select.Item value={SKETCH_ID} textValue={t('switcher.sketchbook')} data-testid="sketchbook-entry" className={ITEM_CLS}>
                <span className="flex w-4 shrink-0 justify-center"><Select.ItemIndicator><Check size={14} aria-hidden="true" /></Select.ItemIndicator></span>
                <span className="min-w-0 flex-1 truncate"><Select.ItemText>{t('switcher.sketchbook')}</Select.ItemText></span>
                <NotebookPen size={14} aria-hidden="true" className="shrink-0 text-text-secondary" />
              </Select.Item>
              <Select.Separator className="my-1.5 h-px bg-border-subtle" />
              <Select.Group>
                <Select.Label className="flex justify-between gap-2 px-2.5 pb-1 pt-1.5 type-caption text-text-secondary"><span className="type-overline font-semibold">{t('switcher.groupLabel')}</span><span data-testid="project-keys-hint">{t('switcher.keysHint')}</span></Select.Label>
                {list.map((p) => (
                  <Select.Item key={p.id} value={p.id} textValue={p.name} data-testid="project-option" data-project-id={p.id} className={ITEM_CLS}
                    // 改名期间指针移过哪一行都不抢焦点：Radix 在 pointermove 时把焦点交给指针下的那一行，改名框随之失焦，
                    // 后面打的字进了下拉的字母检索，Enter 选中那一行、切走项目（preventDefault 让 Radix 跳过它自己的处理）
                    onPointerMove={renaming ? (e) => e.preventDefault() : undefined} onPointerLeave={renaming ? (e) => e.preventDefault() : undefined}>
                    <span className="flex w-4 shrink-0 justify-center"><Select.ItemIndicator><Check size={14} aria-hidden="true" /></Select.ItemIndicator></span>
                    {renaming === p.id ? (
                      <>
                        {/* Radix Select 的 content 自己监听 keydown 做首字母跳转与上下移动，不拦住的话字打不进去 */}
                        <input
                          autoFocus data-testid="rename-input" aria-label={t('switcher.renameInput', { name: p.name })} value={draft} maxLength={80}
                          onChange={(e) => setDraft(e.target.value)}
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); void commitRename(p, draft); }
                            if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                          }}
                          className="focus-ring fill min-w-0 flex-1 rounded-sm px-1.5 py-0.5 type-body text-text-primary"
                        />
                        {/* 改名只由这两个键收尾：鼠标在下拉里一动焦点就变，拿失焦当「确认」会把没想好的名字存进去 */}
                        <button
                          type="button" tabIndex={-1} aria-label={t('switcher.renameSave', { name: draft.trim() })} data-testid="rename-confirm" disabled={!draft.trim()}
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void commitRename(p, draft); }}
                          className="grid size-6 shrink-0 place-items-center rounded-sm text-success state-layer focus-ring"
                        ><Check size={14} aria-hidden="true" /></button>
                        <button
                          type="button" tabIndex={-1} aria-label={t('switcher.renameCancel')} data-testid="rename-cancel"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenaming(null); }}
                          className="grid size-6 shrink-0 place-items-center rounded-sm text-error state-layer focus-ring"
                        ><X size={14} aria-hidden="true" /></button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate"><Select.ItemText>{p.name}</Select.ItemText></span>
                        {/* 重命名与删除同一套露出规则：hover / 键盘高亮才显形，点它们都不选中该项 */}
                        <button
                          type="button" tabIndex={-1} aria-label={t('switcher.rename', { name: p.name })} data-testid="rename-project"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDraft(p.name); setRenaming(p.id); }}
                          className="grid size-6 shrink-0 place-items-center rounded-sm text-text-secondary opacity-0 transition-opacity duration-(--semantic-motion-duration-fast) group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100 state-layer"
                        ><Pencil size={14} aria-hidden="true" /></button>
                        <button
                          type="button" tabIndex={-1} aria-label={t('switcher.delete', { name: p.name })} data-testid="delete-project"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); askDelete(p); }}
                          className="grid size-6 shrink-0 place-items-center rounded-sm text-text-secondary opacity-0 transition-opacity duration-(--semantic-motion-duration-fast) group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100 state-layer"
                        ><Trash2 size={14} aria-hidden="true" /></button>
                      </>
                    )}
                    <span className="fill shrink-0 rounded-sm px-2 py-0.5 type-caption text-text-secondary">{t(p.deviceType === 'mobile' ? 'switcher.mobile' : 'switcher.desktop')}</span>
                  </Select.Item>
                ))}
                {loading && items === null && <p role="status" className="px-2.5 py-2 type-label text-text-secondary">{t('switcher.loading')}</p>}
              </Select.Group>
              <Select.Separator className="my-1.5 h-px bg-border-subtle" />
              <Select.Item value={NEW_ID} textValue={t('create.title')} data-testid="new-project" className={ITEM_CLS}>
                <span className="flex w-4 shrink-0 justify-center"><Plus size={14} aria-hidden="true" /></span>
                <Select.ItemText>{t('switcher.newProject')}</Select.ItemText>
              </Select.Item>
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} returnTo={triggerRef} />}
      {deleting && (
        <ConfirmDialog title={t('switcher.deleteTitle', { name: deleting.name })} body={t('switcher.deleteBody')} confirmLabel={tc('delete')} returnTo={triggerRef} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
      )}
    </>
  );
}
