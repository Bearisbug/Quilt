import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { X } from 'lucide-react';
import { failureText, type JobDto, type RunnerOptionDto } from '@quilt/core/browser';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, IconButton, Panel, Spinner } from '@/ui/ui';
import { VendorIcon } from '@/ui/VendorIcon';
import { jobLabel } from '@/canvas/jobs';
import { getLocale, intlLocale, useT } from '@/i18n';
import panelsMessages from '@/i18n/locales/panels-design';
import commonMessages from '@/i18n/locales/common';

// 本机 agent 面板（§13 v0.34 / REQ-AGENT-003）：runner=agent 的作业列表——投递到哪个会话、指令、目标屏、状态、
// 会话收口时的摘要或失败原因；运行中的可取消（只标作业，会话那边的活由用户自己在终端叫停）。派活入口只有输入框的通道下拉与会话下拉。
// 状态标签：语义色 12% 底 + 语义色字，中性的用填充底（brand/DESIGN.md「控件形态」）；名字在 panels-design 的 agentJobs.status.<状态>
const STATUS: Record<JobDto['status'], string> = {
  queued: 'fill text-text-secondary',
  running: 'tint-link',
  succeeded: 'tint-success',
  failed: 'tint-error',
  cancelled: 'fill text-text-secondary',
};
// 目录里本机 agent 的名字与提示是服务端按请求语言给的：去掉「交给本机」前缀只留工具名；提示是缺省的「本机 CLI」（没读到版本号）时不重复显示
const AGENT_LABEL_PREFIX = /^(交给本机|Hand to local) /;
const LOCAL_CLI_HINTS = ['本机 CLI', 'Local CLI'];
type Input = { prompt?: string; screenIds?: string[]; componentId?: string; runner?: { kind: string; tool?: string; sessionId?: string } };
type Output = { screenIds?: string[]; component?: string; delivery?: { tool?: string; sessionId: string; name: string; deliveredAt: string; opened?: boolean; openError?: string }; summary?: string; message?: string; errorClass?: string } | null;
// 失败原因：作业里存的是中文规范形或会话自己写的原因，中文界面原样显示。英文界面遇到中文原因由 failureText 换成英文（认不得的退回通用原因），
// 只留「什么失败了：为什么」——最后一个「. 」之后那句下一步说的正是本面板
const CJK = /[\u3400-\u9fff]/;
function failedReason(j: JobDto, o: NonNullable<Output>): string {
  const msg = o.message ?? '';
  if (getLocale() !== 'en' || !CJK.test(msg)) return msg;
  const en = failureText(j.kind, o.errorClass ?? 'agent', msg, 0, 'en');
  const i = en.lastIndexOf('. ');
  return i > 0 ? en.slice(0, i + 1) : en;
}
// 有在跑作业时的重取间隔：投递（作业先转 running，会话探活最多 250 ms 之后才落 output.delivery）与收口都要在这个延迟内看到
const POLL_MS = 1500;

