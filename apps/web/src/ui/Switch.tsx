import { Switch as RxSwitch } from 'radix-ui';
import { cn } from '@/ui/ui';

// 开关（brand/DESIGN.md「控件形态」）：38 × 22 胶囊，关是正文色 16% 的底、开是苹果蓝；白色圆钮带 raised 投影。
// 圆钮的移动走 emphasized 曲线（屏上已有元素的移动），减弱动态时直接到位。
// 保存中不用原生 disabled（会把焦点甩到 body，A11Y-013）：调用方传 busy，点击由调用方忽略
export function Switch({ id, checked, onCheckedChange, busy, className, ...rest }: { id?: string; checked: boolean; onCheckedChange: (on: boolean) => void; busy?: boolean; className?: string; 'aria-describedby'?: string; 'data-testid'?: string }) {
  return (
    <RxSwitch.Root
      id={id} checked={checked} onCheckedChange={onCheckedChange} aria-busy={busy || undefined}
      className={cn('focus-ring relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-pill bg-[color-mix(in_srgb,var(--semantic-color-text-primary)_16%,transparent)] transition-colors duration-(--semantic-motion-duration-fast) data-[state=checked]:bg-(--semantic-color-action-link)', className)}
      {...rest}
    >
      <RxSwitch.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-(--primitive-color-neutral-0) shadow-(--semantic-elevation-raised) transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-emphasized) data-[state=checked]:translate-x-[18px] motion-reduce:transition-none" />
    </RxSwitch.Root>
  );
}
