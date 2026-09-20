import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, redirect } from 'react-router';
import { api } from './lib/api';
import { ToastProvider } from './lib/toast';
import { FirstProjectPage } from './pages/Projects';
import { CanvasPage } from './pages/Canvas';
import './styles.css';

// 画布即主界面（§13 导航 v0.28 / v0.32 本地版无登录）：直接进最近更新的项目；一个项目都没有才落到 PAGE-FIRST
async function latestProjectId(): Promise<string | null> {
  const { items } = await api.projects.list();
  const latest = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return latest?.id ?? null;
}

const router = createBrowserRouter([
  { path: '/', loader: async () => { const id = await latestProjectId(); return id ? redirect(`/p/${id}`) : null; }, element: <FirstProjectPage /> },
  { path: '/projects', loader: () => redirect('/') },
  { path: '/p/:projectId', element: <CanvasPage /> },
  // 旧的设置页路径：设置现在是画布上的弹层。从某个画布页点进来的（loader 跑的时候地址栏还是原页面）留在那个项目里，
  // 直接打开的去最近更新的项目；没有项目就回 /
  { path: '/settings', loader: async () => {
    const from = window.location.pathname.match(/^\/p\/([^/]+)/)?.[1];
    const id = from ?? await latestProjectId();
    return redirect(id ? `/p/${id}?settings=usage` : '/');
  } },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
