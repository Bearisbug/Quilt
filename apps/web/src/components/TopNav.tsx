import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { cn } from './ui';
import { Wordmark } from './BrandMark';

// floating：画布页用，顶栏没有底板，只有一层自上而下的渐暗遮罩，画布连点阵一起透上来（见 styles.css 的 .scrim-top）。
// 其余页面（PAGE-FIRST）是常规文档流页，仍用实底顶栏。
// 「设置」在画布页由 Canvas 经 right 传入按钮（就地打开设置弹层）；非画布页保留链接，走 /settings 重定向回最近的项目。
// 退出账号不在这里——它是低频且不可逆的操作，收在设置弹层的「账号」一节。
export function TopNav({ children, right, floating }: { children?: ReactNode; right?: ReactNode; floating?: boolean }) {
  return (
    <header className={cn(
      'flex shrink-0 items-center gap-3 px-3',
      floating ? 'scrim-top absolute inset-x-0 top-0 z-30 h-12' : 'h-11 border-b border-line bg-panel',
    )}>
      {/* 画布顶栏不挂品牌：那一行是用户的去向（项目、设备、屏数），左上第一个元素就是项目切换器。
          非画布 chrome 放不下 64 px 的完整符号，用字标（见 BrandMark.tsx / §13.1） */}
      {!floating && <Link to="/" aria-label="Quilt 首页" className="shrink-0 whitespace-nowrap text-[15px] text-fg hover:text-accent-strong"><Wordmark /></Link>}
      {children}
      <span className="flex-1" />
      {right}
      {!floating && <Link to="/settings" className="shrink-0 whitespace-nowrap text-xs text-muted hover:text-fg">设置</Link>}
    </header>
  );
}
