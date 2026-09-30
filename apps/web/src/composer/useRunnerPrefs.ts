import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunnerOptionDto, AgentSessionDto, AgentTool } from '@quilt/core';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type { ComposerMode } from './Composer';

const RUNNER_KEY = 'quilt:runner';
// 投递会话按工具分开记：Claude Code 的会话 id 与 Codex 的线程 id 互不相干，混在一个键里切工具就会带着错的 id（v0.68）
const SESSION_KEY: Record<AgentTool, string> = { 'claude-code': 'quilt:agent-session', codex: 'quilt:agent-session:codex' };
const MODE_KEY = 'quilt:composer-mode';
const read = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };

export type SessionList = { items: AgentSessionDto[] | null; reason?: string };

// 输入框的三个跨会话偏好：生成通道、投递会话、动词模式（造 / 改 ｜ 聊天）。清单来自服务端，选择记在本机。
export function useRunnerPrefs() {
  const toast = useToast();
  // 生成通道（REQ-CORE-011）：清单来自服务端，选择作为跨会话偏好记在本机（INT-007 / INT-021）
  const [runners, setRunners] = useState<RunnerOptionDto[]>([]);
  const [runnerId, setRunnerId] = useState(() => read(RUNNER_KEY));
  // 清单落地只有这一条路径：挂载时取一次，之后由通道管理器在增删改后回传（保住当前选择，它还可用就不动）
  const applyCatalog = useCallback((items: RunnerOptionDto[], defaultId: string) => {
    setRunners(items);
    setRunnerId((cur) => (cur && items.some((x) => x.id === cur && x.available) ? cur : defaultId));
  }, []);
  // 取不到清单要说出来（v0.76）：当成空的话通道选择器整块消失，用户不知道通道去哪了
  const [runnersFailed, setRunnersFailed] = useState(false);
  const loadRunners = useCallback(() => api.runners().then((r) => { setRunnersFailed(false); applyCatalog(r.items, r.default); }).catch(() => setRunnersFailed(true)), [applyCatalog]);
  useEffect(() => { void loadRunners(); }, [loadRunners]);
  // 空值不落（同 onSessionChange）：切「聊天」再切回「造 / 改」时通道清单换批，Radix Select 隐藏的原生 <select> 在那一帧回报 ''，
  // 照写会把选中的通道清掉、下一轮静默走默认通道（v0.74）
  const onRunnerChange = (id: string) => { if (!id) return; setRunnerId(id); try { localStorage.setItem(RUNNER_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const runner = runners.find((r) => r.id === runnerId)?.runner;
  const agentTool = runner?.kind === 'agent' ? runner.tool : null;
  // 投递会话（REQ-AGENT-003 v0.34 / v0.68）：通道是本机 agent 时还要选投给哪个会话，选择按工具跨会话记忆（INT-007 / INT-021）；
  // 列表只在需要时取（通道切到 agent、下拉打开、发送被拒后）、按工具分槽存——检查器可能选了另一个工具，两边各看各的；
  // 记住的会话不在列表里就当没选——不自动换人
  const [lists, setLists] = useState<Record<AgentTool, SessionList>>({ 'claude-code': { items: null }, codex: { items: null } });
  const [sessionIds, setSessionIds] = useState<Record<AgentTool, string>>(() => ({ 'claude-code': read(SESSION_KEY['claude-code']), codex: read(SESSION_KEY.codex) }));
  const loadSessionsFor = useCallback((tool: AgentTool) => api.agentSessions(tool)
    .then((r) => setLists((m) => ({ ...m, [tool]: { items: r.items, reason: r.reason } })))
    .catch(() => { setLists((m) => ({ ...m, [tool]: { items: [] } })); toast('会话列表加载失败', 'error'); }), [toast]);
  // 空值不落：下拉里没有「不选」这一项，空串只会来自 Radix Select 的隐藏原生 <select>——受控值暂时不在选项里时它回报 ''，
  // 照写会把记住的会话冲掉（TC-AGENT-012 实测刷新后记忆丢失）
  const onSessionChange = (id: string) => {
    if (!agentTool || !id) return;
    setSessionIds((m) => ({ ...m, [agentTool]: id }));
    try { localStorage.setItem(SESSION_KEY[agentTool], id); } catch { /* 无痕模式写不了 */ }
  };
  useEffect(() => { if (agentTool) void loadSessionsFor(agentTool); }, [agentTool, loadSessionsFor]);
  const sessionId = agentTool ? sessionIds[agentTool] : '';
  const sessionList: SessionList = agentTool ? lists[agentTool] : { items: null };
  const loadSessions = useCallback(() => { if (agentTool) void loadSessionsFor(agentTool); }, [agentTool, loadSessionsFor]);
  // 发送时把选中的会话填进通道；造缺屏 / 提炼约定这类辅助作业只走模型通道
  const sendRunner = runner?.kind === 'agent' ? { ...runner, sessionId } : runner;
  const modelRunner = runner?.kind === 'agent' ? undefined : runner;
  // 聊天模式（REQ-CORE-023）：动词段控的选择是个人偏好，跨会话记忆（INT-007 / INT-021）；
  // 聊天只能走 agent-sdk 通道——清单收窄到它们，当前通道不是就自动落到第一条可用的，用户没在聊天里换过通道时切回造 / 改还是原来那条
  const [mode, setMode] = useState<ComposerMode>(() => (read(MODE_KEY) === 'chat' ? 'chat' : 'design'));
  const onMode = (m: ComposerMode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 无痕模式写不了 */ } };
  const chatRunners = useMemo(() => runners.filter((r) => r.channelKind === 'agent-sdk'), [runners]);
  const chatRunnerId = chatRunners.some((r) => r.id === runnerId && r.available) ? runnerId : chatRunners.find((r) => r.available)?.id ?? '';
  const chatRunner = chatRunners.find((r) => r.id === chatRunnerId)?.runner;
  return { runners, runnersFailed, loadRunners, runnerId, applyCatalog, onRunnerChange, runner, agentTool, sessionList, sessionId, loadSessions, lists, loadSessionsFor, onSessionChange, sendRunner, modelRunner, mode, onMode, chatRunners, chatRunnerId, chatRunner };
}
