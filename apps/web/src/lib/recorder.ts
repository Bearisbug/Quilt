// 本机使用记录的浏览器端（REQ-CORE-047，ADR-035，API-CORE-051）：开着时采集界面操作与输入，攒批写进本机库。
// 设置「系统」里改开关后调 setRecordingEnabled；各处没有点击的结束点（镜头停下、拖完、作业出现与结束……）调 recordEvent。
// 采集是文档上的被动监听（不逐个组件埋点，不听指针移动与滚动）；取名、截断、去签名与缓冲规则在 recordRules.ts。
// 记录本身的任何失败都不打断用户操作、不在界面上报错：发不出去的留在缓冲里下次再发
import type { PreviewToParent, RecordEventType } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import {
  BATCH_SIZE, EDITABLE, FLUSH_MS, INPUT_IDLE_MS, KEEPALIVE_BYTES, SEND_MAX, SWITCH_POLL_MS, RecordQueue, buildEvent, clickable, describeChange,
  describeClick, describePreview, fieldValue, keyCombo, optionOf, placeOf, recordOff, retryable, targetName, textField,
} from '@/lib/recordRules';

// 每打开一次页面一个会话（§9 record_events.session_id），seq 在 queue 里从 1 递增
const sessionId = crypto.randomUUID();
const queue = new RecordQueue();
let enabled = false;
// 开关每变一次加一：在途的重取与发送回来时开关已经变过，就不再按它们改状态（设置里刚打开时，之前发出的重取回来说「关」不算数；
// 关掉之后回来的失败批次不放回缓冲）
let epoch = 0;
let flushTimer = 0;
let sending = false;
let lastSwitchCheck = 0;
let lastPath = '';
// 上一批发失败的时刻：之后 FLUSH_MS 内攒满也不立即再发，等定时器——连不上时每多一次点击就打一次失败的请求
let failedAt = 0;

function push(type: RecordEventType, target?: string, data?: Record<string, unknown>) {
  const { event, bytes } = buildEvent(queue.nextSeq(), new Date().toISOString(), placeOf(location.pathname, location.search), type, target, data);
  queue.push({ event, bytes });
  if (queue.size >= BATCH_SIZE && Date.now() - failedAt >= FLUSH_MS) void flush();
  else if (!flushTimer) flushTimer = window.setTimeout(() => void flush(), FLUSH_MS);
}

/** keepalive：页面隐藏或关闭时发，浏览器在页面没了之后照样送出（只发 64 KB 以内的一批，剩下的留到下次可见时） */
async function flush(keepalive = false) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  if (!enabled || !queue.size) return;
  const at = epoch;
  if (keepalive) {
    const batch = queue.take(SEND_MAX, KEEPALIVE_BYTES);
    api.recordEvents(sessionId, batch, true).catch((e) => { if (at === epoch && retryable(e instanceof ApiError ? e.status : null)) queue.restore(batch); });
    return;
  }
  if (sending) return;   // 在途那一轮发完会接着发
  sending = true;
  try {
    while (enabled && at === epoch && queue.size) {
      const batch = queue.take(SEND_MAX);
      try { await api.recordEvents(sessionId, batch); failedAt = 0; }
      catch (e) { failedAt = Date.now(); if (at === epoch && retryable(e instanceof ApiError ? e.status : null)) queue.restore(batch); break; }
    }
  } finally {
    sending = false;
    if (enabled && queue.size && !flushTimer) flushTimer = window.setTimeout(() => void flush(), FLUSH_MS);
  }
}

// ── 文本框快照：停 1.5 s、失焦、点按钮或按 Enter 之前各记一次，内容没变不重复记 ──────────────
let pendingField: Element | null = null;
let idleTimer = 0;
const lastValue = new WeakMap<Element, string>();
// 上次快照之后打字时出现过与快照不同的内容：发送后输入框被程序清空（不发 input 事件）、再打一遍同样的话，也要再记一次
const strayed = new WeakSet<Element>();
function snapshot() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  const el = pendingField;
  pendingField = null;
  if (!el || !enabled) return;
  const value = fieldValue(el);
  if (lastValue.get(el) === value && !strayed.has(el)) return;
  lastValue.set(el, value);
  strayed.delete(el);
  push('input', targetName(el), { value });
}
const onInput = (e: Event) => {
  const el = textField(e.target);
  if (!el || recordOff(el)) return;
  if (pendingField && pendingField !== el) snapshot();
  if (lastValue.has(el) && lastValue.get(el) !== fieldValue(el)) strayed.add(el);
  pendingField = el;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(snapshot, INPUT_IDLE_MS);
};
const onFocusOut = (e: FocusEvent) => { if (pendingField && e.target === pendingField) snapshot(); };

