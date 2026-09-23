import { parseHTML } from 'linkedom';

// 服务端注入（ADR-001/007）：body 内每个元素打稳定 data-qid；拼 prelude 成完整文档。
export function injectQids(bodyHtml: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  let n = 0;
  for (const el of Array.from(document.body.querySelectorAll('*'))) { n += 1; el.setAttribute('data-qid', `q${n}`); }
  return document.body.innerHTML;
}

// 写入时对齐 qid（v0.65）：保留合法（q + 数字）且在文档里唯一的已有 qid，其余元素从现有最大号之后续编。
// agent 读屏 → 改几处 → 回写，没动的元素 qid 不变：连着几次 patch_screen 的锚点还对得上，挂在元素上的批注不会漂到别的元素。
// 重复出现的 qid（复制了一块带 qid 的结构）只有第一个保留。
export function reconcileQids(bodyHtml: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const els = Array.from(document.body.querySelectorAll('*'));
  const seen = new Set<string>();
  let max = 0;
  for (const el of els) {
    const q = el.getAttribute('data-qid');
    if (q && /^q\d+$/.test(q) && !seen.has(q)) { seen.add(q); max = Math.max(max, Number(q.slice(1))); }
    else el.removeAttribute('data-qid');
  }
  for (const el of els) if (!el.hasAttribute('data-qid')) { max += 1; el.setAttribute('data-qid', `q${max}`); }
  return document.body.innerHTML;
}

// body 两侧去空白：extractBody 取回的 innerHTML 自带上一次拼装时的换行，不去掉的话每回刷一次 body 就长两个空行
export function assembleDocument(bodyWithQids: string, prelude: string, title: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n${prelude}\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n${bodyWithQids.trim()}\n</body>\n</html>\n`;
}

// 从完整文档取回 body 内容（元素直改 / 子树替换时用）。
export function extractBody(documentHtml: string): string {
  const { document } = parseHTML(documentHtml);
  return document.body?.innerHTML ?? '';
}

// 子树替换（ADR-007）：按 qid 定位，用新 HTML 整段替换；新节点从现有最大 qid 之后编号，兄弟节点不变。
export function replaceSubtree(bodyHtml: string, qid: string, newHtml: string): { body: string; newQids: string[] } | null {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const target = document.querySelector(`[data-qid="${qid}"]`);
  if (!target) return null;
  let max = 0;
  for (const el of Array.from(document.body.querySelectorAll('[data-qid]'))) { const n = Number((el.getAttribute('data-qid') ?? '').slice(1)); if (n > max) max = n; }
  const holder = document.createElement('div');
  holder.innerHTML = newHtml;
  const nodes = Array.from(holder.children);
  if (nodes.length === 0) return null;
  const newQids: string[] = [];
  let first = true;
  for (const root of nodes) {
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      // 替换后的根沿用被替换元素的 qid：元素身份延续，检查器重选、屏内「已更新」标记、批注都按 qid 对得上
      if (first) { el.setAttribute('data-qid', qid); first = false; continue; }
      max += 1; const id = `q${max}`; el.setAttribute('data-qid', id); newQids.push(id);
    }
  }
  target.replaceWith(...nodes);
  return { body: document.body.innerHTML, newQids };
}

// detach（REQ-EDIT-006）：把元素所在的共享组件实例脱离共享——摘掉实例根的 data-component，这一屏里的这份从此归屏自己管
export type ElementOp = { type: 'text'; value: string } | { type: 'classes'; value: string } | { type: 'style'; value: string } | { type: 'link'; value: string | null } | { type: 'remove' } | { type: 'detach' };

// 导航属性按元素类型落位：<a> 用 href、<form> 用 action、其他元素用 data-href（运行时三者同劫持）
const navAttrOf = (el: Element): string => (el.tagName === 'A' ? 'href' : el.tagName === 'FORM' ? 'action' : 'data-href');

// 元素直改（REQ-EDIT-001）：确定性 DOM 变换，qid 保持稳定；返回 null 表示 qid 不存在。
export function applyElementOps(bodyHtml: string, qid: string, ops: ElementOp[]): string | null {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const el = document.querySelector(`[data-qid="${qid}"]`);
  if (!el) return null;
  for (const op of ops) {
    if (op.type === 'remove') { el.remove(); break; }
    if (op.type === 'detach') { el.closest('[data-component]')?.removeAttribute('data-component'); continue; }
    if (op.type === 'classes') el.setAttribute('class', op.value.trim());
    if (op.type === 'style') el.setAttribute('style', op.value);
    // 「不跳转」：<a> 保留 href="#"（点击给「未设计」提示，样式不变），其他元素去掉 data-href / action
    if (op.type === 'link') { if (op.value) el.setAttribute(navAttrOf(el), op.value); else if (el.tagName === 'A') el.setAttribute('href', '#'); else el.removeAttribute(navAttrOf(el)); }
    if (op.type === 'text') {
      const textNode = Array.from(el.childNodes).find((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      const before = (textNode?.textContent ?? (el.children.length === 0 ? el.textContent : '') ?? '').trim();
      if (textNode) textNode.textContent = op.value;
      else if (el.children.length === 0) el.textContent = op.value;
      else el.appendChild(document.createTextNode(op.value));
      syncAccessibleName(el, before, op.value.trim());
    }
  }
  return document.body.innerHTML;
}

/**
 * 改可见文案时把跟着它走的无障碍名一起改（v0.59）：`aria-label` / `title` 存在的理由就是替这段文字说话，
 * 只改可见的那一处，读屏念出来的与看到的就不是一回事了（实测把一条 tab 从「附近」改成「同城」后，
 * 同一条上的 `aria-label="附近"` 还是旧的）。
 *
 * **只在两者原本一致时联动**：`aria-label` 与旧文案逐字符相等才改。不相等说明作者刻意让它们不同
 * （图标按钮 `aria-label="关闭对话框"` 配可见的「×」是最常见的一种），这时一个字都不动。
 *
 * 找的范围是被改元素本身、加上最近的那层可交互 / 带语义的祖先及其子树——HeaderTabs 那种
 * `<label><input aria-label="附近"><span>附近</span></label>` 结构里，名字挂在兄弟节点上，
 * 只看自己会漏掉。范围到 label / a / button / [role] 就停，不会漫到整屏去改别人的。
 */
function syncAccessibleName(el: Element, before: string, after: string): void {
  if (!before || before === after) return;
  const scope = el.closest('label, a, button, [role]') ?? el;
  for (const node of [scope, ...Array.from(scope.querySelectorAll('*'))]) {
    for (const attr of ['aria-label', 'title']) {
      if ((node.getAttribute(attr) ?? '').trim() === before) node.setAttribute(attr, after);
    }
  }
}

export function describeElement(bodyHtml: string, qid: string): { tag: string; text: string; classes: string; href: string | null } | null {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const el = document.querySelector(`[data-qid="${qid}"]`);
  if (!el) return null;
  const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
  return { tag: el.tagName.toLowerCase(), text, classes: el.getAttribute('class') ?? '', href: el.getAttribute(navAttrOf(el)) };
}

export function stripFences(text: string): string {
  const m = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