export function AgentJobsPanel({ projectId, screens, components, runners, onClose, onChanged }: { projectId: string; screens: { id: string; name: string }[]; components: { id: string; name: string }[]; runners: RunnerOptionDto[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const t = useT(panelsMessages);
  const tc = useT(commonMessages);
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

  const cancel = async (id: string) => { try { await api.jobs.cancel(id); toast(t('agentJobs.cancelled')); } catch { toast(t('agentJobs.cancelFailed'), 'error'); } };
  const agents = runners.filter((r) => r.runner.kind === 'agent');

  return (
    <Panel title={t('agentJobs.title')} actions={<IconButton label={tc('close')} hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton>} className="h-full">
      <div className="scroll min-h-0 flex-1 p-3">
        {agents.length > 0 && (
          <ul className="mb-3 space-y-1.5" data-testid="agent-availability">
            {agents.map((a) => (
              <li key={a.id} className="flex items-start gap-2 type-label">
                <VendorIcon vendor={a.vendor} size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0"><span className="font-medium">{a.label.replace(AGENT_LABEL_PREFIX, '')}</span> {a.available ? <span className="text-text-secondary">{a.hint && !LOCAL_CLI_HINTS.includes(a.hint) ? t('agentJobs.readyWithHint', { hint: a.hint }) : t('agentJobs.ready')}</span> : <span className="text-warning">{t('agentJobs.notInstalled')}</span>}
                  {!a.available && a.setupHint && <details className="mt-0.5 text-text-secondary"><summary className="cursor-pointer select-none">{t('agentJobs.howToInstall')}</summary><p className="mt-1 whitespace-pre-wrap">{a.setupHint}</p></details>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* 重取失败时已列出的作业留在原地：它只是旧了一点，比清空成一条横幅有用 */}
        {error && <p role="alert" className="tint-error mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 type-label"><span>{t('agentJobs.loadFailed')}</span><Button size="sm" onClick={() => void load()}>{tc('retry')}</Button></p>}
        {items === null ? (!error && <div className="h-24"><Spinner /></div>)
        : items.length === 0 ? <EmptyState title={t('agentJobs.emptyTitle')} hint={t('agentJobs.emptyHint')} />
        : (
          <ul className="space-y-2" data-testid="agent-jobs">
            {items.map((j) => {
              const input = j.input as Input; const output = j.output as Output;
              const st = STATUS[j.status];
              const session = output?.delivery?.name ?? input.runner?.sessionId ?? '—';
              const codex = input.runner?.tool === 'codex';
              return (
                <li key={j.id} data-testid="agent-job" data-status={j.status} className="fill rounded-md p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 type-label"><VendorIcon vendor={codex ? 'codex-subscription' : 'anthropic'} size={14} /><span className="truncate font-medium">{codex ? 'Codex' : 'Claude Code'}</span><span className="text-text-secondary">{new Date(j.createdAt).toLocaleTimeString(intlLocale())}</span></span>
                    <span className={`shrink-0 rounded-sm px-1.5 py-0.5 type-caption font-medium ${st}`}>{t(`agentJobs.status.${j.status}`)}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-3 type-label">{input.prompt}</p>
                  {/* 会话名是外部数据：作为对象子节点交给 Trans，在拆完标签之后才填进 <session>，名字里带尖括号也只当文字。
                      变量名不能与标签名相同：Trans 把对象子节点并进组件表，同名会把 <session> 组件顶掉 */}
                  <p className="mt-1 type-caption text-text-secondary">{jobLabel(j, screens, components)} · <Trans ns={panelsMessages.ns} i18nKey="agentJobs.deliveredTo" components={{ session: <span className={`break-all ${output?.delivery?.name && output.delivery.name !== output.delivery.sessionId ? '' : 'font-mono'}`} data-testid="agent-session" /> }}>{{ name: session }}</Trans></p>
                  {/* 排进了队列但没能让桌面版打开线程（REQ-AGENT-003 v0.79）：消息不会自己执行，要用户去 Codex 里打开它 */}
                  {j.status === 'running' && (output?.delivery?.openError
                    ? <p className="mt-1.5 type-caption text-warning" data-testid="agent-line" title={output.delivery.openError}>{t('agentJobs.openFailed')}</p>
                    : <p className="mt-1.5 type-caption text-text-secondary" data-testid="agent-line" title={output?.delivery ? t('agentJobs.finishHint') : undefined}>{output?.delivery ? (output.delivery.opened ? t('agentJobs.deliveredOpened') : t('agentJobs.delivered')) : t('agentJobs.delivering')}</p>)}
                  {j.status === 'failed' && output?.message && <p className="mt-1.5 break-words type-caption text-error">{failedReason(j, output)}</p>}
                  {j.status === 'succeeded' && <p className="mt-1.5 break-words type-caption text-text-secondary">{input.componentId ? (output?.component ? t('agentJobs.componentSynced', { count: output.screenIds?.length ?? 0 }) : t('agentJobs.componentUnchanged')) : output?.screenIds?.length ? t('agentJobs.wroteBack', { count: output.screenIds.length }) : t('agentJobs.noWriteBack')}{output?.summary ? ` · ${output.summary}` : ''}</p>}
                  {(j.status === 'queued' || j.status === 'running') && (
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="danger-ghost" data-testid="cancel-agent-job" onClick={() => cancel(j.id)}>{tc('cancel')}</Button>
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
