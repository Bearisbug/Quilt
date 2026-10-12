import type { MarkPalette } from '@quilt/core/browser';
import { useSyncExternalStore } from 'react';

// 外观（REQ-CORE-039，§13.1）：<html data-theme> 是唯一权威源，只取 light / dark 或不设——不设 = 跟随系统，
// 由 brand/tokens.css 的 prefers-color-scheme 层接管（THEME-003）。选择记在 localStorage 的 quilt:theme，
// index.html 的内联脚本在首帧前按同一个键写回（INT-021），两处的键名与取值要一起改。
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'quilt:theme';

export function readThemePref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

export function setThemePref(pref: ThemePref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* 存不下就只对这次打开生效 */ }
  const apply = () => { const root = document.documentElement; if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref); };
  // 亮暗切换给一次短的整页交叉淡化，免得整屏亮度突跳（MOTION-004）；减少动态效果下直接换
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
  else apply();
}

const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');
const resolvedMode = (): 'light' | 'dark' => {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : darkQuery().matches ? 'dark' : 'light';
};
function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = darkQuery();
  mq.addEventListener('change', onChange);
  return () => { mo.disconnect(); mq.removeEventListener('change', onChange); };
}
/** 当前实际生效的模式。画在 <canvas> 上、发进预览 iframe 的颜色读的是 CSS 变量的快照，要以它为依赖在外观变化时重读（VIS-010） */
export const useResolvedMode = () => useSyncExternalStore(subscribe, resolvedMode);

/** 发进预览 iframe 的画布标记色（quilt:mode 的 marks，§13.1）：取当前外观的 tokens 变量，iframe 里没有外壳的样式表 */
export function markPalette(): MarkPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return { line: v('--semantic-color-mark-line'), onLine: v('--semantic-color-mark-on-line'), halo: v('--semantic-color-mark-halo'), success: v('--semantic-color-feedback-success') };
}
