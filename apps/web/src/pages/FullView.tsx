import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router';
import { Crosshair, LayoutGrid, PanelLeft, PanelRight, SlidersHorizontal } from 'lucide-react';
import { DEVICE_SIZE, shadowedStateKeys, statesFillPrompt, type JobDto, type LinkDto, type ProjectDetailDto, type Runner, type ScreenDto, type StateDim, type StatesProposalDto, type SurfaceDto, type SurfaceStatesInput } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type { SelectMessage } from '@/canvas/frameMessages';
import { IconButton } from '@/ui/ui';
import { DraftVersions } from '@/sketch/DraftVersions';
import { ScreenDirectory, directoryChain, directorySections } from '@/fullview/ScreenDirectory';
import { DeviceStage } from '@/fullview/DeviceStage';
import { StatePanel } from '@/fullview/StatePanel';
import { useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';

const MAX_BATCH = 20; // API-CORE-010 一个作业至多 20 屏
const DIR_KEY = 'quilt:fullview:dir';
const STATES_KEY = 'quilt:fullview:states';
const readOpen = (key: string) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const saveOpen = (key: string, open: boolean) => { try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* 无痕模式写不了，只本次有效 */ } };
const problemText = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? e.problem.title : fallback);
// 地址里的取值：state=<维度键>:<取值键>,…
const parseState = (v: string | null): Record<string, string> => Object.fromEntries((v ?? '').split(',').map((x) => x.split(':')).filter((x): x is [string, string] => x.length === 2 && !!x[0] && !!x[1]));
const formatState = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(',');
/** 打开一屏时的地址：端上的取值留着，页内状态回缺省（state 里只留端上维度的键）。画布页的找屏与跟随也走它 */
export function withScreen(q: URLSearchParams, id: string | null, surface: SurfaceDto) {
  if (id) q.set('screen', id); else q.delete('screen');
  const keys = new Set(surface.states.dims.map((d) => d.key));
  const kept = Object.fromEntries(Object.entries(parseState(q.get('state'))).filter(([k]) => keys.has(k)));
  if (Object.keys(kept).length) q.set('state', formatState(kept)); else q.delete('state');
  return q;
}

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, [query]);
  return on;
}

/** 两栏的开合（PAGE-FULLVIEW「三栏」「窄窗口」）：宽窗口下记在本机；窄窗口下收成抽屉，抽屉开合只管这一次。页面外壳按 attrs 让出中栏 */
export function useFullViewColumns() {
  const [dirOpen, setDirOpen] = useState(() => readOpen(DIR_KEY));
  const [statesOpen, setStatesOpen] = useState(() => readOpen(STATES_KEY));
  // 断点与 styles.css 里 .fullview-shell 的两条一致
  const narrowDir = useMedia('(max-width: 48rem)');
  const narrowStates = useMedia('(max-width: 68.75rem)');
  const [dirDrawer, setDirDrawer] = useState(false);
  const [statesDrawer, setStatesDrawer] = useState(false);
  const toggleDir = () => { if (narrowDir) setDirDrawer(!dirDrawer); else { setDirOpen(!dirOpen); saveOpen(DIR_KEY, !dirOpen); } };
  const toggleStates = () => { if (narrowStates) setStatesDrawer(!statesDrawer); else { setStatesOpen(!statesOpen); saveOpen(STATES_KEY, !statesOpen); } };
  return {
    showDir: narrowDir ? dirDrawer : dirOpen, showStates: narrowStates ? statesDrawer : statesOpen, narrowDir, narrowStates, toggleDir, toggleStates,
    closeDrawers: () => { setDirDrawer(false); setStatesDrawer(false); },
    attrs: { 'data-dir': !narrowDir && dirOpen ? 'open' : 'closed', 'data-states': !narrowStates && statesOpen ? 'open' : 'closed' },
  };
}
export type FullViewColumns = ReturnType<typeof useFullViewColumns>;

/**
 * 全屏视图（PAGE-FULLVIEW，REQ-CORE-050 / REQ-CORE-051，ADR-042）：画布页的第二个视图，同一份项目数据、同一个顶栏与输入框。
 * 左栏屏目录、中栏设备台、右栏状态栏；正看哪一屏与状态取值记在地址（?screen= / ?state=），换屏时端上的取值保留、页内状态回缺省
 */
