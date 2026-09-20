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
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`fade-up rounded-md border px-3.5 py-2 text-sm shadow-lg ${t.kind === 'error' ? 'border-danger bg-panel text-fg' : 'border-line bg-panel text-fg'}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
