import { useEffect, useState } from 'react';
import type { RevisionDto, ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, Panel, Spinner } from '@/ui/ui';
import { intlLocale, useT } from '@/i18n';
import inspectMessages from '@/i18n/locales/panels-inspect';
import commonMessages from '@/i18n/locales/common';

// 修订来源的显示名在 panels-inspect 命名空间的 revision.source.<sourceKind>；不认识的来源原样显示
type SourceKind = keyof typeof inspectMessages.zh.revision.source;
const isSourceKind = (k: string): k is SourceKind => Object.hasOwn(inspectMessages.zh.revision.source, k);

// 修订面板（REQ-CORE-007 v0.31）：修订树——同批候选折成一组（未选用的可随时采用），其余按 seq 倒序并标出派生自哪一版。回溯仍是建新修订。
export function RevisionPanel({ screen, onClose, onRestored }: { screen: ScreenDto; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const t = useT(inspectMessages);
  const tc = useT(commonMessages);
  const [items, setItems] = useState<RevisionDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 取数失败就地给重试（v1.03）；重取失败时已列出的修订留在原地
  const load = () => { setLoadError(false); api.screens.revisions(screen.id).then((r) => setItems(r.items)).catch(() => setLoadError(true)); };
  useEffect(() => { setItems(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [screen.id, screen.currentRevisionId]);

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast(t('revision.revisionConflict'), 'error');
    else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast(t('revision.screenBusy'), 'error');
    else toast(fallback, 'error');
  };
  const restore = async (rev: RevisionDto) => {
    if (!screen.currentRevisionId) return;
    setBusy(rev.id);
    try { await api.screens.restore(screen.id, rev.id, screen.currentRevisionId); toast(t('revision.restored', { seq: rev.seq })); onRestored(); }
    catch (e) { fail(e, t('revision.restoreFailed')); } finally { setBusy(null); }
  };
  const adopt = async (rev: RevisionDto) => {
    setBusy(rev.id);
    try { await api.screens.adopt(screen.id, rev.id); toast(t('revision.adopted', { n: (rev.candidateIndex ?? 0) + 1 })); onRestored(); }
    catch (e) { fail(e, t('revision.adoptFailed')); } finally { setBusy(null); }
  };

  // 分组：同 jobId 的候选折成一组，其余单独成项；按组内最大 seq 倒序排
  type Group = { key: string; jobId: string | null; revs: RevisionDto[] };
  const groups: Group[] = [];
  for (const r of items ?? []) {
    if (r.candidateIndex !== null && r.jobId) {
      const g = groups.find((x) => x.jobId === r.jobId);
      if (g) { g.revs.push(r); continue; }
      groups.push({ key: `job:${r.jobId}`, jobId: r.jobId, revs: [r] });
    } else groups.push({ key: r.id, jobId: null, revs: [r] });
  }
  const seqOf = (id: string | null) => items?.find((r) => r.id === id)?.seq;

  const row = (r: RevisionDto, inGroup: boolean) => {
    const current = r.id === screen.currentRevisionId;
    const settled = !!r.candidateSettledAt;
    // 「第 n 版」只指修订序号；同批候选叫「候选 n」（PAGE-CANVAS「同一功能一个名字」）
    const label = inGroup ? t('revision.candidate', { n: (r.candidateIndex ?? 0) + 1 }) : t('revision.version', { seq: r.seq });
    const status = current ? (inGroup && settled ? t('revision.status.adopted') : t('revision.status.current')) : inGroup && !settled ? t('revision.status.unadopted') : '';
    return (
      <li key={r.id} className={`flex gap-2 rounded-md p-2 ${current ? 'bg-(--semantic-color-surface-selected)' : inGroup ? '' : 'fill'}`} data-testid="revision" data-seq={r.seq} data-candidate={inGroup ? r.candidateIndex ?? undefined : undefined}>
        {r.thumbUrl ?? r.screenshotUrl ? <img src={(r.thumbUrl ?? r.screenshotUrl)!} alt={label} width={44} height={Math.round((44 * screen.height) / screen.width)} loading="lazy" className="w-11 shrink-0 rounded-sm bg-neutral-0 object-cover object-top" /> : <div className="fill w-11 shrink-0 rounded-sm" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 type-label">
            <span className="font-medium">{status ? t('revision.labelWithStatus', { label, status }) : label}</span>
            <span className="text-text-secondary">{isSourceKind(r.sourceKind) ? t(`revision.source.${r.sourceKind}`) : r.sourceKind}</span>
          </div>
          <div className="type-caption text-text-secondary">{new Date(r.createdAt).toLocaleString(intlLocale())}{r.parentRevisionId && seqOf(r.parentRevisionId) ? ` · ${t('revision.derivedFrom', { seq: seqOf(r.parentRevisionId) })}` : ''}</div>
          {!current && inGroup && !settled && <Button size="sm" className="mt-1.5" data-testid="adopt-revision" pending={busy === r.id} onClick={() => adopt(r)}>{t('revision.adopt')}</Button>}
          {!current && (!inGroup || settled) && <Button size="sm" className="mt-1.5" pending={busy === r.id} onClick={() => restore(r)}>{t('revision.restore')}</Button>}
        </div>
      </li>
    );
  };

  return (
    <Panel title={t('revision.title', { name: screen.name })} className="h-full" actions={<Button size="sm" onClick={onClose}>{tc('close')}</Button>}>
      {loadError && <p role="alert" className="tint-error m-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 type-label"><span>{t('revision.loadFailed')}</span><Button size="sm" onClick={load}>{tc('retry')}</Button></p>}
      {items === null ? (!loadError && <Spinner />) : items.length === 0 ? <EmptyState title={t('revision.emptyTitle')} hint={t('revision.emptyHint')} /> : (
        <ul className="scroll flex flex-1 flex-col gap-2 p-2">
          {groups.map((g) => g.jobId ? (
            <li key={g.key} className="fill rounded-lg p-1.5" data-testid="candidate-group" data-job={g.jobId}>
              <div className="px-1 pb-1.5 type-caption text-text-secondary">{g.revs.every((r) => r.candidateSettledAt) ? t('revision.groupAdopted', { count: g.revs.length }) : t('revision.groupPending', { count: g.revs.length })}</div>
              <ul className="flex flex-col gap-1.5">{[...g.revs].sort((a, b) => (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0)).map((r) => row(r, true))}</ul>
            </li>
          ) : row(g.revs[0], false))}
        </ul>
      )}
    </Panel>
  );
}
