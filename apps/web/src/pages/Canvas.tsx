import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowLeft, Bot, Component, Crosshair, Download, GalleryHorizontal, GalleryVertical, History, Link2, Maximize2, MessageSquarePlus, Palette, Plus, Star, TextCursorInput, Trash2, Waypoints, X } from 'lucide-react';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, DEVICE_SIZE, type ProjectDetailDto, type MessageDto, type JobDto, type JobEventDto, type ScreenDto, type ComponentDto, type Tokens, type RunnerOptionDto, type AgentSessionDto, type Runner, type ScreenCount, type DesignProposalDto } from '@quilt/core';
import { api, ApiError, loadConfig, subscribeProjectEvents } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, IconButton, Input, Spinner } from '../components/ui';
import { Overlay, useModal } from '../components/modal';
import { TopNav } from '../components/TopNav';
import { ProjectSwitcher } from '../components/ProjectSwitcher';
import { SettingsModal } from '../components/SettingsModal';
import { CanvasView } from '../components/CanvasView';
import { CanvasToolbar, type Tool } from '../components/CanvasToolbar';
import { isSettingsSection, type SettingsSection } from '../components/SettingsModal';
import { ChatDock } from '../components/ChatDock';
import { Composer, type ComposerHandle, type ComposerMode } from '../components/Composer';
import { CandidateStack } from '../components/CandidateStack';
import { RevisionPanel, DesignPanel, InspectorPanel, AnnotationPanel, ProposalDialog, type ElementSel } from '../components/SidePanels';
import { AgentJobsPanel } from '../components/AgentJobsPanel';

type Panel = 'revisions' | 'design' | 'inspect' | 'annotate' | 'agent' | null;
const CHAT_KEY = 'quilt:chat-collapsed';
const RUNNER_KEY = 'quilt:runner';
const SESSION_KEY = 'quilt:agent-session';
const MODE_KEY = 'quilt:composer-mode';
const ICON = 18;
const MAX_TARGETS = 20; // API-CORE-010 契约上限
// 造屏名额是项目级的（REQ-CORE-020）：锚点造屏、工具栏「新建屏幕」、断链补屏建的都是 generate，互相排队但不挡改屏
const GENERATE_BUSY = '上一批屏还在造，等它落地再造下一批';
// 聊天回合逐个串行（REQ-CORE-023）：一个项目一条会话
const CHAT_BUSY = '上一句还在回答，等它说完';
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const ALT = MAC ? '⌥' : 'Alt+';
const CMD = MAC ? '⌘' : 'Ctrl+';
// 排列条的按钮（REQ-CORE-018）：六个对齐 + 两个等距 + 两个排列（v0.52），数组顺序就是方向键在工具条里移动的顺序
const ALIGN_BTNS = [['left', '左对齐', AlignStartVertical], ['hcenter', '水平居中', AlignCenterVertical], ['right', '右对齐', AlignEndVertical], ['top', '上对齐', AlignStartHorizontal], ['vcenter', '垂直居中', AlignCenterHorizontal], ['bottom', '下对齐', AlignEndHorizontal]] as const;
const SPACE_BTNS = [['hspace', '横向等距', AlignHorizontalDistributeCenter], ['vspace', '纵向等距', AlignVerticalDistributeCenter]] as const;
const LAYOUT_BTNS = [['hrow', '排成一行', GalleryHorizontal], ['vcol', '排成一列', GalleryVertical]] as const;
const ARRANGE_N = ALIGN_BTNS.length + SPACE_BTNS.length + LAYOUT_BTNS.length;
// 排成一行 / 一列的固定间距：与造屏落位（worker 的 layoutNewScreens）同一个数，一键摆出来的和生成出来的一样宽松
const LAYOUT_GAP = 80;

