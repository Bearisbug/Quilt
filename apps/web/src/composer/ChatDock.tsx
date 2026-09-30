import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Pencil, RotateCcw } from 'lucide-react';
import type { JobKind, MessageDto } from '@quilt/core';
import { Wordmark } from '@/ui/BrandMark';
import { IconButton } from '@/ui/ui';
import { useToast } from '@/lib/toast';
import { ImageViewer } from './ImageViewer';

const RETRYABLE: JobKind[] = ['generate', 'edit_screens', 'edit_component', 'chat'];

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
  /** 最后一轮的重试 / 修改（REQ-CORE-026）：参数都是这一轮的用户消息 */
  onRetry?: (user: MessageDto) => void;
  onEdit?: (user: MessageDto) => void;
  /** 在排队或在跑的作业：最后一轮的作业还在其中时「重试」置灰 */
  runningJobIds: ReadonlySet<string>;
  /** 重试请求在途（v0.74）：点下到响应回来之前「重试」置灰转圈 */
  retrying: boolean;
  /** 自己发出 / 重试了一轮就加一：列表不在底部也滚到底（v0.74） */
  followSeq: number;
  /** 折叠期间失败了几轮（v0.74）：横条上标出，展开即由父组件清零 */
  failed: number;
};

// 对话记录（REQ-CORE-006，v0.34 挪到左下角）：底部对齐、从下往上长，头部一整条可点——上拉展开、下收折叠；
// 折叠后只剩这一条横条（标题 + 条数；恰好一个作业在跑时显示它的进度，多个时显示条数）。输入在底部的 Composer 里。
export function ChatDock(p: ChatDockProps) {
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);
  // 滚动跟随（INT-008 v0.74）：列表停在底部时跟随新消息与进度；往上翻看时被动更新不动它。自己发出 / 重试的一轮、展开时滚到底
  const stuck = useRef(true);
  const toBottom = () => listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  useEffect(() => { if (stuck.current) toBottom(); }, [p.messages, p.progress]);
  useEffect(() => { stuck.current = true; toBottom(); }, [p.followSeq, p.collapsed]);
  const onScroll = () => { const el = listRef.current; if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  // 大图预览（REQ-CORE-026）：整个对话已加载的参考图按时间排成一组；关闭后焦点回到点开它的那张缩略图。
  // 按「哪条消息的哪张图」记当前图（v0.74）：列表变了（最近 100 条的窗口滑过、新消息进来）序号跟着变、图不换；这张图不在已加载的对话里了就关闭并说明
  const gallery = useMemo(() => p.messages.flatMap((m) => m.attachments.map((a) => ({ id: a.id, url: a.url, caption: m.content.slice(0, 40), messageId: m.id }))), [p.messages]);
  const [viewing, setViewing] = useState<{ messageId: string; id: string } | null>(null);
  const viewerAt = viewing ? gallery.findIndex((g) => g.messageId === viewing.messageId && g.id === viewing.id) : -1;
  useEffect(() => {
    if (viewing && viewerAt < 0) { setViewing(null); toast('这张参考图所在的消息已不在已加载的对话里，预览已关闭'); }
  }, [viewing, viewerAt, toast]);
  const openerRef = useRef<HTMLElement | null>(null);
  // 最后一轮 = 最后一条带作业的用户消息与同一作业的助手消息；只有输入框能发出的四类作业可重试 / 修改
  const round = useMemo(() => {
    const user = [...p.messages].reverse().find((m) => m.role === 'user' && m.jobId);
    if (!user || !user.jobKind || !RETRYABLE.includes(user.jobKind)) return null;
    return { user, assistant: p.messages.find((m) => m.role === 'assistant' && m.jobId === user.jobId) };
  }, [p.messages]);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch { toast('复制失败：浏览器没有给剪贴板权限', 'error'); }
  };

  return (
    <aside className="chat-dock chrome absolute left-3 z-20 flex w-[var(--dock-w)] flex-col overflow-hidden rounded-xl" aria-label="对话记录" data-testid="chat-dock" data-state={p.collapsed ? 'collapsed' : 'open'}>
      <button
        type="button" aria-expanded={!p.collapsed} aria-label={p.collapsed ? `展开对话记录${p.failed ? `（${p.failed} 轮失败）` : ''}` : '折叠对话记录'} onClick={p.onToggle}
        className="flex h-11 w-full shrink-0 items-center justify-between gap-2 px-3 text-left transition-colors duration-[var(--duration-fast)] hover:bg-panel-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-semibold">对话</span>
          <span className="truncate text-xs text-muted">{p.collapsed && p.status ? p.status : `${p.messages.length} 条`}</span>
          {/* 折叠期间有作业失败：toast 几秒就走，横条上留一枚标记直到展开（v0.74） */}
          {p.collapsed && p.failed > 0 && <span data-testid="chat-failed" className="shrink-0 self-center rounded-full bg-danger/10 px-1.5 py-px text-[11px] font-medium text-danger">{p.failed} 轮失败</span>}
        </span>
        {p.collapsed ? <ChevronUp size={16} className="shrink-0 text-muted" aria-hidden="true" /> : <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden="true" />}
      </button>
      {!p.collapsed && (
        <>
          <div ref={listRef} onScroll={onScroll} className="scroll fade-up min-h-0 max-h-[min(28rem,calc(100dvh-12rem))] flex-1 space-y-3 border-t border-line p-3" role="log" aria-live="polite">
            {p.messages.length === 0 && (
              <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
                <p className="font-medium text-fg">试试这样描述：</p>
                <p className="mt-1">「做一个宠物社交 APP：分享宠物照片、关注其他宠物、附近约玩、和主人聊天、管理宠物资料」</p>
              </div>
            )}
            {p.messages.map((m) => (
              <div key={m.id} data-testid="message" data-role={m.role} className={`msg fade-up relative rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'ml-5 bg-accent/15' : 'mr-5 bg-panel-2'}`}>
                {/* 不 uppercase：那会把字标写成 QUILT，改掉品牌字样 */}
                <div className="mb-0.5 text-[10px] tracking-wide text-muted">{m.role === 'user' ? '你' : <Wordmark />}</div>
                {/* 消息操作（REQ-CORE-026）：浮在气泡右上角、占的是标签行右侧的空白，出现时不推动任何内容；显隐规则在 styles.css 的 .msg-actions */}
                {/* 在跑的助手气泡还没有正文、没得复制，但「重试」仍要出现并写明为什么用不了 */}
                {(m.content || m.id === round?.user.id || m.id === round?.assistant?.id) && (
                  <div className="msg-actions absolute -top-3 right-2 flex gap-0.5 rounded-full border border-line bg-panel p-0.5 shadow-md" role="group" aria-label="消息操作">
                    {m.content && <IconButton label="复制" size="xs" tip="bottom-end" data-testid="msg-copy" onClick={() => void copy(m.content)}><Copy size={14} aria-hidden="true" /></IconButton>}
                    {m.id === round?.user.id && p.onEdit && (
                      <IconButton label="修改" desc="把这一轮的文字、参考图与目标填回输入框，改完再发" size="xs" tip="bottom-end" data-testid="msg-edit" onClick={() => p.onEdit!(m)}><Pencil size={14} aria-hidden="true" /></IconButton>
                    )}
                    {m.id === round?.assistant?.id && p.onRetry && (
                      <IconButton label="重试" desc="用原来的文字、参考图与目标再发一轮，通道用输入框当前选的" size="xs" tip="bottom-end" data-testid="msg-retry" aria-busy={p.retrying || undefined}
                        unavailable={p.retrying ? '正在重试…' : p.runningJobIds.has(round.user.jobId!) && '这一轮还在跑，等它结束再重试'} onClick={() => p.onRetry!(round.user)}>
                        {p.retrying ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                      </IconButton>
                    )}
                  </div>
                )}
                {/* 发过的参考图（REQ-CORE-012）：URL 是签名的、会过期，取不到就退成一行说明而不是裂图；点开是大图预览（REQ-CORE-026） */}
                {m.attachments.length > 0 && (
                  <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label={`${m.attachments.length} 张参考图`}>
                    {m.attachments.map((a) => {
                      const at = gallery.findIndex((g) => g.id === a.id && g.messageId === m.id);
                      return (
                        <li key={a.id}>
                          <button type="button" aria-label={`查看参考图 ${at + 1} / ${gallery.length}`} data-testid="message-attachment-open"
                            className="block rounded-md transition-opacity duration-[var(--duration-fast)] hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            onClick={(e) => { openerRef.current = e.currentTarget; setViewing({ messageId: m.id, id: a.id }); }}>
                            <img
                              src={a.url} alt="" data-testid="message-attachment"
                              className="size-14 rounded-md border border-line object-cover"
                              onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'text-[11px] text-muted', textContent: '参考图已过期' })); }}
                            />
                          </button>
                        </li>
                      );
                    })}
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
      {viewing && viewerAt >= 0 && <ImageViewer images={gallery} index={viewerAt} onIndex={(i) => setViewing({ messageId: gallery[i].messageId, id: gallery[i].id })} returnTo={openerRef} onClose={() => setViewing(null)} />}
    </aside>
  );
}
