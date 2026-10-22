import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { XYPanZoom, PanOnScrollMode, type PanZoomInstance, type Viewport } from '@xyflow/system';
import type { ViewInfo } from '@/canvas/Minimap';
import { MIN_ZOOM, MAX_ZOOM } from '@/canvas/geometry';
import { recordEvent } from '@/lib/recorder';

// 滚轮平移速度：画布上的滚轮（panzoom）与交互态组件卡转发来的滚轮（v0.80）同一个值
export const WHEEL_PAN_SPEED = 0.5;
// 手势中往小缩到冻结栅格比例的这个倍数以下就重画一次（v0.86，见 applyTransform）
const RERASTER_RATIO = 0.7;
// 系统「减少动态效果」下镜头移动一律直接到位（v0.80，MOTION-004）：适配视图、自动适配、聚焦推镜头、找屏跳转、小地图点击
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// 存下来的镜头要按当前数据校验再用（INT-019）：缩放超出 panzoom 的 [MIN_ZOOM, MAX_ZOOM] 或存进去的是 NaN / 旧格式，
// 一律当没存过回默认，别把画布恢复成一片空白或卡在够不着的倍率上。
function readView(key: string): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Viewport | null;
    if (!v || ![v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return v.zoom >= MIN_ZOOM && v.zoom <= MAX_ZOOM ? v : null;
  } catch { return null; }
}

/**
 * 画布镜头（ADR-002 / ADR-006，v1.07 从 CanvasView.tsx 抽出）：世界层 transform 由 @xyflow/system 驱动，镜头按项目落盘，
 * 空格按住是平移就绪。onFrame 每次变换都调（平移缩放逐帧），onStop 在手势停下 200 ms 后调；两者都按调用方最近一次渲染给的取
 */
export function useViewport(o: { projectId: string; safeAreaRef?: { current: HTMLElement | null }; onFrame: (v: Viewport) => void; onStop: (v: Viewport) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const panZoom = useRef<PanZoomInstance | null>(null);
  const opts = useRef(o);
  opts.current = o;
  // 平移缩放是用户手摆出来的视图偏好，按项目存、跨会话留（INT-019）。惰性初值读一次，**首帧就是终值**——
  // 用 useEffect 补会先画一帧初始位置再跳过去，用户看到的就是「刷新一次镜头自己动一下」（INT-021）。
  const viewKey = `quilt:view:${o.projectId}`;
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
  const spaceDown = useRef(false);
  // 空格按住 = 平移就绪：只有这时指针才是抓手；平时是箭头（空白处按下是框选，不是拖画布）
  const [panReady, setPanReady] = useState(false);
  const [dragging, setDragging] = useState(false);

  // 落盘防抖 300 ms：平移缩放每帧都在变，逐帧写存储会把拖拽拖掉帧（INT-021）。无痕模式写不了就算了，
  // 退化成只本次会话有效，不能让存储异常打断渲染。
  const saveTimer = useRef<number | null>(null);
  // 平移缩放进行中给世界层挂 will-change 让它独立合成：不挂的话每改一次 transform 整层都要重新光栅化，
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
      movingTimer.current = window.setTimeout(() => { world.classList.remove('moving'); world.style.setProperty('--canvas-zoom', String(vp.current.zoom)); movingTimer.current = null; opts.current.onStop(vp.current); recordEvent('viewport', undefined, { x: Math.round(vp.current.x), y: Math.round(vp.current.y), zoom: Math.round(vp.current.zoom * 1000) / 1000 }); }, 200);
    }
    opts.current.onFrame(v);
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
    const inst = XYPanZoom({ domNode: node, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, viewport: vp.current, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]], onDraggingChange: setDragging,
      onPanZoomStart: (ev) => { if (ev) { autoView.current = false; scheduleSave(); } } });
    panZoom.current = inst;
    updatePanZoom();
    // 首帧镜头要么是记住的、要么是自动适配出来的，都不是这一次手摆的：不落盘
    autoView.current = true; applyTransform(vp.current); autoView.current = false;
    return () => inst.destroy();
  }, [applyTransform, updatePanZoom, scheduleSave]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable]');
      // 空格在按钮、链接、下拉、选项上是「激活」，不是平移——只在画布或页面空处按下时才进入平移就绪
      const control = target?.closest('button, a[href], summary, [role=button], [role=option], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem]');
      if (e.code === 'Space' && !e.repeat && !typing && !control) { spaceDown.current = true; setPanReady(true); updatePanZoom(); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceDown.current = false; setPanReady(false); updatePanZoom(); } };
    // 面板 / 顶栏上的触控板捏合会触发浏览器整页缩放（header 被顶出视口）；画布之外一律拦掉，Cmd +/- 不受影响
    const pinch = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('wheel', pinch, { passive: false });
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('wheel', pinch); };
  }, [updatePanZoom]);

  // 用户动作带来的镜头移动（适配视图、找屏跳转、小地图、聚焦推镜头、屏内捏合）：先撤掉自动适配标记，否则被它打断的那段自动适配会让这一次也不落盘
  const moveTo = useCallback((v: Viewport, opt?: { duration?: number }) => { autoView.current = false; void panZoom.current?.setViewport(v, opt?.duration && reducedMotion() ? { duration: 0 } : opt); }, []);
  // 自动适配：变换照常施加，只是不落盘（见 autoView）；用户手势打断时由 onPanZoomStart 撤标记
  const autoMove = useCallback((v: Viewport, ms: number) => {
    const pz = panZoom.current;
    if (!pz) return;
    const duration = reducedMotion() ? 0 : ms;
    autoView.current = true;
    void pz.setViewport(v, { duration }).then(() => { autoView.current = false; });
    if (!duration) autoView.current = false;
  }, []);
  // 首帧（panzoom 建起来之前，布局阶段）就摆好的镜头：直接写进世界层，panzoom 随后以它为初值
  const placeFirstFrame = useCallback((v: Viewport) => {
    vp.current = v;
    if (worldRef.current) { worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`; worldRef.current.style.setProperty('--canvas-zoom', String(v.zoom)); }
  }, []);
  const isMoving = useCallback(() => movingTimer.current !== null, []);

  // 可用区 = 画布减去四周浮层的占位；几何由 CSS 变量驱动的探针元素给出，这里只测不算
  const safeArea = useCallback(() => {
    const node = viewportRef.current!;
    const el = opts.current.safeAreaRef?.current;
    if (!el) return { x: 0, y: 0, w: node.clientWidth, h: node.clientHeight };
    const nr = node.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { x: r.left - nr.left, y: r.top - nr.top, w: Math.max(240, r.width), h: Math.max(240, r.height) };
  }, []);

  return { viewportRef, worldRef, initialWorldStyle, savedView, vp, touched, spaceDown, panReady, dragging, moveTo, autoMove, placeFirstFrame, isMoving, safeArea, onView };
}
