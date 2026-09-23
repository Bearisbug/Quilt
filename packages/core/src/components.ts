import { parseHTML } from 'linkedom';
import { injectQids } from './inject.ts';

// 共享组件（REQ-EDIT-006 / ADR-019）：项目级的一段 HTML，屏里只放一个占位根元素（data-component="Name"），
// 每次写入屏时由这里确定性地展开成组件的正式 HTML——改组件一次，所有屏零 LLM 同步。
// 展开发生在注入阶段（qid 之前 / 回刷时保 qid），lint、大纲、截图、导出、MCP 看到的都是展开后的 DOM。
export type SharedComponent = { name: string; html: string; activeClass: string | null; inactiveClass: string | null };
/** 进提示词的卡：名字 + 一行结构摘要 + 占位写法；html 只在「与本次相关」时给全 */
export type SharedComponentCard = { name: string; summary: string; tag: string; slots: string[]; html?: string };

export const MAX_COMPONENT_HTML_BYTES = 64 * 1024;
export const MAX_COMPONENTS_PER_PROJECT = 30;
// 名字会进 data-component 属性值与提示词，不收引号、尖括号与反斜杠
export const COMPONENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;

const parse = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const tokens = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const maxQid = (root: Element) => Array.from(root.querySelectorAll('[data-qid]')).reduce((m, el) => Math.max(m, Number((el.getAttribute('data-qid') ?? '').slice(1)) || 0), 0);

/** 组件 HTML 的硬校验：恰好一个根元素、无 script / style、不套别的组件、不超体积 */
export function validateComponentHtml(html: string): { ok: true; tag: string } | { ok: false; error: string } {
  if (new TextEncoder().encode(html).length > MAX_COMPONENT_HTML_BYTES) return { ok: false, error: `组件 HTML 超过 ${MAX_COMPONENT_HTML_BYTES / 1024} KB` };
  const document = parse(html);
  const roots = Array.from(document.body.children);
  if (roots.length !== 1) return { ok: false, error: `组件必须恰好一个根元素，现在有 ${roots.length} 个` };
  if (document.body.querySelector('script, style')) return { ok: false, error: '组件里不能有 <script> 或 <style>：它会被复制进每一屏' };
  if (document.body.querySelector('[data-component]')) return { ok: false, error: '组件里不能再放别的共享组件' };
  return { ok: true, tag: roots[0].tagName.toLowerCase() };
}

/** 组件里声明的槽位（data-slot="name"），实例可按名填内容 */
export function componentSlots(html: string): string[] {
  return Array.from(new Set(Array.from(parse(html).body.querySelectorAll('[data-slot]')).map((el) => el.getAttribute('data-slot') ?? '').filter(Boolean)));
}

/** 屏里放这个组件的写法：占位根元素 + 槽位示例 */
export function componentPlacement(name: string, tag: string, slots: string[]): string {
  const inner = slots.map((s) => `<span data-slot="${s}">${s}</span>`).join('');
  return `<${tag} data-component="${name}">${inner}</${tag}>`;
}

/** 一行结构摘要，确定性、零 LLM：根标签 + 链接 / 按钮 / 输入 / 槽位 */
export function componentSummary(html: string): string {
  const document = parse(html);
  const root = document.body.firstElementChild;
  if (!root) return '(empty)';
  const parts: string[] = [root.tagName.toLowerCase()];
  const links = Array.from(root.querySelectorAll('a[href]')).map((a) => `${clip(squash(a.textContent ?? ''), 16) || '(icon)'}→${a.getAttribute('href')}`);
  if (links.length) parts.push(`links: ${links.slice(0, 6).join(', ')}${links.length > 6 ? ` +${links.length - 6}` : ''}`);
  const buttons = Array.from(root.querySelectorAll('button')).map((b) => clip(squash(b.textContent ?? ''), 16)).filter(Boolean);
  if (buttons.length) parts.push(`buttons: ${buttons.slice(0, 4).join(', ')}${buttons.length > 4 ? ` +${buttons.length - 4}` : ''}`);
  const inputs = root.querySelectorAll('input, select, textarea').length;
  if (inputs) parts.push(`${inputs} input${inputs > 1 ? 's' : ''}`);
  const heading = root.querySelector('h1, h2, h3');
  if (heading) parts.push(`heading: ${clip(squash(heading.textContent ?? ''), 24)}`);
  const slots = componentSlots(html);
  if (slots.length) parts.push(`slots: ${slots.join(', ')}`);
  return parts.join(' · ');
}

