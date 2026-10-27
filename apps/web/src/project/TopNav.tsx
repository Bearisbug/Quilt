import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { cn } from '@/ui/ui';
import { Wordmark } from '@/ui/BrandMark';
import { useT } from '@/i18n';
import projectMessages from '@/i18n/locales/shellProject';

// floating：画布页用（§13.1）。顶栏不铺底、不画边线，只在左上角摆一枚项目切换器 chip（后面跟着偶尔出现的断线提示）；
// 盒子只包住这几枚 chip，其余位置的指针照常落到画布上。其余页面（PAGE-FIRST）是常规文档流页，用实底横条（styles.css 的 .masthead）。
// 「设置」：非画布页保留链接，走 /settings 重定向回最近的项目。
export function TopNav({ children, right, floating }: { children?: ReactNode; right?: ReactNode; floating?: boolean }) {
  const t = useT(projectMessages);
  return (
    <header className={cn(
      'flex shrink-0 items-center gap-3',
      // 画布页的 chip 与小地图、工具栏同一圈 12 px 外边距：左缘与小地图对齐
      floating ? 'absolute left-3 top-3 z-30' : 'masthead h-12 px-3',
    )}>
      {/* 画布顶栏不挂品牌：左上角只有项目切换器，那是用户的去向。
          非画布 chrome 放不下 64 px 的完整符号，用字标（见 BrandMark.tsx / §13.1） */}
      {!floating && <Link to="/" aria-label={t('nav.home')} className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-heading3 text-text-primary"><Wordmark /></Link>}
      {children}
      {!floating && <span className="flex-1" />}
      {right}
      {!floating && <Link to="/settings" className="state-layer focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 type-label text-text-secondary">{t('nav.settings')}</Link>}
    </header>
  );
}

// 视图切换（PAGE-FULLVIEW，ADR-042）：画布与全屏是同一个项目的两个视图，顶栏端切换器后面一组两枚，⌥F 来回切。
// 压在设计稿上，轨道用 chrome 材质（.seg 的透明填充会透出底下的设计稿）
export function ViewToggle({ full, onChange, label, canvasLabel, fullLabel, hint }: { full: boolean; onChange: (full: boolean) => void; label: string; canvasLabel: string; fullLabel: string; hint: string }) {
  const item = (on: boolean) => cn('focus-ring inline-flex h-7 items-center rounded-sm px-2.5 type-label font-medium', on ? 'bg-surface-raised text-text-primary shadow-(--semantic-elevation-raised)' : 'state-layer text-text-secondary');
  return (
    <div role="group" aria-label={label} aria-description={hint} data-testid="view-toggle" className="chrome inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md p-0.5">
      <button type="button" aria-pressed={!full} aria-keyshortcuts="Alt+F" data-testid="view-canvas" className={item(!full)} onClick={() => { if (full) onChange(false); }}>{canvasLabel}</button>
      <button type="button" aria-pressed={full} aria-keyshortcuts="Alt+F" data-testid="view-full" className={item(full)} onClick={() => { if (!full) onChange(true); }}>{fullLabel}</button>
    </div>
  );
}
