import type { AssetDto, ColorMode, Palette, Tokens } from '@quilt/core';
import { toneClass, useAssetTone } from '../lib/assetTone';

export const STYLE_GUIDE_SIZE = { w: 420, h: 640 };
// 有素材时卡片要长出一行来放它们；画布的适配视图按同一个函数算外接框，否则这一行会被框在视野外
export const ASSET_ROW_H = 86;
export const styleGuideSize = (assetCount: number) => ({ w: STYLE_GUIDE_SIZE.w, h: STYLE_GUIDE_SIZE.h + (assetCount ? ASSET_ROW_H : 0) });

// REQ-CORE-010：由 token 渲染的风格指南卡片（画布只读），颜色全部来自 tokens，永远同步。
// 品牌素材瓦片：底色按图的亮度选，白色标志才不会变成一块空白。
// 展示用 <img> 不加 crossOrigin：那会把普通图片请求升级成 CORS 请求，而 /a/ 的 ACAO 是常量 webOrigin，
// 页面 origin 不等于它（127.0.0.1、局域网地址）时整张图加载失败，标志在画布上直接看不见
function BrandTile({ asset, radius }: { asset: AssetDto; radius: string }) {
  const tone = useAssetTone(asset.url);
  return (
    <div className={`${toneClass(tone)} flex h-14 flex-1 items-center justify-center overflow-hidden p-2`} style={{ borderRadius: radius }} data-asset={asset.name}>
      <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export function StyleGuideCard({ tokens, name, palette, colorMode = 'light', assets = [] }: { tokens: Tokens; name: string; palette?: Palette | null; colorMode?: ColorMode; assets?: AssetDto[] }) {
  const c = tokens.colors;
  // 只数当前生效的那一套：tokens 就是它合并出来的，数两套加起来会报一个没人用得上的数
  const overrides = Object.keys(palette?.[colorMode] ?? {}).length;
  const size = styleGuideSize(assets.length);
  const swatches: [string, string, string][] = [
    ['primary', c.primary, c.onPrimary], ['primary-container', c.primaryContainer, c.onPrimaryContainer],
    ['secondary', c.secondary, c.onSecondary], ['secondary-container', c.secondaryContainer, c.onSecondaryContainer],
    ['tertiary', c.tertiary, c.onTertiary], ['error', c.error, c.onError],
    ['success', c.success, c.onSuccess], ['warning', c.warning, c.onWarning],
    ['surface', c.surface, c.onSurface], ['surface-variant', c.surfaceVariant, c.onSurfaceVariant],
  ];
  return (
    <div style={{ width: size.w, height: size.h, background: c.background, color: c.onBackground, fontFamily: `${tokens.typography.fontFamily}, system-ui, sans-serif` }} className="flex flex-col gap-4 overflow-hidden p-5 text-left" data-testid="style-guide">
      <div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{name} · Style guide</div>
        {/* 字体名要读项目自己的：写死成 Inter 会在项目换了字体之后报假信息 */}
        {/* 色板来源要写实话：挂了品牌色板还说「种子派生」就是在骗看卡片的人 */}
        <div style={{ fontSize: 12, color: c.onSurfaceVariant }}>{overrides ? `Brand palette · ${overrides} keys` : 'Seed-derived Material 3 palette'} · {tokens.typography.fontFamily}</div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {swatches.map(([k, bg, fg]) => (
          <div key={k} style={{ background: bg, color: fg, borderRadius: tokens.radius.md }} className="flex h-14 flex-col justify-end p-1.5" data-token={k} data-color={bg}>
            <span style={{ fontSize: 10, lineHeight: 1.2 }}>{k}</span>
            <span style={{ fontSize: 9, opacity: 0.8 }}>{bg}</span>
          </div>
        ))}
      </div>
      <div style={{ background: c.surface, border: `1px solid ${c.outlineVariant}`, borderRadius: tokens.radius.lg }} className="p-3">
        <div style={{ fontSize: 22, fontWeight: 700 }}>Headline text-2xl</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Section title text-base</div>
        <div style={{ fontSize: 14 }}>Body text-sm — realistic content, no lorem ipsum.</div>
        <div style={{ fontSize: 12, color: c.onSurfaceVariant }}>Caption text-xs on-surface-variant</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ background: c.primary, color: c.onPrimary, borderRadius: tokens.radius.full, fontSize: 13, fontWeight: 600 }} className="inline-flex h-10 items-center px-4">Primary button</span>
        <span style={{ border: `1px solid ${c.outline}`, color: c.primary, borderRadius: tokens.radius.full, fontSize: 13, fontWeight: 600 }} className="inline-flex h-10 items-center px-4">Secondary</span>
        <span style={{ background: c.secondaryContainer, color: c.onSecondaryContainer, borderRadius: tokens.radius.full, fontSize: 12 }} className="inline-flex h-7 items-center px-3">Chip</span>
      </div>
      <div style={{ background: c.surface, border: `1px solid ${c.outlineVariant}`, borderRadius: tokens.radius.lg }} className="flex items-center gap-3 p-3">
        <div style={{ background: c.surfaceVariant, borderRadius: tokens.radius.md }} className="h-12 w-12" />
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 500 }}>List item title</div>
          <div style={{ fontSize: 12, color: c.onSurfaceVariant }}>Supporting text · 2h ago</div>
        </div>
        <div style={{ background: c.surfaceVariant, borderRadius: tokens.radius.full }} className="h-2 w-24"><div style={{ background: c.primary, borderRadius: tokens.radius.full, width: '60%' }} className="h-2" /></div>
      </div>
      <div className="flex items-center gap-3" style={{ fontSize: 11, color: c.onSurfaceVariant }}>
        {Object.entries(tokens.radius).filter(([k]) => k !== 'full').map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5"><div style={{ width: 22, height: 22, border: `2px solid ${c.outline}`, borderRadius: v }} />radius-{k} {v}</div>
        ))}
      </div>
      {/* 品牌素材（REQ-CORE-019）：导进来的标志要在画布上看得见，否则跟没导一样 */}
      {assets.length > 0 && (
        <div className="mt-auto flex flex-col gap-1.5" data-testid="guide-assets">
          <div style={{ fontSize: 11, color: c.onSurfaceVariant }}>Brand assets · {assets.length}</div>
          <div className="flex items-stretch gap-2">
            {assets.slice(0, 4).map((a) => <BrandTile key={a.id} asset={a} radius={tokens.radius.md} />)}
          </div>
        </div>
      )}
    </div>
  );
}
