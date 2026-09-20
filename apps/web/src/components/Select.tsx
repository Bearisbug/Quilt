import { Select as RxSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './ui';

// 表单下拉（shadcn 的 Select 同一底座：Radix Select）。
// 原生 <select> 的选项列表由操作系统渲染，暗色主题下在部分平台会画成系统亮色面板、也接不了图标与分组说明；
// 这个组件让列表进我们自己的 .menu 材质，键盘导航 / 焦点归还 / 定位仍由 Radix 负责。
// 触发器的外观与 Input 对齐（h-9、圆角、同一焦点环），放进 <Field> 里不用再调。

export type SelectOption = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean };

export function Select({ id, value, onChange, options, placeholder, disabled, className, 'aria-label': ariaLabel, 'data-testid': testId, ...rest }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <RxSelect.Root value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <RxSelect.Trigger
        id={id} aria-label={ariaLabel} data-testid={testId} data-value={value}
        className={cn(
          'group flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2.5 text-sm text-fg',
          'transition-colors duration-[var(--duration-fast)] hover:border-line-strong',
          'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1',
          'data-[state=open]:border-line-strong disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-danger',
          className,
        )}
        {...rest}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {current?.icon}
          <RxSelect.Value placeholder={<span className="text-muted">{placeholder ?? '请选择'}</span>} />
        </span>
        <RxSelect.Icon className="flex shrink-0 text-muted transition-transform duration-[var(--duration-base)] ease-out group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </RxSelect.Icon>
      </RxSelect.Trigger>
      <RxSelect.Portal>
        <RxSelect.Content
          position="popper" sideOffset={6} collisionPadding={12}
          // 在弹层里用时，Esc / 方向键归下拉自己，不冒泡给外层弹层或画布快捷键
          onKeyDown={(e) => e.stopPropagation()}
          className="menu z-50 max-h-[min(20rem,60vh)] min-w-[var(--radix-select-trigger-width)] max-w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-1.5"
        >
          <RxSelect.Viewport>
            {options.map((o) => (
              <RxSelect.Item
                key={o.value} value={o.value} disabled={o.disabled} textValue={o.label}
                className="relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=checked]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
              >
                {o.icon}
                <span className="min-w-0 flex-1">
                  <RxSelect.ItemText>{o.label}</RxSelect.ItemText>
                  {o.hint && <span className="mt-0.5 block truncate text-[11px] text-muted">{o.hint}</span>}
                </span>
                <RxSelect.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></RxSelect.ItemIndicator>
              </RxSelect.Item>
            ))}
          </RxSelect.Viewport>
        </RxSelect.Content>
      </RxSelect.Portal>
    </RxSelect.Root>
  );
}
