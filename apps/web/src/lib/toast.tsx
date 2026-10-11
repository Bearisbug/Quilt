import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

// 提示条（PAGE-CANVAS「提示条」，v1.04）：信息 3.2 s、错误 8 s 后消失；悬停时不计时，移开重新计时；
// 错误与带动作的可手动关。动作只有一个（例如「撤销（⌘Z）」），点了就收起
export type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; kind: 'info' | 'error'; action?: ToastAction };
type Push = (text: string, kind?: Toast['kind'], opts?: { action?: ToastAction }) => void;
const Ctx = createContext<Push>(() => {});
const LIFE = { info: 3200, error: 8000 } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback<Push>((text, kind = 'info', opts) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, text, kind, action: opts?.action }]);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* 画布页的输入框在底部正中：底边让到它上方、落在这一列底下的对话记录折叠横条也让开（--toast-bottom 由画布页写在 <html> 上，见 useComposerChrome），单条限宽、长文案换行 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[var(--toast-bottom,1.5rem)] z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => <ToastItem key={t.id} toast={t} onDismiss={dismiss} />)}
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hover, setHover] = useState(false);
  // 计时挂在悬停状态上：悬停时清掉，移开后按整段寿命重新算
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(() => onDismiss(t.id), LIFE[t.kind]);
    return () => clearTimeout(timer);
  }, [hover, t.id, t.kind, onDismiss]);
  // 只有错误与带动作的接指针（悬停暂停、可点）；普通信息条不挡底下画布的点击
  const closable = t.kind === 'error' || !!t.action;
  return (
    <div data-testid="toast" data-kind={t.kind} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={`fade-up ${closable ? 'pointer-events-auto' : ''} flex max-w-[28rem] items-start gap-2 rounded-md border bg-panel px-3.5 py-2 text-sm leading-relaxed text-fg [overflow-wrap:anywhere] shadow-lg ${t.kind === 'error' ? 'border-danger' : 'border-line'}`}>
      <span className="min-w-0 flex-1">{t.text}</span>
      {t.action && (
        <button type="button" data-testid="toast-action" onClick={() => { t.action!.run(); onDismiss(t.id); }}
          className="shrink-0 rounded px-1 font-medium text-accent-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent">{t.action.label}</button>
      )}
      {closable && (
        <button type="button" aria-label="关闭提示" onClick={() => onDismiss(t.id)} className="-mr-1 mt-0.5 shrink-0 rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export const useToast = () => useContext(Ctx);
