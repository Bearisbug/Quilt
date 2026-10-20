import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Viewport } from '@xyflow/system';
import { isPreviewMessage, type AssetDto, type ScreenDto, type LinkDto, type Tokens, type Palette, type ColorMode, type ParentToPreview, type AnnotationDto, type ComponentDto } from '@quilt/core/browser';
import { StyleGuideCard, STYLE_GUIDE_SIZE, styleGuideSize } from '@/canvas/StyleGuideCard';
import { Minimap, type MiniRect } from '@/canvas/Minimap';
import { EDGE_LIMIT, mergeEdges, shownEdges, edgeCurves, drawEdges, type Curve, type EdgeColors } from '@/canvas/edges';
import { toWorld, wantsThumb, fullShotIds, inMarquee, fitViewport, focusViewport, revealViewport, panToViewport, ensureVisibleViewport, zoomAround } from '@/canvas/geometry';
import { useViewport, WHEEL_PAN_SPEED } from '@/canvas/useViewport';
import { frameSide } from '@/lib/frameZoom';
import { useFocusedFrame } from '@/canvas/useFocusedFrame';
import { ScreenCard, ComponentCard, keepPointerFocus, type CardActions, type CardKind } from '@/canvas/cards';
import { keyAction, toSelection, type ElementSelection } from '@/canvas/frameMessages';
import { markPalette, useResolvedMode } from '@/lib/theme';
import { useLocale, useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';

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
  /** 框选：与选框相交的屏与组件一起交回（REQ-EDIT-006） */
  onSelectMany: (screenIds: string[], componentIds: string[], additive: boolean) => void;
  /** 共享组件（REQ-EDIT-006）：画布上的一等对象，活渲染、可拖、可框选、可当目标 */
  components: ComponentDto[];
  selectedComponentIds: string[];
  onSelectComponent: (id: string, additive: boolean) => void;
  onSelectStyleGuide: () => void;
  onFocus: (id: string | null) => void;
  /** 松手落库：拖动集合里的屏与组件一次交回（多选批量移动时是整组） */
  onMove: (screens: { id: string; x: number; y: number }[], components: { id: string; x: number; y: number }[]) => void;
  onNavigateMissing: (fromScreenId: string, href: string) => void;
  onDanglingClick: (screenId: string, hrefs: string[]) => void;
  onDeadLink: () => void;
  /** 焦点在预览文档里时运行时转发来的 ⌘ 组合键与 ⌥ + 字母（e.code；alt = ⌥ 组合），父页按自己的键位表处理 */
  onShortcut?: (code: string, alt?: boolean) => void;
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
  /** null = 热更新后元素已不在（被删 / 子树换了 qid），父页清空选中；component = 元素所在的共享组件名（REQ-EDIT-006） */
  onElementSelect: (sel: ElementSelection | null) => void;
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
  /** 视图位置按项目记（quilt:view:<projectId>），刷新回到原处 */
  projectId: string;
  /** 正在交互的共享组件卡（REQ-EDIT-006）：与屏的聚焦互斥，但不动镜头 */
  focusedComponentId?: string | null;
  onFocusComponent?: (id: string | null) => void;
  /** 未被浮层遮住的那块画布：适配视图与聚焦都以它为准，否则内容会被推到输入框/工具栏底下 */
  safeAreaRef?: { current: HTMLElement | null };
  registerApi?: (api: CanvasApi) => void;
  /** 小地图（REQ-CORE-024）：画在视口左上、跟着视图流重画 */
  minimap?: boolean;
  /** 聚焦的 iframe 此刻显示的是哪一屏（跳转、切变体、叠层之后都会变）：检查器、批注、子树重生成都要写到这一屏上 */
  onShown?: (screenId: string | null) => void;
  navStack: string[];
  setNavStack: (f: (s: string[]) => string[]) => void;
  /** 手里的签名可能过期了（v0.76）：静默重取项目详情，返回新详情（取不到为 null）；聚焦 iframe 等不到就绪、屏内取页失败时用 */
  onStale?: () => Promise<{ screens: ScreenDto[] } | null>;
  /** 卡片截图加载失败（多半是签名过期）：父页节流后静默重取 */
  onShotError?: () => void;
  /** 屏内跳转 / 切变体 / 后退重摆 / 热更新取不到目标屏（重取签名后仍失败）：父页 toast 说明 */
  onPreviewError?: (screen: ScreenDto) => void;
};

// 画布对外 API（Canvas.tsx 经 registerApi 取）：reveal 把一张卡摆到可用区中央（找屏 / 屏列表用）
export type CanvasApi = {
  /** false = 缩到下限 MIN_ZOOM 仍装不下全部 */
  fitView: () => boolean; goBack: () => void; highlight: (qid: string | null) => void; focus: (id: string) => void; resetToOwn: () => void; createAtCenter: () => void; markDone: (qids: string[]) => void;
  /** 键盘进入交互（屏或组件卡，v0.80）：就绪后焦点移进 iframe，退出后焦点回到这张卡 */
  enter: (id: string) => void;
  /** 逐级选（v1.00）：发给此刻处于选择元素态的那个 iframe——Shift+Enter / Enter、祖先路径的点选与悬停预览 */
  climb: (dir: 'up' | 'down') => void; pick: (qid: string) => void; peek: (qid: string | null) => void;
  reveal: (id: string) => void;
};


const STYLE_GUIDE_POS = { x: -(STYLE_GUIDE_SIZE.w + 80), y: 0 };
// 组件卡尺寸没记过时的紧凑占位高度（v0.76）：按设备整屏占位的话，每次加载都是一块 844 高的白板
const COMP_PLACEHOLDER_H = 64;
// 组件卡量到的框按项目记在本机（quilt:comp-size:<projectId>，v0.76）：刷新、切项目回来首帧就是真实尺寸，不会从占位跳到终值。
// 框是根元素在设备整屏视口里的位置与尺寸：卡片取 w×h，iframe 平移 (−x, −y) 让根元素对齐卡片左上角
type CompBox = { x: number; y: number; w: number; h: number };
function readCompSizes(key: string): Record<string, CompBox> {
  try {
    const m = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, CompBox>;
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && v.w > 0 && v.h > 0));
  } catch { return {}; }
}
const omit = <T,>(m: Record<string, T>, ids: string[]) => { const rest = { ...m }; for (const id of ids) delete rest[id]; return rest; };
const dpr = () => window.devicePixelRatio || 1;
// 聚焦屏的 iframe 不跟着世界层的缩放变换走：包它的那层（.frame-box）按镜头倍率 zoom、再 scale(1/倍率) 抵消，iframe 上的总变换是 1:1，看上去大小不变。
// Chromium 在带缩放变换的跨域 iframe 里用 GPU 合成时，会把同时带 backdrop-filter 与 box-shadow 的元素画错——一片灰色渐变盖住邻近的内容
// （2026-10-20 有头 Edge 实测，无头复现不出）；zoom 让 iframe 按目标倍率原生绘制，里面仍按设备宽度排版。
// zoom 不放大百分比宽高，所以外层宽高写成卡片的像素，并取到刚好不少于它的整设备像素（frameSide）
function unscaleFrame(el: HTMLElement | null, zoom: number) {
  const box = el?.parentElement;
  if (!el || !box || !(zoom > 0)) return;
  const want = { zoom: String(zoom), width: `${frameSide(box.offsetWidth, zoom)}px`, height: `${frameSide(box.offsetHeight, zoom)}px`, transform: `scale(${1 / zoom})` };
  if (el.style.zoom === want.zoom && el.style.width === want.width && el.style.height === want.height) return;
  Object.assign(el.style, want, { transformOrigin: '0 0' });
}

