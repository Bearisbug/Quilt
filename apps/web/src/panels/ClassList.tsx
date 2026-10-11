import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { COLOR_CLASS_NAMES, type Tokens } from '@quilt/core/browser';
import { Select } from '@/ui/Select';
import { IconButton } from '@/ui/ui';
import { explainClass, splitClasses, stepClass, withColorToken } from '@/lib/twClass';

// 检查器的类名：一行一个（v0.96 PAGE-CANVAS「类名编辑」）。每个类上面是可改的类名与 ‹ › ×，紧跟着下面一句说明（本项目的实际取值）
// 与颜色类的 token 色下拉；× 删一行，末尾一行回车加入。说明不要并排放在类名右边：检查器只有约 300px 宽，并排时类名一栏只剩约 90px，常见类名都会被截断。
// 行用序号做 key：输入框都是受控的、没有自己的状态，按内容做 key 的话每敲一个字输入框就重挂、焦点丢掉。
// ‹ › 的位置常驻（RESP-010）：边打字边在「能换档 / 不能换档」之间变，按钮一出一没右列就变宽变窄，正在打字的输入框跟着横跳
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function ClassList({ rows, onChange, tokens, labelledBy }: { rows: string[]; onChange: (rows: string[]) => void; tokens?: Tokens; labelledBy: string }) {
  const [adding, setAdding] = useState('');
  const ctx = { tokens, column: rows.includes('flex-col') };
  const set = (i: number, v: string) => onChange(rows.map((r, j) => (j === i ? v : r)));
  // 失焦时收拾这一行：打了空格的拆成多行，清空的去掉
  const tidy = (i: number) => {
    const parts = splitClasses(rows[i] ?? '');
    if (parts.length === 1 && parts[0] === rows[i]) return;
    onChange([...rows.slice(0, i), ...parts, ...rows.slice(i + 1)]);
  };
  const colorOptions = COLOR_CLASS_NAMES.map((name) => {
    const hex = tokens?.colors[camel(name) as keyof Tokens['colors']];
    return { value: name, label: name, icon: <span className="size-3 shrink-0 rounded-sm border border-line" style={{ background: hex }} aria-hidden="true" /> };
  });
  return (
    <div role="group" aria-labelledby={labelledBy} className="space-y-1" data-testid="class-list">
      {rows.map((cls, i) => {
        const info = explainClass(cls, ctx);
        const down = stepClass(cls, -1, ctx);
        const up = stepClass(cls, 1, ctx);
        const steppable = down !== null || up !== null;
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1" data-testid="class-row" data-class={cls}>
            <input value={cls} onChange={(e) => set(i, e.target.value)} onBlur={() => tidy(i)} aria-label={`类名 ${i + 1}`} spellCheck={false}
              className="h-7 w-full rounded-md border border-line bg-canvas px-1.5 font-mono text-xs" />
            <div className="flex items-center">
              {steppable ? (<>
                <IconButton size="2xs" tip="none" label={`第 ${i + 1} 行调小一档`} unavailable={down === null && '已到最小一档'} onClick={() => down && set(i, down)} data-testid="class-down"><ChevronLeft size={14} aria-hidden="true" /></IconButton>
                <IconButton size="2xs" tip="none" label={`第 ${i + 1} 行调大一档`} unavailable={up === null && '已到最大一档'} onClick={() => up && set(i, up)} data-testid="class-up"><ChevronRight size={14} aria-hidden="true" /></IconButton>
              </>) : <span className="w-12" aria-hidden="true" />}
              <IconButton size="2xs" tip="none" label={`删掉 ${cls || `第 ${i + 1} 行`}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} data-testid="class-remove"><X size={14} aria-hidden="true" /></IconButton>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pb-1.5 pt-0.5">
              <p className={`text-xs leading-snug [overflow-wrap:anywhere] ${info.known ? 'text-muted' : 'text-muted/70'}`} data-testid="class-desc">
                {info.color?.swatch && !info.color.token && <span className="mr-1 inline-block size-2.5 rounded-sm border border-line align-middle" style={{ background: info.color.swatch }} aria-hidden="true" />}
                {info.text}
              </p>
              {info.color && (
                <div className="w-44">
                  <Select value={info.color.token ?? ''} onChange={(token) => token && set(i, withColorToken(cls, info.color!.prefix, token))} options={colorOptions}
                    placeholder="换成 token 色" aria-label={`第 ${i + 1} 行换色`} data-testid="class-color" className="h-7 px-1.5 text-xs" />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="添加类名…（回车加入）" aria-label="添加类名" spellCheck={false} data-testid="class-add"
        onKeyDown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); const parts = splitClasses(adding); if (parts.length) onChange([...rows, ...parts]); setAdding(''); }}
        className="h-7 w-full rounded-md border border-dashed border-line bg-transparent px-1.5 font-mono text-xs" />
    </div>
  );
}
