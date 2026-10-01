import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; kind: 'info' | 'error' };
const Ctx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 3200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* 画布页的输入框在底部正中：底边让到它上方、落在这一列底下的对话记录折叠横条也让开（--toast-bottom 由画布页写在 <html> 上，见 useComposerChrome），单条限宽、长文案换行 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[var(--toast-bottom,1.5rem)] z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`fade-up max-w-[28rem] rounded-md border px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] shadow-lg ${t.kind === 'error' ? 'border-danger bg-panel text-fg' : 'border-line bg-panel text-fg'}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
