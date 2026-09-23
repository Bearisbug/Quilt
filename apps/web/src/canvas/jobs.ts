import type { JobDto, ScreenDto, ComponentDto, ScreenCount } from '@quilt/core';

export type JobInput = { count?: ScreenCount; versions?: number; screenIds?: string[] | 'all'; screenId?: string; fromScreenId?: string; prompt?: string; componentId?: string; componentIds?: string[]; variantOf?: string; variantName?: string };
// 一个在跑作业会改到哪些屏（REQ-CORE-020）。JobDto 不带 targetScreenId，只能按 kind 从 input 反推；
// 口径与 apps/api/src/services/jobs.ts 的守卫对齐，但比它严：多屏 edit_screens 与回刷在后端落 target_screen_id=null，
// 后端看不见它们实际改的屏（§16 真值表的缺口行），撞上的后果是一方作业 failed 或静默顶掉对方，所以前端按覆盖屏集拦。
export function coveredScreens(job: JobDto, allIds: string[], components: ComponentDto[] = []): string[] {
  const i = job.input as JobInput;
  switch (job.kind) {
    case 'edit_screens':
    case 'apply_design_system': return i.screenIds === 'all' ? allIds : i.screenIds ?? [];
    case 'regenerate_subtree':
    case 'ingest_screen': return i.screenId ? [i.screenId] : [];
    // generate 占项目级造屏名额，但带 fromScreenId（懒生成补屏、断链补屏）时还会给入口屏跑一次反向连线，
    // 用 sourceKind=edit 给它落新修订（pipeline.ts 的入口屏补链）——那一屏同样被占着，
    // 不算进来的话用户同时改这一屏，谁后落库谁撞修订冲突整个作业 failed
    case 'generate': return i.fromScreenId ? [i.fromScreenId] : [];
    // 改组件（REQ-EDIT-006）：成功后确定性回刷所有用它的屏
    case 'edit_component': return components.find((c) => c.id === i.componentId)?.usedBy ?? [];
    // 提炼与导出只读
    default: return [];
  }
}
// 在跑作业行的文案（REQ-CORE-020）：沿用输入框动词行的口径说「这个作业在做什么」
export function jobLabel(job: JobDto, screens: ScreenDto[], components: ComponentDto[]): string {
  const i = job.input as JobInput;
  const name = (id: string | undefined) => screens.find((s) => s.id === id)?.name ?? '已删除的屏';
  const ver = (i.versions ?? 1) > 1 ? ` × ${i.versions} 版` : '';
  switch (job.kind) {
    // 出变体（REQ-CORE-025）：钉死默认屏路由的 generate，行上说清是给哪一屏出哪个状态
    case 'generate': return i.variantOf ? `出「${name(i.variantOf)}」的「${i.variantName}」变体${ver}` : `造${i.count === undefined || i.count === 'auto' ? '一组屏' : ` ${i.count} 屏`}${ver}`;
    case 'edit_screens': {
      const ids = coveredScreens(job, screens.map((s) => s.id));
      return `改${ids.length === 1 ? `「${name(ids[0])}」` : screens.length > 0 && ids.length >= screens.length ? `全部 ${ids.length} 屏` : ` ${ids.length} 屏`}${ver}`;
    }
    case 'regenerate_subtree': return `重做「${name(i.screenId)}」的一块`;
    case 'apply_design_system': return i.screenIds === 'all' ? '回刷所有屏' : `回刷 ${(i.screenIds ?? []).length} 屏`;
    case 'propose_design_system': return '提炼约定';
    case 'export_prototype': return '打包原型';
    case 'ingest_screen': return `写入「${name(i.screenId)}」`;
    // 聊天（REQ-CORE-023）：范围要等助手看完才知道，行上只写这句话的开头
    case 'chat': { const q = i.prompt ?? ''; return `聊「${q.length > 20 ? `${q.slice(0, 20)}…` : q}」`; }
    case 'edit_component': return `改组件「${components.find((c) => c.id === i.componentId)?.name ?? '已删除的组件'}」`;
  }
}
