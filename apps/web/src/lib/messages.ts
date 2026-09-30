import type { MessageDto } from '@quilt/core';

// 对话记录有两个写入源（v0.76）：服务端快照整体到达；本页发出一轮时在本地先追加。快照可能早于那一轮发出、晚于它返回，
// 整体覆盖就把刚发的一轮抹掉（要等作业结束的下一次刷新才回来）——按 id 合并：以快照为准，再接上本地追加且快照里还没有的
export function mergeMessages(snapshot: MessageDto[], local: MessageDto[]): MessageDto[] {
  const ids = new Set(snapshot.map((m) => m.id));
  return [...snapshot, ...local.filter((m) => !ids.has(m.id))];
}
