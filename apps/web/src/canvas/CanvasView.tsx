import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { XYPanZoom, PanOnScrollMode, getViewportForBounds, type PanZoomInstance, type Viewport } from '@xyflow/system';
import { isPreviewMessage, type AssetDto, type ScreenDto, type LinkDto, type Tokens, type Palette, type ColorMode, type ParentToPreview, type AnnotationDto, type ComponentDto } from '@quilt/core';
import { StyleGuideCard, STYLE_GUIDE_SIZE, styleGuideSize } from '@/canvas/StyleGuideCard';
import { Minimap, type MiniRect, type ViewInfo } from '@/canvas/Minimap';

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
  onElementSelect: (sel: { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; rect: { x: number; y: number; w: number; h: number } } | null) => void;
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
  /** 视图位置按项目记（quilt:view:<projectId>），刷新回到原处 */
  projectId: string;
  /** 正在交互的共享组件卡（REQ-EDIT-006）：与屏的聚焦互斥，但不动镜头 */
  focusedComponentId?: string | null;
  onFocusComponent?: (id: string | null) => void;
  /** 未被浮层遮住的那块画布：适配视图与聚焦都以它为准，否则内容会被推到对话面板/工具栏底下 */
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

// 画布对外 API（Canvas.tsx 经 registerApi 取）：reveal 把一张卡摆到可用区中央（找屏 / 屏列表用），panTo 平移镜头中心到世界坐标（小地图用），
// onView 订阅视图变换（每帧都在变，不经 props）
export type CanvasApi = {
  /** false = 缩到下限 MIN_ZOOM 仍装不下全部 */
  fitView: () => boolean; goBack: () => void; highlight: (qid: string | null) => void; focus: (id: string) => void; resetToOwn: () => void; createAtCenter: () => void; markDone: (qids: string[]) => void;
  /** 键盘进入交互（屏或组件卡，v0.80）：就绪后焦点移进 iframe，退出后焦点回到这张卡 */
  enter: (id: string) => void;
  reveal: (id: string) => void; panTo: (x: number, y: number) => void; onView: (cb: (v: ViewInfo) => void) => () => void;
};

const STYLE_GUIDE_POS = { x: -(STYLE_GUIDE_SIZE.w + 80), y: 0 };
// 缩放下限（v0.76）：25 张桌面屏横排约 34000 px，下限取 0.1 的话适配视图有 6 屏整张在视口外。
// 适配视图、画布与屏内捏合、存储镜头校验都用它
const MIN_ZOOM = 0.02;
// 手势中往小缩到冻结栅格比例的这个倍数以下就重画一次（v0.86，见 applyTransform）
const RERASTER_RATIO = 0.7;
// 组件卡尺寸没记过时的紧凑占位高度（v0.76）：按设备整屏占位的话，每次加载都是一块 844 高的白板
const COMP_PLACEHOLDER_H = 64;
// 存下来的镜头要按当前数据校验再用（INT-019）：缩放超出 panzoom 的 [MIN_ZOOM, 2] 或存进去的是 NaN / 旧格式，
// 一律当没存过回默认，别把画布恢复成一片空白或卡在够不着的倍率上。
function readView(key: string): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Viewport | null;
    if (!v || ![v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return v.zoom >= MIN_ZOOM && v.zoom <= 2 ? v : null;
  } catch { return null; }
}
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
// 系统「减少动态效果」下镜头移动一律直接到位（v0.80，MOTION-004）：适配视图、自动适配、聚焦推镜头、找屏跳转、小地图点击
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// 滚轮平移速度：画布上的滚轮（panzoom）与交互态组件卡转发来的滚轮（v0.80）同一个值
const WHEEL_PAN_SPEED = 0.5;

