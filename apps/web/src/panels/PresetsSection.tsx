import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Trash2 } from 'lucide-react';
import type { DesignPresetDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Input } from '@/ui/ui';
import { ConfirmDialog, Overlay, useModal } from '@/ui/modal';
import { SWATCH_EDGE } from './designOptions';
import { useT } from '@/i18n';
import panelsMessages from '@/i18n/locales/panels-design';
import commonMessages from '@/i18n/locales/common';

// 设计预设（REQ-CORE-021）：把当前项目的设计系统连同素材存成账号级预设，供别的项目开局或随时套用。
// 预设存的是输入（种子色 / 字体 / 圆角 / 色板 / 模式 / DESIGN.md / 组件配方），tokens 由套用方现算。
export function PresetsSection({ projectId, version, busy, onApplied }: {
  projectId: string; version: number; busy: boolean; onApplied: () => void;
}) {
  const toast = useToast();
  const t = useT(panelsMessages);
  const tc = useT(commonMessages);
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
      toast(r.assetsCopied ? t('presets.appliedWithAssets', { name: p.name, count: r.assetsCopied }) : t('presets.applied', { name: p.name }));
      onApplied();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? t('presets.versionConflict') : t('presets.applyFailed'), 'error');
    }
  };

  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-3" data-testid="presets-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="type-label font-semibold text-text-secondary">{t('presets.title')}</span>
        <Button ref={saveRef} size="sm" data-testid="preset-save" disabled={busy} onClick={() => setSaveOpen(true)}>
          <BookmarkPlus size={14} aria-hidden="true" />{t('presets.saveAs')}
        </Button>
      </div>
      {loadError && <p role="alert" className="tint-error flex items-center justify-between gap-2 rounded-md px-3 py-2 type-label"><span>{t('presets.loadFailed')}</span><Button size="sm" onClick={load}>{tc('retry')}</Button></p>}
      {items === null ? (loadError ? null :
        <ul className="flex flex-col gap-1" aria-busy="true">
          {[0, 1].map((i) => <li key={i} className="fill h-9 animate-pulse rounded-md" />)}
        </ul>
      ) : items.length === 0 ? (
        <p className="type-label text-text-secondary">{t('presets.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="preset-list">
          {items.map((p) => (
            <li key={p.id} className="fill flex items-center gap-2 rounded-md p-1.5" data-testid="preset-item" data-name={p.name}>
              <span className={`size-5 shrink-0 rounded-sm ${SWATCH_EDGE}`} style={{ background: p.palette?.[p.colorMode]?.primary ?? p.seedColor }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate type-label text-text-primary" title={p.name}>{p.name}</span>
                <span className="block truncate type-caption text-text-secondary">{p.assetCount ? t('presets.metaWithAssets', { count: p.assetCount, font: p.fontFamily, date: p.createdAt.slice(0, 10) }) : `${p.fontFamily} · ${p.createdAt.slice(0, 10)}`}</span>
              </span>
              <Button size="sm" data-testid="preset-apply" disabled={busy} onClick={() => setApplying(p)}>{t('presets.apply')}</Button>
              <button type="button" aria-label={t('presets.deleteLabel', { name: p.name })} data-testid="preset-delete" onClick={() => setPendingDelete(p)}
                className="shrink-0 rounded-md p-1 text-text-secondary state-layer focus-ring"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}

      {saveOpen && <SavePresetDialog projectId={projectId} returnTo={saveRef} onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); load(); }} />}
      {applying && (
        <ConfirmDialog title={t('presets.applyTitle', { name: applying.name })}
          body={t('presets.applyBody')}
          confirmLabel={t('presets.apply')} onCancel={() => setApplying(null)} onConfirm={() => apply(applying)} />
      )}
      {pendingDelete && (
        <ConfirmDialog title={t('presets.deleteTitle', { name: pendingDelete.name })}
          body={t('presets.deleteBody')}
          confirmLabel={tc('delete')} onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try { await api.presets.remove(pendingDelete.id); toast(t('presets.deleted')); load(); }
            catch { toast(t('deleteFailed'), 'error'); }
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
  const t = useT(panelsMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose, returnTo);
  const [name, setName] = useState('');
  const [includeAssets, setIncludeAssets] = useState(true);
  const [pending, setPending] = useState(false);

  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="pre-title" tabIndex={-1} data-testid="preset-save-dialog"
        className="sheet w-full max-w-xs p-5 fade-up outline-none"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setPending(true);
          try { await api.presets.create({ projectId, name: name.trim(), includeAssets }); toast(t('presets.saveDialog.savedAs', { name: name.trim() })); onSaved(); }
          catch { toast(t('presets.saveDialog.saveFailed'), 'error'); setPending(false); }
        }}>
        <h2 id="pre-title" className="type-heading3 font-semibold">{t('presets.saveDialog.title')}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('presets.saveDialog.body')}</p>
        <div className="mt-4 space-y-3">
          <Input autoFocus data-testid="preset-name" aria-label={t('presets.saveDialog.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('presets.saveDialog.placeholder')} maxLength={80} />
          <label className="flex items-center gap-2 type-label text-text-primary">
            <input type="checkbox" checked={includeAssets} onChange={(e) => setIncludeAssets(e.target.checked)} data-testid="preset-with-assets" className="size-4 accent-(--semantic-color-action-link)" />
            {t('presets.saveDialog.withAssets')}
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{tc('cancel')}</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!name.trim() || pending} data-testid="preset-save-confirm">{t('presets.saveDialog.save')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
