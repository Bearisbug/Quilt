import { FONT_FAMILIES, type FontSource } from '@quilt/core';

export const FONTS = FONT_FAMILIES;
// 字体来源（v0.44）：族名是自由文本，两份候选只是输入框的 datalist 提示
export const SYSTEM_FONTS = ['-apple-system', 'PingFang SC', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei', 'system-ui'];
export const FONT_SOURCE_OPTIONS: { key: FontSource; label: string; hint: string }[] = [
  { key: 'google', label: 'Google', hint: '任意 Google Fonts 族名，预览与导出自动加载' },
  { key: 'system', label: '本机字体', hint: '用这台电脑装的字体，不发外链；换机器观感可能不同' },
  { key: 'url', label: '自定义链接', hint: '自托管或 CDN 上带 @font-face 的样式表' },
];
export const RADIUS: { key: 'sharp' | 'default' | 'round'; label: string; md: string }[] = [{ key: 'sharp', label: '锐利', md: '4px' }, { key: 'default', label: '默认', md: '12px' }, { key: 'round', label: '圆润', md: '18px' }];
