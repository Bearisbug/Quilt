import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

// ---- 弹层基建：焦点陷阱 + 背景 inert + Esc 关闭 + 关闭归还焦点（A11Y-004 / A11Y-005）----
// 弹层可以叠（设置弹层里再开「添加通道」），所以背景隔离按层栈算：开一层就把 #root 与它下面所有层设成 inert，
// 关一层只放开新的最上层；栈空了才摘掉 #root 的 inert。#root 上的 data-modal-depth 记当前层数，方便调试与断言。
export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const layers: HTMLElement[] = [];
function pushLayer(layer: HTMLElement) {
  for (const l of layers) l.setAttribute('inert', '');
  layers.push(layer);
  const root = document.getElementById('root');
  root?.setAttribute('inert', '');
  root?.setAttribute('data-modal-depth', String(layers.length));
}
function popLayer(layer: HTMLElement) {
  const i = layers.lastIndexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  layers[layers.length - 1]?.removeAttribute('inert');
  const root = document.getElementById('root');
  if (layers.length === 0) { root?.removeAttribute('inert'); root?.removeAttribute('data-modal-depth'); }
  else root?.setAttribute('data-modal-depth', String(layers.length));
}
// 弹层挂在 body 下，键盘事件仍会冒泡到 window 上的画布快捷键（F 适配视图、Delete 删屏…）。
// 在 document 这一级截住来自弹层的按键：React 的处理器挂在 body、已经跑过，window 上的页面快捷键则收不到。
function isolateKeys(layer: HTMLElement) {
  const stop = (e: KeyboardEvent) => { if (layer.contains(e.target as Node)) e.stopPropagation(); };
  document.addEventListener('keydown', stop);
  return () => document.removeEventListener('keydown', stop);
}

export function useModal<T extends HTMLElement>(
  onClose: () => void,
  returnTo?: React.RefObject<HTMLElement | null>,
  fallback?: React.RefObject<HTMLElement | null>,
  opts: { initialFocus?: 'first' | 'self' } = {},
) {
  const ref = useRef<T>(null);
  // onClose 每次父组件重渲染都会换引用；用 ref 持有，陷阱只装一次，不然保存后列表刷新会把焦点甩回首字段
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const el = ref.current;
    const layer = el?.closest<HTMLElement>('[data-modal-layer]') ?? el;
    if (layer) pushLayer(layer);
    const unIsolate = layer ? isolateKeys(layer) : undefined;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((x) => x.offsetParent !== null);
    // 初始焦点：短弹层落第一个可聚焦项（首字段 / 「取消」）；长内容弹层落容器本身（tabIndex=-1），Tab 再进内容。
    // effect 跑的时候 DOM 已在，直接聚焦，不等下一帧
    if (opts.initialFocus === 'self') el?.focus();
    else { const f = focusables()[0]; (f ?? el)?.focus(); }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables(); if (!els.length) { e.preventDefault(); return; }
      const i = els.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); els[els.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === els.length - 1)) { e.preventDefault(); els[0].focus(); }
    };
    el?.addEventListener('keydown', onKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      unIsolate?.();
      // 先摘 inert 再归还焦点：inert 子树里的元素 focus() 会静默失败（A11Y-013）。
      // 归还目标可能已被卸载（刚删掉那一行的「删除」键），也可能还在但已禁用（保存成功后的「保存」键）——
      // 后者 focus() 同样静默失败，所以按「焦点真的落上去了没有」判断，而不是只看它还在不在文档里
      if (layer) popLayer(layer);
      const back = returnTo?.current;
      if (back?.isConnected) back.focus();
      if (document.activeElement !== back) fallback?.current?.focus();
    };
  }, []);
  return ref;
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return createPortal(
    <div data-modal-layer className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>,
    document.body,
  );
}

export function ConfirmDialog(p: { title: string; body: string; confirmLabel: string; returnTo?: React.RefObject<HTMLElement | null>; fallback?: React.RefObject<HTMLElement | null>; onCancel: () => void; onConfirm: () => void | Promise<void> }) {
  const ref = useModal<HTMLDivElement>(p.onCancel, p.returnTo, p.fallback);
  const [busy, setBusy] = useState(false);
  return (
    <Overlay onClose={p.onCancel}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="ch-del-title" tabIndex={-1} className="w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="ch-del-title" className="text-sm font-semibold">{p.title}</h2>
        <p className="mt-1 text-xs text-muted">{p.body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={p.onCancel}>取消</Button>
          <Button variant="danger" pending={busy} onClick={async () => { setBusy(true); try { await p.onConfirm(); } finally { setBusy(false); } }}>{p.confirmLabel}</Button>
        </div>
      </div>
    </Overlay>
  );
}
