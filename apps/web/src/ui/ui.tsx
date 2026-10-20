import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'danger-ghost'; size?: 'sm' | 'md'; pending?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'ghost', size = 'md', pending, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn(
        // 交互态只经状态层（brand/state-layer.css）：悬停、按下、禁用都不改底色，焦点环由 focus-ring 画（THEME-006）
        // 形态（brand/DESIGN.md「控件形态」）：主按钮与危险按钮是胶囊，次按钮是填充底、圆角 10、不描边；
        // 列表行里的删除 / 取消用 danger-ghost（次按钮形态 + 错误色字），成排出现时不抢眼，确认框里的危险动作才用实心红胶囊
        'state-layer focus-ring inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 type-label' : 'h-9 type-body',
        variant === 'ghost' || variant === 'danger-ghost' ? cn('fill rounded-md', variant === 'ghost' ? 'text-text-primary' : 'text-error', size === 'sm' ? 'px-3' : 'px-3.5') : cn('rounded-pill', size === 'sm' ? 'px-3.5' : 'px-4'),
        variant === 'primary' && 'bg-primary text-on-primary',
        variant === 'danger' && 'bg-error text-on-primary',
        className,
      )}
      {...rest}
    >
      {pending && <span className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

// 图标按钮：无障碍名走 aria-label、悬停提示只是补充（A11Y-010）。
// 悬停态挂在几何恒定的外层 span 上，动的只有提示子元素，按钮盒子一帧不变（INT-018）。
// 不可用时用 aria-disabled 而非原生 disabled：工具栏按钮要能被键盘发现、并在提示里说明为什么用不了（A11Y-007 / INT-013）。
// 尺寸：2xs 24px（列表行内的小按钮，点击区下限 A11Y-009）、xs 32px（面板角落的收起 / 关闭）、sm 40px（输入框的发送 / 取消）、md 44px（工具栏）。
// tone=invert 是反色实心钮，只给「此刻唯一的主动作」（发送 / 停止）用。active 是工具栏里开着的工具：一块淡灰底（.rail-on，状态层常驻按下那一档）、图标用主文字色。
type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  label: string; hint?: string; desc?: string; active?: boolean; tip?: 'left' | 'top' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end' | 'none'; unavailable?: string | false; size?: '2xs' | 'xs' | 'sm' | 'md'; tone?: 'default' | 'invert';
};
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, hint, desc, active, tip = 'left', unavailable, size = 'md', tone = 'default', className, children, onClick, ...rest }, ref) {
  return (
    <span className="group relative flex">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-disabled={unavailable ? true : undefined}
        onClick={(e) => { if (unavailable) { e.preventDefault(); return; } onClick?.(e); }}
        className={cn(
          'state-layer focus-ring grid place-items-center rounded-md transition-[scale] duration-(--semantic-motion-duration-fast) ease-(--semantic-motion-easing-standard) active:scale-[0.96] aria-disabled:cursor-not-allowed aria-disabled:active:scale-100',
          size === 'md' ? 'size-11' : size === 'sm' ? 'size-10' : size === 'xs' ? 'size-8' : 'size-6',
          active ? 'rail-on text-text-primary' : tone === 'invert' ? 'inverse' : 'text-text-secondary',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
      {/* tip="none"：调用方自己在滚动容器外面渲染提示（容器的 overflow 会把贴边提示整块裁掉） */}
      {tip !== 'none' && <span
        aria-hidden="true"
        className={cn(
          // 工具提示：反色实底（§13.1）
          'inverse pointer-events-none absolute z-10 rounded-md px-2.5 py-1.5 type-label opacity-0 shadow-(--semantic-elevation-overlay) transition-opacity duration-(--semantic-motion-duration-fast) group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
          desc ? 'w-52 text-left' : 'whitespace-nowrap',
          tip === 'left' && 'right-full top-1/2 mr-2 -translate-y-1/2',
          tip === 'top' && 'bottom-full left-1/2 mb-2 -translate-x-1/2',
          tip === 'bottom' && 'top-full left-1/2 mt-2 -translate-x-1/2',
          // 贴容器右缘展开：按钮在容器边上时，居中锚点会把提示顶出容器（实测撑出 59px）；贴左缘的按钮同理向右展开
          tip === 'top-end' && 'bottom-full right-0 mb-2',
          tip === 'bottom-end' && 'top-full right-0 mt-2',
          tip === 'bottom-start' && 'top-full left-0 mt-2',
        )}
      >
        <span className="flex items-baseline gap-1.5 whitespace-nowrap font-medium">
          {label}
          {hint && <kbd className="kbd px-1 type-caption">{hint}</kbd>}
        </span>
        {/* 图标按钮没有可见文字，作用说明必须跟着标签一起给出，否则只剩一个猜不出的图标 */}
        {(unavailable || desc) && <span className="mt-1 block font-normal">{unavailable || desc}</span>}
      </span>}
    </span>
  );
});

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('focus-ring fill h-9 w-full rounded-md border border-transparent px-3 type-body text-text-primary placeholder:text-(--semantic-color-text-tertiary)', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('focus-ring fill w-full resize-none rounded-md border border-transparent px-3 py-2 type-body text-text-primary placeholder:text-(--semantic-color-text-tertiary)', className)} {...rest} />;
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block type-label font-medium text-text-secondary">{label}</label>
      {children}
      {error ? <p id={`${htmlFor}-error`} className="type-label text-error" role="alert">{error}</p> : hint ? <p className="type-label text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title: ReactNode; actions: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-h-0 flex-col border-border-subtle', className)}>
      {/* 面板标题字阶，与内容之间一道发丝线（§13.1） */}
      <header className="panel-head flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="type-heading2 font-semibold truncate">{title}</h2>
        <div className="flex items-center gap-1">{actions}</div>
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center fade-up">
      <p className="type-body font-medium">{title}</p>
      {hint && <p className="max-w-sm type-label text-text-secondary">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="flex h-full items-center justify-center gap-2 type-label text-text-secondary" role="status"><span className="size-4 rounded-full border-2 border-text-secondary border-r-transparent animate-spin" aria-hidden />加载中</div>;
}
