import type { MessageDto } from '@quilt/core/browser';

/** 输入框里 ↑ / ↓ 翻到的一条（PAGE-CANVAS 输入框，v1.46）：当时发出去的话与参考图 */
export type PromptHistoryEntry = { text: string; images: { id: string; url: string }[] };

/**
 * 这个项目里发过的话，排成最近的在前（消息接口给的是最近 100 条、旧的在前）：只要用户发的、有字的；
 * 紧挨着的两条一模一样（重试会再记一条同样的消息）只留一条，同命令行的 ignoredups
 */
export function promptHistory(items: MessageDto[]): PromptHistoryEntry[] {
  const out: PromptHistoryEntry[] = [];
  for (const m of [...items].reverse()) {
    if (m.role !== 'user' || !m.content.trim()) continue;
    const entry = { text: m.content, images: m.attachments.map((a) => ({ id: a.id, url: a.url })) };
    const last = out[out.length - 1];
    if (last && last.text === entry.text && last.images.map((i) => i.id).join() === entry.images.map((i) => i.id).join()) continue;
    out.push(entry);
  }
  return out;
}
