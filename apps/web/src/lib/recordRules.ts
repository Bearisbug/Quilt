// 本机使用记录的纯规则（REQ-CORE-047，§9 record_events.*，INV-CORE-006）：元素取名、去掉签名、截断、事件成形与缓冲。
// 监听、计时与发送在 recorder.ts；这里不碰全局 document / window，单测直接喂元素与事件
import { RECORD_EVENT_MAX_BYTES, recordSafe, type PreviewToParent, type RecordEventInput, type RecordEventType } from '@quilt/core/browser';

/** 攒满这么多条就发（API-CORE-051） */
export const BATCH_SIZE = 50;
/** 没攒满时最迟这么久发一次 */
export const FLUSH_MS = 5000;
/** 缓冲上限，再多丢最旧的 */
export const BUFFER_MAX = 2000;
/** 一批最多这么多条（服务端 1–200） */
export const SEND_MAX = 200;
/** 文本框停手这么久记一次快照 */
export const INPUT_IDLE_MS = 1500;
/** 开关多久重取一次（API-CORE-050：别的标签页 60 s 内停下） */
export const SWITCH_POLL_MS = 60_000;
/** keepalive 请求体合计不能超过 64 KB，留点余量 */
export const KEEPALIVE_BYTES = 60 * 1024;

const NAME_TEXT = 40;
const TARGET_MAX = 200;
const PATH_MAX = 2000;
// 与 zod 的 z.uuid() 同一口径：版本位 1–8、变体位 8–b。不合格的 id 进批次会让整批 400，宁可不带
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

// ── 不记的（INV-CORE-006）────────────────────────────────────────────────
/** 密码框与 [data-record="off"] 里的一切都不记：点击、按键、输入、取值 */
export const recordOff = (el: Element): boolean => !!el.closest('[data-record="off"], input[type="password"]');

/** 带签名的查询参数（sig / exp / 预览 token t / S3 预签名）只把值换成 -，与服务端同一份规则（core recordSafe），其余参数原样 */
export const stripSigned = (s: string): string => recordSafe(s, Infinity) as string;

/** data 里的字符串：先去签名，再过与服务端同一份的 recordSafe（超过 2000 字换成它的长度，§9 record_events.data）；undefined 丢掉，过深的层级截断 */
export function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return recordSafe(stripSigned(v));
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'object' || depth >= 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) { const y = sanitize(x, depth + 1); if (y !== undefined) out[k] = y; }
  return out;
}

// ── 取名（§9 record_events.target）──────────────────────────────────────
const CLICKABLE = 'button, a[href], summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], input[type="button"], input[type="submit"], input[type="reset"]';
/** 这几种角色按下去是改取值：记成 change，不记 click */
const VALUE_ROLES = new Set(['tab', 'menuitemradio', 'menuitemcheckbox', 'option', 'switch', 'checkbox', 'radio']);
const TOGGLE_ROLES = new Set(['switch', 'checkbox', 'menuitemcheckbox']);
/** 与画布快捷键同一口径：焦点在这些里面时是在打字 */
export const EDITABLE = 'input, textarea, select, [contenteditable]';
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number']);
// 取可见文字时跳过的子树：textarea 的子文本是 React 写进去的初始值（用户的字），不是界面文字
const SKIP_TEXT = 'textarea, script, style, template, [data-record="off"]';

const asElement = (t: EventTarget | null): Element | null => {
  const n = t as (Node & { parentElement?: Element | null }) | null;
  if (!n || typeof n !== 'object' || !('nodeType' in n)) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement ?? null;
};

/** 元素里前 n 个可见字：逐个文本节点走，攒够就停，不把整棵子树的 textContent 拼出来 */
function leadingText(el: Element, n: number): string {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let out = '';
  for (let node = walker.nextNode(); node && out.length < n * 4; node = walker.nextNode()) {
    if (node.parentElement?.closest(SKIP_TEXT)) continue;
    out += node.textContent ?? '';
  }
  return [...out.replace(/\s+/g, ' ').trim()].slice(0, n).join('');
}

const clipTarget = (s: string) => [...s].slice(0, TARGET_MAX).join('');

/** 文本框、下拉、单选这类表单控件的「可见文字」是它的标签或占位，绝不取它的值 */
function fieldText(el: Element): string {
  const doc = el.ownerDocument;
  const id = el.getAttribute('id');
  const label = el.closest('label') ?? (id ? [...doc.querySelectorAll('label[for]')].find((l) => l.getAttribute('for') === id) : null);
  if (label) { const t = leadingText(label, NAME_TEXT); if (t) return t; }
  return [...(el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '')].slice(0, NAME_TEXT).join('');
}

/** data-testid > aria-label > 「标签名:可见文字前 40 字」 */
export function targetName(el: Element): string {
  const testId = el.getAttribute('data-testid')?.trim();
  if (testId) return clipTarget(testId);
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return clipTarget(aria);
  const tag = el.tagName.toLowerCase();
  return clipTarget(`${tag}:${el.matches('input, textarea, select') ? fieldText(el) : leadingText(el, NAME_TEXT)}`);
}

