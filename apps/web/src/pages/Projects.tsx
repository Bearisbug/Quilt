import type { ReactNode } from 'react';
import { useLocation, useNavigate, useRouteError } from 'react-router';
import { ApiError } from '@/lib/api';
import { Button } from '@/ui/ui';
import { TopNav } from '@/project/TopNav';
import { BrandSymbol } from '@/ui/BrandMark';
import { CreateProjectDialog } from '@/project/CreateProjectDialog';
import { useT } from '@/i18n';
import pagesMessages from '@/i18n/locales/shellPages';
import commonMessages from '@/i18n/locales/common';

// PAGE-FIRST（§13）：还没有任何项目时 `/` 落到这里——只有新建弹窗，没有别处可去，所以弹窗不可关闭；
// 有项目时 `/` 的 loader 直接跳最近更新的项目，画布顶栏的项目切换器承担原项目列表的职责。
// 这是 `npx quilt-canvas` 首次打开看到的第一屏，也是产品里唯一放得下 64 px 完整品牌符号的地方（BRAND.md §5）。
export function FirstProjectPage() {
  const t = useT(pagesMessages);
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <BrandSymbol size={96} label="Quilt" />
        <PageMessage title={t('first.title')} hint={t('first.hint')} />
      </main>
      <CreateProjectDialog />
    </div>
  );
}

// 路由出错的错误页（全部路由共用，v0.83）：按界面语言写说明 + 下一步，不落到路由库的英文默认错误页（IA-009）。
// loader 取不到数据（API 没起来、网络断了、请求超时）→「没连上 Quilt 服务」+ 重试；页面渲染时抛了异常 →「页面出错了」+ 重新加载
export function RouteError() {
  const t = useT(pagesMessages);
  const tc = useT(commonMessages);
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : '';
  const offline = error instanceof ApiError || (error instanceof TypeError && /fetch/i.test(error.message)) || (error instanceof DOMException && error.name === 'AbortError');
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        {offline
          ? <PageMessage title={t('offline.title')} hint={detail ? t('offline.hintDetail', { detail }) : t('offline.hint')}
              action={<Button variant="primary" onClick={() => window.location.reload()}>{tc('retry')}</Button>} />
          : <PageMessage title={t('crash.title')} hint={detail ? t('crash.hintDetail', { detail }) : t('crash.hint')}
              action={<Button variant="primary" onClick={() => window.location.reload()}>{t('crash.reload')}</Button>} />}
      </main>
    </div>
  );
}

// 没有匹配的地址（v0.83）：说清是哪个地址不对，出口回到最近更新的项目（根路径的 loader 会转过去）
export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const t = useT(pagesMessages);
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        <PageMessage title={t('notFound.title')} hint={t('notFound.hint', { path: pathname })}
          action={<Button variant="primary" onClick={() => navigate('/')}>{t('notFound.back')}</Button>} />
      </main>
    </div>
  );
}

// 整页说明（PAGE-FIRST 与错误页）：这几页只有一件事，大标题、一段说明、一个主动作，整页居中
function PageMessage({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center fade-up">
      <h1 className="type-heading1 font-semibold text-balance">{title}</h1>
      <p className="max-w-md type-body text-text-secondary text-pretty break-words">{hint}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
