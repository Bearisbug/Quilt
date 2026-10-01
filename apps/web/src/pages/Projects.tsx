import { useLocation, useNavigate, useRouteError } from 'react-router';
import { ApiError } from '@/lib/api';
import { Button, EmptyState } from '@/ui/ui';
import { TopNav } from '@/project/TopNav';
import { BrandSymbol } from '@/ui/BrandMark';
import { CreateProjectDialog } from '@/project/CreateProjectDialog';

// PAGE-FIRST（§13）：还没有任何项目时 `/` 落到这里——只有新建弹窗，没有别处可去，所以弹窗不可关闭；
// 有项目时 `/` 的 loader 直接跳最近更新的项目，画布顶栏的项目切换器承担原项目列表的职责。
// 这是 `npx quilt-canvas` 首次打开看到的第一屏，也是产品里唯一放得下 64 px 完整品牌符号的地方（BRAND.md §5）。
export function FirstProjectPage() {
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <BrandSymbol size={96} label="Quilt" />
        <EmptyState title="还没有项目" hint="新建一个项目，用一句话描述你的 APP，Quilt 会生成整套屏幕摆到画布上。" />
      </main>
      <CreateProjectDialog />
    </div>
  );
}

// 路由出错的中文错误页（全部路由共用，v0.83）：中文说明 + 下一步，不落到路由库的英文默认错误页（IA-009）。
// loader 取不到数据（API 没起来、网络断了、请求超时）→「没连上 Quilt 服务」+ 重试；页面渲染时抛了异常 →「页面出错了」+ 重新加载
export function RouteError() {
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : '';
  const offline = error instanceof ApiError || (error instanceof TypeError && /fetch/i.test(error.message)) || (error instanceof DOMException && error.name === 'AbortError');
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        {offline
          ? <EmptyState title="没连上 Quilt 服务" hint={`取项目列表失败${detail ? `（${detail}）` : ''}。确认 Quilt 还在运行（启动它的终端没有关掉），然后重试。`}
              action={<Button variant="primary" onClick={() => window.location.reload()}>重试</Button>} />
          : <EmptyState title="页面出错了" hint={`这一页在显示时出了错${detail ? `（${detail}）` : ''}。重新加载一次；还是这样的话，看启动 Quilt 的终端里有没有报错。`}
              action={<Button variant="primary" onClick={() => window.location.reload()}>重新加载</Button>} />}
      </main>
    </div>
  );
}

// 没有匹配的地址（v0.83）：说清是哪个地址不对，出口回到最近更新的项目（根路径的 loader 会转过去）
export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        <EmptyState title="没有这个页面" hint={`Quilt 里没有「${pathname}」这个地址，可能是链接写错了。`}
          action={<Button variant="primary" onClick={() => navigate('/')}>回到最近的项目</Button>} />
      </main>
    </div>
  );
}
