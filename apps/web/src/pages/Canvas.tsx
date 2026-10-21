import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Bot, Component, Crosshair, Download, History, Layers, LayoutList, Link2, Map as MapIcon, Maximize2, MousePointerClick, NotebookPen, Palette, Plus, Search, Settings, SquareStack, Star, TextCursorInput, Trash2, Waypoints, X } from 'lucide-react';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, DEVICE_SIZE, failureText, missingPagePrompt, type ComponentDto, type ProjectDetailDto, type JobDto, type JobEventDto, type ScreenDto, type Tokens, type Runner, type ScreenCount, type DesignProposalDto } from '@quilt/core/browser';
import { api, ApiError, loadConfig, subscribeProjectEvents, type LiveState } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { rememberLastProject } from '@/lib/lastProject';
import { Button, Spinner } from '@/ui/ui';
import { TopNav } from '@/project/TopNav';
import { ProjectSwitcher } from '@/project/ProjectSwitcher';
import { CanvasView, type CanvasApi } from '@/canvas/CanvasView';
import { ScreenFinder, type FinderPick } from '@/canvas/ScreenFinder';
import { ScreensPanel } from '@/panels/ScreensPanel';
import { CanvasToolbar, type Tool } from '@/canvas/CanvasToolbar';
import { isSettingsSection, type SettingsSection } from '@/settings/sections';
import { Composer, type ComposerHandle } from '@/composer/Composer';
import { jobChips, useEndedJobs } from '@/composer/JobChips';
import { useRunnerPrefs } from '@/composer/useRunnerPrefs';
import { useComposerChrome } from '@/composer/useComposerChrome';
import { CandidateStack } from '@/canvas/CandidateStack';
import { ArrangeBar } from '@/canvas/ArrangeBar';
import { usePositionDrafts, usePositionUndo } from '@/canvas/positions';
import { useUndoStack } from '@/canvas/undo';
import { coveredScreens, jobLabel, type JobInput } from '@/canvas/jobs';
import { reconcileJobs, settleJob, progressText } from '@/canvas/jobTracker';
import { DeleteDialog, MissingDialog, NewComponentDialog, VariantDialog } from '@/canvas/dialogs';
import { RevisionPanel } from '@/panels/RevisionPanel';
import type { ElementSel, DirectEdit, InspectorKeys } from '@/panels/InspectorPanel';
import { AgentJobsPanel } from '@/panels/AgentJobsPanel';
import { getLocale, tOf, useLocale, useT, type Locale } from '@/i18n';
import canvasPageMessages from '@/i18n/locales/canvas-page';
import commonMessages from '@/i18n/locales/common';
import inspectMessages from '@/i18n/locales/panels-inspect';

// 低频的面板与弹层按需加载（PERF-3 v1.06）：首屏不解析它们。画布空闲两秒后预取，真用到时多半已在缓存里；
// 面板槽位在载入期间占位成同一个框、居中转圈，载入后原地出现，不跳
const loadSettings = () => import('@/settings/SettingsModal');
const loadDesign = () => import('@/panels/DesignPanel');
const loadInspector = () => import('@/panels/InspectorPanel');
const loadProposal = () => import('@/panels/ProposalDialog');
const SettingsModal = lazy(() => loadSettings().then((m) => ({ default: m.SettingsModal })));
const DesignPanel = lazy(() => loadDesign().then((m) => ({ default: m.DesignPanel })));
const InspectorPanel = lazy(() => loadInspector().then((m) => ({ default: m.InspectorPanel })));
const ProposalDialog = lazy(() => loadProposal().then((m) => ({ default: m.ProposalDialog })));
const PanelLoading = () => <div className="flex flex-1 items-center justify-center"><Spinner /></div>;

type Panel = 'revisions' | 'design' | 'inspect' | 'agent' | 'screens' | null;
const MINIMAP_KEY = 'quilt:minimap';
const ICON = 18;
const MAX_TARGETS = 20; // API-CORE-010 契约上限
// 详情还没到时的屏与组件：同一个空数组，依赖它们的 memo 不必每次渲染都重算
const NONE: never[] = [];
// 稳定回调（refresh）里取文案用它：按调用时的界面语言取，不进依赖——换语言不该重取项目、重连事件流
const tNow = tOf(canvasPageMessages);
const tInspect = tOf(inspectMessages);
// 检查器直改的种类 → 撤销提示里的动作名（与检查器按钮同名）
const DIRECT_EDIT_LABEL = { remove: 'inspector.deleteElement', detach: 'inspector.lock.detach', edit: 'inspector.editElement' } as const;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const ALT = MAC ? '⌥' : 'Alt+';
const CMD = MAC ? '⌘' : 'Ctrl+';

// 新建组件时的占位内容（REQ-EDIT-006）：建完立刻在输入框里描述它，第一句「改组件」就把它写出来
const NEW_COMPONENT_HTML = '<div class="p-4 text-sm text-on-surface-variant">New component</div>';
// 签名续取（v0.76）：截图签名至少有效 5 分钟、预览签名至少 10 分钟（API 的 stableExpiry），页面可见时距上次取到详情满 4 分钟就静默重取
const RENEW_MS = 4 * 60_000;

// 画布区取不到项目时的两种失败（v0.76）；null = 没失败（加载中或已就绪）。reason 为 null = 连不上服务，渲染时按当时的界面语言写
type LoadFailure = { kind: 'not-found' } | { kind: 'failed'; reason: string | null } | null;
// 作业进度存原始事件、渲染时再成句：换界面语言后 chip 上的进度跟着换
type JobProgress = { type: 'progress' | 'screen_planned' | 'screen_html_ready'; data: Record<string, unknown> };
// 结束了的作业 chip 的原始字段：作业、结束那一刻的屏与组件表（作业名按它们写）、失败原因（failureText 按界面语言成句）
type EndedFrom = { job: JobDto; screens: ScreenDto[]; components: ComponentDto[]; errorClass?: string; message?: string };
const endedReason = (f: EndedFrom, locale: Locale) => failureText(f.job.kind, f.errorClass, f.message, 0, locale);

// PAGE-CANVAS：画布 + 输入框 + 修订/设计系统/检查器面板（面板状态进 URL，INT-020）

// 画布页按项目重挂（v0.76）：/p/:projectId 是同一个路由、切项目是客户端导航，不按项目换 key 的话选中、目标、锚点、版数、
// 聚焦 / 交互态会带进下一个项目，上一个项目在途的详情晚到还会覆盖新项目、把画布卡在加载态。外壳在新页面的第一帧就画出来
export function CanvasRoute() {
  const { projectId = '' } = useParams();
  return <CanvasPage key={projectId} />;
}

function CanvasPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const t = useT(canvasPageMessages);
  const tc = useT(commonMessages);
  const locale = useLocale();
  // 造屏名额是项目级的（REQ-CORE-020）：锚点造屏、工具栏「新建屏幕」、断链补屏建的都是 generate，互相排队但不挡改屏
  const generateBusy = t('generateBusy');
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  // 在跑作业是一组（REQ-CORE-020）：后端允许并行，前端跟踪全部非 agent 作业，进度按 jobId 分别记
  const [activeJobs, setActiveJobs] = useState<JobDto[]>([]);
  const [progress, setProgress] = useState<Record<string, JobProgress>>({});
  // 作业 chip（v1.17）：结束了还要留一会儿的那些——失败的留到关掉或重试，成功的淡出后撤
  const { ended, end: endJob, dismiss: dismissJob } = useEndedJobs();
  // 结束了的作业 chip 的文案按当时的界面语言现算（失败的一直留着，切语言要跟着换）：记下作业、结束那一刻的屏与组件表、失败原因的原始字段
  const endedFrom = useRef(new Map<string, EndedFrom>());
  // 预览域地址来自运行时配置（API-CORE-028）：打包后是 127.0.0.1:3101，开发是 preview.localhost:3101
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const loadPreviewOrigin = useCallback(() => loadConfig().then((c) => { setConfigFailed(false); setPreviewOrigin(c.previewOrigin); }).catch(() => setConfigFailed(true)), []);
  useEffect(() => { void loadPreviewOrigin(); }, [loadPreviewOrigin]);
  const [loadFailure, setLoadFailure] = useState<LoadFailure>(null);
  // 项目不存在（详情 404，含加载后在别处被删）：不再订阅项目事件流、不写断线状态（v0.83）
  const gone = loadFailure?.kind === 'not-found';
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
  const [count, setCount] = useState<ScreenCount>(1);
  const [versions, setVersions] = useState(1);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // 组件卡的交互态（REQ-EDIT-006）：与屏的聚焦互斥——两边都是「活 iframe 吃掉指针」，同时开会分不清点的是谁
  const [focusedComponentId, setFocusedComponentId] = useState<string | null>(null);
  const [navStack, setNavStack] = useState<string[]>([]);
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
  // 输入框这一条横带的探针（v0.78）：左边界是 --lane-left（停在底边时是 --composer-left），与画布可用区的左边界不是一回事（styles.css）
  const laneRef = useRef<HTMLDivElement>(null);
  // 生成通道 / 投递会话两个跨会话偏好（REQ-CORE-011 / REQ-AGENT-003）：见 useRunnerPrefs
  const { runners, runnersFailed, loadRunners, runnerId, applyCatalog, onRunnerChange, agentTool, sessionList, sessionId, loadSessions, lists, loadSessionsFor, onSessionChange, sendRunner, modelRunner } = useRunnerPrefs();
  const panel = (params.get('panel') as Panel) ?? null;
  const setPanel = useCallback((v: Panel) => setParams((q) => { if (v) q.set('panel', v); else q.delete('panel'); return q; }, { replace: true }), [setParams]);
  // 设置弹层的开关与当前节都在 URL 上（?settings=<节>，INT-020）：刷新保持，旧 /settings 路径重定向到这里；不认识的值回到第一节
  const settingsParam = params.get('settings');
  const settingsSection: SettingsSection | null = settingsParam ? (isSettingsSection(settingsParam) ? settingsParam : 'usage') : null;
  const setSettings = useCallback((v: SettingsSection | null) => setParams((q) => { if (v) q.set('settings', v); else q.delete('settings'); return q; }, { replace: true }), [setParams]);
  const settingsTool = useMemo(() => ({ get current() { return document.querySelector<HTMLElement>('[data-tool="settings"]'); } }), []);
  // 侧面板关掉后焦点归还（A11Y-013，v0.78）：挂载时记下焦点所在（点工具栏按钮打开时就是那个按钮）。卸载时焦点若在面板里、
  // 且是键盘焦点（按面板自己的「关闭」），就还给它；它已不在（快捷键打开时焦点本不在工具栏上）就给工具栏上同名的工具。
  // 鼠标点的「关闭」不挪焦点：焦点停在工具栏按钮上，接着按空格就是点它，而不是平移画布
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const a = document.activeElement;
    const opener = a instanceof HTMLElement && a !== document.body && !el.contains(a) ? a : null;
    return () => {
      const f = document.activeElement;
      if (!(f instanceof HTMLElement) || !el.contains(f) || !f.matches(':focus-visible')) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>(`[data-tool="${panel}"]`))?.focus();
      });
    };
  }, [panel]);
  // 选择元素是**全局模式**：先开模式（不必先选中某一屏），再点任意一屏进去。
  // armed = 模式已开；进到某一屏（focusedId）之后才谈得上把 inspect 下发给屏内运行时。
  const inspectArmed = panel === 'inspect';
  // 组件卡也能选元素（v0.57）：它跑同一套运行时，qid 落在组件自己的 HTML 上
  const inspectMode = inspectArmed && (!!focusedId || !!focusedComponentId);

  // 进行中作业的终态由 SSE 事件宣告；refresh 负责与后端对账：先剔除已经结束的（事件流与刷新之间的竞态会丢终态），
  // 作业对账的三个集合（含义见 canvas/jobTracker.ts）：已列出过、已宣告终态、本页开始跟踪时的详情请求序号
  const activeJobsRef = useRef<JobDto[]>([]);
  activeJobsRef.current = activeJobs;
  const finishedRef = useRef<ReadonlySet<string>>(new Set());
  const seenRef = useRef<ReadonlySet<string>>(new Set());
  const trackedAt = useRef<ReadonlyMap<string, number>>(new Map());
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
      // 撤哪些、认领哪些由 canvas/jobTracker.ts 的 reconcileJobs 定（取舍与 v0.76 / v0.88 的反例写在那里），这里只执行
      const r = reconcileJobs(activeJobsRef.current, { seen: seenRef.current, finished: finishedRef.current, trackedAt: trackedAt.current }, d.activeJobs, seq);
      seenRef.current = r.seen; finishedRef.current = r.finished; trackedAt.current = r.trackedAt;
      if (r.gone.length) {
        const dead = new Set(r.gone);
        setActiveJobs((prev) => prev.filter((j) => !dead.has(j.id)));
        setProgress((m) => { const next = { ...m }; for (const id of dead) delete next[id]; return next; });
      }
      if (r.claim.length) {
        for (const j of r.claim) if (!beforeRef.current.has(j.id)) beforeRef.current.set(j.id, new Set(d.screens.map((x) => x.id)));
        setActiveJobs((prev) => [...prev, ...r.claim.filter((j) => !prev.some((x) => x.id === j.id))]);
      }
      return d;
    } catch (e) {
      if (seq !== detailSeq.current) return null;
      // 404 = 项目没了（书签指向已删项目、别的标签页刚删掉）：任何时候都转到「不存在」态，画布撤掉
      if (e instanceof ApiError && e.status === 404) { hasDetail.current = false; setDetail(null); setLoadFailure({ kind: 'not-found' }); return null; }
      if (!hasDetail.current) setLoadFailure({ kind: 'failed', reason: e instanceof ApiError ? e.problem.title : null });
      else if (!quiet) toast(e instanceof ApiError ? e.problem.title : tNow('load.refreshFailed'), 'error');
      return null;
    }
  }, [projectId, toast, drafts]);

  useEffect(() => { refresh(); }, [refresh]);
  const retryLoad = () => { setLoadFailure(null); setConfigFailed(false); void loadPreviewOrigin(); void refresh(); };
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
  // 草稿本（REQ-CORE-040）：地址是草稿本的 id 时换到 /sketch，画布不摆它；普通项目记成「上次打开的项目」（「写回项目…」的缺省目标，REQ-CORE-041）
  const navigate = useNavigate();
  const projectKind = detail?.project.kind;
  useEffect(() => {
    if (projectKind === 'sketchbook') navigate('/sketch', { replace: true });
    else if (projectKind) rememberLastProject(projectId);
  }, [projectKind, projectId, navigate]);

  const screens = detail?.screens ?? NONE;
  const screensRef = useRef(screens);
  screensRef.current = screens;

  // 作业事件（API-CORE-008）：变更即刷新项目（防抖）；导出作业成功后自动下载；
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
  // 项目级事件（API-CORE-030 v0.34）：本机会话经 MCP 回写、别处建的作业、截图就绪都会到这里——刷新项目（聚焦中的屏走热更新）
  // 一个标签页只开这一条长连接（API-CORE-030 / §16 连接预算）：浏览器对同源 HTTP/1.1 只给 6 条并发、
  // 且所有标签页共用，按作业各开一条的话多开两三个项目就把额度占满、普通请求全部排队。
  // 项目不存在时不连：事件流对它回 404，连着只会按退避一直重连、3 s 后顶栏写「重连中」
  useEffect(() => gone ? undefined : subscribeProjectEvents(projectId, (e) => {
    scheduleRefresh();
    if (e.type !== 'job_changed') return;
    const p = e.data as { jobId?: string; type?: string; seq?: number; data?: unknown } | undefined;
    if (!p?.jobId || !p.type) return;
    const job = activeJobsRef.current.find((j) => j.id === p.jobId);
    // 别处建的作业（本机会话投递、另一个标签页发的）本页没跟踪，上面的整体重取已经覆盖
    if (job) onJobEvent.current(job, { type: p.type as JobEventDto['type'], data: p.data ?? {}, seq: p.seq ?? 0, at: e.at });
  }, (st) => {
    setFeed(st);
    // 事件不续传：断过之后重新连上就整体重取一次，补上断线期间丢掉的作业终态、截图就绪与回写
    if (st !== 'open') { feedBroken.current = true; return; }
    if (feedBroken.current) { feedBroken.current = false; void refresh({ quiet: true }); }
  }), [projectId, scheduleRefresh, refresh, feedEpoch, gone]);
  // 处理器放 ref：闭包每帧刷新，订阅不动
  const onJobEvent = useRef<(job: JobDto, e: JobEventDto) => void>(() => {});
  onJobEvent.current = (job, e) => {
    const d = e.data as Record<string, unknown>;
    const setP = (p: JobProgress) => setProgress((m) => ({ ...m, [job.id]: p }));
    // 聊天作业的进度是助手每次工具调用的一句话（REQ-CORE-023）
    // 改组件（REQ-EDIT-006）：模型回来后先确定性回刷用它的屏，再逐屏截图
    if (e.type === 'progress') setP({ type: e.type, data: d });
    if (e.type === 'screen_planned') { setP({ type: e.type, data: d }); scheduleRefresh(); }
    if (e.type === 'screen_html_ready') { setP({ type: e.type, data: d }); scheduleRefresh(); }
    if (e.type === 'screen_screenshot_ready') scheduleRefresh();
    if (e.type === 'succeeded' || e.type === 'failed' || e.type === 'cancelled') {
      const settled = settleJob({ seen: seenRef.current, finished: finishedRef.current, trackedAt: trackedAt.current }, job.id);
      seenRef.current = settled.seen; finishedRef.current = settled.finished; trackedAt.current = settled.trackedAt;
      const before = beforeRef.current.get(job.id) ?? new Set<string>();
      beforeRef.current.delete(job.id);
      setActiveJobs((prev) => prev.filter((j) => j.id !== job.id));
      setProgress((m) => { const next = { ...m }; delete next[job.id]; return next; });
      refresh();
      // 作业 chip：失败的变成警告色 chip 留着（写原因、可重试），成功的写「完成」后淡出，取消的直接消失
      const from: EndedFrom = { job, screens, components, errorClass: d.errorClass as string | undefined, message: d.message as string | undefined };
      if (e.type !== 'cancelled') endedFrom.current.set(job.id, from);
      const chip = { id: job.id, createdAt: job.createdAt, label: jobLabel(job, screens, components), kind: job.kind };
      // 失败只在 chip 上说（v1.17）：chip 留到用户关掉，再弹一条提示条是同一件事说两遍
      if (e.type === 'failed') endJob({ ...chip, state: 'failed', reason: endedReason(from, getLocale()) });
      if (e.type === 'succeeded') endJob({ ...chip, state: 'succeeded' });
      if (e.type === 'succeeded' && job.kind === 'export_prototype') { toast(t('jobs.exported')); window.location.assign(api.exportUrl(job.id)); }
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
        }).catch(() => toast(t('jobs.proposalLost'), 'error'));
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
  // ?panel=revisions 只在恰好选中一屏时成立（INT-020 标识非法回默认，v0.78）：加载后没有选中、点空白、加选成多屏都把它从 URL 去掉——
  // 留着的话面板不显示，下次单选某屏时它自己弹出来
  useEffect(() => { if (panel === 'revisions' && detail && !selected) setPanel(null); }, [panel, detail, selected, setPanel]);
  const targetScreens = useMemo(() => screens.filter((s) => targetIds.includes(s.id)), [screens, targetIds]);
  const components = detail?.components ?? NONE;
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
  // 聚焦 iframe 此刻显示的那一屏（切了状态变体就是那张变体）：检查器、子树重生成都写到它上面——
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
  // 只有组件没有屏也没有锚点 = 改组件（REQ-EDIT-006）：一次一个，且不撞同一组件在跑的 edit_component
  // 项目还没到手时发送与工具栏一律不可用，理由随加载 / 失败态写
  const pendingReason = loadFailure?.kind === 'not-found' ? t('load.notFound') : loadFailure || configFailed ? t('load.failed') : t('load.loading');
  const blockedReason = useMemo(() => {
    if (!detail) return pendingReason;
    const targets = targetScreens.slice(0, MAX_TARGETS);
    if (!targets.length && !anchor && targetComponents.length) {
      if (targetComponents.length > 1) return t('blocked.oneComponent');
      const c = targetComponents[0];
      return guardJobs.some((j) => j.kind === 'edit_component' && (j.input as JobInput).componentId === c.id) ? t('blocked.editing', { name: c.name }) : null;
    }
    if (!targets.length) return generating ? generateBusy : null;
    const hit = targets.filter((s) => busyScreens.has(s.id));
    if (!hit.length) return null;
    return hit.length === 1 ? t('blocked.editing', { name: hit[0].name }) : t('blocked.editingMany', { n: hit.length, name: hit[0].name });
  }, [detail, pendingReason, targetScreens, targetComponents, anchor, busyScreens, generating, guardJobs, t, generateBusy]);
  // 在跑作业按创建时间倒序：最新的贴着输入框（Esc 取消的就是它，必须始终可见、不被折进「还有 N 个」）；时间相同取后加入的那个
  const runningJobs = useMemo(() => [...activeJobs].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [activeJobs]);
  // 进度兜底收在这里：作业刚建、事件还没来时 chip 也要有话说，不能看起来卡住
  const chips = useMemo(() => {
    // 已撤掉的 chip 不再留它的原始字段
    for (const id of endedFrom.current.keys()) if (!ended.some((x) => x.id === id)) endedFrom.current.delete(id);
    return jobChips(runningJobs.map((j) => {
      const p = progress[j.id];
      const text = !p ? t('progress.queued') : p.type === 'progress' ? progressText(j.kind, p.data) : p.type === 'screen_planned' ? t('progress.planned', { name: p.data.name }) : t('progress.screenshotting');
      return { id: j.id, createdAt: j.createdAt, label: jobLabel(j, screens, components), progress: text };
    }), ended.map((x) => {
      const f = endedFrom.current.get(x.id);
      if (!f) return x;
      const label = jobLabel(f.job, f.screens, f.components);
      return x.state === 'failed' ? { ...x, label, reason: endedReason(f, locale) } : { ...x, label };
    }));
  }, [runningJobs, screens, components, progress, ended, t, locale]);

  const handleJobError = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.type === '/errors/screen-busy') toast(t('jobs.screenBusy'), 'error');
    else if (e instanceof ApiError && e.type === '/errors/rate-limited') toast(t('jobs.rateLimited'), 'error');
    else toast(e instanceof ApiError ? e.problem.title : fallback, 'error');
  };
  // 追加而不是替换：并行作业各自一枚 chip，且 job.input 里带着目标屏，冲突判定不必等下一次 refresh
  const trackJob = (job: JobDto) => {
    if (!beforeRef.current.has(job.id)) beforeRef.current.set(job.id, new Set(screensRef.current.map((s) => s.id)));
    if (!trackedAt.current.has(job.id)) trackedAt.current = new Map(trackedAt.current).set(job.id, detailSeq.current);
    setActiveJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
  };
  const startJob = async (body: unknown, fallback: string) => {
    try {
      const { job } = await api.projects.createJob(projectId, body);
      // 投递到本机会话的作业不进作业 chip，去 agent 面板看状态
      if (job.runner === 'agent') { refresh(); toast((job.input as { runner?: { tool?: string } })?.runner?.tool === 'codex' ? t('jobs.deliveredCodex') : t('jobs.deliveredClaude')); } else trackJob(job);
      return job;
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast(t('jobs.sessionGone'), 'error'); void loadSessions(); }
      else handleJobError(e, fallback);
      return null;
    }
  };
  // 一轮建好（发送 / 重试）：交给本机 agent 的已投递到会话，切到 agent 面板看状态，其余成一枚作业 chip
  const roundStarted = (job: JobDto) => {
    if (job.runner === 'agent') { refresh(); setPanel('agent'); }
    else trackJob(job);
  };
  // 失败 chip 的「重试」（REQ-CORE-026，API-CORE-034）：原样再发一轮——服务端复制原作业输入，这里只给通道：输入框此刻选的那条。
  // 重试按用户消息定位：每个作业建出来时服务端都写了一条带 jobId 的用户消息，用这一个作业的那条；聊天作业（只经接口发起）沿用它原来的通道。
  // 发出去了就撤掉旧的这枚，新作业成一枚在跑的 chip；没发出去旧的留着、说原因
  const retryJob = async (id: string) => {
    const failed = ended.find((x) => x.id === id);
    if (!failed) return;
    try {
      const user = (await api.projects.messages(projectId)).items.find((m) => m.role === 'user' && m.jobId === id);
      if (!user) { toast(t('jobs.retryNoRecord'), 'error'); return; }
      roundStarted((await api.projects.retry(projectId, user.id, failed.kind === 'chat' ? undefined : sendRunner)).job);
      dismissJob(id);
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/job-not-finished') toast(t('jobs.retryNotFinished'), 'error');
      else if (e instanceof ApiError && e.type === '/errors/validation') toast((e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title, 'error');
      else handleJobError(e, t('jobs.retryFailed'));
    }
  };
  // 发送（REQ-CORE-006）：有目标 = 改（targetScreenIds），没有 = 造（count / anchor）；版数两边都带。
  // 返回是否发出去了：没发出去时输入框保留草稿与参考图（REQ-CORE-020）
  // 共享组件目标（REQ-EDIT-006）：随消息带上——只有组件没有屏也没有锚点时服务端建的是 edit_component，其余是上下文
  const onSend = async (content: string, attachmentIds: string[] = []): Promise<boolean> => {
    const targets = targetScreens.length ? targetScreens.slice(0, MAX_TARGETS).map((s) => s.id) : undefined;
    const compTargets = targetComponents.length ? targetComponents.map((c) => c.id) : undefined;
    try {
      const r = await api.projects.send(projectId, { content, targetScreenIds: targets, targetComponentIds: compTargets, count: targets ? undefined : count, versions, anchor: targets ? undefined : anchor ?? undefined, runner: sendRunner, attachmentIds: attachmentIds.length ? attachmentIds : undefined });
      roundStarted(r.job);
      if (!targets) setAnchor(null);
      return true;
    } catch (e) {
      // 记住的会话在发送前关掉了：说清楚并重取列表，下拉会回到「选择会话」
      if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast(t('jobs.sessionGone'), 'error'); void loadSessions(); }
      // 预判之外真撞上了（别处刚建的作业、多屏改屏的后端缺口）：problem 体不带屏信息，重取项目后用本轮目标 ∩ 覆盖屏集点名
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') {
        const d = await refresh();
        const ids = new Set((d?.activeJobs ?? []).flatMap((j) => coveredScreens(j, (d?.screens ?? []).map((s) => s.id), d?.components ?? [])));
        const hit = targets?.map((id) => (d?.screens ?? []).find((s) => s.id === id)).find((s) => s && ids.has(s.id));
        toast(hit ? t('blocked.editing', { name: hit.name }) : targets ? t('blocked.targetsBusy') : generateBusy, 'error');
      }
      else handleJobError(e, t('jobs.sendFailed'));
      return false;
    }
  };
  // 取消一个在跑作业：chip 上的 × 按 id 取消，Esc 取消最新那一个（按一次取消一个）。
  // 记进 finishedRef 防被迟到的 GET 重新认领；chip 的消失由 cancelled 事件（或下一次对账）宣告
  const cancelJob = async (id: string) => {
    try { await api.jobs.cancel(id); finishedRef.current = new Set([...finishedRef.current, id]); }
    catch (e) {
      // 连按两次会撞上「它已经结束了」，这不是失败，不必打扰用户
      if (e instanceof ApiError && e.type === '/errors/job-finished') return;
      toast(t('jobs.cancelFailed'), 'error');
    }
  };
  const cancelNewest = () => { const j = runningJobs[0]; if (j) void cancelJob(j.id); };
  // 画布撤销栈（⌘Z，undo.ts）：位置改动与检查器的直改共用。拖动落库、多选排列在 positions.ts 的 usePositionUndo，这里只接线
  const undoStack = useUndoStack(toast);
  // 预取按需加载的面板与弹层（见文件顶部）
  useEffect(() => { const t = setTimeout(() => { void loadSettings(); void loadDesign(); void loadInspector(); void loadProposal(); }, 2000); return () => clearTimeout(t); }, []);
  const { onMove, arrange } = usePositionUndo({ drafts, screensRef, components, setDetail, refresh, toast, pushStep: undoStack.push, undo: () => void undoStack.undo() });
  // 检查器直改的撤销（v0.95）：回溯到改前那一版，expectedRevisionId 是这次直改落下的修订——之后被别的写入改过就不撤，免得把后来的改动一起冲掉。
  // 回溯会新建一版（内容同改前那一版）：记下「改前那一版现在由哪一版接替」，连按 ⌘Z 时下一步按接替的那一版比，否则第二下必定判成冲突。
  // 组件里的直改撤不了（会同步到所有用它的屏），也压一步：撤到它时说明，不越过它去撤更早的一步
  const succeeded = useRef(new Map<string, string>());
  const latest = (rev: string) => { let r = rev; while (succeeded.current.has(r)) r = succeeded.current.get(r)!; return r; };
  // 撤销步晚于直改才跑，提示文案按撤销那一刻的界面语言取（tNow / tInspect），不用压栈时那一帧的 t
  const onDirectEdit = (e: DirectEdit) => undoStack.push('componentName' in e
    ? { label: '改组件', run: async () => { toast(tNow('undo.componentEdit', { name: e.componentName }), 'error'); return 'drop'; } }
    : { label: e.op, run: async () => {
      try {
        const { revision } = await api.screens.restore(e.screenId, e.before, latest(e.after));
        succeeded.current.set(e.before, revision.id);
        toast(tNow('undo.done', { label: tInspect(DIRECT_EDIT_LABEL[e.op]) })); refresh(); return 'done';
      }
      catch (err) {
        if (err instanceof ApiError && err.type === '/errors/screen-busy') { toast(tNow('undo.busy'), 'error'); return 'keep'; }
        if (err instanceof ApiError && err.type === '/errors/revision-conflict') { toast(tNow('undo.conflict'), 'error'); return 'drop'; }
        toast(tNow('undo.failed'), 'error'); return 'keep';
      }
    } });
  const inspectorKeys = useRef<InspectorKeys | null>(null);
  const targetOnlyComponent = (id: string) => { setSelectedIds([]); setTargetIds([]); setAnchor(null); setSelectedComponentIds([id]); setTargetComponentIds([id]); showComposer(); };
  // 新建组件（REQ-EDIT-006）：先起名建一个占位组件，选成唯一目标，接着在输入框里描述它——第一句「改组件」就把它写出来
  const createComponent = async (name: string) => {
    const { component } = await api.components.create(projectId, { name, html: NEW_COMPONENT_HTML });
    setNewComponentOpen(false);
    await refresh();
    targetOnlyComponent(component.id);
    toast(t('component.created', { name }));
  };
  // 检查器「改组件」：把组件设为唯一目标（屏目标让位——这一句说的是组件，不是屏）
  const onEditComponent = (name: string) => {
    const c = components.find((x) => x.name === name);
    if (!c) { toast(t('component.gone'), 'error'); return; }
    targetOnlyComponent(c.id);
  };
  // 删选中的屏与组件（REQ-EDIT-006）：先屏后组件；组件删掉后屏里已展开的那份留着、只是不再跟着改
  const onDelete = async () => {
    if (selectedScreens.length === 0 && selectedComponents.length === 0) return;
    setConfirmDelete(false);
    const failed: string[] = [];
    for (const s of selectedScreens) {
      try { await api.screens.remove(s.id); }
      catch (e) { failed.push(e instanceof ApiError && e.type === '/errors/screen-busy' ? t('remove.screenBusy', { name: s.name }) : s.name); }
    }
    for (const c of selectedComponents) {
      try { await api.components.remove(c.id); }
      catch { failed.push(t('remove.component', { name: c.name })); }
    }
    const gone = new Set(selectedScreens.map((s) => s.id));
    const goneComps = new Set(selectedComponents.map((c) => c.id));
    setSelectedIds([]); setTargetIds((t) => t.filter((id) => !gone.has(id)));
    setSelectedComponentIds([]); setTargetComponentIds((t) => t.filter((id) => !goneComps.has(id)));
    refresh();
    const total = selectedScreens.length + selectedComponents.length;
    if (failed.length) toast(t('remove.failed', { count: failed.length, names: failed.join(t('remove.separator')) }), 'error');
    else toast(total > 1 ? t('remove.doneMany', { n: total }) : t('remove.done'));
  };
  // REQ-PROTO-003：懒生成 = 钉死路由的 generate
  const generateMissing = async (fromScreenId: string, route: string) => {
    setMissing(null);
    const job = await startJob({ kind: 'generate', input: { prompt: missingPagePrompt(route), count: 1, versions: 1, route, fromScreenId, runner: modelRunner } }, t('jobs.generateFailed'));
    if (job) toast(t('jobs.generatingRoute', { route }));
  };
  // REQ-CORE-014：双击空白 / ⌥G 放锚点，然后聚焦输入框；锚点让屏目标让位（造）
  const placeAnchor = (world: { x: number; y: number }) => {
    if (generating) { toast(generateBusy, 'error'); return; }
    setAnchor(world); setSelectedIds([]); setTargetIds([]);
    showComposer();
  };
  const exportPrototype = () => startJob({ kind: 'export_prototype', input: {} }, t('jobs.exportFailed'));
  // REQ-PROTO-002：连线开关（本机记忆）与「接上跳转」修复轮（edit_screens 固定指令，按屏计费）
  const [showLinks, setShowLinks] = useState(() => { try { return localStorage.getItem('quilt:links') !== '0'; } catch { return true; } });
  const toggleLinks = () => setShowLinks((v) => { try { localStorage.setItem('quilt:links', v ? '0' : '1'); } catch { /* 无痕模式等写不了，退化为仅本次会话有效 */ } return !v; });
  // 选中了就只修选中的那几屏，没选中才作用于全部（契约上限 20 屏）
  // 超过 20 屏（API-CORE-010 的上限）每 20 屏一个作业，全部发出（REQ-PROTO-002 v1.03）；有批次没发出去时说清还剩几屏
  const repairLinks = async () => {
    const targets = selectedIds.length ? selectedScreens : screens;
    let sent = 0;
    for (let i = 0; i < targets.length; i += MAX_TARGETS) {
      const batch = targets.slice(i, i + MAX_TARGETS);
      if (!(await startJob({ kind: 'edit_screens', input: { prompt: LINK_REPAIR_PROMPT, screenIds: batch.map((s) => s.id), versions: 1 } }, t('repair.failed')))) break;
      sent += batch.length;
    }
    if (sent === targets.length) toast(targets.length > MAX_TARGETS ? t('repair.startedBatches', { n: sent, batches: Math.ceil(sent / MAX_TARGETS) }) : t('repair.started', { count: sent }));
    else if (sent) toast(t('repair.partial', { sent, rest: targets.length - sent }), 'error');
  };
  const applyDesignSystem = () => startJob({ kind: 'apply_design_system', input: { screenIds: 'all' } }, t('jobs.applyFailed'));
  // REQ-EDIT-002：通道由检查器自己选（记忆独立于输入框），本机 agent 时作业投递到会话、提示词限定只重写该子树。
  // 发出后不清选中——面板留在这个元素上，回写后由热更新重选刷新
  const regenerateSubtree = async (qid: string, prompt: string, runner: Runner | undefined): Promise<boolean> => {
    if (!shownScreen?.currentRevisionId) return false;
    const job = await startJob({ kind: 'regenerate_subtree', input: { screenId: shownScreen.id, qid, prompt, expectedRevisionId: shownScreen.currentRevisionId, runner } }, t('jobs.regenerateFailed'));
    return !!job;
  };
  // 出变体（REQ-CORE-025）：钉死默认屏路由的 generate；建不成时抛出去让弹层留着报错
  const createVariant = async (name: string, prompt: string) => {
    if (!variantFor) return;
    const job = await startJob({ kind: 'generate', input: { prompt, count: 1, versions, variantOf: variantFor.id, variantName: name, runner: modelRunner } }, t('variant.failed'));
    if (!job) throw new Error(t('variant.failed'));
    setVariantFor(null);
    toast(t('variant.started', { base: variantFor.name, name }));
  };
  // 呈现方式（REQ-PROTO-005）：元数据，PATCH 即生效，不重烤修订
  const togglePresentation = async () => {
    if (!selected) return;
    const next = selected.presentation === 'overlay' ? 'push' : 'overlay';
    try { await api.screens.patch(selected.id, { presentation: next }); await refresh(); toast(next === 'overlay' ? t('screen.overlaySet', { name: selected.name }) : t('screen.fullSet', { name: selected.name })); }
    catch { toast(t('screen.settingFailed'), 'error'); }
  };
  // REQ-CORE-016：样板屏
  const setExemplar = async () => {
    if (!selected) return;
    try { await api.projects.patch(projectId, { exemplarScreenId: selected.id }); toast(t('screen.exemplarSet', { name: selected.name })); refresh(); }
    catch { toast(t('screen.settingFailed'), 'error'); }
  };
  // 到草稿本里改（REQ-CORE-043）：工具栏带整屏、检查器带选中的那一块，建好草稿就打开草稿本落在它上面（API-CORE-048）
  const [forking, setForking] = useState(false);
  const forkToSketch = async (screenId: string, qid?: string) => {
    if (forking) return;
    setForking(true);
    try { const { screen } = await api.sketchbook.createDraft({ fromScreenId: screenId, qid }); navigate(`/sketch?d=${screen.id}`); }
    catch (e) { toast(t('screen.forkFailed', { reason: e instanceof ApiError ? (e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title : t('load.unreachable') }), 'error'); }
    finally { setForking(false); }
  };
  // REQ-EDIT-003：设计系统只显式改——面板里的一句话指令建 propose_design_system 作业，成功后弹预览
  const propose = async (instruction: string) => {
    const job = await startJob({ kind: 'propose_design_system', input: { instruction, runner: modelRunner } }, t('design.proposeFailed'));
    if (job) toast(t('design.proposing'));
  };
  // 提案「确认写入」即落库（v0.78）；返回是否写成——写不成提案弹层留着，可以再点一次
  const writeProposal = async (choice: { conventions: string[]; tokens: DesignProposalDto['tokens'] }): Promise<boolean> => {
    if (!detail) return false;
    try {
      await api.designSystem.update(projectId, { conventions: choice.conventions, ...(choice.tokens ?? {}), expectedVersion: detail.designSystem.version });
      toast(t('design.updated'));
      await refresh();
      return true;
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? t('design.conflict') : t('design.writeFailed'), 'error');
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
      if (!(await startJob({ kind: 'edit_screens', input: { prompt: CONVENTIONS_REGENERATE_PROMPT, screenIds: batch.map((s) => s.id), versions: 1 } }, t('jobs.regenerateFailed')))) break;
      sent += batch.length;
    }
    if (sent < screens.length) toast(t('jobs.regeneratePartial', { sent, rest: screens.length - sent }), 'error');
  };

  // 输入框的停靠与收起（useComposerChrome）：输入框停的边与大小换算成画布安全区（--chrome-*）
  const { composerVisible, showComposer, toggleComposer, composerDock } = useComposerChrome(focusedId, composerRef);
  const openDesign = () => { if (panel === 'design') setPanel(null); else { setSelectedIds([]); setPanel('design'); } };
  // 交互态与选择元素态互斥，退出任一都回到静态截图（卡片本来的样子）。
  // 从交互态切进来时若已在屏内跳转过，先把 iframe 拉回这张卡片自己的那一屏——
  // 否则选中的元素属于别的屏，与卡片截图对不上。
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
  // 检查器的键盘等价物（v0.95）：选择元素态下选中了元素时 Delete / Backspace 删元素（优先于删屏 / 删组件）；⌘S 只要检查器里有选中元素
  const elementDeletable = panel === 'inspect' && inspectMode && !!elementSel;
  const removeElement = () => inspectorKeys.current?.remove();
  const saveElement = panel === 'inspect' && elementSel ? () => inspectorKeys.current?.save() : undefined;
  // 适配视图：缩到下限仍装不下全部时说一声，不静默裁掉（v0.76）
  const fitAll = () => { if (canvasApi.current && !canvasApi.current.fitView()) toast(t('screen.fitTooBig', { key: `${CMD}K` })); };
  // 恰好选中一屏（或只选了一个组件）时 Enter 进入交互（v0.80）：双击的键盘等价入口，iframe 就绪后焦点移进去
  const enterTarget = focusedId || focusedComponentId ? null : selected ?? (selectedScreens.length === 0 && selectedComponents.length === 1 ? selectedComponents[0] : null);
  const plain: Record<string, (() => void) | undefined> = {
    KeyF: () => fitAll(),
    Enter: enterTarget ? () => canvasApi.current?.enter(enterTarget.id) : undefined,
    KeyL: toggleLinks,
    Delete: elementDeletable ? removeElement : deletable ? () => setConfirmDelete(true) : undefined,
    Backspace: elementDeletable ? removeElement : deletable ? () => setConfirmDelete(true) : undefined,
  };
  const alted: Record<string, (() => void) | undefined> = {
    KeyD: openDesign,
    KeyT: () => setPanel(panel === 'agent' ? null : 'agent'),
    KeyR: selected && !focusedId ? () => setPanel(panel === 'revisions' ? null : 'revisions') : undefined,
    KeyG: () => canvasApi.current?.createAtCenter(),
    KeyC: detail ? () => setNewComponentOpen(true) : undefined,
    KeyS: () => setPanel(panel === 'screens' ? null : 'screens'),
    KeyV: selected && !selected.variantOf && !focusedId ? () => { if (generating) toast(generateBusy, 'error'); else setVariantFor(selected); } : undefined,
  };
  // busy = 有任何作业在跑（导出、接上跳转等仍按这个语义走）
  const busy = activeJobs.length > 0;
  // 回刷所有屏、按新约定重生成要改全部屏，与任何在跑作业都冲突：挡住时写出是哪个作业（PAGE-CANVAS「作业进行中时的面板」）
  const busyReason = runningJobs.length ? t('blocked.jobRunning', { label: jobLabel(runningJobs[0], screens, components) }) : false;
  const keyState = {
    plain, alted, toggleInspect, toggleComposer, undo: undoStack.undo, saveElement, blocked, closeModals, openFinder: () => setFinderOpen(true), expanded: !!candidates, busy, cancel: cancelNewest,
    focused: !!focusedId || !!focusedComponentId, exitFocus: () => { setFocusedId(null); setFocusedComponentId(null); },
    inspecting: inspectMode, climb: (dir: 'up' | 'down') => canvasApi.current?.climb(dir),
    panel: !!panel, closePanel: () => setPanel(null),
    selection: selectedIds.length > 0 || selectedComponentIds.length > 0, clearSelection: () => { setSelectedIds([]); setSelectedComponentIds([]); },
    // ⌘A 全选屏与共享组件卡（组件卡与屏一样进选中集合，REQ-EDIT-006）
    selectAll: () => { setSelectedIds(screens.map((x) => x.id)); setSelectedComponentIds(components.map((c) => c.id)); },
  };
  const keyRef = useRef(keyState);
  keyRef.current = keyState;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 由近及远、每次只关一层（DESIGN §13）：弹窗 → 编辑控件只失焦 → 候选 → 聚焦 → 面板 / 模式 → 选中 → 取消最新作业。
      // 取消作业不可撤销，只能是最后一层：面板、待命模式、选中不在链上时，按 Esc 想关面板或失焦，结果把在跑作业取消了
      if (e.key === 'Escape') {
        // 下拉、菜单这类控件自己接住的 Esc（关层时 preventDefault）不再往外走
        if (e.defaultPrevented) return;
        const k = keyRef.current;
        // 弹层自己的 Esc 只在焦点落在弹层内时生效（useModal）；点过一个随即禁用的按钮后焦点会掉到 body，这里兜底关掉
        if (k.blocked) { k.closeModals(); return; }
        // 面板里的输入框（检查器、设计系统……）只失焦，草稿留着；底部输入框自己处理 Esc 并拦下冒泡
        const field = (e.target as HTMLElement | null)?.closest<HTMLElement>('input, textarea, select, [contenteditable]');
        if (field) { field.blur(); return; }
        if (k.expanded) { setCandidates(null); return; }
        if (k.focused) { k.exitFocus(); return; }
        if (k.panel) { k.closePanel(); return; }
        if (k.selection) { k.clearSelection(); return; }
        if (k.busy) { e.preventDefault(); k.cancel(); }
        return;
      }
      // ⌘/ 收起 / 显示输入框：正打着字想看画布时也要能按，所以放在「输入框内不吃快捷键」那道门之前
      if ((e.metaKey || e.ctrlKey) && e.code === 'Slash') { e.preventDefault(); if (!keyRef.current.blocked) keyRef.current.toggleComposer(); return; }
      // ⌘K 找屏（REQ-CORE-024）：正在输入框里打字也要能按
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') { e.preventDefault(); if (!keyRef.current.blocked) keyRef.current.openFinder(); return; }
      // ⌘S 保存检查器（v0.95）：正在检查器的文案 / 类名框里改着时也要能按，同样放在这道门之前；检查器里没有选中元素时不拦浏览器
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { const save = keyRef.current.saveElement; if (!save) return; e.preventDefault(); if (!keyRef.current.blocked) save(); return; }
      // ⌘E 选择元素：焦点在底部输入框或检查器里也要能开关——开着选择元素去输入框写一句、再按 ⌘E 退出是常见动作；⌘E 在文本框里没有要保留的原生行为
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyE') { e.preventDefault(); if (!keyRef.current.blocked) keyRef.current.toggleInspect(); return; }
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      const k = keyRef.current;
      const mod = e.metaKey || e.ctrlKey;
      // 逐级选（v1.00）：选择元素态下 Shift+Enter 选父级、Enter 回到子级；焦点在按钮、链接、卡片这类控件上时 Enter 留给它自己
      if (e.key === 'Enter' && k.inspecting && !mod && !e.altKey && !e.isComposing && !k.blocked
        && !(e.target as HTMLElement).closest('button, a[href], [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [tabindex]:not([tabindex="-1"])')) {
        e.preventDefault(); k.climb(e.shiftKey ? 'up' : 'down'); return;
      }
      if (mod && e.code === 'KeyA') { e.preventDefault(); if (!k.blocked) k.selectAll(); return; }
      // ⌘Z 撤销画布位置（拖动 / 对齐 / 等距）与检查器的直改（v0.95）；对话改屏、回溯这些内容历史在修订树里，不进这个栈
      if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); if (!k.blocked) void k.undo(); return; }
      if (mod || k.blocked) return;
      // Enter 只在焦点不在任何控件上时进入交互：按钮、链接、卡片上的 Enter 各有各的激活
      if (e.code === 'Enter' && e.target !== document.body) return;
      const run = e.altKey ? k.alted[e.code] : !e.shiftKey ? k.plain[e.code] : undefined;
      if (run) { e.preventDefault(); run(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 选中元素随聚焦走：退出聚焦、换屏才清空。屏换了修订不清——热更新后由运行时按 qid 重选（quilt:reselect），
  // 检查器字段刷成新值；元素真没了（被删 / 子树重生成换了 qid）运行时回 deselect 才清
  useEffect(() => { setElementSel(null); }, [focusedId, focusedComponentId]);

  // 外壳常驻（v0.76）：顶栏、输入框、工具栏在加载与失败时照样画，只有画布区换成加载 / 失败态
  const ready = !!detail && !!tokens && !!previewOrigin && detail.project.kind !== 'sketchbook';
  const failure: LoadFailure = loadFailure ?? (configFailed ? { kind: 'failed', reason: t('load.configMissing') } : null);
  const jobBlocked = busy ? t('blocked.waitForJob') : screens.length === 0 ? t('blocked.noScreens') : false;

  const tools: Tool[][] = [
    [
      { id: 'fit', label: t('tools.fit.label'), hint: 'F', desc: t('tools.fit.desc'), icon: <Maximize2 size={ICON} />, onSelect: fitAll },
      { id: 'find', label: t('tools.find.label'), hint: `${CMD}K`, desc: t('tools.find.desc'), icon: <Search size={ICON} />, testId: 'find-screen', onSelect: () => setFinderOpen(true) },
      { id: 'screens', label: t('tools.screens.label'), hint: `${ALT}S`, desc: t('tools.screens.desc'), icon: <LayoutList size={ICON} />, active: panel === 'screens', testId: 'toggle-screens', onSelect: () => setPanel(panel === 'screens' ? null : 'screens') },
      { id: 'minimap', label: t('tools.minimap.label'), desc: t('tools.minimap.desc'), icon: <MapIcon size={ICON} />, active: minimapOn, testId: 'toggle-minimap', onSelect: toggleMinimap },
      { id: 'links', label: t('tools.links.label'), hint: 'L', desc: t('tools.links.desc'), icon: <Waypoints size={ICON} />, active: showLinks, testId: 'toggle-links', onSelect: toggleLinks },
      { id: 'composer', label: composerVisible ? t('tools.composer.hide') : t('tools.composer.show'), hint: `${CMD}/`, desc: t('tools.composer.desc'), icon: <TextCursorInput size={ICON} />, active: composerVisible, testId: 'toggle-composer', onSelect: toggleComposer },
      { id: 'inspect', label: inspectArmed ? t('tools.inspect.on') : t('tools.inspect.label'), hint: `${CMD}E`, desc: t('tools.inspect.desc'), icon: <Crosshair size={ICON} />, active: inspectArmed, onSelect: toggleInspect },
      { id: 'repair', label: t('tools.repair.label'), desc: selectedScreens.length ? t('tools.repair.descSelected', { count: selectedScreens.length }) : t('tools.repair.descAll'), icon: <Link2 size={ICON} />, testId: 'repair-links', unavailable: jobBlocked, onSelect: repairLinks },
      { id: 'design', label: t('tools.design.label'), hint: `${ALT}D`, desc: t('tools.design.desc'), icon: <Palette size={ICON} />, active: panel === 'design', onSelect: openDesign },
    ],
    [
      { id: 'new-screen', label: t('tools.newScreen.label'), hint: `${ALT}G`, desc: t('tools.newScreen.desc'), icon: <Plus size={ICON} />, testId: 'new-screen', unavailable: generating ? generateBusy : false, onSelect: () => canvasApi.current?.createAtCenter() },
      { id: 'new-component', label: t('tools.newComponent.label'), hint: `${ALT}C`, desc: t('tools.newComponent.desc'), icon: <Component size={ICON} />, testId: 'new-component', onSelect: () => setNewComponentOpen(true) },
      { id: 'export', label: t('tools.export.label'), desc: t('tools.export.desc'), icon: <Download size={ICON} />, unavailable: jobBlocked, onSelect: exportPrototype },
      { id: 'agent', label: t('tools.agent.label'), hint: `${ALT}T`, desc: t('tools.agent.desc'), icon: <Bot size={ICON} />, active: panel === 'agent', onSelect: () => setPanel(panel === 'agent' ? null : 'agent') },
    ],
  ];
  // 进入 / 退出交互是上下文组第一格的同一个工具（v0.80）：id 不变、按钮不重挂——在这一格上连点是进去再出来，焦点也一直留在这一格。
  // 拆成两个工具的话，退出后同一位置换成「出变体」（再点一下就开出变体弹层），被点的按钮卸载、焦点掉到 body
  const interact = (on: boolean, onSelect: () => void): Tool => ({ id: 'interact', label: on ? t('tools.interact.exit') : t('tools.interact.enter'), hint: on ? 'Esc' : 'Enter', desc: on ? t('tools.interact.exitDesc') : t('tools.interact.enterDesc'), icon: on ? <X size={ICON} /> : <MousePointerClick size={ICON} />, testId: 'toggle-interact', onSelect });
  if (selectedScreens.length > 0 && !focusedId) tools.push([
    ...(selected ? [
      interact(false, () => canvasApi.current?.focus(selected.id)),
      { id: 'revisions', label: t('tools.revisions.label'), hint: `${ALT}R`, desc: t('tools.revisions.desc'), icon: <History size={ICON} />, active: panel === 'revisions', onSelect: () => setPanel(panel === 'revisions' ? null : 'revisions') } satisfies Tool,
      { id: 'variant', label: t('tools.variant.label'), hint: `${ALT}V`, desc: t('tools.variant.desc'), icon: <SquareStack size={ICON} />, testId: 'new-variant', unavailable: selected.variantOf ? t('tools.variant.fromDefault') : generating ? generateBusy : false, onSelect: () => setVariantFor(selected) } satisfies Tool,
      { id: 'presentation', label: selected.presentation === 'overlay' ? t('tools.presentation.toFull') : t('tools.presentation.toOverlay'), desc: selected.presentation === 'overlay' ? t('tools.presentation.overlayDesc') : t('tools.presentation.fullDesc'), icon: <Layers size={ICON} />, testId: 'toggle-presentation', active: selected.presentation === 'overlay', onSelect: () => void togglePresentation() } satisfies Tool,
      { id: 'exemplar', label: detail?.project.exemplarScreenId === selected.id ? t('tools.exemplar.current') : t('tools.exemplar.set'), desc: t('tools.exemplar.desc'), icon: <Star size={ICON} />, testId: 'set-exemplar', active: detail?.project.exemplarScreenId === selected.id, unavailable: detail?.project.exemplarScreenId === selected.id ? t('tools.exemplar.already') : !selected.currentRevisionId ? t('tools.notGenerated') : false, onSelect: setExemplar } satisfies Tool,
      { id: 'fork', label: t('tools.fork.label'), desc: t('tools.fork.desc'), icon: <NotebookPen size={ICON} />, testId: 'fork-to-sketch', pending: forking, unavailable: !selected.currentRevisionId ? t('tools.notGenerated') : false, onSelect: () => void forkToSketch(selected.id) } satisfies Tool,
    ] : []),
    { id: 'delete', label: selectedComponents.length ? t('tools.delete.items', { n: selectedScreens.length + selectedComponents.length }) : selectedScreens.length > 1 ? t('tools.delete.screens', { n: selectedScreens.length }) : tc('delete'), hint: 'Del', desc: selectedComponents.length ? t('tools.delete.mixedDesc') : t('tools.delete.desc'), icon: <Trash2 size={ICON} />, onSelect: () => setConfirmDelete(true) },
  ]);
  // 只选了组件（REQ-EDIT-006）：上下文组给「删除组件」；改组件走输入框（它已是目标）
  if (selectedComponents.length > 0 && selectedScreens.length === 0 && !focusedId) tools.push([
    { id: 'delete-component', label: selectedComponents.length > 1 ? t('tools.deleteComponent.many', { n: selectedComponents.length }) : t('tools.deleteComponent.label'), hint: 'Del', desc: t('tools.deleteComponent.desc'), icon: <Trash2 size={ICON} />, testId: 'delete-component', onSelect: () => setConfirmDelete(true) },
  ]);
  if (focused) tools.push([
    interact(true, () => { setFocusedId(null); setFocusedComponentId(null); }),
    { id: 'back', label: t('tools.back.label'), hint: 'Alt+←', desc: t('tools.back.desc'), icon: <ArrowLeft size={ICON} />, unavailable: navStack.length === 0 && t('tools.back.none'), onSelect: () => canvasApi.current?.goBack() },
  ]);
  // 设置（v0.97 从顶栏移来）：最末单独一组，排在上下文组之后
  tools.push([
    { id: 'settings', label: t('tools.settings.label'), desc: t('tools.settings.desc'), icon: <Settings size={ICON} />, testId: 'open-settings', onSelect: () => setSettings('usage') },
  ]);

  const panelBody = !detail ? null
    : panel === 'revisions' && selected ? <RevisionPanel screen={selected} onClose={() => setPanel(null)} onRestored={refresh} />
    : panel === 'design' ? <DesignPanel ds={detail.designSystem} project={detail.project} screens={screens} assets={detail.assets} busyReason={busyReason} onClose={() => setPanel(null)} onSaved={refresh} onApplyAll={applyDesignSystem} onPropose={(i) => propose(i)} />
    : panel === 'screens' ? <ScreensPanel screens={screens} links={detail.links} busy={busyScreens} onPick={(id) => reveal({ kind: 'screen', id })} onClose={() => setPanel(null)} />
    : panel === 'agent' ? <AgentJobsPanel projectId={projectId} screens={screens} components={components} runners={runners} onClose={() => setPanel(null)} onChanged={refresh} />
    : panel === 'inspect' && focusedComponent ? <InspectorPanel component={focusedComponent} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyComponents.has(focusedComponent.id)} keysRef={inspectorKeys} onDirectEdit={onDirectEdit} tokens={tokens} onPathPick={(qid) => canvasApi.current?.pick(qid)} onPathPeek={(qid) => canvasApi.current?.peek(qid)} onClose={() => setPanel(null)} onEdited={() => { setElementSel(null); refresh(); }} />
    : panel === 'inspect' && shownScreen ? <InspectorPanel screen={shownScreen} sel={elementSel} routes={screens.map((s) => s.route)} busy={busyScreens.has(shownScreen.id)} keysRef={inspectorKeys} onDirectEdit={onDirectEdit} onUndo={() => void undoStack.undo()} tokens={tokens} onPathPick={(qid) => canvasApi.current?.pick(qid)} onPathPeek={(qid) => canvasApi.current?.peek(qid)} runners={runners} composerRunnerId={runnerId} sessionLists={lists} onSessionsOpen={(tool) => void loadSessionsFor(tool)} workingQids={workingSubtrees.filter((w) => w.screenId === shownScreen.id).map((w) => w.qid)} onClose={() => setPanel(null)} onEdited={(qid) => { canvasApi.current?.markDone([qid]); refresh(); }} onRegenerate={regenerateSubtree} onEditComponent={onEditComponent} onForkToSketch={(qid) => void forkToSketch(shownScreen.id, qid)} forking={forking} />
    : null;

  return (
    <div className="canvas-shell relative h-full" style={composerDock.shellStyle} data-panel={panelBody ? 'open' : 'closed'} data-dock={composerDock.edge} data-minimap={minimapOn && !focusedId && !focusedComponentId ? 'on' : 'off'}>
      {/* 可用区探针：四边跟着浮层占位的 CSS 变量走，画布只负责测量它，避免两处各写一套数 */}
      <div ref={safeAreaRef} aria-hidden="true" data-testid="safe-area" className="pointer-events-none absolute bottom-[var(--chrome-bottom)] left-[var(--chrome-left)] right-[var(--chrome-right)] top-[var(--chrome-top)]" />
      <div ref={laneRef} aria-hidden="true" data-testid="composer-lane" className="pointer-events-none absolute bottom-0 left-[var(--lane-left)] right-[var(--side-right)] h-0" />
      {/* 顶栏在 DOM 里排在画布之前（v0.80）：Tab 序从项目切换器开始。层级靠 z-index，不靠 DOM 顺序 */}
      <TopNav floating right={<>
        {feedShown && feed !== 'open' && !gone && (
          <span role="status" data-testid="live-status" className="chrome inline-flex h-8 min-w-0 items-center gap-0.5 truncate whitespace-nowrap rounded-md px-3 type-label font-medium text-text-primary">
            {/* 警告色只给圆点：毛玻璃下压着深色设计稿时，警告色字读不清 */}
            <span aria-hidden="true" className="mr-1.5 size-1.5 shrink-0 rounded-pill bg-warning" />{t('live.disconnected')} · {feed === 'offline'
              ? <button type="button" onClick={() => { setFeed('reconnecting'); setFeedEpoch((n) => n + 1); }} className="inline-flex h-6 items-center rounded-sm px-1.5 text-(--semantic-color-action-link) state-layer focus-ring">{t('live.reconnect')}</button>
              : t('live.reconnecting')}
          </span>
        )}
      </>}>
        <ProjectSwitcher current={detail?.project ?? null} placeholder={failure?.kind === 'not-found' ? t('switcher.notFound') : failure ? t('load.failed') : t('switcher.loading')} onRenamed={(id) => { if (id === projectId) refresh(); }} />
      </TopNav>
      <div className="absolute inset-0">
        {ready && detail && tokens && previewOrigin ? (
          <CanvasView
            projectId={projectId} safeAreaRef={safeAreaRef}
            projectName={detail.project.name} tokens={tokens} palette={detail.designSystem.palette} colorMode={detail.designSystem.colorMode} assets={detail.assets} screens={screens} links={detail.links} previewOrigin={previewOrigin}
            selectedIds={selectedIds} focusedId={focusedId} styleGuideSelected={panel === 'design'} inspectMode={inspectMode} armed={inspectArmed} showLinks={showLinks}
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
            onDeadLink={() => toast(t('screen.deadLink'))}
            onShortcut={(code, alt) => { if (blocked) return; if (alt) alted[code]?.(); else if (code === 'KeyE') toggleInspect(); else if (code === 'Slash') toggleComposer(); else if (code === 'KeyK') setFinderOpen(true); else if (code === 'KeyS') saveElement?.(); else if (code === 'KeyZ') void undoStack.undo(); else if (code === 'Delete' || code === 'Backspace') plain[code]?.(); }}
            onAnchor={placeAnchor}
            onCandidates={(jobId, screenId) => setCandidates((c) => (c?.screenId === screenId ? null : { jobId, screenId }))}
            candidateStack={candidates && screens.some((s) => s.id === candidates.screenId) ? { screenId: candidates.screenId, node: <CandidateStack jobId={candidates.jobId} screen={screens.find((s) => s.id === candidates.screenId)!} onClose={() => setCandidates(null)} onAdopted={async () => { await refresh(); setCandidates(null); }} /> } : null}
            onElementSelect={(sel) => { setElementSel(sel); canvasApi.current?.highlight(sel?.qid ?? null); }}
            // sel 里带 component（REQ-EDIT-006）：检查器据此挡直改
            selectedQid={elementSel?.qid ?? null}
            workingSubtrees={workingSubtrees}
            registerApi={(a) => { canvasApi.current = a; }}
            minimap={minimapOn}
            onShown={setShownScreenId}
            navStack={navStack} setNavStack={setNavStack}
            onStale={() => refresh({ quiet: true })} onShotError={onShotError}
            onPreviewError={(s) => toast(t('screen.previewFailed', { name: s.name }), 'error')}
          />
        ) : <CanvasPending failure={failure} onRetry={retryLoad} />}
      </div>
      {/* 多选排列条（REQ-CORE-018）：选中 ≥ 2 屏且没聚焦时出现在画布顶部中央；候选就地展开时让位。排版与键盘在 ArrangeBar，算位在 arrange.ts，落库在 positions.ts */}
      {selectedScreens.length >= 2 && !focusedId && !inspectArmed && !candidates && <ArrangeBar count={selectedScreens.length} yieldToPanel={!!panelBody} onArrange={(k) => void arrange(k, selectedScreens)} />}
      {settingsSection && <Suspense fallback={null}><SettingsModal section={settingsSection} onSection={setSettings} onClose={() => setSettings(null)} returnTo={settingsTool} onCatalog={applyCatalog} /></Suspense>}
      <Composer
        handle={composerRef} laneRef={laneRef} jobs={chips} blockedReason={blockedReason} targets={targetScreens} totalScreens={screens.length} anchor={anchor} maxTargets={MAX_TARGETS}
        componentTargets={targetComponents}
        onRemoveComponentTarget={(id) => { setTargetComponentIds((prev) => prev.filter((x) => x !== id)); setSelectedComponentIds((prev) => prev.filter((x) => x !== id)); }}
        count={count} versions={versions} onCount={setCount} onVersions={setVersions}
        onSend={onSend} onCancelJob={(id) => void cancelJob(id)} onRetryJob={retryJob} onDismissJob={dismissJob} onUploadImage={(file) => api.projects.uploadImage(projectId, file)} onError={(m) => toast(m, 'error')}
        onRemoveTarget={(id) => { setTargetIds((prev) => prev.filter((x) => x !== id)); setSelectedIds((prev) => prev.filter((x) => x !== id)); }}
        onRemoveAnchor={() => setAnchor(null)}
        onClearTargets={() => { setTargetIds([]); setSelectedIds([]); setTargetComponentIds([]); setSelectedComponentIds([]); setAnchor(null); }}
        runners={runners} runnersFailed={runnersFailed} onReloadRunners={() => void loadRunners()} runnerId={runnerId} onRunnerChange={onRunnerChange}
        sessions={sessionList.items} sessionsReason={sessionList.reason} sessionTool={agentTool} sessionId={sessionId} onSessionChange={onSessionChange} onSessionsOpen={loadSessions}
        hidden={!composerVisible}
        dock={{ edge: composerDock.edge, at: composerDock.at, narrow: composerDock.narrow, onMove: composerDock.move, onToggle: toggleComposer, onMeasure: composerDock.onMeasure }}
      />
      {/* 项目没到手时只留三个本机开关与设置可用，其余写明为什么用不了 */}
      <CanvasToolbar groups={ready ? tools : tools.map((g) => g.map((t) => (['composer', 'minimap', 'links', 'settings'].includes(t.id) ? t : { ...t, unavailable: pendingReason })))} />
      {panelBody && <div key={panel} ref={panelRef} className="chrome slide-in-right absolute bottom-4 right-[var(--rail-w)] top-16 z-20 flex w-[var(--panel-w)] flex-col overflow-hidden rounded-lg"><Suspense fallback={<PanelLoading />}>{panelBody}</Suspense></div>}
      {proposal && detail && <Suspense fallback={null}><ProposalDialog proposal={proposal} ds={detail.designSystem} busyReason={busyReason} screenCount={screens.length} batches={Math.ceil(screens.length / MAX_TARGETS)} onWrite={writeProposal} onFinish={finishProposal} onClose={() => setProposal(null)} /></Suspense>}
      {newComponentOpen && <NewComponentDialog onCreate={createComponent} onClose={() => setNewComponentOpen(false)} />}
      {finderOpen && detail && <ScreenFinder screens={screens} components={components} links={detail.links} busy={busyScreens} onPick={(pick) => { setFinderOpen(false); reveal(pick); }} onClose={() => setFinderOpen(false)} />}
      {variantFor && <VariantDialog base={variantFor} onCreate={createVariant} onClose={() => setVariantFor(null)} />}
      {confirmDelete && (selectedScreens.length > 0 || selectedComponents.length > 0) && <DeleteDialog screens={selectedScreens} components={selectedComponents} selected={selected} variantCount={screens.filter((s) => s.variantOf && selectedIds.includes(s.variantOf) && !selectedIds.includes(s.id)).length} onConfirm={onDelete} onClose={() => setConfirmDelete(false)} />}
      {missing && <MissingDialog missing={missing} busyReason={generating ? generateBusy : false} onGenerate={generateMissing} onClose={() => setMissing(null)} />}
    </div>
  );
}

