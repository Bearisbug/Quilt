import { useRef, useState, type DragEvent } from 'react';
import { Copy, Trash2, Upload } from 'lucide-react';
import { ASSET_MEDIA_TYPES, TOKEN_COLOR_KEYS, kebab, MAX_ASSET_BYTES, type AssetDto, type ColorMode, type Palette, type TokenColorKey, type Tokens } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button } from '@/ui/ui';
import { ConfirmDialog } from '@/ui/modal';
import { toneClass, toneColor, useAssetTone } from '@/lib/assetTone';
import { SWATCH_EDGE } from './designOptions';
import { useT } from '@/i18n';
import panelsMessages from '@/i18n/locales/panels-design';
import commonMessages from '@/i18n/locales/common';

// 品牌色板（REQ-EDIT-005）：26 个 token 色键的色块表，逐键标出「派生 / 品牌」，可就地改一个键、可整份清空。
// 色块底色是数据（用户的品牌色），只能走 inline style；工具自己的外壳仍然只用 token 类。
export function PaletteSection({ tokens, palette, colorMode, savedColorMode, onChange }: {
  tokens: Tokens; palette: Palette | null; colorMode: ColorMode; savedColorMode: ColorMode;
  onChange: (next: { palette: Palette | null; colorMode: ColorMode }) => void;
}) {
  const t = useT(panelsMessages);
  const [open, setOpen] = useState(false);
  const active = palette?.[colorMode] ?? {};
  const overridden = Object.keys(active).length;

  const setKey = (key: TokenColorKey, hex: string) => {
    const base: Palette = palette ?? { light: {} };
    onChange({ colorMode, palette: { ...base, [colorMode]: { ...(base[colorMode] ?? {}), [key]: hex.toUpperCase() } } });
  };
  const dropKey = (key: TokenColorKey) => {
    if (!palette) return;
    const rest = { ...(palette[colorMode] ?? {}) };
    delete rest[key];
    const next: Palette = { ...palette, [colorMode]: rest };
    // 两套都空了就等于没有色板，此时 colorMode 必须跟着回亮色：API-EDIT-002 对 {palette:null, colorMode:'dark'} 报
    // 「没有暗色色板可切」，整次保存被挡回，而段控也已随 palette=null 消失，用户在面板里再没有切回亮色的出口
    if (!Object.keys(next.light).length && !Object.keys(next.dark ?? {}).length) { onChange({ palette: null, colorMode: 'light' }); return; }
    onChange({ colorMode, palette: next });
  };

  return (
    <div className="space-y-1.5" data-testid="palette-section">
      {/* 英文的切换钮更长：一行放不下时右边整组换到下一行，钮里的字不折行 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="type-label font-semibold text-text-secondary">{t('palette.source')}</span>
        <div className="flex items-center gap-2">
          {palette?.dark && (
            <div className="seg" role="group" aria-label={t('palette.mode')} data-testid="palette-mode">
              {(['light', 'dark'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={colorMode === m} data-testid={`palette-mode-${m}`}
                  onClick={() => onChange({ palette, colorMode: m })}
                  className={`px-2 py-0.5 type-caption focus-ring ${colorMode === m ? '' : 'state-layer'}`}>{t(m === 'light' ? 'palette.light' : 'palette.dark')}</button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="palette-toggle"
            className="whitespace-nowrap rounded-md px-1.5 py-0.5 type-caption text-(--semantic-color-action-link) state-layer focus-ring">
            {overridden ? t('palette.brand', { count: overridden }) : t('palette.derived')}{open ? ' ▴' : ' ▾'}
          </button>
        </div>
      </div>
      {open && (
        <>
          <ul className="grid grid-cols-2 gap-1" data-testid="palette-grid">
            {TOKEN_COLOR_KEYS.map((key) => {
              // 覆盖了的键显示这一套色板的值；没覆盖的走种子派生——派生值随模式变（亮暗两套 Material 方案），
              // 而 tokens 是服务端按「已保存的」模式算的，所以切了模式还没保存时，派生值先不报数
              const isBrand = key in active;
              const stale = !isBrand && colorMode !== savedColorMode;
              const value = active[key] ?? tokens.colors[key];
              return (
                <li key={key} className="fill flex items-center gap-1.5 rounded-md px-1.5 py-1" data-token={key} data-source={isBrand ? 'brand' : 'derived'}>
                  <label className={`relative size-5 shrink-0 cursor-pointer rounded-sm focus-ring is-field ${SWATCH_EDGE}`} style={{ background: value }}>
                    <span className="sr-only">{t('palette.changeColor', { token: kebab(key) })}</span>
                    <input type="color" value={value} onChange={(e) => setKey(key, e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
                  </label>
                  {/* 名字与色值分两行：并排放在窄面板里会把色值截断，而色值才是这里要看的东西 */}
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className={`block truncate type-caption ${isBrand ? 'text-text-primary' : 'text-text-secondary'}`} title={kebab(key)}>{kebab(key)}</span>
                    <span className="block font-mono type-caption text-text-secondary">{stale ? t('palette.staleValue') : value}</span>
                  </span>
                  {isBrand && (
                    <button type="button" aria-label={t('palette.revert', { token: kebab(key) })} onClick={() => dropKey(key)}
                      className="shrink-0 rounded-sm px-1 type-caption text-text-secondary state-layer focus-ring">×</button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <span className="type-caption text-text-secondary">{t('palette.footnote')}</span>
            <Button size="sm" disabled={!overridden} data-testid="palette-clear" onClick={() => onChange({ palette: null, colorMode: 'light' })}>{t('palette.clear')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

// 素材瓦片：底色按该图亮度选，优先取项目色板（toneColor，v0.98），读不出就棋盘格。
// 展示用 <img> 不加 crossOrigin：那会把普通图片请求升级成 CORS 请求，而 /a/ 的 ACAO 是常量 webOrigin，
// 页面 origin 不等于它（127.0.0.1、局域网地址）时整张图加载失败——标志本身不显示，比棋盘格更糟。
// 取像素判亮度的那个离屏 Image 自带 crossOrigin，读不出来本就回落棋盘格（assetTone.ts）
function AssetTile({ asset, colors, className }: { asset: AssetDto; colors: Tokens['colors']; className: string }) {
  const tone = useAssetTone(asset.url);
  return <img src={asset.url} alt="" width={40} height={40} loading="lazy" className={`${toneClass(tone)} object-contain ${className}`} style={{ backgroundColor: toneColor(tone, colors) }} />;
}

// 项目素材（REQ-CORE-019）：上传 / 复制引用地址 / 删除；清单随每次生成进 prompt。
// 列表来自项目详情（与风格指南卡片同一份），增删后让父组件重取，避免两处各刷各的
export function AssetsSection({ projectId, items, colors, onChanged }: { projectId: string; items: AssetDto[]; colors: Tokens['colors']; onChanged: () => void }) {
  const toast = useToast();
  const t = useT(panelsMessages);
  const tc = useT(commonMessages);
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AssetDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const tooBig = list.find((f) => f.size > MAX_ASSET_BYTES);
    if (tooBig) { toast(t('assets.tooBig', { name: tooBig.name, mb: MAX_ASSET_BYTES / 1024 / 1024 }), 'error'); return; }
    setUploading(true);
    try {
      for (const f of list) await api.assets.upload(projectId, f);
      toast(list.length === 1 ? t('assets.uploadedOne', { name: list[0].name }) : t('assets.uploadedMany', { n: list.length }));
      onChanged();
    } catch (e) {
      const detail = e instanceof ApiError ? (e.problem.errors as { message?: string }[] | undefined)?.[0]?.message : undefined;
      toast(e instanceof ApiError && e.type === '/errors/validation' ? (detail ?? t('assets.invalidFile')) : t('assets.uploadFailed'), 'error');
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  // 拖入上传：与「上传」按钮同一条路径（点按仍是键盘可达的等价入口）。
  // dragover 不 preventDefault 这块就不是合法放置目标，浏览器会拿文件自己去导航
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDropping(false);
    const files = [...e.dataTransfer.files];
    const ok = files.filter((f) => (ASSET_MEDIA_TYPES as readonly string[]).includes(f.type));
    if (ok.length < files.length) toast(t('assets.skipped', { count: files.length - ok.length }), 'error');
    void upload(ok);
  };

  return (
    <div className={`space-y-1.5 border-t pt-3 ${dropping ? 'border-(--semantic-color-action-link) outline-2 outline-dashed outline-(--semantic-color-action-link) outline-offset-2' : 'border-border-subtle'}`}
      data-testid="assets-panel" data-dropping={dropping ? '' : undefined} onDrop={onDrop}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}>
      <div className="flex items-center justify-between gap-2">
        {/* 拖入提示占用标题本来的位置：另起一行会把下面的列表整块推走 */}
        <span className={`type-label font-semibold ${dropping ? 'text-(--semantic-color-action-link)' : 'text-text-secondary'}`}>{dropping ? t('assets.dropHint') : t('assets.title')}</span>
        <Button size="sm" pending={uploading} disabled={uploading} data-testid="asset-upload" onClick={() => fileRef.current?.click()}>
          <Upload size={14} aria-hidden="true" />{t('assets.upload')}
        </Button>
      </div>
      {/* 选文件与拖入两条路必须认同一份类型清单，否则拖进来的文件被前端放过、到服务端才被拒 */}
      <input ref={fileRef} type="file" multiple accept={ASSET_MEDIA_TYPES.join(',')} className="sr-only"
        onChange={(e) => { if (e.target.files) void upload(e.target.files); }} />
      {items.length === 0 ? (
        <p className="type-label text-text-secondary">{t('assets.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="asset-list">
          {items.map((a) => (
            <li key={a.id} className="fill flex items-center gap-2 rounded-md p-1.5" data-testid="asset-item" data-name={a.name}>
              {/* 素材长宽不可控：固定方槽 + contain，logo 不能被裁（VIS-006 / PERF-003） */}
              <AssetTile asset={a} colors={colors} className="size-10 shrink-0 rounded-sm p-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate type-label text-text-primary" title={a.name}>{a.name}</span>
                <span className="block truncate type-caption text-text-secondary">{a.mediaType.replace('image/', '').replace('+xml', '')} · {a.width && a.height ? `${a.width}×${a.height} · ` : ''}{Math.max(1, Math.round(a.bytes / 1024))} KB</span>
              </span>
              <button type="button" aria-label={t('assets.copyLabel', { name: a.name })} data-testid="asset-copy"
                onClick={() => { void navigator.clipboard.writeText(a.url).then(() => toast(t('assets.copied')), () => toast(t('assets.copyFailed'), 'error')); }}
                className="shrink-0 rounded-md p-1 text-text-secondary state-layer focus-ring"><Copy size={14} aria-hidden="true" /></button>
              <button type="button" aria-label={t('assets.deleteLabel', { name: a.name })} data-testid="asset-delete" onClick={() => setPendingDelete(a)}
                className="shrink-0 rounded-md p-1 text-text-secondary state-layer focus-ring"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {pendingDelete && (
        <ConfirmDialog title={t('assets.deleteTitle', { name: pendingDelete.name })}
          body={t('assets.deleteBody')}
          confirmLabel={tc('delete')} onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try { await api.assets.remove(pendingDelete.id); toast(t('assets.deleted')); onChanged(); }
            catch { toast(t('deleteFailed'), 'error'); }
            finally { setPendingDelete(null); }
          }} />
      )}
    </div>
  );
}