type JobInput = { count?: ScreenCount; versions?: number; screenIds?: string[] | 'all'; screenId?: string; fromScreenId?: string; prompt?: string; componentId?: string; componentIds?: string[] };
// 一个在跑作业会改到哪些屏（REQ-CORE-020）。JobDto 不带 targetScreenId，只能按 kind 从 input 反推；
// 口径与 apps/api/src/services/jobs.ts 的守卫对齐，但比它严：多屏 edit_screens 与回刷在后端落 target_screen_id=null，
// 后端看不见它们实际改的屏（§16 真值表的缺口行），撞上的后果是一方作业 failed 或静默顶掉对方，所以前端按覆盖屏集拦。
function coveredScreens(job: JobDto, allIds: string[], components: ComponentDto[] = []): string[] {
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
// 在跑作业行的文案（REQ-CORE-020）：沿用输入框动词行的口径说「这个作业在做什么」
function jobLabel(job: JobDto, screens: ScreenDto[], components: ComponentDto[]): string {
  const i = job.input as JobInput;
  const name = (id: string | undefined) => screens.find((s) => s.id === id)?.name ?? '已删除的屏';
  const ver = (i.versions ?? 1) > 1 ? ` × ${i.versions} 版` : '';
  switch (job.kind) {
    case 'generate': return `造${i.count === undefined || i.count === 'auto' ? '一组屏' : ` ${i.count} 屏`}${ver}`;
    case 'edit_screens': {
      const ids = coveredScreens(job, screens.map((s) => s.id));
      return `改${ids.length === 1 ? `「${name(ids[0])}」` : screens.length > 0 && ids.length >= screens.length ? `全部 ${ids.length} 屏` : ` ${ids.length} 屏`}${ver}`;
    }
    case 'regenerate_subtree': return `重做「${name(i.screenId)}」的一块`;
    case 'apply_design_system': return i.screenIds === 'all' ? '回刷所有屏' : `回刷 ${(i.screenIds ?? []).length} 屏`;
    case 'propose_design_system': return '提炼约定';
    case 'export_prototype': return '打包原型';
    case 'ingest_screen': return `写入「${name(i.screenId)}」`;
    // 聊天（REQ-CORE-023）：范围要等助手看完才知道，行上只写这句话的开头
    case 'chat': { const q = i.prompt ?? ''; return `聊「${q.length > 20 ? `${q.slice(0, 20)}…` : q}」`; }
    case 'edit_component': return `改组件「${components.find((c) => c.id === i.componentId)?.name ?? '已删除的组件'}」`;
  }
}
// 新建组件时的占位内容（REQ-EDIT-006）：建完立刻在输入框里描述它，第一句「改组件」就把它写出来
const NEW_COMPONENT_HTML = '<div class="p-4 text-sm text-on-surface-variant">New component</div>';
// 画布上一张卡（屏或组件）的位置，位置写回与撤销栈都用它
type PosEntry = { id: string; x: number; y: number };

// PAGE-CANVAS：画布 + 对话 + 修订/设计系统/检查器面板（面板状态进 URL，INT-020）
export function CanvasPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  // 在跑作业是一组（REQ-CORE-020）：后端允许并行，前端跟踪全部非 agent 作业，进度按 jobId 分别记
  const [activeJobs, setActiveJobs] = useState<JobDto[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  // 预览域地址来自运行时配置（API-CORE-028）：打包后是 127.0.0.1:3101，开发是 preview.localhost:3101
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  useEffect(() => { loadConfig().then((c) => setPreviewOrigin(c.previewOrigin)).catch(() => toast('运行时配置加载失败', 'error')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 目标标签（REQ-CORE-006）与画布选中是两个状态：选中变化会写进目标，但清空选中（点空白 / Esc）不动目标。
  // 目标只经标签 × 与「清空」减少——发完一条、点空白看结果、追加指令，是最高频的用法，标签一清就会误造一张新屏。
  const [targetIds, setTargetIds] = useState<string[]>([]);
  // 共享组件（REQ-EDIT-006）：选中与目标各一份，规则与屏完全一致——选中即目标，清空选中不清目标
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [targetComponentIds, setTargetComponentIds] = useState<string[]>([]);
  const [newComponentOpen, setNewComponentOpen] = useState(false);
  // 锚点（REQ-CORE-014）：双击空白放下，是「造 · 此处」；点选任何一屏（改）就让位
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [count, setCount] = useState<ScreenCount>(1);
  const [versions, setVersions] = useState(1);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // 组件卡的交互态（REQ-EDIT-006）：与屏的聚焦互斥——两边都是「活 iframe 吃掉指针」，同时开会分不清点的是谁
  const [focusedComponentId, setFocusedComponentId] = useState<string | null>(null);
  const [navStack, setNavStack] = useState<string[]>([]);
  const [zoom, setZoom] = useState(0.5);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [missing, setMissing] = useState<{ fromScreenId: string; hrefs: string[] } | null>(null);
  // 候选就地展开（REQ-CORE-015）：一次只展开一屏；展开层不是弹窗，不拦画布快捷键，只吃 Esc
  const [candidates, setCandidates] = useState<{ jobId: string; screenId: string } | null>(null);
  // 设计系统提案（REQ-EDIT-003）：propose_design_system 作业成功后弹预览，确认才写入
  const [proposal, setProposal] = useState<DesignProposalDto | null>(null);
  const [elementSel, setElementSel] = useState<ElementSel | null>(null);
  const canvasApi = useRef<{ fitView: () => void; goBack: () => void; highlight: (qid: string | null) => void; focus: (id: string) => void; resetToOwn: () => void; createAtCenter: () => void; markDone: (qids: string[]) => void } | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);
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
  const panel = (params.get('panel') as Panel) ?? null;
  const setPanel = useCallback((v: Panel) => setParams((q) => { if (v) q.set('panel', v); else q.delete('panel'); return q; }, { replace: true }), [setParams]);
  // 设置弹层的开关与当前节都在 URL 上（?settings=<节>，INT-020）：刷新保持，旧 /settings 路径重定向到这里；不认识的值回到第一节
  const settingsParam = params.get('settings');
  const settingsSection: SettingsSection | null = settingsParam ? (isSettingsSection(settingsParam) ? settingsParam : 'usage') : null;
  const setSettings = useCallback((v: SettingsSection | null) => setParams((q) => { if (v) q.set('settings', v); else q.delete('settings'); return q; }, { replace: true }), [setParams]);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  // 批注态与选择元素态共用屏内的 inspect 运行时（都靠点元素），但面板与去向不同
  // 选择元素 / 批注是**全局模式**：先开模式（不必先选中某一屏），再点任意一屏进去。
  // armed = 模式已开；进到某一屏（focusedId）之后才谈得上把 inspect 下发给屏内运行时。
  const inspectArmed = panel === 'inspect';
  const annotateArmed = panel === 'annotate';
  const annotateMode = annotateArmed && !!focusedId;
  // 组件卡也能选元素（v0.57）：它跑同一套运行时，qid 落在组件自己的 HTML 上
  const inspectMode = (inspectArmed || annotateArmed) && (!!focusedId || !!focusedComponentId);

  const refreshMessages = useCallback(() => api.projects.messages(projectId).then((r) => setMessages(r.items)).catch(() => {}), [projectId]);
  // 进行中作业的终态由 SSE 事件宣告；refresh 负责与后端对账：先剔除已经结束的（事件流与刷新之间的竞态会丢终态），
  // 再认领还没跟踪的（首次加载、MCP / 另一个标签页建的作业）。runner=agent 的作业由本机 agent 面板跟踪，不进这里（ADR-015）。
  // finishedRef 记住已宣告终态的 jobId：早于终态发出、晚于终态返回的那次 GET 还会列着它，没有这道白名单会把死作业重新认领回来
  // （行上带取消键的幽灵作业，且新订阅从 seq 0 重放会把 succeeded 再处理一次——导出作业等于二次下载）。
  const activeJobsRef = useRef<JobDto[]>([]);
  activeJobsRef.current = activeJobs;
  const finishedRef = useRef(new Set<string>());
  const seenRef = useRef(new Set<string>());
  // 每个作业开始跟踪那一刻的屏集合：generate 成功后用它从结果里挑出「这一轮新造的屏」
  const beforeRef = useRef(new Map<string, Set<string>>());
  // 刚写出去、服务端还没回声的坐标（拖动与排列，REQ-CORE-018）：项目级事件流每来一条事件就刷新，
  // 那次 GET 可能早于排列发出、晚于它落地才回来，这份旧快照整份写进 detail 就把排好的位置顶回去，
  // 而此后没有任何路径再纠正它（PATCH 已经 200）。所以坐标在服务端跟上之前归本地，跟上即出栈。
  const dirtyPos = useRef(new Map<string, { x: number; y: number }>());
  // 组件卡的坐标同一套竞态、同一套处理（REQ-EDIT-006）
  const dirtyCompPos = useRef(new Map<string, { x: number; y: number }>());
  const refresh = useCallback(async () => {
    try {
      const d = await api.projects.get(projectId);
      for (const [id, p] of dirtyPos.current) { const s = d.screens.find((x) => x.id === id); if (!s || (s.x === p.x && s.y === p.y)) dirtyPos.current.delete(id); }
      for (const [id, p] of dirtyCompPos.current) { const c = d.components.find((x) => x.id === id); if (!c || (c.x === p.x && c.y === p.y)) dirtyCompPos.current.delete(id); }
      setDetail({
        ...d,
        screens: dirtyPos.current.size ? d.screens.map((s) => ({ ...s, ...dirtyPos.current.get(s.id) })) : d.screens,
        components: dirtyCompPos.current.size ? d.components.map((c) => ({ ...c, ...dirtyCompPos.current.get(c.id) })) : d.components,
      });
      const live = new Set(d.activeJobs.map((j) => j.id));
      for (const id of live) seenRef.current.add(id);
      // 只剔除服务端确认过（某次 GET 列出过）的作业：刚建的作业可能还没进这次 GET 的快照，
      // 无条件剔除会让它的行闪一下又回来，重连的订阅还会从 seq 0 重放一遍
      // 换项目时上一个项目的作业一律剔除：路由是同一个 /p/:projectId，组件不卸载，否则它会留着行、占着 busy 与造屏名额，Esc 还会取消别的项目的作业
      const gone = activeJobsRef.current.filter((j) => j.projectId !== projectId || (!live.has(j.id) && seenRef.current.has(j.id)));
      if (gone.length) {
        const dead = new Set(gone.map((j) => j.id));
        setActiveJobs((prev) => prev.filter((j) => !dead.has(j.id)));
        setProgress((m) => { const next = { ...m }; for (const id of dead) delete next[id]; return next; });
        for (const id of dead) seenRef.current.delete(id);
        refreshMessages();
      }
      const tracked = new Set(activeJobsRef.current.map((j) => j.id));
      const claim = d.activeJobs.filter((j) => j.runner !== 'agent' && !tracked.has(j.id) && !finishedRef.current.has(j.id));
      if (claim.length) {
        for (const j of claim) if (!beforeRef.current.has(j.id)) beforeRef.current.set(j.id, new Set(d.screens.map((x) => x.id)));
        setActiveJobs((prev) => [...prev, ...claim.filter((j) => !prev.some((x) => x.id === j.id))]);
      }
      // 后端不再列出的作业不会再被认领，白名单到此为止——不让它随会话无声长大
      for (const id of finishedRef.current) if (!live.has(id)) finishedRef.current.delete(id);
      return d;
    } catch (e) { toast(e instanceof ApiError ? e.problem.title : '项目加载失败', 'error'); return null; }
  }, [projectId, toast, refreshMessages]);

  useEffect(() => { refresh(); refreshMessages(); }, [refresh, refreshMessages]);
  // 浏览器标签页写项目名：多个项目开在不同标签页时靠它分辨
  const projectName = detail?.project.name;
  useEffect(() => { document.title = projectName ? `${projectName} · Quilt` : 'Quilt'; return () => { document.title = 'Quilt'; }; }, [projectName]);

  const screens = detail?.screens ?? [];
  const screensRef = useRef(screens);
  screensRef.current = screens;

  // 作业事件（API-CORE-008）：变更即刷新项目（防抖），终态刷新消息；导出作业成功后自动下载；
  // 造完自动选中新屏（追加指令直接是改）；设计系统提案成功后弹预览
  const refreshTimer = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; refresh(); }, 250); }, [refresh]);
  // 项目级事件（API-CORE-030 v0.34）：本机会话经 MCP 回写、别处建的作业、截图就绪都会到这里——刷新项目（聚焦中的屏走热更新），作业终态再刷消息
  // 一个标签页只开这一条长连接（API-CORE-030 / §16 连接预算）：浏览器对同源 HTTP/1.1 只给 6 条并发、
  // 且所有标签页共用，按作业各开一条的话多开两三个项目就把额度占满、普通请求全部排队。
  useEffect(() => subscribeProjectEvents(projectId, (e) => {
    scheduleRefresh();
    if (e.type !== 'job_changed') return;
    const p = e.data as { jobId?: string; type?: string; seq?: number; data?: unknown } | undefined;
    if (!p?.jobId || !p.type) return;
    if (['succeeded', 'failed', 'cancelled'].includes(p.type)) refreshMessages();
    const job = activeJobsRef.current.find((j) => j.id === p.jobId);
    // 别处建的作业（本机会话投递、另一个标签页发的）本页没跟踪，上面的整体重取已经覆盖
    if (job) onJobEvent.current(job, { type: p.type as JobEventDto['type'], data: p.data ?? {}, seq: p.seq ?? 0, at: e.at });
  }), [projectId, scheduleRefresh, refreshMessages]);
  // 处理器放 ref：闭包每帧刷新，订阅不动
  const onJobEvent = useRef<(job: JobDto, e: JobEventDto) => void>(() => {});
  onJobEvent.current = (job, e) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const setP = (text: string) => setProgress((m) => ({ ...m, [job.id]: text }));
    // 聊天作业的进度是助手每次工具调用的一句话（REQ-CORE-023）
    // 改组件（REQ-EDIT-006）：模型回来后先确定性回刷用它的屏，再逐屏截图
    if (e.type === 'progress') setP(d.stage === 'chat' && typeof d.step === 'string' ? d.step : d.stage === 'retry' ? `供应商波动，正在重试（第 ${d.attempt} 次）…` : d.stage === 'component_synced' ? `已同步 ${d.screens ?? 0} 屏，正在截图…` : d.stage === 'running' ? (job.kind === 'chat' ? '助手在想…' : job.kind === 'edit_component' ? '正在改组件…' : job.kind === 'export_prototype' ? '正在打包原型…' : job.kind === 'apply_design_system' ? '正在回刷屏幕…' : job.kind === 'propose_design_system' ? '正在提炼约定…' : job.kind === 'edit_screens' || job.kind === 'regenerate_subtree' ? '正在改屏…' : '正在规划屏幕…') : d.stage === 'exported' ? '打包完成' : '排队中…');
    if (e.type === 'screen_planned') { setP(`正在生成「${d.name}」…`); scheduleRefresh(); }
    if (e.type === 'screen_html_ready') { setP('正在截图…'); scheduleRefresh(); }
    if (e.type === 'screen_screenshot_ready') scheduleRefresh();
    if (e.type === 'succeeded' || e.type === 'failed' || e.type === 'cancelled') {
      finishedRef.current.add(job.id);
      seenRef.current.delete(job.id);
      const before = beforeRef.current.get(job.id) ?? new Set<string>();
      beforeRef.current.delete(job.id);
      setActiveJobs((prev) => prev.filter((j) => j.id !== job.id));
      setProgress((m) => { const next = { ...m }; delete next[job.id]; return next; });
      refresh(); refreshMessages();
      if (e.type === 'failed') toast(`${job.kind === 'chat' ? '回答失败' : '生成失败'}：${d.message ?? d.errorClass ?? ''}`, 'error');
      if (e.type === 'succeeded' && job.kind === 'export_prototype') { toast('原型已导出，开始下载'); window.location.assign(api.exportUrl(job.id)); }
      if (e.type === 'succeeded' && job.kind === 'generate') {
        const fresh = ((d.screenIds as string[] | undefined) ?? []).filter((id) => !before.has(id));
        // 只在目标为空时接管（INT-008）：一批屏在造、同时手动选了另一张屏要改，是 REQ-CORE-020 的主场景，
        // 这一落地把药丸换成新屏就等于把用户写好的指令改投到刚造出来的屏上
        if (fresh.length && !targetIds.length) { setSelectedIds(fresh); setTargetIds(fresh); }
      }
      // 提案本体不走项目频道（pg_notify 有 8000 字节上限，投影只送屏 id），要用时另取作业产出
      if (e.type === 'succeeded' && job.kind === 'propose_design_system') {
        void api.jobs.get(job.id).then(({ job: full }) => {
          const proposal = (full.output as { proposal?: DesignProposalDto } | null)?.proposal;
          if (proposal) { setProposal(proposal); setPanel('design'); }
        }).catch(() => toast('提案取不回来了，重新说一次', 'error'));
      }
    }
  };
  // 选中变化 → 写进目标并清掉锚点（选中即改）；清空选中不动目标
  useEffect(() => { if (selectedIds.length) { setTargetIds(selectedIds); setAnchor(null); } }, [selectedIds]);
  useEffect(() => { if (selectedComponentIds.length) { setTargetComponentIds(selectedComponentIds); setAnchor(null); } }, [selectedComponentIds]);
  // 屏数档位的默认值（REQ-CORE-003）：空项目默认「自动」（规划器定 4–6 屏主流程），有屏之后默认 1；只在空 ↔ 非空切换时重置
  const empty = !!detail && screens.length === 0;
  useEffect(() => { if (detail) setCount(empty ? 'auto' : 1); }, [detail?.project.id, empty]); // eslint-disable-line react-hooks/exhaustive-deps
  // 选中集合即上下文；「恰好一屏」另算，修订链等单屏概念只在这种情况下成立
  const selectedScreens = useMemo(() => screens.filter((s) => selectedIds.includes(s.id)), [screens, selectedIds]);
  const selected = selectedScreens.length === 1 ? selectedScreens[0] : null;
  const targetScreens = useMemo(() => screens.filter((s) => targetIds.includes(s.id)), [screens, targetIds]);
  const components = detail?.components ?? [];
  const selectedComponents = useMemo(() => components.filter((c) => selectedComponentIds.includes(c.id)), [components, selectedComponentIds]);
  const targetComponents = useMemo(() => components.filter((c) => targetComponentIds.includes(c.id)), [components, targetComponentIds]);
  // 屏与组件是同一个选区（INT-015 单一状态源）：非加选地点哪一种，另一种就清空；点空白两种都清
  const setSelectedId = useCallback((id: string | null, additive = false) => {
    if (!id) { setSelectedIds([]); setSelectedComponentIds([]); return; }
    setSelectedIds((prev) => (!additive ? [id] : prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (!additive) setSelectedComponentIds([]);
  }, []);
  const setSelectedComponentId = useCallback((id: string, additive: boolean) => {
    setSelectedComponentIds((prev) => (!additive ? [id] : prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (!additive) setSelectedIds([]);
  }, []);
  const focused = useMemo(() => screens.find((s) => s.id === focusedId) ?? null, [screens, focusedId]);
  const tokens = detail?.designSystem.tokens as Tokens | undefined;
  // 正在被子树重生成作业改的元素（REQ-EDIT-002）：来自项目的进行中作业，卡片与聚焦屏内都标出来；检查器据此挡住重复发起
  const workingSubtrees = useMemo(() => (detail?.activeJobs ?? []).filter((j) => j.kind === 'regenerate_subtree').map((j) => { const i = j.input as { screenId: string; qid: string }; return { screenId: i.screenId, qid: i.qid }; }), [detail?.activeJobs]);

  // 冲突判定读的是全部在跑作业（REQ-CORE-020）：项目详情里那份含 runner=agent（它同样持屏锁）与别处建的，
  // 再并上本页刚建、还没回到详情里的那些——否则连点两次会在同一屏上撞出 409。
  const guardJobs = useMemo(() => {
    const m = new Map<string, JobDto>();
    for (const j of detail?.activeJobs ?? []) m.set(j.id, j);
    for (const j of activeJobs) if (!m.has(j.id)) m.set(j.id, j);
    return [...m.values()];
  }, [detail?.activeJobs, activeJobs]);
  // 哪些屏被在跑作业占着；哪个作业占着项目级的造屏名额
  const busyScreens = useMemo(() => {
    const ids = screens.map((s) => s.id);
    return new Set(guardJobs.flatMap((j) => coveredScreens(j, ids, components)));
  }, [guardJobs, screens, components]);
  // 正在被 edit_component 作业改的组件：改它的元素会撞版本，检查器先挡住（与屏的 busyScreens 同义）
  const busyComponents = useMemo(() => new Set(guardJobs.filter((j) => j.kind === 'edit_component').map((j) => (j.input as { componentId?: string } | null)?.componentId).filter(Boolean) as string[]), [guardJobs]);
  const focusedComponent = useMemo(() => components.find((c) => c.id === focusedComponentId) ?? null, [components, focusedComponentId]);
  const generating = useMemo(() => guardJobs.find((j) => j.kind === 'generate'), [guardJobs]);
  // 发送前的冲突预判：没有目标 = 造，撞在跑的 generate；有目标 = 改，撞目标屏的占用。其余组合一律放行，后端 409 是最终判据
  // 聊天：一个项目一条会话，只撞在跑的 chat（REQ-CORE-023）
  // 只有组件没有屏也没有锚点 = 改组件（REQ-EDIT-006）：一次一个，且不撞同一组件在跑的 edit_component
  const blockedReason = useMemo(() => {
    if (mode === 'chat') return guardJobs.some((j) => j.kind === 'chat') ? CHAT_BUSY : null;
    const targets = targetScreens.slice(0, MAX_TARGETS);
    if (!targets.length && !anchor && targetComponents.length) {
      if (targetComponents.length > 1) return '一次只能改一个组件，其余先从目标里去掉';
      const c = targetComponents[0];
      return guardJobs.some((j) => j.kind === 'edit_component' && (j.input as JobInput).componentId === c.id) ? `「${c.name}」正在改，等这一轮完事` : null;
    }
    if (!targets.length) return generating ? GENERATE_BUSY : null;
    const hit = targets.filter((s) => busyScreens.has(s.id));
    if (!hit.length) return null;
    return hit.length === 1 ? `「${hit[0].name}」正在改，等这一轮完事` : `选中的 ${hit.length} 屏正在改（含「${hit[0].name}」），等这一轮完事`;
  }, [targetScreens, targetComponents, anchor, busyScreens, generating, mode, guardJobs]);
  // 在跑作业按创建时间倒序：最新的在最上（Esc 取消的就是它，必须始终可见、不被折进「+N」）；时间相同取后加入的那个
  const runningJobs = useMemo(() => [...activeJobs].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [activeJobs]);
  // 进度兜底收在这里：作业刚建、事件还没来时行与折叠横条都要有话说，不能看起来卡住
  const running = useMemo(() => runningJobs.map((j) => ({ id: j.id, label: jobLabel(j, screens, components), progress: progress[j.id] ?? '排队中…' })), [runningJobs, screens, components, progress]);
  // 折叠横条上的一行状态：恰好一个作业在跑时显示它的进度，多个只报条数（逐个的详情在输入框上方那一叠行里）
  const jobStatus = running.length > 1 ? `${running.length} 个作业进行中` : running[0] ? `${running[0].label} · ${running[0].progress}` : null;

  const handleJobError = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中，等它完成再改', 'error');
    else if (e instanceof ApiError && e.type === '/errors/rate-limited') toast('操作太频繁，稍后再试', 'error');
    else toast(e instanceof ApiError ? e.problem.title : fallback, 'error');
  };
  // 追加而不是替换：并行作业各自成行，且 job.input 里带着目标屏，冲突判定不必等下一次 refresh
  const trackJob = (job: JobDto) => {
    if (!beforeRef.current.has(job.id)) beforeRef.current.set(job.id, new Set(screensRef.current.map((s) => s.id)));
    setActiveJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
  };
  const startJob = async (body: unknown, fallback: string) => {
    try {
      const { job } = await api.projects.createJob(projectId, body);
      // 投递到本机会话的作业不进在跑作业行，去 agent 面板看状态
      if (job.runner === 'agent') { refresh(); toast('已投递到本机 Claude Code 会话，在本机 agent 面板看状态'); } else trackJob(job);
      refreshMessages(); return job;
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast('会话已关闭或不存在，重新选一个', 'error'); void loadSessions(); }
      else handleJobError(e, fallback);
      return null;
    }
  };
  // 发送（REQ-CORE-006）：有目标 = 改（targetScreenIds），没有 = 造（count / anchor）；版数两边都带。
  // 返回是否发出去了：没发出去时输入框保留草稿与参考图（REQ-CORE-020）
  // 聊天（REQ-CORE-023）：不看目标，选中的屏只作上下文提示随消息带上；通道用收窄后的那条
  // 共享组件目标（REQ-EDIT-006）：只在造 / 改模式下随消息带上——只有组件没有屏也没有锚点时服务端建的是 edit_component，其余是上下文
  const onSend = async (content: string, attachmentIds: string[] = []): Promise<boolean> => {
    const targets = targetScreens.length ? targetScreens.slice(0, MAX_TARGETS).map((s) => s.id) : undefined;
    const compTargets = targetComponents.length ? targetComponents.map((c) => c.id) : undefined;
    const chat = mode === 'chat';
    try {
      const r = await api.projects.send(projectId, chat
        ? { content, mode: 'chat', targetScreenIds: targets, runner: chatRunner, attachmentIds: attachmentIds.length ? attachmentIds : undefined }
        : { content, targetScreenIds: targets, targetComponentIds: compTargets, count: targets ? undefined : count, versions, anchor: targets ? undefined : anchor ?? undefined, runner: sendRunner, attachmentIds: attachmentIds.length ? attachmentIds : undefined });
      setMessages((m) => [...m, r.userMessage, r.assistantMessage]);
      if (!targets && !chat) setAnchor(null);
      if (r.job.runner === 'agent') { refresh(); setPanel('agent'); }  // 交给本机 agent：已投递到会话，切到 agent 面板看状态
      else trackJob(r.job);
      return true;
    } catch (e) {
      // 记住的会话在发送前关掉了：说清楚并重取列表，下拉会回到「选择会话」
      if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast('会话已关闭或不存在，重新选一个', 'error'); void loadSessions(); }
      // 聊天撞的只有在跑的 chat（别的标签页刚发的那句）
      else if (chat && e instanceof ApiError && e.type === '/errors/screen-busy') { toast(CHAT_BUSY, 'error'); refresh(); }
      // 预判之外真撞上了（别处刚建的作业、多屏改屏的后端缺口）：problem 体不带屏信息，重取项目后用本轮目标 ∩ 覆盖屏集点名
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') {
        const d = await refresh();
        const ids = new Set((d?.activeJobs ?? []).flatMap((j) => coveredScreens(j, (d?.screens ?? []).map((s) => s.id), d?.components ?? [])));
        const hit = targets?.map((id) => (d?.screens ?? []).find((s) => s.id === id)).find((s) => s && ids.has(s.id));
        toast(hit ? `「${hit.name}」正在改，等这一轮完事` : targets ? '目标屏有作业在跑，等它完成再改' : GENERATE_BUSY, 'error');
      }
      else handleJobError(e, '发送失败');
      return false;
    }
  };
  // 取消一个在跑作业：行上的取消键按 id 取消，Esc 取消最新那一个（按一次取消一个）。
  // 记进 finishedRef 防被迟到的 GET 重新认领；行的消失由 cancelled 事件（或下一次对账）宣告
  const cancelJob = async (id: string) => {
    try { await api.jobs.cancel(id); finishedRef.current.add(id); }
    catch (e) {
      // 连按两次会撞上「它已经结束了」，这不是失败，不必打扰用户
      if (e instanceof ApiError && e.type === '/errors/job-finished') return;
      toast('取消失败', 'error');
    }
  };
  const cancelNewest = () => { const j = runningJobs[0]; if (j) void cancelJob(j.id); };
  // 位置撤销栈（v0.41）：拖动与对齐都是一步把屏挪走的动作，错了没有退路——每次动之前把「这几张原来在哪」压栈，⌘Z 逐步还原。
  // 只管位置：屏内容的历史在修订树里，删屏有确认框，都不进这个栈。一步同时记屏与组件（v0.47 整组一起拖、整组一起还原）
  const posUndo = useRef<{ label: string; screens: PosEntry[]; components: PosEntry[] }[]>([]);
  const pushUndo = (label: string, screenIds: string[], componentIds: string[] = []) => {
    const pick = (list: PosEntry[], ids: string[]) => list.filter((x) => ids.includes(x.id)).map(({ id, x, y }) => ({ id, x, y }));
    const entry = { label, screens: pick(screensRef.current, screenIds), components: pick(components, componentIds) };
    if (entry.screens.length || entry.components.length) posUndo.current = [...posUndo.current.slice(-19), entry];
  };
  // 位置写回（INT-019 文档级几何）：本地先行 + 在途坐标，屏与组件各走自己的 PATCH；等全部有结果再决定，
  // 失败的坐标交还服务端、成功的不回滚（口径同排列）。返回没写上的那几张的名字
  const writePositions = async (moved: PosEntry[], movedComps: PosEntry[]) => {
    for (const e of moved) dirtyPos.current.set(e.id, { x: e.x, y: e.y });
    for (const e of movedComps) dirtyCompPos.current.set(e.id, { x: e.x, y: e.y });
    const apply = <T extends PosEntry>(list: T[], entries: PosEntry[]) => (entries.length ? list.map((x) => { const e = entries.find((q) => q.id === x.id); return e ? { ...x, x: e.x, y: e.y } : x; }) : list);
    setDetail((d) => d && { ...d, screens: apply(d.screens, moved), components: apply(d.components, movedComps) });
    const done = await Promise.allSettled([...moved.map((e) => api.screens.patch(e.id, { x: e.x, y: e.y })), ...movedComps.map((e) => api.components.patch(e.id, { x: e.x, y: e.y }))]);
    const failed: string[] = [];
    moved.forEach((e, i) => { if (done[i].status === 'rejected') { dirtyPos.current.delete(e.id); failed.push(screensRef.current.find((s) => s.id === e.id)?.name ?? e.id); } });
    movedComps.forEach((e, i) => { if (done[moved.length + i].status === 'rejected') { dirtyCompPos.current.delete(e.id); failed.push(components.find((c) => c.id === e.id)?.name ?? e.id); } });
    return failed;
  };
  const undoPos = async () => {
    const last = posUndo.current.pop();
    if (!last) { toast('没有可撤销的移动'); return; }
    const failed = await writePositions(last.screens, last.components);
    if (failed.length) { toast('撤销没能全部写回，已重取', 'error'); refresh(); return; }
    toast(`已撤销${last.label}`);
  };
  // 松手落库：单张与整组同一条路（v0.47 多选批量移动）
  const onMove = async (moved: PosEntry[], movedComps: PosEntry[]) => {
    pushUndo('移动', moved.map((e) => e.id), movedComps.map((e) => e.id));
    const failed = await writePositions(moved, movedComps);
    if (!failed.length) return;
    toast(moved.length + movedComps.length > 1 ? `位置保存失败：${failed.join('、')} 没挪过去，再拖一次` : '位置保存失败', 'error');
    refresh();
  };
  // 新建组件（REQ-EDIT-006）：先起名建一个占位组件，选成唯一目标，接着在输入框里描述它——第一句「改组件」就把它写出来
  const createComponent = async (name: string) => {
    const { component } = await api.components.create(projectId, { name, html: NEW_COMPONENT_HTML });
    setNewComponentOpen(false);
    await refresh();
    setSelectedIds([]); setTargetIds([]); setAnchor(null);
    setSelectedComponentIds([component.id]); setTargetComponentIds([component.id]);
    showComposer();
    toast(`已新建组件「${name}」，在下方描述它`);
  };
  // 检查器「改组件」：把组件设为唯一目标（屏目标让位——这一句说的是组件，不是屏）
  const onEditComponent = (name: string) => {
    const c = components.find((x) => x.name === name);
    if (!c) { toast('这个组件已不存在', 'error'); return; }
    setSelectedIds([]); setTargetIds([]); setAnchor(null);
    setSelectedComponentIds([c.id]); setTargetComponentIds([c.id]);
    showComposer();
  };
  // 排列条声明了 role=toolbar：整组在 Tab 序里只占一个停靠点，方向键在组内移动焦点（INT-002，与 CanvasToolbar 同一套做法）
  const [arrangeAt, setArrangeAt] = useState(0);
  const arrangeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onArrangeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number | undefined> = { ArrowRight: arrangeAt + 1, ArrowLeft: arrangeAt - 1, Home: 0, End: ARRANGE_N - 1 };
    const next = to[e.key];
    if (next == null) return;
    e.preventDefault();
    const at = (next + ARRANGE_N) % ARRANGE_N;
    setArrangeAt(at);
    arrangeRefs.current[at]?.focus();
  };
  // 多选排列（REQ-CORE-018）：对齐按选中集合的外接框算，等距保住首尾、中间按间隙均分；只动位置变了的屏，落库走同一条 PATCH
  const arrange = async (kind: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hspace' | 'vspace' | 'hrow' | 'vcol') => {
    const sel = selectedScreens;
    if (sel.length < 2 || (kind.endsWith('space') && sel.length < 3)) return;
    const minX = Math.min(...sel.map((s) => s.x)); const maxR = Math.max(...sel.map((s) => s.x + s.width));
    const minY = Math.min(...sel.map((s) => s.y)); const maxB = Math.max(...sel.map((s) => s.y + s.height));
    const next = new Map<string, { x: number; y: number }>();
    const layout = kind === 'hrow' || kind === 'vcol';
    if (layout) {
      // 排成一行 / 一列（v0.52）：顺序取当前位置（行按 x、列按 y，相同再按另一轴），起点取外接框左上角，间距固定
      const h = kind === 'hrow';
      const sorted = [...sel].sort((a, b) => (h ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
      let cursor = h ? minX : minY;
      for (const s of sorted) { next.set(s.id, h ? { x: cursor, y: minY } : { x: minX, y: cursor }); cursor += (h ? s.width : s.height) + LAYOUT_GAP; }
    } else if (kind === 'hspace' || kind === 'vspace') {
      const h = kind === 'hspace';
      const sorted = [...sel].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
      const span = h ? maxR - minX : maxB - minY;
      const gap = (span - sorted.reduce((m, s) => m + (h ? s.width : s.height), 0)) / (sorted.length - 1);
      let cursor = h ? minX : minY;
      for (const s of sorted) { next.set(s.id, h ? { x: Math.round(cursor), y: s.y } : { x: s.x, y: Math.round(cursor) }); cursor += (h ? s.width : s.height) + gap; }
    } else {
      for (const s of sel) {
        const x = kind === 'left' ? minX : kind === 'right' ? maxR - s.width : kind === 'hcenter' ? Math.round((minX + maxR) / 2 - s.width / 2) : s.x;
        const y = kind === 'top' ? minY : kind === 'bottom' ? maxB - s.height : kind === 'vcenter' ? Math.round((minY + maxB) / 2 - s.height / 2) : s.y;
        next.set(s.id, { x, y });
      }
    }
    const moved = sel.filter((s) => { const n = next.get(s.id)!; return n.x !== s.x || n.y !== s.y; });
    if (!moved.length) return;
    pushUndo(layout ? '排列' : kind.endsWith('space') ? '等距' : '对齐', moved.map((s) => s.id));
    for (const s of moved) dirtyPos.current.set(s.id, next.get(s.id)!);
    setDetail((d) => d && { ...d, screens: d.screens.map((s) => (next.has(s.id) ? { ...s, ...next.get(s.id)! } : s)) });
    // 等每条 PATCH 都有结果再重取：先回来的旧快照会盖掉后落地的那几条写入。
    // 失败的屏把坐标交还服务端（口径是重取、不回滚已落库的那几屏），成功的仍归本地直到刷新里对上
    const done = await Promise.allSettled(moved.map((s) => api.screens.patch(s.id, next.get(s.id)!)));
    const failed = moved.filter((_, i) => done[i].status === 'rejected');
    if (!failed.length) return;
    for (const s of failed) dirtyPos.current.delete(s.id);
    toast(`位置保存失败：${failed.map((s) => s.name).join('、')} 没排上，再点一次对齐`, 'error');
    refresh();
  };
  // 删选中的屏与组件（REQ-EDIT-006）：先屏后组件；组件删掉后屏里已展开的那份留着、只是不再跟着改
  const onDelete = async () => {
    if (selectedScreens.length === 0 && selectedComponents.length === 0) return;
    setConfirmDelete(false);
    const failed: string[] = [];
    for (const s of selectedScreens) {
      try { await api.screens.remove(s.id); }
      catch (e) { failed.push(e instanceof ApiError && e.type === '/errors/screen-busy' ? `${s.name} 正在生成中` : s.name); }
    }
    for (const c of selectedComponents) {
      try { await api.components.remove(c.id); }
      catch { failed.push(`组件 ${c.name}`); }
    }
    const gone = new Set(selectedScreens.map((s) => s.id));
    const goneComps = new Set(selectedComponents.map((c) => c.id));
    setSelectedIds([]); setTargetIds((t) => t.filter((id) => !gone.has(id)));
    setSelectedComponentIds([]); setTargetComponentIds((t) => t.filter((id) => !goneComps.has(id)));
    refresh();
    const total = selectedScreens.length + selectedComponents.length;
    if (failed.length) toast(`${failed.length} 项未能删除：${failed.join('、')}`, 'error');
    else toast(total > 1 ? `已删除 ${total} 项` : '已删除');
  };
  // REQ-PROTO-003：懒生成 = 钉死路由的 generate
  const generateMissing = async (fromScreenId: string, route: string) => {
    setMissing(null);
    const job = await startJob({ kind: 'generate', input: { prompt: `Screen for route ${route}`, count: 1, versions: 1, route, fromScreenId, runner: modelRunner } }, '生成失败');
    if (job) toast(`正在生成 ${route}`);
  };
  // REQ-CORE-014：双击空白 / ⌥G 放锚点，然后聚焦输入框；锚点让屏目标让位（造）
  const placeAnchor = (world: { x: number; y: number }) => {
    if (generating) { toast(GENERATE_BUSY, 'error'); return; }
    setAnchor(world); setSelectedIds([]); setTargetIds([]);
    showComposer();
  };
  const exportPrototype = () => startJob({ kind: 'export_prototype', input: {} }, '导出失败');
  // REQ-PROTO-002：连线开关（本机记忆）与「补链」修复轮（edit_screens 固定指令，按屏计费）
  const [showLinks, setShowLinks] = useState(() => { try { return localStorage.getItem('quilt:links') !== '0'; } catch { return true; } });
  const toggleLinks = () => setShowLinks((v) => { try { localStorage.setItem('quilt:links', v ? '0' : '1'); } catch { /* 无痕模式等写不了，退化为仅本次会话有效 */ } return !v; });
  // 选中了就只修选中的那几屏，没选中才作用于全部（契约上限 20 屏）
  const repairLinks = async () => {
    const targets = (selectedIds.length ? selectedScreens : screens).slice(0, MAX_TARGETS);
    const job = await startJob({ kind: 'edit_screens', input: { prompt: LINK_REPAIR_PROMPT, screenIds: targets.map((s) => s.id), versions: 1 } }, '接上跳转失败');
    if (job) toast(`正在为 ${targets.length} 屏补链`);
  };
  const applyDesignSystem = () => startJob({ kind: 'apply_design_system', input: { screenIds: 'all' } }, '回刷失败');
  // REQ-EDIT-002：通道由检查器自己选（记忆独立于输入框），本机 agent 时作业投递到会话、提示词限定只重写该子树。
  // 发出后不清选中——面板留在这个元素上，回写后由热更新重选刷新
  const regenerateSubtree = async (qid: string, prompt: string, runner: Runner | undefined): Promise<boolean> => {
    if (!focused?.currentRevisionId) return false;
    const job = await startJob({ kind: 'regenerate_subtree', input: { screenId: focused.id, qid, prompt, expectedRevisionId: focused.currentRevisionId, runner } }, '重生成失败');
    return !!job;
  };
  // REQ-CORE-016：样板屏
  const setExemplar = async () => {
    if (!selected) return;
    try { await api.projects.patch(projectId, { exemplarScreenId: selected.id }); toast(`已把「${selected.name}」设为样板屏`); refresh(); }
    catch { toast('设置失败', 'error'); }
  };
  // REQ-EDIT-003：设计系统只显式改——两条路径（面板指令 / 回执「记为约定」）都建 propose_design_system 作业，成功后弹预览
  const propose = async (instruction: string, screenId?: string) => {
    const job = await startJob({ kind: 'propose_design_system', input: { instruction, screenId, runner: modelRunner } }, '提炼失败');
    if (job) toast('正在提炼约定…');
  };
  const rememberConvention = (assistant: MessageDto) => {
    const userMsg = messages.find((m) => m.jobId === assistant.jobId && m.role === 'user');
    if (!userMsg) { toast('找不到这一轮的指令', 'error'); return; }
    propose(userMsg.content, assistant.affectedScreenIds[0]);
  };
  const confirmProposal = async (choice: { conventions: string[]; tokens: DesignProposalDto['tokens']; regenerate: boolean }) => {
    if (!detail) return;
    try {
      await api.designSystem.update(projectId, { conventions: choice.conventions, ...(choice.tokens ?? {}), expectedVersion: detail.designSystem.version });
      setProposal(null);
      toast('设计系统已更新');
      await refresh();
      if (choice.regenerate && screens.length) await startJob({ kind: 'edit_screens', input: { prompt: CONVENTIONS_REGENERATE_PROMPT, screenIds: screens.slice(0, MAX_TARGETS).map((s) => s.id), versions: 1 } }, '重生成失败');
      else if (choice.tokens && screens.length) await applyDesignSystem();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '写入失败', 'error');
    }
  };

  // 对话记录折叠：属于个人视图偏好，跨会话记忆；首帧即取到正确值、读写容错（INT-007 / INT-021）
  const [chatCollapsed, setChatCollapsed] = useState(() => { try { return localStorage.getItem(CHAT_KEY) === '1'; } catch { return false; } });
  const toggleChat = () => setChatCollapsed((v) => { try { localStorage.setItem(CHAT_KEY, v ? '0' : '1'); } catch { /* 无痕模式写不了，退化为仅本次会话有效 */ } return !v; });
  // 输入框显隐（v0.33）：画布态由 ⌘/ 收起或叫回；聚焦某屏时默认收起（把屏底让出来）、⌘/ 可临时叫出，退出聚焦回到画布态的值。
  // 收起只是不显示（草稿与参考图留着），不跨会话记忆——它是主输入控件，刷新后总该在。
  const [composerHidden, setComposerHidden] = useState(false);
  const [composerInFocus, setComposerInFocus] = useState(false);
  useEffect(() => { setComposerInFocus(false); }, [focusedId]);
  const composerVisible = focusedId ? composerInFocus : !composerHidden;
  const showComposer = () => { if (focusedId) setComposerInFocus(true); else setComposerHidden(false); setTimeout(() => composerRef.current?.focus(), 0); };
  const toggleComposer = () => { if (!composerVisible) showComposer(); else if (focusedId) setComposerInFocus(false); else setComposerHidden(true); };
  // 输入框实际高度 → 画布安全区底部占位（--chrome-bottom = 高度 + 16px 底距 + 16px 间隙）；收起时不设，让样式表的 1rem 生效
  const [composerH, setComposerH] = useState<number | null>(null);
  const shellStyle = composerVisible && composerH ? ({ '--chrome-bottom': `${Math.round(composerH) + 32}px` } as React.CSSProperties) : undefined;
  const openDesign = () => { if (panel === 'design') setPanel(null); else { setSelectedIds([]); setPanel('design'); } };
  // 批注（REQ-EDIT-004）：入口与选择元素同源——选中一屏或已聚焦都能进
  const toggleAnnotate = () => {
    if (annotateArmed) { setPanel(null); setFocusedId(null); return; }
    if (focusedId) { if (navStack.length) canvasApi.current?.resetToOwn(); setPanel('annotate'); return; }
    if (selected) { canvasApi.current?.focus(selected.id); setPanel('annotate'); return; }
    setPanel('annotate');
  };
  const annotations = detail?.annotations ?? [];
  const screenAnnotations = useMemo(() => annotations.filter((a) => a.screenId === focusedId), [annotations, focusedId]);
  const addAnnotation = async (note: string) => {
    if (!focused || !elementSel) return;
    try { await api.annotations.create(focused.id, { qid: elementSel.qid, note, anchorText: elementSel.text.slice(0, 200), rect: elementSel.rect }); await refresh(); }
    catch (e) { handleJobError(e, '批注失败'); }
  };
  const updateAnnotation = async (id: string, note: string) => { try { await api.annotations.update(id, { note }); await refresh(); } catch { toast('保存失败', 'error'); } };
  const removeAnnotation = async (id: string) => { try { await api.annotations.remove(id); await refresh(); } catch { toast('删除失败', 'error'); } };
  const sendAnnotations = async (ids: string[]) => {
    const d = await refresh();
    const target = ids.length ? ids : (d?.annotations ?? []).filter((a) => a.screenId === focusedId && a.status === 'open').map((a) => a.id);
    if (!target.length) return;
    try {
      const { jobs } = await api.annotations.send(projectId, target);
      // 同一屏的多条批注合成一次作业，多屏就是多个作业——逐个跟踪，不只跟第一个
      for (const j of jobs) if (j.runner !== 'agent') trackJob(j);
      refreshMessages(); await refresh();
      toast(jobs.length > 1 ? `已发送 ${target.length} 条批注（${jobs.length} 屏）` : `已发送 ${target.length} 条批注`);
    } catch (e) { handleJobError(e, '发送批注失败'); }
  };
  // 交互态与选择元素态互斥，退出任一都回到静态截图（卡片本来的样子）。
  // 从交互态切进来时若已在屏内跳转过，先把 iframe 拉回这张卡片自己的那一屏——
  // 否则选中的元素属于别的屏，与卡片截图对不上（批注的锚点也会错）。
  const toggleInspect = () => {
    if (inspectArmed) { setPanel(null); setFocusedId(null); setFocusedComponentId(null); return; }   // 退出模式：连同聚焦一起退回静态卡片
    if (focusedComponentId) { setPanel('inspect'); return; }            // 组件卡已在交互态：就地转成选择元素
    if (focusedId) { if (navStack.length) canvasApi.current?.resetToOwn(); setPanel('inspect'); return; }
    if (selected) { canvasApi.current?.focus(selected.id); setPanel('inspect'); return; }
    setPanel('inspect');                                                // 没选中屏也能开：点哪一屏就进哪一屏
  };

  // 画布快捷键分两档防误触（工具栏提示上标的就是这里实现的键）：
  // 单键只给「一眼看得出、再按一次即撤销」的视图操作；会弹出/收起面板的一律要 Alt。
  // 用 e.code 判键：macOS 下 Alt+字母 的 e.key 会变成 ∂ ˚ 这类符号。
  // 设置弹层也算弹层（DESIGN §画布快捷键：有弹窗先关弹窗）：它开着时画布快捷键全让位，Esc 关它而不是取消在跑作业
  const blocked = confirmDelete || !!missing || !!proposal || !!settingsSection || newComponentOpen;
  const closeModals = () => { setConfirmDelete(false); setMissing(null); setProposal(null); setNewComponentOpen(false); if (settingsSection) setSettings(null); };
  const deletable = (selectedScreens.length > 0 || selectedComponents.length > 0) && !focusedId;
  const plain: Record<string, (() => void) | undefined> = {
    KeyF: () => canvasApi.current?.fitView(),
    KeyL: toggleLinks,
    Delete: deletable ? () => setConfirmDelete(true) : undefined,
    Backspace: deletable ? () => setConfirmDelete(true) : undefined,
  };
  const alted: Record<string, (() => void) | undefined> = {
    KeyD: openDesign,
    KeyT: () => setPanel(panel === 'agent' ? null : 'agent'),
    KeyR: selected && !focusedId ? () => setPanel(panel === 'revisions' ? null : 'revisions') : undefined,
    KeyN: toggleAnnotate,
    KeyG: () => canvasApi.current?.createAtCenter(),
    KeyC: () => setNewComponentOpen(true),
  };
  // busy = 有任何作业在跑（设计系统面板的回刷、导出、接上跳转等仍按这个语义走）
  const busy = activeJobs.length > 0;
  const keyState = { plain, alted, toggleInspect, toggleComposer, undoPos, blocked, closeModals, expanded: !!candidates, focused: !!focusedId, busy, cancel: cancelNewest, selectAll: () => setSelectedIds(screens.map((x) => x.id)) };
  const keyRef = useRef(keyState);
  keyRef.current = keyState;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 由近及远：有弹窗先关弹窗；否则聚焦态交给画布退出聚焦；否则取消进行中的作业
      if (e.key === 'Escape') {
        // 弹层自己的 Esc 只在焦点落在弹层内时生效（useModal）；点过一个随即禁用的按钮后焦点会掉到 body，这里兜底关掉
        if (keyRef.current.blocked) { keyRef.current.closeModals(); return; }
        if (keyRef.current.expanded) { setCandidates(null); return; }
        if (!keyRef.current.focused && keyRef.current.busy) { e.preventDefault(); keyRef.current.cancel(); return; }
      }
      // ⌘/ 收起 / 显示输入框：正打着字想看画布时也要能按，所以放在「输入框内不吃快捷键」那道门之前
      if ((e.metaKey || e.ctrlKey) && e.code === 'Slash') { e.preventDefault(); if (!keyRef.current.blocked) keyRef.current.toggleComposer(); return; }
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      const k = keyRef.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === 'KeyE') { e.preventDefault(); if (!k.blocked) k.toggleInspect(); return; }
      if (mod && e.code === 'KeyA') { e.preventDefault(); if (!k.blocked) k.selectAll(); return; }
      // ⌘Z 只撤销画布位置（拖动 / 对齐 / 等距）：屏内容的历史在修订树里，是另一套语义
      if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); if (!k.blocked) void k.undoPos(); return; }
      if (mod || k.blocked) return;
      const run = e.altKey ? k.alted[e.code] : !e.shiftKey ? k.plain[e.code] : undefined;
      if (run) { e.preventDefault(); run(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 选中元素随聚焦走：退出聚焦、换屏才清空。屏换了修订不清——热更新后由运行时按 qid 重选（quilt:reselect），
  // 检查器字段刷成新值；元素真没了（被删 / 子树重生成换了 qid）运行时回 deselect 才清
  useEffect(() => { setElementSel(null); }, [focusedId, focusedComponentId]);

  // detail.project.id !== projectId：切项目是客户端导航，CanvasPage 不卸载、detail 还是上一个项目的数据。
  // 拿它渲染画布的后果不只是闪一下别人的卡片——CanvasView 的一次性适配会按上一个项目的屏算镜头，
  // 还把这个算错的镜头存进新项目的 quilt:view 键，此后每次打开都开在那儿（存过就不再适配）。
  if (!detail || detail.project.id !== projectId || !tokens || !previewOrigin) return <div className="relative h-full"><TopNav floating /><Spinner label="加载项目…" /></div>;
  const jobBlocked = busy ? '有作业进行中，等它完成' : screens.length === 0 ? '还没有屏幕' : false;
  const screenSize = DEVICE_SIZE[detail.project.deviceType];

  const tools: Tool[][] = [
    [
      { id: 'fit', label: '适配视图', hint: 'F', desc: '缩放画布，把全部屏幕和风格指南卡片一次装进视野', icon: <Maximize2 size={ICON} />, onSelect: () => canvasApi.current?.fitView() },
      { id: 'links', label: '连线', hint: 'L', desc: '在画布上画出屏与屏之间的跳转关系；指向不存在路由的会标成断链', icon: <Waypoints size={ICON} />, active: showLinks, testId: 'toggle-links', onSelect: toggleLinks },
      { id: 'composer', label: composerVisible ? '收起输入框' : '显示输入框', hint: `${CMD}/`, desc: '收起底部输入框腾出画布，草稿与参考图都留着；进入屏内交互时自动收起，退出时回来', icon: <TextCursorInput size={ICON} />, active: composerVisible, testId: 'toggle-composer', onSelect: toggleComposer },
      { id: 'inspect', label: inspectArmed ? '选择元素中' : '选择元素', hint: `${CMD}E`, desc: '开了就一直在：点任意一屏进去点选元素，改文案/样式/跳转（零 token），或只让 AI 重做这一块。再按一次退出，卡片回到静态', icon: <Crosshair size={ICON} />, active: inspectArmed, onSelect: toggleInspect },
      { id: 'annotate', label: annotateArmed ? '批注中' : '批注', hint: `${ALT}N`, desc: '开了就一直在：点任意一屏的元素写下要改什么，攒成一批再一起发——同一屏的多条批注合成一次作业，少跑几轮', icon: <MessageSquarePlus size={ICON} />, active: annotateArmed, onSelect: toggleAnnotate },
      { id: 'repair', label: '接上跳转', desc: selectedScreens.length ? `把选中的 ${selectedScreens.length} 屏里点了没反应的按钮和表单，交给 AI 接到该去的那一屏上。会改屏、按屏计费` : '屏里那些点了没反应的按钮和表单，让 AI 判断它们各自该去哪一屏并接上，原型就能连着点下去。先选中几屏可只修这几屏。会改屏、按屏计费', icon: <Link2 size={ICON} />, testId: 'repair-links', unavailable: jobBlocked, onSelect: repairLinks },
      { id: 'design', label: '设计系统', hint: `${ALT}D`, desc: '看/改这个项目的色板、字体、圆角、应用简介、约定与 DESIGN.md，可一键回刷所有屏', icon: <Palette size={ICON} />, active: panel === 'design', onSelect: openDesign },
    ],
    [
      { id: 'new-screen', label: '新建屏幕', hint: `${ALT}G`, desc: '在可见区中心放一个新屏落点，然后在下方输入框描述它；双击画布空白处也能放。屏数、版数、通道都在输入框里选', icon: <Plus size={ICON} />, testId: 'new-screen', unavailable: generating ? GENERATE_BUSY : false, onSelect: () => canvasApi.current?.createAtCenter() },
      { id: 'new-component', label: '新建组件', hint: `${ALT}C`, desc: '起个名字建一个共享组件（导航栏、页头这类每屏都一样的块），然后在输入框里描述它；改组件一次，用它的屏全部同步。从屏里现有元素做组件走检查器的「记为共享组件」', icon: <Component size={ICON} />, testId: 'new-component', onSelect: () => setNewComponentOpen(true) },
      { id: 'export', label: '导出原型', desc: '把全部屏打包成一个可离线打开的单文件 HTML 原型', icon: <Download size={ICON} />, unavailable: jobBlocked, onSelect: exportPrototype },
      { id: 'agent', label: '本机 agent', hint: `${ALT}T`, desc: '交给本机 Claude Code 的作业列表：投递到哪个会话、状态、取消。派活入口在输入框的通道下拉与会话下拉', icon: <Bot size={ICON} />, active: panel === 'agent', onSelect: () => setPanel(panel === 'agent' ? null : 'agent') },
    ],
  ];
  if (selectedScreens.length > 0 && !focusedId) tools.push([
    ...(selected ? [
      { id: 'revisions', label: '修订', hint: `${ALT}R`, desc: '这一屏的历史版本与候选，可回溯到任意一版（修订链是单屏概念，只在恰好选中一屏时可用）', icon: <History size={ICON} />, active: panel === 'revisions', onSelect: () => setPanel(panel === 'revisions' ? null : 'revisions') } satisfies Tool,
      { id: 'exemplar', label: detail.project.exemplarScreenId === selected.id ? '样板屏' : '设为样板', desc: '生成和修改时都以样板屏为风格参照（密度、间距、组件用法）', icon: <Star size={ICON} />, testId: 'set-exemplar', active: detail.project.exemplarScreenId === selected.id, unavailable: detail.project.exemplarScreenId === selected.id ? '这一屏已经是样板屏' : !selected.currentRevisionId ? '这一屏还没生成完' : false, onSelect: setExemplar } satisfies Tool,
    ] : []),
    { id: 'delete', label: selectedComponents.length ? `删除 ${selectedScreens.length + selectedComponents.length} 项` : selectedScreens.length > 1 ? `删除 ${selectedScreens.length} 屏` : '删除', hint: 'Del', desc: selectedComponents.length ? '删掉选中的屏（连同修订历史）与组件；组件在屏里已展开的那份留着，只是不再跟着改' : '删掉选中的屏及其修订历史，指向它们的链接会变成断链', icon: <Trash2 size={ICON} />, onSelect: () => setConfirmDelete(true) },
  ]);
  // 只选了组件（REQ-EDIT-006）：上下文组给「删除组件」；改组件走输入框（它已是目标）
  if (selectedComponents.length > 0 && selectedScreens.length === 0 && !focusedId) tools.push([
    { id: 'delete-component', label: selectedComponents.length > 1 ? `删除 ${selectedComponents.length} 个组件` : '删除组件', hint: 'Del', desc: '删掉组件；屏里已经展开的那份留着，只是不再跟着改', icon: <Trash2 size={ICON} />, testId: 'delete-component', onSelect: () => setConfirmDelete(true) },
  ]);
  if (focused) tools.push([
    { id: 'back', label: '后退', hint: 'Alt+←', desc: '退回屏内上一次跳转之前', icon: <ArrowLeft size={ICON} />, unavailable: navStack.length === 0 && '还没有在这一屏里跳转过', onSelect: () => canvasApi.current?.goBack() },
    { id: 'exit', label: '退出交互', hint: 'Esc', desc: '结束屏内交互，回到画布', icon: <X size={ICON} />, onSelect: () => { setFocusedId(null); setFocusedComponentId(null); } },
  ]);

  const panelBody =
    panel === 'revisions' && selected ? <RevisionPanel screen={selected} onClose={() => setPanel(null)} onRestored={refresh} />
    : panel === 'design' ? <DesignPanel ds={detail.designSystem} project={detail.project} screens={screens} assets={detail.assets} busy={busy} onClose={() => setPanel(null)} onSaved={refresh} onApplyAll={applyDesignSystem} onPropose={(i) => propose(i)} />
    : panel === 'agent' ? <AgentJobsPanel projectId={projectId} screens={screens} runners={runners} onClose={() => setPanel(null)} onChanged={refresh} />
    : panel === 'inspect' && focusedComponent ? <InspectorPanel component={focusedComponent} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyComponents.has(focusedComponent.id)} onClose={() => setPanel(null)} onEdited={() => { setElementSel(null); refresh(); }} />
    : panel === 'inspect' && focused ? <InspectorPanel screen={focused} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyScreens.has(focused.id)} runners={runners} composerRunnerId={runnerId} sessions={sessions} onSessionsOpen={() => void loadSessions()} workingQids={workingSubtrees.filter((w) => w.screenId === focused.id).map((w) => w.qid)} onClose={() => setPanel(null)} onEdited={(qid) => { canvasApi.current?.markDone([qid]); refresh(); }} onRegenerate={regenerateSubtree} onEditComponent={onEditComponent} />
    : panel === 'annotate' && focused ? <AnnotationPanel screen={focused} sel={elementSel} items={screenAnnotations} busy={busyScreens.has(focused.id)} onClose={() => { setPanel(null); setFocusedId(null); }} onAdd={addAnnotation} onUpdate={updateAnnotation} onRemove={removeAnnotation} onSend={sendAnnotations} />
    : null;

  return (
    <div className="canvas-shell relative h-full" style={shellStyle} data-chat={chatCollapsed ? 'collapsed' : 'open'} data-panel={panelBody ? 'open' : 'closed'} data-composer={composerVisible ? 'open' : 'hidden'}>
      {/* 可用区探针：四边跟着浮层占位的 CSS 变量走，画布只负责测量它，避免两处各写一套数 */}
      <div ref={safeAreaRef} aria-hidden="true" data-testid="safe-area" className="pointer-events-none absolute bottom-[var(--chrome-bottom)] left-[var(--chrome-left)] right-[var(--chrome-right)] top-[var(--chrome-top)]" />
      <div className="absolute inset-0">
          <CanvasView
            // 换项目就换一张画布：视图位置是按项目记的（quilt:view:<id>），不重挂会把上一个项目的镜头带过来
            key={projectId}
            projectId={projectId} safeAreaRef={safeAreaRef}
            projectName={detail.project.name} tokens={tokens} palette={detail.designSystem.palette} colorMode={detail.designSystem.colorMode} assets={detail.assets} screens={screens} links={detail.links} previewOrigin={previewOrigin}
            selectedIds={selectedIds} focusedId={focusedId} styleGuideSelected={panel === 'design'} inspectMode={inspectMode} annotateMode={annotateMode} armed={inspectArmed ? 'inspect' : annotateArmed ? 'annotate' : null} showLinks={showLinks}
            anchor={anchor} screenSize={screenSize} exemplarScreenId={detail.project.exemplarScreenId}
            onSelect={(id, additive) => { setSelectedId(id, additive); if (!id && panel === 'revisions') setPanel(null); }}
            onSelectMany={(ids, compIds, additive) => { setSelectedIds((prev) => (additive ? [...new Set([...prev, ...ids])] : ids)); setSelectedComponentIds((prev) => (additive ? [...new Set([...prev, ...compIds])] : compIds)); }}
            onSelectStyleGuide={() => { setSelectedIds([]); setSelectedComponentIds([]); setPanel('design'); }}
            onFocus={(id) => { setFocusedId(id); if (id) { setFocusedComponentId(null); setSelectedIds([id]); setSelectedComponentIds([]); } }}
            focusedComponentId={focusedComponentId}
            onFocusComponent={(id) => { setFocusedComponentId(id); if (id) { setFocusedId(null); setSelectedComponentIds([id]); setSelectedIds([]); } }}
            onMove={onMove}
            components={components} selectedComponentIds={selectedComponentIds} onSelectComponent={setSelectedComponentId}
            onNavigateMissing={(fromScreenId, href) => setMissing({ fromScreenId, hrefs: [href] })}
            onDanglingClick={(screenId, hrefs) => setMissing({ fromScreenId: screenId, hrefs })}
            onDeadLink={() => toast('这个交互还没有设计；想让它跳转，用「选择元素」给它连线')}
            onShortcut={(code) => { if (blocked) return; if (code === 'KeyE') toggleInspect(); else if (code === 'Slash') toggleComposer(); }}
            onAnchor={placeAnchor}
            onCandidates={(jobId, screenId) => setCandidates((c) => (c?.screenId === screenId ? null : { jobId, screenId }))}
            candidateStack={candidates && screens.some((s) => s.id === candidates.screenId) ? { screenId: candidates.screenId, node: <CandidateStack jobId={candidates.jobId} screen={screens.find((s) => s.id === candidates.screenId)!} onClose={() => setCandidates(null)} onAdopted={async () => { await refresh(); setCandidates(null); }} /> } : null}
            onElementSelect={(sel) => { setElementSel(sel); canvasApi.current?.highlight(sel?.qid ?? null); }}
            // sel 里带 component（REQ-EDIT-006）：检查器据此挡直改、批注面板据此挡批注
            selectedQid={elementSel?.qid ?? null}
            workingSubtrees={workingSubtrees}
            annotations={annotations}
            onAnnotationClick={(id) => { const a = annotations.find((x) => x.id === id); if (a) { canvasApi.current?.focus(a.screenId); setPanel('annotate'); } }}
            onStat={(s) => setZoom(s.zoom)}
            registerApi={(a) => { canvasApi.current = a; }}
          navStack={navStack} setNavStack={setNavStack}
        />
      </div>
      {/* 多选排列条（REQ-CORE-018）：选中 ≥ 2 屏且没聚焦时出现在画布顶部中央；等距要 ≥ 3 屏。
          候选就地展开时让位：候选胶囊挂在每格上方、与这条争同一批像素，而这条在上面——点「收起」会点成对齐键并把新位置落库。
          右端避让右侧浮层（--chrome-right 含工具栏与滑出面板，与输入框同一组变量）：面板层级更高且不避让，
          写死视口居中时窄视口下右端的等距按钮会钻到面板底下；左侧这一条横带上没有浮层（对话记录贴底、顶栏在其上方），所以只让右边。
          窄视口下面板改成叠在画布上、可用区不再为它让位（styles.css 的 48rem 断点），此时整条让位给面板。 */}
      {selectedScreens.length >= 2 && !focusedId && !inspectArmed && !annotateArmed && !candidates && (
        <div role="toolbar" aria-orientation="horizontal" aria-label={`排列已选的 ${selectedScreens.length} 屏`} data-testid="arrange-bar" onKeyDown={onArrangeKey}
          className={`absolute left-0 right-[var(--chrome-right)] top-16 z-10 mx-auto flex w-max items-center gap-0.5 rounded-full border border-line bg-panel/95 p-1 shadow-lg backdrop-blur${panelBody ? ' [@media(max-width:48rem)]:hidden' : ''}`}>
          <span className="whitespace-nowrap px-2 text-xs text-muted tabular-nums">{selectedScreens.length} 屏</span>
          {ALIGN_BTNS.map(([k, label, Icon], i) => (
            <IconButton key={k} ref={(el) => { arrangeRefs.current[i] = el; }} tabIndex={i === arrangeAt ? 0 : -1} size="xs" tip="bottom" label={label} data-testid={`arrange-${k}`} onFocus={() => setArrangeAt(i)} onClick={() => { setArrangeAt(i); arrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>
          ))}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          {SPACE_BTNS.map(([k, label, Icon], i) => {
            const at = ALIGN_BTNS.length + i;
            return <IconButton key={k} ref={(el) => { arrangeRefs.current[at] = el; }} tabIndex={at === arrangeAt ? 0 : -1} size="xs" tip="bottom" label={label} desc="保住最左 / 最上和最右 / 最下两屏，中间按间隙均分" unavailable={selectedScreens.length < 3 ? '至少选 3 屏' : false} data-testid={`arrange-${k}`} onFocus={() => setArrangeAt(at)} onClick={() => { setArrangeAt(at); arrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
          })}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          {LAYOUT_BTNS.map(([k, label, Icon], i) => {
            const at = ALIGN_BTNS.length + SPACE_BTNS.length + i;
            return <IconButton key={k} ref={(el) => { arrangeRefs.current[at] = el; }} tabIndex={at === arrangeAt ? 0 : -1} size="xs" tip="bottom" label={label} desc={k === 'hrow' ? `按当前左右顺序排成一行，间距 ${LAYOUT_GAP}` : `按当前上下顺序排成一列，间距 ${LAYOUT_GAP}`} data-testid={`arrange-${k}`} onFocus={() => setArrangeAt(at)} onClick={() => { setArrangeAt(at); arrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
          })}
        </div>
      )}
      <TopNav floating right={<>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted tabular-nums" data-testid="stat">{screens.length} 屏 · {Math.round(zoom * 100)}%</span>
        <button ref={settingsBtnRef} type="button" data-testid="open-settings" aria-haspopup="dialog" aria-expanded={!!settingsSection} onClick={() => setSettings('usage')}
          className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">设置</button>
      </>}>
        <ProjectSwitcher current={detail.project} onRenamed={(id) => { if (id === projectId) refresh(); }} />
        <span className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{detail.project.deviceType === 'mobile' ? '手机' : '桌面'}</span>
        {(selectedScreens.length > 0 || selectedComponents.length > 0) && !focusedId && (
          <span className="ml-1 min-w-0 truncate whitespace-nowrap text-xs text-muted" data-testid="selection-stat">
            已选 {selectedScreens.length === 0
              ? (selectedComponents.length === 1 ? <>组件 <b className="text-fg">{selectedComponents[0].name}</b></> : <b className="text-fg">{selectedComponents.length} 个组件</b>)
              : selectedComponents.length > 0 ? <b className="text-fg">{selectedScreens.length} 屏 · {selectedComponents.length} 个组件</b>
              : selected ? <><b className="text-fg">{selected.name}</b> {selected.route}</> : <b className="text-fg">{selectedScreens.length} 屏</b>}
          </span>
        )}
      </TopNav>
      {settingsSection && <SettingsModal section={settingsSection} onSection={setSettings} onClose={() => setSettings(null)} returnTo={settingsBtnRef} onCatalog={applyCatalog} />}
      <ChatDock messages={messages} progress={progress} status={jobStatus} collapsed={chatCollapsed} onToggle={toggleChat} onRemember={rememberConvention} busy={busy} />
      <Composer
        handle={composerRef} safeAreaRef={safeAreaRef} running={running} blockedReason={blockedReason} targets={targetScreens} totalScreens={screens.length} anchor={anchor} maxTargets={MAX_TARGETS}
        componentTargets={targetComponents}
        onRemoveComponentTarget={(id) => { setTargetComponentIds((prev) => prev.filter((x) => x !== id)); setSelectedComponentIds((prev) => prev.filter((x) => x !== id)); }}
        count={count} versions={versions} onCount={setCount} onVersions={setVersions}
        onSend={onSend} onCancelJob={(id) => void cancelJob(id)} onUploadImage={(file) => api.projects.uploadImage(projectId, file)} onError={(m) => toast(m, 'error')}
        onRemoveTarget={(id) => { setTargetIds((prev) => prev.filter((x) => x !== id)); setSelectedIds((prev) => prev.filter((x) => x !== id)); }}
        onRemoveAnchor={() => setAnchor(null)}
        onClearTargets={() => { setTargetIds([]); setSelectedIds([]); setTargetComponentIds([]); setSelectedComponentIds([]); setAnchor(null); }}
        mode={mode} onMode={onMode}
        runners={mode === 'chat' ? chatRunners : runners} runnerId={mode === 'chat' ? chatRunnerId : runnerId} onRunnerChange={onRunnerChange}
        sessions={sessions} sessionId={sessionId} onSessionChange={onSessionChange} onSessionsOpen={() => void loadSessions()}
        hidden={!composerVisible} onResize={setComposerH}
      />
      <CanvasToolbar groups={tools} />
      {panelBody && <div key={panel} className="chrome slide-in-right absolute bottom-4 right-[var(--rail-w)] top-16 z-20 flex w-[var(--panel-w)] flex-col overflow-hidden rounded-xl">{panelBody}</div>}
      {proposal && <ProposalDialog proposal={proposal} ds={detail.designSystem} busy={busy} onConfirm={confirmProposal} onClose={() => setProposal(null)} />}
      {newComponentOpen && <NewComponentDialog onCreate={createComponent} onClose={() => setNewComponentOpen(false)} />}
      {confirmDelete && (selectedScreens.length > 0 || selectedComponents.length > 0) && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="del-title" className="w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up" data-testid="delete-dialog">
            <h2 id="del-title" className="text-sm font-semibold">
              {selectedScreens.length === 0
                ? (selectedComponents.length === 1 ? `删除组件「${selectedComponents[0].name}」？` : `删除 ${selectedComponents.length} 个组件？`)
                : selectedComponents.length > 0 ? `删除 ${selectedScreens.length} 屏与 ${selectedComponents.length} 个组件？`
                : selected ? `删除「${selected.name}」？` : `删除选中的 ${selectedScreens.length} 屏？`}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {selectedScreens.length > 0 ? '屏的修订历史一并删除，指向它的链接会变成断链。' : ''}
              {selectedComponents.length > 0 ? '组件在屏里已经展开的那份留着，只是不再跟着改。' : ''}
            </p>
            <div className="mt-4 flex justify-end gap-2"><Button onClick={() => setConfirmDelete(false)} autoFocus>取消</Button><Button variant="danger" onClick={onDelete}>删除</Button></div>
          </div>
        </div>
      )}
      {missing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setMissing(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="miss-title" className="w-full max-w-sm rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up" data-testid="missing-dialog">
            <h2 id="miss-title" className="text-sm font-semibold">{missing.hrefs.length === 1 ? `「${missing.hrefs[0]}」尚不存在，生成它？` : '这些路由尚不存在，生成哪一个？'}</h2>
            <p className="mt-1 text-xs text-muted">会按当前设计系统生成新屏幕并接上链接（消耗额度）。</p>
            <ul className="mt-3 space-y-1.5">
              {missing.hrefs.map((h) => (
                <li key={h} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <code className="text-danger">{h}</code>
                  <Button size="sm" variant="primary" disabled={!!generating} onClick={() => generateMissing(missing.fromScreenId, h)}>生成</Button>
                </li>
              ))}
            </ul>
            {/* 补屏建的也是 generate，与在跑的那个抢同一个项目级名额：说清为什么现在点不了（A11Y-007 / IA-009） */}
            {generating && <p className="mt-2 text-xs text-warn">{GENERATE_BUSY}</p>}
            <div className="mt-4 flex justify-end"><Button onClick={() => setMissing(null)} autoFocus>关闭</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// 新建组件（REQ-EDIT-006）：只问名字。焦点陷阱 / Esc / 背景 inert 由 useModal 管（A11Y-004 / A11Y-005）；
// 名字被占用时就地报错、不关框，让用户改一个字再试
function NewComponentDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const ref = useModal<HTMLFormElement>(onClose);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) { setError('给组件起个名字'); return; }
    setPending(true);
    try { await onCreate(n); }
    catch (err) {
      if (err instanceof ApiError && err.type === '/errors/component-name-taken') setError('这个名字已被占用');
      else if (err instanceof ApiError && err.status === 400) setError((err.problem.errors as { message?: string }[] | undefined)?.[0]?.message ?? err.problem.title);
      else setError(err instanceof ApiError ? err.problem.title : '创建失败');
    } finally { setPending(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="nc-title" data-testid="new-component-dialog" tabIndex={-1} onSubmit={submit}
        className="w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="nc-title" className="text-sm font-semibold">新建组件</h2>
        <p className="mt-1 text-xs text-muted">先起个名字；建好后在输入框里描述它。改组件一次，用它的屏全部同步。</p>
        <label htmlFor="nc-name" className="mt-3 block text-xs font-medium text-muted">组件名</label>
        <Input id="nc-name" data-testid="new-component-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="例如 TabBar" autoComplete="off" spellCheck={false} maxLength={40} className="mt-1.5"
          aria-invalid={!!error} aria-describedby={error ? 'nc-error' : undefined} />
        {error && <p id="nc-error" role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" type="submit" data-testid="new-component-create" pending={pending} disabled={!name.trim()}>创建</Button>
        </div>
      </form>
    </Overlay>
  );
}
