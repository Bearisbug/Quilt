import { defineMessages } from '@/i18n';

// 整页说明（pages/Projects.tsx）：PAGE-FIRST、路由错误页、没有这个页面（§13，v0.83）
export default defineMessages('shellPages', {
  first: {
    title: '还没有项目',
    hint: '新建一个项目，用一句话描述你的 APP，Quilt 会生成整套屏幕摆到画布上。',
  },
  offline: {
    title: '没连上 Quilt 服务',
    hint: '取项目列表失败。确认 Quilt 还在运行（启动它的终端没有关掉），然后重试。',
    hintDetail: '取项目列表失败（{{detail}}）。确认 Quilt 还在运行（启动它的终端没有关掉），然后重试。',
  },
  crash: {
    title: '页面出错了',
    hint: '这一页在显示时出了错。重新加载一次；还是这样的话，看启动 Quilt 的终端里有没有报错。',
    hintDetail: '这一页在显示时出了错（{{detail}}）。重新加载一次；还是这样的话，看启动 Quilt 的终端里有没有报错。',
    reload: '重新加载',
  },
  notFound: {
    title: '没有这个页面',
    hint: 'Quilt 里没有「{{path}}」这个地址，可能是链接写错了。',
    back: '回到最近的项目',
  },
}, {
  first: {
    title: 'No projects yet',
    hint: 'Create a project and describe your app in one sentence; Quilt generates a full set of screens and lays them out on the canvas.',
  },
  offline: {
    title: 'Can’t reach the Quilt service',
    hint: 'Couldn’t load the project list. Make sure Quilt is still running (the terminal that started it is still open), then retry.',
    hintDetail: 'Couldn’t load the project list ({{detail}}). Make sure Quilt is still running (the terminal that started it is still open), then retry.',
  },
  crash: {
    title: 'Something went wrong',
    hint: 'This page hit an error while rendering. Reload it; if the error comes back, check the terminal that started Quilt for errors.',
    hintDetail: 'This page hit an error while rendering ({{detail}}). Reload it; if the error comes back, check the terminal that started Quilt for errors.',
    reload: 'Reload',
  },
  notFound: {
    title: 'Page not found',
    hint: 'Quilt has no page at “{{path}}”; the link may be mistyped.',
    back: 'Go to the latest project',
  },
});
