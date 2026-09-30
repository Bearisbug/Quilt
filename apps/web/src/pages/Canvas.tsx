import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Bot, Component, Crosshair, Download, History, Layers, LayoutList, Link2, Map as MapIcon, Maximize2, MessageSquarePlus, Palette, Plus, Search, SquareStack, Star, TextCursorInput, Trash2, Waypoints, X } from 'lucide-react';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, DEVICE_SIZE, failureText, missingPagePrompt, type ProjectDetailDto, type MessageDto, type JobDto, type JobEventDto, type ScreenDto, type ComponentDto, type Tokens, type Runner, type ScreenCount, type DesignProposalDto } from '@quilt/core';
import { api, ApiError, loadConfig, subscribeProjectEvents, type LiveState } from '@/lib/api';
import { mergeMessages } from '@/lib/messages';
import { useToast } from '@/lib/toast';
import { Button } from '@/ui/ui';
import { TopNav } from '@/project/TopNav';
import { ProjectSwitcher } from '@/project/ProjectSwitcher';
import { SettingsModal } from '@/settings/SettingsModal';
import { CanvasView, type CanvasApi } from '@/canvas/CanvasView';
import { ScreenFinder, type FinderPick } from '@/canvas/ScreenFinder';
import { ScreensPanel } from '@/panels/ScreensPanel';
import { CanvasToolbar, type Tool } from '@/canvas/CanvasToolbar';
import { isSettingsSection, type SettingsSection } from '@/settings/SettingsModal';
import { ChatDock } from '@/composer/ChatDock';
import { Composer, type ComposerHandle } from '@/composer/Composer';
import { useRunnerPrefs } from '@/composer/useRunnerPrefs';
import { useComposerChrome } from '@/composer/useComposerChrome';
import { CandidateStack } from '@/canvas/CandidateStack';
import { ArrangeBar } from '@/canvas/ArrangeBar';
import { usePositionDrafts, usePositionUndo } from '@/canvas/positions';
import { coveredScreens, jobLabel, roundPreset, presetView, presetBody, type JobInput, type RoundPreset } from '@/canvas/jobs';
import { DeleteDialog, MissingDialog, NewComponentDialog, VariantDialog } from '@/canvas/dialogs';
import { RevisionPanel } from '@/panels/RevisionPanel';
import { DesignPanel } from '@/panels/DesignPanel';
import { InspectorPanel, type ElementSel } from '@/panels/InspectorPanel';
import { AnnotationPanel } from '@/panels/AnnotationPanel';
import { ProposalDialog } from '@/panels/ProposalDialog';
import { AgentJobsPanel } from '@/panels/AgentJobsPanel';

type Panel = 'revisions' | 'design' | 'inspect' | 'annotate' | 'agent' | 'screens' | null;
const MINIMAP_KEY = 'quilt:minimap';
const ICON = 18;
const MAX_TARGETS = 20; // API-CORE-010 契约上限
// 造屏名额是项目级的（REQ-CORE-020）：锚点造屏、工具栏「新建屏幕」、断链补屏建的都是 generate，互相排队但不挡改屏
const GENERATE_BUSY = '上一批屏还在造，等它落地再造下一批';
// 聊天回合逐个串行（REQ-CORE-023）：一个项目一条会话
const CHAT_BUSY = '上一句还在回答，等它说完';
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const ALT = MAC ? '⌥' : 'Alt+';
const CMD = MAC ? '⌘' : 'Ctrl+';

// 新建组件时的占位内容（REQ-EDIT-006）：建完立刻在输入框里描述它，第一句「改组件」就把它写出来
const NEW_COMPONENT_HTML = '<div class="p-4 text-sm text-on-surface-variant">New component</div>';
// 签名续取（v0.76）：截图签名至少有效 5 分钟、预览签名至少 10 分钟（API 的 stableExpiry），页面可见时距上次取到详情满 4 分钟就静默重取
const RENEW_MS = 4 * 60_000;

// 画布区取不到项目时的两种失败（v0.76）；null = 没失败（加载中或已就绪）
type LoadFailure = { kind: 'not-found' } | { kind: 'failed'; reason: string } | null;

// PAGE-CANVAS：画布 + 对话 + 修订/设计系统/检查器面板（面板状态进 URL，INT-020）
// 顶栏的缩放百分比：缩放每帧都在变，放进页面 state 的话每一帧整页连同全部卡片重渲染一遍（100 屏时捏合缩放掉帧）。
// 值放在页面外的小仓库里，只有这个百分比订阅它，且只在取整后的数字变了时才重画
function zoomStore() {
  let pct = 50; const subs = new Set<() => void>();
  return {
    set: (zoom: number) => { const next = Math.round(zoom * 100); if (next === pct) return; pct = next; subs.forEach((f) => f()); },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
    get: () => pct,
  };
}
function ZoomPct({ store }: { store: ReturnType<typeof zoomStore> }) {
  return <>{useSyncExternalStore(store.subscribe, store.get)}</>;
}

// 画布页按项目重挂（v0.76）：/p/:projectId 是同一个路由、切项目是客户端导航，不按项目换 key 的话选中、目标、锚点、版数、
// 聚焦 / 交互态会带进下一个项目，上一个项目在途的详情晚到还会覆盖新项目、把画布卡在加载态。外壳在新页面的第一帧就画出来
export function CanvasRoute() {
  const { projectId = '' } = useParams();
  return <CanvasPage key={projectId} />;
}

