import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { XYPanZoom, PanOnScrollMode, getViewportForBounds, type PanZoomInstance, type Viewport } from '@xyflow/system';
import { isPreviewMessage, type AssetDto, type ScreenDto, type LinkDto, type Tokens, type Palette, type ColorMode, type ParentToPreview, type AnnotationDto } from '@quilt/core';
import { StyleGuideCard, STYLE_GUIDE_SIZE, styleGuideSize } from './StyleGuideCard';

// 角标里提示的进入选择元素模式的键，要与 Canvas.tsx 的键位表一致（REQ-EDIT-004）
const INSPECT_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘E' : 'Ctrl+E';

export type CanvasProps = {
  projectName: string;
  tokens: Tokens;
  /** 品牌色板（REQ-EDIT-005）：只为风格指南卡片写明色板来源 */
  palette?: Palette | null;
  colorMode?: ColorMode;
  /** 项目素材（REQ-CORE-019）：画在风格指南卡片底部 */
  assets?: AssetDto[];
  screens: ScreenDto[];
  links: LinkDto[];
  previewOrigin: string;
  selectedIds: string[];
  focusedId: string | null;
  styleGuideSelected: boolean;
  /** additive = Shift/⌘ 加选；id 为 null 表示清空 */
  onSelect: (id: string | null, additive?: boolean) => void;
  onSelectMany: (ids: string[], additive: boolean) => void;
  onSelectStyleGuide: () => void;
  onFocus: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onNavigateMissing: (fromScreenId: string, href: string) => void;
  onDanglingClick: (screenId: string, hrefs: string[]) => void;
  onDeadLink: () => void;
  /** 焦点在预览文档里时运行时转发来的 ⌘ 组合键（e.code），父页按自己的键位表处理 */
  onShortcut?: (code: string) => void;
  /** 双击画布空白处放锚点（REQ-CORE-014）：world 是落点的画布坐标（新屏中心） */
  onAnchor?: (world: { x: number; y: number }) => void;
  /** 已放下的锚点（幽灵框画在世界层，尺寸 = 设备形态） */
  anchor: { x: number; y: number } | null;
  screenSize: { w: number; h: number };
  /** 样板屏（REQ-CORE-016）：卡片标签上标出 */
  exemplarScreenId: string | null;
  /** 点卡片候选角标：就地展开 / 收起候选（REQ-CORE-015） */
  onCandidates: (jobId: string, screenId: string) => void;
  /** 正展开候选的屏：展开层画在世界层、盖在该卡片原位（节点由父组件提供） */
  candidateStack: { screenId: string; node: ReactNode } | null;
  /** null = 热更新后元素已不在（被删 / 子树换了 qid），父页清空选中 */
  onElementSelect: (sel: { qid: string; tag: string; text: string; classes: string; href: string | null; rect: { x: number; y: number; w: number; h: number } } | null) => void;
  /** 当前选中元素的 qid：热更新换了修订后让运行时按它重选，检查器不必退回空态 */
  selectedQid: string | null;
  /** 正在被子树重生成作业改的元素（REQ-EDIT-002）：聚焦屏内描边 + 「修改中…」，回写后换成「已更新」；未聚焦的卡片标「局部修改中」 */
  workingSubtrees: { screenId: string; qid: string }[];
  inspectMode: boolean;
  /** 批注态也复用屏内的 inspect 运行时，但角标与去向不同 */
  annotateMode: boolean;
  /** 选择元素 / 批注模式已开但还没进任何一屏：点哪一屏就进哪一屏 */
  armed: null | 'inspect' | 'annotate';
  showLinks: boolean;
  /** 未处理的批注：气泡画在画布层，按批注时记下的元素矩形定位（REQ-EDIT-004 / ADR-003） */
  annotations: AnnotationDto[];
  onAnnotationClick: (id: string) => void;
  onStat?: (s: { zoom: number }) => void;
  /** 未被浮层遮住的那块画布：适配视图与聚焦都以它为准，否则内容会被推到对话面板/工具栏底下 */
  safeAreaRef?: { current: HTMLElement | null };
  registerApi?: (api: { fitView: () => void; goBack: () => void; highlight: (qid: string | null) => void; focus: (id: string) => void; resetToOwn: () => void; createAtCenter: () => void; markDone: (qids: string[]) => void }) => void;
  navStack: string[];
  setNavStack: (f: (s: string[]) => string[]) => void;
};

const STYLE_GUIDE_POS = { x: -(STYLE_GUIDE_SIZE.w + 80), y: 0 };