/** 点到的是哪个可点元素；没有就是 null（点在空白处、文本框里） */
export const clickable = (t: EventTarget | null): Element | null => asElement(t)?.closest(CLICKABLE) ?? null;

/** 包着复选框 / 单选框（或 for 指向它们）的 label：取值由那个框的 change 记，label 的点击不另记 */
function labelsToggle(el: Element): boolean {
  if (el.tagName !== 'LABEL') return false;
  const f = el.getAttribute('for');
  const control = f ? el.ownerDocument.getElementById(f) : el.querySelector('input');
  return !!control && control.matches('input[type="checkbox"], input[type="radio"]');
}

type Described = { type: RecordEventType; target: string; data?: Record<string, unknown> };
const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

/**
 * 一次点击记成什么：可改取值的角色（开关、复选、单选、选项、tab）记 change，开关类带按下之后的值（按下前取反——
 * 捕获阶段读到的还是旧值）；其余记 click，链接带 href。点在禁用的控件上照样记一条，带 disabled（用户点了没反应也是信息）
 */
export function describeClick(el: Element): Described | null {
  if (labelsToggle(el)) return null;
  const target = targetName(el);
  if (disabled(el)) return { type: 'click', target, data: { disabled: true } };
  const role = el.getAttribute('role');
  if (role && VALUE_ROLES.has(role)) return { type: 'change', target, data: TOGGLE_ROLES.has(role) ? { role, checked: el.getAttribute('aria-checked') !== 'true' } : { role } };
  const href = el.tagName === 'A' ? el.getAttribute('href') : null;
  return { type: 'click', target, data: href ? { href } : undefined };
}

/** 选项（Radix Select 用鼠标时在 pointerup 上选中、不发 click）：pointerup 与键盘选中走这里 */
export const optionOf = (t: EventTarget | null): Element | null => asElement(t)?.closest('[role="option"]') ?? null;

/** 原生 change：下拉、单选、复选、滑块这类控件的取值；文本框与 textarea 由 input 快照记，这里不记 */
export function describeChange(t: EventTarget | null): Described | null {
  const el = asElement(t);
  if (!el || disabled(el)) return null;
  const target = targetName(el);
  if (el.tagName === 'SELECT') { const s = el as HTMLSelectElement; return { type: 'change', target, data: s.multiple ? { values: [...s.selectedOptions].map((o) => o.value) } : { value: s.value } }; }
  if (el.tagName !== 'INPUT') return null;
  const i = el as HTMLInputElement;
  const type = (i.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'checkbox') return { type: 'change', target, data: { checked: i.checked } };
  if (type === 'radio') return { type: 'change', target, data: { name: i.name, value: i.value } };
  // 文件框只是选图的入口：参考图的加删与上传结果由输入框记 attach
  if (TEXT_TYPES.has(type) || type === 'hidden' || type === 'password' || type === 'file') return null;
  return { type: 'change', target, data: { value: i.value } };
}

/** 要记全文快照的文本框：textarea、文本类 input、contenteditable 的编辑根 */
export function textField(t: EventTarget | null): Element | null {
  const el = asElement(t);
  if (!el) return null;
  if (el.tagName === 'TEXTAREA') return el;
  if (el.tagName === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase()) ? el : null;
  const host = el.closest('[contenteditable]');
  return host && host.getAttribute('contenteditable') !== 'false' ? host : null;
}
export const fieldValue = (el: Element): string => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el as HTMLInputElement).value : el.textContent ?? '');

// ── 快捷键（type=key）──────────────────────────────────────────────────
type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean; isComposing?: boolean };
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph']);
const modsOf = (e: KeyLike) => [e.metaKey && 'meta', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean).join('+');

/**
 * 哪些按键记成 key：焦点不在可编辑元素上时每个键都是命令（画布的 F、L、Delete、方向键……），都记；在打字时只记带 ⌘ / Ctrl 的组合、
 * Esc 与 Enter（发送、提交）——⌥ + 字母在 macOS 文本框里是在打特殊字符，Shift + 字母是大写，都不算。长按的重复、输入法组字不记
 */
