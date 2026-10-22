import { ROUND_PRESETS, ROUND_PRESET_PROMPTS, presetNote, type AnyJobInput, type JobDto, type ScreenDto, type ComponentDto } from '@quilt/core/browser';
import { tOf } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';

// 不分种类读作业输入的形状，从 core 的 schema 推出来（CH-2 v1.06）
export type JobInput = AnyJobInput;
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
// 作业 chip 的文案（REQ-CORE-020）：沿用输入框动词行的口径说「这个作业在做什么」；每次调用按当时的界面语言取文案
const t = tOf(canvasMessages);
export function jobLabel(job: JobDto, screens: Pick<ScreenDto, 'id' | 'name'>[], components: Pick<ComponentDto, 'id' | 'name'>[]): string {
  const i = job.input as JobInput;
  const name = (id: string | undefined) => screens.find((s) => s.id === id)?.name ?? t('jobs.deletedScreen');
  const ver = (i.versions ?? 1) > 1 ? ` × ${t('jobs.versions', { n: i.versions })}` : '';
  switch (job.kind) {
    // 出变体（REQ-CORE-025）：钉死默认屏路由的 generate，行上说清是给哪一屏出哪个状态
    case 'generate': return (i.variantOf ? t('jobs.variant', { screen: name(i.variantOf), name: i.variantName }) : i.count === undefined || i.count === 'auto' ? t('jobs.generateSet') : t('jobs.generateN', { count: i.count })) + ver;
    case 'edit_screens': {
      const ids = coveredScreens(job, screens.map((s) => s.id));
      // 系统代发的修复轮按它自己的名字说（PAGE-CANVAS「同一功能一个名字」）：提示词是固定指令（加附加要求）的就是它
      const preset = ROUND_PRESETS.find((kind) => presetNote(i.prompt ?? '', ROUND_PRESET_PROMPTS[kind]) !== null);
      if (preset === 'link_repair') return t('jobs.linkRepair', { count: ids.length }) + ver;
      if (preset === 'conventions') return t('jobs.conventions', { count: ids.length }) + ver;
      return (ids.length === 1 ? t('jobs.editOne', { name: name(ids[0]) }) : screens.length > 0 && ids.length >= screens.length ? t('jobs.editAll', { n: ids.length }) : t('jobs.editSome', { n: ids.length })) + ver;
    }
    // 一次改几块（v1.26 qids）说块数
    case 'regenerate_subtree': return i.qids && i.qids.length > 1 ? t('jobs.regenerateBlocks', { name: name(i.screenId), n: i.qids.length }) : t('jobs.regenerateBlock', { name: name(i.screenId) });
    case 'apply_design_system': return i.screenIds === 'all' ? t('jobs.applyAll') : t('jobs.applyN', { count: (i.screenIds ?? []).length });
    case 'propose_design_system': return t('jobs.propose');
    case 'export_prototype': return t('jobs.export');
    case 'ingest_screen': return t('jobs.ingest', { name: name(i.screenId) });
    // 聊天（REQ-CORE-023）：范围要等助手看完才知道，行上只写这句话的开头
    case 'chat': { const q = i.prompt ?? ''; return t('jobs.chat', { text: q.length > 20 ? `${q.slice(0, 20)}…` : q }); }
    case 'edit_component': return t('jobs.editComponent', { name: components.find((c) => c.id === i.componentId)?.name ?? t('jobs.deletedComponent') });
  }
}
