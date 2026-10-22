import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router';
import { MAX_SUBTREE_BLOCKS, draftNameFromPrompt, failureText, type DraftFrame, type DraftFrameChoice, type JobDto, type ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button } from '@/ui/ui';
import { ConfirmDialog } from '@/ui/modal';
import { TopNav } from '@/project/TopNav';
import { ProjectSwitcher } from '@/project/ProjectSwitcher';
import type { ComposerHandle } from '@/composer/Composer';
import { useRunnerPrefs } from '@/composer/useRunnerPrefs';
import { useComposerDock } from '@/composer/useComposerDock';
import { jobChips, useEndedJobs } from '@/composer/JobChips';
import { coveredScreens, jobLabel } from '@/canvas/jobs';
import { applySelect, type ElementSelection, type SelectMessage } from '@/canvas/frameMessages';
import { useSketchbook, type SketchEvent } from '@/sketch/useSketchbook';
import { DraftStage, type StageState } from '@/sketch/DraftStage';
import { DraftRail } from '@/sketch/DraftRail';
import { SketchComposer } from '@/sketch/SketchComposer';
import { useRefProjects } from '@/sketch/RefSelect';
import { CopyDialog } from '@/sketch/CopyDialog';
import { useSettingsSection } from '@/settings/sections';
import { getLocale, tOf, useLocale, useT, type Locale } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';
import commonMessages from '@/i18n/locales/common';
import collabMessages from '@/i18n/locales/collab';
import { distinctPeople, useFollow, useMe, usePresence, type Peer, type Presence } from '@/lib/collab';
import { NameDialog } from '@/collab/NameDialog';
import { PeerAvatars } from '@/collab/PeerAvatars';

const RAIL_KEY = 'quilt:sketch-rail';
// 窄视口断点，与 styles.css 里 .sketch-shell 的同一条
const narrow = () => matchMedia('(max-width: 48rem)').matches;
const tm = tOf(sketchMessages);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
// 输入框里的文字 / 改名框是可编辑区：那里的 Esc 归它自己（清字、放弃改名），不收起看板
const EDITABLE = 'input, textarea, select, [contenteditable]';
// 服务端点名的原因（problem 的 errors[0]，没有就 title）；不是服务端的错（连不上）用 fallback
const problemText = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title : fallback);

// 作业 chip 的文案：草稿本里只有这几种——出一张新草稿、改某一张、改某一张里的一块或几块（v1.26 qids）
function draftJobLabel(j: JobDto, screens: ScreenDto[]): string {
  const i = j.input as { prompt?: string; screenIds?: string[]; qids?: string[] } | null;
  if (j.kind === 'generate') return tm('page.job.newDraft', { name: draftNameFromPrompt(i?.prompt ?? '') });
  if (j.kind === 'edit_screens') return tm('page.job.edit', { name: screens.find((s) => s.id === i?.screenIds?.[0])?.name ?? tm('page.job.deletedDraft') });
  if (j.kind === 'regenerate_subtree') {
    const name = screens.find((s) => s.id === (j.input as { screenId?: string } | null)?.screenId)?.name ?? tm('page.job.deletedDraft');
    return i?.qids && i.qids.length > 1 ? tm('page.job.editBlocks', { name, n: i.qids.length }) : tm('page.job.editBlock', { name });
  }
  return jobLabel(j, screens, []);
}

// 结束了的作业 chip 的文案按当时的界面语言现算（失败的一直留着，切语言要跟着换）：记下作业、结束那一刻的草稿表与失败原因的原始字段
type EndedFrom = { job: JobDto; screens: ScreenDto[]; errorClass?: string; message?: string; blockGone: boolean };
const endedReason = (f: EndedFrom, locale: Locale) => (f.blockGone ? tm('page.blockChanged') : failureText(f.job.kind, f.errorClass, f.message, 0, locale));

// PAGE-SKETCH（REQ-CORE-040，路由 /sketch，?d=<草稿 id> 是看板上正打开的那张）：沉浸式的一整页——顶部那一行是切换器 chip 与草稿工具条，其下看板，
// 右侧记录栏，输入框缺省停在底边（可停左右边、可收起）；没有画布、工具栏与小地图。草稿就是草稿本这个项目的屏，读写全走项目与屏的接口（ADR-030）
const SettingsModal = lazy(() => import('@/settings/SettingsModal').then((m) => ({ default: m.SettingsModal })));

