import { parseHTML } from 'linkedom';

// 项目大纲（REQ-CORE-023 / ADR-018）：从屏的 body 确定性派生一份结构摘要，零 LLM。
// 聊天助手先看它决定该读哪张整屏——整屏 HTML 一张 20 KB，大纲一张 ≤ 40 行，几十屏也装得进一次调用。
const LANDMARKS = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'dialog', 'table']);
const LEAVES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'input', 'select', 'textarea', 'img', 'label']);
const SKIP = new Set(['script', 'style', 'svg', 'template']);
const LIST_ITEMS = 2;
const TEXT_MAX = 40;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = TEXT_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ownText = (el: Element) => squash(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join(' '));

function describe(el: Element, tag: string): string {
  const parts: string[] = [];
  // 叶子（链接 / 按钮 / 标题）常把文字包在 span 里：取整棵子树的文字；容器只取自己的文字，免得把整块内容抄一遍
  const text = ownText(el) || (LEAVES.has(tag) && tag !== 'img' && tag !== 'input' ? squash(el.textContent ?? '') : '');
  if (text) parts.push(`"${clip(text)}"`);
  const target = tag === 'a' ? el.getAttribute('href') : tag === 'form' ? el.getAttribute('action') : el.getAttribute('data-href');
  if (target) parts.push(`→ ${target}`);
  if (tag === 'img') parts.push(`alt="${clip(el.getAttribute('alt') ?? '', 30)}"`);
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const bits = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('placeholder')].filter(Boolean);
    if (bits.length) parts.push(`[${bits.join(' ')}]`);
  }
  const icon = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'i' && c.getAttribute('data-lucide'))?.getAttribute('data-lucide');
  if (icon) parts.push(`icon:${icon}`);
  // 共享组件实例（REQ-EDIT-006）：标出来，读大纲的人就知道这一块不归屏管
  const comp = el.getAttribute('data-component');
  if (comp) parts.push(`[shared component: ${comp}]`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** 每行 `<缩进>tag#qid "文字" → 去向`；根与其直接子元素、地标、标题、链接、按钮、表单控件、图片入选，列表只展开前 2 项 */
export function outlineBody(bodyHtml: string, maxLines = 40): string {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const lines: string[] = [];
  let overflow = 0;
  const push = (line: string) => { if (lines.length < maxLines) lines.push(line); else overflow += 1; };
  const indent = (depth: number) => '  '.repeat(Math.min(depth, 8));
  const walk = (el: Element, depth: number) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (depth <= 1 || LANDMARKS.has(tag) || LEAVES.has(tag)) push(`${indent(depth)}${tag}#${el.getAttribute('data-qid') ?? '?'}${describe(el, tag)}`);
    const children = Array.from(el.children);
    const list = tag === 'ul' || tag === 'ol';
    const shown = list ? children.slice(0, LIST_ITEMS) : children;
    for (const c of shown) walk(c, depth + 1);
    if (shown.length < children.length) push(`${indent(depth + 1)}… +${children.length - shown.length} more items`);
  };
  for (const root of Array.from(document.body.children)) walk(root, 0);
  if (overflow) lines.push(`… +${overflow} more elements (quilt.get_screen has the full HTML)`);
  return lines.join('\n');
}
