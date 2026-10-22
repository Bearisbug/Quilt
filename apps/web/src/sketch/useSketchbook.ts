import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobDto, JobEventDto, ProjectDetailDto, ScreenDto } from '@quilt/core/browser';
import { api, ApiError, loadConfig, subscribeProjectEvents, type LiveState } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { recordEvent } from '@/lib/recorder';
import type { Presence } from '@/lib/collab';
import { progressText } from '@/canvas/jobTracker';
import { tOf, useLocale, type Locale } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

/** 项目事件流里草稿本页关心的两类（API-CORE-030）：作业事件按 jobId，屏回写按 screenId（本机会话写出的新草稿带 jobId） */
export type SketchEvent =
  | { kind: 'job'; jobId: string; type: JobEventDto['type']; data: Record<string, unknown>; job: JobDto | undefined }
  | { kind: 'screen'; screenId: string; jobId: string | null };

// 签名续取（同画布 v0.76）：截图签名至少 5 分钟、预览签名至少 10 分钟有效，页面可见时距上次取到详情满 4 分钟就静默重取
const RENEW_MS = 4 * 60_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const t = tOf(sketchMessages);

// 作业此刻到哪一步：记事件的原始字段，文案按当时的界面语言现算（切语言即时换）
type Stage = { type: 'progress' | 'screen_planned' | 'screen_html_ready'; kind: JobDto['kind']; data: Record<string, unknown> };
const stageText = (s: Stage, lng: Locale) => (s.type === 'progress' ? progressText(s.kind, s.data) : s.type === 'screen_planned' ? t('book.planned', { name: String(s.data.name), lng }) : t('book.shooting', { lng }));

