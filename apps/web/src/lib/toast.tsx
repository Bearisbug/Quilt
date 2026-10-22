import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { useT } from '@/i18n';
import libMessages from '@/i18n/locales/shellLib';
import { recordEvent } from '@/lib/recorder';

// 提示条（PAGE-CANVAS「提示条」，v1.04）：信息 3.2 s、错误 8 s 后消失；悬停时不计时，移开重新计时；
// 错误与带动作的可手动关。动作只有一个（例如「撤销（⌘Z）」），点了就收起
type ToastAction = { label: string; run: () => void };
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
    recordEvent('toast', undefined, { text, kind, ...(opts?.action ? { action: opts.action.label } : null) });
    setItems((xs) => [...xs, { id, text, kind, action: opts?.action }]);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      {/* 输入框（或收起后的胶囊）停在底边时底边让到它与上方作业 chip 的上方、停在左右边时距底 1.5rem（--toast-bottom 由画布页与草稿本页写在 <html> 上，见 useComposerDock / useComposerChrome），单条限宽、长文案换行 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[var(--toast-bottom,1.5rem)] z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => <ToastItem key={t.id} toast={t} onDismiss={dismiss} />)}
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const tl = useT(libMessages);
  const [hover, setHover] = useState(false);
  // 计时挂在悬停状态上：悬停时清掉，移开后按整段寿命重新算
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(() => onDismiss(t.id), LIFE[t.kind]);
    return () => clearTimeout(timer);
  }, [hover, t.id, t.kind, onDismiss]);
  // 只有错误与带动作的接指针（悬停暂停、可点）；普通信息条不挡底下画布的点击
  const closable = t.kind === 'error' || !!t.action;
  // 悬停开始用 onMouseOver，不能用 onMouseEnter：指针原先所在的元素被移除时（点了「删除元素」，按钮随检查器清空消失），Chrome 只补发
  // mouseover、不发 mouseout，React 的 onMouseEnter 是按 mouseout 合成的，于是一直不触发，提示条在指针下照常到点消失（TC-EDIT-034）
  // 信息条是反色实底（§13.1）；错误条换成弹层底 + 错误色细框 + 警示图标——错误色压在反色底上对比度不够，也不能只靠颜色区分
  const error = t.kind === 'error';
  return (
    <div data-testid="toast" data-kind={t.kind} onMouseOver={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={`fade-up ${closable ? 'pointer-events-auto' : ''} flex max-w-[28rem] items-start gap-2 rounded-md px-3.5 py-2 type-body [overflow-wrap:anywhere] shadow-(--semantic-elevation-overlay) ${error ? 'border border-error bg-surface-overlay text-text-primary' : 'inverse'}`}>
      {error && <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-error" />}
      <span className="min-w-0 flex-1">{t.text}</span>
      {t.action && (
        <button type="button" data-testid="toast-action" onClick={() => { t.action!.run(); onDismiss(t.id); }}
          className={`state-layer focus-ring shrink-0 rounded-sm px-1 font-medium underline underline-offset-2 ${error ? 'text-primary' : ''}`}>{t.action.label}</button>
      )}
      {closable && (
        <button type="button" aria-label={tl('toast.dismiss')} onClick={() => onDismiss(t.id)} className={`state-layer focus-ring -mr-1 mt-0.5 shrink-0 rounded-sm ${error ? 'text-text-secondary' : ''}`}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export const useToast = () => useContext(Ctx);
