import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { MessageDto } from '@quilt/core';
import { Wordmark } from '@/ui/BrandMark';

export type ChatDockProps = {
  messages: MessageDto[];
  /** 各在跑作业的进度，按 jobId 索引（REQ-CORE-020）：空内容的助手气泡只读它自己那一条 */
  progress: Record<string, string>;
  /** 折叠横条上的一行状态：一个作业在跑时是它的进度，多个时是条数；没有在跑作业为 null */
  status: string | null;
  collapsed: boolean;
  onToggle: () => void;
  /** 「记为约定」（REQ-EDIT-003）：把这一轮改屏的指令提炼成设计系统约定，预览后写入 */
  onRemember?: (assistant: MessageDto) => void;
  busy?: boolean;
};

// 对话记录（REQ-CORE-006，v0.34 挪到左下角）：底部对齐、从下往上长，头部一整条可点——上拉展开、下收折叠；
// 折叠后只剩这一条横条（标题 + 条数；恰好一个作业在跑时显示它的进度，多个时显示条数）。输入在底部的 Composer 里。
export function ChatDock(p: ChatDockProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [p.messages.length, p.progress, p.collapsed]);

  return (
    <aside className="chat-dock chrome absolute left-3 z-20 flex w-[var(--dock-w)] flex-col overflow-hidden rounded-xl" aria-label="对话记录" data-testid="chat-dock" data-state={p.collapsed ? 'collapsed' : 'open'}>
      <button
        type="button" aria-expanded={!p.collapsed} aria-label={p.collapsed ? '展开对话记录' : '折叠对话记录'} onClick={p.onToggle}
        className="flex h-11 w-full shrink-0 items-center justify-between gap-2 px-3 text-left transition-colors duration-[var(--duration-fast)] hover:bg-panel-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-semibold">对话</span>
          <span className="truncate text-xs text-muted">{p.collapsed && p.status ? p.status : `${p.messages.length} 条`}</span>
        </span>
        {p.collapsed ? <ChevronUp size={16} className="shrink-0 text-muted" aria-hidden="true" /> : <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden="true" />}
      </button>
      {!p.collapsed && (
        <>
          <div ref={listRef} className="scroll fade-up min-h-0 max-h-[min(28rem,calc(100dvh-12rem))] flex-1 space-y-3 border-t border-line p-3" role="log" aria-live="polite">
            {p.messages.length === 0 && (
              <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
                <p className="font-medium text-fg">试试这样描述：</p>
                <p className="mt-1">「做一个宠物社交 APP：分享宠物照片、关注其他宠物、附近约玩、和主人聊天、管理宠物资料」</p>
              </div>
            )}
            {p.messages.map((m) => (
              <div key={m.id} className={`fade-up rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'ml-5 bg-accent/15' : 'mr-5 bg-panel-2'}`}>
                {/* 不 uppercase：那会把字标写成 QUILT，改掉品牌字样 */}
                <div className="mb-0.5 text-[10px] tracking-wide text-muted">{m.role === 'user' ? '你' : <Wordmark />}</div>
                {/* 发过的参考图（REQ-CORE-012）：URL 是签名的、会过期，取不到就退成一行说明而不是裂图 */}
                {m.attachments.length > 0 && (
                  <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label={`${m.attachments.length} 张参考图`}>
                    {m.attachments.map((a) => (
                      <li key={a.id}>
                        <img
                          src={a.url} alt="参考图" data-testid="message-attachment"
                          className="size-14 rounded-md border border-line object-cover"
                          onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'text-[11px] text-muted', textContent: '参考图已过期' })); }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {/* 回执还没落库的助手气泡显示它自己那个作业的进度：并行时按 jobId 取，否则每个空气泡都会写上别人的进度 */}
                {m.content ? <p className="leading-cn whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content}</p> : <p className="text-muted">{(m.jobId ? p.progress[m.jobId] : undefined) ?? '排队中…'}</p>}
                {m.affectedScreenIds.length > 0 && (
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                    <span>影响 {m.affectedScreenIds.length} 屏</span>
                    {/* 只有改屏的回执才能记为约定：单屏指令也可能是全局偏好，让用户自己判断；提炼后有预览兜底 */}
                    {m.role === 'assistant' && m.jobKind === 'edit_screens' && m.content && p.onRemember && (
                      <button type="button" data-testid="remember-convention" disabled={p.busy} onClick={() => p.onRemember!(m)} title="把这一轮的指令提炼成设计系统约定，预览后写入，之后每次生成都会遵守"
                        className="rounded-md px-1.5 py-0.5 text-[11px] text-accent-strong transition-colors duration-[var(--duration-fast)] hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">记为约定</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="shrink-0 border-t border-line p-3 text-[11px] leading-relaxed text-muted">
            滚轮/触控板平移 · Ctrl+滚轮或捏合缩放 · 空格+拖拽平移 · 空白处拖拽框选 · Shift/⌘ 点击加选 · 拖动卡片摆放 · 双击进入交互 · Esc 退出
          </p>
        </>
      )}
    </aside>
  );
}
