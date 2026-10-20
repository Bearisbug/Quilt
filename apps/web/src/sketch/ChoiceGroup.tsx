import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/ui/ui';

// 草稿本里的分段单选（画框、落成屏还是组件，REQ-CORE-040 / REQ-CORE-041）：radiogroup 语义，方向键换项、Tab 只停在选中那一项；
// 外观是 iOS 分段控件（styles.css 的 .seg：填充轨道 + 选中项浮起的滑块，选中靠 aria-checked 标出）。每个选项带 data-value，测试按取值认；
// value 为 null（新草稿的画框还没定）时一项都不选
export function ChoiceGroup<T extends string>({ label, testId, value, options, onChange }: { label: string; testId: string; value: T | null; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = options.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (Math.max(0, idx) + delta + options.length) % options.length;
    onChange(options[next].value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${options[next].value}"]`)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} data-testid={testId} data-value={value ?? ''} className="seg h-8 shrink-0 items-center">
      {options.map((o, i) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={i === idx} tabIndex={i === Math.max(0, idx) ? 0 : -1} data-value={o.value}
          onClick={() => onChange(o.value)} onKeyDown={onKey}
          className={cn('h-7 min-w-7 whitespace-nowrap px-2.5 type-label focus-ring', i !== idx && 'state-layer')}
        >{o.label}</button>
      ))}
    </div>
  );
}
