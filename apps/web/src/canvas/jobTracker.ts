import type { JobDto } from '@quilt/core/browser';

// 画布的作业对账（REQ-CORE-020，v1.06 从 Canvas.tsx 抽出成纯函数）：组件拿结果去改状态、发后续请求，时序的取舍都在这里，由
// tests/unit/web/jobTracker.test.ts 锁住。几种状态的含义：
// - active：本页正在跟踪的作业（在跑作业行）；
// - seen：某次详情 GET 列出过的作业 id；
// - trackedAt：本页自己建的作业开始跟踪时的详情请求序号；
// - finished：已经宣告过终态的作业 id。早于终态发出、晚于终态返回的那次 GET 还会列着它，没有这道白名单会把死作业重新认领回来
//   （行上带取消键的幽灵作业，新订阅从 seq 0 重放还会把 succeeded 再处理一次——导出作业等于二次下载）
export type TrackerSets = { seen: ReadonlySet<string>; finished: ReadonlySet<string>; trackedAt: ReadonlyMap<string, number> };

/** 一次详情回包（发起序号 seq，列出的进行中作业 live）之后：撤掉哪些、认领哪些，三个集合变成什么 */
export function reconcileJobs(active: JobDto[], sets: TrackerSets, live: JobDto[], seq: number) {
  const liveIds = new Set(live.map((j) => j.id));
  const seen = new Set([...sets.seen, ...liveIds]);
  // 只撤服务端确认过（某次 GET 列出过）、或在这次 GET 发出之前就已跟踪的作业：比作业先发出的 GET 快照里没有它，
  // 无条件撤掉会让它的行闪一下又回来，重连的订阅还会从 seq 0 重放一遍。只认「列出过」不够（v0.88）：事件流假死时
  // 本页建的作业从建到结束都没被哪次 GET 列出过，重连后的整体重取也撤不掉它，行一直挂着「排队中…」
  const gone = active.filter((j) => !liveIds.has(j.id) && (seen.has(j.id) || (sets.trackedAt.get(j.id) ?? Infinity) < seq)).map((j) => j.id);
  const trackedAt = new Map(sets.trackedAt);
  for (const id of gone) { seen.delete(id); trackedAt.delete(id); }
  // 再认领还没跟踪的（首次加载、MCP / 另一个标签页建的作业）；runner=agent 的由本机 agent 面板跟踪（ADR-015）
  const tracked = new Set(active.map((j) => j.id));
  const claim = live.filter((j) => j.runner !== 'agent' && !tracked.has(j.id) && !sets.finished.has(j.id));
  // 后端不再列出的作业不会再被认领，白名单到此为止——不让它随会话无声长大
  const finished = new Set([...sets.finished].filter((id) => liveIds.has(id)));
  return { gone, claim, seen, trackedAt, finished };
}

/** 作业宣告终态（succeeded / failed / cancelled）之后的三个集合 */
export function settleJob(sets: TrackerSets, jobId: string) {
  const seen = new Set(sets.seen); seen.delete(jobId);
  const trackedAt = new Map(sets.trackedAt); trackedAt.delete(jobId);
  return { seen, trackedAt, finished: new Set([...sets.finished, jobId]) };
}

const RUNNING_TEXT: Partial<Record<JobDto['kind'], string>> = {
  chat: '助手在想…', edit_component: '正在改组件…', export_prototype: '正在打包原型…', apply_design_system: '正在回刷屏幕…',
  propose_design_system: '正在提炼约定…', edit_screens: '正在改屏…', regenerate_subtree: '正在改屏…',
};
/** progress 事件对应的在跑作业行文案：聊天是助手每次工具调用的一句话（REQ-CORE-023），改组件先回刷再逐屏截图（REQ-EDIT-006） */
export function progressText(kind: JobDto['kind'], data: Record<string, unknown>): string {
  if (data.stage === 'chat' && typeof data.step === 'string') return data.step;
  if (data.stage === 'retry') return `供应商波动，正在重试（第 ${data.attempt} 次）…`;
  if (data.stage === 'component_synced') return `已同步 ${data.screens ?? 0} 屏，正在截图…`;
  if (data.stage === 'running') return RUNNING_TEXT[kind] ?? '正在规划屏幕…';
  if (data.stage === 'exported') return '打包完成';
  return '排队中…';
}
