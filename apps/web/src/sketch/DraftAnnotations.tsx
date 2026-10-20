import { useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import type { AnnotationDto } from '@quilt/core/browser';
import type { ElementSelection } from '@/canvas/frameMessages';
import { Button, cn } from '@/ui/ui';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';
import commonMessages from '@/i18n/locales/common';

/** 草稿文档坐标里的一个框 → 看板上（.draft-frame 里、已按看板缩放）气泡的落点；folded = 元素在草稿可见区之外，气泡贴在底边 */
export type PinPlace = (rect: AnnotationDto['rect']) => { x: number; y: number; folded: boolean };

type Target = { kind: 'new'; sel: ElementSelection } | { kind: 'edit'; anno: AnnotationDto; n: number };

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
// 说明的上限与服务端同一个数、同一种计法（API-EDIT-003 的 note：去掉首尾空白后按 length 计）
const NOTE_MAX = 2000;

// 草稿上的批注（REQ-CORE-045，FLOW-SKETCH-REFINE S2–S3）：编号气泡画在看板上、随看板缩放换算位置（气泡本身不缩），与画布卡片上的批注钉同一套标记色；
// 「批注」开着时点中的元素弹出说明框，存下就是一条批注（API-EDIT-003）；点气泡可改说明或删除，已发出的只读。
// 说明框是锚在落点上的 Radix Popover：Esc、点外面关闭、焦点进出由它负责，它的 Esc 被消费掉，不会连带收起看板
export function DraftAnnotations({ items, place, composing, onCloseCompose, onCreate, onUpdate, onRemove, returnFocus }: {
  /** 这张草稿上未处理的批注（open + sent），按创建时间升序，编号即序号 */
  items: AnnotationDto[];
  place: PinPlace;
  /** 「批注」开着时刚点中的元素：等写说明 */
  composing: ElementSelection | null;
  onCloseCompose: () => void;
  /** 存上了回 true；存不上时原因已由调用方说，说明框留着 */
  onCreate: (sel: ElementSelection, note: string) => Promise<boolean>;
  onUpdate: (id: string, note: string) => Promise<boolean>;
  /** 删除要先确认（撤销不了），确认框由调用方开 */
  onRemove: (anno: AnnotationDto) => void;
  /** 新批注的说明框关掉后焦点交给谁（「批注」开关） */
  returnFocus: () => void;
}) {
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  const [editing, setEditing] = useState<string | null>(null);
  // 点中了新元素就不再改旧批注：说明框同一时刻只有一个
  if (composing && editing) setEditing(null);
  // 没存的说明按元素暂存（同画布 v0.78）：点了别的元素再点回来，字还在；改旧批注的草稿关掉即弃
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const editAnno = editing ? items.find((a) => a.id === editing) : undefined;
  const target: Target | null = composing ? { kind: 'new', sel: composing } : editAnno ? { kind: 'edit', anno: editAnno, n: items.indexOf(editAnno) + 1 } : null;
  const key = !target ? '' : target.kind === 'new' ? `new:${target.sel.qid}` : `edit:${target.anno.id}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const text = !target ? '' : notes[key] ?? (target.kind === 'edit' ? target.anno.note : '');
  const forget = (k: string) => setNotes((m) => { if (!(k in m)) return m; const next = { ...m }; delete next[k]; return next; });

  const close = (t: Target) => { if (t.kind === 'new') onCloseCompose(); else { forget(`edit:${t.anno.id}`); setEditing(null); } };
  const save = async () => {
    if (!target || pending) return;
    const note = text.trim();
    if (!note || note.length > NOTE_MAX) return;
    const t = target; const k = key;
    if (t.kind === 'edit' && note === t.anno.note) { close(t); return; }
    setPending(true);
    const ok = t.kind === 'new' ? await onCreate(t.sel, note) : await onUpdate(t.anno.id, note);
    setPending(false);
    if (!ok) return;
    forget(k);
    // 存的这一会儿又点了别的元素：说明框已经换成它的了，不关
    if (keyRef.current === k) close(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 同输入框：Enter 存下，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
  };
  // 关掉之后焦点回到起点：改的是旧批注就回它的气泡，新批注回「批注」开关（A11Y-013）。
  // 焦点已经被用户带走（点进了草稿、点了另一枚气泡）时不抢
  const refocus = (t: Target) => {
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const pin = t.kind === 'edit' ? document.querySelector<HTMLElement>(`[data-testid="draft-annotation-pin"][data-anno="${t.anno.id}"]`) : null;
    if (pin) pin.focus(); else returnFocus();
  };

  const at = target ? place(target.kind === 'new' ? target.sel.rect : target.anno.rect) : null;
  const over = text.trim().length > NOTE_MAX;
  const sent = target?.kind === 'edit' && target.anno.status !== 'open';
  const title = !target ? '' : target.kind === 'new'
    ? (target.sel.text ? t('anno.newTitleText', { tag: target.sel.tag, text: short(target.sel.text, 16) }) : t('anno.newTitle', { tag: target.sel.tag }))
    : (target.anno.anchorText ? t('anno.editTitleText', { n: target.n, text: short(target.anno.anchorText, 16) }) : t('anno.editTitle', { n: target.n }));

  return (
    <>
      {items.map((a, i) => {
        const p = place(a.rect);
        const out = a.status !== 'open';
        return (
          <button
            key={a.id} type="button" data-testid="draft-annotation-pin" data-anno={a.id} data-status={a.status}
            aria-label={t(out ? (p.folded ? 'anno.pinSentFolded' : 'anno.pinSent') : p.folded ? 'anno.pinFolded' : 'anno.pin', { n: i + 1, note: a.note })}
            aria-haspopup="dialog" aria-expanded={editing === a.id}
            onClick={() => { onCloseCompose(); setEditing(a.id); }}
            className={cn(
              'state-layer focus-ring absolute z-[2] grid h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-pill border-2 px-1.5 type-caption font-semibold leading-none shadow-(--semantic-elevation-raised)',
              // 已发出的同画布：抬起面底 + 警告色字，不单靠颜色——编号旁的读屏名写明了「已发出」
              out ? 'border-current bg-surface-raised text-warning' : 'border-(--semantic-color-mark-halo) bg-(--semantic-color-mark-line) text-(--semantic-color-mark-on-line)',
            )}
            style={{ left: p.x, top: p.y }}
          >{i + 1}</button>
        );
      })}
      {target && at && (
        <Popover.Root key={key} open onOpenChange={(o) => { if (!o) close(target); }}>
          <Popover.Anchor asChild><span aria-hidden="true" className="pointer-events-none absolute size-px" style={{ left: at.x, top: at.y }} /></Popover.Anchor>
          <Popover.Portal>
            <Popover.Content
              data-testid="draft-annotation-box" side="bottom" align="center" sideOffset={16} collisionPadding={12} aria-label={title}
              onCloseAutoFocus={(e) => { e.preventDefault(); refocus(target); }}
              // 从落点那一侧长出来（MOTION-007）
              style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
              className="menu z-50 w-[min(20rem,calc(100vw-1.5rem))] p-3 outline-none"
            >
              {sent ? (
                <>
                  <p className="type-label font-medium text-text-secondary">{title}</p>
                  <p className="mt-1.5 whitespace-pre-wrap type-body text-text-primary [overflow-wrap:anywhere]">{target.anno.note}</p>
                  <p className="mt-1.5 type-caption text-text-secondary">{t('anno.sentNote')}</p>
                  <div className="mt-2.5 flex justify-end"><Button size="sm" onClick={() => close(target)}>{tc('close')}</Button></div>
                </>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
                  <label htmlFor="draft-anno-note" className="block type-label font-medium text-text-secondary [overflow-wrap:anywhere]">{title}</label>
                  <textarea
                    id="draft-anno-note" data-testid="draft-annotation-note" rows={3} value={text} onChange={(e) => setNotes((m) => ({ ...m, [key]: e.target.value }))} onKeyDown={onKey}
                    placeholder={t('anno.placeholder')} aria-invalid={over || undefined} aria-describedby={over ? 'draft-anno-over' : undefined}
                    className="fill focus-ring mt-1.5 block w-full resize-none rounded-md border border-transparent p-2 type-body text-text-primary placeholder:text-(--semantic-color-text-tertiary) aria-invalid:border-error"
                  />
                  {/* 超了不截字，就地说多了多少（I18N-008） */}
                  {over && <p id="draft-anno-over" className="mt-1 type-caption text-error">{t('anno.over', { max: NOTE_MAX, len: text.trim().length })}</p>}
                  <div className="mt-2.5 flex items-center gap-2">
                    {target.kind === 'edit' && <Button size="sm" variant="danger-ghost" data-testid="draft-annotation-remove" onClick={() => { const a = target.anno; setEditing(null); onRemove(a); }}>{tc('delete')}</Button>}
                    <span className="flex-1" />
                    <Button size="sm" onClick={() => close(target)}>{tc('cancel')}</Button>
                    <Button size="sm" variant="primary" type="submit" data-testid="draft-annotation-save" pending={pending} disabled={!text.trim() || over}>{target.kind === 'new' ? t('anno.create') : t('anno.save')}</Button>
                  </div>
                </form>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}
