import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Trash2 } from 'lucide-react';
import type { DesignPresetDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Input } from '@/ui/ui';
import { ConfirmDialog, Overlay, useModal } from '@/ui/modal';

// 设计预设（REQ-CORE-021）：把当前项目的设计系统连同素材存成账号级预设，供别的项目开局或随时套用。
// 预设存的是输入（种子色 / 字体 / 圆角 / 色板 / 模式 / DESIGN.md / 组件配方），tokens 由套用方现算。
export function PresetsSection({ projectId, version, busy, onApplied }: {
  projectId: string; version: number; busy: boolean; onApplied: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<DesignPresetDto[] | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [applying, setApplying] = useState<DesignPresetDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DesignPresetDto | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  // 取数失败不能说成「还没有预设」（v1.03）：就地给重试，已列出的留在原地
  const [loadError, setLoadError] = useState(false);
  const load = () => { setLoadError(false); api.presets.list().then((r) => setItems(r.items)).catch(() => setLoadError(true)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (p: DesignPresetDto) => {
    setApplying(null);
    try {
      const r = await api.presets.apply(projectId, { presetId: p.id, expectedVersion: version });
      toast(r.assetsCopied ? `已套用「${p.name}」，另复制了 ${r.assetsCopied} 个素材` : `已套用「${p.name}」`);
      onApplied();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，刷新后再套用' : '套用失败', 'error');
    }
  };

  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-3" data-testid="presets-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="type-label font-medium text-text-secondary">设计预设（跨项目复用这套视觉）</span>
        <Button ref={saveRef} size="sm" data-testid="preset-save" disabled={busy} onClick={() => setSaveOpen(true)}>
          <BookmarkPlus size={14} aria-hidden="true" />存为预设
        </Button>
      </div>
      {loadError && <p role="alert" className="flex items-center justify-between gap-2 rounded-md border border-error/60 bg-error/10 px-3 py-2 type-label text-error"><span>预设列表没取到</span><Button size="sm" onClick={load}>重试</Button></p>}
      {items === null ? (loadError ? null :
        <ul className="flex flex-col gap-1" aria-busy="true">
          {[0, 1].map((i) => <li key={i} className="h-9 animate-pulse rounded-md bg-(--semantic-color-surface-sunken)" />)}
        </ul>
      ) : items.length === 0 ? (
        <p className="type-label text-text-secondary">还没有预设。把这个项目的配色、字体、圆角、DESIGN.md 与素材存成一份，新建别的项目时就能直接开局。</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="preset-list">
          {items.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md border border-border-subtle p-1.5" data-testid="preset-item" data-name={p.name}>
              <span className="size-5 shrink-0 rounded-sm border border-border-subtle" style={{ background: p.palette?.[p.colorMode]?.primary ?? p.seedColor }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate type-label text-text-primary" title={p.name}>{p.name}</span>
                <span className="block truncate type-caption text-text-secondary">{p.assetCount ? `${p.assetCount} 个素材 · ` : ''}{p.fontFamily} · {p.createdAt.slice(0, 10)}</span>
              </span>
              <Button size="sm" data-testid="preset-apply" disabled={busy} onClick={() => setApplying(p)}>套用</Button>
              <button type="button" aria-label={`删除预设「${p.name}」`} data-testid="preset-delete" onClick={() => setPendingDelete(p)}
                className="shrink-0 rounded-md p-1 text-text-secondary state-layer focus-ring"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}

      {saveOpen && <SavePresetDialog projectId={projectId} returnTo={saveRef} onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); load(); }} />}
      {applying && (
        <ConfirmDialog title={`套用预设「${applying.name}」？`}
          body="会覆盖当前的配色、字体、圆角、DESIGN.md 与组件配方；预设里的素材是新增，不会删掉现有素材。"
          confirmLabel="套用" onCancel={() => setApplying(null)} onConfirm={() => apply(applying)} />
      )}
      {pendingDelete && (
        <ConfirmDialog title={`删除预设「${pendingDelete.name}」？`}
          body="只删这份预设，已经套用过它的项目不受影响。"
          confirmLabel="删除" onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try { await api.presets.remove(pendingDelete.id); toast('预设已删除'); load(); }
            catch { toast('删除失败', 'error'); }
            finally { setPendingDelete(null); }
          }} />
      )}
    </div>
  );
}

// 取名 + 要不要连素材一起存；素材默认带上——同一品牌的两个项目多半要用同一套 logo
function SavePresetDialog({ projectId, returnTo, onClose, onSaved }: {
  projectId: string; returnTo: React.RefObject<HTMLButtonElement | null>; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const ref = useModal<HTMLFormElement>(onClose, returnTo);
  const [name, setName] = useState('');
  const [includeAssets, setIncludeAssets] = useState(true);
  const [pending, setPending] = useState(false);

  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="pre-title" tabIndex={-1} data-testid="preset-save-dialog"
        className="w-full max-w-xs rounded-lg border border-border-subtle bg-surface-overlay p-5 shadow-(--semantic-elevation-overlay) fade-up outline-none"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setPending(true);
          try { await api.presets.create({ projectId, name: name.trim(), includeAssets }); toast(`已存为预设「${name.trim()}」`); onSaved(); }
          catch { toast('存预设失败', 'error'); setPending(false); }
        }}>
        <h2 id="pre-title" className="type-heading3 font-medium">存为设计预设</h2>
        <p className="mt-1 type-label text-text-secondary">存的是配色、字体、圆角、DESIGN.md 与组件配方；之后新建项目可以直接用它开局。</p>
        <div className="mt-4 space-y-3">
          <Input autoFocus data-testid="preset-name" aria-label="预设名" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Ofcourt Rally" maxLength={80} />
          <label className="flex items-center gap-2 type-label text-text-primary">
            <input type="checkbox" checked={includeAssets} onChange={(e) => setIncludeAssets(e.target.checked)} data-testid="preset-with-assets" className="size-4 accent-primary" />
            连素材一起存（logo 等，套用时复制给目标项目）
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!name.trim() || pending} data-testid="preset-save-confirm">保存</Button>
        </div>
      </form>
    </Overlay>
  );
}