// 草稿本页的数据（REQ-CORE-040，ADR-030）：取回草稿本（API-CORE-046）→ 项目详情（API-CORE-004）→ 订阅项目事件流（API-CORE-030）。
// 与画布同一套口径的精简版：事件只是「有变化」，收到就防抖 250 ms 整体重取；详情按发起序号只丢早于已应用的回包；
// 断线由 subscribeProjectEvents 退避重建，断过之后重新连上就整体重取一次（事件不续传）。
// 在跑作业 = 详情里的进行中作业 ∪ 本页刚建、详情还没列出的；宣告过终态的记进 finished，晚到的旧详情不把它带回来
// presenceRef（v1.32 REQ-CORE-048）：协作事件交给它，事件流重连时先清空它记着的人
export function useSketchbook(onEvent: (e: SketchEvent) => void, presenceRef?: { current: Presence | null }) {
  const toast = useToast();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  // 失败原因：服务端的 problem 标题，没有（连不上）时 title 空着，文案渲染时再取
  const [failure, setFailure] = useState<{ title?: string } | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const loadBook = useCallback(() => api.sketchbook.get()
    .then((b) => { setFailure(null); setProjectId(b.projectId); })
    .catch((e) => setFailure({ title: e instanceof ApiError ? e.problem.title : undefined })), []);
  // 预览域地址来自运行时配置（API-CORE-028），没有它草稿的 iframe 摆不出来
  const loadOrigin = useCallback(() => loadConfig().then((c) => { setConfigFailed(false); setPreviewOrigin(c.previewOrigin); }).catch(() => setConfigFailed(true)), []);
  useEffect(() => { void loadBook(); void loadOrigin(); }, [loadBook, loadOrigin]);

  // 本页刚建的作业与它建出来那一刻已发起到第几次详情请求：之后发起的详情回来时，它要么已列在里面、要么已经结束，本地这份就不用再留
  const [local, setLocal] = useState<{ job: JobDto; seq: number }[]>([]);
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set());
  const [stages, setStages] = useState<Record<string, Stage>>({});
  const detailSeq = useRef(0);
  const appliedSeq = useRef(0);
  const lastFetch = useRef(0);
  const hasDetail = useRef(false);
  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}): Promise<ProjectDetailDto | null> => {
    if (!projectId) return null;
    const seq = ++detailSeq.current;
    try {
      const d = await api.projects.get(projectId);
      if (seq < appliedSeq.current) return d;
      appliedSeq.current = seq;
      lastFetch.current = Date.now();
      hasDetail.current = true;
      setFailure(null);
      setDetail(d);
      setLocal((prev) => (prev.some((l) => l.seq < seq) ? prev.filter((l) => l.seq >= seq) : prev));
      const live = new Set(d.activeJobs.map((j) => j.id));
      setFinished((prev) => ([...prev].every((id) => live.has(id)) ? prev : new Set([...prev].filter((id) => live.has(id)))));
      return d;
    } catch (e) {
      if (seq !== detailSeq.current) return null;
      // 草稿本在别处被删（API-CORE-031 / quilt.delete_project）：再取一次草稿本，服务端建一个空的（API-CORE-046）
      if (e instanceof ApiError && e.status === 404) { hasDetail.current = false; setDetail(null); void loadBook(); return null; }
      if (!hasDetail.current) setFailure({ title: e instanceof ApiError ? e.problem.title : undefined });
      else if (!quiet) toast(e instanceof ApiError ? e.problem.title : t('book.loadFailed'), 'error');
      return null;
    }
  }, [projectId, loadBook, toast]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible' && hasDetail.current && Date.now() - lastFetch.current >= RENEW_MS) void refresh({ quiet: true }); };
    const t = window.setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [refresh]);
  const refreshTimer = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void refresh(); }, 250);
  }, [refresh]);
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current); }, []);

  const jobs = useMemo(() => {
    const m = new Map<string, JobDto>();
    for (const j of detail?.activeJobs ?? []) m.set(j.id, j);
    for (const l of local) if (!m.has(l.job.id)) m.set(l.job.id, l.job);
    return [...m.values()].filter((j) => !finished.has(j.id));
  }, [detail?.activeJobs, local, finished]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const track = useCallback((job: JobDto) => { recordEvent('job', job.kind, { jobId: job.id, status: job.status }); setLocal((prev) => [...prev, { job, seq: detailSeq.current }]); }, []);
  const settle = useCallback((id: string) => {
    setFinished((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setLocal((prev) => prev.filter((l) => l.job.id !== id));
    setStages((m) => { if (!(id in m)) return m; const next = { ...m }; delete next[id]; return next; });
  }, []);
  // 取消（GAI-002）：成功即撤掉那一行，不等 cancelled 事件；连按两次撞上「已经结束」不算失败
  const cancel = useCallback(async (id: string) => {
    try { await api.jobs.cancel(id); settle(id); }
    catch (e) { if (!(e instanceof ApiError && e.type === '/errors/job-finished')) toast(t('book.cancelFailed'), 'error'); }
  }, [settle, toast]);

  // 项目事件流的连接状态：断开超过 3 s 才露出（重连通常 1 s 内完成），放弃重试后给「重连」
  const [feed, setFeed] = useState<LiveState>('open');
  const [feedShown, setFeedShown] = useState(false);
  const [feedEpoch, setFeedEpoch] = useState(0);
  const feedBroken = useRef(false);
  useEffect(() => {
    if (feed === 'open') { setFeedShown(false); return; }
    if (feed === 'offline') { setFeedShown(true); return; }
    const t = window.setTimeout(() => setFeedShown(true), 3000);
    return () => window.clearTimeout(t);
  }, [feed]);
  const reconnect = useCallback(() => { setFeed('reconnecting'); setFeedEpoch((n) => n + 1); }, []);
  // 处理器放 ref：页面每次渲染换成新的，订阅不动
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => projectId ? subscribeProjectEvents(projectId, (e) => {
    scheduleRefresh();
    const p = e.data as { jobId?: string; type?: JobEventDto['type']; screenId?: string; data?: unknown } | undefined;
    if (e.type === 'screen_changed') { if (p?.screenId) onEventRef.current({ kind: 'screen', screenId: p.screenId, jobId: p.jobId ?? null }); return; }
    if (!p?.jobId || !p.type) return;
    const jobId = p.jobId;
    const data = (p.data ?? {}) as Record<string, unknown>;
    const job = jobsRef.current.find((j) => j.id === jobId);
    const type = p.type;
    if (type === 'progress' || type === 'screen_planned' || type === 'screen_html_ready') setStages((m) => ({ ...m, [jobId]: { type, kind: job?.kind ?? 'generate', data } }));
    if (TERMINAL.has(p.type)) { recordEvent('job', job?.kind, { jobId, status: p.type, errorClass: data.errorClass }); settle(jobId); void refresh(); }
    onEventRef.current({ kind: 'job', jobId, type: p.type, data, job });
  }, (st) => {
    setFeed(st);
    if (st !== 'open') { feedBroken.current = true; return; }
    presenceRef?.current?.reset();
    if (feedBroken.current) { feedBroken.current = false; void refresh({ quiet: true }); }
  }, (e) => presenceRef?.current?.handle(e)) : undefined, [projectId, scheduleRefresh, refresh, settle, feedEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // 改名、换画框的回包（API-CORE-012）直接写回详情：不等下一次整体重取，工具条上不闪一下旧值
  const applyScreen = useCallback((screen: ScreenDto) => setDetail((d) => d && { ...d, screens: d.screens.map((x) => (x.id === screen.id ? screen : x)) }), []);
  const locale = useLocale();
  const progress = useMemo(() => Object.fromEntries(Object.entries(stages).map(([id, s]) => [id, stageText(s, locale)])), [stages, locale]);
  const retry = useCallback(() => { setFailure(null); setConfigFailed(false); void loadOrigin(); if (projectId) void refresh(); else void loadBook(); }, [loadOrigin, loadBook, refresh, projectId]);
  return { projectId, detail, failure: failure ? failure.title ?? t('book.offline') : configFailed ? t('book.noConfig') : null, previewOrigin, refresh, retry, applyScreen, detailSeq, appliedSeq, jobs, progress, track, cancel, feed, feedShown, reconnect };
}