export function CanvasPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  // 在跑作业是一组（REQ-CORE-020）：后端允许并行，前端跟踪全部非 agent 作业，进度按 jobId 分别记
  const [activeJobs, setActiveJobs] = useState<JobDto[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  // 对话记录（v0.74）：自己发出 / 重试一轮就加一，让列表不在底部也滚到底；折叠期间失败了几轮，展开即清
  const [followSeq, setFollowSeq] = useState(0);
  const [unseenFailures, setUnseenFailures] = useState(0);
  // 预览域地址来自运行时配置（API-CORE-028）：打包后是 127.0.0.1:3101，开发是 preview.localhost:3101
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const loadPreviewOrigin = useCallback(() => loadConfig().then((c) => { setConfigFailed(false); setPreviewOrigin(c.previewOrigin); }).catch(() => setConfigFailed(true)), []);
  useEffect(() => { void loadPreviewOrigin(); }, [loadPreviewOrigin]);
  const [loadFailure, setLoadFailure] = useState<LoadFailure>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 目标标签（REQ-CORE-006）与画布选中是两个状态：选中变化会写进目标，但清空选中（点空白 / Esc）不动目标。
  // 目标只经标签 × 与「清空」减少——发完一条、点空白看结果、追加指令，是最高频的用法，标签一清就会误造一张新屏。
  const [targetIds, setTargetIds] = useState<string[]>([]);
  // 共享组件（REQ-EDIT-006）：选中与目标各一份，规则与屏完全一致——选中即目标，清空选中不清目标
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [targetComponentIds, setTargetComponentIds] = useState<string[]>([]);
  const [newComponentOpen, setNewComponentOpen] = useState(false);
  // 找屏与总览（REQ-CORE-024）：跳屏面板、小地图开关（本机记忆）；状态变体（REQ-CORE-025）：出变体弹层记着给哪张默认屏出
  const [finderOpen, setFinderOpen] = useState(false);
  const [minimapOn, setMinimapOn] = useState(() => { try { return localStorage.getItem(MINIMAP_KEY) !== '0'; } catch { return true; } });
  const toggleMinimap = () => setMinimapOn((v) => { try { localStorage.setItem(MINIMAP_KEY, v ? '0' : '1'); } catch { /* 无痕模式写不了 */ } return !v; });
  const [variantFor, setVariantFor] = useState<ScreenDto | null>(null);
  // 锚点（REQ-CORE-014）：双击空白放下，是「造 · 此处」；点选任何一屏（改）就让位
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // 「修改」还原的系统代发轮次的隐藏参数（REQ-CORE-026 v0.74）：与锚点同一条让位规则——点选屏 / 组件、放锚点都把它换掉
  const [preset, setPreset] = useState<RoundPreset | null>(null);
  const [count, setCount] = useState<ScreenCount>(1);
  const [versions, setVersions] = useState(1);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // 组件卡的交互态（REQ-EDIT-006）：与屏的聚焦互斥——两边都是「活 iframe 吃掉指针」，同时开会分不清点的是谁
  const [focusedComponentId, setFocusedComponentId] = useState<string | null>(null);
  const [navStack, setNavStack] = useState<string[]>([]);
  const zoomStat = useMemo(() => zoomStore(), []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [missing, setMissing] = useState<{ fromScreenId: string; hrefs: string[] } | null>(null);
  // 候选就地展开（REQ-CORE-015）：一次只展开一屏；展开层不是弹窗，不拦画布快捷键，只吃 Esc
  const [candidates, setCandidates] = useState<{ jobId: string; screenId: string } | null>(null);
  // 设计系统提案（REQ-EDIT-003）：propose_design_system 作业成功后弹预览，确认才写入
  const [proposal, setProposal] = useState<DesignProposalDto | null>(null);
  const [elementSel, setElementSel] = useState<ElementSel | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);
  // 输入框这一条横带的探针（v0.78）：左边界是 --composer-left，与画布可用区的左边界不是一回事（styles.css）
  const laneRef = useRef<HTMLDivElement>(null);
  // 生成通道 / 投递会话 / 动词模式三个跨会话偏好（REQ-CORE-011 / REQ-AGENT-003 / REQ-CORE-023）：见 useRunnerPrefs
  const { runners, runnersFailed, loadRunners, runnerId, applyCatalog, onRunnerChange, agentTool, sessionList, sessionId, loadSessions, lists, loadSessionsFor, onSessionChange, sendRunner, modelRunner, mode, onMode, chatRunners, chatRunnerId, chatRunner } = useRunnerPrefs();
  const panel = (params.get('panel') as Panel) ?? null;
  const setPanel = useCallback((v: Panel) => setParams((q) => { if (v) q.set('panel', v); else q.delete('panel'); return q; }, { replace: true }), [setParams]);
  // 设置弹层的开关与当前节都在 URL 上（?settings=<节>，INT-020）：刷新保持，旧 /settings 路径重定向到这里；不认识的值回到第一节
  const settingsParam = params.get('settings');
  const settingsSection: SettingsSection | null = settingsParam ? (isSettingsSection(settingsParam) ? settingsParam : 'usage') : null;
  const setSettings = useCallback((v: SettingsSection | null) => setParams((q) => { if (v) q.set('settings', v); else q.delete('settings'); return q; }, { replace: true }), [setParams]);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  // 侧面板关掉后焦点归还（A11Y-013，v0.78）：挂载时记下焦点所在（点工具栏按钮打开时就是那个按钮）。卸载时焦点若在面板里、
  // 且是键盘焦点（按面板自己的「关闭」），就还给它；它已不在（快捷键打开时焦点本不在工具栏上）就给工具栏上同名的工具。
  // 鼠标点的「关闭」不挪焦点：焦点停在工具栏按钮上，接着按空格就是点它，而不是平移画布
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const a = document.activeElement;
    const opener = a instanceof HTMLElement && a !== document.body && !el.contains(a) ? a : null;
    const tool = panel;
    return () => {
      const f = document.activeElement;
      if (!(f instanceof HTMLElement) || !el.contains(f) || !f.matches(':focus-visible')) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>(`[data-tool="${tool}"]`))?.focus();
      });
    };
  }, [panel]);
  // 批注态与选择元素态共用屏内的 inspect 运行时（都靠点元素），但面板与去向不同
  // 选择元素 / 批注是**全局模式**：先开模式（不必先选中某一屏），再点任意一屏进去。
  // armed = 模式已开；进到某一屏（focusedId）之后才谈得上把 inspect 下发给屏内运行时。
  const inspectArmed = panel === 'inspect';
  const annotateArmed = panel === 'annotate';
  const annotateMode = annotateArmed && !!focusedId;
  // 组件卡也能选元素（v0.57）：它跑同一套运行时，qid 落在组件自己的 HTML 上
  const inspectMode = (inspectArmed || annotateArmed) && (!!focusedId || !!focusedComponentId);

  // 对话记录（v0.76）：请求按发起序号只认最新；快照与本页刚追加、快照里还没有的一轮按 id 合并（见 mergeMessages）。
  // 首次取不到记成 error、就地给重试，取到过之后的失败保留已有内容
  const [msgState, setMsgState] = useState<'loading' | 'ok' | 'error'>('loading');
  const msgSeq = useRef(0);
  const localRounds = useRef<MessageDto[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const refreshMessages = useCallback(() => {
    const seq = ++msgSeq.current;
    return api.projects.messages(projectId).then((r) => {
      if (seq !== msgSeq.current) return;
      const ids = new Set(r.items.map((m) => m.id));
      localRounds.current = localRounds.current.filter((m) => !ids.has(m.id));
      setMessages(mergeMessages(r.items, localRounds.current));
      setMsgState('ok');
    }).catch(() => { if (seq === msgSeq.current) setMsgState((st) => (st === 'ok' ? st : 'error')); });
  }, [projectId]);
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
  // 刚写出去、服务端还没回声的坐标（拖动与排列）归本地，服务端跟上即出栈——见 positions.ts 的 usePositionDrafts
  const drafts = usePositionDrafts();
  // 详情请求带发起序号：同一项目里两次刷新乱序返回时，旧的不覆盖新的（v0.76）。只丢早于最近一次已应用的回包——
  // 只认最后发起的那一次的话，事件密集、GET 又慢于防抖间隔时，每个回包到达时都已被更晚的请求作废，详情一直不更新
  const detailSeq = useRef(0);
  const appliedSeq = useRef(0);
  const lastFetch = useRef(0);
  const hasDetail = useRef(false);
  // quiet：签名续取、截图失败后的重取这类后台刷新，失败不打扰用户（断线有顶栏提示）
  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const seq = ++detailSeq.current;
    try {
      const d = await api.projects.get(projectId);
      if (seq < appliedSeq.current) return d;
      appliedSeq.current = seq;
      lastFetch.current = Date.now();
      hasDetail.current = true;
      setLoadFailure(null);
      setDetail(drafts.reconcile(d));
      const live = new Set(d.activeJobs.map((j) => j.id));
      for (const id of live) seenRef.current.add(id);
      // 只剔除服务端确认过（某次 GET 列出过）的作业：刚建的作业可能还没进这次 GET 的快照，
      // 无条件剔除会让它的行闪一下又回来，重连的订阅还会从 seq 0 重放一遍
      const gone = activeJobsRef.current.filter((j) => !live.has(j.id) && seenRef.current.has(j.id));
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
    } catch (e) {
      if (seq !== detailSeq.current) return null;
      // 404 = 项目没了（书签指向已删项目、别的标签页刚删掉）：任何时候都转到「不存在」态，画布撤掉
      if (e instanceof ApiError && e.status === 404) { hasDetail.current = false; setDetail(null); setLoadFailure({ kind: 'not-found' }); return null; }
      if (!hasDetail.current) setLoadFailure({ kind: 'failed', reason: e instanceof ApiError ? e.problem.title : '连不上 Quilt 服务' });
      else if (!quiet) toast(e instanceof ApiError ? e.problem.title : '项目加载失败', 'error');
      return null;
    }
  }, [projectId, toast, refreshMessages]);

  useEffect(() => { refresh(); refreshMessages(); }, [refresh, refreshMessages]);
  const retryLoad = () => { setLoadFailure(null); setConfigFailed(false); void loadPreviewOrigin(); void refresh(); if (msgState !== 'ok') { setMsgState('loading'); void refreshMessages(); } };
  // 签名续取（v0.76）：页面可见时每 30 s 看一次距上次取到详情满没满 RENEW_MS，从后台切回可见时立即看一次（休眠唤醒后计时器也会补跑）
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible' && hasDetail.current && Date.now() - lastFetch.current >= RENEW_MS) void refresh({ quiet: true }); };
    const t = window.setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [refresh]);
  // 卡片截图取不到（多半是签名过期）：静默重取，10 s 内至多一次
  const shotRetryAt = useRef(0);
  const onShotError = useCallback(() => { if (Date.now() - shotRetryAt.current < 10_000) return; shotRetryAt.current = Date.now(); void refresh({ quiet: true }); }, [refresh]);
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
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); }, []);
  // 项目事件流的连接状态（v0.76）：断开超过 3 s 才在顶栏露出（重连通常 1 s 内完成，不为它闪一下）；放弃重试后给「重连」
  const [feed, setFeed] = useState<LiveState>('open');
  const feedBroken = useRef(false);
  const [feedShown, setFeedShown] = useState(false);
  const [feedEpoch, setFeedEpoch] = useState(0);
  useEffect(() => {
    if (feed === 'open') { setFeedShown(false); return; }
    if (feed === 'offline') { setFeedShown(true); return; }
    const t = window.setTimeout(() => setFeedShown(true), 3000);
    return () => window.clearTimeout(t);
  }, [feed]);
  // 别处发起的一轮（另一个标签页、MCP）：收到它的第一条非终态事件而本页消息里还没有这个作业时补取一次消息，每个作业只补一次
  const askedJobs = useRef(new Set<string>());
  // 项目级事件（API-CORE-030 v0.34）：本机会话经 MCP 回写、别处建的作业、截图就绪都会到这里——刷新项目（聚焦中的屏走热更新），作业终态再刷消息
  // 一个标签页只开这一条长连接（API-CORE-030 / §16 连接预算）：浏览器对同源 HTTP/1.1 只给 6 条并发、
  // 且所有标签页共用，按作业各开一条的话多开两三个项目就把额度占满、普通请求全部排队。
  useEffect(() => subscribeProjectEvents(projectId, (e) => {
    scheduleRefresh();
    if (e.type !== 'job_changed') return;
    const p = e.data as { jobId?: string; type?: string; seq?: number; data?: unknown } | undefined;
    if (!p?.jobId || !p.type) return;
    if (['succeeded', 'failed', 'cancelled'].includes(p.type)) refreshMessages();
    else if (!askedJobs.current.has(p.jobId) && !messagesRef.current.some((m) => m.jobId === p.jobId)) { askedJobs.current.add(p.jobId); refreshMessages(); }
    const job = activeJobsRef.current.find((j) => j.id === p.jobId);
    // 别处建的作业（本机会话投递、另一个标签页发的）本页没跟踪，上面的整体重取已经覆盖
    if (job) onJobEvent.current(job, { type: p.type as JobEventDto['type'], data: p.data ?? {}, seq: p.seq ?? 0, at: e.at });
  }, (st) => {
    setFeed(st);
    // 事件不续传：断过之后重新连上就整体重取一次，补上断线期间丢掉的作业终态、截图就绪与回写
    if (st !== 'open') { feedBroken.current = true; return; }
    if (feedBroken.current) { feedBroken.current = false; void refresh({ quiet: true }); void refreshMessages(); }
  }), [projectId, scheduleRefresh, refreshMessages, refresh, feedEpoch]);
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
      if (e.type === 'failed') {
        toast(failureText(job.kind, d.errorClass as string | undefined, d.message as string | undefined), 'error');
        if (chatCollapsed) setUnseenFailures((n) => n + 1);
      }
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
  useEffect(() => { if (selectedIds.length) { setTargetIds(selectedIds); setAnchor(null); setPreset(null); } }, [selectedIds]);
  useEffect(() => { if (selectedComponentIds.length) { setTargetComponentIds(selectedComponentIds); setAnchor(null); setPreset(null); } }, [selectedComponentIds]);
  // 屏数档位的默认值（REQ-CORE-003）：空项目默认「自动」（规划器定 4–6 屏主流程），有屏之后默认 1；只在空 ↔ 非空切换时重置
  const empty = !!detail && screens.length === 0;
  useEffect(() => { if (detail) setCount(empty ? 'auto' : 1); }, [detail?.project.id, empty]); // eslint-disable-line react-hooks/exhaustive-deps
  // 选中集合即上下文；「恰好一屏」另算，修订链等单屏概念只在这种情况下成立
  const selectedScreens = useMemo(() => screens.filter((s) => selectedIds.includes(s.id)), [screens, selectedIds]);
  const selected = selectedScreens.length === 1 ? selectedScreens[0] : null;
  // ?panel=revisions 只在恰好选中一屏时成立（INT-020 标识非法回默认，v0.78）：加载后没有选中、点空白、加选成多屏都把它从 URL 去掉——
  // 留着的话面板不显示，下次单选某屏时它自己弹出来
  useEffect(() => { if (panel === 'revisions' && detail && !selected) setPanel(null); }, [panel, detail, selected, setPanel]);
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
  // 聚焦 iframe 此刻显示的那一屏（切了状态变体就是那张变体）：检查器、批注、子树重生成都写到它上面——
  // 写到卡片自己那屏的话，同号 qid 会静默改掉默认屏上的另一个元素（每屏的 qid 都从 q1 编起）
  const [shownScreenId, setShownScreenId] = useState<string | null>(null);
  const shownScreen = useMemo(() => screens.find((s) => s.id === shownScreenId) ?? focused, [screens, shownScreenId, focused]);
  // 跳过去（REQ-CORE-024）：镜头把那张卡摆到可用区中央并单选它；找屏面板与屏列表都走这一条
  const reveal = (pick: FinderPick) => {
    canvasApi.current?.reveal(pick.id);
    if (pick.kind === 'screen') setSelectedId(pick.id); else setSelectedComponentId(pick.id, false);
  };
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
  // 隐藏参数胶囊只跟它那种动词走：出变体 / 补缺失页是造（没有目标屏），补链 / 按新约定重生成要有目标屏；本机会话接不了钉死路由的造
  const pinnedPreset = preset?.kind === 'variant' || preset?.kind === 'missing';
  const livePreset = mode !== 'chat' && preset && pinnedPreset === (targetScreens.length === 0) ? preset : null;
  // 项目还没到手时发送与工具栏一律不可用，理由随加载 / 失败态写
  const pendingReason = loadFailure?.kind === 'not-found' ? '这个项目不存在' : loadFailure || configFailed ? '项目没加载出来' : '项目还在加载';
  const blockedReason = useMemo(() => {
    if (!detail) return pendingReason;
    if (mode === 'chat') return guardJobs.some((j) => j.kind === 'chat') ? CHAT_BUSY : null;
    const targets = targetScreens.slice(0, MAX_TARGETS);
    if (livePreset && pinnedPreset && sendRunner?.kind === 'agent') return '出变体、补缺失页请换一个模型通道，本机会话不接这类作业';
    if (!targets.length && !anchor && !livePreset && targetComponents.length) {
      if (targetComponents.length > 1) return '一次只能改一个组件，其余先从目标里去掉';
      const c = targetComponents[0];
      return guardJobs.some((j) => j.kind === 'edit_component' && (j.input as JobInput).componentId === c.id) ? `「${c.name}」正在改，等这一轮完事` : null;
    }
    if (!targets.length) return generating ? GENERATE_BUSY : null;
    const hit = targets.filter((s) => busyScreens.has(s.id));
    if (!hit.length) return null;
    return hit.length === 1 ? `「${hit[0].name}」正在改，等这一轮完事` : `选中的 ${hit.length} 屏正在改（含「${hit[0].name}」），等这一轮完事`;
  }, [detail, pendingReason, targetScreens, targetComponents, anchor, busyScreens, generating, mode, guardJobs, livePreset, pinnedPreset, sendRunner?.kind]);
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
      if (job.runner === 'agent') { refresh(); toast(`已投递到本机 ${(job.input as { runner?: { tool?: string } })?.runner?.tool === 'codex' ? 'Codex 线程' : 'Claude Code 会话'}，在本机 agent 面板看状态`); } else trackJob(job);
      refreshMessages(); return job;
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast('会话已关闭或不存在，重新选一个', 'error'); void loadSessions(); }
      else handleJobError(e, fallback);
      return null;
    }
  };
  // 一轮建好（发送 / 重试）：消息追加进记录；交给本机 agent 的已投递到会话，切到 agent 面板看状态，其余进在跑作业行
  const roundStarted = (r: { userMessage: MessageDto; assistantMessage: MessageDto; job: JobDto }) => {
    // 先记进本地追加：较早发起、晚到的消息快照不会把它抹掉；快照先到、已经带着这一轮的话不再追加（按 id 去重）
    localRounds.current = [...localRounds.current, r.userMessage, r.assistantMessage];
    setMessages((m) => (m.some((x) => x.id === r.userMessage.id) ? m : [...m, r.userMessage, r.assistantMessage]));
    setFollowSeq((n) => n + 1);
    if (r.job.runner === 'agent') { refresh(); setPanel('agent'); }
    else trackJob(r.job);
  };
  // 最后一轮的重试 / 修改（REQ-CORE-026）。重试由服务端复制原作业输入（API-CORE-034），这里只给通道：输入框此刻选的那条，聊天轮用聊天通道。
  // 在途锁（v0.74）：ref 挡住同一帧里的连点（state 要到下一次渲染才生效），state 给按钮置灰转圈
  const retryingRef = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const retryRound = async (user: MessageDto) => {
    if (retryingRef.current) return;
    retryingRef.current = true; setRetrying(true);
    try { roundStarted(await api.projects.retry(projectId, user.id, user.jobKind === 'chat' ? chatRunner : sendRunner)); }
    catch (e) {
      if (e instanceof ApiError && e.type === '/errors/job-not-finished') toast('这一轮还在跑，等它结束再重试', 'error');
      else if (e instanceof ApiError && e.type === '/errors/validation') toast((e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title, 'error');
      else handleJobError(e, '重试失败');
    } finally { retryingRef.current = false; setRetrying(false); }
  };
  // 修改：这一轮的文字、参考图、目标、动词与档位原样填回输入框（替换现有草稿），不改写历史；已被删掉的屏 / 组件不填、说一声。
  // 只写输入框的目标、不动画布选中：写选中会触发上面「选中即改」的 effect，把刚填回的锚点与胶囊清掉（v0.74）。
  // 系统代发的轮次（出变体 / 补缺失页 / 补链 / 按新约定重生成）的隐藏参数还原成胶囊，正文按作业输入反解（REQ-CORE-026 v0.74）
  const editRound = async (user: MessageDto) => {
    let job: JobDto;
    try { job = (await api.jobs.get(user.jobId!)).job; } catch { toast('读取这一轮失败', 'error'); return; }
    const input = job.input as JobInput & { anchor?: { x: number; y: number } };
    const screenIds = ((input.screenIds as string[] | undefined) ?? []).filter((id) => screens.some((s) => s.id === id));
    const compIds = (input.componentId ? [input.componentId] : input.componentIds ?? []).filter((id) => components.some((c) => c.id === id));
    const alive = (id: string | undefined) => !!id && screens.some((s) => s.id === id);
    const restored = roundPreset(job);
    const r = restored?.preset;
    // 变体的默认屏已被删掉：变体出不成，按丢了一个目标算；缺失页的来源屏只是参考，丢了就不带
    const baseGone = r?.kind === 'variant' && !alive(r.variantOf);
    const lost = (input.screenIds?.length ?? 0) - screenIds.length + ((input.componentId ? 1 : input.componentIds?.length ?? 0) - compIds.length) + (baseGone ? 1 : 0);
    onMode(job.kind === 'chat' ? 'chat' : 'design');
    setSelectedIds([]); setTargetIds(screenIds);
    setSelectedComponentIds([]); setTargetComponentIds(compIds);
    setAnchor(job.kind === 'generate' ? input.anchor ?? null : null);
    setPreset(!r || baseGone ? null : r.kind === 'missing' && !alive(r.fromScreenId) ? { ...r, fromScreenId: undefined } : r);
    if (input.count !== undefined) setCount(input.count);
    if (input.versions !== undefined) setVersions(input.versions);
    composerRef.current?.load({ text: restored && !baseGone ? restored.text : user.content, images: user.attachments.map((a) => ({ id: a.id, url: a.url })) });
    showComposer();
    if (lost > 0) toast(`这一轮有 ${lost} 个目标已被删除，没有填回`);
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
        : { content, targetScreenIds: targets, targetComponentIds: compTargets, count: targets || livePreset ? undefined : count, versions, anchor: targets || livePreset ? undefined : anchor ?? undefined, runner: sendRunner, attachmentIds: attachmentIds.length ? attachmentIds : undefined, ...(livePreset ? presetBody(livePreset) : {}) });
      roundStarted(r);
      if (!targets && !chat) setAnchor(null);
      if (livePreset) setPreset(null);
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
  // 位置撤销栈（⌘Z）、拖动落库、多选排列：都在 positions.ts 的 usePositionUndo，这里只接线
  const { undoPos, onMove, arrange } = usePositionUndo({ drafts, screensRef, components, setDetail, refresh, toast });
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
    const job = await startJob({ kind: 'generate', input: { prompt: missingPagePrompt(route), count: 1, versions: 1, route, fromScreenId, runner: modelRunner } }, '生成失败');
    if (job) toast(`正在生成 ${route}`);
  };
  // REQ-CORE-014：双击空白 / ⌥G 放锚点，然后聚焦输入框；锚点让屏目标让位（造）
  const placeAnchor = (world: { x: number; y: number }) => {
    if (generating) { toast(GENERATE_BUSY, 'error'); return; }
    setAnchor(world); setSelectedIds([]); setTargetIds([]); setPreset(null);
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
    if (!shownScreen?.currentRevisionId) return false;
    const job = await startJob({ kind: 'regenerate_subtree', input: { screenId: shownScreen.id, qid, prompt, expectedRevisionId: shownScreen.currentRevisionId, runner } }, '重生成失败');
    return !!job;
  };
  // 出变体（REQ-CORE-025）：钉死默认屏路由的 generate；建不成时抛出去让弹层留着报错
  const createVariant = async (name: string, prompt: string) => {
    if (!variantFor) return;
    const job = await startJob({ kind: 'generate', input: { prompt, count: 1, versions, variantOf: variantFor.id, variantName: name, runner: modelRunner } }, '出变体失败');
    if (!job) throw new Error('出变体失败');
    setVariantFor(null);
    toast(`正在出「${variantFor.name}」的「${name}」变体`);
  };
  // 呈现方式（REQ-PROTO-005）：元数据，PATCH 即生效，不重烤修订
  const togglePresentation = async () => {
    if (!selected) return;
    const next = selected.presentation === 'overlay' ? 'push' : 'overlay';
    try { await api.screens.patch(selected.id, { presentation: next }); await refresh(); toast(next === 'overlay' ? `「${selected.name}」已设为叠层屏：播放时压在来处那一屏上` : `「${selected.name}」已设为整屏`); }
    catch { toast('设置失败', 'error'); }
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
  // 提案「确认写入」即落库（v0.78）；返回是否写成——写不成提案弹层留着，可以再点一次
  const writeProposal = async (choice: { conventions: string[]; tokens: DesignProposalDto['tokens'] }): Promise<boolean> => {
    if (!detail) return false;
    try {
      await api.designSystem.update(projectId, { conventions: choice.conventions, ...(choice.tokens ?? {}), expectedVersion: detail.designSystem.version });
      toast('设计系统已更新');
      await refresh();
      return true;
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '写入失败', 'error');
      return false;
    }
  };
  // 写入之后的收尾：按新约定重生成全部屏，或只改了 token 就确定性回刷。
  // 重生成按契约上限每 20 屏一个作业、全部发出（v0.78）；某一批被拒（限流等，startJob 已说原因）就停下，说清还剩几屏没发
  const finishProposal = async (regenerate: boolean, tokensChanged: boolean) => {
    setProposal(null);
    if (!screens.length) return;
    if (!regenerate) { if (tokensChanged) await applyDesignSystem(); return; }
    let sent = 0;
    for (let i = 0; i < screens.length; i += MAX_TARGETS) {
      const batch = screens.slice(i, i + MAX_TARGETS);
      if (!(await startJob({ kind: 'edit_screens', input: { prompt: CONVENTIONS_REGENERATE_PROMPT, screenIds: batch.map((s) => s.id), versions: 1 } }, '重生成失败'))) break;
      sent += batch.length;
    }
    if (sent < screens.length) toast(`已为 ${sent} 屏发起重生成，其余 ${screens.length - sent} 屏没发出去`, 'error');
  };

  // 对话记录折叠与输入框显隐（useComposerChrome）：输入框高度换算成画布底部占位 --chrome-bottom
  const { chatCollapsed, toggleChat, composerVisible, showComposer, toggleComposer, composerH, setComposerH, shellStyle } = useComposerChrome(focusedId, composerRef);
  const openDesign = () => { if (panel === 'design') setPanel(null); else { setSelectedIds([]); setPanel('design'); } };
  // 批注（REQ-EDIT-004）：入口与选择元素同源——选中一屏或已聚焦都能进
  const toggleAnnotate = () => {
    if (annotateArmed) { setPanel(null); setFocusedId(null); return; }
    if (focusedId) { if (navStack.length) canvasApi.current?.resetToOwn(); setPanel('annotate'); return; }
    if (selected) { canvasApi.current?.focus(selected.id); setPanel('annotate'); return; }
    setPanel('annotate');
  };
  const annotations = detail?.annotations ?? [];
  const screenAnnotations = useMemo(() => annotations.filter((a) => a.screenId === shownScreen?.id), [annotations, shownScreen?.id]);
  // 存不上时 toast 原因并回 null / false（v0.78）：面板据此留着草稿与改写框，「记下并立刻发送」存不上就不发
  const addAnnotation = async (note: string): Promise<string | null> => {
    if (!shownScreen || !elementSel) return null;
    try { const { annotation } = await api.annotations.create(shownScreen.id, { qid: elementSel.qid, note, anchorText: elementSel.text.slice(0, 200), rect: elementSel.rect }); await refresh(); return annotation.id; }
    catch (e) { handleJobError(e, '批注失败'); return null; }
  };
  const updateAnnotation = async (id: string, note: string): Promise<boolean> => { try { await api.annotations.update(id, { note }); await refresh(); return true; } catch { toast('保存失败', 'error'); return false; } };
  const removeAnnotation = async (id: string) => { try { await api.annotations.remove(id); await refresh(); } catch { toast('删除失败', 'error'); } };
  const sendAnnotations = async (target: string[]) => {
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
  const blocked = confirmDelete || !!missing || !!proposal || !!settingsSection || newComponentOpen || finderOpen || !!variantFor;
  const closeModals = () => { setConfirmDelete(false); setMissing(null); setProposal(null); setNewComponentOpen(false); setFinderOpen(false); setVariantFor(null); if (settingsSection) setSettings(null); };
  const deletable = (selectedScreens.length > 0 || selectedComponents.length > 0) && !focusedId;
  // 适配视图：缩到下限仍装不下全部时说一声，不静默裁掉（v0.76）
  const fitAll = () => { if (canvasApi.current && !canvasApi.current.fitView()) toast(`内容太大，最小缩放也装不下全部，用小地图或找屏（${CMD}K）定位`); };
  const plain: Record<string, (() => void) | undefined> = {
    KeyF: () => fitAll(),
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
    KeyC: detail ? () => setNewComponentOpen(true) : undefined,
    KeyS: () => setPanel(panel === 'screens' ? null : 'screens'),
    KeyV: selected && !selected.variantOf && !focusedId ? () => { if (generating) toast(GENERATE_BUSY, 'error'); else setVariantFor(selected); } : undefined,
  };
  // busy = 有任何作业在跑（设计系统面板的回刷、导出、接上跳转等仍按这个语义走）
  const busy = activeJobs.length > 0;
  // 对话记录里「重试」要知道最后一轮还在不在跑：本页跟踪的作业 + 服务端列出的（含交给本机 agent 的）
  const runningJobIds = useMemo(() => new Set([...activeJobs, ...(detail?.activeJobs ?? [])].map((j) => j.id)), [activeJobs, detail?.activeJobs]);
  const keyState = { plain, alted, toggleInspect, toggleComposer, undoPos, blocked, closeModals, openFinder: () => setFinderOpen(true), expanded: !!candidates, focused: !!focusedId, busy, cancel: cancelNewest, selectAll: () => setSelectedIds(screens.map((x) => x.id)) };
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
      // ⌘K 找屏（REQ-CORE-024）：正在输入框里打字也要能按
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') { e.preventDefault(); if (!keyRef.current.blocked) keyRef.current.openFinder(); return; }
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

  // 外壳常驻（v0.76）：顶栏、对话记录、输入框、工具栏在加载与失败时照样画，只有画布区换成加载 / 失败态
  const ready = !!detail && !!tokens && !!previewOrigin;
  const failure: LoadFailure = loadFailure ?? (configFailed ? { kind: 'failed', reason: '运行时配置取不到' } : null);
  const jobBlocked = busy ? '有作业进行中，等它完成' : screens.length === 0 ? '还没有屏幕' : false;

  const tools: Tool[][] = [
    [
      { id: 'fit', label: '适配视图', hint: 'F', desc: '缩放画布，把全部屏幕和风格指南卡片一次装进视野', icon: <Maximize2 size={ICON} />, onSelect: fitAll },
      { id: 'find', label: '找屏', hint: `${CMD}K`, desc: '按名字、路由或用途搜屏与组件，Enter 跳过去并选中', icon: <Search size={ICON} />, testId: 'find-screen', onSelect: () => setFinderOpen(true) },
      { id: 'screens', label: '屏列表', hint: `${ALT}S`, desc: '按画布顺序列出全部屏，可按断链 / 待选候选 / 有偏离 / 正在改筛选，点一行跳过去', icon: <LayoutList size={ICON} />, active: panel === 'screens', testId: 'toggle-screens', onSelect: () => setPanel(panel === 'screens' ? null : 'screens') },
      { id: 'minimap', label: '小地图', desc: '左上角的缩略图：画出全部屏与当前视口，点哪儿镜头就到哪儿', icon: <MapIcon size={ICON} />, active: minimapOn, testId: 'toggle-minimap', onSelect: toggleMinimap },
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
      { id: 'agent', label: '本机 agent', hint: `${ALT}T`, desc: '交给本机 Claude Code / Codex 的作业列表：投递到哪个会话、状态、取消。派活入口在输入框的通道下拉与会话下拉', icon: <Bot size={ICON} />, active: panel === 'agent', onSelect: () => setPanel(panel === 'agent' ? null : 'agent') },
    ],
  ];
  if (selectedScreens.length > 0 && !focusedId) tools.push([
    ...(selected ? [
      { id: 'revisions', label: '修订', hint: `${ALT}R`, desc: '这一屏的历史版本与候选，可回溯到任意一版（修订链是单屏概念，只在恰好选中一屏时可用）', icon: <History size={ICON} />, active: panel === 'revisions', onSelect: () => setPanel(panel === 'revisions' ? null : 'revisions') } satisfies Tool,
      { id: 'variant', label: '出变体', hint: `${ALT}V`, desc: '给这一屏出一个状态变体（空态、出错、未登录…）：同路由同布局，只改状态那部分；播放时可切换', icon: <SquareStack size={ICON} />, testId: 'new-variant', unavailable: selected.variantOf ? '选它的默认屏再出变体' : generating ? GENERATE_BUSY : false, onSelect: () => setVariantFor(selected) } satisfies Tool,
      { id: 'presentation', label: selected.presentation === 'overlay' ? '设为整屏' : '设为叠层', desc: selected.presentation === 'overlay' ? '现在是叠层屏：播放时压在来处那一屏上。改回整屏后跳转时换掉整个画面' : '把它当弹层 / 底部抽屉：播放时压在来处那一屏上，点遮罩或后退关掉。只改呈现方式，不重生成', icon: <Layers size={ICON} />, testId: 'toggle-presentation', active: selected.presentation === 'overlay', onSelect: () => void togglePresentation() } satisfies Tool,
      { id: 'exemplar', label: detail?.project.exemplarScreenId === selected.id ? '样板屏' : '设为样板', desc: '生成和修改时都以样板屏为风格参照（密度、间距、组件用法）', icon: <Star size={ICON} />, testId: 'set-exemplar', active: detail?.project.exemplarScreenId === selected.id, unavailable: detail?.project.exemplarScreenId === selected.id ? '这一屏已经是样板屏' : !selected.currentRevisionId ? '这一屏还没生成完' : false, onSelect: setExemplar } satisfies Tool,
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

  const panelBody = !detail ? null
    : panel === 'revisions' && selected ? <RevisionPanel screen={selected} onClose={() => setPanel(null)} onRestored={refresh} />
    : panel === 'design' ? <DesignPanel ds={detail.designSystem} project={detail.project} screens={screens} assets={detail.assets} busy={busy} onClose={() => setPanel(null)} onSaved={refresh} onApplyAll={applyDesignSystem} onPropose={(i) => propose(i)} />
    : panel === 'screens' ? <ScreensPanel screens={screens} links={detail.links} busy={busyScreens} onPick={(id) => reveal({ kind: 'screen', id })} onClose={() => setPanel(null)} />
    : panel === 'agent' ? <AgentJobsPanel projectId={projectId} screens={screens} runners={runners} onClose={() => setPanel(null)} onChanged={refresh} />
    : panel === 'inspect' && focusedComponent ? <InspectorPanel component={focusedComponent} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyComponents.has(focusedComponent.id)} onClose={() => setPanel(null)} onEdited={() => { setElementSel(null); refresh(); }} />
    : panel === 'inspect' && shownScreen ? <InspectorPanel screen={shownScreen} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyScreens.has(shownScreen.id)} runners={runners} composerRunnerId={runnerId} sessionLists={lists} onSessionsOpen={(tool) => void loadSessionsFor(tool)} workingQids={workingSubtrees.filter((w) => w.screenId === shownScreen.id).map((w) => w.qid)} onClose={() => setPanel(null)} onEdited={(qid) => { canvasApi.current?.markDone([qid]); refresh(); }} onRegenerate={regenerateSubtree} onEditComponent={onEditComponent} />
    : panel === 'annotate' && shownScreen ? <AnnotationPanel screen={shownScreen} sel={elementSel} items={screenAnnotations} busy={busyScreens.has(shownScreen.id)} onClose={() => { setPanel(null); setFocusedId(null); }} onAdd={addAnnotation} onUpdate={updateAnnotation} onRemove={removeAnnotation} onSend={sendAnnotations} />
    : null;

  return (
    <div className="canvas-shell relative h-full" style={shellStyle} data-chat={chatCollapsed ? 'collapsed' : 'open'} data-panel={panelBody ? 'open' : 'closed'} data-composer={composerVisible ? 'open' : 'hidden'} data-minimap={minimapOn && !focusedId && !focusedComponentId ? 'on' : 'off'}>
      {/* 可用区探针：四边跟着浮层占位的 CSS 变量走，画布只负责测量它，避免两处各写一套数 */}
      <div ref={safeAreaRef} aria-hidden="true" data-testid="safe-area" className="pointer-events-none absolute bottom-[var(--chrome-bottom)] left-[var(--chrome-left)] right-[var(--chrome-right)] top-[var(--chrome-top)]" />
      <div ref={laneRef} aria-hidden="true" data-testid="composer-lane" className="pointer-events-none absolute bottom-0 left-[var(--composer-left)] right-[var(--chrome-right)] h-0" />
      <div className="absolute inset-0">
        {ready && detail && tokens && previewOrigin ? (
          <CanvasView
            projectId={projectId} safeAreaRef={safeAreaRef}
            projectName={detail.project.name} tokens={tokens} palette={detail.designSystem.palette} colorMode={detail.designSystem.colorMode} assets={detail.assets} screens={screens} links={detail.links} previewOrigin={previewOrigin}
            selectedIds={selectedIds} focusedId={focusedId} styleGuideSelected={panel === 'design'} inspectMode={inspectMode} annotateMode={annotateMode} armed={inspectArmed ? 'inspect' : annotateArmed ? 'annotate' : null} showLinks={showLinks}
            anchor={anchor} screenSize={DEVICE_SIZE[detail.project.deviceType]} exemplarScreenId={detail.project.exemplarScreenId}
            onSelect={setSelectedId}
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
            onShortcut={(code) => { if (blocked) return; if (code === 'KeyE') toggleInspect(); else if (code === 'Slash') toggleComposer(); else if (code === 'KeyK') setFinderOpen(true); }}
            onAnchor={placeAnchor}
            onCandidates={(jobId, screenId) => setCandidates((c) => (c?.screenId === screenId ? null : { jobId, screenId }))}
            candidateStack={candidates && screens.some((s) => s.id === candidates.screenId) ? { screenId: candidates.screenId, node: <CandidateStack jobId={candidates.jobId} screen={screens.find((s) => s.id === candidates.screenId)!} onClose={() => setCandidates(null)} onAdopted={async () => { await refresh(); setCandidates(null); }} /> } : null}
            onElementSelect={(sel) => { setElementSel(sel); canvasApi.current?.highlight(sel?.qid ?? null); }}
            // sel 里带 component（REQ-EDIT-006）：检查器据此挡直改、批注面板据此挡批注
            selectedQid={elementSel?.qid ?? null}
            workingSubtrees={workingSubtrees}
            annotations={annotations}
            onAnnotationClick={(id) => { const a = annotations.find((x) => x.id === id); if (a) { canvasApi.current?.focus(a.screenId); setPanel('annotate'); } }}
            onStat={(s) => zoomStat.set(s.zoom)}
            registerApi={(a) => { canvasApi.current = a; }}
            minimap={minimapOn}
            onShown={setShownScreenId}
            navStack={navStack} setNavStack={setNavStack}
            onStale={() => refresh({ quiet: true })} onShotError={onShotError}
            onPreviewError={(s) => toast(`「${s.name}」这一屏没取到，稍后再试一次`, 'error')}
          />
        ) : <CanvasPending failure={failure} onRetry={retryLoad} />}
      </div>
      {/* 多选排列条（REQ-CORE-018）：选中 ≥ 2 屏且没聚焦时出现在画布顶部中央；候选就地展开时让位。排版与键盘在 ArrangeBar，算位在 arrange.ts，落库在 positions.ts */}
      {selectedScreens.length >= 2 && !focusedId && !inspectArmed && !annotateArmed && !candidates && <ArrangeBar count={selectedScreens.length} yieldToPanel={!!panelBody} onArrange={(k) => void arrange(k, selectedScreens)} />}
      <TopNav floating right={<>
        {feedShown && feed !== 'open' && (
          <span role="status" data-testid="live-status" className="min-w-0 truncate whitespace-nowrap rounded-full border border-warn/60 px-2 py-0.5 text-[11px] text-warn">
            实时更新已断开 · {feed === 'offline'
              ? <button type="button" onClick={() => { setFeed('reconnecting'); setFeedEpoch((n) => n + 1); }} className="underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">重连</button>
              : '重连中'}
          </span>
        )}
        {detail && <span className="shrink-0 whitespace-nowrap text-xs text-muted tabular-nums" data-testid="stat">{screens.length} 屏 · <ZoomPct store={zoomStat} />%</span>}
        <button ref={settingsBtnRef} type="button" data-testid="open-settings" aria-haspopup="dialog" aria-expanded={!!settingsSection} onClick={() => setSettings('usage')}
          className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">设置</button>
      </>}>
        <ProjectSwitcher current={detail?.project ?? null} placeholder={failure?.kind === 'not-found' ? '项目不存在' : failure ? '项目没加载出来' : '加载中…'} onRenamed={(id) => { if (id === projectId) refresh(); }} />
        {detail && <span className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{detail.project.deviceType === 'mobile' ? '手机' : '桌面'}</span>}
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
      <ChatDock messages={messages} progress={progress} status={jobStatus} collapsed={chatCollapsed} onToggle={() => { if (chatCollapsed) setUnseenFailures(0); toggleChat(); }} onRemember={rememberConvention} busy={busy}
        onRetry={(u) => void retryRound(u)} onEdit={(u) => void editRound(u)} runningJobIds={runningJobIds} retrying={retrying} followSeq={followSeq} failed={unseenFailures}
        // 项目不存在时消息自然也取不到：那不是「没加载出来」，画布区已经说明了
        loadState={msgState === 'ok' || loadFailure?.kind === 'not-found' ? undefined : msgState} onReload={() => { setMsgState('loading'); void refreshMessages(); }} />
      <Composer
        handle={composerRef} laneRef={laneRef} running={running} blockedReason={blockedReason} targets={targetScreens} totalScreens={screens.length} anchor={anchor} maxTargets={MAX_TARGETS}
        componentTargets={targetComponents}
        onRemoveComponentTarget={(id) => { setTargetComponentIds((prev) => prev.filter((x) => x !== id)); setSelectedComponentIds((prev) => prev.filter((x) => x !== id)); }}
        count={count} versions={versions} onCount={setCount} onVersions={setVersions}
        onSend={onSend} onCancelJob={(id) => void cancelJob(id)} onUploadImage={(file) => api.projects.uploadImage(projectId, file)} onError={(m) => toast(m, 'error')}
        onRemoveTarget={(id) => { setTargetIds((prev) => prev.filter((x) => x !== id)); setSelectedIds((prev) => prev.filter((x) => x !== id)); }}
        onRemoveAnchor={() => setAnchor(null)}
        onClearTargets={() => { setTargetIds([]); setSelectedIds([]); setTargetComponentIds([]); setSelectedComponentIds([]); setAnchor(null); setPreset(null); }}
        preset={livePreset ? presetView(livePreset, screens, Math.min(targetScreens.length, MAX_TARGETS), versions) : null} onRemovePreset={() => setPreset(null)}
        mode={mode} onMode={onMode}
        runners={mode === 'chat' ? chatRunners : runners} runnersFailed={runnersFailed} onReloadRunners={() => void loadRunners()} runnerId={mode === 'chat' ? chatRunnerId : runnerId} onRunnerChange={onRunnerChange}
        sessions={sessionList.items} sessionsReason={sessionList.reason} sessionTool={agentTool} sessionId={sessionId} onSessionChange={onSessionChange} onSessionsOpen={loadSessions}
        hidden={!composerVisible} onResize={setComposerH}
      />
      {/* 项目没到手时只留三个本机开关可用，其余写明为什么用不了 */}
      <CanvasToolbar groups={ready ? tools : tools.map((g) => g.map((t) => (['composer', 'minimap', 'links'].includes(t.id) ? t : { ...t, unavailable: pendingReason })))} />
      {panelBody && <div key={panel} ref={panelRef} className="chrome slide-in-right absolute bottom-4 right-[var(--rail-w)] top-16 z-20 flex w-[var(--panel-w)] flex-col overflow-hidden rounded-xl">{panelBody}</div>}
      {proposal && detail && <ProposalDialog proposal={proposal} ds={detail.designSystem} busy={busy} screenCount={screens.length} batches={Math.ceil(screens.length / MAX_TARGETS)} onWrite={writeProposal} onFinish={finishProposal} onClose={() => setProposal(null)} />}
      {newComponentOpen && <NewComponentDialog onCreate={createComponent} onClose={() => setNewComponentOpen(false)} />}
      {finderOpen && detail && <ScreenFinder screens={screens} components={components} links={detail.links} busy={busyScreens} onPick={(pick) => { setFinderOpen(false); reveal(pick); }} onClose={() => setFinderOpen(false)} />}
      {variantFor && <VariantDialog base={variantFor} onCreate={createVariant} onClose={() => setVariantFor(null)} />}
      {confirmDelete && (selectedScreens.length > 0 || selectedComponents.length > 0) && <DeleteDialog screens={selectedScreens} components={selectedComponents} selected={selected} variantCount={screens.filter((s) => s.variantOf && selectedIds.includes(s.variantOf) && !selectedIds.includes(s.id)).length} onConfirm={onDelete} onClose={() => setConfirmDelete(false)} />}
      {missing && <MissingDialog missing={missing} busyReason={generating ? GENERATE_BUSY : false} onGenerate={generateMissing} onClose={() => setMissing(null)} />}
    </div>
  );
}

// 画布区的加载 / 失败态（v0.76）：外壳照常，只有这一块换。加载中是空画布加一枚状态胶囊（300 ms 后才显形，快的时候不闪）；
// 失败写明发生了什么与下一步（IA-009）：项目不存在 → 回到最近的项目；其余 → 重试。
// 摆在可用区（与画布的 safe-area 探针同一组 CSS 变量）中央、层级压过对话记录：窄视口下对话记录盖在画布上，出口不能被它挡住
function CanvasPending({ failure, onRetry }: { failure: LoadFailure; onRetry: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="viewport" data-testid="canvas-pending" data-state={failure?.kind ?? 'loading'}>
      <div className="pointer-events-none absolute bottom-[var(--chrome-bottom)] left-[var(--chrome-left)] right-[var(--chrome-right)] top-[var(--chrome-top)] z-[25] grid place-items-center p-4">
      {!failure ? (
        <div role="status" className="pending-in chrome flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-muted">
          <span className="size-3.5 animate-spin rounded-full border-2 border-muted border-r-transparent motion-reduce:animate-none" aria-hidden="true" />加载项目…
        </div>
      ) : (
        <div role="alert" className="pointer-events-auto fade-up chrome w-[min(24rem,100%)] rounded-xl p-4">
          <p className="text-sm font-semibold text-fg">{failure.kind === 'not-found' ? '这个项目不存在或已被删除' : '项目没加载出来'}</p>
          <p className="mt-1 text-xs text-muted leading-cn">{failure.kind === 'not-found' ? '可能在别的标签页里删掉了，或者链接里的项目 id 不对。' : `${failure.reason}。确认 Quilt 还在运行，然后重试。`}</p>
          <div className="mt-3">
            {failure.kind === 'not-found'
              ? <Button variant="primary" size="sm" onClick={() => navigate('/')}>回到最近的项目</Button>
              : <Button variant="primary" size="sm" onClick={onRetry}>重试</Button>}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