// 画布区的加载 / 失败态（v0.76）：外壳照常，只有这一块换。加载中是空画布加一枚状态胶囊（300 ms 后才显形，快的时候不闪）；
// 失败写明发生了什么与下一步（IA-009）：项目不存在 → 回到最近的项目；其余 → 重试。
// 摆在可用区（与画布的 safe-area 探针同一组 CSS 变量）中央、层级压过输入框与作业 chip：出口不能被它们挡住
function CanvasPending({ failure, onRetry }: { failure: LoadFailure; onRetry: () => void }) {
  const navigate = useNavigate();
  const t = useT(canvasPageMessages);
  const tc = useT(commonMessages);
  return (
    <div className="viewport" data-testid="canvas-pending" data-state={failure?.kind ?? 'loading'}>
      <div className="pointer-events-none absolute bottom-[var(--chrome-bottom)] left-[var(--chrome-left)] right-[var(--chrome-right)] top-[var(--chrome-top)] z-[25] grid place-items-center p-4">
      {!failure ? (
        <div role="status" className="pending-in chrome flex items-center gap-2 rounded-md px-3.5 py-2 type-label text-text-secondary">
          <span className="size-3.5 animate-spin rounded-full border-2 border-text-secondary border-r-transparent motion-reduce:animate-none" aria-hidden="true" />{t('pending.loading')}
        </div>
      ) : (
        <div role="alert" className="pointer-events-auto fade-up chrome w-[min(24rem,100%)] rounded-lg p-4">
          <p className="type-body font-semibold text-text-primary">{failure.kind === 'not-found' ? t('pending.notFound') : t('load.failed')}</p>
          <p className="mt-1 type-label text-text-secondary leading-(--semantic-typography-body-line-height)">{failure.kind === 'not-found' ? t('pending.notFoundHint') : t('pending.failedHint', { reason: failure.reason ?? t('load.unreachable') })}</p>
          <div className="mt-3">
            {failure.kind === 'not-found'
              ? <Button variant="primary" size="sm" onClick={() => navigate('/')}>{t('pending.backToRecent')}</Button>
              : <Button variant="primary" size="sm" onClick={onRetry}>{tc('retry')}</Button>}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