// 无限画布（ADR-002 / ADR-006）：截图卡片 + 单聚焦活 iframe；世界层 transform 由 @xyflow/system 驱动。
export function CanvasView(p: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panZoom = useRef<PanZoomInstance | null>(null);
  // 平移缩放是用户手摆出来的视图偏好，按项目存、跨会话留（INT-019）。惰性初值读一次，**首帧就是终值**——
  // 用 useEffect 补会先画一帧初始位置再跳过去，用户看到的就是「刷新一次镜头自己动一下」（INT-021）。
  const viewKey = `quilt:view:${p.projectId}`;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const [savedView] = useState<Viewport | null>(() => readView(viewKey));
  const vp = useRef<Viewport>(savedView ?? { x: 80, y: 80, zoom: 0.5 });
  // 自动适配（首帧、首批屏到达、组件尺寸首次量完）施加的变换不落盘、不算用户动过镜头（v0.76）：与手动一样落盘的话，
  // 按未量尺寸算出的镜头会被当成用户摆好的存下来，此后每次打开都停在那儿。touched = 用户摆过镜头（存过的也算），之后不再自动适配
  const autoView = useRef(false);
  const touched = useRef(!!savedView);
  const [initialWorldStyle] = useState<CSSProperties>(() => ({
    transform: `translate(${vp.current.x}px, ${vp.current.y}px) scale(${vp.current.zoom})`,
    '--canvas-zoom': String(vp.current.zoom),
  } as CSSProperties));
  // 候选展开层的操作胶囊按 1/zoom 反向缩放，--zoom 只写在它那一层：写在世界层上的话每帧都让全部卡片重算样式（100 屏时缩放掉帧）
  const candRef = useRef<HTMLDivElement | null>(null);
  const spaceDown = useRef(false);
  // 空格按住 = 平移就绪：只有这时指针才是抓手；平时是箭头（空白处按下是框选，不是拖画布）
  const [panReady, setPanReady] = useState(false);
  const [dragging, setDragging] = useState(false);
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
  const [iframeReady, setIframeReady] = useState(false);
  // 重挂 iframe 用：从交互态切到选择元素态时，要把屏内导航过的 DOM 丢掉、回到这张卡片自己的那一屏
  const [reloadKey, setReloadKey] = useState(0);
  // 聚焦期间钉住 iframe 的 src：previewUrl 是签名 URL，每次 refresh 都会换一串新签名，
  // src 一变 iframe 就静默重载、回到 interact 模式，选择元素/批注态当场失效（且丢掉屏内滚动位置）。
  const [focusedSrc, setFocusedSrc] = useState<string | null>(null);
  // iframe 这一次实际加载的是哪一版（v0.76）：钉 src 时一并记下，就绪后作为热更新的基线——取「就绪那一刻的当前修订」的话，
  // 加载期间落地的新修订会被直接当成已显示，屏里停在旧版、检查器却按新版改
  const pinned = useRef<{ id: string; rev: string | null } | null>(null);
  useEffect(() => { if (!p.focusedId) { setIframeReady(false); setFocusedSrc(null); } }, [p.focusedId]);
  useEffect(() => {
    if (!p.focusedId || focusedSrc) return;
    const cur = p.screens.find((x) => x.id === p.focusedId);
    if (cur?.previewUrl) { pinned.current = { id: cur.id, rev: cur.currentRevisionId }; setFocusedSrc(cur.previewUrl); }
  }, [p.focusedId, p.screens, focusedSrc]);
  // 聚焦 iframe 的就绪看门（v0.76）：load 之后 2 s 还没收到 quilt:ready，多半是签名过期（里面是 403 JSON，父页读不到状态码）——
  // 静默重取签名、换新地址重载一次；仍不行就在角标上给「重试」
  const readyRef = useRef(false);
  readyRef.current = iframeReady;
  const frameRetried = useRef(false);
  const [frameFailed, setFrameFailed] = useState(false);
  const readyTimer = useRef<number | null>(null);
  useEffect(() => { frameRetried.current = false; setFrameFailed(false); return () => { if (readyTimer.current) clearTimeout(readyTimer.current); }; }, [p.focusedId]);

  // 父组件每次渲染都会传入新的回调；XYPanZoom 实例与 transform 回调必须稳定，否则实例被反复重建、transition 被打断
  const propsRef = useRef(p);
  propsRef.current = p;
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
  const selectedCompSet = useMemo(() => new Set(p.selectedComponentIds), [p.selectedComponentIds]);
  const focused = p.focusedId ? byId[p.focusedId] : null;
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

  // 落盘防抖 300 ms：平移缩放每帧都在变，逐帧写存储会把拖拽拖掉帧（INT-021）。无痕模式写不了就算了，
  // 退化成只本次会话有效，不能让存储异常打断渲染。
  const saveTimer = useRef<number | null>(null);
  // 平移缩放进行中给世界层挂 will-change 让它独立合成：不挂的话每改一次 transform 整层（跨越大片区域的连线 SVG 尤其贵）都要重新光栅化，
  // 100 屏时 GPU 每帧超预算。常驻又不行——独立合成层按挂上时的比例光栅化，放大后文字发虚；停下 200 ms 摘掉，按最终比例清晰重画一次
  const movingTimer = useRef<number | null>(null);
  // 挂着 moving 时栅格比例冻在挂上那一刻的缩放（zoom）。往小缩时新露出来的区域都要按这个比例现画：从 200% 一路缩到全景，
  // 一帧要现画几百块图块，显存放不下也画不完，这几帧卡片整块空着（25 屏 2 倍屏实测一次快速缩小缺块的帧 3～4 个、单帧最多 408 块）。
  // 缩到冻结比例的 RERASTER_RATIO 以下就摘掉 moving 一帧，让浏览器按当前比例重画，下一帧再挂上（pending 期间不重挂）
  const raster = useRef({ zoom: 0, pending: false });
  const viewSubs = useRef(new Set<(v: ViewInfo) => void>());
  const onView = useCallback((cb: (v: ViewInfo) => void) => {
    viewSubs.current.add(cb);
    const node = viewportRef.current;
    if (node) cb({ ...vp.current, w: node.clientWidth, h: node.clientHeight });
    return () => { viewSubs.current.delete(cb); };
  }, []);
  const scheduleSave = useCallback(() => {
    touched.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try { localStorage.setItem(viewKeyRef.current, JSON.stringify(vp.current)); } catch { /* 无痕模式写不了 */ }
    }, 300);
  }, []);
  const applyTransform = useCallback((v: Viewport) => {
    vp.current = v;
    const world = worldRef.current;
    if (world) {
      world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      const r = raster.current;
      if (!r.pending) {
        if (!world.classList.contains('moving')) { world.classList.add('moving'); r.zoom = v.zoom; }
        else if (v.zoom < r.zoom * RERASTER_RATIO) {
          // 两层 rAF：这一帧要带着「没有 moving」提交出去才会重画，单层 rAF 可能在同一帧的样式计算之前就把它挂回去
          world.classList.remove('moving'); r.pending = true;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            r.pending = false;
            if (movingTimer.current) { world.classList.add('moving'); r.zoom = vp.current.zoom; }
          }));
        }
      }
      if (movingTimer.current) clearTimeout(movingTimer.current);
      // 停下时顺手写 --canvas-zoom（v0.80）：选中描边与卡片焦点环按它保持屏幕像素宽度。逐帧写的话每帧全部卡片重算样式
      movingTimer.current = window.setTimeout(() => { world.classList.remove('moving'); world.style.setProperty('--canvas-zoom', String(vp.current.zoom)); movingTimer.current = null; }, 200);
    }
    candRef.current?.style.setProperty('--zoom', String(v.zoom));
    propsRef.current.onStat?.({ zoom: v.zoom });
    if (viewSubs.current.size) { const node = viewportRef.current; const info = { ...v, w: node?.clientWidth ?? 0, h: node?.clientHeight ?? 0 }; for (const cb of viewSubs.current) cb(info); }
    if (!autoView.current) scheduleSave();
  }, [scheduleSave]);
  // 防抖窗口里离开就把这一段丢了：触控板惯性滚动能持续几百毫秒，松手立刻刷新 / 切项目，
  // 丢的不是最后一点而是整段平移（起点还是上一次落盘的位置）。卸载与 pagehide 都补写一次。
  const flushView = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current); saveTimer.current = null;
    try { localStorage.setItem(viewKeyRef.current, JSON.stringify(vp.current)); } catch { /* 无痕模式写不了 */ }
  }, []);
  useEffect(() => {
    // pagehide 而不是 beforeunload：后者在移动端与 bfcache 下不保证触发，前者是 Safari/Chrome 都认的那一个
    window.addEventListener('pagehide', flushView);
    return () => { window.removeEventListener('pagehide', flushView); flushView(); };
  }, [flushView]);

  const updatePanZoom = useCallback(() => {
    panZoom.current?.update({
      noWheelClassName: 'nowheel', noPanClassName: 'nopan', preventScrolling: true,
      // 空白处拖拽留给框选，平移走滚轮 / 触控板 / 空格+拖拽
      panOnScroll: true, panOnScrollMode: PanOnScrollMode.Free, panOnScrollSpeed: WHEEL_PAN_SPEED, panOnDrag: spaceDown.current,
      panActivationKeyPressed: spaceDown.current, userSelectionActive: false,
      zoomOnPinch: true, zoomOnScroll: false, zoomOnDoubleClick: false, zoomActivationKeyPressed: false,
      lib: 'react', onTransformChange: ([x, y, zoom]) => applyTransform({ x, y, zoom }), connectionInProgress: false, paneClickDistance: 0,
    });
  }, [applyTransform]);

  useEffect(() => {
    const node = viewportRef.current!;
    // 用户手势开始（滚轮、捏合、空格拖拽带着原始事件；程序化的 setViewport 没有）：打断进行中的自动适配，这一段要落盘
    const inst = XYPanZoom({ domNode: node, minZoom: MIN_ZOOM, maxZoom: 2, viewport: vp.current, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]], onDraggingChange: setDragging,
      onPanZoomStart: (ev) => { if (ev) { autoView.current = false; scheduleSave(); } } });
    panZoom.current = inst;
    updatePanZoom();
    // 首帧镜头要么是记住的、要么是自动适配出来的，都不是这一次手摆的：不落盘
    autoView.current = true; applyTransform(vp.current); autoView.current = false;
    return () => inst.destroy();
  }, [applyTransform, updatePanZoom, scheduleSave]);
  // 用户动作带来的镜头移动（适配视图、找屏跳转、小地图、聚焦推镜头、屏内捏合）：先撤掉自动适配标记，否则被它打断的那段自动适配会让这一次也不落盘
  const moveTo = useCallback((v: Viewport, opts?: { duration?: number }) => { autoView.current = false; void panZoom.current?.setViewport(v, opts?.duration && reducedMotion() ? { duration: 0 } : opts); }, []);

  // 可用区 = 画布减去四周浮层的占位；几何由 CSS 变量驱动的探针元素给出，这里只测不算
  const safeArea = useCallback(() => {
    const node = viewportRef.current!;
    const el = propsRef.current.safeAreaRef?.current;
    if (!el) return { x: 0, y: 0, w: node.clientWidth, h: node.clientHeight };
    const nr = node.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { x: r.left - nr.left, y: r.top - nr.top, w: Math.max(240, r.width), h: Math.max(240, r.height) };
  }, []);

  // 装下全部屏、组件与风格指南卡的镜头；fits = 缩到 MIN_ZOOM 装不装得下
  const fitTarget = useCallback((): { v: Viewport; fits: boolean } | null => {
    if (!viewportRef.current) return null;
    const rects = [...p.screens.map((s) => ({ ...pos(s), w: s.width, h: s.height })), ...p.components.map((c) => ({ ...compPos(c), ...compBox(c) })), { ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) }];
    const x0 = Math.min(...rects.map((r) => r.x)); const y0 = Math.min(...rects.map((r) => r.y)) - 40;
    const x1 = Math.max(...rects.map((r) => r.x + r.w)); const y1 = Math.max(...rects.map((r) => r.y + r.h));
    const a = safeArea();
    const b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 + 40 };
    const v = getViewportForBounds(b, a.w, a.h, MIN_ZOOM, 1.5, 0.08);
    return { v: { x: v.x + a.x, y: v.y + a.y, zoom: v.zoom }, fits: b.width * v.zoom <= a.w + 1 && b.height * v.zoom <= a.h + 1 };
  }, [p.screens, p.components, p.assets?.length, pos, compPos, compBox, safeArea]);
  const fitView = useCallback(() => {
    const t = fitTarget();
    if (t) moveTo(t.v, { duration: 300 });
    return t?.fits ?? true;
  }, [fitTarget, moveTo]);
  // 自动适配：变换照常施加，只是不落盘（见 autoView）；用户手势打断时由 onPanZoomStart 撤标记
  const autoFit = (ms: number) => {
    const t = fitTarget(); const pz = panZoom.current;
    if (!t || !pz) return;
    const duration = reducedMotion() ? 0 : ms;
    autoView.current = true;
    void pz.setViewport(t.v, { duration }).then(() => { autoView.current = false; });
    if (!duration) autoView.current = false;
  };

  // 组件预览页量完根元素就上报它的框：只认本画布里某张组件卡的 iframe 发来的（按 source 对号），钳到设备视口以内
  useEffect(() => {
    const onSize = (e: MessageEvent) => {
      if (e.origin !== propsRef.current.previewOrigin) return;
      const d = e.data as { type?: string; x?: number; y?: number; w?: number; h?: number } | null;
      if (!d || d.type !== 'quilt:component-size') return;
      let id: string | null = null;
      for (const [cid, frame] of compFrames.current) if (frame.contentWindow === e.source) { id = cid; break; }
      if (!id) return;
      const max = propsRef.current.screenSize;
      const w = Math.min(max.w, Math.max(48, Math.ceil(Number(d.w) || 0)));
      const h = Math.min(max.h, Math.max(32, Math.ceil(Number(d.h) || 0)));
      const x = Math.min(max.w - w, Math.max(0, Math.floor(Number(d.x) || 0)));
      const y = Math.min(max.h - h, Math.max(0, Math.floor(Number(d.y) || 0)));
      setCompSize((m) => { const o = m[id]; return o?.x === x && o?.y === y && o?.w === w && o?.h === h ? m : { ...m, [id]: { x, y, w, h } }; });
      setCompLive((s) => (s.has(id!) ? s : new Set(s).add(id!)));
    };
    window.addEventListener('message', onSize);
    return () => window.removeEventListener('message', onSize);
  }, []);

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
    if (savedView) return;
    const t = fitTarget();
    if (!t) return;
    vp.current = t.v;
    if (worldRef.current) { worldRef.current.style.transform = `translate(${t.v.x}px, ${t.v.y}px) scale(${t.v.zoom})`; worldRef.current.style.setProperty('--canvas-zoom', String(t.v.zoom)); }
    if (p.screens.length) fitOnce.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (touched.current || fitOnce.current || !p.screens.length) return; fitOnce.current = true; setTimeout(() => autoFitRef.current(300), 0); }, [p.screens.length]);
  useEffect(() => {
    if (!measureFit.current) return;
    if (touched.current) { measureFit.current = false; return; }
    if (!p.components.every((c) => compLive.has(c.id))) return;
    measureFit.current = false;
    autoFitRef.current(0);
  }, [compLive, p.components]);

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
    landed.current = null;  // 换屏或重挂之后，还在等上一份文档换完的重摆作废
    pinned.current = { id, rev: s.currentRevisionId };
    setFocusedSrc(s.previewUrl);
    p.onFocus(id);
    p.setNavStack(() => []);
    setTimeout(() => moveTo({ x: a.x + (a.w - s.width * zoom) / 2 - q.x * zoom, y: a.y + top - q.y * zoom, zoom }, { duration: 250 }), 0);
  }, [byId, pos, p, safeArea, moveTo]);

  focusCardRef.current = focusCard;

  const postToPreview = useCallback((msg: ParentToPreview) => { iframeRef.current?.contentWindow?.postMessage(msg, propsRef.current.previewOrigin); }, []);
  // 播放跳转只认默认屏（v0.62）：变体与默认屏同路由，路由找屏时排除变体
  const baseByRoute = useCallback((route: string) => propsRef.current.screens.find((s) => s.route === route && !s.variantOf), []);
  // 此刻 iframe 里显示的是哪一屏（最上面那层）：聚焦时是卡片自己，之后随跳转、切变体、叠层变
  const [shownId, setShownId] = useState<string | null>(p.focusedId);
  useEffect(() => { setShownId(p.focusedId); }, [p.focusedId]);
  useEffect(() => { p.onShown?.(shownId); }, [shownId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 取目标屏的 HTML（屏内跳转、切变体、后退重摆、热更新）：检查响应状态——同源可读的错误体不能当屏 swap 进去；
  // 失败（签名过期时预览域的 403 不带 CORS 头，这里拿到的是网络错误）先静默重取签名再取一次，仍失败抛给调用方（v0.76）
  const htmlOf = useCallback(async (s: ScreenDto): Promise<string | null> => {
    if (!s.previewUrl) return null;
    const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`preview ${r.status}`); return r.text(); };
    try { return await get(s.previewUrl); }
    catch {
      const fresh = (await propsRef.current.onStale?.())?.screens.find((x) => x.id === s.id)?.previewUrl;
      if (!fresh) throw new Error('preview unavailable');
      return get(fresh);
    }
  }, []);
  // 叠层屏（v0.63 REQ-PROTO-005）：跳到 overlay 屏压一层（quilt:overlay），不换 DOM；跳到 push 屏整份换（运行时先清叠层）
  const swapTo = useCallback(async (target: ScreenDto) => {
    let html: string | null;
    try { html = await htmlOf(target); } catch { propsRef.current.onPreviewError?.(target); return; }
    if (html === null) return;
    const msg: ParentToPreview = target.presentation === 'overlay' ? { type: 'quilt:overlay', html, route: target.route } : { type: 'quilt:swap', html, route: target.route };
    iframeRef.current?.contentWindow?.postMessage(msg, p.previewOrigin);
    setShownId(target.id);
    p.setNavStack((s) => [...s, target.route]);
  }, [p, htmlOf]);
  // 按一条导航栈把 iframe 重新摆出来：栈里最靠上的整屏（没有就是卡片自己）换进去，它上面的叠层逐层压回去。
  // 后退穿过叠层、叠层关闭链接都走这里——只发一条 overlay-close 的话，底下那一屏若是后来才换进来的就对不上了。
  // 叠层要等整屏换完（quilt:swapped，整份重写时是新文档的 quilt:ready）再发：整份重写期间 iframe 里没有任何监听，发过去就丢了
  const landed = useRef<(() => void) | null>(null);
  const rebuild = useCallback(async (stack: string[]) => {
    if (!focused) return;
    let j = stack.length - 1;
    while (j >= 0 && baseByRoute(stack[j])?.presentation === 'overlay') j--;
    const base = j >= 0 ? baseByRoute(stack[j]) : focused;
    if (!base) return;
    let baseHtml: string | null;
    try { baseHtml = await htmlOf(base); } catch { propsRef.current.onPreviewError?.(base); return; }
    if (baseHtml === null) return;
    await new Promise<void>((done) => { landed.current = done; postToPreview({ type: 'quilt:swap', html: baseHtml, route: base.route }); });
    let top = base;
    // 某一层取不到就停在它下面那层：导航栈只留真的摆出来的
    let shownStack = stack;
    for (let k = j + 1; k < stack.length; k++) {
      const route = stack[k];
      const o = baseByRoute(route);
      let html: string | null = null;
      if (o) { try { html = await htmlOf(o); } catch { propsRef.current.onPreviewError?.(o); shownStack = stack.slice(0, k); break; } }
      if (!o || !html) continue;
      postToPreview({ type: 'quilt:overlay', html, route });
      top = o;
    }
    setShownId(top.id);
    p.setNavStack(() => shownStack);
  }, [focused, p, baseByRoute, htmlOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = useCallback(() => {
    if (!focused || p.navStack.length === 0) return;
    const stack = p.navStack.slice(0, -1);
    // 栈顶是叠层屏：只关它这一层，底下那一屏原样留着（滚动位置都在）
    const top = baseByRoute(p.navStack[p.navStack.length - 1]);
    if (top?.presentation === 'overlay') {
      const under = stack.length ? baseByRoute(stack[stack.length - 1]) : focused;
      // 叠层开着时底下那一屏出了新修订（热更新只跟最上面那层走）：按栈重摆一遍，露出来的是它的新版本
      if (under && shownRevs.current.has(under.id) && shownRevs.current.get(under.id) !== under.currentRevisionId) { void rebuild(stack); return; }
      iframeRef.current?.contentWindow?.postMessage({ type: 'quilt:overlay-close' } as ParentToPreview, p.previewOrigin);
      setShownId(under?.id ?? focused.id);
      p.setNavStack(() => stack);
      return;
    }
    void rebuild(stack);
  }, [focused, p, baseByRoute, rebuild]);

  const highlight = useCallback((qid: string | null) => postToPreview({ type: 'quilt:highlight', qid }), [postToPreview]);
  // 回到这张卡片自己的屏：重挂 iframe（src 不变时 React 不会重新加载，只能靠换 key）并清空导航栈
  // 清空后由下面的 effect 用「当前这一轮的 props」重新钉住——这里直接读 propsRef 会拿到上一轮的
  // previewUrl（调用方常常是 await refresh() 之后紧接着调，state 还没落到下一次渲染），于是重载出旧修订
  const resetToOwn = useCallback(() => { setIframeReady(false); landed.current = null; setFocusedSrc(null); setReloadKey((k) => k + 1); propsRef.current.setNavStack(() => []); setShownId(propsRef.current.focusedId); }, []);
  // 签名过期导致 iframe 等不到就绪：重取详情，用新签名的地址重挂（钉住的修订随之换成详情里的当前版）
  const reloadFresh = useCallback(async () => {
    const id = propsRef.current.focusedId;
    if (!id) return;
    const d = await propsRef.current.onStale?.();
    const fresh = (d?.screens ?? propsRef.current.screens).find((x) => x.id === id);
    if (!fresh?.previewUrl || propsRef.current.focusedId !== id) return;
    pinned.current = { id, rev: fresh.currentRevisionId };
    landed.current = null;
    setIframeReady(false); setFocusedSrc(fresh.previewUrl); setReloadKey((k) => k + 1);
    propsRef.current.setNavStack(() => []); setShownId(id);
  }, []);
  const onFrameLoad = () => {
    if (readyTimer.current) clearTimeout(readyTimer.current);
    readyTimer.current = window.setTimeout(() => {
      readyTimer.current = null;
      if (readyRef.current) return;
      if (frameRetried.current) { setFrameFailed(true); return; }
      frameRetried.current = true;
      void reloadFresh();
    }, 2000);
  };
  const retryFrame = () => { setFrameFailed(false); frameRetried.current = true; void reloadFresh(); };
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
      compFrames.current.get(id)?.contentWindow?.postMessage({ type: 'quilt:mode', mode } as ParentToPreview, propsRef.current.previewOrigin);
    if (prev && prev !== now) post(prev, 'interact');
    if (!now) return;
    const mode = p.inspectMode ? 'inspect' : 'interact';
    post(now, mode);
    // iframe 可能还没 ready（切模式与聚焦常在同一帧），补发一次
    const t = setTimeout(() => post(now, mode), 300);
    return () => clearTimeout(t);
  }, [p.focusedComponentId, p.inspectMode]);

  // 聚焦态热更新（REQ-CORE-005 v0.33）：src 钉住后新修订不会自己进来，由这里显式送——iframe 里正显示的那一屏
  //（导航栈顶，没跳转过就是卡片自己）换了 currentRevisionId，就取新 HTML swap 进同一个文档：不重挂、不丢导航栈，
  // 模式与滚动位置由运行时保住。基线按「屏 id + 修订 id」记：跳转换屏只更新基线不 swap，同屏换修订才 swap。
  // previewUrl 是签名 URL、每次 refresh 都换，所以不进依赖，只在真要 swap 时从 ref 读当前值。
  const shown = shownId ? byId[shownId] : undefined;
  const shownRev = shown?.currentRevisionId ?? null;
  // 正显示那一屏所在的家族（v0.62）：默认屏在前，变体按位置排——跳到别的屏之后胶囊跟着换成那一屏的
  const family = useMemo(() => {
    if (!shown) return [] as ScreenDto[];
    const base = shown.variantOf ? byId[shown.variantOf] : shown;
    if (!base) return [shown];
    return [base, ...p.screens.filter((s) => s.variantOf === base.id).sort((a, b) => a.x - b.x || a.y - b.y)];
  }, [shown, byId, p.screens]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const baseline = useRef<{ id: string; rev: string | null } | null>(null);
  // 每屏最近一次显示在 iframe 里的修订：叠层关掉时拿它判断底下那一屏在被盖住期间有没有更新
  const shownRevs = useRef(new Map<string, string | null>());
  // 热更新换完 DOM（quilt:swapped，或整份重写后的 quilt:ready）再按这个 qid 重选；跳转的 swap 不重选——同一 qid 在别的屏上是另一个元素
  const pendingReselect = useRef<string | null>(null);
  useEffect(() => {
    if (!p.focusedId || !iframeReady || !shownId) { baseline.current = null; return; }
    const base = baseline.current ?? pinned.current;
    pinned.current = null;
    baseline.current = { id: shownId, rev: shownRev };
    shownRevs.current.set(shownId, shownRev);
    const cur = shownRef.current;
    if (!base || base.id !== shownId || base.rev === shownRev || !cur?.previewUrl) return;
    let stale = false;
    // 正显示的是一层叠层：只换这一层，底下那一屏不动（swap 会把叠层全清掉、让它独占整页）
    const asLayer = cur.presentation === 'overlay' && propsRef.current.navStack.length > 0;
    htmlOf(cur).then((html) => {
      if (stale || html === null) return;
      pendingReselect.current = propsRef.current.selectedQid;
      if (asLayer) { postToPreview({ type: 'quilt:overlay-close' }); postToPreview({ type: 'quilt:overlay', html, route: cur.route }); }
      else postToPreview({ type: 'quilt:swap', html, route: cur.route, keepScroll: true });
    }).catch(() => { if (!stale) propsRef.current.onPreviewError?.(cur); });
    return () => { stale = true; };
  }, [p.focusedId, iframeReady, shownId, shownRev, postToPreview, htmlOf]);
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
  // panTo：镜头中心平移到世界坐标（缩放不变）；reveal：把一张卡（屏或组件）摆到可用区中央，缩放取「装得下」与 1:1 的较小者（REQ-CORE-024）
  const panTo = useCallback((x: number, y: number) => {
    const a = safeArea(); const z = vp.current.zoom;
    moveTo({ x: a.x + a.w / 2 - x * z, y: a.y + a.h / 2 - y * z, zoom: z }, { duration: 200 });
  }, [safeArea, moveTo]);
  // 小地图拖视口框：直接设平移量（缩放不变、不带动画），拖动全程 1:1 跟手
  const moveView = useCallback((x: number, y: number) => { moveTo({ x, y, zoom: vp.current.zoom }); }, [moveTo]);
  // 一张卡（屏或组件）此刻画出来的世界矩形
  const cardRect = useCallback((id: string) => {
    const s = byId[id]; const c = propsRef.current.components.find((x) => x.id === id);
    return s ? { ...pos(s), w: s.width, h: s.height } : c ? { ...compPos(c), ...compBox(c) } : null;
  }, [byId, pos, compPos, compBox]);
  const reveal = useCallback((id: string) => {
    const rect = cardRect(id);
    if (!rect) return;
    const a = safeArea();
    const zoom = Math.max(0.1, Math.min(1, (a.w - 80) / rect.w, (a.h - 80) / rect.h));
    moveTo({ x: a.x + (a.w - rect.w * zoom) / 2 - rect.x * zoom, y: a.y + (a.h - rect.h * zoom) / 2 - rect.y * zoom, zoom }, { duration: 250 });
  }, [cardRect, safeArea, moveTo]);
  // 键盘把焦点移到一张卡上（v0.80）：它不完整在可用区里就把镜头中心平移过去（缩放不变）——视口只裁不滚，焦点落在视口外等于消失。
  // 键盘触发不带动画（MOTION-010）：连按方向键时上一段平移还没走完，按半路的镜头判断下一张在不在视野里会判错
  const ensureVisible = useCallback((r: { x: number; y: number; w: number; h: number }) => {
    const v = vp.current; const a = safeArea();
    const sx = v.x + r.x * v.zoom; const sy = v.y + r.y * v.zoom;
    if (sx >= a.x && sy >= a.y && sx + r.w * v.zoom <= a.x + a.w && sy + r.h * v.zoom <= a.y + a.h) return;
    moveTo({ x: a.x + a.w / 2 - (r.x + r.w / 2) * v.zoom, y: a.y + a.h / 2 - (r.y + r.h / 2) * v.zoom, zoom: v.zoom });
  }, [safeArea, moveTo]);
  // 键盘进入交互（v0.80）：记下是哪张卡——屏的 iframe 就绪、组件卡进了交互态就把焦点移进 iframe，退出后还给这张卡（A11Y-013）
  const kbEntered = useRef<string | null>(null);
  const kbFocusPending = useRef(false);
  const enterByKey = useCallback((id: string) => {
    const s = byId[id];
    if (s ? !s.previewUrl : !propsRef.current.components.some((c) => c.id === id)) return;
    kbEntered.current = id;
    if (s) { kbFocusPending.current = true; focusCard(id); } else propsRef.current.onFocusComponent?.(id);
  }, [byId, focusCard]);
  useEffect(() => {
    const id = kbEntered.current;
    if (!id) return;
    if (p.focusedComponentId === id) { compFrames.current.get(id)?.focus(); return; }
    if (p.focusedId === id) return;   // 屏的 iframe 就绪时再把焦点移进去（quilt:ready）
    kbEntered.current = null; kbFocusPending.current = false;
    if (p.focusedId || p.focusedComponentId) return;   // 换进了别的卡：不动焦点
    // 焦点已被放到别处（点了输入框、面板）就不抢；屏退出后 iframe 卸载，焦点在 body；组件卡的 iframe 常驻，焦点还在它上面
    const a = document.activeElement;
    if (a && a !== document.body && a !== compFrames.current.get(id)) return;
    requestAnimationFrame(() => gestures.current.get(id)?.focus({ preventScroll: true }));
  }, [p.focusedId, p.focusedComponentId]);
  useEffect(() => { propsRef.current.registerApi?.({ fitView, goBack, highlight, focus: focusCard, resetToOwn, createAtCenter, markDone, reveal, panTo, onView, enter: enterByKey }); }, [fitView, goBack, highlight, focusCard, resetToOwn, createAtCenter, markDone, reveal, panTo, onView, enterByKey]);
  // 切状态变体（v0.62）：同一 iframe 换成该变体的当前修订，镜头不动、导航栈不动；选中的元素属于换掉的那份 DOM，清空。
  // 正显示的是一层叠层时只换这一层，底下那一屏留着（与热更新的叠层分支同理）
  const swapVariant = useCallback(async (id: string) => {
    const target = byId[id];
    if (!target) return;
    let html: string | null;
    try { html = await htmlOf(target); } catch { propsRef.current.onPreviewError?.(target); return; }
    if (html === null) return;
    pendingReselect.current = null;
    propsRef.current.onElementSelect(null);
    if (target.presentation === 'overlay' && propsRef.current.navStack.length > 0) { postToPreview({ type: 'quilt:overlay-close' }); postToPreview({ type: 'quilt:overlay', html, route: target.route }); }
    else postToPreview({ type: 'quilt:swap', html, route: target.route, keepScroll: true });
    setShownId(target.id);
  }, [byId, postToPreview, htmlOf]);
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

  // iframe 里转发来的滚轮（ADR-003）：捏合换算成画布坐标后围绕指针缩放（系数同 d3-zoom 的 ctrl+wheel）；
  // pan = 组件文档里指针下没有可滚区域的普通滚轮（v0.80），按画布滚轮的速度平移
  const frameWheel = useCallback((frame: HTMLIFrameElement | null | undefined, msg: { deltaY: number; deltaX?: number; x: number; y: number; pan?: boolean }) => {
    const node = viewportRef.current;
    if (!node || !frame) return;
    const v = vp.current;
    if (msg.pan) { moveTo({ x: v.x - (msg.deltaX ?? 0) * WHEEL_PAN_SPEED, y: v.y - msg.deltaY * WHEEL_PAN_SPEED, zoom: v.zoom }); return; }
    const nr = node.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    const px = fr.left - nr.left + msg.x * v.zoom; const py = fr.top - nr.top + msg.y * v.zoom;
    const zoom = Math.min(2, Math.max(MIN_ZOOM, v.zoom * Math.pow(2, -msg.deltaY * 0.02)));
    const k = zoom / v.zoom;
    moveTo({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom });
  }, [moveTo]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // 唯一从候选格接的一条消息：焦点一进格子（格子可滚动、可填表），父页 window 的 keydown 就收不到了，
      // 不接这条 Esc 它就是死键；格子的其余消息仍由下面那道守卫拦掉
      if (p.candidateStack && e.origin === p.previewOrigin && e.source !== iframeRef.current?.contentWindow
        && isPreviewMessage(e.data) && e.data.type === 'quilt:key' && e.data.key === 'Escape') { collapseCandidates(); return; }
      // 交互 / 选择元素态的组件卡（v0.55 / v0.57）：焦点在组件 iframe 内时父页 window 收不到键盘，
      // Esc 靠运行时转发；选中元素同样由它上报，父页据此开检查器。组件没有路由，navigate / dead
      // 一类对它没有意义（组件里的链接在运行时侧已做成惰性），所以只接这三条。
      if (p.focusedComponentId && e.origin === p.previewOrigin && isPreviewMessage(e.data)
        && compFrames.current.get(p.focusedComponentId)?.contentWindow === e.source) {
        const m = e.data;
        // 组件版本一升，previewUrl 的 ?v= 就变、iframe 重新导航，新文档里运行时是初始的 interact——
        // 而同步模式那个 effect 的依赖（focusedComponentId / inspectMode）都没变，不会重跑。
        // 所以这里接住新文档的 ready，把当前模式补发一次；不接的话「改完一个元素就得退出重进」。
        if (m.type === 'quilt:ready') {
          e.source?.postMessage({ type: 'quilt:mode', mode: p.inspectMode ? 'inspect' : 'interact' } as ParentToPreview, p.previewOrigin);
          return;
        }
        if (m.type === 'quilt:key') {
          if (m.key === 'Escape') { p.onFocusComponent?.(null); return; }
          // ⌘E / ⌘/ 同屏一样转发给父页的键位表：不转发的话焦点一落进组件 iframe，按 ⌘E 就是死键——
          // 模式退不掉，选中框与「tag · qid」标签留在卡片上（组件卡的 iframe 常驻，不像屏那样退出即卸载）
          if ((m.metaKey || m.ctrlKey) && m.code) { p.onShortcut?.(m.code); return; }
          if (m.altKey && m.code) p.onShortcut?.(m.code, true);
          return;
        }
        // 交互态组件卡上的捏合与滚轮（v0.80）：与屏同一条 quilt:wheel，按这张卡的 iframe 换算
        if (m.type === 'quilt:wheel') { frameWheel(compFrames.current.get(p.focusedComponentId), m); return; }
        if (m.type === 'quilt:select') { p.onElementSelect({ qid: m.qid, tag: m.tag, text: m.text, classes: m.classes, href: m.href ?? null, component: m.component ?? null, rect: m.rect }); return; }
        if (m.type === 'quilt:deselect') { p.onElementSelect(null); return; }
      }
      // 只认聚焦 iframe 发来的：候选展开层里的活 iframe（REQ-CORE-015）也跑同一套运行时，它们的 ready / navigate / key 不能动聚焦态
      if (e.origin !== p.previewOrigin || !focused || e.source !== iframeRef.current?.contentWindow || !isPreviewMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === 'quilt:ready' || msg.type === 'quilt:swapped') { landed.current?.(); landed.current = null; }
      if (msg.type === 'quilt:ready') {
        readyRef.current = true; frameRetried.current = false; setFrameFailed(false); setIframeReady(true); postToPreview({ type: 'quilt:mode', mode: propsRef.current.inspectMode ? 'inspect' : 'interact' }); reselectAfterSwap();
        if (kbFocusPending.current) { kbFocusPending.current = false; iframeRef.current?.focus(); }
      }
      if (msg.type === 'quilt:swapped') reselectAfterSwap();
      if (msg.type === 'quilt:select') p.onElementSelect({ qid: msg.qid, tag: msg.tag, text: msg.text, classes: msg.classes, href: msg.href ?? null, component: msg.component ?? null, rect: msg.rect });
      if (msg.type === 'quilt:deselect') p.onElementSelect(null);
      if (msg.type === 'quilt:navigate') {
        // 叠层里指回它底下那一屏的链接（契约要求叠层带这样一个关闭动作）是关闭，不是再跳一次
        const stack = p.navStack;
        const topIsOverlay = stack.length > 0 && baseByRoute(stack[stack.length - 1])?.presentation === 'overlay';
        const under = stack.length >= 2 ? stack[stack.length - 2] : focused.route;
        if (topIsOverlay && msg.href === under) { goBack(); return; }
        const t = baseByRoute(msg.href);
        if (t) void swapTo(t); else p.onNavigateMissing(focused.id, msg.href);
      }
      if (msg.type === 'quilt:overlay-dismiss') goBack();
      if (msg.type === 'quilt:key') {
        if (msg.key === 'Escape') p.onFocus(null);
        else if (msg.key === 'ArrowLeft' && msg.altKey) goBack();
        else if ((msg.metaKey || msg.ctrlKey) && msg.code) p.onShortcut?.(msg.code);  // ⌘E / ⌘/：键位表在 Canvas.tsx
        else if (msg.altKey && msg.code) p.onShortcut?.(msg.code, true);  // ⌥N / ⌥D……（v0.80）
      }
      if (msg.type === 'quilt:dead') p.onDeadLink();
      if (msg.type === 'quilt:wheel') frameWheel(iframeRef.current, msg);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [focused, p, swapTo, goBack, reselectAfterSwap, collapseCandidates, baseByRoute, frameWheel]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable]');
      // 空格在按钮、链接、下拉、选项上是「激活」，不是平移——只在画布或页面空处按下时才进入平移就绪
      const control = target?.closest('button, a[href], summary, [role=button], [role=option], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem]');
      if (e.code === 'Space' && !e.repeat && !typing && !control) { spaceDown.current = true; setPanReady(true); updatePanZoom(); e.preventDefault(); }
      if (e.altKey && e.key === 'ArrowLeft' && !typing) { e.preventDefault(); goBack(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceDown.current = false; setPanReady(false); updatePanZoom(); } };
    // 面板 / 顶栏上的触控板捏合会触发浏览器整页缩放（header 被顶出视口）；画布之外一律拦掉，Cmd +/- 不受影响
    const pinch = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('wheel', pinch, { passive: false });
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('wheel', pinch); };
  }, [goBack, updatePanZoom]);

  // 卡片的键盘停靠点（v0.80，INT-002）：屏卡与组件卡在 Tab 序里只占一个停靠点（默认选中的那张，没有选中时阅读顺序第一张），
  // 方向键按阅读顺序（y 再 x）移动、Home / End 到两端；Enter 进入交互，空格选中（Shift / ⌘ 加选去选）
  const order = useMemo(() => [...p.screens.map((s) => ({ id: s.id, x: s.x, y: s.y })), ...p.components.map((c) => ({ id: c.id, x: c.x, y: c.y }))].sort((a, b) => a.y - b.y || a.x - b.x), [p.screens, p.components]);
  const [rove, setRove] = useState<string | null>(null);
  const tabStop = order.some((o) => o.id === rove) ? rove : p.selectedIds[0] ?? p.selectedComponentIds[0] ?? order[0]?.id ?? null;
  const gestures = useRef(new Map<string, HTMLElement>());
  // 鼠标点卡片不把焦点留在卡片上，焦点照旧回到页面：卡片只是键盘停靠点，鼠标点过之后按住空格仍要是平移、Delete / F 这些单键照常
  const keepPointerFocus = (e: ReactMouseEvent) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); };
  const onCardFocus = (id: string) => {
    setRove(id);
    const r = cardRect(id);
    if (r) ensureVisible(r);
  };
  const onCardKey = (e: ReactKeyboardEvent<HTMLElement>, kind: 'screen' | 'component', id: string) => {
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
  const gestureRef = (id: string) => (el: HTMLDivElement | null) => { if (el) gestures.current.set(id, el); else gestures.current.delete(id); };

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
      const v = vp.current;
      const toWorld = (sx: number, sy: number) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });
      const a = toWorld(Math.min(x0, x1), Math.min(y0, y1));
      const b = toWorld(Math.max(x0, x1), Math.max(y0, y1));
      const inside = (q: { x: number; y: number }, w: number, h: number) => q.x < b.x && a.x < q.x + w && q.y < b.y && a.y < q.y + h;
      const screens = propsRef.current.screens.filter((s) => inside(dragPos[s.id] ?? { x: s.x, y: s.y }, s.width, s.height)).map((s) => s.id);
      const comps = propsRef.current.components.filter((c) => { const box = compBox(c); return inside(compDrag[c.id] ?? { x: c.x, y: c.y }, box.w, box.h); }).map((c) => c.id);
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
    const v = vp.current;
    propsRef.current.onAnchor({ x: Math.round((e.clientX - nr.left - v.x) / v.zoom), y: Math.round((e.clientY - nr.top - v.y) / v.zoom) });
  };

  // 卡片拖拽（MOTION-017/028）：Pointer capture、10px 迟滞、buttons===0 兜底、松手才持久化（INT-019）。屏卡片与组件卡同一套手势纪律。
  // 多选批量移动（v0.47）：拖动集合按「按下的卡片在不在选中集合里」定——在则选中的屏与组件整组一起走，不在只拖它自己。
  // 所以按在已选中的卡片上不能一按就换选择（那会把整组收成一张、组拖不起来），松手没拖过才收成只选它；Shift / ⌘ 仍是按下即加选 / 去选。
  const startDrag = (e: ReactPointerEvent, kind: 'screen' | 'component', id: string) => {
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

  return (
    <div ref={viewportRef} className={`viewport${panReady ? ' pan-ready' : ''}${dragging ? ' dragging' : ''}${p.armed && !p.focusedId ? ' armed' : ''}`} onPointerDown={onViewportPointerDown} onDoubleClick={onViewportDoubleClick} data-testid="canvas">
      {/* 首帧的 transform 写在这里，不等 panzoom 的 effect：effect 跑在绘制之后，画布会先按未变换的原点画一帧。
          值取自惰性初值、之后不再变（后续变换由 applyTransform 直接改 style），React 不会回头覆盖它 */}
      {/* 聚焦屏或组件时不画小地图：它压在可用区左上角，会挡住聚焦屏上那一块的点击 */}
      {p.minimap && !p.focusedId && !p.focusedComponentId && <Minimap rects={miniRects} onView={onView} onPanTo={panTo} onMoveView={moveView} />}
      <div ref={worldRef} className="world" style={initialWorldStyle}>
        {/* 连线的计数徽标是 HTML，不是 SVG <text>：祖先的缩放比例一变，Chrome 要按新比例重排每一段 SVG 文字，
            100 屏时每一步缩放都要重排上百个徽标。HTML 文字随 transform 缩放不重排 */}
        {p.showLinks && edges.length > 0 && (<>
          <svg className="edges" width={1} height={1} aria-hidden="true" data-testid="link-edges">
            <defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {edges.map((e) => {
              const from = byId[e.from]; const to = byId[e.to];
              if (!from || !to) return null;
              const reverse = edges.some((r) => r.from === e.to && r.to === e.from);
              const { d } = edgePath(from, to, reverse ? (e.from < e.to ? -36 : 36) : 0);
              return (
                <g key={`${e.from}>${e.to}`} data-testid="link-edge" data-count={e.count}>
                  <path d={d} markerEnd="url(#edge-arrow)" />
                </g>
              );
            })}
          </svg>
          {edges.map((e) => {
            const from = byId[e.from]; const to = byId[e.to];
            if (!from || !to) return null;
            const reverse = edges.some((r) => r.from === e.to && r.to === e.from);
            const { mx, my } = edgePath(from, to, reverse ? (e.from < e.to ? -36 : 36) : 0);
            return <span key={`${e.from}>${e.to}`} className="edge-count" aria-hidden="true" style={{ transform: `translate(${mx - 14}px, ${my - 11}px)` }}>{e.count}</span>;
          })}
        </>)}
        {/* 按住空格时从风格指南卡上起手同样是平移（v0.80）：不带 nopan、不接住按下；获焦（只会来自键盘）时镜头把它摆进可用区 */}
        <div className={`styleguide${panReady ? '' : ' nopan'}${p.styleGuideSelected ? ' selected' : ''}`} style={{ transform: `translate(${STYLE_GUIDE_POS.x}px, ${STYLE_GUIDE_POS.y}px)` }}
          onPointerDown={(e) => { if (spaceDown.current) return; e.stopPropagation(); p.onSelectStyleGuide(); }} onMouseDown={keepPointerFocus}
          onFocus={() => ensureVisible({ ...STYLE_GUIDE_POS, ...styleGuideSize(p.assets?.length ?? 0) })}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelectStyleGuide(); } }} role="button" tabIndex={0} aria-label="风格指南">
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
          const live = isFocused && !!s.previewUrl;
          const dangling = danglingBySource.get(s.id);
          const working = p.workingSubtrees.some((w) => w.screenId === s.id);
          const desktop = s.width > 600;
          // 有候选未采用的卡片：后面叠两张错位底板示意「还有几版」；展开时底板让位给展开层
          const stacked = !!s.pendingCandidates && !isFocused && p.candidateStack?.screenId !== s.id;
          return (
            <Fragment key={s.id}>
            {stacked && [2, 1].map((k) => <div key={k} className="cand-ghost" aria-hidden="true" style={{ width: s.width, height: s.height, transform: `translate(${q.x + 14 * k}px, ${q.y + 10 * k}px)`, opacity: 1 - 0.25 * k }} />)}
            <div ref={watchOnscreen} data-testid="screen-card" data-route={s.route} data-variant={s.variantOf ? 'true' : undefined} data-presentation={s.presentation} className={`card${s.presentation === 'overlay' ? ' overlay' : ''}${(marquee ? hitSet.has(s.id) || (marquee.additive && selectedSet.has(s.id)) : selectedSet.has(s.id)) ? ' selected' : ''}${isFocused ? ' focused' : ''}${live && iframeReady ? ' live' : ''}${dragPos[s.id] ? ' dragging' : ''}`} style={{ width: s.width, height: s.height, transform: `translate(${q.x}px, ${q.y}px)` }}>
              <div className="label">{s.variantOf && <span className="chip">变体</span>}{s.presentation === 'overlay' && <span className="chip">叠层</span>}<b>{s.name}</b> {s.route}{p.exemplarScreenId === s.id ? ' · 样板' : ''}{variantCount.get(s.id) ? ` · ${variantCount.get(s.id)} 个变体` : ''}{s.deviations ? ` · ${s.deviations} 处偏离` : ''}</div>
              {/* 圆角裁切只包截图 / 骨架 / iframe 这一层（v0.80）：裁整张卡的话，画在卡片上方的标签一起被裁掉 */}
              <div className="card-clip">
                {/* 截图（或骨架）始终垫在底下（v0.76）：聚焦时 iframe 盖在上面、收到 quilt:ready 前透明，就绪才接班（卡片加 live，底层藏起）——
                    双击即撤掉截图的话，iframe 加载的 1 s 多里整张卡是白的，深色屏黑→白→黑 */}
                {s.screenshotUrl ? (
                  <CardShot url={s.screenshotUrl} width={s.width} height={s.height} alt={s.name} onError={p.onShotError}
                    retryKey={shotRetry[s.id] ?? 0} onGiveUp={(failed) => markShot(s.id, failed)}
                    fallback={<CardSkeleton desktop={desktop} delay={(idx % 6) * -230} />} failed={<CardSkeleton desktop={desktop} delay={0} failed />} />
                ) : (
                  <CardSkeleton desktop={desktop} delay={(idx % 6) * -230} status={s.currentRevisionId ? '截图中' : '生成中'} />
                )}
                {live && <iframe key={reloadKey} ref={iframeRef} className={`nowheel nopan${iframeReady ? '' : ' loading'}`} src={focusedSrc ?? s.previewUrl!} title={s.name} sandbox="allow-scripts allow-same-origin allow-forms" onLoad={onFrameLoad} />}
              </div>
              {/* 截图取不到（v0.83）：盖在手势层之上、卡片正中，点了从头再取；聚焦时 iframe 接班，不出 */}
              {!isFocused && s.screenshotUrl && shotFailed.has(s.id) && (
                <button type="button" className="shot-retry nopan" data-testid="shot-retry" onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); setShotRetry((m) => ({ ...m, [s.id]: (m[s.id] ?? 0) + 1 })); }}>截图没取到 · 重试</button>
              )}
              {/* 同一张卡同时有未结清候选时错开一行：两者右上同位、同底色同尺寸，叠在一起会把角标整块盖住 */}
              {!isFocused && working && <span className={`working${s.pendingCandidates ? ' below' : ''}`} data-testid="card-working">局部修改中…</span>}
              {!isFocused && <div ref={gestureRef(s.id)} className={`gesture${panReady ? '' : ' nopan'}`} role="button" tabIndex={tabStop === s.id ? 0 : -1} aria-label={`${s.name} ${s.route}`}
                onFocus={() => onCardFocus(s.id)} onKeyDown={(ev) => onCardKey(ev, 'screen', s.id)} onMouseDown={keepPointerFocus}
                onPointerDown={(ev) => startDrag(ev, 'screen', s.id)} onDoubleClick={(ev) => { ev.stopPropagation(); focusCard(s.id); }} />}
              {/* 状态变体（REQ-CORE-025 v0.62）：聚焦的屏所在家族 ≥ 2 时卡内顶部中央出一排胶囊，点即同 iframe 换成那一份。
                  放卡内而不是卡上方：聚焦把卡顶贴到可用区上沿，卡上方那 32 px 正压在顶栏底下（RUN-112 实测点不到） */}
              {isFocused && iframeReady && family.length >= 2 && (
                <div className="variant-chips nopan" role="group" aria-label="状态变体" data-testid="variant-chips">
                  {family.map((v) => (
                    <button key={v.id} type="button" className="variant-chip" aria-pressed={shownId === v.id} data-testid="variant-chip" data-id={v.id}
                      onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); void swapVariant(v.id); }}>{v.variantOf ? v.variantName : '默认'}</button>
                  ))}
                </div>
              )}
              {isFocused && frameFailed && !iframeReady ? (
                <button type="button" className="badge failed nopan" data-testid="frame-retry" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); retryFrame(); }}>加载失败 · 重试</button>
              ) : isFocused && <div className="badge">{!iframeReady ? '加载中' : p.annotateMode ? '批注中' : p.inspectMode ? '选择元素中' : '交互中'} · {p.navStack.length ? p.navStack[p.navStack.length - 1] : s.route}{iframeReady ? (p.inspectMode ? ' · 点屏里的元素' : ` · 选元素按 ${INSPECT_KEY}`) : ''}</div>}
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
        {/* 共享组件卡（REQ-EDIT-006）：活渲染在预览域里，尺寸由它量根元素后上报；同一套选中 outline，拖动走 .gesture。
            iframe 与聚焦屏同样带 allow-same-origin：尺寸上报要按 origin 认，纯 allow-scripts 的沙箱 origin 是 "null" 对不上 */}
        {p.components.map((c) => {
          const q = compPos(c); const box = compBox(c);
          const at = compSize[c.id]; const ready = compLive.has(c.id);
          const compFocused = p.focusedComponentId;
          const selected = marquee ? compHitSet.has(c.id) || (marquee.additive && selectedCompSet.has(c.id)) : selectedCompSet.has(c.id);
          return (
            <div key={c.id} ref={watchOnscreen} data-testid="component-card" data-name={c.name} data-ready={ready || undefined} className={`comp${ready ? ' live' : ''}${selected ? ' selected' : ''}${compFocused === c.id ? ' focused' : ''}${compDrag[c.id] ? ' dragging' : ''}`} style={{ width: box.w, height: box.h, transform: `translate(${q.x}px, ${q.y}px)` }}>
              <div className="label"><b>{c.name}</b> · 用于 {c.usedBy.length} 屏</div>
              {/* 上报尺寸前：屏卡片那一套骨架垫着、iframe 透明，上报后 iframe 淡入（v0.76）。iframe 恒按整个设备渲染、平移到根元素左上角，由卡片裁切 */}
              <div className="card-clip">
                <div className="skeleton" aria-hidden="true"><div className="sk-sweep" /></div>
                <iframe
                  ref={(el) => { if (el) compFrames.current.set(c.id, el); else compFrames.current.delete(c.id); }}
                  className="nowheel nopan" src={c.previewUrl} title={c.name} sandbox="allow-scripts allow-same-origin"
                  style={{ width: p.screenSize.w, height: p.screenSize.h, transform: at ? `translate(${-at.x}px, ${-at.y}px)` : undefined }}
                />
              </div>
              {/* 交互态（与屏一致：双击进、Esc 出）。这层手势罩摘掉，指针才落得到 iframe 上；
                  **镜头不动**——组件卡是按自身内容尺寸渲染的、本来就是 1:1，没有屏那种「推到 1:1 居中」的理由，
                  为看一眼组件把整块画布推走反而丢了上下文（屏那条见 REQ-CORE-005） */}
              {compFocused !== c.id && <div ref={gestureRef(c.id)} className={`gesture${panReady ? '' : ' nopan'}`} role="button" tabIndex={tabStop === c.id ? 0 : -1} aria-label={`组件 ${c.name}`}
                onFocus={() => onCardFocus(c.id)} onKeyDown={(ev) => onCardKey(ev, 'component', c.id)} onMouseDown={keepPointerFocus}
                onPointerDown={(ev) => startDrag(ev, 'component', c.id)} onDoubleClick={(ev) => { ev.stopPropagation(); p.onFocusComponent?.(c.id); }} />}
              {/* 交互态只用一个呼吸绿点：组件名已经写在卡片标签上，角标再重复一遍就是拿走卡片右上一整条。
                  不是纯靠颜色表态——名字给了读屏，卡片本身还有强调色外框（A11Y-001） */}
              {compFocused === c.id && <span className="live-dot" role="status" aria-label="交互中" title="交互中" />}
            </div>
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
        <div className="chrome pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-xs text-fg" data-testid="armed-hint">
          {p.armed === 'annotate' ? '批注模式：点任意一屏开始' : '选择元素模式：点任意一屏开始'} · Esc 退出
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

// 屏卡片的占位：设备线框 + 光带；status 给了就是「截图中 / 生成中」这类状态标签（没有截图时），没给就是截图还在下载。
// failed = 截图重试到头仍取不到（v0.83）：线框不动、不带光带与标签，说明与「重试」由卡片盖在手势层之上给（shot-retry）
function CardSkeleton({ desktop, delay, status, failed }: { desktop: boolean; delay: number; status?: string; failed?: boolean }) {
  return (
    <div className={`skeleton${desktop ? ' desktop' : ''}${failed ? ' failed' : ''}`} style={{ animationDelay: `${delay}ms` }} role="img" aria-label={failed ? '截图没取到' : status === '生成中' ? '生成中' : status ? '截图生成中' : '截图加载中'}>
      {desktop ? (
        <><div className="sk sk-side" /><div className="sk sk-topbar" /><div className="sk sk-title" /><div className="sk sk-grid"><i /><i /><i /></div><div className="sk sk-table" /></>
      ) : (
        <><div className="sk sk-appbar" /><div className="sk sk-hero" /><div className="sk sk-line" /><div className="sk sk-line short" /><div className="sk sk-card" /><div className="sk sk-card" /><div className="sk sk-cta" /><div className="sk sk-tabbar"><i /><i /><i /><i /></div></>
      )}
      {!failed && <div className="sk-sweep" />}
      {status && <div className="sk-label"><span className="sk-dot" />{status}</div>}
    </div>
  );
}

// 卡片截图（v0.76）：截图地址变了（出新截图、签名换窗口）时新图叠在旧图上、透明，解码完成才接班；没有旧图时 fallback（骨架）留到那一刻——
// decoding=async 的图解码前那几帧画的是卡片白底，深色屏会闪一下白。仍是 loading=lazy：只有进了视野的卡才取图。
// 取图失败（多半是签名过期）交给父页静默重取签名；地址没变时那一下换不来新请求，所以同一地址自己隔 2 s、6 s 各再取一次（v0.83，DATA-006 退避限次）。
// 还取不到就收手：有旧图留旧图，没有就换成不动的 failed 并经 onGiveUp 报给卡片。地址变了或 retryKey 变了（点了「重试」）从头再来
const SHOT_RETRY_MS = [2000, 6000];
function CardShot({ url, width, height, alt, fallback, failed, retryKey, onError, onGiveUp }: { url: string; width: number; height: number; alt: string; fallback: ReactNode; failed: ReactNode; retryKey: number; onError?: () => void; onGiveUp?: (failed: boolean) => void }) {
  // 正显示的那一张：key 沿用它还在取时那个 <img> 的 key，接班时同一个元素换 class，不重挂（重挂的话 decoding=async 又要空一帧）
  const [shown, setShown] = useState<{ src: string; key: string } | null>(null);
  const key = `${retryKey}|${url}`;
  const [tries, setTries] = useState({ key, n: 0, gaveUp: false });
  const cur = tries.key === key ? tries : { key, n: 0, gaveUp: false };
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), [key]);
  const gaveUp = cur.gaveUp && shown?.src !== url;
  useEffect(() => { onGiveUp?.(gaveUp && !shown); }, [gaveUp, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onGiveUp?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  // 已经完成的图不会再触发 onLoad（缓存命中可能早于事件挂上，PERF-009）：挂上时再查一次 complete
  const settle = (img: HTMLImageElement | null, src: string, k: string) => {
    if (!img || !img.complete || img.naturalWidth === 0) return;
    void img.decode().catch(() => {}).then(() => setShown({ src, key: k }));
  };
  const fail = () => {
    onError?.();
    window.clearTimeout(timer.current);
    if (cur.n >= SHOT_RETRY_MS.length) { setTries({ ...cur, gaveUp: true }); return; }
    timer.current = window.setTimeout(() => setTries({ key, n: cur.n + 1, gaveUp: false }), SHOT_RETRY_MS[cur.n]);
  };
  // 还要去取的那一张：旧图在时叠在上面、透明；重试换 key 让 <img> 重挂，同一地址才会再发一次请求
  const want = shown?.src === url || gaveUp ? null : url;
  const wantKey = cur.n ? `${url}#${cur.n}` : url;
  return (
    <>
      {!shown && (gaveUp ? failed : fallback)}
      {shown && <img key={shown.key} src={shown.src} className="shot" width={width} height={height} decoding="async" alt={alt} draggable={false} />}
      {want && (
        <img key={wantKey} src={want} className="shot pending" width={width} height={height} loading="lazy" decoding="async" alt="" draggable={false}
          ref={(el) => settle(el, want, wantKey)} onLoad={(e) => settle(e.currentTarget, want, wantKey)} onError={fail} />
      )}
    </>
  );
}
