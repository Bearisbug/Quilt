import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { JobDto, RunnerOptionDto } from '@quilt/core';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, IconButton, Panel, Spinner } from '@/ui/ui';
import { VendorIcon } from '@/ui/VendorIcon';

// 本机 agent 面板（§13 v0.34 / REQ-AGENT-003）：runner=agent 的作业列表——投递到哪个会话、指令、目标屏、状态、
// 会话收口时的摘要或失败原因；运行中的可取消（只标作业，会话那边的活由用户自己在终端叫停）。派活入口只有输入框的通道下拉与会话下拉。
const STATUS: Record<JobDto['status'], { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'border-line text-muted' },
  running: { label: '运行中', cls: 'border-accent text-accent-strong' },
  succeeded: { label: '完成', cls: 'border-success/60 text-success' },
  failed: { label: '失败', cls: 'border-danger/60 text-danger' },
  cancelled: { label: '已取消', cls: 'border-line text-muted' },
};
type Input = { prompt?: string; screenIds?: string[]; runner?: { kind: string; tool?: string; sessionId?: string } };
type Output = { screenIds?: string[]; delivery?: { sessionId: string; name: string; deliveredAt: string }; summary?: string; message?: string; errorClass?: string } | null;
// 有在跑作业时的重取间隔：投递（作业先转 running，会话探活最多 250 ms 之后才落 output.delivery）与收口都要在这个延迟内看到
const POLL_MS = 1500;

export function AgentJobsPanel({ projectId, screens, runners, onClose, onChanged }: { projectId: string; screens: { id: string; name: string }[]; runners: RunnerOptionDto[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<JobDto[] | null>(null);
  const [error, setError] = useState(false);
  // 轮询、重试、换项目都可能让多个请求同时在飞：只认最后发出的那次，陈旧响应不许盖回来
  const reqRef = useRef(0);
  const load = useCallback(() => { const seq = ++reqRef.current; return api.projects.jobs(projectId, 'agent').then((r) => { if (seq === reqRef.current) { setItems(r.items); setError(false); } }).catch(() => { if (seq === reqRef.current) setError(true); }); }, [projectId]);
  useEffect(() => { setItems(null); void load(); }, [load]);
  // 进行中的作业靠重取推进，不按作业各开一条事件流：浏览器对同源 HTTP/1.1 只给 6 条并发、所有标签页共用，
  // 同项目几个 agent 作业同时跑就能占满，之后普通请求全部排队（§16 连接预算）。「已投递」读作业自己的
  // output.delivery（投递时落库），不另存一份前端状态。
  const activeKey = (items ?? []).filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id).join(',');
  useEffect(() => {
    // 取回失败就停下，出口是错误横幅那颗「重试」——网络断着时每 1.5 s 空打一次没有意义
    if (!activeKey || error) return;
    const tick = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(tick, POLL_MS);
    // 后台标签页的定时器被节流到分钟级，回到前台立刻补一拍，不等下一拍
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [activeKey, error, load]);
  // 有作业收口：会话那边已经经 MCP 回写过屏，让画布重取
  const activeRef = useRef<string[]>([]);
  useEffect(() => {
    const ids = activeKey ? activeKey.split(',') : [];
    if (activeRef.current.some((id) => !ids.includes(id))) onChanged();
    activeRef.current = ids;
  }, [activeKey, onChanged]);

  const cancel = async (id: string) => { try { await api.jobs.cancel(id); toast('已取消；会话那边如果还在做，去终端里叫停它'); } catch { toast('取消失败', 'error'); } };
  const nameOf = (id: string) => screens.find((s) => s.id === id)?.name ?? '（已删除的屏）';
  const agents = runners.filter((r) => r.runner.kind === 'agent');

  return (
    <Panel title="本机 agent" actions={<IconButton label="关闭" hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton>} className="h-full">
      <div className="scroll min-h-0 flex-1 p-3">
        {agents.length > 0 && (
          <ul className="mb-3 space-y-1.5" data-testid="agent-availability">
            {agents.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-xs">
                <VendorIcon vendor={a.vendor} size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0"><span className="font-medium">{a.label.replace(/^交给本机 /, '')}</span> {a.available ? <span className="text-muted">已就绪{a.hint && a.hint !== '本机 CLI' ? ` · ${a.hint}` : ''} · 投给哪个会话在输入框旁选</span> : <span className="text-warn">未安装</span>}
                  {!a.available && a.setupHint && <details className="mt-0.5 text-muted"><summary className="cursor-pointer select-none">如何安装</summary><p className="mt-1 whitespace-pre-wrap">{a.setupHint}</p></details>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* 重取失败时已列出的作业留在原地：它只是旧了一点，比清空成一条横幅有用 */}
        {error && <p role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger"><span>作业列表加载失败</span><Button size="sm" onClick={() => void load()}>重试</Button></p>}
        {items === null ? (!error && <div className="h-24"><Spinner /></div>)
        : items.length === 0 ? <EmptyState title="还没有交给本机 agent 的作业" hint="在输入框的通道下拉里选「交给本机 Claude Code」，再在旁边选要投递的会话，发出的作业会在这里显示状态。" />
        : (
          <ul className="space-y-2" data-testid="agent-jobs">
            {items.map((j) => {
              const input = j.input as Input; const output = j.output as Output;
              const st = STATUS[j.status];
              const targets = input.screenIds ?? [];
              const session = output?.delivery?.name ?? input.runner?.sessionId ?? '—';
              return (
                <li key={j.id} data-testid="agent-job" data-status={j.status} className="rounded-md border border-line p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs"><VendorIcon vendor="anthropic" size={14} /><span className="truncate font-medium">Claude Code</span><span className="text-muted">{new Date(j.createdAt).toLocaleTimeString()}</span></span>
                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-xs">{input.prompt}</p>
                  <p className="mt-1 text-[11px] text-muted">{targets.length ? `改 ${targets.map(nameOf).join('、')}` : '造新屏'} · 投递到「<span className={`break-all ${output?.delivery?.name && output.delivery.name !== output.delivery.sessionId ? '' : 'font-mono'}`} data-testid="agent-session">{session}</span>」</p>
                  {j.status === 'running' && <p className="mt-1.5 text-[11px] text-muted" data-testid="agent-line">{output?.delivery ? '已投递，等会话收口（quilt.finish_job）' : '正在投递…'}</p>}
                  {j.status === 'failed' && output?.message && <p className="mt-1.5 break-words text-[11px] text-danger">{output.message}</p>}
                  {j.status === 'succeeded' && <p className="mt-1.5 break-words text-[11px] text-muted">{output?.screenIds?.length ? `回写了 ${output.screenIds.length} 屏` : '没有回写屏幕'}{output?.summary ? ` · ${output.summary}` : ''}</p>}
                  {(j.status === 'queued' || j.status === 'running') && (
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="danger" data-testid="cancel-agent-job" onClick={() => cancel(j.id)}>取消</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