/** 屏 body 里引用了哪些共享组件（按实例根的 data-component） */
export function componentNamesIn(bodyHtml: string): string[] {
  return Array.from(new Set(Array.from(parse(bodyHtml).body.querySelectorAll('[data-component]')).map((el) => el.getAttribute('data-component') ?? '').filter(Boolean)));
}

/** qid 所在的共享组件实例（自身或祖先带 data-component）；不在任何组件里返回 null */
export function componentOf(bodyHtml: string, qid: string): { name: string; rootQid: string | null } | null {
  const el = parse(bodyHtml).querySelector(`[data-qid="${qid}"]`);
  const inst = el?.closest('[data-component]');
  if (!inst) return null;
  return { name: inst.getAttribute('data-component') ?? '', rootQid: inst.getAttribute('data-qid') };
}

// 激活态：按屏路由算，不用传参——href 等于当前屏路由的链接加上 activeClass、去掉 inactiveClass，其余反之；
// 同时同步 aria-current="page"。只对提取时能分出「激活 / 未激活」两套类的导航型组件生效
function applyActiveState(root: Element, route: string, comp: SharedComponent) {
  const act = tokens(comp.activeClass); const inact = tokens(comp.inactiveClass);
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const on = a.getAttribute('href') === route;
    const cls = new Set(tokens(a.getAttribute('class')));
    for (const t of on ? inact : act) cls.delete(t);
    for (const t of on ? act : inact) cls.add(t);
    a.setAttribute('class', [...cls].join(' '));
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/**
 * 展开：把 body 里每个 [data-component] 实例换成组件的正式 HTML。实例里 [data-slot] 的内容填进对应槽位；
 * 导航型组件按 route 算激活态；不认识的名字原样保留（已删组件的实例就此「脱离」）。
 * qid：实例根沿用原 qid（元素身份延续），新子树从现有最大 qid 之后编号；body 还没打 qid 时不打，交给之后的 injectQids。
 * rename：改名回刷时把旧名的实例当新名处理。不支持组件套组件（正式 HTML 里的 data-component 不再展开）。
 */
export function expandComponents(html: string, components: SharedComponent[], route: string, opts: { rename?: { from: string; to: string } } = {}): { html: string; used: string[] } {
  if (!components.length) return { html, used: [] };
  const byName = new Map(components.map((c) => [c.name, c]));
  const document = parse(html);
  const body = document.body;
  let max = maxQid(body);
  const used = new Set<string>();
  for (const inst of Array.from(body.querySelectorAll('[data-component]'))) {
    // 外层实例换掉后，快照里它的内层节点已脱离文档
    if (!inst.isConnected) continue;
    let name = inst.getAttribute('data-component') ?? '';
    if (opts.rename && name === opts.rename.from) name = opts.rename.to;
    const comp = byName.get(name);
    if (!comp) continue;
    const holder = document.createElement('div');
    holder.innerHTML = comp.html;
    const root = holder.firstElementChild;
    if (!root) continue;
    used.add(name);
    root.setAttribute('data-component', name);
    for (const slot of Array.from(root.querySelectorAll('[data-slot]'))) {
      const k = slot.getAttribute('data-slot') ?? '';
      const given = inst.querySelector(`[data-slot="${k}"]`);
      if (given) slot.innerHTML = given.innerHTML;
    }
    if (comp.activeClass !== null || comp.inactiveClass !== null) applyActiveState(root, route, comp);
    const rootQid = inst.getAttribute('data-qid');
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) el.removeAttribute('data-qid');
    if (rootQid) {
      root.setAttribute('data-qid', rootQid);
      for (const el of Array.from(root.querySelectorAll('*'))) { max += 1; el.setAttribute('data-qid', `q${max}`); }
    }
    inst.replaceWith(root);
  }
  return { html: body.innerHTML, used: [...used] };
}

