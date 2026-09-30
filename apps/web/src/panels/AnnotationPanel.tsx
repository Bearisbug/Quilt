import { useState } from 'react';
import type { ScreenDto, AnnotationDto } from '@quilt/core';
import { Button, EmptyState, Panel } from '@/ui/ui';
import type { ElementSel } from './InspectorPanel';

// 批注面板（REQ-EDIT-004）：选中元素后写一条改动说明，可单独发也可一起发。
// 发送按屏合并成一条整屏指令——N 屏计 N 次费，而不是 N 条批注计 N 次。
export function AnnotationPanel({ screen, sel, items, busy, onClose, onAdd, onUpdate, onRemove, onSend }: {
  screen: ScreenDto; sel: ElementSel | null; items: AnnotationDto[]; busy: boolean;
  /** onAdd 回新批注的 id、onUpdate 回是否存上；存不上时回 null / false，原因已由调用方 toast */
  onClose: () => void; onAdd: (note: string) => Promise<string | null>; onUpdate: (id: string, note: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<void>; onSend: (ids: string[]) => Promise<void>;
}) {
  // 说明框的草稿按「屏 + 元素」暂存（v0.78）：点别的元素换成它自己的草稿，点回来原样还在
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = sel ? `${screen.id}:${sel.qid}` : '';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (v: string) => setDrafts((m) => ({ ...m, [draftKey]: v }));
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const [pending, setPending] = useState(false);
  const open = items.filter((a) => a.status === 'open');
  // 共享组件里的元素不批注（REQ-EDIT-006）：批注发出去是改屏，改屏动不了组件展开的那一块
  const locked = sel?.component ?? null;

  const run = async (fn: () => Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };
  // 存上了才清草稿；「记下并立刻发送」只发刚记下的这一条、存不上就不发（v0.78）
  const add = async (send: boolean) => {
    const k = draftKey;
    const id = await onAdd(draft.trim());
    if (!id) return;
    setDrafts((m) => { const next = { ...m }; delete next[k]; return next; });
    if (send) await onSend([id]);
  };

  return (
    <Panel title={`批注 · ${screen.name}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        <div className="space-y-1.5">
          <label htmlFor="anno-note" className="block text-xs font-medium text-muted" data-testid="anno-target" data-qid={sel?.qid ?? ''}>
            {sel ? <>给 <code className="text-fg">&lt;{sel.tag}&gt;{sel.text ? ` 「${sel.text.slice(0, 20)}」` : ''}</code> 写一条改动说明</> : '在屏幕里点选一个元素，再写改动说明'}
          </label>
          {locked && <p className="rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs leading-cn" data-testid="anno-component-lock">这个元素属于共享组件「<b className="text-fg">{locked}</b>」，批注请改组件本身（选中画布上的组件卡后在输入框里说）。</p>}
          <textarea id="anno-note" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} disabled={!sel || !!locked}
            className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-sm text-fg placeholder:text-muted disabled:opacity-50"
            placeholder={sel && !locked ? '例如：这个按钮改成次要样式，文案换成「稍后再说」' : ''} />
          <div className="flex gap-2">
            <Button size="sm" disabled={!sel || !!locked || !draft.trim() || pending} pending={pending}
              onClick={() => run(() => add(false))}>记下（不发送）</Button>
            <Button size="sm" variant="primary" disabled={!sel || !!locked || !draft.trim() || pending || busy}
              onClick={() => run(() => add(true))}>记下并立刻发送</Button>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted">这一屏的批注（{open.length} 条未处理）</h3>
            <Button size="sm" variant="primary" disabled={open.length === 0 || pending || busy} data-testid="send-annotations"
              onClick={() => run(() => onSend(open.map((a) => a.id)))}>一起发送</Button>
          </div>
          {items.length === 0 ? <EmptyState title="还没有批注" hint="点选元素后写下改动说明，可以攒够一起发。" /> : (
            <ul className="space-y-2">
              {items.map((a, i) => (
                <li key={a.id} className="rounded-md border border-line p-2 text-xs" data-testid="anno-item" data-status={a.status}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-fg">#{i + 1} {a.anchorText ? `「${a.anchorText.slice(0, 16)}」` : a.qid}</span>
                    <span className={a.status === 'sent' ? 'text-warn' : a.status === 'resolved' ? 'text-success' : 'text-muted'}>
                      {a.status === 'sent' ? '已发送' : a.status === 'resolved' ? '已处理' : '未处理'}
                    </span>
                  </div>
                  {editing?.id === a.id ? (
                    <div className="mt-1.5 space-y-1.5">
                      <textarea value={editing.note} onChange={(e) => setEditing({ id: a.id, note: e.target.value })} rows={3}
                        className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-xs text-fg" />
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" disabled={!editing.note.trim() || pending}
                          onClick={() => run(async () => { if (await onUpdate(a.id, editing.note.trim())) setEditing(null); })}>保存</Button>
                        <Button size="sm" onClick={() => setEditing(null)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{a.note}</p>
                      {a.status === 'open' && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Button size="sm" onClick={() => setEditing({ id: a.id, note: a.note })}>改写</Button>
                          <Button size="sm" disabled={pending || busy} onClick={() => run(() => onSend([a.id]))}>只发这条</Button>
                          <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => onRemove(a.id))}>删除</Button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
