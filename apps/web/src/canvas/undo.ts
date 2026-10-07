import { useRef } from 'react';
import type { useToast } from '@/lib/toast';

// 画布撤销栈（⌘Z）：位置改动（v0.41）与检查器的直改（v0.95）共用一个栈、按时间先后撤，至多 20 步。
// 每一步自带撤法并自己出 toast，返回 keep 时（暂时撤不了，比如屏正忙）这一步留在栈顶，下次再撤
export type UndoStep = { label: string; run: () => Promise<'done' | 'keep' | 'drop'> };

export function useUndoStack(toast: ReturnType<typeof useToast>) {
  const stack = useRef<UndoStep[]>([]);
  const push = (step: UndoStep) => { stack.current = [...stack.current.slice(-19), step]; };
  const undo = async () => {
    const last = stack.current.pop();
    if (!last) { toast('没有可撤销的操作'); return; }
    if ((await last.run()) === 'keep') stack.current.push(last);
  };
  return { push, undo };
}