/**
 * 写入时哪些共享组件实例的内容会被组件正式 HTML 盖掉（v0.65）：实例里除了 data-slot 之外还写了东西、且与展开结果不同。
 * 屏里的实例每次写入都会被组件重新展开，agent 改了副本不会报错、改动却静默消失——把名字报回去，让它改组件本身。
 * 只放了占位（或只填了槽位）、或原样抄回 get_screen 给的展开结果的实例不算。
 */
export function overwrittenInstances(bodyHtml: string, components: SharedComponent[], route: string): string[] {
  const byName = new Map(components.map((c) => [c.name, c]));
  const norm = (s: string) => s.replace(/\sdata-qid="[^"]*"/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  for (const inst of Array.from(parse(bodyHtml).body.querySelectorAll('[data-component]'))) {
    const name = inst.getAttribute('data-component') ?? '';
    if (!byName.has(name) || !inst.isConnected) continue;
    const onlySlots = Array.from(inst.children).every((c) => c.hasAttribute('data-slot')) && !Array.from(inst.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (onlySlots) continue;
    if (norm(expandComponents(inst.outerHTML, [byName.get(name)!], route).html) !== norm(inst.outerHTML)) out.add(name);
  }
  return [...out];
}

/**
 * 导航型组件的激活 / 未激活两套类：激活 = 带 aria-current 的链接（没有时按 route 找 href 相等的那条）；
 * 它独有的类是 activeClass、其余链接共有而它没有的是 inactiveClass；两边都空 = 认不出差异，按非导航型处理。
 * 顺手把激活项标上 aria-current，正式 HTML 里恒有一条。
 */
export function navClasses(root: Element, route?: string): { activeClass: string | null; inactiveClass: string | null } {
  const links = Array.from(root.querySelectorAll('a[href^="/"]'));
  const active = links.find((a) => a.getAttribute('aria-current') === 'page') ?? (route ? links.find((a) => a.getAttribute('href') === route) : undefined);
  if (!active || links.length < 2) return { activeClass: null, inactiveClass: null };
  const others = links.filter((a) => a !== active).map((a) => new Set(tokens(a.getAttribute('class'))));
  const common = [...others[0]].filter((t) => others.every((s) => s.has(t)));
  const own = new Set(tokens(active.getAttribute('class')));
  const act = [...own].filter((t) => !common.includes(t));
  const inact = common.filter((t) => !own.has(t));
  active.setAttribute('aria-current', 'page');
  return act.length || inact.length ? { activeClass: act.join(' '), inactiveClass: inact.join(' ') } : { activeClass: null, inactiveClass: null };
}
/** 独立组件 HTML（已校验单根）的导航型判定，改组件 / MCP 写入时用 */
export function classifyComponentHtml(html: string): { html: string; activeClass: string | null; inactiveClass: string | null } {
  // 落库前重编 qid（v0.57）：组件自己也要有可寻址的元素，否则画布上选中它里面的元素无从定位。
  // 这是组件 HTML 里的编号，与屏里的互不相干——展开进屏时 expandComponents 会整套剥掉、按那一屏重发。
  const document = parse(injectQids(html));
  const root = document.body.firstElementChild;
  if (!root) return { html, activeClass: null, inactiveClass: null };
  const r = navClasses(root);
  return { html: root.outerHTML, ...r };
}

