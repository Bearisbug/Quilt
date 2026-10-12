import { useEffect, useState } from 'react';
import type { RevisionDto, ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, Panel, Spinner } from '@/ui/ui';

const SOURCE_LABEL: Record<string, string> = { generate: '生成', edit: '对话修改', subtree: '重生成一块', manual: '直改', restore: '回溯', apply_ds: '设计系统回刷', agent_ingest: 'agent 推入', component: '共享组件同步' };

// 修订面板（REQ-CORE-007 v0.31）：修订树——同批候选折成一组（未选用的可随时采用），其余按 seq 倒序并标出派生自哪一版。回溯仍是建新修订。
export function RevisionPanel({ screen, onClose, onRestored }: { screen: ScreenDto; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<RevisionDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 取数失败就地给重试（v1.03）；重取失败时已列出的修订留在原地
  const load = () => { setLoadError(false); api.screens.revisions(screen.id).then((r) => setItems(r.items)).catch(() => setLoadError(true)); };
  useEffect(() => { setItems(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [screen.id, screen.currentRevisionId]);

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast('屏幕已被更新，请刷新后重试', 'error');
    else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中，稍后再试', 'error');
    else toast(fallback, 'error');
  };
  const restore = async (rev: RevisionDto) => {
    if (!screen.currentRevisionId) return;
    setBusy(rev.id);
    try { await api.screens.restore(screen.id, rev.id, screen.currentRevisionId); toast(`已回溯到第 ${rev.seq} 版`); onRestored(); }
    catch (e) { fail(e, '回溯失败'); } finally { setBusy(null); }
  };
  const adopt = async (rev: RevisionDto) => {
    setBusy(rev.id);
    try { await api.screens.adopt(screen.id, rev.id); toast(`已采用候选 ${(rev.candidateIndex ?? 0) + 1}`); onRestored(); }
    catch (e) { fail(e, '采用失败'); } finally { setBusy(null); }
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
    const label = inGroup ? `候选 ${(r.candidateIndex ?? 0) + 1}` : `第 ${r.seq} 版`;
    const status = current ? (inGroup && settled ? '已采用' : '当前') : inGroup && !settled ? '未选用' : '';
    return (
      <li key={r.id} className={`flex gap-2 rounded-md border p-2 ${current ? 'border-primary bg-(--semantic-color-surface-selected)' : 'border-border-subtle'}`} data-testid="revision" data-seq={r.seq} data-candidate={inGroup ? r.candidateIndex ?? undefined : undefined}>
        {r.thumbUrl ?? r.screenshotUrl ? <img src={(r.thumbUrl ?? r.screenshotUrl)!} alt={label} width={44} height={Math.round((44 * screen.height) / screen.width)} loading="lazy" className="w-11 shrink-0 rounded-sm bg-neutral-0 object-cover object-top" /> : <div className="w-11 shrink-0 rounded-sm bg-(--semantic-color-surface-sunken)" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 type-label">
            <span className="font-medium">{label}{status ? `（${status}）` : ''}</span>
            <span className="text-text-secondary">{SOURCE_LABEL[r.sourceKind] ?? r.sourceKind}</span>
          </div>
          <div className="type-caption text-text-secondary">{new Date(r.createdAt).toLocaleString()}{r.parentRevisionId && seqOf(r.parentRevisionId) ? ` · 派生自第 ${seqOf(r.parentRevisionId)} 版` : ''}</div>
          {!current && inGroup && !settled && <Button size="sm" className="mt-1.5" data-testid="adopt-revision" pending={busy === r.id} onClick={() => adopt(r)}>采用</Button>}
          {!current && (!inGroup || settled) && <Button size="sm" className="mt-1.5" pending={busy === r.id} onClick={() => restore(r)}>回溯到此版</Button>}
        </div>
      </li>
    );
  };

  return (
    <Panel title={`修订 · ${screen.name}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      {loadError && <p role="alert" className="m-2 flex items-center justify-between gap-2 rounded-md border border-error/60 bg-error/10 px-3 py-2 type-label text-error"><span>修订列表没取到</span><Button size="sm" onClick={load}>重试</Button></p>}
      {items === null ? (!loadError && <Spinner />) : items.length === 0 ? <EmptyState title="还没有修订" hint="生成完成后会出现在这里" /> : (
        <ul className="scroll flex flex-1 flex-col gap-2 p-2">
          {groups.map((g) => g.jobId ? (
            <li key={g.key} className="rounded-lg border border-dashed border-border-subtle p-1.5" data-testid="candidate-group" data-job={g.jobId}>
              <div className="px-1 pb-1.5 type-caption text-text-secondary">候选 · {g.revs.length} 版{g.revs.every((r) => r.candidateSettledAt) ? ' · 已采用' : ' · 待采用'}</div>
              <ul className="flex flex-col gap-1.5">{[...g.revs].sort((a, b) => (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0)).map((r) => row(r, true))}</ul>
            </li>
          ) : row(g.revs[0], false))}
        </ul>
      )}
    </Panel>
  );
}
