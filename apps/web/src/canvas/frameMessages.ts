import { MAX_SUBTREE_BLOCKS, type ElementPathItem, type PreviewToParent } from '@quilt/core/browser';

// 聚焦屏与交互态组件卡跑同一套预览运行时（ADR-003），两类 iframe 发来的选中与按键按同一套规则处理（v1.07 从 CanvasView.tsx 抽出）
export type ElementSelection = { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; path?: ElementPathItem[] };
export type SelectMessage = Extract<PreviewToParent, { type: 'quilt:select' }>;

/** quilt:select → 检查器要的选中信息 */
export const toSelection = (m: SelectMessage): ElementSelection =>
  ({ qid: m.qid, tag: m.tag, text: m.text, classes: m.classes, href: m.href, component: m.component, path: m.path });

// a 包住 b（同一块不算）：path 是屏根到锚点的链，选中的那一块一定在链上，它前面的都是它的祖先
const contains = (a: ElementSelection, b: ElementSelection) => {
  const chain = b.path?.map((p) => p.qid) ?? [];
  const at = chain.indexOf(b.qid);
  return a.qid !== b.qid && at > 0 && chain.slice(0, at).includes(a.qid);
};

/**
 * 选元素的多选（v1.26 REQ-EDIT-002，画布与草稿本同一套）：list 是选中的几块，最后一个是最后点中的那一块（逐级选、路径行作用于它）。
 * 不按 Shift 点 = 只选这一个；按着 Shift 点已选中的 = 去掉它，点别的 = 加上它——与已选的互相包含时只留外面那一块（note=merged），
 * 已满 MAX_SUBTREE_BLOCKS 块就不加（note=max）。replace = 逐级选 / 路径点选换掉那一块（换上来的包住了别的块同样只留外层），
 * 热更新重选原地刷新；要换的那块已不在选中里（重选的回话晚到）就不动
 */
export function applySelect(list: ElementSelection[], m: SelectMessage): { list: ElementSelection[]; note: 'merged' | 'max' | null } {
  const sel = toSelection(m);
  if (m.replace !== undefined) {
    const at = list.findIndex((s) => s.qid === m.replace);
    if (at < 0) return { list, note: null };
    const others = list.filter((_, i) => i !== at);
    const outer = others.find((s) => s.qid === sel.qid || contains(s, sel));
    if (outer) return { list: [...others.filter((s) => s !== outer), outer], note: 'merged' };
    const next = list.map((s, i) => (i === at ? sel : s)).filter((s, i) => i === at || !contains(sel, s));
    return { list: next, note: next.length < list.length ? 'merged' : null };
  }
  if (!m.additive) return { list: [sel], note: null };
  if (list.some((s) => s.qid === sel.qid)) return { list: list.filter((s) => s.qid !== sel.qid), note: null };
  if (list.some((s) => contains(s, sel))) return { list, note: 'merged' };
  const kept = list.filter((s) => !contains(sel, s));
  if (kept.length >= MAX_SUBTREE_BLOCKS) return { list, note: 'max' };
  return { list: [...kept, sel], note: kept.length < list.length ? 'merged' : null };
}

/**
 * 运行时转发来的键（焦点在 iframe 里时父页 window 收不到键盘）怎么处理：exit = Esc 退出交互；back = ⌥← 后退（只有屏有导航栈，
 * 组件卡上的 ⌥← 照「⌥ + 键」交给键位表）；shortcut = 交给父页的键位表（Canvas.tsx）——⌘ / Ctrl 组合按物理键 code，
 * ⌥ + 字母带 alt（v0.80），选择元素态的 Delete / Backspace 按 key（v0.95，运行时只在焦点不在输入框里时转发）
 */
type KeyAction = { kind: 'exit' } | { kind: 'back' } | { kind: 'shortcut'; code: string; alt?: true } | null;
export function keyAction(m: Extract<PreviewToParent, { type: 'quilt:key' }>, canGoBack: boolean): KeyAction {
  if (m.key === 'Escape') return { kind: 'exit' };
  if (canGoBack && m.key === 'ArrowLeft' && m.altKey) return { kind: 'back' };
  if ((m.metaKey || m.ctrlKey) && m.code) return { kind: 'shortcut', code: m.code };
  if (m.altKey && m.code) return { kind: 'shortcut', code: m.code, alt: true };
  if (m.key === 'Delete' || m.key === 'Backspace') return { kind: 'shortcut', code: m.key };
  return null;
}
