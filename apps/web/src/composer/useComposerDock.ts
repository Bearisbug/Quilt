import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { recordEvent } from '@/lib/recorder';

/** 输入框停的边（PAGE-CANVAS「停靠与收起」v1.16）：不去顶边，顶边是项目切换器与草稿工具条 */
export type DockEdge = 'bottom' | 'left' | 'right';
/** Composer 量出来报给外壳的：正显示的那一个（输入框或收起后的胶囊）的宽高、叠在它上方的作业 chip 的高（含间隙，没有 chip 时为 0），与左右两条可用段的长度 */
export type DockMeasure = { w: number; h: number; stack: number; left: number; right: number };
/** 交给 Composer 的停靠接口：edge / at 是实际停的位置；onMove 在松手或按键之后提交一次；onToggle 是收起 / 展开；
 *  width 是拖边改出来的宽（px，null = 自动宽；窄视口恒为 null），onResize 在松手或按键之后提交一次（停在底边时连同保住对边的 at） */
export type ComposerDock = { edge: DockEdge; at: number; narrow: boolean; width: number | null; onMove: (edge: DockEdge, at: number) => void; onResize: (width: number | null, at?: number) => void; onToggle: () => void; onMeasure: (m: DockMeasure) => void };

type Prefs = { edge: DockEdge; at: number; collapsed: boolean; width: number | null };
const EDGES: readonly DockEdge[] = ['bottom', 'left', 'right'];
const DEFAULT: Prefs = { edge: 'bottom', at: 0.5, collapsed: false, width: null };
/** 拖边改宽的下限（px）：再窄工具条要折成三行以上；上限是可用宽，由样式表的 min() 管 */
export const COMPOSER_MIN_W = 384;
// 窄视口断点，与 styles.css 的 48rem 同一条：放不下侧停的卡片，只停底边
const NARROW = '(max-width: 48rem)';

// 读不出、不是这个形状、取值越界的一律回缺省（INT-021）
function read(key: string): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Prefs> | null;
    if (!v || !EDGES.includes(v.edge as DockEdge)) return DEFAULT;
    return { edge: v.edge as DockEdge, at: typeof v.at === 'number' && v.at >= 0 && v.at <= 1 ? v.at : 0.5, collapsed: v.collapsed === true,
      width: typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= COMPOSER_MIN_W ? Math.round(v.width) : null };
  } catch { return DEFAULT; }
}

// 输入框停在哪条边、沿边的位置（这条边可用段上的比例）、收没收起与拖边改的宽：按页面记在本机（画布 quilt:composer:canvas、草稿本 quilt:composer:sketch、
// 全屏视图 quilt:composer:fullview），首帧即记下的样子（惰性初值，INT-021）；只在松手、按键、点收起时写一次，不跟着拖动逐帧写。回到缺省的入口是把手的 ↓ / 菜单里的「底边」（INT-019）。
// 画布与全屏视图是同一个页面里的两个视图、共用一个输入框：换视图时在这次渲染里换成那一份记忆。
// 实际停的边由这里定：窄视口只停底边，侧边的可用段放不下就落到底边——两种都不改记忆。外壳的让位与 toast 落点按实际停的边与 Composer 量到的大小算
export function useComposerDock(page: 'canvas' | 'sketch' | 'fullview') {
  const key = `quilt:composer:${page}`;
  const [prefs, setPrefs] = useState(() => read(key));
  const [prefsKey, setPrefsKey] = useState(key);
  if (prefsKey !== key) { setPrefsKey(key); setPrefs(read(key)); }
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const save = (patch: Partial<Prefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 无痕模式写不了，只本次有效 */ }
  };
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const m = matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const [measure, setMeasure] = useState<DockMeasure | null>(null);
  const onMeasure = useCallback((next: DockMeasure) => setMeasure((v) => (v && Math.abs(v.w - next.w) < 1 && Math.abs(v.h - next.h) < 1 && Math.abs(v.stack - next.stack) < 1 && Math.abs(v.left - next.left) < 1 && Math.abs(v.right - next.right) < 1 ? v : next)), []);
  const want: DockEdge = narrow ? 'bottom' : prefs.edge;
  const edge: DockEdge = want !== 'bottom' && measure && measure[want] < measure.h ? 'bottom' : want;
  // 落回底边时停在正中，不沿用侧边上的比例
  const at = edge === prefs.edge ? prefs.at : 0.5;
  // 外壳上的让位（styles.css 的 [data-dock]）：停在底边时底部占位 = 实际高度 + 16 px 底距 + 16 px 间隙；停在侧边时那一侧让出卡片宽（--dock-span）
  const shellStyle: CSSProperties | undefined = !measure ? undefined
    : edge === 'bottom' ? ({ '--chrome-bottom': `${Math.round(measure.h) + 32}px` } as CSSProperties)
    : ({ '--dock-span': `${Math.round(measure.w)}px` } as CSSProperties);
  // toast：输入框或胶囊停在底边时浮在它上方（与 --chrome-bottom 同一数值），上方叠着作业 chip 时再让过这一叠；停在左右边时距底 1.5rem
  const toastBottom = edge === 'bottom' && measure ? Math.round(measure.h + measure.stack) + 32 : 24;
  return {
    prefs, narrow, edge, at, shellStyle, toastBottom, onMeasure, measure,
    width: narrow ? null : prefs.width,
    move: (to: DockEdge, toAt: number) => { recordEvent('drag', 'composer-dock', { page, edge: to, at: Math.round(toAt * 1000) / 1000 }); save({ edge: to, at: toAt }); },
    // 停在侧边、或侧边放不下落到底边时，at 是另一条边上的比例，不跟着改宽改
    resize: (w: number | null, toAt?: number) => {
      recordEvent('drag', 'composer-width', { page, width: w });
      save(toAt !== undefined && edge === 'bottom' && prefsRef.current.edge === 'bottom' ? { width: w, at: toAt } : { width: w });
    },
    setCollapsed: (collapsed: boolean) => save({ collapsed }),
  };
}
