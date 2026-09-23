import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunnerOptionDto, AgentSessionDto } from '@quilt/core';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type { ComposerMode } from './Composer';

const RUNNER_KEY = 'quilt:runner';
const SESSION_KEY = 'quilt:agent-session';
const MODE_KEY = 'quilt:composer-mode';

// 输入框的三个跨会话偏好：生成通道、投递会话、动词模式（造 / 改 ｜ 聊天）。清单来自服务端，选择记在本机。
export function useRunnerPrefs() {
  const toast = useToast();
  // 生成通道（REQ-CORE-011）：清单来自服务端，选择作为跨会话偏好记在本机（INT-007 / INT-021）
  const [runners, setRunners] = useState<RunnerOptionDto[]>([]);
  const [runnerId, setRunnerId] = useState(() => { try { return localStorage.getItem(RUNNER_KEY) ?? ''; } catch { return ''; } });
  // 清单落地只有这一条路径：挂载时取一次，之后由通道管理器在增删改后回传（保住当前选择，它还可用就不动）
  const applyCatalog = useCallback((items: RunnerOptionDto[], defaultId: string) => {
    setRunners(items);
    setRunnerId((cur) => (cur && items.some((x) => x.id === cur && x.available) ? cur : defaultId));
  }, []);
  useEffect(() => { api.runners().then((r) => applyCatalog(r.items, r.default)).catch(() => {}); }, [applyCatalog]);
  const onRunnerChange = (id: string) => { setRunnerId(id); try { localStorage.setItem(RUNNER_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const runner = runners.find((r) => r.id === runnerId)?.runner;
  // 投递会话（REQ-AGENT-003 v0.34）：通道是「交给本机 Claude Code」时还要选投给哪个会话，选择跨会话记忆（INT-007 / INT-021）；
  // 列表只在需要时取（通道切到 agent、下拉打开、发送被拒后），记住的会话不在列表里就当没选——不自动换人
  const [sessions, setSessions] = useState<AgentSessionDto[] | null>(null);
  const [sessionId, setSessionId] = useState(() => { try { return localStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; } });
  const loadSessions = useCallback(() => api.agentSessions().then((r) => setSessions(r.items)).catch(() => { setSessions([]); toast('会话列表加载失败', 'error'); }), [toast]);
  const onSessionChange = (id: string) => { setSessionId(id); try { localStorage.setItem(SESSION_KEY, id); } catch { /* 无痕模式写不了 */ } };
  useEffect(() => { if (runner?.kind === 'agent') void loadSessions(); }, [runner?.kind, loadSessions]);
  // 发送时把选中的会话填进通道；造缺屏 / 提炼约定这类辅助作业只走模型通道
  const sendRunner = runner?.kind === 'agent' ? { ...runner, sessionId } : runner;
  const modelRunner = runner?.kind === 'agent' ? undefined : runner;
  // 聊天模式（REQ-CORE-023）：动词段控的选择是个人偏好，跨会话记忆（INT-007 / INT-021）；
  // 聊天只能走 agent-sdk 通道——清单收窄到它们，当前通道不是就自动落到第一条可用的，用户没在聊天里换过通道时切回造 / 改还是原来那条
  const [mode, setMode] = useState<ComposerMode>(() => { try { return localStorage.getItem(MODE_KEY) === 'chat' ? 'chat' : 'design'; } catch { return 'design'; } });
  const onMode = (m: ComposerMode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 无痕模式写不了 */ } };
  const chatRunners = useMemo(() => runners.filter((r) => r.channelKind === 'agent-sdk'), [runners]);
  const chatRunnerId = chatRunners.some((r) => r.id === runnerId && r.available) ? runnerId : chatRunners.find((r) => r.available)?.id ?? '';
  const chatRunner = chatRunners.find((r) => r.id === chatRunnerId)?.runner;
  return { runners, runnerId, applyCatalog, onRunnerChange, runner, sessions, sessionId, loadSessions, onSessionChange, sendRunner, modelRunner, mode, onMode, chatRunners, chatRunnerId, chatRunner };
}
