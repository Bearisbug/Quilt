import { argbFromHex, hexFromArgb, themeFromSourceColor, TonalPalette } from '@material/material-color-utilities';
import type { ColorMode, FontSource } from './schemas.ts';

// 设计系统 token（§9 `tokens`）：调色板由种子色按 Material HCT 算出，不由模型生成（ADR-005）。
export const TOKEN_COLOR_KEYS = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'success', 'onSuccess', 'warning', 'onWarning',
  'background', 'onBackground',
  'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant',
  'outline', 'outlineVariant',
] as const;
export type TokenColorKey = (typeof TOKEN_COLOR_KEYS)[number];

export type Tokens = {
  colors: Record<TokenColorKey, string>;
  radius: { sm: string; md: string; lg: string; full: string };
  spacing: { base: number };
  // fontSource / fontUrl 是 v0.44 加的，更早的行没有：读时缺省按 google（见 fonts.ts）
  typography: { fontFamily: string; fontSource?: FontSource; fontUrl?: string | null; scale: string[] };
};

// token 色的 RGB 三元组（v0.65）：Tailwind 的透明度修饰符（bg-primary/40）要靠 rgb(var(--x-rgb) / <alpha-value>) 才生效，
// 只给 var(--color-x) 时它会静默丢掉整个类
export const rgbTriplet = (hex: string): string => { const n = parseInt(hex.replace('#', '').slice(0, 6), 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`; };
/** :root 里的颜色变量：--color-x（原值）与 --color-x-rgb（三元组），prelude 与导出共用 */
export const colorVarsCss = (colors: Record<string, string>): string => Object.entries(colors).map(([k, v]) => `--color-${kebab(k)}:${v};--color-${kebab(k)}-rgb:${rgbTriplet(v)}`).join(';');

export const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
export const COLOR_CLASS_NAMES: string[] = TOKEN_COLOR_KEYS.map(kebab);

export const RADIUS_SCALES = {
  sharp: { sm: '2px', md: '4px', lg: '8px', full: '9999px' },
  default: { sm: '6px', md: '12px', lg: '20px', full: '9999px' },
  round: { sm: '10px', md: '18px', lg: '28px', full: '9999px' },
} as const;

// 语义色（v0.35 `REQ-EDIT-005`）：M3 方案只给 error，success / warning 在同一套 HCT 里按固定色相补齐。
// 色相固定，是为了「绿 = 成功、琥珀 = 警告」跨项目稳定；明度与 error/onError 同档（亮 40 / 100、暗 80 / 20）。
const SEMANTIC_HUES: Record<'success' | 'warning', number> = { success: 145, warning: 85 };
const SEMANTIC_TONES: Record<ColorMode, { color: number; on: number }> = { light: { color: 40, on: 100 }, dark: { color: 80, on: 20 } };
const semanticPair = (hue: number, mode: ColorMode) => {
  const p = TonalPalette.fromHueAndChroma(hue, 48);
  const t = SEMANTIC_TONES[mode];
  return { color: p.tone(t.color), on: p.tone(t.on) };
};

export function tokensFromSeed(
  seedColor: string,
  opts: { fontFamily?: string; fontSource?: FontSource; fontUrl?: string | null; radiusScale?: keyof typeof RADIUS_SCALES; palette?: Partial<Record<TokenColorKey, string>>; colorMode?: ColorMode } = {},
): Tokens {
  // 派生底座按模式取方案（`REQ-EDIT-005`「亮 / 暗各一套」）：色板只覆盖一部分键，底座固定用 light 时暗色模式下
  // 没覆盖的键就是亮色值——深底上冒出近白的 surface-variant，撞上浅色的 on-* 文字就读不出来
  const colorMode = opts.colorMode ?? 'light';
  const s = themeFromSourceColor(argbFromHex(seedColor)).schemes[colorMode];
  const success = semanticPair(SEMANTIC_HUES.success, colorMode);
  const warning = semanticPair(SEMANTIC_HUES.warning, colorMode);
  const colors = {
    primary: s.primary, onPrimary: s.onPrimary, primaryContainer: s.primaryContainer, onPrimaryContainer: s.onPrimaryContainer,
    secondary: s.secondary, onSecondary: s.onSecondary, secondaryContainer: s.secondaryContainer, onSecondaryContainer: s.onSecondaryContainer,
    tertiary: s.tertiary, onTertiary: s.onTertiary, tertiaryContainer: s.tertiaryContainer, onTertiaryContainer: s.onTertiaryContainer,
    error: s.error, onError: s.onError, success: success.color, onSuccess: success.on, warning: warning.color, onWarning: warning.on,
    background: s.background, onBackground: s.onBackground,
    surface: s.surface, onSurface: s.onSurface, surfaceVariant: s.surfaceVariant, onSurfaceVariant: s.onSurfaceVariant,
    outline: s.outline, outlineVariant: s.outlineVariant,
  } satisfies Record<TokenColorKey, number>;
  // 品牌色板逐键覆盖派生值（`REQ-EDIT-005`）：没给的键仍走种子派生，所以一份只写了 5 个键的品牌色板也是完整可用的 token
  const derived = Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, hexFromArgb(v)])) as Record<TokenColorKey, string>;
  return {
    colors: Object.fromEntries(TOKEN_COLOR_KEYS.map((k) => [k, opts.palette?.[k] ?? derived[k]])) as Record<TokenColorKey, string>,
    radius: { ...RADIUS_SCALES[opts.radiusScale ?? 'default'] },
    spacing: { base: 4 },
    typography: {
      fontFamily: opts.fontFamily ?? 'Inter', fontSource: opts.fontSource ?? 'google', fontUrl: opts.fontSource === 'url' ? (opts.fontUrl ?? null) : null,
      scale: ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl'],
    },
  };
}