// 引用不变的方法表：每个方法转调最近一次渲染给的实现。卡片是 memo 的，动作表一换引用就整片画布重渲染
function useStableActions<T extends Record<string, (...args: any[]) => any>>(impl: T): T {
  const ref = useRef(impl);
  ref.current = impl;
  const [stable] = useState(() => Object.fromEntries(Object.keys(impl).map((k) => [k, (...a: unknown[]) => (ref.current[k] as (...x: any[]) => any)(...a)])) as T);
  return stable;
}

// 无限画布（ADR-002 / ADR-006）：截图卡片 + 单聚焦活 iframe；世界层 transform 由 @xyflow/system 驱动（镜头见 useViewport，
// 聚焦屏的 iframe 见 useFocusedFrame，卡片见 cards.tsx，几何见 geometry.ts）
export function CanvasView(p: CanvasProps) {
  const tr = useT(canvasMessages);
  // 父组件每次渲染都会传入新的回调；XYPanZoom 实例与 transform 回调必须稳定，否则实例被反复重建、transition 被打断
  const propsRef = useRef(p);
  propsRef.current = p;
  // 候选展开层的操作胶囊按 1/zoom 反向缩放，--zoom 只写在它那一层：写在世界层上的话每帧都让全部卡片重算样式（100 屏时缩放掉帧）
  const candRef = useRef<HTMLDivElement | null>(null);
  const view = useViewport({
    projectId: p.projectId, safeAreaRef: p.safeAreaRef,
    onFrame: (v) => {
      candRef.current?.style.setProperty('--zoom', String(v.zoom));
      paintEdges();
      if (fullRef.current.size && wantsThumb(v.zoom, dpr())) settleShots(v);
    },
    onStop: (v) => { settleShots(v); unscaleFrame(frameBoxRef.current, v.zoom); },
  });
  const { viewportRef, worldRef, vp, spaceDown, panReady, moveTo, safeArea, onView, isMoving, touched, autoMove, placeFirstFrame, savedView } = view;
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  // 共享组件卡（REQ-EDIT-006）：拖动中的位置与量到的框。框由预览页量根元素后上报（quilt:component-size），量到即记进本机；
  // 首帧用记住的框，没记过的用紧凑占位（v0.76）。iframe 始终按整个设备尺寸渲染、由卡片裁切：h-dvh、h-[50vh]、w-1/2 这类
  // 按视口或父宽定尺寸的组件只有在整屏视口里量才准；视口跟着卡片缩的话，它们每上报一次再缩一截，一路缩到下限
  const [compDrag, setCompDrag] = useState<Record<string, { x: number; y: number }>>({});
  const compKey = `quilt:comp-size:${p.projectId}`;
  const [compSize, setCompSize] = useState<Record<string, CompBox>>(() => readCompSizes(compKey));
  // 本次挂载里已上报过尺寸的组件：上报前卡片里是骨架、iframe 透明（样式还没到齐，画出来是白底或没排版的字）
  const [compLive, setCompLive] = useState<ReadonlySet<string>>(() => new Set());
  // 卡片在不在视口里（v0.83）：骨架的呼吸与扫光只在进了视口的卡片上跑（styles.css 按 data-onscreen 暂停）。
  // 直接改 DOM 属性、不进 state：平移时卡片进出视口很频繁，进 state 就是每次整块画布重渲染
  const onscreenIo = useRef<IntersectionObserver | null>(null);
  const watchOnscreen = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    onscreenIo.current ??= new IntersectionObserver((entries) => { for (const e of entries) e.target.toggleAttribute('data-onscreen', e.isIntersecting); });
    const io = onscreenIo.current;
    io.observe(el);
    return () => io.unobserve(el);
  }, []);
  useEffect(() => () => onscreenIo.current?.disconnect(), []);
  // 截图重试到头仍取不到、又没有旧图可退的卡（v0.83）：卡上给「截图没取到 · 重试」；点一下把那张卡的重试从头再来
  const [shotFailed, setShotFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [shotRetry, setShotRetry] = useState<Record<string, number>>({});
  const markShot = useCallback((id: string, failed: boolean) => setShotFailed((s) => {
    if (s.has(id) === failed) return s;
    const next = new Set(s);
    if (failed) next.add(id); else next.delete(id);
    return next;
  }), []);
  // 首帧按占位算了适配（有组件没记过尺寸）：尺寸到齐后补一次
  const measureFit = useRef(!savedView && p.components.some((c) => !compSize[c.id]));
  const compFrames = useRef(new Map<string, HTMLIFrameElement>());

  const pos = useCallback((s: ScreenDto) => dragPos[s.id] ?? { x: s.x, y: s.y }, [dragPos]);
  const compPos = useCallback((c: ComponentDto) => compDrag[c.id] ?? { x: c.x, y: c.y }, [compDrag]);
  // 卡片此刻画出来的尺寸：适配视图、小地图、框选、找屏跳转都按它算——没上报时按设备整屏算的话，框到的是一张 844 高的卡。
  // 只给宽高：调用处与卡片位置展开在一起，框里的 x / y 是根元素在 iframe 里的偏移，混进去就把卡片位置盖掉了
  const compBox = useCallback((c: ComponentDto) => { const b = compSize[c.id]; return b ? { w: b.w, h: b.h } : { w: p.screenSize.w, h: COMP_PLACEHOLDER_H }; }, [compSize, p.screenSize.w]);
  // 量到的框落盘：只留当前还在的组件
  useEffect(() => {
    const ids = new Set(p.components.map((c) => c.id));
    try { localStorage.setItem(compKey, JSON.stringify(Object.fromEntries(Object.entries(compSize).filter(([id]) => ids.has(id))))); } catch { /* 无痕模式写不了 */ }
  }, [compSize, p.components, compKey]);
  const byId = useMemo(() => Object.fromEntries(p.screens.map((s) => [s.id, s])), [p.screens]);
  const frame = useFocusedFrame(p, propsRef, byId);
  const { iframeRef, iframeReady, goBack, beginFocus } = frame;
  // iframe 挂上（聚焦、重载、退出后留着的那一张）时按此刻的倍率摆一次，镜头停下时 onStop 再摆
  const frameBoxRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => unscaleFrame(frameBoxRef.current, vp.current.zoom));
  const selectedCompSet = useMemo(() => new Set(p.selectedComponentIds), [p.selectedComponentIds]);
  const selectedSet = useMemo(() => new Set(p.selectedIds), [p.selectedIds]);
  // 每个默认屏有几个变体（v0.62）：卡片标签用
  const variantCount = useMemo(() => { const m = new Map<string, number>(); for (const s of p.screens) if (s.variantOf) m.set(s.variantOf, (m.get(s.variantOf) ?? 0) + 1); return m; }, [p.screens]);
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
  // 页面地图连线（REQ-PROTO-002）：画在视口 canvas 上（v1.02 ADR-029，见 edges.ts）；超过 EDGE_LIMIT 条只画选中屏与聚焦屏进出的
  const edges = useMemo(() => mergeEdges(p.links), [p.links]);
  const edgeSel = useMemo(() => new Set([...p.selectedIds, ...(p.focusedId ? [p.focusedId] : [])]), [p.selectedIds, p.focusedId]);
  const edgeShown = useMemo(() => shownEdges(edges, edgeSel), [edges, edgeSel]);
  const edgeCurveList = useMemo(() => edgeCurves(edgeShown, edges, (id) => { const s = byId[id]; return s && { ...pos(s), w: s.width, h: s.height }; }), [edgeShown, edges, byId, pos]);
  const edgeCanvas = useRef<HTMLCanvasElement | null>(null);
  const edgeDraw = useRef<{ curves: Curve[]; colors: EdgeColors | null; frame: number }>({ curves: [], colors: null, frame: 0 });
  // 按当前镜头重画：平移缩放每次变换都会调到，同一帧里只画一次
  const paintEdges = useCallback(() => {
    const d = edgeDraw.current;
    if (d.frame || !edgeCanvas.current) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      const c = edgeCanvas.current; const node = viewportRef.current;
      if (!c || !node) return;
      const ratio = dpr(); const w = node.clientWidth; const h = node.clientHeight;
      if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(h * ratio); }
      if (!d.colors) {
        const cs = getComputedStyle(c); const line = cs.getPropertyValue('--semantic-color-mark-line').trim();
        d.colors = { line, badge: line, badgeText: cs.getPropertyValue('--semantic-color-mark-on-line').trim(), font: cs.fontFamily };
      }
      const g = c.getContext('2d');
      if (g) drawEdges(g, d.curves, vp.current, { w, h }, ratio, d.colors);
    });
  }, [viewportRef, vp]);
  const edgeCanvasRef = useCallback((el: HTMLCanvasElement | null) => { edgeCanvas.current = el; edgeDraw.current.colors = null; if (el) paintEdges(); }, [paintEdges]);
  useEffect(() => { edgeDraw.current.curves = edgeCurveList; paintEdges(); }, [edgeCurveList, paintEdges]);
  // 连线颜色是 CSS 变量的快照：换外观后丢掉重读（VIS-010）；徽标字体随 <html lang> 的字阶覆盖变，换界面语言同样重读
  const themeMode = useResolvedMode();
  const locale = useLocale();
  useEffect(() => { edgeDraw.current.colors = null; paintEdges(); }, [themeMode, locale, paintEdges]);
  useEffect(() => {
    const node = viewportRef.current;
    const d = edgeDraw.current;
    if (!node) return;
    const ro = new ResizeObserver(() => paintEdges());
    ro.observe(node);
    return () => { ro.disconnect(); cancelAnimationFrame(d.frame); d.frame = 0; };
  }, [paintEdges, viewportRef]);
  // 卡片截图的档位（v1.02 ADR-029）：哪些卡用原图（geometry.ts 的 fullShotIds）。不靠懒加载：它按视口外一两屏的边距预取，
  // 取到的原图又被接班时的 decode() 当场解码。升到原图只在首帧与手势停下时判；缩小越过门槛当帧就全部降回缩略图，否则缩小途中进视口的卡都去取原图
  const [fullIds, setFullIds] = useState<ReadonlySet<string>>(() => new Set());
  const fullRef = useRef(fullIds);
  fullRef.current = fullIds;
  const settleShots = useCallback((v: Viewport) => {
    const node = viewportRef.current;
    const next = node ? fullShotIds(propsRef.current.screens, v, { w: node.clientWidth, h: node.clientHeight }, dpr()) : new Set<string>();
    const cur = fullRef.current;
    if (next.size !== cur.size || [...next].some((id) => !cur.has(id))) setFullIds(next);
  }, [viewportRef]);
  const shotOf = (s: ScreenDto) => (!fullIds.has(s.id) && s.thumbUrl) || s.screenshotUrl;
  // 镜头没动、屏变了（新屏落在视口里、屏被挪开）：按此刻的镜头再判一次
  useEffect(() => { if (!isMoving()) settleShots(vp.current); }, [p.screens, settleShots, isMoving, vp]);

  // 装下全部屏、组件与风格指南卡的镜头；fits = 缩到 MIN_ZOOM 装不装得下
  const fitTarget = useCallback((): { v: Viewport; fits: boolean } | null => {
    if (!viewportRef.current) return null;
    const rects = [...p.screens.map((s) => ({ ...pos(s), w: s.width, h: s.height })), ...p.components.map((c) => ({ ...compPos(c), ...compBox(c) })), { ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) }];
    return fitViewport(rects, safeArea());
  }, [p.screens, p.components, p.assets?.length, pos, compPos, compBox, safeArea, viewportRef]);
  const fitView = useCallback(() => {
    const t = fitTarget();
    if (t) moveTo(t.v, { duration: 300 });
    return t?.fits ?? true;
  }, [fitTarget, moveTo]);
  // 自动适配：变换照常施加，只是不落盘；用户手势打断时撤标记（useViewport）
  const autoFit = (ms: number) => { const t = fitTarget(); if (t) autoMove(t.v, ms); };

  const focusCardRef = useRef<(id: string) => void>(() => {});
  const autoFitRef = useRef(autoFit);
  autoFitRef.current = autoFit;
  const fitOnce = useRef(false);
  // 三次一次性适配，都不落盘（v0.76）：
  // ① 没存过镜头时首帧就是适配视图：布局阶段同步算好写进世界层，panzoom 随后以它为初值建起来（等 panzoom 建好再适配的话，会先画一帧默认镜头再滑 300 ms）。
  //    空项目也要做，否则风格指南卡片停在世界坐标负半轴、被挤出视口左缘够不着；挂载时已有的屏算进了这一次。
  // ② 空项目的首批屏到达后再适配一次（带动画，内容是那一刻才出现的；延后一 tick：同 tick 内的 setViewport 会被 d3-zoom 初始化打断，M0 实证）。
  // ③ 首帧按占位算的组件尺寸都量到了，补一次不带动画的适配。
  // **存过镜头、或这次打开后动过镜头就一次都不做**：那等于当着用户的面把镜头从他摆好的位置推走。
  // 想重新适配有工具栏的「适配视图」（F）——那是 INT-019 要求的重置入口。
  useLayoutEffect(() => {
    if (savedView) { settleShots(vp.current); return; }
    const t = fitTarget();
    if (!t) return;
    placeFirstFrame(t.v);
    settleShots(t.v);
    if (p.screens.length) fitOnce.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (touched.current || fitOnce.current || !p.screens.length) return; fitOnce.current = true; setTimeout(() => autoFitRef.current(300), 0); }, [p.screens.length, touched]);
  useEffect(() => {
    if (!measureFit.current) return;
    if (touched.current) { measureFit.current = false; return; }
    if (!p.components.every((c) => compLive.has(c.id))) return;
    measureFit.current = false;
    autoFitRef.current(0);
  }, [compLive, p.components, touched]);

  // 聚焦：镜头推到该屏 1:1 居中（geometry.ts 的 focusViewport）；清空选区（M0 实证）
  const focusCard = useCallback((id: string) => {
    const s = byId[id]; const node = viewportRef.current;
    if (!s || !node || !s.previewUrl) return;
    const v = focusViewport({ ...pos(s), w: s.width, h: s.height }, safeArea(), node.clientHeight);
    window.getSelection()?.removeAllRanges();
    beginFocus(s);
    p.onFocus(id);
    p.setNavStack(() => []);
    setTimeout(() => moveTo(v, { duration: 250 }), 0);
  }, [byId, pos, p, safeArea, moveTo, beginFocus, viewportRef]);
  focusCardRef.current = focusCard;

  // 逐级选（v1.00）：聚焦的组件卡优先（组件卡的 iframe 常驻，选择元素态就在它上面），否则聚焦的屏
  const postToInspected = useCallback((msg: ParentToPreview) => {
    const cid = propsRef.current.focusedComponentId;
    (cid ? compFrames.current.get(cid) : iframeRef.current)?.contentWindow?.postMessage(msg, propsRef.current.previewOrigin);
  }, [iframeRef]);
  const climb = useCallback((dir: 'up' | 'down') => postToInspected({ type: 'quilt:climb', dir }), [postToInspected]);
  const pick = useCallback((qid: string) => postToInspected({ type: 'quilt:pick', qid }), [postToInspected]);
  const peek = useCallback((qid: string | null) => postToInspected({ type: 'quilt:peek', qid }), [postToInspected]);
  // 工具栏 / ⌥G 走这里：把可见区中心当作锚点落点，等价于在那里双击
  const createAtCenter = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const safe = propsRef.current.safeAreaRef?.current?.getBoundingClientRect() ?? nr;
    const w = toWorld(vp.current, safe.left + safe.width / 2 - nr.left, safe.top + safe.height / 2 - nr.top);
    propsRef.current.onAnchor?.({ x: Math.round(w.x), y: Math.round(w.y) });
  }, [viewportRef, vp]);

  // 组件卡同理（v0.57）：它跑的是同一套运行时，选择元素模式要单独发给它那个 iframe。
  // 组件 HTML 落库前已重编 qid（classifyComponentHtml），所以里面的元素定位得到。
  // **离开时必须显式打回 interact**：屏退出聚焦会把 iframe 卸载、什么都不留，而组件卡的 iframe 是常驻的——
  // 不发这一条，它就停在选择元素模式，选中框与「tag · qid」标签留在卡片上、指针命中规则也还被解除着。
  const prevCompFocus = useRef<string | null>(null);
  useEffect(() => {
    const now = p.focusedComponentId ?? null;
    const prev = prevCompFocus.current;
    prevCompFocus.current = now;
    const post = (id: string, mode: 'inspect' | 'interact') =>
      compFrames.current.get(id)?.contentWindow?.postMessage({ type: 'quilt:mode', mode, marks: markPalette() } as ParentToPreview, propsRef.current.previewOrigin);
    if (prev && prev !== now) post(prev, 'interact');
    if (!now) return;
    const mode = p.inspectMode ? 'inspect' : 'interact';
    post(now, mode);
    // iframe 可能还没 ready（切模式与聚焦常在同一帧），补发一次
    const t = setTimeout(() => post(now, mode), 300);
    return () => clearTimeout(t);
  }, [p.focusedComponentId, p.inspectMode, themeMode, locale]);

  // panTo：镜头中心平移到世界坐标（缩放不变）；reveal：把一张卡（屏或组件）摆到可用区中央，缩放取「装得下」与 1:1 的较小者（REQ-CORE-024）
  const panTo = useCallback((x: number, y: number) => moveTo(panToViewport(x, y, vp.current.zoom, safeArea()), { duration: 200 }), [safeArea, moveTo, vp]);
  // 小地图拖视口框：直接设平移量（缩放不变、不带动画），拖动全程 1:1 跟手
  const moveView = useCallback((x: number, y: number) => { moveTo({ x, y, zoom: vp.current.zoom }); }, [moveTo, vp]);
  // 一张卡（屏或组件）此刻画出来的世界矩形
  const cardRect = useCallback((id: string) => {
    const s = byId[id]; const c = propsRef.current.components.find((x) => x.id === id);
    return s ? { ...pos(s), w: s.width, h: s.height } : c ? { ...compPos(c), ...compBox(c) } : null;
  }, [byId, pos, compPos, compBox]);
  const reveal = useCallback((id: string) => {
    const rect = cardRect(id);
    if (rect) moveTo(revealViewport(rect, safeArea()), { duration: 250 });
  }, [cardRect, safeArea, moveTo]);
  // 键盘把焦点移到一张卡上（v0.80）：它不完整在可用区里就把镜头中心平移过去（缩放不变）——视口只裁不滚，焦点落在视口外等于消失。
  // 键盘触发不带动画（MOTION-010）：连按方向键时上一段平移还没走完，按半路的镜头判断下一张在不在视野里会判错
  const ensureVisible = useCallback((r: { x: number; y: number; w: number; h: number }) => {
    const v = ensureVisibleViewport(r, vp.current, safeArea());
    if (v) moveTo(v);
  }, [safeArea, moveTo, vp]);
  // 键盘进入交互（v0.80）：记下是哪张卡——屏的 iframe 就绪、组件卡进了交互态就把焦点移进 iframe，退出后还给这张卡（A11Y-013）
  const kbEntered = useRef<string | null>(null);
  const kbFocusPending = useRef(false);
  const enterByKey = useCallback((id: string) => {
    const s = byId[id];
    if (s ? !s.previewUrl : !propsRef.current.components.some((c) => c.id === id)) return;
    kbEntered.current = id;
    if (s) { kbFocusPending.current = true; focusCard(id); } else propsRef.current.onFocusComponent?.(id);
  }, [byId, focusCard]);
  const gestures = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const id = kbEntered.current;
    if (!id) return;
    if (p.focusedComponentId === id) { compFrames.current.get(id)?.focus(); return; }
    if (p.focusedId === id) return;   // 屏的 iframe 就绪时再把焦点移进去（quilt:ready）
    kbEntered.current = null; kbFocusPending.current = false;
    if (p.focusedId || p.focusedComponentId) return;   // 换进了别的卡：不动焦点
    // 焦点已被放到别处（点了输入框、面板）就不抢；屏退出后 iframe 卸载或留在卡片上（inert），焦点在 body 或还挂在它上面；组件卡的 iframe 常驻，焦点还在它上面
    const a = document.activeElement;
    if (a && a !== document.body && a !== compFrames.current.get(id) && a !== iframeRef.current) return;
    requestAnimationFrame(() => gestures.current.get(id)?.focus({ preventScroll: true }));
  }, [p.focusedId, p.focusedComponentId, iframeRef]);
  const { highlight, resetToOwn, markDone } = frame;
  useEffect(() => { propsRef.current.registerApi?.({ fitView, goBack, highlight, focus: focusCard, resetToOwn, createAtCenter, markDone, reveal, enter: enterByKey, climb, pick, peek }); }, [fitView, goBack, highlight, focusCard, resetToOwn, createAtCenter, markDone, reveal, enterByKey, climb, pick, peek]);
  // 小地图的矩形：屏、组件、风格指南卡
  const miniRects = useMemo<MiniRect[]>(() => [
    ...p.screens.map((s) => ({ id: s.id, kind: 'screen' as const, ...pos(s), w: s.width, h: s.height })),
    ...p.components.map((c) => ({ id: c.id, kind: 'component' as const, ...compPos(c), ...compBox(c) })),
    { id: 'guide', kind: 'guide' as const, ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) },
  ], [p.screens, p.components, p.assets?.length, pos, compPos, compBox]);

  // 收起展开层：复用角标那条 toggle——同一屏再调一次 onCandidates 就是收起（REQ-CORE-015）
  const collapseCandidates = useCallback(() => {
    const { candidateStack, screens, onCandidates } = propsRef.current;
    const s = candidateStack && screens.find((x) => x.id === candidateStack.screenId);
    if (s?.pendingCandidates) onCandidates(s.pendingCandidates.jobId, s.id);
  }, []);

  // iframe 里转发来的滚轮（ADR-003）：捏合换算成画布坐标后围绕指针缩放（geometry.ts 的 zoomAround）；
  // pan = 组件文档里指针下没有可滚区域的普通滚轮（v0.80），按画布滚轮的速度平移
  const frameWheel = (el: HTMLIFrameElement | null | undefined, msg: { deltaY: number; deltaX?: number; x: number; y: number; pan?: boolean }) => {
    const node = viewportRef.current;
    if (!node || !el) return;
    const v = vp.current;
    if (msg.pan) { moveTo({ x: v.x - (msg.deltaX ?? 0) * WHEEL_PAN_SPEED, y: v.y - msg.deltaY * WHEEL_PAN_SPEED, zoom: v.zoom }); return; }
    const nr = node.getBoundingClientRect(); const fr = el.getBoundingClientRect();
    moveTo(zoomAround(v, fr.left - nr.left + msg.x * v.zoom, fr.top - nr.top + msg.y * v.zoom, msg.deltaY));
  };

  // iframe 发来的消息（ADR-003，形状由 previewMessageSchema 校验过）：组件预览页的尺寸、候选格的 Esc、交互态组件卡、聚焦屏。
  // 处理函数每次渲染换成新的（读这一次的 props 与状态），window 上的监听只挂一次
  const onFrameMessage = (e: MessageEvent) => {
    if (e.origin !== p.previewOrigin || !isPreviewMessage(e.data)) return;
    const m = e.data;
    // 组件预览页量完根元素就上报它的框：只认本画布里某张组件卡的 iframe 发来的（按 source 对号），钳到设备视口以内
    if (m.type === 'quilt:component-size') {
      let id: string | null = null;
      for (const [cid, el] of compFrames.current) if (el.contentWindow === e.source) { id = cid; break; }
      if (!id) return;
      const max = p.screenSize;
      const w = Math.min(max.w, Math.max(48, Math.ceil(m.w)));
      const h = Math.min(max.h, Math.max(32, Math.ceil(m.h)));
      const x = Math.min(max.w - w, Math.max(0, Math.floor(m.x)));
      const y = Math.min(max.h - h, Math.max(0, Math.floor(m.y)));
      const cid = id;
      setCompSize((s) => { const o = s[cid]; return o?.x === x && o?.y === y && o?.w === w && o?.h === h ? s : { ...s, [cid]: { x, y, w, h } }; });
      setCompLive((s) => (s.has(cid) ? s : new Set(s).add(cid)));
      return;
    }
    // 唯一从候选格接的一条消息：焦点一进格子（格子可滚动、可填表），父页 window 的 keydown 就收不到了，
    // 不接这条 Esc 它就是死键；格子的其余消息仍由下面那道守卫拦掉
    if (p.candidateStack && e.source !== iframeRef.current?.contentWindow && m.type === 'quilt:key' && m.key === 'Escape') { collapseCandidates(); return; }
    // 交互 / 选择元素态的组件卡（v0.55 / v0.57）：焦点在组件 iframe 内时父页 window 收不到键盘，
    // Esc 靠运行时转发；选中元素同样由它上报，父页据此开检查器。组件没有路由，navigate / dead
    // 一类对它没有意义（组件里的链接在运行时侧已做成惰性）
    if (p.focusedComponentId && compFrames.current.get(p.focusedComponentId)?.contentWindow === e.source) {
      // 组件版本一升，previewUrl 的 ?v= 就变、iframe 重新导航，新文档里运行时是初始的 interact——
      // 而同步模式那个 effect 的依赖（focusedComponentId / inspectMode）都没变，不会重跑。
      // 所以这里接住新文档的 ready，把当前模式补发一次；不接的话「改完一个元素就得退出重进」。
      if (m.type === 'quilt:ready') e.source?.postMessage({ type: 'quilt:mode', mode: p.inspectMode ? 'inspect' : 'interact', marks: markPalette() } as ParentToPreview, p.previewOrigin);
      // ⌘E / ⌘/ 同屏一样转发给父页的键位表：不转发的话焦点一落进组件 iframe，按 ⌘E 就是死键——
      // 模式退不掉，选中框与「tag · qid」标签留在卡片上（组件卡的 iframe 常驻，不像屏那样退出即卸载）
      if (m.type === 'quilt:key') { const a = keyAction(m, false); if (a?.kind === 'exit') p.onFocusComponent?.(null); else if (a?.kind === 'shortcut') p.onShortcut?.(a.code, a.alt); }
      // 交互态组件卡上的捏合与滚轮（v0.80）：与屏同一条 quilt:wheel，按这张卡的 iframe 换算
      if (m.type === 'quilt:wheel') frameWheel(compFrames.current.get(p.focusedComponentId), m);
      if (m.type === 'quilt:select') p.onElementSelect(toSelection(m));
      if (m.type === 'quilt:deselect') p.onElementSelect(null);
      return;
    }
    // 只认聚焦 iframe 发来的：候选展开层里的活 iframe（REQ-CORE-015）也跑同一套运行时，它们的 ready / navigate / key 不能动聚焦态
    if (!frame.focused || e.source !== iframeRef.current?.contentWindow) return;
    if (m.type === 'quilt:ready') {
      frame.markReady();
      if (kbFocusPending.current) { kbFocusPending.current = false; iframeRef.current?.focus(); }
    }
    if (m.type === 'quilt:swapped') frame.markSwapped();
    if (m.type === 'quilt:select') p.onElementSelect(toSelection(m));
    if (m.type === 'quilt:deselect') p.onElementSelect(null);
    if (m.type === 'quilt:navigate') frame.navigate(m.href);
    if (m.type === 'quilt:overlay-dismiss') goBack();
    if (m.type === 'quilt:key') {
      const a = keyAction(m, true);
      if (a?.kind === 'exit') p.onFocus(null);
      else if (a?.kind === 'back') goBack();
      else if (a) p.onShortcut?.(a.code, a.alt);   // ⌘E / ⌘/、⌥N / ⌥D……、Delete：键位表在 Canvas.tsx
    }
    if (m.type === 'quilt:dead') p.onDeadLink();
    if (m.type === 'quilt:wheel') frameWheel(iframeRef.current, m);
  };
  const frameMessage = useRef(onFrameMessage);
  frameMessage.current = onFrameMessage;
  useEffect(() => {
    const on = (e: MessageEvent) => frameMessage.current(e);
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]');
      if (e.altKey && e.key === 'ArrowLeft' && !typing) { e.preventDefault(); goBack(); }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [goBack]);

  // 卡片的键盘停靠点（v0.80，INT-002）：屏卡与组件卡在 Tab 序里只占一个停靠点（默认选中的那张，没有选中时阅读顺序第一张），
  // 方向键按阅读顺序（y 再 x）移动、Home / End 到两端；Enter 进入交互，空格选中（Shift / ⌘ 加选去选）
  const order = useMemo(() => [...p.screens.map((s) => ({ id: s.id, x: s.x, y: s.y })), ...p.components.map((c) => ({ id: c.id, x: c.x, y: c.y }))].sort((a, b) => a.y - b.y || a.x - b.x), [p.screens, p.components]);
  const [rove, setRove] = useState<string | null>(null);
  const tabStop = order.some((o) => o.id === rove) ? rove : p.selectedIds[0] ?? p.selectedComponentIds[0] ?? order[0]?.id ?? null;
  const onCardFocus = (id: string) => {
    setRove(id);
    const r = cardRect(id);
    if (r) ensureVisible(r);
  };
  const onCardKey = (e: ReactKeyboardEvent<HTMLElement>, kind: CardKind, id: string) => {
    if (e.key === ' ') {
      e.preventDefault();
      const add = e.shiftKey || e.metaKey || e.ctrlKey;
      if (kind === 'screen') p.onSelect(id, add); else p.onSelectComponent(id, add);
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); enterByKey(id); return; }
    const i = order.findIndex((o) => o.id === id);
    const to = ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: order.length - 1 } as Record<string, number | undefined>)[e.key];
    if (to === undefined || !order.length) return;
    e.preventDefault();
    gestures.current.get(order[(to + order.length) % order.length].id)?.focus({ preventScroll: true });
  };

  // 框选（MOTION-017 同一套手势纪律）：空白处按下拖出选框，与选框相交的屏即选中；
  // 没越过迟滞就当普通单击处理——清空选择。
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null);
  // 拖拽过程中就把命中的屏与组件亮起来（松手才亮的话，用户拖到一半不知道圈住了谁）
  const [marqueeHits, setMarqueeHits] = useState<{ screens: string[]; comps: string[] }>({ screens: [], comps: [] });
  const hitSet = new Set(marqueeHits.screens);
  const compHitSet = new Set(marqueeHits.comps);
  const onViewportPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || spaceDown.current) return;
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const x0 = e.clientX - nr.left; const y0 = e.clientY - nr.top;
    let moved = false;
    const hitsIn = (x1: number, y1: number) => {
      const box = { x0, y0, x1, y1 };
      const screens = inMarquee(propsRef.current.screens.map((s) => ({ id: s.id, ...pos(s), w: s.width, h: s.height })), vp.current, box);
      const comps = inMarquee(propsRef.current.components.map((c) => ({ id: c.id, ...compPos(c), ...compBox(c) })), vp.current, box);
      return { screens, comps };
    };
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((id, i) => y[i] === id);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.buttons === 0) { finish(ev); return; }
      const x1 = ev.clientX - nr.left; const y1 = ev.clientY - nr.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 10) return;
      // 拖动期间画布里的 iframe 不接指针（v0.80，拖卡片、拖小地图视口框同理）：指针一进跨源 iframe，父页就收不到 move / up——
      // 拖过交互态组件卡、聚焦屏、候选格时选框冻住、松手后残留。setPointerCapture 管不到跨源 iframe（Edge 实测照样丢）
      if (!moved) node.toggleAttribute('data-pointer-drag', true);
      moved = true;
      setMarquee({ x0, y0, x1, y1, additive });
      const hit = hitsIn(x1, y1);
      setMarqueeHits((prev) => (same(prev.screens, hit.screens) && same(prev.comps, hit.comps) ? prev : hit));
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      node.toggleAttribute('data-pointer-drag', false);
      setMarquee(null); setMarqueeHits({ screens: [], comps: [] });
      if (!moved) { propsRef.current.onSelect(null); return; }
      const hit = hitsIn(ev.clientX - nr.left, ev.clientY - nr.top);
      propsRef.current.onSelectMany(hit.screens, hit.comps, additive);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };

  // 双击空白处 = 在这里放锚点（REQ-CORE-014），描述在底部输入框里填。卡片自己的双击（进屏）在 .gesture 上已 stopPropagation，
  // 这里再按目标兜一层：风格指南卡、批注钉、断链角标、候选角标、锚点自己都不算空白。聚焦态里 iframe 吃掉了双击，不会到这。
  const onViewportDoubleClick = (e: ReactMouseEvent) => {
    if (!propsRef.current.onAnchor || propsRef.current.focusedId) return;
    if ((e.target as HTMLElement).closest('.card, .comp, .styleguide, .anno-pin, .warn, .cand-badge, .anchor')) return;
    const node = viewportRef.current;
    if (!node) return;
    const nr = node.getBoundingClientRect();
    const w = toWorld(vp.current, e.clientX - nr.left, e.clientY - nr.top);
    propsRef.current.onAnchor({ x: Math.round(w.x), y: Math.round(w.y) });
  };

  // 卡片拖拽（MOTION-017/028）：Pointer capture、10px 迟滞、buttons===0 兜底、松手才持久化（INT-019）。屏卡片与组件卡同一套手势纪律。
  // 多选批量移动（v0.47）：拖动集合按「按下的卡片在不在选中集合里」定——在则选中的屏与组件整组一起走，不在只拖它自己。
  // 所以按在已选中的卡片上不能一按就换选择（那会把整组收成一张、组拖不起来），松手没拖过才收成只选它；Shift / ⌘ 仍是按下即加选 / 去选。
  const startDrag = (e: ReactPointerEvent, kind: CardKind, id: string) => {
    // 按住空格是平移（v0.80）：不接住，交给 panzoom——平移就绪时手势层不带 nopan
    if (e.button !== 0 || spaceDown.current) return;
    e.stopPropagation();
    const cur = propsRef.current;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const wasSelected = (kind === 'screen' ? cur.selectedIds : cur.selectedComponentIds).includes(id);
    const select = (add: boolean) => (kind === 'screen' ? cur.onSelect(id, add) : cur.onSelectComponent(id, add));
    if (additive || !wasSelected) select(additive);
    const group = additive ? !wasSelected : wasSelected;   // 按下之后它还在选中集合里 → 带上整组
    const screenIds = new Set(group ? cur.selectedIds : []);
    const compIds = new Set(group ? cur.selectedComponentIds : []);
    (kind === 'screen' ? screenIds : compIds).add(id);
    const screens = cur.screens.filter((s) => screenIds.has(s.id)).map((s) => ({ id: s.id, ...pos(s) }));
    const comps = cur.components.filter((c) => compIds.has(c.id)).map((c) => ({ id: c.id, ...compPos(c) }));
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let offset = { x: 0, y: 0 };   // 整组同一个整数世界位移，相对位置逐像素保持
    const shifted = (list: { id: string; x: number; y: number }[]) => list.map((o) => ({ id: o.id, x: o.x + offset.x, y: o.y + offset.y }));
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.buttons === 0) { finish(ev); return; }
      const dx = ev.clientX - start.x; const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 10) return;
      if (!moved) viewportRef.current?.toggleAttribute('data-pointer-drag', true);   // 拖过 iframe 时照样跟手，见框选
      moved = true;
      const z = vp.current.zoom;
      offset = { x: Math.round(dx / z), y: Math.round(dy / z) };
      setDragPos((m) => ({ ...m, ...Object.fromEntries(shifted(screens).map((o) => [o.id, { x: o.x, y: o.y }])) }));
      if (comps.length) setCompDrag((m) => ({ ...m, ...Object.fromEntries(shifted(comps).map((o) => [o.id, { x: o.x, y: o.y }])) }));
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', finish); el.removeEventListener('pointercancel', finish);
      viewportRef.current?.toggleAttribute('data-pointer-drag', false);
      if (moved) {
        // 先把终点交给父页写进详情，再撤掉本地覆盖：同一个事件里的两次 setState 合成一帧，不会闪回旧位置（MOTION-026）
        propsRef.current.onMove(shifted(screens), shifted(comps));
        setDragPos((m) => omit(m, screens.map((o) => o.id)));
        if (comps.length) setCompDrag((m) => omit(m, comps.map((o) => o.id)));
      } else if (kind === 'screen' && propsRef.current.armed && !propsRef.current.focusedId) {
        focusCardRef.current(id);  // 模式已开：单击哪一屏就进哪一屏
      } else if (!additive && wasSelected) {
        select(false);  // 按在已选中的卡片上、没拖过：收成只选它
      }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', finish); el.addEventListener('pointercancel', finish);
  };

  const act = useStableActions<CardActions>({
    shotError: () => propsRef.current.onShotError?.(),
    shotGiveUp: markShot,
    shotShown: frame.onShotShown,
    retryShot: (id) => setShotRetry((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 })),
    cardFocus: onCardFocus,
    cardKey: onCardKey,
    dragStart: startDrag,
    enterScreen: focusCard,
    enterComponent: (id) => propsRef.current.onFocusComponent?.(id),
    annotation: (id) => propsRef.current.onAnnotationClick(id),
    dangling: (screenId, hrefs) => propsRef.current.onDanglingClick(screenId, hrefs),
    candidates: (jobId, screenId) => propsRef.current.onCandidates(jobId, screenId),
    gesture: (id, el) => { if (el) gestures.current.set(id, el); else gestures.current.delete(id); },
    compFrame: (id, el) => { if (el) compFrames.current.set(id, el); else compFrames.current.delete(id); },
    watchOnscreen,
  });

  const { lingerOn, family, shownId, frameFailed } = frame;
  return (
    <div ref={viewportRef} className={`viewport${panReady ? ' pan-ready' : ''}${view.dragging ? ' dragging' : ''}${p.armed && !p.focusedId ? ' armed' : ''}`} onPointerDown={onViewportPointerDown} onDoubleClick={onViewportDoubleClick} data-testid="canvas">
      {/* 首帧的 transform 写在这里，不等 panzoom 的 effect：effect 跑在绘制之后，画布会先按未变换的原点画一帧。
          值取自惰性初值、之后不再变（后续变换由 applyTransform 直接改 style），React 不会回头覆盖它 */}
      {/* 聚焦屏或组件时不画小地图：它压在可用区左上角，会挡住聚焦屏上那一块的点击 */}
      {p.minimap && !p.focusedId && !p.focusedComponentId && <Minimap rects={miniRects} onView={onView} onPanTo={panTo} onMoveView={moveView} />}
      {/* 连线（v1.02 ADR-029）：压在世界层下面，卡片盖住它；不进无障碍树，供测试读的数在 data-* 上 */}
      {p.showLinks && edges.length > 0 && <canvas ref={edgeCanvasRef} className="edges" aria-hidden="true" data-testid="link-edges" data-total={edges.length} data-drawn={edgeShown.length} data-max-count={Math.max(0, ...edgeShown.map((e) => e.count))} />}
      {p.showLinks && edges.length > EDGE_LIMIT && !p.focusedId && p.selectedIds.length === 0 && (
        <p data-testid="links-hint" className="pointer-events-none absolute left-0 right-[var(--chrome-right)] top-16 z-20 mx-auto w-max max-w-[calc(100%-2rem)] truncate chrome rounded-md px-3 py-1.5 type-label text-text-secondary">{tr('view.linksHint', { n: edges.length })}</p>
      )}
      <div ref={worldRef} className="world" style={view.initialWorldStyle}>
        {/* 按住空格时从风格指南卡上起手同样是平移（v0.80）：不带 nopan、不接住按下；获焦（只会来自键盘）时镜头把它摆进可用区 */}
        <div className={`styleguide${panReady ? '' : ' nopan'}${p.styleGuideSelected ? ' selected' : ''}`} style={{ transform: `translate(${STYLE_GUIDE_POS.x}px, ${STYLE_GUIDE_POS.y}px)` }}
          onPointerDown={(e) => { if (spaceDown.current) return; e.stopPropagation(); p.onSelectStyleGuide(); }} onMouseDown={keepPointerFocus}
          onFocus={() => ensureVisible({ ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) })}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelectStyleGuide(); } }} role="button" tabIndex={0} aria-label={tr('view.styleGuide')}>
          <StyleGuideCard tokens={p.tokens} name={p.projectName} palette={p.palette} colorMode={p.colorMode} assets={p.assets} />
        </div>
        {/* 锚点（REQ-CORE-014）：新屏落点的幽灵框，尺寸 = 设备形态；只是标记，不可拖不可点 */}
        {p.anchor && (
          <div className={`anchor${p.screenSize.w > 600 ? ' desktop' : ''}`} data-testid="anchor" aria-hidden="true" style={{ width: p.screenSize.w, height: p.screenSize.h, transform: `translate(${p.anchor.x - p.screenSize.w / 2}px, ${p.anchor.y - p.screenSize.h / 2}px)` }}>
            <span className="anchor-label">{tr('view.anchor')}</span>
          </div>
        )}
        {p.screens.map((s, idx) => {
          const q = pos(s);
          const isFocused = p.focusedId === s.id;
          const live = isFocused && !!s.previewUrl;
          const lingering = lingerOn?.id === s.id;
          return (
            <ScreenCard
              key={s.id} s={s} idx={idx} x={q.x} y={q.y}
              selected={marquee ? hitSet.has(s.id) || (marquee.additive && selectedSet.has(s.id)) : selectedSet.has(s.id)}
              focused={isFocused} live={live && iframeReady} dragging={!!dragPos[s.id]}
              shotUrl={shotOf(s)} shotFailed={shotFailed.has(s.id)} shotRetry={shotRetry[s.id] ?? 0}
              working={p.workingSubtrees.some((w) => w.screenId === s.id)} annotations={annoByScreen.get(s.id)} dangling={danglingBySource.get(s.id)}
              exemplar={p.exemplarScreenId === s.id} variants={variantCount.get(s.id) ?? 0} tabbable={tabStop === s.id} panReady={panReady}
              // 有候选未采用的卡片：后面叠两张错位底板示意「还有几版」；展开时底板让位给展开层
              stacked={!!s.pendingCandidates && !isFocused && p.candidateStack?.screenId !== s.id} candExpanded={p.candidateStack?.screenId === s.id}
              // 退出聚焦后留下的那个（v0.94）：同一个元素、src 不变，不重载；inert，手势层照常在上面
              frame={(live || lingering) && <div ref={frameBoxRef} className="frame-box"><iframe key={frame.reloadKey} ref={iframeRef} className={`nowheel nopan${iframeReady || lingering ? '' : ' loading'}`} src={lingering ? lingerOn.src : frame.focusedSrc ?? s.previewUrl!} title={s.name} sandbox="allow-scripts allow-same-origin allow-forms" inert={lingering} tabIndex={lingering ? -1 : undefined} onLoad={frame.onFrameLoad} /></div>}
              chrome={isFocused && (
                <>
                  {/* 状态变体（REQ-CORE-025 v0.62）：聚焦的屏所在家族 ≥ 2 时卡内顶部中央出一排胶囊，点即同 iframe 换成那一份。
                      放卡内而不是卡上方：聚焦把卡顶贴到可用区上沿，卡上方那 32 px 正压在顶栏底下（RUN-112 实测点不到） */}
                  {iframeReady && family.length >= 2 && (
                    <div className="variant-chips chrome nopan" role="group" aria-label={tr('view.variants')} data-testid="variant-chips">
                      {family.map((v) => (
                        <button key={v.id} type="button" className="variant-chip state-layer focus-ring" aria-pressed={shownId === v.id} data-testid="variant-chip" data-id={v.id}
                          onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); void frame.swapVariant(v.id); }}>{v.variantOf ? v.variantName : tr('view.defaultVariant')}</button>
                      ))}
                    </div>
                  )}
                  {frameFailed && !iframeReady ? (
                    <button type="button" className="badge failed state-layer nopan" data-testid="frame-retry" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); frame.retryFrame(); }}>{tr('view.frameRetry')}</button>
                  ) : <div className="badge">{!iframeReady ? tr('view.badge.loading') : p.annotateMode ? tr('view.badge.annotating') : p.inspectMode ? tr('view.badge.inspecting') : tr('interacting')} · {p.navStack.length ? p.navStack[p.navStack.length - 1] : s.route}{iframeReady ? ` · ${p.inspectMode ? tr('view.badge.clickElement') : tr('view.badge.inspectKey', { shortcut: INSPECT_KEY })}` : ''}</div>}
                </>
              )}
              act={act}
            />
          );
        })}
        {p.components.map((c) => {
          const q = compPos(c); const box = compBox(c); const at = compSize[c.id];
          return (
            <ComponentCard
              key={c.id} c={c} x={q.x} y={q.y} w={box.w} h={box.h} shift={at ? `translate(${-at.x}px, ${-at.y}px)` : undefined}
              ready={compLive.has(c.id)} selected={marquee ? compHitSet.has(c.id) || (marquee.additive && selectedCompSet.has(c.id)) : selectedCompSet.has(c.id)}
              focused={p.focusedComponentId === c.id} dragging={!!compDrag[c.id]} tabbable={tabStop === c.id} panReady={panReady}
              screenW={p.screenSize.w} screenH={p.screenSize.h} act={act}
            />
          );
        })}
        {/* 候选就地展开（REQ-CORE-015）：盖在卡片原位；按下不冒泡给画布，否则会当成框选 / 选卡 */}
        {p.candidateStack && byId[p.candidateStack.screenId] && (
          <div ref={(el) => { candRef.current = el; el?.style.setProperty('--zoom', String(vp.current.zoom)); }} className="cand-stack nopan" style={{ transform: `translate(${pos(byId[p.candidateStack.screenId]).x}px, ${pos(byId[p.candidateStack.screenId]).y}px)` }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {p.candidateStack.node}
          </div>
        )}
      </div>
      {/* 待命提示压在卡片上也得读得出（v0.80）：chrome 材质——透明强调色底（15%）压在白卡上对比度只有约 1.1:1；组件卡在交互态时不显示 */}
      {p.armed && !p.focusedId && !p.focusedComponentId && (
        <div className="chrome pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-md px-3 py-1 type-label text-text-primary" data-testid="armed-hint">
          {p.armed === 'annotate' ? tr('view.armed.annotate') : tr('view.armed.inspect')}
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
