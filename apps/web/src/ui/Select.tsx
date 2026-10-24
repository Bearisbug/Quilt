import { Select as RxSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/ui/ui';
import { useT } from '@/i18n';
import uiMessages from '@/i18n/locales/shellUi';

// 表单下拉（shadcn 的 Select 同一底座：Radix Select）。
// 原生 <select> 的选项列表由操作系统渲染，暗色主题下在部分平台会画成系统亮色面板、也接不了图标与分组说明；
// 这个组件让列表进我们自己的 .menu 材质，键盘导航 / 焦点归还 / 定位仍由 Radix 负责。
// 触发器的外观与 Input 对齐（高 30、圆角、同一焦点环），放进 <Field> 里不用再调。

type SelectOption = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean };

export function Select({ id, value, onChange, options, placeholder, disabled, className, 'aria-label': ariaLabel, 'data-testid': testId }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  const t = useT(uiMessages);
  const current = options.find((o) => o.value === value);
  return (
    <RxSelect.Root value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <RxSelect.Trigger
        id={id} aria-label={ariaLabel} data-testid={testId} data-value={value}
        className={cn(
          'state-layer focus-ring fill group flex h-7.5 w-full items-center justify-between gap-2 rounded-md border border-transparent px-3 type-body text-text-primary',
          'disabled:cursor-not-allowed aria-invalid:border-error',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {current?.icon}
          <RxSelect.Value placeholder={<span className="text-(--semantic-color-text-tertiary)">{placeholder ?? t('selectPlaceholder')}</span>} />
        </span>
        <RxSelect.Icon className="flex shrink-0 text-text-secondary transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180">
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
                className="state-layer relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:text-text-primary data-[state=checked]:bg-(--semantic-color-surface-selected) data-[state=checked]:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-(--semantic-state-disabled-opacity)"
              >
                {o.icon}
                <span className="min-w-0 flex-1">
                  <RxSelect.ItemText>{o.label}</RxSelect.ItemText>
                  {o.hint && <span className="mt-0.5 block truncate type-caption text-text-secondary">{o.hint}</span>}
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
