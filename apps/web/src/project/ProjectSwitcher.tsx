import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Select } from 'radix-ui';
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ProjectDto } from '@quilt/core';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { CreateProjectDialog } from '@/project/CreateProjectDialog';
import { ConfirmDialog } from '@/ui/modal';

// 项目切换器（§13 导航 v0.28）：顶栏左上的项目名就是它——点开是按更新时间倒序的项目列表，当前项打勾，
// 底部固定「新建项目…」。底座与输入框的通道下拉同为 Radix Select：键盘导航、Esc、焦点归还、定位都由它负责。
// 列表在打开时才拉（项目多时不用每次进画布都请求），拉不到就只列当前项并 toast。
// 删项目（v0.34）：每行 hover / 键盘高亮时露出垃圾桶，或在高亮行按 Delete；先关下拉再弹确认，确认后级联删除。
const NEW_ID = '__new_project__';
const ITEM_CLS = 'group relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=checked]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-40';

export function ProjectSwitcher({ current, onRenamed }: { current: ProjectDto; onRenamed?: (id: string, name: string) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
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
    } catch { toast('项目列表加载失败', 'error'); setItems(null); }
    finally { setLoading(false); }
  };
  // 列表未到手时至少有当前项：Radix 靠它渲染选中态，触发器也不会闪成占位符
  const list = items && items.some((p) => p.id === current.id) ? items : [current, ...(items ?? []).filter((p) => p.id !== current.id)];

  useEffect(() => { if (!open) setRenaming(null); }, [open]);
  const askDelete = (p: ProjectDto) => { setOpen(false); setDeleting(p); };
  // 改名即存：空名或没改动就当放弃，不弹错——重命名是低风险动作，不值得为它立一道确认
  const commitRename = async (p: ProjectDto, raw: string) => {
    const name = raw.trim().slice(0, 80);
    setRenaming(null);
    if (!name || name === p.name) return;
    setItems((prev) => prev?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? prev);
    try { await api.projects.patch(p.id, { name }); toast(`已改名为「${name}」`); onRenamed?.(p.id, name); }
    catch { toast('改名失败', 'error'); void load(); }
  };
  const confirmDelete = async () => {
    const p = deleting!;
    try {
      await api.projects.remove(p.id);
      toast(`已删除「${p.name}」`);
      setDeleting(null);
      setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? null);
      if (p.id === current.id) navigate('/');   // 删的是当前项目：回到最近更新的那个（一个不剩就是 PAGE-FIRST）
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/project-busy' ? '项目有进行中的作业，先取消或等它完成' : '删除失败', 'error');
      setDeleting(null);
    }
  };

  return (
    <>
      <Select.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) void load(); }} value={current.id} onValueChange={(v) => { if (v === NEW_ID) setCreating(true); else if (v !== current.id) navigate(`/p/${v}`); }}>
        <Select.Trigger ref={triggerRef} data-testid="project-switcher" aria-haspopup="listbox" aria-label={`项目：${current.name}，切换项目`}
          className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-fg transition-colors duration-[var(--duration-fast)] hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-panel-2">
          <span className="truncate">{current.name}</span>
          <Select.Icon className="flex shrink-0 text-muted transition-transform duration-[var(--duration-base)] ease-out group-data-[state=open]:rotate-180"><ChevronDown size={14} aria-hidden="true" /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" side="bottom" align="start" sideOffset={6} collisionPadding={12} data-testid="project-switcher-list"
            // Esc / 方向键 / 字母检索归下拉自己，不冒泡给画布快捷键；Delete / Backspace 删高亮行（垃圾桶的键盘等价物）
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== 'Delete' && e.key !== 'Backspace') return;
              const id = (e.currentTarget as HTMLElement).querySelector('[data-highlighted][data-project-id]')?.getAttribute('data-project-id');
              const p = id ? list.find((x) => x.id === id) : undefined;
              if (p) { e.preventDefault(); askDelete(p); }
            }}
            className="menu z-50 max-h-[min(24rem,70vh)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5">
            <Select.Viewport>
              <Select.Group>
                <Select.Label className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted">项目 · 按更新时间</Select.Label>
                {list.map((p) => (
                  <Select.Item key={p.id} value={p.id} textValue={p.name} data-testid="project-option" data-project-id={p.id} className={ITEM_CLS}>
                    <span className="flex w-4 shrink-0 justify-center"><Select.ItemIndicator><Check size={14} aria-hidden="true" /></Select.ItemIndicator></span>
                    {renaming === p.id ? (
                      <>
                        {/* Radix Select 的 content 自己监听 keydown 做首字母跳转与上下移动，不拦住的话字打不进去 */}
                        <input
                          autoFocus data-testid="rename-input" aria-label={`项目名，原名「${p.name}」`} value={draft} maxLength={80}
                          onChange={(e) => setDraft(e.target.value)}
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); void commitRename(p, draft); }
                            if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                          }}
                          className="min-w-0 flex-1 rounded-md border border-accent bg-canvas px-1.5 py-0.5 text-sm text-fg outline-none"
                        />
                        {/* 改名只由这两个键收尾：鼠标在下拉里一动焦点就变，拿失焦当「确认」会把没想好的名字存进去 */}
                        <button
                          type="button" tabIndex={-1} aria-label={`保存新名字「${draft.trim()}」`} data-testid="rename-confirm" disabled={!draft.trim()}
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void commitRename(p, draft); }}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-success hover:bg-success/15 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
                        ><Check size={14} aria-hidden="true" /></button>
                        <button
                          type="button" tabIndex={-1} aria-label="放弃改名" data-testid="rename-cancel"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenaming(null); }}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-danger hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-accent"
                        ><X size={14} aria-hidden="true" /></button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate"><Select.ItemText>{p.name}</Select.ItemText></span>
                        {/* 重命名与删除同一套露出规则：hover / 键盘高亮才显形，点它们都不选中该项 */}
                        <button
                          type="button" tabIndex={-1} aria-label={`重命名项目「${p.name}」`} data-testid="rename-project"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDraft(p.name); setRenaming(p.id); }}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity duration-[var(--duration-fast)] hover:bg-panel-2 hover:text-fg group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
                        ><Pencil size={14} aria-hidden="true" /></button>
                        <button
                          type="button" tabIndex={-1} aria-label={`删除项目「${p.name}」`} data-testid="delete-project"
                          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); askDelete(p); }}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity duration-[var(--duration-fast)] hover:bg-danger/15 hover:text-danger group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
                        ><Trash2 size={14} aria-hidden="true" /></button>
                      </>
                    )}
                    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{p.deviceType === 'mobile' ? '手机' : '桌面'}</span>
                  </Select.Item>
                ))}
                {loading && items === null && <p role="status" className="px-2.5 py-2 text-xs text-muted">正在加载项目列表…</p>}
              </Select.Group>
              <Select.Separator className="my-1.5 h-px bg-line" />
              <Select.Item value={NEW_ID} textValue="新建项目" data-testid="new-project" className={ITEM_CLS}>
                <span className="flex w-4 shrink-0 justify-center"><Plus size={14} aria-hidden="true" /></span>
                <Select.ItemText>新建项目…</Select.ItemText>
              </Select.Item>
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} returnTo={triggerRef} />}
      {deleting && (
        <ConfirmDialog title={`删除「${deleting.name}」？`} body="项目下的全部屏幕、修订历史、对话与导出都会一起删除，不可恢复。" confirmLabel="删除" returnTo={triggerRef} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
      )}
    </>
  );
}
