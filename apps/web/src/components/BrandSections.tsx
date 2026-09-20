import { useRef, useState, type DragEvent } from 'react';
import { Copy, Trash2, Upload } from 'lucide-react';
import { ASSET_MEDIA_TYPES, TOKEN_COLOR_KEYS, kebab, MAX_ASSET_BYTES, type AssetDto, type ColorMode, type Palette, type TokenColorKey, type Tokens } from '@quilt/core';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button } from './ui';
import { ConfirmDialog } from './modal';
import { toneClass, useAssetTone } from '../lib/assetTone';

// 品牌色板（REQ-EDIT-005）：26 个 token 色键的色块表，逐键标出「派生 / 品牌」，可就地改一个键、可整份清空。
// 色块底色是数据（用户的品牌色），只能走 inline style；工具自己的外壳仍然只用 token 类。
export function PaletteSection({ tokens, palette, colorMode, savedColorMode, onChange }: {
  tokens: Tokens; palette: Palette | null; colorMode: ColorMode; savedColorMode: ColorMode;
  onChange: (next: { palette: Palette | null; colorMode: ColorMode }) => void;
}) {
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">色板来源</span>
        <div className="flex items-center gap-2">
          {palette?.dark && (
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="色板模式" data-testid="palette-mode">
              {(['light', 'dark'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={colorMode === m} data-testid={`palette-mode-${m}`}
                  onClick={() => onChange({ palette, colorMode: m })}
                  className={`rounded px-2 py-0.5 text-[11px] ${colorMode === m ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}>{m === 'light' ? '亮' : '暗'}</button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="palette-toggle"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            {overridden ? `品牌色板 · ${overridden} 键覆盖` : '种子派生'}{open ? ' ▴' : ' ▾'}
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
                <li key={key} className="flex items-center gap-1.5 rounded-md border border-line px-1.5 py-1" data-token={key} data-source={isBrand ? 'brand' : 'derived'}>
                  <label className="relative size-5 shrink-0 cursor-pointer rounded-sm border border-line" style={{ background: value }}>
                    <span className="sr-only">改 {kebab(key)} 的颜色</span>
                    <input type="color" value={value} onChange={(e) => setKey(key, e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
                  </label>
                  {/* 名字与色值分两行：并排放在窄面板里会把色值截断，而色值才是这里要看的东西 */}
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className={`block truncate text-[11px] ${isBrand ? 'text-fg' : 'text-muted'}`} title={kebab(key)}>{kebab(key)}</span>
                    <span className="block font-mono text-[10px] text-muted">{stale ? '保存后按新模式派生' : value}</span>
                  </span>
                  {isBrand && (
                    <button type="button" aria-label={`把 ${kebab(key)} 退回种子派生`} onClick={() => dropKey(key)}
                      className="shrink-0 rounded px-1 text-[11px] text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-accent">×</button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">改过的键标为品牌色，其余仍由种子派生</span>
            <Button size="sm" disabled={!overridden} data-testid="palette-clear" onClick={() => onChange({ palette: null, colorMode: 'light' })}>清空品牌色板</Button>
          </div>
        </>
      )}
    </div>
  );
}

// 素材瓦片：底色按该图亮度选，读不出就棋盘格。
// 展示用 <img> 不加 crossOrigin：那会把普通图片请求升级成 CORS 请求，而 /a/ 的 ACAO 是常量 webOrigin，
// 页面 origin 不等于它（127.0.0.1、局域网地址）时整张图加载失败——标志本身不显示，比棋盘格更糟。
// 取像素判亮度的那个离屏 Image 自带 crossOrigin，读不出来本就回落棋盘格（assetTone.ts）
export function AssetTile({ asset, className }: { asset: AssetDto; className?: string }) {
  const tone = useAssetTone(asset.url);
  return <img src={asset.url} alt="" width={40} height={40} loading="lazy" className={`${toneClass(tone)} object-contain ${className ?? ''}`} />;
}

// 项目素材（REQ-CORE-019）：上传 / 复制引用地址 / 删除；清单随每次生成进 prompt。
// 列表来自项目详情（与风格指南卡片同一份），增删后让父组件重取，避免两处各刷各的
export function AssetsSection({ projectId, items, onChanged }: { projectId: string; items: AssetDto[]; onChanged: () => void }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AssetDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const tooBig = list.find((f) => f.size > MAX_ASSET_BYTES);
    if (tooBig) { toast(`「${tooBig.name}」超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB，压缩后再传`, 'error'); return; }
    setUploading(true);
    try {
      for (const f of list) await api.assets.upload(projectId, f);
      toast(list.length === 1 ? `已上传「${list[0].name}」` : `已上传 ${list.length} 个素材`);
      onChanged();
    } catch (e) {
      const detail = e instanceof ApiError ? (e.problem.errors as { message?: string }[] | undefined)?.[0]?.message : undefined;
      toast(e instanceof ApiError && e.type === '/errors/validation' ? (detail ?? '这个文件不符合素材要求') : '上传失败', 'error');
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  // 拖入上传：与「上传」按钮同一条路径（点按仍是键盘可达的等价入口）。
  // dragover 不 preventDefault 这块就不是合法放置目标，浏览器会拿文件自己去导航
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDropping(false);
    const files = [...e.dataTransfer.files];
    const ok = files.filter((f) => (ASSET_MEDIA_TYPES as readonly string[]).includes(f.type));
    if (ok.length < files.length) toast(`有 ${files.length - ok.length} 个文件不是 SVG / PNG / JPEG / WebP，已跳过`, 'error');
    void upload(ok);
  };

  return (
    <div className={`space-y-1.5 border-t pt-3 ${dropping ? 'border-accent outline-2 outline-dashed outline-accent outline-offset-2' : 'border-line'}`}
      data-testid="assets-panel" data-dropping={dropping ? '' : undefined} onDrop={onDrop}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}>
      <div className="flex items-center justify-between gap-2">
        {/* 拖入提示占用标题本来的位置：另起一行会把下面的列表整块推走 */}
        <span className={`text-xs font-medium ${dropping ? 'text-accent-strong' : 'text-muted'}`}>{dropping ? '松手上传到这个项目' : <>素材（生成时可被 &lt;img&gt; 引用）</>}</span>
        <Button size="sm" pending={uploading} disabled={uploading} data-testid="asset-upload" onClick={() => fileRef.current?.click()}>
          <Upload size={14} aria-hidden="true" />上传
        </Button>
      </div>
      {/* 选文件与拖入两条路必须认同一份类型清单，否则拖进来的文件被前端放过、到服务端才被拒 */}
      <input ref={fileRef} type="file" multiple accept={ASSET_MEDIA_TYPES.join(',')} className="sr-only"
        onChange={(e) => { if (e.target.files) void upload(e.target.files); }} />
      {items.length === 0 ? (
        <p className="text-xs text-muted">还没有素材。把 logo、插图、模板拖进这块区域或点「上传」，生成的屏就能直接用真图，而不是拿色块占位。</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="asset-list">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-md border border-line p-1.5" data-testid="asset-item" data-name={a.name}>
              {/* 素材长宽不可控：固定方槽 + contain，logo 不能被裁（VIS-006 / PERF-003） */}
              <AssetTile asset={a} className="size-10 shrink-0 rounded-sm p-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-fg" title={a.name}>{a.name}</span>
                <span className="block truncate text-[11px] text-muted">{a.mediaType.replace('image/', '').replace('+xml', '')} · {a.width && a.height ? `${a.width}×${a.height} · ` : ''}{Math.max(1, Math.round(a.bytes / 1024))} KB</span>
              </span>
              <button type="button" aria-label={`复制「${a.name}」的引用地址`} data-testid="asset-copy"
                onClick={() => { void navigator.clipboard.writeText(a.url).then(() => toast('引用地址已复制'), () => toast('复制失败', 'error')); }}
                className="shrink-0 rounded-md p-1 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><Copy size={14} aria-hidden="true" /></button>
              <button type="button" aria-label={`删除素材「${a.name}」`} data-testid="asset-delete" onClick={() => setPendingDelete(a)}
                className="shrink-0 rounded-md p-1 text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {pendingDelete && (
        <ConfirmDialog title={`删除素材「${pendingDelete.name}」？`}
          body="已经用到它的屏会变成裂图——那些屏是历史快照，不会自动改回去。"
          confirmLabel="删除" onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            try { await api.assets.remove(pendingDelete.id); toast('素材已删除'); onChanged(); }
            catch { toast('删除失败', 'error'); }
            finally { setPendingDelete(null); }
          }} />
      )}
    </div>
  );
}