export function SketchRoute() {
  const toast = useToast();
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  const locale = useLocale();
  // 草稿本占着项目级的造屏名额（ADR-030）：一次只出一张新草稿
  const newBusy = t('page.newBusy');
  const [params, setParams] = useSearchParams();
  const d = params.get('d');
  const dRef = useRef(d);
  dRef.current = d;
  const composerRef = useRef<ComposerHandle>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const prefs = useRunnerPrefs();
  // 输入框的停靠与收起（PAGE-SKETCH「输入框」v1.16）：与画布同一套，记忆单独一份。收起后点胶囊、按 ⌘/ 或页面要用输入框时（点示例、选元素点中一块）展开，光标回输入区
  const composerDock = useComposerDock('sketch');
  // 收着时先展开：输入区要等这次渲染之后才显形，光标放到下一拍
  const showComposer = () => {
    if (!composerDock.prefs.collapsed) { composerRef.current?.focus(); return; }
    composerDock.setCollapsed(false);
    setTimeout(() => composerRef.current?.focus(), 0);
  };
  const toggleComposer = () => { if (composerDock.prefs.collapsed) showComposer(); else composerDock.setCollapsed(true); };
  // 看板上开哪一张进 URL（INT-020）：点记录栏、收起是用户的导航（push），自动摆上新草稿、清掉已删的是校正（replace）
  // 设置弹层（?settings=<节>，与画布同一个）：输入框模型下拉的「管理模型…」打开它，看板上开着的草稿不动
  const [settingsSection, setSettings] = useSettingsSection();
  const openDraft = useCallback((id: string | null, mode: 'push' | 'replace' = 'push') => setParams((q) => { if (id) q.set('d', id); else q.delete('d'); return q; }, { replace: mode === 'replace' }), [setParams]);

  // 本页发出、还在等它落成屏的新草稿：作业 id 与发出时的画框。看板空着就自动摆上去；这期间用户已打开别的草稿就不抢（S5）
  const [pendingNew, setPendingNew] = useState<{ jobId: string; frame: DraftFrameChoice; screenId?: string } | null>(null);
  const pendingRef = useRef(pendingNew);
  pendingRef.current = pendingNew;
  // 「选元素」开关与点中的那几块（REQ-CORE-045，v1.26 按住 Shift 选几块，最后点中的排最后）：都记着是哪张草稿的，换了草稿就不算数；
  // 胶囊还记着点选时的那一版，草稿出了新一版（FLOW-SKETCH-REFINE S6）它们就一起作废
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [pick, setPick] = useState<{ draftId: string; revisionId: string; sels: ElementSelection[] } | null>(null);
  // 新草稿作业建出的是哪张屏（screen_planned 带 screenId）：失败时没内容的那张由服务端删掉，看板上开着它就一起撤
  const planned = useRef(new Map<string, string>());
  const screensRef = useRef<ScreenDto[]>([]);
  // 作业 chip（PAGE-CANVAS「作业 chip」v1.17，草稿本同一套）：结束了还要留一会儿的那些——失败的留到关掉或重试，成功的淡出后撤
  const { ended, end: endJob, dismiss: dismissJob } = useEndedJobs();
  const endedFrom = useRef(new Map<string, EndedFrom>());
  const claim = (screenId: string) => {
    const cur = dRef.current;
    // d 指着一张已不在详情里的草稿（浏览器后退回到被删的那张）时当作看板空着，不让它挡住新草稿上看板
    const live = !!cur && screensRef.current.some((s) => s.id === cur);
    if (live && cur !== screenId) { setPendingNew(null); return; }
    if (cur !== screenId) openDraft(screenId, 'replace');
    // 骨架留到这张屏进了详情再撤，中间不闪回空看板
    setPendingNew((p) => p && { ...p, screenId });
  };
  const onEvent = (e: SketchEvent) => {
    const pend = pendingRef.current;
    // 本机会话写出的新草稿没有 screen_planned，靠带同一 jobId 的回写认领（API-CORE-030 草稿本）
    if (e.kind === 'screen') { if (pend?.jobId === e.jobId) claim(e.screenId); return; }
    if (e.type === 'screen_planned' && typeof e.data.screenId === 'string') {
      planned.current.set(e.jobId, e.data.screenId);
      if (pend?.jobId === e.jobId) claim(e.data.screenId);
    }
    if (!TERMINAL.has(e.type)) return;
    const sid = planned.current.get(e.jobId);
    planned.current.delete(e.jobId);
    // 只改一块时点中的元素在别处的改动里已被换掉（FLOW-SKETCH-REFINE S4）：胶囊作废，请用户重新点
    const blockGone = e.type === 'failed' && e.job?.kind === 'regenerate_subtree' && /^element not found$/.test(String(e.data.message ?? ''));
    // 作业 chip：失败的留一枚警告色 chip（写原因、可重试），成功的写「完成」后淡出，取消的直接消失
    if (e.job && e.type !== 'cancelled') {
      const from: EndedFrom = { job: e.job, screens: screensRef.current, errorClass: e.data.errorClass as string | undefined, message: e.data.message as string | undefined, blockGone };
      endedFrom.current.set(e.job.id, from);
      const chip = { id: e.job.id, createdAt: e.job.createdAt, label: draftJobLabel(e.job, from.screens), kind: e.job.kind };
      if (e.type === 'succeeded') endJob({ ...chip, state: 'succeeded' });
      else endJob({ ...chip, state: 'failed', reason: endedReason(from, getLocale()) });
    }
    if (e.type === 'succeeded') {
      if (pend?.jobId === e.jobId) { const id = (e.data.screenIds as string[] | undefined)?.[0] ?? sid; if (id) claim(id); else setPendingNew(null); }
      return;
    }
    if (pend?.jobId === e.jobId) setPendingNew(null);
    // 没出内容的新草稿被删了（S4）：看板跟着清空，原因写在失败的作业 chip 上，不再提示「已被删除」
    if (sid && sid === dRef.current && !screensRef.current.find((s) => s.id === sid)?.currentRevisionId) openDraft(null, 'replace');
    // 失败的原因写在作业 chip 上（v1.17），不再弹提示条
    if (blockGone) setPick(null);
  };
  // 协作显示（v1.32 REQ-CORE-048）：草稿本是一个项目，协作通道按它的 id 建
  const presenceRef = useRef<Presence | null>(null);
  const book = useSketchbook(onEvent, presenceRef);
  const { projectId, detail, jobs, progress, refresh, applyScreen } = book;
  const me = useMe();
  const { presence, peers } = usePresence(projectId, me);
  presenceRef.current = presence;
  const people = useMemo(() => distinctPeople(peers), [peers]);
  const mineJobs = useRef(new Set<string>());
  const tk = useT(collabMessages);
  // 跟随（链式跟随、跟随连成一圈的处理在 useFollow，同画布）：跟着领头人正看的草稿换
  const follow = useFollow(presence, peers, me, { left: (name) => toast(tk('left', { name })), yielded: (name) => toast(tk('yielded', { name })) });
  const following = follow.following;
  const screens = detail?.screens;
  screensRef.current = screens ?? [];
  useEffect(() => { if (pendingNew?.screenId && screens?.some((s) => s.id === pendingNew.screenId)) setPendingNew(null); }, [screens, pendingNew]);
  // 作业已经不在了却没认领到屏（事件丢了）：撤掉骨架，新草稿照常在记录栏里，不让「新草稿」一直被挡着
  useEffect(() => { if (pendingNew && !pendingNew.screenId && detail && !jobs.some((j) => j.id === pendingNew.jobId)) setPendingNew(null); }, [pendingNew, detail, jobs]);

  // 地址里的草稿已被删（S9）：看板回到空并说一声。只按「d 设好之后才发起的详情」判——刚认领的新草稿可能还没进上一份详情
  const dSince = useRef({ id: d, seq: 0 });
  // d 换成一张眼下详情里没有的草稿（后退回到已删的那张、别处刚删）：立刻重取一次，回来的详情里还没有它就按已删处理；刚认领的新草稿等它自己的详情
  useEffect(() => {
    dSince.current = { id: d, seq: book.detailSeq.current };
    if (d && detail && !detail.screens.some((s) => s.id === d) && pendingRef.current?.screenId !== d) void refresh({ quiet: true });
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!detail || !d || detail.screens.some((s) => s.id === d) || book.appliedSeq.current <= dSince.current.seq) return;
    openDraft(null, 'replace');
    setPendingNew((p) => (p?.screenId === d ? null : p));
    toast(t('page.send.deleted'), 'error');
  }, [detail, d]); // eslint-disable-line react-hooks/exhaustive-deps

  // 记录栏按创建时间倒序：详情里的屏按创建时间升序返回（API-CORE-004），反过来即可
  const drafts = useMemo(() => (screens ? [...screens].reverse() : null), [screens]);
  const open = (d && screens?.find((s) => s.id === d)) || null;
  const ids = useMemo(() => (screens ?? []).map((s) => s.id), [screens]);
  const busyIds = useMemo(() => new Set(jobs.flatMap((j) => coveredScreens(j, ids))), [jobs, ids]);
  const newJob = jobs.find((j) => j.kind === 'generate');
  // 生成中 = 被改着的，或还没有第一版而有新草稿作业在跑的
  const generating = useMemo(() => new Set([...busyIds, ...(newJob ? (screens ?? []).filter((s) => !s.currentRevisionId).map((s) => s.id) : [])]), [busyIds, newJob, screens]);
  const openBusy = !open ? null : busyIds.has(open.id) ? t('page.busy.editing') : !open.currentRevisionId && newJob ? t('page.busy.generating') : null;
  // 挡发送的规则同 REQ-CORE-020：新草稿撞在跑的新草稿，改撞这张草稿上一轮
  const blockedReason = !detail ? (book.failure ? t('page.blocked.failed') : t('page.blocked.loading'))
    : open ? (!open.currentRevisionId ? t('page.blocked.generating', { name: open.name }) : busyIds.has(open.id) ? t('page.blocked.editing', { name: open.name }) : null)
    : newJob || pendingNew ? newBusy : null;
  const stageState: StageState = open ? (open.currentRevisionId ? 'draft' : 'generating') : pendingNew ? 'generating' : 'empty';
  // 看板那张草稿（或本页刚发的新草稿）此刻在跑的作业
  const stageJob = open
    ? jobs.find((j) => coveredScreens(j, ids).includes(open.id)) ?? (!open.currentRevisionId ? newJob : undefined)
    : pendingNew ? jobs.find((j) => j.id === pendingNew.jobId) : undefined;
  const stageProgress = stageJob ? progress[stageJob.id] ?? t('queued') : null;
  // 作业 chip：最新的贴着输入框，每枚可取消（GAI-002）；交给本机会话的也在这里，草稿本页没有 agent 面板
  const chips = useMemo(() => {
    // 已撤掉的 chip 不再留它的原始字段
    for (const id of endedFrom.current.keys()) if (!ended.some((x) => x.id === id)) endedFrom.current.delete(id);
    return jobChips(
      [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => ({ id: j.id, createdAt: j.createdAt, label: draftJobLabel(j, screens ?? []), progress: progress[j.id] ?? tm('queued') })),
      ended.map((x) => { const f = endedFrom.current.get(x.id); if (!f) return x; const label = draftJobLabel(f.job, f.screens); return x.state === 'failed' ? { ...x, label, reason: endedReason(f, locale) } : { ...x, label }; }),
    );
  }, [jobs, screens, progress, ended, locale]);

  // 参照项目的候选（REQ-CORE-042）：工具条与新草稿的输入框共用
  const refs = useRefProjects();
  // 开关与胶囊只对看板上这张草稿的这一版有效（见上）；换了草稿时连同记下的一起清掉，回到这张时不再自己开着
  const picking = !!open && pickingFor === open.id;
  const activePick = picking && open && pick?.draftId === open.id && pick.revisionId === open.currentRevisionId ? pick : null;
  const picks = useMemo(() => activePick?.sels ?? [], [activePick]);
  // ---- 协作显示（v1.32 REQ-CORE-048，PAGE-SKETCH「协作者」）：把自己在看哪张草稿、选中的块、发出的作业发出去；跟随的人换草稿就跟着换 ----
  useEffect(() => { presence?.set({ draft: open?.id ?? undefined }); }, [presence, open?.id]);
  useEffect(() => { const qs = picks.map((x) => x.qid); presence?.set({ blocks: qs.length ? qs.slice(0, 8) : undefined }); }, [presence, picks]);
  useEffect(() => { const mine = jobs.filter((j) => mineJobs.current.has(j.id)).map((j) => j.id); presence?.set({ jobs: mine.length ? mine.slice(0, 20) : undefined }); }, [presence, jobs]);
  // 记录栏小头像与「正在改」按标签页算、按人去重：他开着两个标签页时，看着这张草稿或在改它的是哪一个都算
  const viewers = useMemo(() => { const m: Record<string, Peer[]> = {}; for (const x of peers) if (x.state.draft) (m[x.state.draft] ??= []).push(x); for (const k of Object.keys(m)) m[k] = distinctPeople(m[k]); return m; }, [peers]);
  const peersHere = useMemo(() => peers.filter((x) => !!open && x.state.draft === open.id), [peers, open]);
  const editors = useMemo(() => !open ? [] : distinctPeople(peers.filter((x) => (x.state.jobs ?? []).some((id) => { const j = jobs.find((y) => y.id === id); return !!j && coveredScreens(j, [open.id]).includes(open.id); }))), [peers, jobs, open]);
  const describePeer = useCallback((x: Peer) => {
    const g = x.state.following;
    if (g) return g.id === me?.id ? tk('doing.followingYou') : tk('doing.following', { name: people.find((y) => y.person.id === g.id)?.person.name ?? '' });
    const d = x.state.draft && (screens ?? []).find((y) => y.id === x.state.draft);
    return d ? tk('doing.draft', { name: d.name }) : tk('doing.sketch');
  }, [screens, tk, me?.id, people]);
  // 跟着领头人（按人算）：开始时跟他最近更新的那个标签页正看的草稿，之后他哪个标签页换了草稿就跟到哪；领头人换了从头记
  const leaderId = follow.leader?.person.id ?? null;
  const followDrafts = useRef({ leader: null as string | null, tabs: new Map<string, string | undefined>() });
  useEffect(() => {
    const mem = followDrafts.current;
    if (mem.leader !== leaderId) { mem.leader = leaderId; mem.tabs = new Map(); }
    if (!leaderId) return;
    const tabs = peers.filter((x) => x.person.id === leaderId);
    const moved = mem.tabs.size ? tabs.find((x) => mem.tabs.get(x.clientId) !== x.state.draft) : distinctPeople(tabs)[0];
    for (const x of tabs) mem.tabs.set(x.clientId, x.state.draft);
    const d = moved?.state.draft;
    if (d && d !== dRef.current) openDraft(d);
  }, [peers, leaderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openId = open?.id ?? null;
  useEffect(() => { setPickingFor(null); setPick(null); }, [openId]);
  // 胶囊只在「选元素」开着时有：开关一换就去掉
  const changePicking = (on: boolean) => { if (!open) return; setPickingFor(on ? open.id : null); setPick(null); };
  // 选元素点中一块（FLOW-SKETCH-REFINE S2）：输入框目标区出胶囊、焦点交给输入框写这一句。点在草稿根上等同改整张（S4）：不出胶囊，框随之撤掉。
  // 按住 Shift 点是加选或减选（v1.26），规则同画布的多选（applySelect）：互相包含只留外层、最多 MAX_SUBTREE_BLOCKS 块，碰上时说一声
  const climbRef = useRef<((dir: 'up' | 'down') => void) | null>(null);
  const onPick = (m: SelectMessage) => {
    if (!open?.currentRevisionId) return;
    const root = !!m.path?.length && m.path[0].qid === m.qid;
    if (root) { setPick(null); showComposer(); return; }
    const { list, note } = applySelect(picks, m);
    if (note === 'merged') toast(t('page.pick.merged'));
    else if (note === 'max') toast(t('page.pick.max', { max: MAX_SUBTREE_BLOCKS }));
    setPick(list.length ? { draftId: open.id, revisionId: open.currentRevisionId, sels: list } : null);
    showComposer();
  };
  // 胶囊上的 ×：只去掉这一块，去光了回到改整张
  const removePick = (qid: string) => {
    const rest = picks.filter((x) => x.qid !== qid);
    setPick(activePick && rest.length ? { ...activePick, sels: rest } : null);
    composerRef.current?.focus();
  };

  // 发送没发出去：原因按 problem 的类型说（REQ-CORE-020 的挡法之外真撞上的），输入框留着字与参考图
  const sendFailed = (e: unknown, target: ScreenDto | null, withRef: boolean) => {
    if (e instanceof ApiError && e.type === '/errors/validation' && JSON.stringify(e.problem).includes('sessionId')) { toast(t('page.send.sessionGone'), 'error'); prefs.loadSessions(); }
    else if (e instanceof ApiError && e.type === '/errors/screen-busy') { toast(target ? t('page.blocked.editing', { name: target.name }) : newBusy, 'error'); void refresh(); }
    // 点选之后这张草稿已出了新一版（FLOW-SKETCH-REFINE S4）：胶囊作废，重新点
    else if (e instanceof ApiError && e.type === '/errors/revision-conflict') { setPick(null); toast(t('page.send.conflict'), 'error'); void refresh(); }
    else if (e instanceof ApiError && e.type === '/errors/not-found' && target) { openDraft(null, 'replace'); toast(t('page.send.deleted'), 'error'); void refresh(); }
    // 新草稿参照的项目刚被删了：候选跟着重取，换一个再发
    else if (e instanceof ApiError && e.type === '/errors/not-found' && withRef) { toast(t('page.send.refGone'), 'error'); refs.reload(); }
    else if (e instanceof ApiError && e.type === '/errors/rate-limited') toast(t('page.send.rateLimited'), 'error');
    else toast(problemText(e, t('page.send.offline')), 'error');
  };
  // 发送（API-CORE-010 草稿本）：看板空着 = 新草稿（带画框与参照），有草稿 = 改它；选元素点中了一块 = 只改这一块（API-CORE-006 regenerate_subtree，
  // 目标是这张草稿与点中的元素，expectedRevisionId 取点选时的那一版，参考图同样带上）；点中了几块（v1.26）是同一种作业带 qids，qid 是最后点中的那块。
  // 没发出去时输入框留着字与参考图（REQ-CORE-020）
  const onSend = async (content: string, attachmentIds: string[], frame: DraftFrameChoice, refProjectId: string | null): Promise<boolean> => {
    if (!projectId) return false;
    const target = open;
    const block = target && activePick ? { ...activePick, qids: activePick.sels.map((x) => x.qid) } : null;
    const agentNote = prefs.agentTool === 'codex' ? t('page.send.toCodex') : t('page.send.toClaude');
    try {
      if (target && block) {
        const { job } = await api.projects.createJob(projectId, { kind: 'regenerate_subtree', input: { screenId: target.id, qid: block.qids[block.qids.length - 1], ...(block.qids.length > 1 ? { qids: block.qids } : null), prompt: content, expectedRevisionId: block.revisionId, runner: prefs.sendRunner }, attachmentIds: attachmentIds.length ? attachmentIds : undefined });
        book.track(job); mineJobs.current.add(job.id);
        if (job.runner === 'agent') toast(agentNote);
        return true;
      }
      const r = await api.projects.send(projectId, { content, runner: prefs.sendRunner, attachmentIds: attachmentIds.length ? attachmentIds : undefined, ...(target ? { targetScreenIds: [target.id] } : { frame, ...(refProjectId ? { refProjectId } : null) }) });
      book.track(r.job); mineJobs.current.add(r.job.id);
      if (!target) setPendingNew({ jobId: r.job.id, frame });
      if (r.job.runner === 'agent') toast(agentNote);
      return true;
    } catch (e) {
      sendFailed(e, target, !target && !!refProjectId);
      return false;
    }
  };
  // 失败 chip 的「重试」（REQ-CORE-026，API-CORE-034）：同画布——按这个作业的那条用户消息原样再发一轮，通道换成输入框当前的；
  // 重发的是新草稿而看板空着时，同本页发出的新草稿一样等它落成屏就摆上看板。发出去了就撤掉旧的这枚，没发出去旧的留着、说原因
  const retryJob = async (id: string) => {
    const failed = ended.find((x) => x.id === id);
    if (!failed || !projectId) return;
    try {
      const user = (await api.projects.messages(projectId)).items.find((m) => m.role === 'user' && m.jobId === id);
      if (!user) { toast(t('page.retry.lost'), 'error'); return; }
      const { job } = await api.projects.retry(projectId, user.id, failed.kind === 'chat' ? undefined : prefs.sendRunner);
      book.track(job); mineJobs.current.add(job.id);
      if (job.kind === 'generate' && !dRef.current) setPendingNew({ jobId: job.id, frame: (job.input as { frame?: DraftFrameChoice }).frame ?? 'auto' });
      dismissJob(id);
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/job-not-finished') toast(t('page.retry.running'), 'error');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') { toast(failed.kind === 'generate' ? newBusy : t('page.retry.busy'), 'error'); void refresh(); }
      else if (e instanceof ApiError && e.type === '/errors/rate-limited') toast(t('page.send.rateLimited'), 'error');
      else toast(problemText(e, t('page.retry.offline')), 'error');
    }
  };
  // 改名、换画框（API-CORE-012）：元数据，不建修订；换画框后服务端按新画框重拍截图
  const patchDraft = async (patch: { name?: string; frame?: DraftFrame }, fallback: string) => {
    if (!open) return;
    try { applyScreen((await api.screens.patch(open.id, patch)).screen); }
    catch (e) { toast(problemText(e, fallback), 'error'); }
  };
  // 换参照（API-CORE-012 refProjectId，REQ-CORE-042）：不建修订，从下一轮改稿起生效；选的项目刚被删了（404）就重取候选
  const changeRef = async (refProjectId: string | null) => {
    if (!open) return;
    try { applyScreen((await api.screens.patch(open.id, { refProjectId })).screen); }
    catch (e) {
      toast(problemText(e, t('page.refFailed')), 'error');
      if (e instanceof ApiError && e.type === '/errors/not-found') { refs.reload(); void refresh(); }
    }
  };

  // 收起（S8）：去掉 d、看板清空、焦点回输入框；在生成的照常生成，只是不再自动摆上来
  const collapse = useCallback(() => {
    if (!dRef.current && !pendingRef.current) return;
    setPendingNew(null);
    if (dRef.current) openDraft(null);
    composerRef.current?.focus();
  }, [openDraft]);
  // Esc 的先后（PAGE-SKETCH）：下拉与弹层自己先拦下；然后一次去掉全部胶囊回到改整张；最后才按 Q-SKETCH-3 收起看板
  // 跟随中先停止跟随（v1.32），再撤选中的块，最后收起看板
  const escape = () => { if (following) follow.stop(); else if (activePick) setPick(null); else collapse(); };

  const [copyFor, setCopyFor] = useState<ScreenDto | null>(null);
  const [deleting, setDeleting] = useState<ScreenDto | null>(null);
  const composerInput = useMemo(() => ({ get current() { return document.getElementById('chat-input'); } }), []);
  // 删除（API-CORE-018）：确认后删、不可恢复；正在生成或改的服务端回 409
  const remove = async () => {
    const s = deleting;
    if (!s) return;
    try {
      await api.screens.remove(s.id);
      setDeleting(null);
      if (dRef.current === s.id) {
        openDraft(null, 'replace');
        // 确认框关掉时焦点先回到删除键，删除键随看板清空一起卸载：等这两次提交都过去，同收起一样交给输入框（A11Y-013）
        requestAnimationFrame(() => composerRef.current?.focus());
      }
      toast(t('page.removed', { name: s.name }));
      void refresh();
    } catch (e) {
      setDeleting(null);
      toast(e instanceof ApiError && e.type === '/errors/screen-busy' ? t('page.removeBusy') : t('page.removeFailed'), 'error');
    }
  };

  // Esc 收起（Q-SKETCH-3）：焦点在输入框里时由输入框处理（有字先清字），弹层与下拉开着时归它们（它们会拦下或 preventDefault）。
  // ⌘/ 收起 / 展开输入框（同画布）：焦点在输入框里也要能按，所以不过「可编辑区」那道门
  // 快捷键同画布（v1.16）：⌘E 选元素、⌘/ 输入框；焦点在草稿 iframe 里时父页收不到键盘，由运行时转发上来（DraftStage 的 onShortcut）
  // ⌘Z 回到上一版（v1.25）：取当前版的父修订，走「版本」里「回到这一版」同一个接口（以它的内容建新一版，新一版的父修订就是被回到的那一版）。
  // 当前版本身是回到旧版建出来的（restore）时，它的内容就是父修订那一版，要先退到那一版再取父修订——连按才会沿着来路一版版往回走
  const undoing = useRef(false);
  const undoVersion = async () => {
    if (!open?.currentRevisionId || undoing.current) return;
    if (openBusy) { toast(openBusy); return; }
    undoing.current = true;
    try {
      const { items } = await api.screens.revisions(open.id);
      const byId = new Map(items.map((r) => [r.id, r]));
      let base = byId.get(open.currentRevisionId);
      while (base?.sourceKind === 'restore' && base.parentRevisionId && byId.has(base.parentRevisionId)) base = byId.get(base.parentRevisionId);
      const parent = base?.parentRevisionId ? byId.get(base.parentRevisionId) : undefined;
      if (!parent) { toast(t('versions.atFirst')); return; }
      await api.screens.restore(open.id, parent.id, open.currentRevisionId);
      toast(t('versions.restored', { seq: parent.seq }));
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/revision-conflict') { toast(t('versions.conflict'), 'error'); void refresh(); }
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast(t('versions.busy', { name: open.name }), 'error');
      else toast(e instanceof ApiError ? e.problem.title : t('versions.failed'), 'error');
    } finally { undoing.current = false; }
  };
  const shortcut = (code: string) => {
    if (keyRef.current.blocked) return;
    if (code === 'Slash') { toggleComposer(); return; }
    if (!open?.currentRevisionId) return;
    if (code === 'KeyE') changePicking(!picking);
    if (code === 'KeyZ') void undoVersion();
  };
  const keyRef = useRef({ escape, toggleComposer, shortcut, blocked: false });
  keyRef.current = { escape, toggleComposer, shortcut, blocked: !!copyFor || !!deleting || !!settingsSection };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.code === 'Slash' || e.code === 'KeyE')) { e.preventDefault(); keyRef.current.shortcut(e.code); return; }
      // ⌘Z：焦点在文本框里时留给文本框自己撤销
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !e.shiftKey && !e.altKey) {
        if ((e.target as HTMLElement | null)?.closest(EDITABLE)) return;
        e.preventDefault(); keyRef.current.shortcut(e.code); return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || keyRef.current.blocked) return;
      if ((e.target as HTMLElement | null)?.closest(EDITABLE)) return;
      keyRef.current.escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 记录栏开合：本机视图偏好，首帧即正确值（INT-021）。窄视口里它盖在看板与输入框上：没记过偏好时缺省收着，点了一项就收起，不改记下的偏好
  const [railOpen, setRailOpen] = useState(() => { try { const v = localStorage.getItem(RAIL_KEY); return v === null ? !narrow() : v !== '0'; } catch { return !narrow(); } });
  const toggleRail = () => { const next = !railOpen; setRailOpen(next); try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* 无痕模式写不了 */ } };
  // 缩略图取不到（多半是签名过期）：静默重取详情，10 s 内至多一次
  const shotRetryAt = useRef(0);
  const onShotError = useCallback(() => { if (Date.now() - shotRetryAt.current < 10_000) return; shotRetryAt.current = Date.now(); void refresh({ quiet: true }); }, [refresh]);

  useEffect(() => { document.title = t('page.title'); return () => { document.title = 'Quilt'; }; }, [t]);
  // 输入框停的边与实际大小 → 看板让出的空间与提示条的落点（输入框随内容增高、窄视口下工具条折行）；草稿工具条的实际底边 → 看板的上沿（折行时看板下移）
  const [topRow, setTopRow] = useState<number | null>(null);
  const shellStyle = { ...composerDock.shellStyle, ...(topRow ? { '--top-row': `${topRow}px` } : null) } as CSSProperties;
  const toastBottom = composerDock.toastBottom;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--toast-bottom', `${toastBottom}px`);
    return () => { root.removeProperty('--toast-bottom'); };
  }, [toastBottom]);

  return (
    <div className="sketch-shell relative h-full" data-testid="sketch-page" data-rail={railOpen ? 'open' : 'closed'} data-dock={composerDock.edge} style={shellStyle}>
      {/* 输入框这一条横带的探针：Composer 按它判断工具条放不放得下一行 */}
      <div ref={laneRef} aria-hidden="true" className="pointer-events-none absolute bottom-0 left-[var(--lane-left)] right-[var(--side-right)] h-0" />
      <TopNav floating right={book.feedShown && book.feed !== 'open' && (
        <span role="status" data-testid="live-status" className="chrome inline-flex h-8 min-w-0 items-center gap-0.5 truncate whitespace-nowrap rounded-md px-3 type-label font-medium text-text-primary">
          <span aria-hidden="true" className="mr-1.5 size-1.5 shrink-0 rounded-pill bg-warning" />{t('page.feed.lost')} · {book.feed === 'offline'
            ? <button type="button" onClick={book.reconnect} className="inline-flex h-6 items-center rounded-sm px-1.5 text-(--semantic-color-action-link) state-layer focus-ring">{t('page.feed.reconnect')}</button>
            : t('page.feed.reconnecting')}
        </span>
      )}>
        <ProjectSwitcher current={null} placeholder={t('page.switcher')} sketchbook />
      </TopNav>
      {/* 协作者头像（v1.32 REQ-CORE-048）：右上角记录栏开关的左边 */}
      <PeerAvatars className="absolute right-14 top-3 z-30" people={people} following={following} onFollow={follow.toggle} describe={describePeer} />
      {!me && <NameDialog taken={peers.map((x) => x.person.color)} />}
      {detail && book.previewOrigin ? (
        <DraftStage
          state={stageState} draft={open} pendingFrame={pendingNew?.frame ?? null} progress={stageProgress} busy={openBusy} previewOrigin={book.previewOrigin}
          onExample={(text) => { composerRef.current?.fill(text); showComposer(); }}
          onTopRow={setTopRow}
          onRename={(name) => void patchDraft({ name }, t('page.renameFailed'))}
          onFrame={(frame) => void patchDraft({ frame }, t('page.frameFailed'))}
          onRestored={() => void refresh()}
          onCopy={() => { if (open) setCopyFor(open); }}
          onDelete={() => { if (open) setDeleting(open); }}
          onCollapse={collapse}
          onEscape={escape} onShortcut={(code) => keyRef.current.shortcut(code)}
          onStale={() => refresh({ quiet: true })}
          refs={refs} onRef={(id) => void changeRef(id)}
          picking={picking} onPicking={changePicking} pickQids={picks.map((x) => x.qid)} onPick={onPick} climbRef={climbRef}
          presence={presence} peersHere={peersHere} editors={editors}
        />
      ) : <StagePending failure={book.failure} onRetry={book.retry} />}
      <DraftRail open={railOpen} onToggle={toggleRail} drafts={drafts} openId={open?.id ?? null} generating={generating} viewers={viewers} onPick={(id) => { follow.stop(); if (id !== dRef.current) openDraft(id); if (narrow()) setRailOpen(false); }} onShotError={onShotError} />
      <SketchComposer
        handle={composerRef} laneRef={laneRef} draft={open} jobs={chips} blockedReason={blockedReason} prefs={prefs}
        refs={refs} picking={picking} picks={picks} onRemovePick={removePick} onClimb={(dir) => climbRef.current?.(dir)}
        onSend={onSend} onCancelJob={(id) => void book.cancel(id)} onRetryJob={retryJob} onDismissJob={dismissJob}
        onUploadImage={(file) => (projectId ? api.projects.uploadImage(projectId, file) : Promise.reject(new Error(t('page.blocked.loading'))))}
        onError={(m) => toast(m, 'error')} onEscape={escape}
        hidden={composerDock.prefs.collapsed}
        dock={{ edge: composerDock.edge, at: composerDock.at, narrow: composerDock.narrow, onMove: composerDock.move, onToggle: toggleComposer, onMeasure: composerDock.onMeasure }}
      />
      {settingsSection && <Suspense fallback={null}><SettingsModal section={settingsSection} onSection={setSettings} onClose={() => setSettings(null)} onCatalog={prefs.applyCatalog} /></Suspense>}
      {/* 传当前的那份：弹层开着时这一版的截图、写回目标可能刚到 */}
      {copyFor && <CopyDialog draft={detail?.screens.find((x) => x.id === copyFor.id) ?? copyFor} runner={prefs.sendRunner} onClose={() => setCopyFor(null)} onCopied={() => void refresh({ quiet: true })} />}
      {deleting && <ConfirmDialog title={t('page.removeTitle', { name: deleting.name })} body={t('page.removeBody')} confirmLabel={tc('delete')} fallback={composerInput} onCancel={() => setDeleting(null)} onConfirm={remove} />}
    </div>
  );
}

