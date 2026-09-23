import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; pending?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'ghost', size = 'md', pending, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-strong',
        variant === 'ghost' && 'border border-line text-fg hover:border-line-strong hover:bg-panel-2',
        variant === 'danger' && 'border border-danger/60 text-danger hover:bg-danger/10',
        className,
      )}
      {...rest}
    >
      {pending && <span className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

// 图标按钮：命中区固定 44px（A11Y-009），无障碍名走 aria-label、悬停提示只是补充（A11Y-010）。
// 悬停态挂在几何恒定的外层 span 上，动的只有提示子元素，按钮盒子一帧不变（INT-018）。
// 不可用时用 aria-disabled 而非原生 disabled：工具栏按钮要能被键盘发现、并在提示里说明为什么用不了（A11Y-007 / INT-013）。
// 尺寸：xs 32px（面板角落的收起 / 关闭）、sm 40px（输入框的发送 / 取消）、md 44px（工具栏）。
// tone=invert 是反色实心钮，只给「此刻唯一的主动作」（发送 / 停止）用。
type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  label: string; hint?: string; desc?: string; active?: boolean; tip?: 'left' | 'right' | 'top' | 'top-end' | 'bottom' | 'none'; unavailable?: string | false; size?: 'xs' | 'sm' | 'md'; tone?: 'default' | 'danger' | 'invert';
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
          'grid place-items-center rounded-full transition-[color,background-color,box-shadow,scale] duration-[var(--duration-fast)] ease-out active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:active:scale-100',
          size === 'md' ? 'size-11' : size === 'sm' ? 'size-10' : 'size-8',
          active ? 'bg-accent text-white' : tone === 'invert' ? 'bg-fg text-canvas hover:ring-4 hover:ring-fg/15' : tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-muted hover:bg-panel-2 hover:text-fg',
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
          'pointer-events-none absolute z-10 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-fg opacity-0 shadow-lg transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 group-focus-within:opacity-100',
          desc ? 'w-52 text-left' : 'whitespace-nowrap',
          tip === 'left' && 'right-full top-1/2 mr-2 -translate-y-1/2',
          tip === 'right' && 'left-full top-1/2 ml-2 -translate-y-1/2',
          tip === 'top' && 'bottom-full left-1/2 mb-2 -translate-x-1/2',
          tip === 'bottom' && 'top-full left-1/2 mt-2 -translate-x-1/2',
          // 贴容器右缘展开：按钮在容器边上时，居中锚点会把提示顶出容器（实测撑出 59px）
          tip === 'top-end' && 'bottom-full right-0 mb-2',
        )}
      >
        <span className="flex items-baseline gap-1.5 whitespace-nowrap font-medium">
          {label}
          {hint && <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-sans text-[10px] text-muted">{hint}</kbd>}
        </span>
        {/* 图标按钮没有可见文字，作用说明必须跟着标签一起给出，否则只剩一个猜不出的图标 */}
        {(unavailable || desc) && <span className="mt-1 block leading-relaxed text-muted">{unavailable || desc}</span>}
      </span>}
    </span>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn('h-9 w-full rounded-md border border-line bg-canvas px-3 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn('w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1', className)} {...rest} />;
});

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted">{label}</label>
      {children}
      {error ? <p id={`${htmlFor}-error`} className="text-xs text-danger" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-h-0 flex-col border-line', className)}>
      {(title || actions) && (
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="text-sm font-semibold truncate">{title}</h2>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center fade-up">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return <div className="flex h-full items-center justify-center gap-2 text-xs text-muted" role="status"><span className="size-4 rounded-full border-2 border-muted border-r-transparent animate-spin" aria-hidden />{label}</div>;
}
