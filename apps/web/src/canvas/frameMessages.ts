import type { ElementPathItem, PreviewToParent } from '@quilt/core/browser';

// 聚焦屏与交互态组件卡跑同一套预览运行时（ADR-003），两类 iframe 发来的选中与按键按同一套规则处理（v1.07 从 CanvasView.tsx 抽出）
export type ElementSelection = { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; rect: { x: number; y: number; w: number; h: number }; path?: ElementPathItem[] };

/** quilt:select → 检查器要的选中信息 */
export const toSelection = (m: Extract<PreviewToParent, { type: 'quilt:select' }>): ElementSelection =>
  ({ qid: m.qid, tag: m.tag, text: m.text, classes: m.classes, href: m.href, component: m.component, rect: m.rect, path: m.path });

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
