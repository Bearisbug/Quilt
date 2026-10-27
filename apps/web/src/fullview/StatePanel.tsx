import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import {
  EVENT_MS, MAX_DIM_VALUES, MAX_SURFACE_DIMS, MAX_SURFACE_EVENTS, MIN_DIM_VALUES, estimateJob, missingValues, shadowedStateKeys,
  type ScreenDto, type StateDim, type StatesProposalDto, type SurfaceDto, type SurfaceStatesInput,
} from '@quilt/core/browser';
import { Button, cn } from '@/ui/ui';
import { useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';
import commonMessages from '@/i18n/locales/common';

// 状态栏（PAGE-FULLVIEW「状态栏」，FLOW-STATES）：三节——「这一端」列端上的维度（分段按钮，这一屏没写的取值淡显）、
// 「这一页」列这一屏声明的页内状态、「事件」列端上与这一页的事件；栏底「重置」。
// 切取值、播事件只发给设备台里的运行时，不建修订（ADR-041）；改维度整份提交（API-CORE-054），没提交的维度由服务端标 retired 留着
type DraftDim = { key?: string; name: string; values: { key?: string; name: string }[]; def: number };
type DraftEvent = { key?: string; name: string; ms: string };
type Draft = { dims: DraftDim[]; events: DraftEvent[] };

/** 这一端里哪些屏还没把这个维度的取值写全（默认屏与变体都算） */
export const unwrittenScreens = (dim: StateDim, screens: ScreenDto[]) => screens.filter((s) => s.currentRevisionId && missingValues(dim, s.states?.uses).missing.length > 0);

export function StatePanel({ surface, screen, screens, values, busy, proposal, proposing, onValue, onReset, onPlay, onPropose, onDismissProposal, onSave, onFill, onAddPageState }: {
  surface: SurfaceDto; screen: ScreenDto | null; screens: ScreenDto[];
  /** 此刻生效的取值（维度键 → 取值键），含页内状态 */
  values: Record<string, string>;
  busy: ReadonlySet<string>;
  proposal: StatesProposalDto | null; proposing: boolean;
  onValue: (dim: string, value: string) => void;
  onReset: () => void;
  onPlay: (key: string, ms?: number) => void;
  onPropose: () => void;
  onDismissProposal: () => void;
  onSave: (states: SurfaceStatesInput) => Promise<string | null>;
  onFill: (dim: StateDim, targets: ScreenDto[]) => Promise<void>;
  onAddPageState: () => void;
}) {
  const t = useT(fullviewMessages);
  const dims = surface.states.dims.filter((d) => !d.retired);
  const page = screen?.states ?? null;
  const shadowed = useMemo(() => new Set(page ? shadowedStateKeys(page, surface.states) : []), [page, surface.states]);
  const pageDims = (page?.dims ?? []).filter((d) => !shadowed.has(d.key));
  const events = [...surface.states.events, ...(page?.events ?? []).filter((e) => !shadowed.has(e.key))];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 换了一端：编辑中的草稿作废
  useEffect(() => { setDraft(null); setSaveError(null); }, [surface.id]);

  const openEditor = (extra: Draft = { dims: [], events: [] }) => {
    setSaveError(null);
    setDraft({
      dims: [...dims.map((d) => ({ key: d.key, name: d.name, values: d.values.map((v) => ({ key: v.key, name: v.name })), def: Math.max(0, d.values.findIndex((v) => v.key === d.default)) })), ...extra.dims],
      events: [...surface.states.events.map((e) => ({ key: e.key, name: e.name, ms: e.ms ? String(e.ms) : '' })), ...extra.events],
    });
  };
  const save = async () => {
    if (!draft || saving) return;
    const input: SurfaceStatesInput = {
      dims: draft.dims.map((d) => ({ ...(d.key ? { key: d.key } : null), name: d.name.trim(), values: d.values.map((v) => ({ ...(v.key ? { key: v.key } : null), name: v.name.trim() })), default: d.def })),
      events: draft.events.map((e) => ({ ...(e.key ? { key: e.key } : null), name: e.name.trim(), ...(e.ms.trim() ? { ms: Math.round(Number(e.ms)) } : null) })),
    };
    // 本地先挡住一眼能看出的错：空名、取值不够、重名、毫秒越界；其余交给服务端（API-CORE-054 的 400 原样写在这里）
    const bad = input.dims.some((d) => !d.name || d.values.some((v) => !v.name)) || input.events.some((e) => !e.name) ? t('states.editor.emptyName')
      : input.dims.some((d) => new Set(d.values.map((v) => v.name.toLowerCase())).size !== d.values.length) ? t('states.editor.dupValue')
        : new Set(input.dims.map((d) => d.name.toLowerCase())).size !== input.dims.length ? t('states.editor.dupDim')
          : input.events.some((e) => e.ms !== undefined && (!Number.isFinite(e.ms) || e.ms < EVENT_MS.min || e.ms > EVENT_MS.max)) ? t('states.editor.badMs', { min: EVENT_MS.min, max: EVENT_MS.max })
            : null;
    if (bad) { setSaveError(bad); return; }
    setSaving(true);
    const err = await onSave(input);
    setSaving(false);
    if (err) setSaveError(err); else { setDraft(null); onDismissProposal(); }
  };
  // 勾选建议（FLOW-STATES S3）：勾上的接在已有维度后面进编辑器，改名改取值后再保存
  const [picked, setPicked] = useState<{ dims: boolean[]; events: boolean[] }>({ dims: [], events: [] });
  useEffect(() => { setPicked({ dims: (proposal?.dims ?? []).map(() => true), events: (proposal?.events ?? []).map(() => true) }); }, [proposal]);
  const takeProposal = () => {
    if (!proposal) return;
    openEditor({
      dims: proposal.dims.filter((_, i) => picked.dims[i]).map((d) => ({ name: d.name, values: d.values.map((v) => ({ name: v })), def: 0 })),
      events: proposal.events.filter((_, i) => picked.events[i]).map((e) => ({ name: e.name, ms: e.ms ? String(e.ms) : '' })),
    });
  };

  return (
    <div className="flex flex-col gap-5 pb-2" data-testid="state-panel">
      <section aria-labelledby="st-surface">
        <h3 id="st-surface" className="flex items-baseline justify-between gap-2 px-1 pb-2">
          <span className="type-overline font-semibold text-text-secondary">{t('states.surface', { name: surface.name })}</span>
          {dims.length > 0 && !draft && <button type="button" onClick={() => openEditor()} data-testid="states-edit" className="state-layer focus-ring rounded-sm px-1.5 type-label text-(--semantic-color-action-link)">{t('states.edit')}</button>}
        </h3>
        {draft ? (
          <StatesEditor draft={draft} setDraft={setDraft} error={saveError} saving={saving} onSave={() => void save()} onCancel={() => { setDraft(null); setSaveError(null); }} />
        ) : (
          <>
            {dims.length === 0 && <p className="px-1 pb-2 type-label text-text-secondary">{t('states.noDims')}</p>}
            <div className="flex flex-col gap-3">
              {dims.map((d) => <DimRow key={d.key} dim={d} value={values[d.key] ?? d.default} screen={screen} screens={screens} busy={busy} onValue={onValue} onFill={onFill} />)}
            </div>
            {proposal && <ProposalBlock proposal={proposal} picked={picked} setPicked={setPicked} onTake={takeProposal} onDiscard={onDismissProposal} />}
            <div className="mt-3 flex flex-wrap gap-2 px-1">
              <Button size="sm" data-testid="states-add" aria-disabled={dims.length >= MAX_SURFACE_DIMS || undefined}
                onClick={() => { if (dims.length < MAX_SURFACE_DIMS) openEditor({ dims: [{ name: '', values: [{ name: '' }, { name: '' }], def: 0 }], events: [] }); }}>
                <Plus size={14} aria-hidden="true" />{t('states.addDim')}
              </Button>
              <Button size="sm" data-testid="states-propose" pending={proposing} aria-disabled={proposing || undefined} onClick={() => { if (!proposing) onPropose(); }}>
                {!proposing && <Sparkles size={14} aria-hidden="true" />}{proposing ? t('states.proposing') : t('states.propose')}
              </Button>
            </div>
            {dims.length >= MAX_SURFACE_DIMS && <p className="mt-1.5 px-1 type-caption text-text-secondary">{t('states.maxDims', { max: MAX_SURFACE_DIMS })}</p>}
          </>
        )}
      </section>

      <section aria-labelledby="st-page">
        <h3 id="st-page" className="px-1 pb-2 type-overline font-semibold text-text-secondary">{t('states.page')}</h3>
        {!screen ? <p className="px-1 type-label text-text-secondary">{t('states.noScreen')}</p> : (
          <>
            {pageDims.length === 0 && <p className="px-1 pb-2 type-label text-text-secondary">{t('states.noPage')}</p>}
            <div className="flex flex-col gap-3">
              {pageDims.map((d) => <ValueButtons key={d.key} dim={d} value={values[d.key] ?? d.default} missing={[]} onValue={onValue} />)}
            </div>
            {[...shadowed].filter((k) => page?.dims.some((d) => d.key === k)).map((k) => <p key={k} className="mt-1.5 px-1 type-caption text-warning">{t('states.shadowed', { key: k })}</p>)}
            <div className="mt-3 px-1"><Button size="sm" data-testid="states-add-page" onClick={onAddPageState}><Plus size={14} aria-hidden="true" />{t('states.addPage')}</Button></div>
          </>
        )}
      </section>

      <section aria-labelledby="st-events">
        <h3 id="st-events" className="px-1 pb-2 type-overline font-semibold text-text-secondary">{t('states.events')}</h3>
        {events.length === 0 ? <p className="px-1 type-label text-text-secondary">{t('states.noEvents')}</p> : (
          <ul className="flex flex-wrap gap-2 px-1">
            {events.map((e) => (
              <li key={e.key}><Button size="sm" data-testid="state-event" data-key={e.key} aria-label={t('states.play', { name: e.name })} onClick={() => onPlay(e.key, e.ms)}><Play size={12} aria-hidden="true" />{e.name}</Button></li>
            ))}
          </ul>
        )}
      </section>

      <div className="px-1 pt-3 shadow-[inset_0_var(--semantic-layout-hairline)_0_var(--semantic-color-border-subtle)]">
        <Button size="sm" data-testid="states-reset" onClick={onReset}><RotateCcw size={14} aria-hidden="true" />{t('states.reset')}</Button>
      </div>
    </div>
  );
}

// 一个维度一行分段按钮；这一屏没写的取值淡显，悬停写「这一屏没写这个取值」。
// 按钮外包了一层放提示气泡，.seg 的选中样式只认直接子元素，所以选中标在外层上
function ValueButtons({ dim, value, missing, onValue }: { dim: StateDim; value: string; missing: string[]; onValue: (dim: string, value: string) => void }) {
  const t = useT(fullviewMessages);
  return (
    <div role="radiogroup" aria-label={dim.name} data-testid="state-dim" data-key={dim.key} className="flex flex-col gap-1.5 px-1">
      <span className="type-label font-medium text-text-primary">{dim.name}</span>
      <div className="seg flex-wrap">
        {dim.values.map((v) => {
          const absent = missing.includes(v.key);
          return (
            <span key={v.key} data-state={v.key === value ? 'on' : 'off'} className="group/v relative flex">
              <button type="button" role="radio" aria-checked={v.key === value} data-testid="state-value" data-key={v.key} data-missing={absent ? '' : undefined}
                aria-description={absent ? t('states.notWritten') : undefined} onClick={() => onValue(dim.key, v.key)}
                className={cn('focus-ring h-7 rounded-sm px-2.5 type-label', v.key !== value && 'state-layer', absent && 'opacity-(--semantic-state-disabled-opacity)')}>
                {v.name}
              </button>
              {absent && <span aria-hidden="true" className="inverse pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md px-2.5 py-1.5 type-label opacity-0 shadow-(--semantic-elevation-overlay) transition-opacity duration-(--semantic-motion-duration-fast) group-hover/v:opacity-100 group-has-[:focus-visible]/v:opacity-100">{t('states.notWritten')}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// 端上的一个维度：分段按钮 + 「N 屏还没写」与「补上 N 屏」。点了补上就地换成确认，写明调用次数；正在改的屏不放进这一轮、就地点名
function DimRow({ dim, value, screen, screens, busy, onValue, onFill }: { dim: StateDim; value: string; screen: ScreenDto | null; screens: ScreenDto[]; busy: ReadonlySet<string>; onValue: (dim: string, value: string) => void; onFill: (dim: StateDim, targets: ScreenDto[]) => Promise<void> }) {
  const t = useT(fullviewMessages);
  const tc = useT(commonMessages);
  const missing = screen?.currentRevisionId ? missingValues(dim, screen.states?.uses).missing : [];
  const todo = unwrittenScreens(dim, screens);
  const ready = todo.filter((s) => !busy.has(s.id));
  const held = todo.filter((s) => busy.has(s.id));
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const fillRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => { if (!confirming && opened.current) fillRef.current?.focus(); if (confirming) opened.current = true; }, [confirming]);
  const calls = estimateJob({ kind: 'edit_screens', input: { prompt: 'x', screenIds: ready.map((s) => s.id), versions: 1 } }, screens.length).calls;
  return (
    <div>
      <ValueButtons dim={dim} value={value} missing={missing} onValue={onValue} />
      {todo.length > 0 && (
        <div className="mt-1.5 px-1" data-testid="state-unwritten">
          {confirming ? (
            <div role="group" aria-label={t('states.fill', { count: ready.length })} onKeyDown={(e) => { if (e.key === 'Escape' && !pending) { e.preventDefault(); e.stopPropagation(); setConfirming(false); } }}>
              <p className="type-label text-text-primary">{t('states.fillConfirm', { count: calls, n: ready.length })}</p>
              <div className="mt-1.5 flex justify-end gap-2">
                <Button size="sm" autoFocus aria-disabled={pending || undefined} onClick={() => { if (!pending) setConfirming(false); }}>{tc('cancel')}</Button>
                <Button size="sm" variant="primary" data-testid="state-fill-yes" pending={pending} aria-disabled={pending || undefined}
                  onClick={async () => { if (pending) return; setPending(true); try { await onFill(dim, ready); } finally { setPending(false); setConfirming(false); } }}>
                  {t('states.fillGo')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="type-caption text-text-secondary">{t('states.unwritten', { count: todo.length })}</span>
              {ready.length > 0 && <button ref={fillRef} type="button" data-testid="state-fill" onClick={() => setConfirming(true)} className="state-layer focus-ring rounded-sm px-1.5 type-label text-(--semantic-color-action-link)">{t('states.fill', { count: ready.length })}</button>}
            </div>
          )}
          {held.length > 0 && <p className="mt-1 type-caption text-text-secondary">{t('states.fillHeld', { names: held.map((s) => s.name).join(t('states.valueSep')) })}</p>}
        </div>
      )}
    </div>
  );
}

function ProposalBlock({ proposal, picked, setPicked, onTake, onDiscard }: { proposal: StatesProposalDto; picked: { dims: boolean[]; events: boolean[] }; setPicked: (p: { dims: boolean[]; events: boolean[] }) => void; onTake: () => void; onDiscard: () => void }) {
  const t = useT(fullviewMessages);
  const empty = proposal.dims.length === 0 && proposal.events.length === 0;
  const any = picked.dims.some(Boolean) || picked.events.some(Boolean);
  return (
    <div className="fill mt-3 rounded-md p-3" data-testid="states-proposal">
      <p className="type-label font-medium text-text-primary">{t('states.proposalTitle')}</p>
      {proposal.summary && <p className="mt-1 type-caption text-text-secondary">{proposal.summary}</p>}
      {empty ? <p className="mt-2 type-label text-text-secondary">{t('states.proposalEmpty')}</p> : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {proposal.dims.map((d, i) => (
            <li key={`d${i}`}>
              <label className="flex cursor-pointer items-start gap-2 type-label text-text-primary">
                <input type="checkbox" checked={picked.dims[i] ?? false} onChange={(e) => setPicked({ ...picked, dims: picked.dims.map((v, j) => (j === i ? e.target.checked : v)) })} className="focus-ring mt-0.5 size-3.5 shrink-0 accent-(--semantic-color-action-link)" />
                <span className="min-w-0"><span className="font-medium">{d.name}</span><span className="block type-caption text-text-secondary">{d.values.join(t('states.valueSep'))}</span></span>
              </label>
            </li>
          ))}
          {proposal.events.map((e, i) => (
            <li key={`e${i}`}>
              <label className="flex cursor-pointer items-start gap-2 type-label text-text-primary">
                <input type="checkbox" checked={picked.events[i] ?? false} onChange={(ev) => setPicked({ ...picked, events: picked.events.map((v, j) => (j === i ? ev.target.checked : v)) })} className="focus-ring mt-0.5 size-3.5 shrink-0 accent-(--semantic-color-action-link)" />
                <span className="min-w-0"><span className="font-medium">{e.name}</span><span className="block type-caption text-text-secondary">{t('states.eventKind')}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={onDiscard} data-testid="states-proposal-discard">{t('states.proposalDiscard')}</Button>
        {!empty && <Button size="sm" variant="primary" data-testid="states-proposal-take" aria-disabled={!any || undefined} onClick={() => { if (any) onTake(); }}>{t('states.proposalTake')}</Button>}
      </div>
    </div>
  );
}

// 改维度（FLOW-STATES S3）：维度名、取值（2～8 个，选一个缺省）、事件名与显示多久；保存整份提交
function StatesEditor({ draft, setDraft, error, saving, onSave, onCancel }: { draft: Draft; setDraft: (d: Draft) => void; error: string | null; saving: boolean; onSave: () => void; onCancel: () => void }) {
  const t = useT(fullviewMessages);
  const tc = useT(commonMessages);
  const setDim = (i: number, d: DraftDim) => setDraft({ ...draft, dims: draft.dims.map((x, j) => (j === i ? d : x)) });
  const setEvent = (i: number, e: DraftEvent) => setDraft({ ...draft, events: draft.events.map((x, j) => (j === i ? e : x)) });
  const field = 'focus-ring fill min-w-0 flex-1 rounded-sm px-2 py-1 type-label text-text-primary placeholder:text-(--semantic-color-text-tertiary)';
  return (
    <form data-testid="states-editor" className="flex flex-col gap-4 px-1" noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      {draft.dims.map((d, i) => (
        <fieldset key={i} className="flex flex-col gap-1.5" data-testid="editor-dim">
          <legend className="sr-only">{t('states.editor.dim', { n: i + 1 })}</legend>
          <div className="flex items-center gap-1">
            <input aria-label={t('states.editor.dimName')} placeholder={t('states.editor.dimName')} value={d.name} maxLength={20} onChange={(e) => setDim(i, { ...d, name: e.target.value })} className={cn(field, 'font-medium')} />
            <button type="button" aria-label={t('states.editor.removeDim', { name: d.name || t('states.editor.dim', { n: i + 1 }) })} onClick={() => setDraft({ ...draft, dims: draft.dims.filter((_, j) => j !== i) })} className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary"><Trash2 size={14} aria-hidden="true" /></button>
          </div>
          <ul className="flex flex-col gap-1 pl-2">
            {d.values.map((v, k) => (
              <li key={k} className="flex items-center gap-1.5">
                <input type="radio" name={`def-${i}`} aria-label={t('states.editor.default', { name: v.name || String(k + 1) })} checked={d.def === k} onChange={() => setDim(i, { ...d, def: k })} className="focus-ring size-3.5 shrink-0 accent-(--semantic-color-action-link)" />
                <input aria-label={t('states.editor.valueName', { n: k + 1 })} placeholder={t('states.editor.valueName', { n: k + 1 })} value={v.name} maxLength={20}
                  onChange={(e) => setDim(i, { ...d, values: d.values.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} className={field} />
                <button type="button" aria-label={t('states.editor.removeValue', { name: v.name || String(k + 1) })} aria-disabled={d.values.length <= MIN_DIM_VALUES || undefined}
                  onClick={() => { if (d.values.length > MIN_DIM_VALUES) setDim(i, { ...d, values: d.values.filter((_, j) => j !== k), def: d.def === k ? 0 : d.def > k ? d.def - 1 : d.def }); }}
                  className="state-layer focus-ring grid size-6 shrink-0 place-items-center rounded-sm text-text-secondary"><X size={12} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
          {d.values.length < MAX_DIM_VALUES && <button type="button" onClick={() => setDim(i, { ...d, values: [...d.values, { name: '' }] })} className="state-layer focus-ring self-start rounded-sm px-1.5 pl-2 type-label text-(--semantic-color-action-link)">{t('states.editor.addValue')}</button>}
        </fieldset>
      ))}
      {draft.dims.length < MAX_SURFACE_DIMS && <button type="button" data-testid="editor-add-dim" onClick={() => setDraft({ ...draft, dims: [...draft.dims, { name: '', values: [{ name: '' }, { name: '' }], def: 0 }] })} className="state-layer focus-ring self-start rounded-sm px-1.5 type-label text-(--semantic-color-action-link)">{t('states.addDim')}</button>}
      <div className="flex flex-col gap-1.5">
        <span className="type-label font-medium text-text-secondary">{t('states.events')}</span>
        {draft.events.map((e, i) => (
          <div key={i} className="flex items-center gap-1">
            <input aria-label={t('states.editor.eventName')} placeholder={t('states.editor.eventName')} value={e.name} maxLength={20} onChange={(ev) => setEvent(i, { ...e, name: ev.target.value })} className={field} />
            <input aria-label={t('states.editor.eventMs')} placeholder={String(EVENT_MS.default)} inputMode="numeric" value={e.ms} onChange={(ev) => setEvent(i, { ...e, ms: ev.target.value.replace(/[^0-9]/g, '') })} className={cn(field, 'w-16 flex-none tabular-nums')} />
            <button type="button" aria-label={t('states.editor.removeEvent', { name: e.name || String(i + 1) })} onClick={() => setDraft({ ...draft, events: draft.events.filter((_, j) => j !== i) })} className="state-layer focus-ring grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary"><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        ))}
        {draft.events.length < MAX_SURFACE_EVENTS && <button type="button" onClick={() => setDraft({ ...draft, events: [...draft.events, { name: '', ms: '' }] })} className="state-layer focus-ring self-start rounded-sm px-1.5 type-label text-(--semantic-color-action-link)">{t('states.editor.addEvent')}</button>}
      </div>
      <p className="type-caption text-text-secondary">{t('states.editor.note')}</p>
      {error && <p role="alert" data-testid="states-error" className="type-label text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>{tc('cancel')}</Button>
        <Button size="sm" type="submit" variant="primary" pending={saving} data-testid="states-save">{t('states.editor.save')}</Button>
      </div>
    </form>
  );
}
