import { FONT_FAMILIES, type FontSource } from '@quilt/core/browser';

export const FONTS = FONT_FAMILIES;
// 字体来源（v0.44）：族名是自由文本，两份候选只是输入框的 datalist 提示
export const SYSTEM_FONTS = ['-apple-system', 'PingFang SC', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei', 'system-ui'];
// 名字与说明在 panels-design 命名空间的 options.fontSource.<key> / options.radius.<key>，渲染时再取
export const FONT_SOURCE_OPTIONS: FontSource[] = ['google', 'system', 'url'];
export const RADIUS: { key: 'sharp' | 'default' | 'round'; md: string }[] = [{ key: 'sharp', md: '4px' }, { key: 'default', md: '12px' }, { key: 'round', md: '18px' }];
// 色块的边（brand/DESIGN.md「表面与层级」不画外框）：正文色 10% 的内描边，白色块在浅底上看得出边，深色块上几乎看不见
export const SWATCH_EDGE = 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--semantic-color-text-primary)_10%,transparent)]';
