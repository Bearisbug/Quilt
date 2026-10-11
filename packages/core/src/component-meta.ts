// 共享组件里浏览器也要用的部分（PERF-3 v1.06）：名字规则、体积上限、占位写法与提示词里的组件段。不 import linkedom——
// 前端经 @quilt/core/browser 引用它，解析 HTML 的部分留在 components.ts（只在服务端用）
/** 进提示词的卡：名字 + 一行结构摘要 + 占位写法；html 只在「与本次相关」时给全 */
export type SharedComponentCard = { name: string; summary: string; tag: string; slots: string[]; html?: string };

export const MAX_COMPONENT_HTML_BYTES = 64 * 1024;
export const MAX_COMPONENTS_PER_PROJECT = 30;
// 名字会进 data-component 属性值与提示词，不收引号、尖括号与反斜杠
export const COMPONENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;

/** 屏里放这个组件的写法：占位根元素 + 槽位示例 */
export function componentPlacement(name: string, tag: string, slots: string[]): string {
  const inner = slots.map((s) => `<span data-slot="${s}">${s}</span>`).join('');
  return `<${tag} data-component="${name}">${inner}</${tag}>`;
}

/** 提示词里的共享组件段（ADR-012 稳定前缀的一节）：每个组件一张卡，相关的附完整 HTML */
export function sharedComponentsSection(cards: SharedComponentCard[]): string {
  if (!cards.length) return '';
  const lines = cards.map((c) => `  - ${c.name} — ${c.summary} · place with: ${componentPlacement(c.name, c.tag, c.slots)}`).join('\n');
  const full = cards.filter((c) => c.html);
  const fullText = full.length
    ? `\nFULL HTML of the shared components relevant to this request (layout reference only — still place them with the tag above, never paste this in):\n${full.map((c) => `--- ${c.name} ---\n${c.html}`).join('\n')}\n`
    : '';
  return `
SHARED COMPONENTS (project-level building blocks — Quilt fills in their HTML wherever you place them, and the designer edits them in ONE place):
${lines}
- Use a shared component wherever its role appears on a screen (a mobile main screen's bottom navigation IS the shared TabBar when one exists — never write your own). Emit exactly the placement tag, empty except for slot content. Never re-implement, restyle or add children to a shared component inside a screen: to change how one looks, the designer edits the component itself.
${fullText}`;
}
