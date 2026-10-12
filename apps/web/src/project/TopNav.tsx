import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { cn } from '@/ui/ui';
import { Wordmark } from '@/ui/BrandMark';

// 顶栏是实底横条（styles.css 的 .masthead，§13.1）。floating：画布页用，绝对定位贴顶，画布在它下面平移；
// 其余页面（PAGE-FIRST）是常规文档流页，顶栏占一行。
// 「设置」在画布页由 Canvas 经 right 传入按钮（就地打开设置弹层）；非画布页保留链接，走 /settings 重定向回最近的项目。
// 退出账号不在这里——它是低频且不可逆的操作，收在设置弹层的「账号」一节。
export function TopNav({ children, right, floating }: { children?: ReactNode; right?: ReactNode; floating?: boolean }) {
  return (
    <header className={cn(
      'masthead flex h-12 shrink-0 items-center gap-3 px-3',
      floating && 'absolute inset-x-0 top-0 z-30',
    )}>
      {/* 画布顶栏不挂品牌：那一行是用户的去向（项目、设备、屏数），左上第一个元素就是项目切换器。
          非画布 chrome 放不下 64 px 的完整符号，用字标（见 BrandMark.tsx / §13.1） */}
      {!floating && <Link to="/" aria-label="Quilt 首页" className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-heading3 text-text-primary"><Wordmark /></Link>}
      {children}
      <span className="flex-1" />
      {right}
      {!floating && <Link to="/settings" className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-label text-text-secondary">设置</Link>}
    </header>
  );
}
