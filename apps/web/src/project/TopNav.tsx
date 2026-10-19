import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { cn } from '@/ui/ui';
import { Wordmark } from '@/ui/BrandMark';

// floating：画布页用（§13.1）。顶栏不铺底、不画边线，只在左上角摆一枚项目切换器 chip（后面跟着偶尔出现的断线提示）；
// 盒子只包住这几枚 chip，其余位置的指针照常落到画布上。其余页面（PAGE-FIRST）是常规文档流页，用实底横条（styles.css 的 .masthead）。
// 「设置」：非画布页保留链接，走 /settings 重定向回最近的项目。
export function TopNav({ children, right, floating }: { children?: ReactNode; right?: ReactNode; floating?: boolean }) {
  return (
    <header className={cn(
      'flex shrink-0 items-center gap-3',
      // 画布页的 chip 与小地图、对话记录、工具栏同一圈 12 px 外边距：左缘与小地图对齐
      floating ? 'absolute left-3 top-3 z-30' : 'masthead h-12 px-3',
    )}>
      {/* 画布顶栏不挂品牌：左上角只有项目切换器，那是用户的去向。
          非画布 chrome 放不下 64 px 的完整符号，用字标（见 BrandMark.tsx / §13.1） */}
      {!floating && <Link to="/" aria-label="Quilt 首页" className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-heading3 text-text-primary"><Wordmark /></Link>}
      {children}
      {!floating && <span className="flex-1" />}
      {right}
      {!floating && <Link to="/settings" className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-label text-text-secondary">设置</Link>}
    </header>
  );
}