// 无限画布（ADR-002 / ADR-006）：截图卡片 + 单聚焦活 iframe；世界层 transform 由 @xyflow/system 驱动。
export function CanvasView(p: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panZoom = useRef<PanZoomInstance | null>(null);
  const vp = useRef<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  const spaceDown = useRef(false);
  // 空格按住 = 平移就绪：只有这时指针才是抓手；平时是箭头（空白处按下是框选，不是拖画布）
  const [panReady, setPanReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  const [iframeReady, setIframeReady] = useState(false);
  // 重挂 iframe 用：从交互态切到选择元素态时，要把屏内导航过的 DOM 丢掉、回到这张卡片自己的那一屏
  const [reloadKey, setReloadKey] = useState(0);
  // 聚焦期间钉住 iframe 的 src：previewUrl 是签名 URL，每次 refresh 都会换一串新签名，
  // src 一变 iframe 就静默重载、回到 interact 模式，选择元素/批注态当场失效（且丢掉屏内滚动位置）。
  const [focusedSrc, setFocusedSrc] = useState<string | null>(null);
  useEffect(() => { if (!p.focusedId) { setIframeReady(false); setFocusedSrc(null); } }, [p.focusedId]);
  useEffect(() => {
    if (!p.focusedId || focusedSrc) return;
    const cur = p.screens.find((x) => x.id === p.focusedId);
    if (cur?.previewUrl) setFocusedSrc(cur.previewUrl);
  }, [p.focusedId, p.screens, focusedSrc]);

  // 父组件每次渲染都会传入新的回调；XYPanZoom 实例与 transform 回调必须稳定，否则实例被反复重建、transition 被打断
  const propsRef = useRef(p);
  propsRef.current = p;
  const pos = useCallback((s: ScreenDto) => dragPos[s.id] ?? { x: s.x, y: s.y }, [dragPos]);
  const byId = useMemo(() => Object.fromEntries(p.screens.map((s) => [s.id, s])), [p.screens]);
  const focused = p.focusedId ? byId[p.focusedId] : null;
  const selectedSet = useMemo(() => new Set(p.selectedIds), [p.selectedIds]);
  const annoByScreen = useMemo(() => {
    const m = new Map<string, AnnotationDto[]>();
    for (const a of p.annotations) m.set(a.screenId, [...(m.get(a.screenId) ?? []), a]);
    return m;
  }, [p.annotations]);
  const danglingBySource = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of p.links) if (!l.toScreenId) m.set(l.fromScreenId, [...(m.get(l.fromScreenId) ?? []), l.href]);
    return m;
  }, [p.links]);
  // 页面地图连线（REQ-PROTO-002）：同一对屏合并为一条并计数；自环不画
  const edges = useMemo(() => {
    const m = new Map<string, { from: string; to: string; count: number }>();
    for (const l of p.links) {
      if (!l.toScreenId || l.toScreenId === l.fromScreenId) continue;
      const k = `${l.fromScreenId}>${l.toScreenId}`;
      const e = m.get(k) ?? { from: l.fromScreenId, to: l.toScreenId, count: 0 };
      e.count += 1; m.set(k, e);
    }
    return Array.from(m.values());
  }, [p.links]);
  // 双向互链的两条边上下错开，免得箭头与计数叠在一起
  const edgePath = (from: ScreenDto, to: ScreenDto, offset: number) => {
    const a = pos(from); const b = pos(to);
    const leftToRight = a.x + from.width / 2 <= b.x + to.width / 2;
    const x1 = leftToRight ? a.x + from.width : a.x; const y1 = a.y + Math.min(from.height, 240) / 2 + offset;
    const x2 = leftToRight ? b.x : b.x + to.width; const y2 = b.y + Math.min(to.height, 240) / 2 + offset;
    const dx = Math.max(60, Math.abs(x2 - x1) / 2) * (leftToRight ? 1 : -1);
    return { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  };

  const applyTransform = useCallback((v: Viewport) => {
    vp.current = v;
    if (worldRef.current) { worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`; worldRef.current.style.setProperty('--zoom', String(v.zoom)); }
    propsRef.current.onStat?.({ zoom: v.zoom });
  }, []);

  const updatePanZoom = useCallback(() => {
    panZoom.current?.update({
      noWheelClassName: 'nowheel', noPanClassName: 'nopan', preventScrolling: true,
      // 空白处拖拽留给框选，平移走滚轮 / 触控板 / 空格+拖拽
      panOnScroll: true, panOnScrollMode: PanOnScrollMode.Free, panOnScrollSpeed: 0.5, panOnDrag: spaceDown.current,
      panActivationKeyPressed: spaceDown.current, userSelectionActive: false,
      zoomOnPinch: true, zoomOnScroll: false, zoomOnDoubleClick: false, zoomActivationKeyPressed: false,
      lib: 'react', onTransformChange: ([x, y, zoom]) => applyTransform({ x, y, zoom }), connectionInProgress: false, paneClickDistance: 0,
    });
  }, [applyTransform]);

  useEffect(() => {
    const node = viewportRef.current!;
    const inst = XYPanZoom({ domNode: node, minZoom: 0.1, maxZoom: 2, viewport: vp.current, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]], onDraggingChange: setDragging });
    panZoom.current = inst;
    updatePanZoom();
    applyTransform(vp.current);
    return () => inst.destroy();
  }, [applyTransform, updatePanZoom]);

  // 可用区 = 画布减去四周浮层的占位；几何由 CSS 变量驱动的探针元素给出，这里只测不算
  const safeArea = useCallback(() => {
    const node = viewportRef.current!;
    const el = propsRef.current.safeAreaRef?.current;
    if (!el) return { x: 0, y: 0, w: node.clientWidth, h: node.clientHeight };
    const nr = node.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { x: r.left - nr.left, y: r.top - nr.top, w: Math.max(240, r.width), h: Math.max(240, r.height) };
  }, []);

  const fitView = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const rects = [...p.screens.map((s) => ({ ...pos(s), w: s.width, h: s.height })), { ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) }];
    const x0 = Math.min(...rects.map((r) => r.x)); const y0 = Math.min(...rects.map((r) => r.y)) - 40;
    const x1 = Math.max(...rects.map((r) => r.x + r.w)); const y1 = Math.max(...rects.map((r) => r.y + r.h));
    const a = safeArea();
    const v = getViewportForBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 + 40 }, a.w, a.h, 0.1, 1.5, 0.08);
    panZoom.current?.setViewport({ x: v.x + a.x, y: v.y + a.y, zoom: v.zoom }, { duration: 300 });
  }, [p.screens, pos, safeArea]);

  const focusCardRef = useRef<(id: string) => void>(() => {});
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  const fitOnce = useRef(false);
  // 两次一次性适配，都延后到下一 tick（挂载同 tick 内的 setViewport 会被 d3-zoom 初始化打断，M0 实证）：
  // ① 挂载即适配，否则空项目的风格指南卡片停在世界坐标负半轴、被挤出视口左缘够不着；
  // ② 首批屏幕到达后再适配一次。
  useEffect(() => { const t = setTimeout(() => fitViewRef.current(), 0); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!fitOnce.current && p.screens.length) { fitOnce.current = true; setTimeout(() => fitViewRef.current(), 0); } }, [p.screens.length]);

  // 聚焦：镜头推到该屏 1:1 居中；清空选区（M0 实证）
  const focusCard = useCallback((id: string) => {
    const s = byId[id]; const node = viewportRef.current;
    if (!s || !node || !s.previewUrl) return;
    const q = pos(s);
    const a = safeArea();
    // 聚焦要保住 1:1（REQ-CORE-005，也是 iframe 内点击坐标不偏的前提）：横向让开左右浮层，
    // 纵向只让开顶栏——底部输入框是浮层，让它压住屏底也不能把整屏缩小。
    const fh = node.clientHeight - a.y;
    const zoom = Math.min(1, (a.w - 40) / s.width, (fh - 80) / s.height);
    // 纵向落点按安全区（已让开底部输入框）居中；屏比安全区高时顶到安全区上沿，
    // 把不可避免的遮挡全部留在屏底——那里是可滚动内容，主操作按钮在它上方。
    // 居中到 fh 会把屏往下推，正好把底部 CTA 塞进输入框底下点不到（RUN-045 TC-PROTO-001 实证）。
    const top = Math.max(0, (a.h - s.height * zoom) / 2);
    window.getSelection()?.removeAllRanges();
    setIframeReady(false);
    setFocusedSrc(s.previewUrl);
    p.onFocus(id);
    p.setNavStack(() => []);
    setTimeout(() => panZoom.current?.setViewport({ x: a.x + (a.w - s.width * zoom) / 2 - q.x * zoom, y: a.y + top - q.y * zoom, zoom }, { duration: 250 }), 0);
  }, [byId, pos, p, safeArea]);

  focusCardRef.current = focusCard;

  const swapTo = useCallback(async (target: ScreenDto, push: boolean) => {
    if (!target.previewUrl) return;
    const html = await fetch(target.previewUrl).then((r) => r.text());
    const msg: ParentToPreview = { type: 'quilt:swap', html, route: target.route };
    iframeRef.current?.contentWindow?.postMessage(msg, p.previewOrigin);
    p.setNavStack((s) => (push ? [...s, target.route] : s.slice(0, -1)));
  }, [p]);

  const goBack = useCallback(() => {
    if (!focused || p.navStack.length === 0) return;
    const prev = p.navStack.length >= 2 ? p.navStack[p.navStack.length - 2] : focused.route;
    const t = p.screens.find((s) => s.route === prev);
    if (t) swapTo(t, false);
  }, [focused, p.navStack, p.screens, swapTo]);

  const postToPreview = useCallback((msg: ParentToPreview) => { iframeRef.current?.contentWindow?.postMessage(msg, propsRef.current.previewOrigin); }, []);
  const highlight = useCallback((qid: string | null) => postToPreview({ type: 'quilt:highlight', qid }), [postToPreview]);
  // 回到这张卡片自己的屏：重挂 iframe（src 不变时 React 不会重新加载，只能靠换 key）并清空导航栈
  // 清空后由下面的 effect 用「当前这一轮的 props」重新钉住——这里直接读 propsRef 会拿到上一轮的
  // previewUrl（调用方常常是 await refresh() 之后紧接着调，state 还没落到下一次渲染），于是重载出旧修订
  const resetToOwn = useCallback(() => { setIframeReady(false); setFocusedSrc(null); setReloadKey((k) => k + 1); propsRef.current.setNavStack(() => []); }, []);
  // 工具栏 / ⌥G 走这里：把可见区中心当作锚点落点，等价于在那里双击
  const createAtCenter = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const safe = propsRef.current.safeAreaRef?.current?.getBoundingClientRect() ?? nr;
    const cx = safe.left + safe.width / 2; const cy = safe.top + safe.height / 2;
    const v = vp.current;
    propsRef.current.onAnchor?.({ x: Math.round((cx - nr.left - v.x) / v.zoom), y: Math.round((cy - nr.top - v.y) / v.zoom) });
  }, []);

  // 选择元素模式随 props 与 iframe 就绪同步到运行时
  useEffect(() => { if (iframeReady) postToPreview({ type: 'quilt:mode', mode: p.inspectMode ? 'inspect' : 'interact' }); }, [p.inspectMode, iframeReady, postToPreview]);

  // 聚焦态热更新（REQ-CORE-005 v0.33）：src 钉住后新修订不会自己进来，由这里显式送——iframe 里正显示的那一屏
  //（导航栈顶，没跳转过就是卡片自己）换了 currentRevisionId，就取新 HTML swap 进同一个文档：不重挂、不丢导航栈，
  // 模式与滚动位置由运行时保住。基线按「屏 id + 修订 id」记：跳转换屏只更新基线不 swap，同屏换修订才 swap。
  // previewUrl 是签名 URL、每次 refresh 都换，所以不进依赖，只在真要 swap 时从 ref 读当前值。
  const shownRoute = p.navStack.length ? p.navStack[p.navStack.length - 1] : focused?.route;
  const shown = shownRoute ? p.screens.find((s) => s.route === shownRoute) : undefined;
  const shownId = shown?.id ?? null; const shownRev = shown?.currentRevisionId ?? null;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const baseline = useRef<{ id: string; rev: string | null } | null>(null);
  // 热更新换完 DOM（quilt:swapped，或整份重写后的 quilt:ready）再按这个 qid 重选；跳转的 swap 不重选——同一 qid 在别的屏上是另一个元素
  const pendingReselect = useRef<string | null>(null);
  useEffect(() => {
    if (!p.focusedId || !iframeReady || !shownId) { baseline.current = null; return; }
    const base = baseline.current;
    baseline.current = { id: shownId, rev: shownRev };
    const cur = shownRef.current;
    if (!base || base.id !== shownId || base.rev === shownRev || !cur?.previewUrl) return;
    let stale = false;
    fetch(cur.previewUrl).then((r) => r.text()).then((html) => { if (!stale) { pendingReselect.current = propsRef.current.selectedQid; postToPreview({ type: 'quilt:swap', html, route: cur.route, keepScroll: true }); } }).catch(() => {});
    return () => { stale = true; };
  }, [p.focusedId, iframeReady, shownId, shownRev, postToPreview]);
  // 屏内标记：正显示的屏上有哪些 qid 在被改。作业结束 qid 离开集合 → 记为待「已更新」，等紧随其后的热更新换完 DOM 再打上；
  // 1.5 s 内没等到热更新（失败 / 取消）就作罢，只把「修改中」撤掉
  const workingQids = useMemo(() => p.workingSubtrees.filter((w) => w.screenId === shownId).map((w) => w.qid), [p.workingSubtrees, shownId]);
  const workingKey = workingQids.join(',');
  const workingRef = useRef(workingQids);
  workingRef.current = workingQids;
  const prevWorking = useRef<string[]>([]);
  const pendingDone = useRef<string[]>([]);
  useEffect(() => {
    if (!iframeReady) { prevWorking.current = []; return; }
    const left = prevWorking.current.filter((q) => !workingQids.includes(q));
    prevWorking.current = workingQids;
    // 作业一收口就打「已更新」（作业先出屏后收口时 DOM 早换过了，此刻不打就没机会）；同时留一份给紧随其后的热更新换完 DOM 再补
    if (left.length) pendingDone.current = [...new Set([...pendingDone.current, ...left])];
    postToPreview({ type: 'quilt:mark', working: workingQids, done: left });
    const t = setTimeout(() => { pendingDone.current = []; }, 1500);
    return () => clearTimeout(t);
  }, [workingKey, iframeReady, postToPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  // 直改保存后：父页知道改的是哪个 qid，热更新换完 DOM 给它打「已更新」（没等到热更新就算了）
  const markDone = useCallback((qids: string[]) => {
    pendingDone.current = [...new Set([...pendingDone.current, ...qids])];
    setTimeout(() => { pendingDone.current = pendingDone.current.filter((q) => !qids.includes(q)); }, 3000);
  }, []);
  const reselectAfterSwap = useCallback(() => {
    const qid = pendingReselect.current;
    pendingReselect.current = null;
    if (qid) postToPreview({ type: 'quilt:reselect', qid });
    const done = pendingDone.current;
    pendingDone.current = [];
    postToPreview({ type: 'quilt:mark', working: workingRef.current, done });
  }, [postToPreview]);
  // 对外 API 在 markDone / reselectAfterSwap 之后注册：它们是 useCallback，声明前引用会撞 TDZ
  useEffect(() => { propsRef.current.registerApi?.({ fitView, goBack, highlight, focus: focusCard, resetToOwn, createAtCenter, markDone }); }, [fitView, goBack, highlight, focusCard, resetToOwn, createAtCenter, markDone]);

  // 收起展开层：复用角标那条 toggle——同一屏再调一次 onCandidates 就是收起（REQ-CORE-015）
  const collapseCandidates = useCallback(() => {
    const { candidateStack, screens, onCandidates } = propsRef.current;
    const s = candidateStack && screens.find((x) => x.id === candidateStack.screenId);
    if (s?.pendingCandidates) onCandidates(s.pendingCandidates.jobId, s.id);
  }, []);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // 唯一从候选格接的一条消息：焦点一进格子（格子可滚动、可填表），父页 window 的 keydown 就收不到了，
      // 不接这条 Esc 它就是死键；格子的其余消息仍由下面那道守卫拦掉
      if (p.candidateStack && e.origin === p.previewOrigin && e.source !== iframeRef.current?.contentWindow
        && isPreviewMessage(e.data) && e.data.type === 'quilt:key' && e.data.key === 'Escape') { collapseCandidates(); return; }
      // 只认聚焦 iframe 发来的：候选展开层里的活 iframe（REQ-CORE-015）也跑同一套运行时，它们的 ready / navigate / key 不能动聚焦态
      if (e.origin !== p.previewOrigin || !focused || e.source !== iframeRef.current?.contentWindow || !isPreviewMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === 'quilt:ready') { setIframeReady(true); postToPreview({ type: 'quilt:mode', mode: propsRef.current.inspectMode ? 'inspect' : 'interact' }); reselectAfterSwap(); }
      if (msg.type === 'quilt:swapped') reselectAfterSwap();
      if (msg.type === 'quilt:select') p.onElementSelect({ qid: msg.qid, tag: msg.tag, text: msg.text, classes: msg.classes, href: msg.href ?? null, rect: msg.rect });
      if (msg.type === 'quilt:deselect') p.onElementSelect(null);
      if (msg.type === 'quilt:navigate') {
        const t = p.screens.find((s) => s.route === msg.href);
        if (t) swapTo(t, true); else p.onNavigateMissing(focused.id, msg.href);
      }
      if (msg.type === 'quilt:key') {
        if (msg.key === 'Escape') p.onFocus(null);
        else if (msg.key === 'ArrowLeft' && msg.altKey) goBack();
        else if ((msg.metaKey || msg.ctrlKey) && msg.code) p.onShortcut?.(msg.code);  // ⌘E / ⌘/：键位表在 Canvas.tsx
      }
      if (msg.type === 'quilt:dead') p.onDeadLink();
      if (msg.type === 'quilt:wheel') {
        // iframe 内的捏合：换算成画布坐标后围绕指针缩放（系数同 d3-zoom 的 ctrl+wheel）
        const node = viewportRef.current; const frame = iframeRef.current;
        if (!node || !frame) return;
        const v = vp.current; const nr = node.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
        const px = fr.left - nr.left + msg.x * v.zoom; const py = fr.top - nr.top + msg.y * v.zoom;
        const zoom = Math.min(2, Math.max(0.1, v.zoom * Math.pow(2, -msg.deltaY * 0.02)));
        const k = zoom / v.zoom;
        panZoom.current?.setViewport({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [focused, p, swapTo, goBack, reselectAfterSwap, collapseCandidates]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]');
      if (e.code === 'Space' && !e.repeat && !typing) { spaceDown.current = true; setPanReady(true); updatePanZoom(); e.preventDefault(); }
      if (e.key === 'Escape') { p.onFocus(null); }
      if (e.altKey && e.key === 'ArrowLeft' && !typing) { e.preventDefault(); goBack(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceDown.current = false; setPanReady(false); updatePanZoom(); } };
    // 面板 / 顶栏上的触控板捏合会触发浏览器整页缩放（header 被顶出视口）；画布之外一律拦掉，Cmd +/- 不受影响
    const pinch = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('wheel', pinch, { passive: false });
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('wheel', pinch); };
  }, [goBack, p, updatePanZoom]);

  // 框选（MOTION-017 同一套手势纪律）：空白处按下拖出选框，与选框相交的屏即选中；
  // 没越过迟滞就当普通单击处理——清空选择。
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null);
  // 拖拽过程中就把命中的屏亮起来（松手才亮的话，用户拖到一半不知道圈住了谁）
  const [marqueeHits, setMarqueeHits] = useState<string[]>([]);
  const hitSet = new Set(marqueeHits);
  const onViewportPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || spaceDown.current) return;
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const x0 = e.clientX - nr.left; const y0 = e.clientY - nr.top;
    let moved = false;
    const hitsIn = (x1: number, y1: number) => {
      const v = vp.current;
      const toWorld = (sx: number, sy: number) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });
      const a = toWorld(Math.min(x0, x1), Math.min(y0, y1));
      const b = toWorld(Math.max(x0, x1), Math.max(y0, y1));
      return propsRef.current.screens.filter((s) => {
        const q = dragPos[s.id] ?? { x: s.x, y: s.y };
        return q.x < b.x && a.x < q.x + s.width && q.y < b.y && a.y < q.y + s.height;
      }).map((s) => s.id);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.buttons === 0) { finish(ev); return; }
      const x1 = ev.clientX - nr.left; const y1 = ev.clientY - nr.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 10) return;
      moved = true;
      setMarquee({ x0, y0, x1, y1, additive });
      const hit = hitsIn(x1, y1);
      setMarqueeHits((prev) => (prev.length === hit.length && hit.every((id, i) => prev[i] === id) ? prev : hit));
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      setMarquee(null); setMarqueeHits([]);
      if (!moved) { propsRef.current.onSelect(null); return; }
      propsRef.current.onSelectMany(hitsIn(ev.clientX - nr.left, ev.clientY - nr.top), additive);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };

  // 双击空白处 = 在这里放锚点（REQ-CORE-014），描述在底部输入框里填。卡片自己的双击（进屏）在 .gesture 上已 stopPropagation，
  // 这里再按目标兜一层：风格指南卡、批注钉、断链角标、候选角标、锚点自己都不算空白。聚焦态里 iframe 吃掉了双击，不会到这。
  const onViewportDoubleClick = (e: ReactMouseEvent) => {
    if (!propsRef.current.onAnchor || propsRef.current.focusedId) return;
    if ((e.target as HTMLElement).closest('.card, .styleguide, .anno-pin, .warn, .cand-badge, .anchor')) return;
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const v = vp.current;
    propsRef.current.onAnchor({ x: Math.round((e.clientX - nr.left - v.x) / v.zoom), y: Math.round((e.clientY - nr.top - v.y) / v.zoom) });
  };

  // 卡片拖拽（MOTION-017/028）：Pointer capture、10px 迟滞、buttons===0 兜底、松手才持久化（INT-019）
  const onCardPointerDown = (e: ReactPointerEvent, s: ScreenDto) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    p.onSelect(s.id, e.shiftKey || e.metaKey || e.ctrlKey);
    const start = { x: e.clientX, y: e.clientY };
    const origin = pos(s);
    let moved = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.buttons === 0) { finish(ev); return; }
      const dx = ev.clientX - start.x; const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 10) return;
      moved = true;
      const z = vp.current.zoom;
      setDragPos((m) => ({ ...m, [s.id]: { x: Math.round(origin.x + dx / z), y: Math.round(origin.y + dy / z) } }));
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', finish); el.removeEventListener('pointercancel', finish);
      if (moved) {
        setDragPos((m) => { const q = m[s.id]; if (q) p.onMove(s.id, q.x, q.y); const { [s.id]: _drop, ...rest } = m; void _drop; return rest; });
      } else if (propsRef.current.armed && !propsRef.current.focusedId) {
        focusCardRef.current(s.id);  // 模式已开：单击哪一屏就进哪一屏
      }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', finish); el.addEventListener('pointercancel', finish);
  };

  return (
    <div ref={viewportRef} className={`viewport${panReady ? ' pan-ready' : ''}${dragging ? ' dragging' : ''}${p.armed && !p.focusedId ? ' armed' : ''}`} onPointerDown={onViewportPointerDown} onDoubleClick={onViewportDoubleClick} data-testid="canvas">
      <div ref={worldRef} className="world">
        {p.showLinks && edges.length > 0 && (
          <svg className="edges" width={1} height={1} aria-hidden="true" data-testid="link-edges">
            <defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {edges.map((e) => {
              const from = byId[e.from]; const to = byId[e.to];
              if (!from || !to) return null;
              const reverse = edges.some((r) => r.from === e.to && r.to === e.from);
              const { d, mx, my } = edgePath(from, to, reverse ? (e.from < e.to ? -36 : 36) : 0);
              return (
                <g key={`${e.from}>${e.to}`} data-testid="link-edge" data-count={e.count}>
                  <path d={d} markerEnd="url(#edge-arrow)" />
                  <rect x={mx - 14} y={my - 11} width={28} height={22} rx={11} />
                  <text x={mx} y={my + 4} textAnchor="middle">{e.count}</text>
                </g>
              );
            })}
          </svg>
        )}
        <div className={`styleguide nopan${p.styleGuideSelected ? ' selected' : ''}`} style={{ transform: `translate(${STYLE_GUIDE_POS.x}px, ${STYLE_GUIDE_POS.y}px)` }} onPointerDown={(e) => { e.stopPropagation(); p.onSelectStyleGuide(); }} role="button" tabIndex={0} aria-label="风格指南">
          <StyleGuideCard tokens={p.tokens} name={p.projectName} palette={p.palette} colorMode={p.colorMode} assets={p.assets} />
        </div>
        {/* 锚点（REQ-CORE-014）：新屏落点的幽灵框，尺寸 = 设备形态；只是标记，不可拖不可点 */}
        {p.anchor && (
          <div className="anchor" data-testid="anchor" aria-hidden="true" style={{ width: p.screenSize.w, height: p.screenSize.h, transform: `translate(${p.anchor.x - p.screenSize.w / 2}px, ${p.anchor.y - p.screenSize.h / 2}px)` }}>
            <span className="anchor-label">新屏落点 · 在下方输入框描述它</span>
          </div>
        )}
        {p.screens.map((s, idx) => {
          const q = pos(s);
          const isFocused = p.focusedId === s.id;
          const dangling = danglingBySource.get(s.id);
          const working = p.workingSubtrees.some((w) => w.screenId === s.id);
          const desktop = s.width > 600;
          // 有候选未采用的卡片：后面叠两张错位底板示意「还有几版」；展开时底板让位给展开层
          const stacked = !!s.pendingCandidates && !isFocused && p.candidateStack?.screenId !== s.id;
          return (
            <Fragment key={s.id}>
            {stacked && [2, 1].map((k) => <div key={k} className="cand-ghost" aria-hidden="true" style={{ width: s.width, height: s.height, transform: `translate(${q.x + 14 * k}px, ${q.y + 10 * k}px)`, opacity: 1 - 0.25 * k }} />)}
            <div data-testid="screen-card" data-route={s.route} className={`card${(marquee ? hitSet.has(s.id) || (marquee.additive && selectedSet.has(s.id)) : selectedSet.has(s.id)) ? ' selected' : ''}${isFocused ? ' focused' : ''}${dragPos[s.id] ? ' dragging' : ''}`} style={{ width: s.width, height: s.height, transform: `translate(${q.x}px, ${q.y}px)` }}>
              <div className="label"><b>{s.name}</b> {s.route}{p.exemplarScreenId === s.id ? ' · 样板' : ''}{s.deviations ? ` · ${s.deviations} 处偏离` : ''}</div>
              {isFocused && s.previewUrl ? (
                <iframe key={reloadKey} ref={iframeRef} className="nowheel nopan" src={focusedSrc ?? s.previewUrl} title={s.name} sandbox="allow-scripts allow-same-origin allow-forms" />
              ) : s.screenshotUrl ? (
                <img src={s.screenshotUrl} width={s.width} height={s.height} loading="lazy" decoding="async" alt={s.name} draggable={false} />
              ) : (
                <div className={`skeleton${desktop ? ' desktop' : ''}`} style={{ animationDelay: `${(idx % 6) * -230}ms` }} role="img" aria-label={s.currentRevisionId ? '截图生成中' : '生成中'}>
                  {desktop ? (
                    <><div className="sk sk-side" /><div className="sk sk-topbar" /><div className="sk sk-title" /><div className="sk sk-grid"><i /><i /><i /></div><div className="sk sk-table" /></>
                  ) : (
                    <><div className="sk sk-appbar" /><div className="sk sk-hero" /><div className="sk sk-line" /><div className="sk sk-line short" /><div className="sk sk-card" /><div className="sk sk-card" /><div className="sk sk-cta" /><div className="sk sk-tabbar"><i /><i /><i /><i /></div></>
                  )}
                  <div className="sk-sweep" />
                  <div className="sk-label"><span className="sk-dot" />{s.currentRevisionId ? '截图中' : '生成中'}</div>
                </div>
              )}
              {/* 同一张卡同时有未结清候选时错开一行：两者右上同位、同底色同尺寸，叠在一起会把角标整块盖住 */}
              {!isFocused && working && <span className={`working${s.pendingCandidates ? ' below' : ''}`} data-testid="card-working">局部修改中…</span>}
              {!isFocused && <div className="gesture nopan" onPointerDown={(ev) => onCardPointerDown(ev, s)} onDoubleClick={(ev) => { ev.stopPropagation(); focusCard(s.id); }} />}
              {isFocused && <div className="badge">{!iframeReady ? '加载中' : p.annotateMode ? '批注中' : p.inspectMode ? '选择元素中' : '交互中'} · {p.navStack.length ? p.navStack[p.navStack.length - 1] : s.route}{iframeReady ? (p.inspectMode ? ' · 点屏里的元素' : ` · 选元素按 ${INSPECT_KEY}`) : ''}</div>}
              {annoByScreen.get(s.id)?.map((a, i) => {
                const clamped = a.rect.y + a.rect.h / 2 > s.height - 12;
                return (
                  <button
                    key={a.id} type="button" className={`anno-pin nopan${a.status === 'sent' ? ' sending' : ''}`}
                    style={{ left: Math.min(Math.max(a.rect.x + a.rect.w, 12), s.width - 12), top: clamped ? s.height - 16 : a.rect.y + a.rect.h / 2 }}
                    title={clamped ? `${a.note}（元素在折叠区域内）` : a.note}
                    data-testid="anno-pin" data-anno={a.id}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => { ev.stopPropagation(); p.onAnnotationClick(a.id); }}
                  >{i + 1}</button>
                );
              })}
              {dangling && (
                <button type="button" className="warn nopan cursor-pointer" style={{ pointerEvents: 'auto' }} title={`点击生成：${dangling.join(', ')}`} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); p.onDanglingClick(s.id, dangling); }}>
                  断链 {dangling.length}：{dangling[0]}{dangling.length > 1 ? ' …' : ''}
                </button>
              )}
            </div>
            {/* 待采用的候选批（REQ-CORE-015）：角标就地展开 / 收起。画在卡片之外、与卡片同位的一层槽位里——
                卡片自带 transform 是独立层叠上下文，角标留在卡片里时 z-index 再高也盖不过展开层，
                「再点一次角标收起」就永远点不到（展开层第 0 格的 iframe 正压在这一角） */}
            {s.pendingCandidates && !isFocused && (
              <div className={`cand-badge-slot${p.candidateStack?.screenId === s.id ? ' expanded' : ''}`} style={{ width: s.width, transform: `translate(${q.x}px, ${q.y}px)` }}>
                <button type="button" className="cand-badge nopan" data-testid="candidate-badge" data-route={s.route} data-count={s.pendingCandidates.count} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); p.onCandidates(s.pendingCandidates!.jobId, s.id); }}>
                  {s.pendingCandidates.count} 版 · 展开
                </button>
              </div>
            )}
            </Fragment>
          );
        })}
        {/* 候选就地展开（REQ-CORE-015）：盖在卡片原位；按下不冒泡给画布，否则会当成框选 / 选卡 */}
        {p.candidateStack && byId[p.candidateStack.screenId] && (
          <div className="cand-stack nopan" style={{ transform: `translate(${pos(byId[p.candidateStack.screenId]).x}px, ${pos(byId[p.candidateStack.screenId]).y}px)` }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {p.candidateStack.node}
          </div>
        )}
      </div>
      {p.armed && !p.focusedId && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-full border border-accent/50 bg-accent/15 px-3 py-1 text-xs text-fg" data-testid="armed-hint">
          {p.armed === 'annotate' ? '批注模式：点任意一屏开始' : '选择元素模式：点任意一屏开始'}
        </div>
      )}
      {marquee && (
        <div
          className="marquee" data-testid="marquee" aria-hidden="true"
          style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
        />
      )}
    </div>
  );
}
