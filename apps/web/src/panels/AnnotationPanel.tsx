import { useState } from 'react';
import type { ScreenDto, AnnotationDto } from '@quilt/core/browser';
import { Button, EmptyState, Panel } from '@/ui/ui';
import { ConfirmDialog } from '@/ui/modal';
import type { ElementSel } from './InspectorPanel';
import { Trans } from 'react-i18next';
import { useT } from '@/i18n';
import inspectMessages from '@/i18n/locales/panels-inspect';
import commonMessages from '@/i18n/locales/common';

// 批注面板（REQ-EDIT-004）：选中元素后写一条改动说明，可单独发也可一起发。
// 发送按屏合并成一条整屏指令——N 屏计 N 次费，而不是 N 条批注计 N 次。
export function AnnotationPanel({ screen, sel, items, busy, onClose, onAdd, onUpdate, onRemove, onSend }: {
  screen: ScreenDto; sel: ElementSel | null; items: AnnotationDto[]; busy: boolean;
  /** onAdd 回新批注的 id、onUpdate 回是否存上；存不上时回 null / false，原因已由调用方 toast */
  onClose: () => void; onAdd: (note: string) => Promise<string | null>; onUpdate: (id: string, note: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<void>; onSend: (ids: string[]) => Promise<void>;
}) {
  const t = useT(inspectMessages);
  const tc = useT(commonMessages);
  // 说明框的草稿按「屏 + 元素」暂存（v0.78）：点别的元素换成它自己的草稿，点回来原样还在
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = sel ? `${screen.id}:${sel.qid}` : '';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (v: string) => setDrafts((m) => ({ ...m, [draftKey]: v }));
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const [pending, setPending] = useState(false);
  // 删批注撤销不了（v1.03）：先确认
  const [pendingRemove, setPendingRemove] = useState<AnnotationDto | null>(null);
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
    <Panel title={t('annotation.title', { name: screen.name })} className="h-full" actions={<Button size="sm" onClick={onClose}>{tc('close')}</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        <div className="space-y-1.5">
          <label htmlFor="anno-note" className="block type-label font-semibold text-text-secondary" data-testid="anno-target" data-qid={sel?.qid ?? ''}>
            {sel ? <Trans ns={inspectMessages.ns} i18nKey="annotation.target" components={{ code: <code className="text-text-primary">&lt;{sel.tag}&gt;{sel.text ? ` ${t('quoted', { text: sel.text.slice(0, 20) })}` : ''}</code> }} /> : t('annotation.pickFirst')}
          </label>
          {locked && <p className="fill rounded-md px-2 py-1.5 type-label leading-(--semantic-typography-body-line-height)" data-testid="anno-component-lock"><Trans ns={inspectMessages.ns} i18nKey="annotation.locked" components={{ b: <b className="text-text-primary">{locked}</b> }} /></p>}
          <textarea id="anno-note" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} disabled={!sel || !!locked}
            className="fill w-full resize-none focus-ring rounded-md border border-transparent p-2 type-body text-text-primary placeholder:text-(--semantic-color-text-tertiary)"
            placeholder={sel && !locked ? t('annotation.placeholder') : ''} />
          <div className="flex gap-2">
            <Button size="sm" disabled={!sel || !!locked || !draft.trim() || pending} pending={pending}
              onClick={() => run(() => add(false))}>{t('annotation.add')}</Button>
            <Button size="sm" variant="primary" disabled={!sel || !!locked || !draft.trim() || pending || busy}
              onClick={() => run(() => add(true))}>{t('annotation.addAndSend')}</Button>
          </div>
        </div>

        <div className="border-t border-border-subtle pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="type-label font-semibold text-text-secondary">{t('annotation.listTitle', { open: open.length })}</h3>
            <Button size="sm" variant="primary" disabled={open.length === 0 || pending || busy} data-testid="send-annotations"
              onClick={() => run(() => onSend(open.map((a) => a.id)))}>{t('annotation.sendAll')}</Button>
          </div>
          {busy && <p className="mb-2 type-caption text-warning" data-testid="anno-busy">{t('annotation.busy')}</p>}
          {items.length === 0 ? <EmptyState title={t('annotation.emptyTitle')} hint={t('annotation.emptyHint')} /> : (
            <ul className="space-y-2">
              {items.map((a, i) => (
                <li key={a.id} className="fill rounded-md p-2 type-label" data-testid="anno-item" data-status={a.status}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">#{i + 1} {a.anchorText ? t('quoted', { text: a.anchorText.slice(0, 16) }) : a.qid}</span>
                    <span className={a.status === 'sent' ? 'text-warning' : a.status === 'resolved' ? 'text-success' : 'text-text-secondary'}>
                      {a.status === 'sent' ? t('annotation.status.sent') : a.status === 'resolved' ? t('annotation.status.resolved') : t('annotation.status.open')}
                    </span>
                  </div>
                  {editing?.id === a.id ? (
                    <div className="mt-1.5 space-y-1.5">
                      <textarea value={editing.note} onChange={(e) => setEditing({ id: a.id, note: e.target.value })} rows={3}
                        className="fill w-full resize-none focus-ring rounded-md border border-transparent p-2 type-label text-text-primary" />
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" disabled={!editing.note.trim() || pending}
                          onClick={() => run(async () => { if (await onUpdate(a.id, editing.note.trim())) setEditing(null); })}>{t('annotation.save')}</Button>
                        <Button size="sm" onClick={() => setEditing(null)}>{tc('cancel')}</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 whitespace-pre-wrap text-text-secondary [overflow-wrap:anywhere]">{a.note}</p>
                      {a.status === 'open' && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Button size="sm" onClick={() => setEditing({ id: a.id, note: a.note })}>{t('annotation.rewrite')}</Button>
                          <Button size="sm" disabled={pending || busy} onClick={() => run(() => onSend([a.id]))}>{t('annotation.sendOne')}</Button>
                          <Button size="sm" variant="danger-ghost" disabled={pending} onClick={() => setPendingRemove(a)}>{tc('delete')}</Button>
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
      {pendingRemove && (
        <ConfirmDialog title={t('annotation.confirmTitle')} body={t('annotation.confirmBody', { note: pendingRemove.note.length > 40 ? `${pendingRemove.note.slice(0, 40)}…` : pendingRemove.note })} confirmLabel={tc('delete')}
          onCancel={() => setPendingRemove(null)} onConfirm={async () => { const a = pendingRemove; setPendingRemove(null); await run(() => onRemove(a.id)); }} />
      )}
    </Panel>
  );
}