// ── 点击、取值与按键 ──────────────────────────────────────────────────────
// 选项在 pointerup 上记过一次（Radix Select 用鼠标时只有 pointerup），紧跟着的那次 click 不再记
let lastOption: { el: Element; at: number } | null = null;
const recordOption = (el: Element) => {
  if (recordOff(el)) return;
  if (lastOption?.el === el && performance.now() - lastOption.at < 1000) return;
  lastOption = { el, at: performance.now() };
  const d = describeClick(el);
  if (d) push(d.type, d.target, d.data);
};
const onClick = (e: MouseEvent) => {
  snapshot();
  const el = clickable(e.target);
  if (!el || recordOff(el)) return;
  if (el.getAttribute('role') === 'option') { recordOption(el); return; }
  const d = describeClick(el);
  if (d) push(d.type, d.target, d.data);
};
const onPointerUp = (e: PointerEvent) => { if (e.pointerType === 'mouse' && e.button === 0) { const el = optionOf(e.target); if (el) recordOption(el); } };
const onChange = (e: Event) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el || recordOff(el)) return;
  const d = describeChange(el);
  if (d) push(d.type, d.target, d.data);
};
const onKeyDown = (e: KeyboardEvent) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el && recordOff(el)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) snapshot();
  const combo = keyCombo(e, !!el?.closest(EDITABLE));
  if (combo) push('key', el && el !== document.body && el !== document.documentElement ? targetName(el) : undefined, combo);
  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { const opt = optionOf(el); if (opt) recordOption(opt); }
};
const onHide = () => { snapshot(); void flush(true); };
const onVisibility = () => {
  if (document.visibilityState === 'hidden') onHide();
  else if (Date.now() - lastSwitchCheck >= SWITCH_POLL_MS) checkSwitch();
};

const LISTENERS: [string, EventListener][] = [
  ['click', onClick as EventListener], ['pointerup', onPointerUp as EventListener], ['keydown', onKeyDown as EventListener],
  ['input', onInput], ['focusout', onFocusOut as EventListener], ['change', onChange],
];
const listenOpts = { capture: true, passive: true } as const;

/** 地址变了（进入页面、换路由或查询参数）：记一条 view */
export function noteLocation() {
  const path = location.pathname + location.search;
  if (!enabled || path === lastPath) return;
  const from = lastPath;
  lastPath = path;
  push('view', undefined, from ? { from } : undefined);
}

/** 设置里改了开关的那个标签页当场开始或停止（API-CORE-050）；关掉时丢掉缓冲里还没发出去的 */
export function setRecordingEnabled(on: boolean): void {
  if (on === enabled) return;
  epoch++;
  enabled = on;
  if (on) {
    for (const [type, fn] of LISTENERS) document.addEventListener(type, fn, listenOpts);
    lastPath = '';
    noteLocation();
    return;
  }
  for (const [type, fn] of LISTENERS) document.removeEventListener(type, fn, listenOpts);
  queue.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  pendingField = null;
  lastOption = null;
}

/**
 * 记一条没有点击的结束点（ADR-035：镜头停下、拖完、选中变化、作业出现与结束、提示条、预览消息、参考图）。开关关着时什么也不做。
 * data 里带 screenId 的，提到事件的 screenId 字段上
 */
export function recordEvent(type: RecordEventType, target?: string, data?: Record<string, unknown>): void {
  if (enabled) push(type, target, data);
}

/** 屏与草稿 iframe 发来的消息（形状已校验）：点选、跳转等记 preview，转发来的快捷键记 key；ctx 是消息出自哪一屏或哪个组件 */
export function recordPreview(m: PreviewToParent, ctx?: { screenId?: string | null; componentId?: string | null }): void {
  if (!enabled) return;
  const d = describePreview(m);
  if (d) push(d.type, d.target, { ...d.data, ...(ctx?.screenId ? { screenId: ctx.screenId } : null), ...(ctx?.componentId ? { componentId: ctx.componentId } : null) });
}

// 画布选中变化：同一组选中不重复记（StrictMode 下 effect 跑两遍、详情刷新时数组换了新引用）
let lastSelection = '';
export function recordSelection(screenIds: readonly string[], componentIds: readonly string[]): void {
  const key = `${screenIds.join(',')}|${componentIds.join(',')}`;
  if (key === lastSelection) return;
  lastSelection = key;
  recordEvent('select', undefined, { screenIds: [...screenIds], componentIds: [...componentIds] });
}

// 开关在服务端（users.record_usage）：启动时取一次，之后每 60 s、以及切回前台时离上次已满 60 s 再取（COMP-009：按绝对时刻判，后台节流漏掉的不累积）
function checkSwitch() {
  lastSwitchCheck = Date.now();
  const at = epoch;
  api.recordingSwitch().then((r) => { if (at === epoch) setRecordingEnabled(r.enabled); }, () => { /* 连不上就维持现状，下一轮再取 */ });
}

let started = false;
/** 页面启动时调一次（main.tsx） */
export function startRecorder(): void {
  if (started) return;
  started = true;
  checkSwitch();
  window.setInterval(checkSwitch, SWITCH_POLL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
}