export function FullView(p: {
  projectName: string;
  surface: SurfaceDto;
  /** 这一端的屏（按建屏先后）与从这些屏出发的链接 */
  screens: ScreenDto[];
  links: LinkDto[];
  previewOrigin: string;
  busy: ReadonlySet<string>;
  cols: FullViewColumns;
  onCurrent: (s: ScreenDto | null) => void;
  picking: boolean; onPicking: (on: boolean) => void; pickQids: string[]; onPick: (m: SelectMessage) => void;
  climbRef: RefObject<((dir: 'up' | 'down') => void) | null>;
  onFillComposer: (text: string) => void;
  onNavigateMissing: (fromScreenId: string, href: string) => void;
  onToCanvas: () => void;
  onEscape: () => void;
  onShortcut: (code: string, alt: boolean) => void;
  onStale: () => Promise<ProjectDetailDto | null>;
  refresh: () => Promise<unknown>;
  startJob: (body: unknown, fallback: string) => Promise<JobDto | null>;
  modelRunner: Runner | undefined;
  proposal: StatesProposalDto | null; proposing: boolean; onDismissProposal: () => void;
}) {
  const t = useT(fullviewMessages);
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { screens, surface } = p;
  const chain = useMemo(() => directoryChain(screens, p.links), [screens, p.links]);
  const sections = useMemo(() => directorySections(screens, chain?.ids), [screens, chain]);
  // 目录里每屏属于哪一节：收成一条的那些算一节，其余按分组
  const buckets = useMemo(() => new Map([
    ...(chain?.items ?? []).map((i) => [i.screen.id, '\u0001'] as const),
    ...sections.flatMap((x) => x.items.map((i) => [i.screen.id, x.group ?? '\u0000'] as const)),
  ]), [chain, sections]);
  const order = useMemo(() => [...buckets.keys()], [buckets]);
  const byId = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens]);
  // 「移到分组」可选的分组：这一端所有屏用到的，收成一条的屏的分组也算
  const groups = useMemo(() => directorySections(screens).flatMap((x) => (x.group ? [x.group] : [])), [screens]);
  const [chainOpen, setChainOpen] = useState(false);
  const want = params.get('screen');
  const current = (want && byId.get(want)) || null;
  const raw = useMemo(() => parseState(params.get('state')), [params]);
  // 叠层屏底下垫哪一屏：从某一屏点过来的垫它；单独打开（目录里点、地址直达）的垫这一端第一张整屏
  const [underId, setUnderId] = useState<string | null>(null);
  const firstPush = order.map((id) => byId.get(id)).find((s) => s && s.presentation !== 'overlay' && !s.variantOf && s.currentRevisionId) ?? null;
  const under = current?.presentation === 'overlay' ? (underId && byId.get(underId)) || firstPush : null;

  const open = (id: string | null, mode: 'push' | 'replace' = 'push') => setParams((q) => withScreen(q, id, surface), { replace: mode === 'replace' });
  const pick = (id: string) => { setUnderId(null); if (id !== current?.id) open(id); };

  // 地址里没有屏（画布上选中着一屏时，切过来的地址已带上它）或屏不在这一端（刚被删、地址过期）：校正。正看着的屏在别处被删 → 同一节下一屏（没有就同一节上一屏、再没有就第一屏）
  const last = useRef<{ surfaceId: string; id: string; order: string[]; buckets: Map<string, string> } | null>(null);
  useEffect(() => {
    if (current) {
      last.current = { surfaceId: surface.id, id: current.id, order, buckets };
      return;
    }
    if (!order.length) { if (want) open(null, 'replace'); return; }
    const prev = last.current?.surfaceId === surface.id ? last.current : null;
    let next: string | undefined;
    if (want && prev?.id === want) {
      const same = (id: string) => byId.has(id) && prev.buckets.get(id) === prev.buckets.get(want);
      const i = prev.order.indexOf(want);
      next = prev.order.slice(i + 1).find(same) ?? prev.order.slice(0, i).reverse().find(same);
      toast(t('page.deleted'), 'error');
    } else if (want) toast(t('page.gone'), 'error');
    open(next ?? order[0], 'replace');
  }, [current, want, order, surface.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentId = current?.id ?? null;
  useEffect(() => { p.onCurrent(current); }, [currentId, current?.currentRevisionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 浏览器标签页标题「<屏名> · <项目名> · Quilt」
  useEffect(() => {
    if (!current) return;
    document.title = t('page.title', { screen: current.name, project: p.projectName });
  }, [current?.name, p.projectName, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // 此刻生效的取值：端上没退役的维度与这一屏的页内状态（与端上重名的不算），地址里没给或给得不对的取缺省
  const page = current?.states ?? null;
  const shadowed = useMemo(() => new Set(page ? shadowedStateKeys(page, surface.states) : []), [page, surface.states]);
  const dims: StateDim[] = useMemo(() => [...surface.states.dims.filter((d) => !d.retired), ...(page?.dims ?? []).filter((d) => !shadowed.has(d.key))], [surface.states, page, shadowed]);
  const values = useMemo(() => Object.fromEntries(dims.map((d) => [d.key, d.values.some((v) => v.key === raw[d.key]) ? raw[d.key] : d.default])), [dims, raw]);
  const setValue = (dim: string, value: string) => setParams((q) => {
    const m = parseState(q.get('state'));
    const d = dims.find((x) => x.key === dim);
    if (d && d.default === value) delete m[dim]; else m[dim] = value;
    if (Object.keys(m).length) q.set('state', formatState(m)); else q.delete('state');
    return q;
  }, { replace: true });
  const reset = () => setParams((q) => { q.delete('state'); return q; }, { replace: true });
  const playRef = useRef<((key: string, ms?: number) => void) | null>(null);

  // 屏里点了站内链接（REQ-PROTO-001）：叠层里指回底下那一屏的是关闭；目标路由在这一端没有屏就交给页面问要不要生成
  const navigate = (href: string) => {
    if (!current) return;
    if (current.presentation === 'overlay' && under && href === under.route) { open(under.id); return; }
    const target = screens.find((s) => s.route === href && !s.variantOf);
    if (!target) { p.onNavigateMissing(current.id, href); return; }
    if (target.presentation === 'overlay') setUnderId(current.presentation === 'overlay' ? under?.id ?? null : current.id);
    else setUnderId(null);
    if (target.id !== current.id) open(target.id);
  };
  const dismissOverlay = () => { if (current?.presentation === 'overlay' && under) open(under.id); };

  const rename = async (s: ScreenDto, name: string) => {
    try { await api.screens.patch(s.id, { name }); toast(t('page.renamed', { name })); void p.refresh(); return true; }
    catch (e) { toast(problemText(e, t('page.renameFailed')), 'error'); return false; }
  };
  const moveGroup = async (s: ScreenDto, group: string | null) => {
    try {
      await api.screens.patch(s.id, { group });
      toast(group ? t('page.moved', { name: s.name, group }) : t('page.movedNone', { name: s.name }));
      void p.refresh();
      return true;
    } catch (e) { toast(problemText(e, t('page.moveFailed')), 'error'); return false; }
  };
  // 改维度（API-CORE-054）：整份提交、带版本号；返回写在编辑器里的错误，null = 存上了
  const saveStates = async (states: SurfaceStatesInput): Promise<string | null> => {
    try {
      await api.surfaces.patch(surface.id, { states, expectedVersion: surface.version });
      toast(t('page.statesSaved'));
      void p.refresh();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/version-conflict') { void p.refresh(); return t('page.statesConflict'); }
      if (e instanceof ApiError && e.type === '/errors/not-found') { void p.refresh(); return t('page.surfaceGone'); }
      return problemText(e, t('surface.failed'));
    }
  };
  // 补上 N 屏（FLOW-STATES S5）：每轮至多 20 屏，一轮建不成（正在改、限流）就停下，说清还剩几屏，并重取一次重新数
  const fill = async (dim: StateDim, targets: ScreenDto[]) => {
    let sent = 0;
    for (let i = 0; i < targets.length; i += MAX_BATCH) {
      const batch = targets.slice(i, i + MAX_BATCH);
      if (!(await p.startJob({ kind: 'edit_screens', input: { prompt: statesFillPrompt(dim.name), screenIds: batch.map((s) => s.id), versions: 1, runner: p.modelRunner } }, t('page.fillBusy')))) break;
      sent += batch.length;
    }
    if (sent === targets.length) toast(t('page.fillStarted', { count: sent }));
    else { if (sent) toast(t('page.fillPartial', { sent, rest: targets.length - sent }), 'error'); void p.refresh(); }
  };
  const propose = async () => {
    const job = await p.startJob({ kind: 'propose_states', input: { surfaceId: surface.id, runner: p.modelRunner } }, t('page.proposeFailed'));
    if (job) toast(t('page.proposing'));
  };

  const { cols } = p;
  const size = DEVICE_SIZE[surface.deviceType];
  const busyName = current && p.busy.has(current.id) ? current.name : null;
  return (
    <>
      {cols.showDir && (
        <nav aria-label={t('dir.label')} data-side="left" data-testid="fv-dir" className="fv-col chrome">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 pl-3.5 pr-1.5">
            <h2 className="type-label font-semibold text-text-primary">{t('dir.label')}</h2>
            <IconButton size="xs" tip="bottom-end" label={t('page.hideDir')} onClick={cols.toggleDir}><PanelLeft size={16} aria-hidden="true" /></IconButton>
          </div>
          <div className="fv-body scroll-nav px-1.5">
            <ScreenDirectory chain={chain} expanded={chainOpen} onExpand={setChainOpen} sections={sections} currentId={currentId} groups={groups}
              onPick={(id) => { pick(id); if (cols.narrowDir) cols.closeDrawers(); }} onRename={rename} onMoveGroup={moveGroup} />
          </div>
        </nav>
      )}

      <div className="fv-toolbar">
        <div data-testid="fv-toolbar" role="toolbar" aria-label={t('toolbar.label')} className="chrome flex min-h-10 min-w-0 max-w-full items-center gap-1 rounded-lg px-1 py-0.5">
          {!cols.showDir && <IconButton size="xs" tip="bottom-start" label={t('page.showDir')} data-testid="fv-show-dir" onClick={cols.toggleDir}><PanelLeft size={16} aria-hidden="true" /></IconButton>}
          {current && (
            <span className="flex min-w-0 items-baseline gap-2 px-2" data-testid="fv-screen-name">
              <span className="truncate type-body font-medium text-text-primary">{current.variantOf ? byId.get(current.variantOf)?.name ?? current.name : current.name}</span>
              {current.variantName && <span className="shrink-0 type-label text-text-secondary">{current.variantName}</span>}
              <span className="shrink-0 truncate type-caption text-text-secondary">{current.route}</span>
            </span>
          )}
          {current?.currentRevisionId && (
            <>
              <IconButton size="xs" tip="bottom" label={p.picking ? t('toolbar.inspectOn') : t('toolbar.inspect')} hint="⌘E" active={p.picking} aria-pressed={p.picking} data-testid="fv-pick" onClick={() => p.onPicking(!p.picking)}><Crosshair size={16} aria-hidden="true" /></IconButton>
              <DraftVersions draft={current} busy={busyName} onRestored={() => void p.refresh()} />
            </>
          )}
          <IconButton size="xs" tip="bottom" label={t('toolbar.toCanvas')} hint="⌥F" data-testid="fv-to-canvas" onClick={p.onToCanvas}><LayoutGrid size={16} aria-hidden="true" /></IconButton>
          {!cols.showStates && <IconButton size="xs" tip="bottom-end" label={cols.narrowStates ? t('toolbar.states') : t('page.showStates')} data-testid="fv-show-states" onClick={cols.toggleStates}>{cols.narrowStates ? <SlidersHorizontal size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}</IconButton>}
        </div>
      </div>

      <main className="fv-stage" aria-label={current?.name ?? t('page.empty')}>
        {!order.length ? (
          <div data-testid="fv-empty" className="fade-up flex max-w-md flex-col items-center gap-2 px-4 text-center">
            <h1 className="type-heading2 font-semibold text-text-primary [text-wrap:balance]">{t('page.empty')}</h1>
            <p className="type-label text-text-secondary [text-wrap:pretty]">{t('page.emptyHint')}</p>
          </div>
        ) : current && current.currentRevisionId && current.previewUrl ? (
          <DeviceStage
            screen={current} under={under} size={size} previewOrigin={p.previewOrigin} dimsKey={JSON.stringify(surface.states)} values={values} playRef={playRef}
            picking={p.picking} pickQids={p.pickQids} onPick={p.onPick} climbRef={p.climbRef}
            onNavigate={navigate} onOverlayDismiss={dismissOverlay} onEscape={p.onEscape} onShortcut={p.onShortcut} onStale={p.onStale}
            onPreviewError={(s) => toast(t('page.notGenerated', { name: s.name }), 'error')}
          />
        ) : current ? (
          <div className="draft-frame draft-skeleton grid place-items-center" style={{ width: Math.min(size.w, 480), height: Math.min(size.h, 320) }}>
            <span role="status" className="flex items-center gap-2 rounded-sm px-3 py-1.5 type-label inverse"><span className="sk-dot shrink-0" aria-hidden="true" />{t('page.notGenerated', { name: current.name })}</span>
          </div>
        ) : null}
      </main>

      {cols.showStates && (
        <aside aria-label={t('states.surface', { name: surface.name })} data-side="right" data-testid="fv-states" className="fv-col chrome">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 pl-3.5 pr-1.5">
            <h2 className="type-label font-semibold text-text-primary">{t('toolbar.states')}</h2>
            <IconButton size="xs" tip="bottom-end" label={t('page.hideStates')} onClick={cols.toggleStates}><PanelRight size={16} aria-hidden="true" /></IconButton>
          </div>
          <div className="fv-body scroll px-2.5">
            <StatePanel
              surface={surface} screen={current} screens={screens} values={values} busy={p.busy}
              proposal={p.proposal} proposing={p.proposing}
              onValue={setValue} onReset={reset} onPlay={(key, ms) => playRef.current?.(key, ms)}
              onPropose={() => void propose()} onDismissProposal={p.onDismissProposal}
              onSave={saveStates} onFill={fill} onAddPageState={() => p.onFillComposer(t('page.addPagePrompt'))}
            />
          </div>
        </aside>
      )}
    </>
  );
}