export function keyCombo(e: KeyLike, editable: boolean): Record<string, unknown> | null {
  if (e.repeat || e.isComposing || MODIFIER_KEYS.has(e.key) || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return null;
  if (editable && !(e.metaKey || e.ctrlKey) && e.key !== 'Escape' && !(e.key === 'Enter' && !e.shiftKey)) return null;
  const mods = modsOf(e);
  return { key: e.key, ...(e.code ? { code: e.code } : null), ...(mods ? { mods } : null) };
}

// ── 预览 iframe 发来的消息（type=preview）───────────────────────────────
/** 屏与草稿里的点选、跳转、死链、关叠层记 preview；运行时转发来的键（Esc、⌘E……）记 key；尺寸、就绪、滚轮这类不记 */
export function describePreview(m: PreviewToParent): Described | null {
  switch (m.type) {
    case 'quilt:select': return { type: 'preview', target: 'select', data: { qid: m.qid, tag: m.tag, text: m.text, component: m.component, href: m.href } };
    case 'quilt:deselect': return { type: 'preview', target: 'deselect', data: { qid: m.qid } };
    case 'quilt:navigate': return { type: 'preview', target: 'navigate', data: { href: m.href } };
    case 'quilt:dead': return { type: 'preview', target: 'dead' };
    case 'quilt:overlay-dismiss': return { type: 'preview', target: 'overlay-dismiss' };
    case 'quilt:key': { const d = keyCombo({ key: m.key, code: m.code, metaKey: !!m.metaKey, ctrlKey: !!m.ctrlKey, altKey: m.altKey, shiftKey: false }, false); return d && { type: 'key', target: 'preview', data: d }; }
    default: return null;
  }
}

// ── 页面与事件成形 ──────────────────────────────────────────────────────
export type Place = { page: string; path: string; projectId?: string; screenId?: string };
/** 页面名、路径与查询（去签名）、地址里的项目 id；草稿本的 ?d= 是正打开的那张草稿 */
export function placeOf(pathname: string, search: string): Place {
  const p = pathname.match(/^\/p\/([^/]+)/);
  const page = p ? 'canvas' : pathname === '/sketch' ? 'sketch' : pathname === '/' ? 'first' : 'other';
  const d = page === 'sketch' ? new URLSearchParams(search).get('d') : null;
  return { page, path: stripSigned(pathname + search).slice(0, PATH_MAX), projectId: isUuid(p?.[1]) ? p[1] : undefined, screenId: isUuid(d) ? d : undefined };
}

const utf8 = new TextEncoder();
const bytesOf = (e: RecordEventInput) => utf8.encode(JSON.stringify(e)).length;

/**
 * 拼一条事件：data 里的 screenId 提到顶层（合格的 uuid 才提），字符串去签名、超长只记长度；
 * 整条序列化后超过 16 KB（服务端会整批 400）时 data 只留字节数
 */
export function buildEvent(seq: number, at: string, place: Place, type: RecordEventType, target?: string, data?: Record<string, unknown>): { event: RecordEventInput; bytes: number } {
  let screenId = place.screenId;
  let rest = data;
  if (data && 'screenId' in data) { const { screenId: s, ...others } = data; if (isUuid(s)) screenId = s; rest = others; }
  const clean = rest ? (sanitize(rest) as Record<string, unknown>) : undefined;
  const event: RecordEventInput = {
    seq, at, page: place.page, path: place.path, type,
    ...(target ? { target: clipTarget(stripSigned(target)) } : null),
    ...(place.projectId ? { projectId: place.projectId } : null),
    ...(screenId ? { screenId } : null),
    ...(clean && Object.keys(clean).length ? { data: clean } : null),
  };
  let bytes = bytesOf(event);
  if (bytes > RECORD_EVENT_MAX_BYTES && event.data) { event.data = { bytes }; bytes = bytesOf(event); }
  return { event, bytes };
}

// ── 缓冲 ────────────────────────────────────────────────────────────────
type Item = { event: RecordEventInput; bytes: number };
/**
 * 待发的事件：seq 在这个页面里从 1 递增（关掉再打开也接着编，不撞 (session_id, seq)）；超过上限丢最旧的。
 * take 取出一批去发，发失败的 restore 放回队首，下一轮按原来的顺序与编号再发——服务端按 (session_id, seq) 去重，重发不会写两遍
 */
export class RecordQueue {
  private items: Item[] = [];
  private seq = 0;
  constructor(private readonly cap = BUFFER_MAX) {}
  get size() { return this.items.length; }
  nextSeq() { return ++this.seq; }
  push(item: Item) { this.items.push(item); this.trim(); }
  /** 至多 max 条、合计至多 maxBytes 字节（至少一条） */
  take(max = SEND_MAX, maxBytes = Infinity): RecordEventInput[] {
    let n = 0; let bytes = 0;
    while (n < this.items.length && n < max && (n === 0 || bytes + this.items[n].bytes <= maxBytes)) bytes += this.items[n++].bytes;
    return this.items.splice(0, n).map((i) => i.event);
  }
  restore(batch: RecordEventInput[]) { this.items.unshift(...batch.map((event) => ({ event, bytes: bytesOf(event) }))); this.trim(); }
  clear() { this.items = []; }
  private trim() { if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap); }
}

/** 发送失败要不要留着再发：连不上、超时、限流与 5xx 留着；其余 4xx（格式不对、来源不对、接口不在）再发也一样，丢掉免得每 5 s 重撞一次 */
export const retryable = (status: number | null): boolean => status === null || status === 408 || status === 429 || status >= 500;