// 草稿本还没取到时看板的位置：加载中是一枚状态胶囊（300 ms 后才显形，快的时候不闪）；失败写明发生了什么与下一步（IA-009）
function StagePending({ failure, onRetry }: { failure: string | null; onRetry: () => void }) {
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  return (
    <div data-testid="sketch-pending" data-state={failure ? 'failed' : 'loading'} className="absolute bottom-[var(--stage-bottom)] left-[var(--stage-left)] right-[var(--stage-right)] top-[var(--chrome-top)] grid place-items-center p-4">
      {!failure ? (
        <div role="status" className="pending-in chrome flex items-center gap-2 rounded-pill px-3.5 py-2 type-label text-text-secondary">
          <span className="size-3.5 animate-spin rounded-full border-2 border-text-secondary border-r-transparent motion-reduce:animate-none" aria-hidden="true" />{t('page.pending.loading')}
        </div>
      ) : (
        <div role="alert" className="fade-up chrome w-[min(24rem,100%)] rounded-lg p-4">
          <p className="type-body font-semibold text-text-primary">{t('page.pending.failedTitle')}</p>
          <p className="mt-1 type-label text-text-secondary">{t('page.pending.failedBody', { reason: failure })}</p>
          <div className="mt-3"><Button variant="primary" size="sm" onClick={onRetry}>{tc('retry')}</Button></div>
        </div>
      )}
    </div>
  );
}