export type Extracted = { html: string; tag: string; depth: number; classes: string; activeClass: string | null; inactiveClass: string | null };
/**
 * 从屏里提取一个元素做组件（REQ-EDIT-006「记为共享组件」）：去 qid 取 outerHTML；
 * 导航型（≥ 2 条 / 开头的链接）时分出激活 / 未激活两套类——激活 = 带 aria-current 或 href 等于本屏路由的那条，
 * 它独有的类是 activeClass、其余链接共有而它没有的是 inactiveClass；正式 HTML 里给它标上 aria-current。
 * 元素在别的组件里、或自己包着组件时不可提取。
 */
export function extractComponent(bodyHtml: string, qid: string, route: string, liveNames: string[]): Extracted | { error: string } {
  const document = parse(bodyHtml);
  const el = document.querySelector(`[data-qid="${qid}"]`);
  if (!el) return { error: '元素在当前修订中不存在' };
  // 只认还存在的组件：已删组件留在屏里的实例等于脱离，可以再提取
  const live = new Set(liveNames);
  const inLive = (x: Element | null) => !!x && live.has(x.getAttribute('data-component') ?? '');
  if (inLive(el.closest('[data-component]'))) return { error: '这个元素已经在一个共享组件里' };
  if (Array.from(el.querySelectorAll('[data-component]')).some((x) => inLive(x))) return { error: '这个元素里包着别的共享组件，不能再打包成组件' };
  for (const x of Array.from(el.querySelectorAll('[data-component]'))) x.removeAttribute('data-component');
  let depth = 0;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) depth += 1;
  const clone = el.cloneNode(true) as Element;
  for (const x of [clone, ...Array.from(clone.querySelectorAll('*'))]) x.removeAttribute('data-qid');
  const { activeClass, inactiveClass } = navClasses(clone, route);
  return { html: clone.outerHTML, tag: el.tagName.toLowerCase(), depth, classes: el.getAttribute('class') ?? '', activeClass, inactiveClass };
}

/**
 * 在另一屏里找「对应的元素」（提取后同步到其他屏）：同标签、同深度、不在组件里；
 * 唯一候选直接取，多个时按类名 Jaccard 相似度取最高且 ≥ 0.3。找不到返回 null（那一屏跳过、报出来）。
 */
export function findComponentMatch(bodyHtml: string, tag: string, depth: number, classes: string, liveNames: string[]): string | null {
  const document = parse(bodyHtml);
  const want = new Set(tokens(classes));
  const live = new Set(liveNames);
  const inLive = (x: Element | null) => !!x && live.has(x.getAttribute('data-component') ?? '');
  const cands: { qid: string; score: number }[] = [];
  for (const el of Array.from(document.body.querySelectorAll(tag))) {
    if (inLive(el.closest('[data-component]')) || Array.from(el.querySelectorAll('[data-component]')).some((x) => inLive(x))) continue;
    let d = 0;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) d += 1;
    if (d !== depth) continue;
    const qid = el.getAttribute('data-qid');
    if (!qid) continue;
    const have = new Set(tokens(el.getAttribute('class')));
    const inter = [...want].filter((t) => have.has(t)).length;
    const union = new Set([...want, ...have]).size;
    cands.push({ qid, score: union ? inter / union : 0 });
  }
  if (cands.length === 1) return cands[0].qid;
  const best = cands.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.3 ? best.qid : null;
}

/** 把 qid 那个元素换成组件占位（同步到其他屏时用）；返回新 body，元素不存在返回 null */
export function replaceWithPlaceholder(bodyHtml: string, qid: string, name: string, tag: string): string | null {
  const document = parse(bodyHtml);
  const el = document.querySelector(`[data-qid="${qid}"]`);
  if (!el) return null;
  const ph = document.createElement(tag);
  ph.setAttribute('data-component', name);
  ph.setAttribute('data-qid', qid);
  el.replaceWith(ph);
  return document.body.innerHTML;
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
