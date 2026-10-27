// 界面语言（REQ-CORE-046）：最先导入——i18next 同步初始化并注册全部命名空间，首帧就是选定的语言
import '@/i18n/load';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, redirect } from 'react-router';
import { api } from '@/lib/api';
import { ToastProvider } from '@/lib/toast';
import { noteLocation, startRecorder } from '@/lib/recorder';
import { FirstProjectPage, NotFoundPage, RouteError } from '@/pages/Projects';
import { CanvasRoute } from '@/pages/Canvas';
import { SketchRoute } from '@/pages/Sketch';

// 画布即主界面（§13 导航 v0.28 / v0.32 本地版无登录）：直接进最近更新的项目；一个项目都没有才落到 PAGE-FIRST
async function latestProjectId(): Promise<string | null> {
  const { items } = await api.projects.list();
  const latest = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return latest?.id ?? null;
}

// 全部路由挂在一个无路径的父路由下，共用一个错误页（v0.83，按界面语言写）：loader 取不到、页面渲染时抛异常都落到它，不落到路由库的英文默认错误页；
// 没有匹配的地址是「没有这个页面」
const router = createBrowserRouter([{ errorElement: <RouteError />, children: [
  { path: '/', loader: async () => { const id = await latestProjectId(); return id ? redirect(`/p/${id}`) : null; }, element: <FirstProjectPage /> },
  { path: '/projects', loader: () => redirect('/') },
  // 画布与全屏视图（PAGE-FULLVIEW）是同一个路由：两个视图之间切换不重挂页面
  { path: '/p/:projectId/:view?', element: <CanvasRoute /> },
  // 草稿本（PAGE-SKETCH，REQ-CORE-040）：每个用户一个，进页时取回（没有就建）
  { path: '/sketch', element: <SketchRoute /> },
  // 旧的设置页路径：设置现在是画布上的弹层。从某个画布页点进来的（loader 跑的时候地址栏还是原页面）留在那个项目里，
  // 直接打开的去最近更新的项目；没有项目就回 /
  { path: '/settings', loader: async () => {
    const from = window.location.pathname.match(/^\/p\/([^/]+)/)?.[1];
    const id = from ?? await latestProjectId();
    return redirect(id ? `/p/${id}?settings=usage` : '/');
  } },
  { path: '*', element: <NotFoundPage /> },
] }]);

// 本机使用记录（REQ-CORE-047）：启动时读一次开关，开着才采集；换路由与查询参数记一条 view
startRecorder();
router.subscribe(noteLocation);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
