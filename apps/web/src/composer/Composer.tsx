import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react';
import { useSearchParams } from 'react-router';
import { DropdownMenu, Select } from 'radix-ui';
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, ImagePlus, MapPin, PenLine, Settings2, X } from 'lucide-react';
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_VERSIONS, SCREEN_COUNT_OPTIONS, estimateJob, type ScreenDto, type ComponentDto, type RunnerOptionDto, type AgentSessionDto, type AgentTool, type ScreenCount } from '@quilt/core/browser';
import { cn, IconButton } from '@/ui/ui';
import { recordEvent } from '@/lib/recorder';
import { VendorIcon } from '@/ui/VendorIcon';
import { useT } from '@/i18n';
import composerMessages from '@/i18n/locales/composer';
import type { ComposerDock, DockEdge } from './useComposerDock';
import { JobChips, type JobChip } from './JobChips';

/** fill（草稿本空看板的示例，REQ-CORE-040）：只换文字、参考图留着，并聚焦输入框 */
export type ComposerHandle = { focus: () => void; fill: (text: string) => void };
type ComposerProps = {
  /** 作业 chip（PAGE-CANVAS「作业 chip」v1.17），按创建时间倒序（最新在最前）；叠在输入框（收起时是胶囊）上方，不占输入框的高度 */
  jobs: JobChip[];
  onCancelJob: (jobId: string) => void;
  /** 失败 chip 的「重试」（API-CORE-034）与 ×；重试的 Promise 落定前按钮转圈 */
  onRetryJob: (jobId: string) => Promise<void>;
  onDismissJob: (jobId: string) => void;
  /** 这一轮与在跑作业冲突时的理由；非 null 就挡住发送，但不锁输入（REQ-CORE-020） */
  blockedReason: string | null;
  /** 目标屏 = 改；为空 = 造（REQ-CORE-006 三条原则之一） */
  targets: ScreenDto[];
  /** 共享组件目标（REQ-EDIT-006）：只有组件、没有屏也没有锚点 = 改这个组件；与屏 / 锚点同在 = 它们的完整 HTML 进上下文 */
  componentTargets: ComponentDto[];
  onRemoveComponentTarget: (id: string) => void;
  /** 项目总屏数：目标等于全部时动词行写「改全部」 */
  totalScreens: number;
  /** 双击空白处放下的锚点（REQ-CORE-014）；有它就是「造 · 此处」 */
  anchor: { x: number; y: number } | null;
  maxTargets: number;
  count: ScreenCount;
  versions: number;
  onCount: (c: ScreenCount) => void;
  onVersions: (v: number) => void;
  /** 返回是否发出去了：false 时草稿与参考图留着（REQ-CORE-020） */
  onSend: (content: string, attachmentIds: string[]) => Promise<boolean>;
  /** 参考图上传（REQ-CORE-012）：返回 attachmentId */
  onUploadImage: (file: File) => Promise<string>;
  onError: (msg: string) => void;
  onRemoveTarget: (id: string) => void;
  onRemoveAnchor: () => void;
  onClearTargets: () => void;
  /** 生成通道（REQ-CORE-011）：这一轮由谁来做 */
  runners: RunnerOptionDto[];
  /** 通道清单没取到（v0.76）：通道位写明并给重试，不当成空 */
  runnersFailed?: boolean;
  onReloadRunners?: () => void;
  runnerId: string;
  onRunnerChange: (id: string) => void;
  /** 本机 agent（REQ-AGENT-003 v0.34 / v0.68）：通道是「交给本机 Claude Code / Codex」时还要选投给哪个会话；列表打开时由父组件刷新，null = 还没取到；
   *  sessionsReason：列表为什么是空的（例如读不到 Codex 线程库） */
  sessions: AgentSessionDto[] | null;
  sessionsReason?: string;
  sessionTool: AgentTool | null;
  sessionId: string;
  onSessionChange: (id: string) => void;
  onSessionsOpen: () => void;
  /** 收起（⌘/ / 右上角「收起」/ 聚焦某屏时自动）：只是不显示，草稿与参考图都留着，所以不卸载；收起期间同一条边、同一位置留一枚胶囊 */
  hidden: boolean;
  /** 停靠（PAGE-CANVAS「停靠与收起」v1.16）：停在哪条边、沿边的位置、拖动与按键之后的提交、收起开关；
   *  量到的大小经 onMeasure 报给外壳——它据此定实际停的边、让位与 toast 的落点（输入框随内容增高、窄视口下工具条折行，写死一个数会压住别的浮层） */
  dock: ComposerDock;
  /** 输入框这一条横带的探针（画布提供）：让开左右浮层之后输入框还能有多宽——通道名要不要截短、工具条要不要折行按它判 */
  laneRef?: { current: HTMLElement | null };
  handle?: Ref<ComposerHandle>;
  /** 草稿本（REQ-CORE-040）：不显示目标标签、屏数与版数；动词行与占位示例由草稿本页给，extra 插在工具条右组（新草稿的画框选择）。
   *  onEmptyEscape：输入框空着时按 Esc 交给页面（收起看板），不失焦。
   *  chips：草稿里点选的那几块（REQ-CORE-045，v1.26 按住 Shift 可选几块），每块一枚，与目标标签同形、各自可移除 */
  sketch?: { verb: string; phrases: string[]; extra?: ReactNode; onEmptyEscape?: () => void; chips?: { key: string; label: string; onRemove: () => void }[]; onClimb?: (dir: 'up' | 'down') => void };
};

// 空闲且没有目标时轮播的示例：让第一次进来的人知道能说什么（文案在 composer 命名空间的 idle.*）
const IDLE_PHRASES = ['describe', 'ledger', 'checkout', 'pullRefresh'] as const;
const ROTATE_MS = 3200;
/** 可用宽度差一点时通道触发器最多截到多窄（rem）：再窄连通道名的头几个字都看不出（v0.78） */
const RUNNER_MIN_REM = 6;
/** 拖输入框：按下后移动超过这么远才算拖（MOTION-017），之前仍是普通点按 */
const DRAG_SLOP = 10;
const CMD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 待发的参考图：key 是本地身份，id 是上传完成后服务端给的；id 为 null 表示还在传 */
type Shot = { key: string; url: string; name: string; id: string | null };

// 底部输入框（REQ-CORE-003 / REQ-CORE-006）：动词由目标决定——有目标标签是改、没有是造。
// 有作业在跑不锁输入（REQ-CORE-020）：只有这一轮与在跑作业真冲突时才挡住发送键并就地写出理由。
// 不自动聚焦——焦点默认留在画布上，单键快捷键（F/L…）才可用；放锚点时由父组件显式聚焦。
// 结构：目标区（标签 + 动词行 + 清空）→ 输入区 → 工具条（通道 ｜ 参考图 ｜ 屏数 · 版数 ｜ 发送）；作业 chip 叠在它上方。外壳的材质与投影在 styles.css 的 .composer。
export function Composer(p: ComposerProps) {
  const t = useT(composerMessages);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dropping, setDropping] = useState(false);
  // 参考图：本地先用 objectURL 立刻显示缩略图，上传在后台跑；id 到了再回填
  const [shots, setShots] = useState<Shot[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  // 收起时焦点给胶囊：输入区 display:none 了，focus() 会静默落空（A11Y-011）
  const hiddenRef = useRef(p.hidden);
  hiddenRef.current = p.hidden;
  useImperativeHandle(p.handle, () => ({
    focus: () => (hiddenRef.current ? pillRef.current : taRef.current)?.focus(),
    fill: (next) => { setText(next); taRef.current?.focus(); },
  }), []);

  // ---- 停靠（PAGE-CANVAS「停靠与收起」v1.16） ----
  const { edge, at, narrow } = p.dock;
  // 左右两条可用段与底边可用段的探针（styles.css 的 .composer-seg，位置全由外壳的 --seg-* / --side-* 给）：
  // 量长度判放不放得下，松手时沿边位置也按它们算
  const segLeftRef = useRef<HTMLSpanElement>(null);
  const segRightRef = useRef<HTMLSpanElement>(null);
  const segBottomRef = useRef<HTMLSpanElement>(null);
  // 外层（styles.css 的 .composer-dock）按停的边落位，里面是输入框或胶囊，上方叠着作业 chip：拖动跟手与落位动画都只动外层，chip 跟着卡片一起走
  const dockRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  // 收起 / 展开就地换形：停在底边时 left 按卡片宽重算，样式表里的 left 过渡会让胶囊从输入框左缘滑到正中（展开时反过来）。
  // 换形这一帧关掉外层的过渡，下一帧恢复；必须写在下面量尺寸的 effect 前面——它一读布局，过渡就按旧值起跑了
  const shapeShown = useRef(p.hidden);
  useLayoutEffect(() => {
    const box = dockRef.current;
    if (!box || shapeShown.current === p.hidden) return;
    shapeShown.current = p.hidden;
    box.style.transition = 'none';
    const raf = requestAnimationFrame(() => { void box.offsetWidth; box.style.transition = ''; });
    return () => { cancelAnimationFrame(raf); box.style.transition = ''; };
  }, [p.hidden]);
  // 把正显示的那一个（输入框或胶囊）的大小、上方 chip 叠的高与两条可用段的长度报给外壳。首次在 layout effect 里量，首帧就按实际停的边画（INT-021）；之后靠 ResizeObserver。
  // 胶囊的宽顺手写进外层的 --pill-w：收起停在底边时横向 clamp 要用
  const onMeasure = p.dock.onMeasure;
  useLayoutEffect(() => {
    const el: HTMLElement | null = p.hidden ? pillRef.current : formRef.current;
    const box = dockRef.current; const stack = stackRef.current;
    const l = segLeftRef.current; const r = segRightRef.current;
    if (!el || !box || !stack || !l || !r) return;
    const measure = () => {
      if (!el.offsetWidth) return;
      if (el === pillRef.current) box.style.setProperty('--pill-w', `${el.offsetWidth}px`);
      onMeasure({ w: el.offsetWidth, h: el.offsetHeight, stack: stack.offsetHeight, left: l.offsetHeight, right: r.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const x of [el, stack, l, r]) ro.observe(x);
    return () => ro.disconnect();
  }, [p.hidden, onMeasure]);
  // 收起时焦点若在输入框里（按 ⌘/、点了右上角「收起」），交给胶囊，不掉到 body（A11Y-013）
  useLayoutEffect(() => {
    if (p.hidden && formRef.current?.contains(document.activeElement)) pillRef.current?.focus();
  }, [p.hidden]);

  // 读屏播报：换了停靠位置说一声（把手的说明里另有「现在停在哪条边」）
  const [said, setSaid] = useState('');
  // 落位动画（200 ms，减少动态效果时直接到位）：提交新位置前记下画面上的框，提交后从那里滑到新位置——FLIP，只动 transform。
  // 动画期间内联的 transition 顶掉样式表里的 width / left / top 过渡，位置只走这一条
  const flipFrom = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const from = flipFrom.current;
    const el = dockRef.current;
    if (!from || !el) return;
    flipFrom.current = null;
    el.style.transition = 'none';
    el.style.transform = '';
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left; const dy = from.top - to.top;
    if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.style.transition = ''; return; }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    void el.offsetWidth;  // 先把起点画上，过渡才有起点
    el.style.transition = 'transform var(--semantic-motion-duration-base) var(--semantic-motion-easing-standard)';
    el.style.transform = '';
    const done = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== 'transform') return;
      el.style.transition = '';
      el.removeEventListener('transitionend', done);
    };
    el.addEventListener('transitionend', done);
  });
  // 定位置并提交：侧边放不下（卡片比可用段高）就落到底边。from = 松手时卡片在画面上的框（拖动），null = 按键 / 菜单，停在那条边的正中
  const place = (to: DockEdge, from: DOMRect | null) => {
    const el = dockRef.current;
    const shell = el?.offsetParent?.getBoundingClientRect();
    if (!el || !shell) return;
    if (narrow && to !== 'bottom') { setSaid(t('dock.narrowOnly')); return; }
    let next = to;
    let pos = 0.5;
    if (next !== 'bottom') {
      const seg = (next === 'left' ? segLeftRef : segRightRef).current?.getBoundingClientRect();
      const room = seg ? seg.height - el.offsetHeight : -1;
      if (room < 0) next = 'bottom';
      else if (from && seg && room > 0) pos = clamp01((from.top - seg.top) / room);
    }
    // 底边的 at 按整条底边算（at = 0.5 是视口正中），松手位置先夹进两侧浮层之间——与 styles.css 里那条 clamp 同一算法
    if (next === 'bottom' && from) {
      const seg = segBottomRef.current?.getBoundingClientRect();
      const w = el.offsetWidth;
      const x = seg ? Math.max(seg.left, Math.min(from.left, seg.right - w)) : from.left;
      pos = shell.width > w ? clamp01((x - shell.left) / (shell.width - w)) : 0.5;
    }
    flipFrom.current = from ?? el.getBoundingClientRect();
    p.dock.onMove(next, pos);
    setSaid(next === to ? t('dock.moved', { edge: t(`dock.edgeIn.${next}`) }) : t('dock.noRoom', { from: t(`dock.edgeIn.${to}`), edge: t(`dock.edgeIn.${next}`) }));
  };
  // 拖动输入框 / 胶囊：按下时还不算拖，越过 DRAG_SLOP 才开始 1:1 跟手（从抓住的那一点算位移）并抓住指针（MOTION-017 / MOTION-028），
  // 之前的点按照常是点按（胶囊照样展开、把手照样开菜单）。跟手只写这个元素的 transform（PERF-005），拖动中不吸附；
  // 拖动期间页面里的 iframe 不接指针（styles.css 的 [data-composer-drag]），否则指针一进画布或看板里的预览，父页就收不到 move / up
  const dragged = useRef(false);
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const el = dockRef.current;
    if (!el || e.button !== 0 || !e.isPrimary) return;
    // 不选中文字、不把焦点从输入区挪走；把手上还顺带挡住菜单在按下时就打开
    e.preventDefault();
    dragged.current = false;
    const id = e.pointerId; const sx = e.clientX; const sy = e.clientY;
    // 从画面上此刻的位置起：上一次的落位动画可能还没走完
    const shown = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = '';
    const rest = el.getBoundingClientRect();
    const ox = shown.left - rest.left; const oy = shown.top - rest.top;
    const put = (x: number, y: number) => { el.style.transform = x || y ? `translate(${x}px, ${y}px)` : ''; };
    put(ox, oy);
    const root = document.documentElement;
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      delete root.dataset.composerDrag;
      const shell = el.offsetParent?.getBoundingClientRect();
      if (!dragged.current || !shell) { el.style.transition = ''; put(0, 0); return; }
      // 松手：吸到离指针最近的那条边（只在左、右、下里选；窄视口只停底边），沿边停在松手的位置
      const px = ev.clientX - shell.left; const py = ev.clientY - shell.top;
      const dist: [DockEdge, number][] = [['left', px], ['right', shell.width - px], ['bottom', shell.height - py]];
      place(narrow ? 'bottom' : dist.reduce((a, b) => (b[1] < a[1] ? b : a))[0], el.getBoundingClientRect());
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      // 松开时的 up 没送到（在别处松的手）：没有按键按着就当结束（MOTION-028）
      if (ev.buttons === 0) { finish(ev); return; }
      const dx = ev.clientX - sx; const dy = ev.clientY - sy;
      if (!dragged.current) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        dragged.current = true;
        root.dataset.composerDrag = '';
        try { el.setPointerCapture(id); } catch { /* 指针已经抬起 */ }
      }
      // 窄视口只停底边：只在底边内左右挪
      put(ox + dx, narrow ? oy : oy + dy);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  // 动词行的空白处才是抓手：标签上的 ×、「清空」、「收起」这些按钮照常点
  const onRowPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
    startDrag(e);
  };
  const visionOk = p.runners.find((r) => r.id === p.runnerId)?.vision !== false;
  // 投给谁：通道是本机 agent 时必须选一个还活着的会话；记住的会话不在活列表里就当没选，不自动换人
  const agentRunner = p.runners.find((r) => r.id === p.runnerId)?.runner.kind === 'agent';
  const sessionOk = !agentRunner || !!p.sessions?.some((s) => s.sessionId === p.sessionId);
  // 有作业在跑只影响两件事：工具条的亮度（data-busy）与上方作业 chip 的显示，不作为任何禁用条件（REQ-CORE-020）
  const busy = p.jobs.some((j) => j.state === 'running');
  const creating = p.targets.length === 0;
  const one = p.targets.length === 1 ? p.targets[0] : null;
  const over = p.targets.length > p.maxTargets;
  const all = !creating && p.totalScreens > 0 && p.targets.length >= p.totalScreens;
  // 共享组件目标（REQ-EDIT-006）：只有组件、没有屏也没有锚点 = 改组件（一次一个，多选由父组件的 blockedReason 挡）；否则只是上下文
  const comps = p.componentTargets;
  const compNames = comps.map((c) => c.name).join(t('verb.nameSep'));
  const compOnly = comps.length > 0 && creating && !p.anchor;
  const compSuffix = comps.length && !compOnly ? ` · ${t(creating ? 'verb.withComponents' : 'verb.alongComponents', { count: comps.length, names: compNames })}` : '';

  // 宽度跟着工具条走：这一行是输入框里最宽的东西，其余（动词行、占位、草稿）都比它短。
  // 量法是把工具条临时设成 max-content 读一次——那是它排成一行的真实宽度，与外壳当前多宽无关，
  // 所以「量到的值 → 改外壳宽 → 再量」不会来回振荡。读完当帧还原，不落到画面上。
  // 放 useLayoutEffect 里是为了首帧就是终值：改成 useEffect 会先按回退宽度画一帧再跳（INT-021）。
  const barRef = useRef<HTMLDivElement>(null);
  const lane = p.laneRef;
  // runnerMax：差一点放不下时通道触发器截到多宽（px，null = 不截）；wrap：'bar' 右组整组落到第二行，'all' 连左组自己都放不下一行、两组内部各自折行
  const [bar, setBar] = useState<{ need: number; runnerMax: number | null; wrap: false | 'bar' | 'all' }>({ need: 0, runnerMax: null, wrap: false });
  const measureBar = useCallback(() => {
    const el = barRef.current; const form = formRef.current;
    if (!el || !form || p.hidden) return;
    // 量的是不截短时的一行宽度：触发器上截短用的内联 max-width 只在量的这一刻撤掉
    const trig = el.querySelector<HTMLElement>('[data-testid="runner-select"]');
    const squeezed = trig?.style.maxWidth ?? '';
    if (trig) trig.style.maxWidth = '';
    const prev = el.style.width;
    el.style.width = 'max-content';
    const need = el.getBoundingClientRect().width;
    const left = (el.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? need;
    const trigW = trig?.getBoundingClientRect().width ?? 0;
    el.style.width = prev;
    if (trig) trig.style.maxWidth = squeezed;
    // 外壳自己的内边距与边框；工具条量的是内容宽，两者相加才是外壳该有的宽
    const chrome = form.offsetWidth - el.offsetWidth;
    // 输入框这一条横带有多宽：读画布的探针，不要去 parse --composer-left——自定义属性取回来是没求值的
    // calc(...)，parseFloat 得 NaN，判断会静默恒假、窄视口下工具条被裁掉够不到。也不能拿正在过渡的
    // form.offsetWidth 判，那是中间值。
    const avail = lane?.current?.getBoundingClientRect().width ?? Infinity;
    // 差一点放不下：先截短通道名（最窄 6rem），截到头仍放不下才折行（v0.78）——为几十 px 整条折行，参考图按钮会单独掉到第二行、档位组悬在两行中间
    const short = need + chrome - avail;
    const room = trigW - RUNNER_MIN_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const next = short <= 1 ? { need: Math.ceil(need + chrome), runnerMax: null, wrap: false as const }
      : short <= room ? { need: Math.floor(avail), runnerMax: Math.floor(trigW - short), wrap: false as const }
      : { need: Math.ceil(need + chrome), runnerMax: null, wrap: left + chrome > avail + 1 ? 'all' as const : 'bar' as const };
    setBar((v) => (Math.abs(v.need - next.need) < 1 && v.runnerMax === next.runnerMax && v.wrap === next.wrap ? v : next));
  }, [p.hidden, lane]);
  // 量一次要强制布局两回，每次渲染都量会拖慢打字：只在工具条内容变了（文字、控件增减、显隐）时量。
  // 读 textContent 与元素个数不触发布局；宽度变化另有下面的 ResizeObserver 与字体加载两条路
  const barSig = useRef('');
  useLayoutEffect(() => {
    const el = barRef.current;
    const sig = el ? `${p.hidden}|${el.getElementsByTagName('*').length}|${el.textContent}` : '';
    if (sig === barSig.current) return;
    barSig.current = sig;
    measureBar();
  });
  // 宽度过渡在首次量完的下一帧才启用（v0.78）：与第一次写入宽度落在同一帧的话，浏览器按量宽时算过的 30rem 起跑过渡，
  // 每次加载都先长一下。通道清单还没到时不启用——触发器随后才出现，那一下变宽不该滑
  const [measured, setMeasured] = useState(false);
  const hasRunners = p.runners.length > 0;
  useEffect(() => {
    if (measured || !bar.need || !hasRunners) return;
    const id = requestAnimationFrame(() => setMeasured(true));
    return () => cancelAnimationFrame(id);
  }, [measured, bar.need, hasRunners]);
  // 字体晚于首帧到达时控件会变宽，补量一次
  useEffect(() => { document.fonts?.ready.then(measureBar).catch(() => {}); }, [measureBar]);
  // 可用宽度变了要重量：改窗口大小、开合侧边面板都不经过 React 渲染，只靠上面那个 useLayoutEffect
  // 量不到——工具条会停在缩窄前算出的 nowrap 上，被外壳裁掉的那截（屏数 / 版数 / 发送）点都点不到。
  // 画布的可用区探针正是「让开四周浮层之后还剩多少」，拿它当信号；探针不在时退回窗口 resize。
  useEffect(() => {
    const el = lane?.current;
    if (!el) {
      const onResize = () => measureBar();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const ro = new ResizeObserver(() => measureBar());
    ro.observe(el);
    return () => ro.disconnect();
  }, [lane, measureBar]);

  // 卸载时回收 objectURL，否则贴一次图泄一块内存
  useEffect(() => () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); }, [shots]);
  // 剩余名额读这个 ref、不读渲染闭包：两批贴得很近时，第二批还看不到第一批的渲染结果（REQ-CORE-012 v0.74）
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  // 同一批的图一次性全进缩略图（各自「上传中…」），再并行上传
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    // 通道不支持视觉时在这里就拦住。护栏必须落在贴图这一刻——贴图、拖入、点按钮三条路都经过这里；
    // 只在发送时拦的话，用户已经传完了才被告知白传（服务端那道校验仍在，防绕过）
    if (!visionOk) { p.onError(t('shots.noVision')); return; }
    const imgs = files.filter((f) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(f.type));
    const rejected = files.length - imgs.length;
    if (rejected) p.onError(t('shots.notImage', { count: rejected }));
    const room = MAX_ATTACHMENTS_PER_MESSAGE - shotsRef.current.length;
    if (imgs.length > room) p.onError(t('shots.tooMany', { max: MAX_ATTACHMENTS_PER_MESSAGE }));
    const batch = imgs.slice(0, Math.max(0, room)).filter((file) => {
      if (file.size <= MAX_ATTACHMENT_BYTES) return true;
      p.onError(t('shots.tooLarge', { name: file.name, mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
      return false;
    }).map((file) => ({ file, shot: { key: crypto.randomUUID(), url: URL.createObjectURL(file), name: file.name, id: null } as Shot }));
    if (!batch.length) return;
    shotsRef.current = [...shotsRef.current, ...batch.map((b) => b.shot)];
    setShots((prev) => [...prev, ...batch.map((b) => b.shot)]);
    recordEvent('attach', undefined, { op: 'add', files: batch.map(({ file }) => ({ name: file.name, type: file.type, bytes: file.size })) });
    for (const { file, shot } of batch) {
      p.onUploadImage(file).then(
        (id) => { recordEvent('attach', undefined, { op: 'uploaded', name: file.name, attachmentId: id }); setShots((prev) => prev.map((s) => (s.key === shot.key ? { ...s, id } : s))); },
        () => { recordEvent('attach', undefined, { op: 'failed', name: file.name }); setShots((prev) => prev.filter((s) => s.key !== shot.key)); p.onError(t('shots.failed', { name: file.name })); },
      );
    }
  };
  const removeShot = (key: string) => {
    recordEvent('attach', undefined, { op: 'remove', name: shotsRef.current.find((s) => s.key === key)?.name });
    setShots((prev) => { prev.filter((s) => s.key === key).forEach((s) => URL.revokeObjectURL(s.url)); return prev.filter((s) => s.key !== key); });
  };

  const uploading = shots.some((s) => !s.id);
  // 冲突之外挡住发送的本地原因：按 Enter 被它们挡住时写在冲突理由同一行，原因消失即撤（REQ-CORE-020 v0.74）
  const localReason = uploading ? t('blocked.uploading') : !sessionOk ? t('blocked.pickSession') : null;
  const [nudged, setNudged] = useState(false);
  useEffect(() => { if (!localReason) setNudged(false); }, [localReason]);
  const shownReason = p.blockedReason ?? (nudged ? localReason : null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const content = text.trim();
    if (!content || sending || p.blockedReason) return;
    if (localReason) { setNudged(true); return; }
    setSending(true);
    // 在途期间照样能打字、贴图（REQ-CORE-020）：发送成功只去掉发出去的那段文字与那几张图
    const sentText = text;
    const sentKeys = new Set(shots.map((s) => s.key));
    try {
      // 没发出去（撞上 409 / 限流 / 会话失效）就留着草稿与参考图，不把用户的输入吞掉（REQ-CORE-020）
      const sent = await p.onSend(content, shots.map((s) => s.id!).filter(Boolean));
      if (sent) {
        setText((cur) => (cur.startsWith(sentText) ? cur.slice(sentText.length).trimStart() : cur));
        shotsRef.current.filter((s) => sentKeys.has(s.key)).forEach((s) => URL.revokeObjectURL(s.url));
        setShots((prev) => prev.filter((s) => !sentKeys.has(s.key)));
      }
    } finally { setSending(false); }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDropping(false);
    addFiles([...e.dataTransfer.files]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 草稿本：还没打字、上面有选中块的胶囊时，Shift+↑ / Shift+↓ 走层级（同画布逐级选，v1.28）；打了字之后照旧是扩选文字
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && p.sketch?.onClimb && p.sketch.chips?.length && !text.trim()) {
      e.preventDefault(); p.sketch.onClimb(e.key === 'ArrowUp' ? 'up' : 'down'); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); return; }
    // 输入框内 Esc：有草稿清草稿、无草稿失焦；都不清目标标签（REQ-CORE-006）。草稿本里无草稿时是收起看板，焦点留在输入框
    if (e.key === 'Escape') { e.stopPropagation(); if (text) clearDraft(); else if (p.sketch?.onEmptyEscape) p.sketch.onEmptyEscape(); else taRef.current?.blur(); }
  };
  // 清草稿走浏览器的编辑命令：程序写 value（setText('')）会清掉原生撤销栈，⌘Z 就找不回来了（v0.74）
  const clearDraft = () => {
    const el = taRef.current;
    if (!el) return;
    el.select();
    if (!document.execCommand('delete')) setText('');
  };

  // 动词行（REQ-CORE-006）：屏数 × 版数写全；任一档位 > 1 时追加预计调用数，取值与服务端同一个 estimateJob
  const n = creating ? (p.count === 'auto' ? 5 : p.count) : Math.min(p.targets.length, p.maxTargets);
  const estimate = creating
    ? estimateJob({ kind: 'generate', input: { prompt: 'x', count: p.count, versions: p.versions } }, p.totalScreens)
    : estimateJob({ kind: 'edit_screens', input: { prompt: 'x', screenIds: p.targets.slice(0, p.maxTargets).map((t) => t.id), versions: p.versions } }, p.totalScreens);
  const many = p.versions > 1 || (creating && (p.count === 'auto' || p.count > 1));
  // 本机 agent 通道固定 1 版、屏数由会话自定：动词行只说去向，档位控件也不显示
  const editWhat = t(all ? 'verb.editAll' : 'verb.edit', { count: n });
  const versionsPart = p.versions > 1 ? ` ${t('verb.versions', { count: p.versions })}` : '';
  const callsPart = many ? ` ${t('verb.calls', { count: estimate.calls })}` : '';
  const verb = p.sketch
    ? p.sketch.verb
    : compOnly
    ? (comps.length === 1 ? t('verb.componentOne', { name: comps[0].name, count: comps[0].usedBy.length }) : t('verb.componentMany', { count: comps.length }))
    : agentRunner
    ? `${creating ? `${t('verb.createAgent')} · ${t('verb.toSession')}${p.anchor ? ` · ${t('verb.here')}` : ''}` : `${editWhat} · ${t('verb.toSession')}`}${compSuffix}`
    : creating
      ? `${p.count === 'auto' ? t('verb.createSet') : t('verb.createN', { count: n })}${versionsPart} · ${t(p.anchor ? 'verb.here' : 'verb.autoPlace')}${callsPart}${compSuffix}`
      : `${editWhat}${versionsPart}${callsPart}${compSuffix}`;

  const phrases = p.sketch
    ? p.sketch.phrases
    : compOnly && comps.length === 1 ? [t('phrase.component', { name: comps[0].name })]
    : one ? [t('phrase.one', { name: one.name })]
    : p.targets.length ? [t('phrase.many', { count: p.targets.length })]
    : p.anchor ? [t('phrase.anchor')]
    : IDLE_PHRASES.map((k) => t(`idle.${k}`));

  // 随内容增高；上限只有一个来源——styles.css 里 .composer textarea 的 max-height，到顶后内部滚动（INT-010）
  // 收起期间 display:none 量不到高度，叫回时要重量一次；空着时高度由原生 placeholder 撑开，占位文案换了（草稿本里「改」换回「新草稿」）也要重量
  const placeholder = phrases[0];
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el || p.hidden) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, p.hidden, placeholder]);

  const CollapseIcon = edge === 'left' ? ChevronLeft : edge === 'right' ? ChevronRight : ChevronDown;
  const pillText = text.trim() ? t('pill.continue') : t('pill.write');
  // 收起时 chip 叠比胶囊宽：朝画面里面展开——停在右边或底边右半段时右缘对齐胶囊，否则左缘对齐
  const stackEnd = edge === 'right' || (edge === 'bottom' && at > 0.5);
  return (
    <>
    <span ref={segLeftRef} aria-hidden="true" className="composer-seg" data-side="left" />
    <span ref={segRightRef} aria-hidden="true" className="composer-seg" data-side="right" />
    <span ref={segBottomRef} aria-hidden="true" className="composer-seg" data-side="bottom" />
    <div
      ref={dockRef} className="composer-dock z-20" data-dock={edge} data-collapsed={p.hidden ? '' : undefined} data-measured={measured ? '' : undefined}
      style={{ '--at': at, ...(bar.need ? { '--composer-need': `${bar.need}px` } : null) } as CSSProperties}
    >
    {/* 作业 chip（v1.17）：叠在卡片上方、不进 form——外壳的 --chrome-bottom 只量 form，chip 不占输入框的高度。展开时与卡片同宽，收起时固定宽 */}
    <div ref={stackRef} className={cn('pointer-events-none absolute bottom-full', p.jobs.length > 0 && 'pb-2', p.hidden ? cn('w-80 max-w-[calc(100dvw-1.5rem)]', stackEnd ? 'right-0' : 'left-0') : 'inset-x-0')}>
      <JobChips chips={p.jobs} escCancels={!p.sketch} onCancel={p.onCancelJob} onRetry={p.onRetryJob} onDismiss={p.onDismissJob} />
    </div>
    <form
      ref={formRef} className="composer p-3.5" onSubmit={submit} hidden={p.hidden} data-dock={edge}
      data-bar={bar.wrap === 'bar' ? 'wrap' : bar.wrap === 'all' ? 'wrap-all' : undefined}
      data-has-text={text ? '' : undefined} data-busy={busy ? '' : undefined} data-dropping={dropping ? '' : undefined} data-verb={compOnly ? 'component' : creating ? 'create' : 'edit'}
      onPaste={onPaste} onDrop={onDrop}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
    >
      <label htmlFor="chat-input" className="sr-only">{t('inputLabel')}</label>
      {/* 目标区始终存在：挪位置的把手 + 标签（屏 / 锚点，可逐个移除）+ 动词行 + 清空 + 收起。标签只被点屏 / × / 清空改变，点画布空白不动它。
          这一行的空白处是拖动输入框的抓手（v1.16） */}
      <div className="composer-grab mb-2.5 flex touch-none select-none items-center gap-2 px-0.5" onPointerDown={onRowPointerDown}>
        <DockGrip edge={edge} narrow={narrow} onPointerDown={startDrag} dragged={dragged} onPlace={(to) => place(to, null)} />
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-label={t('targetsLabel')}>
          {p.anchor && (
            <li className="tint-link inline-flex items-center gap-1 rounded-pill py-1 pl-2.5 pr-1 type-label font-medium" data-testid="anchor-chip">
              <MapPin size={12} aria-hidden="true" /><span>{t('chip.anchor')}</span>
              <button type="button" aria-label={t('chip.removeAnchor')} onClick={p.onRemoveAnchor} className="grid size-5 place-items-center rounded-pill transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring"><X size={12} /></button>
            </li>
          )}
          {!p.sketch && p.targets.map((s, i) => (
            <li key={s.id} className={`inline-flex items-center gap-1.5 rounded-pill py-1 pl-2.5 pr-1 type-label font-medium ${i < p.maxTargets ? 'tint-link' : 'tint-warning'}`} data-testid="target-chip">
              <span className="max-w-32 truncate">{s.name}</span>
              <button type="button" aria-label={t('chip.removeTarget', { name: s.name })} onClick={() => p.onRemoveTarget(s.id)} className="grid size-5 place-items-center rounded-pill transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring">
                <X size={12} />
              </button>
            </li>
          ))}
          {p.sketch?.chips?.map((c, _, all) => (
            <li key={c.key} className="tint-link inline-flex min-w-0 items-center gap-1.5 rounded-pill py-1 pl-2.5 pr-1 type-label font-medium" data-testid="draft-pick-chip" data-qid={c.key}>
              <span className="min-w-0 max-w-64 truncate">{c.label}</span>
              <button type="button" aria-label={t(all.length > 1 ? 'chip.removePickOf' : 'chip.removePick', { label: c.label })} onClick={c.onRemove} className="grid size-5 shrink-0 place-items-center rounded-pill transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring">
                <X size={12} />
              </button>
            </li>
          ))}
          {/* 共享组件目标（REQ-EDIT-006）：与屏标签同一排、同一形状，前缀「组件 ·」区分 */}
          {p.componentTargets.map((c) => (
            <li key={c.id} className="tint-link inline-flex items-center gap-1.5 rounded-pill py-1 pl-2.5 pr-1 type-label font-medium" data-testid="component-chip" data-name={c.name}>
              <span className="max-w-40 truncate">{t('chip.component', { name: c.name })}</span>
              <button type="button" aria-label={t('chip.removeComponent', { name: c.name })} onClick={() => p.onRemoveComponentTarget(c.id)} className="grid size-5 place-items-center rounded-pill transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring">
                <X size={12} />
              </button>
            </li>
          ))}
          {/* 动词行是变长文本：放在可截断的 flex 项里，改字不挤动旁边的按钮（RESP-010） */}
          <li className={`min-w-0 truncate type-label ${over ? 'text-warning' : 'text-text-secondary'}`} data-testid="verb-line" aria-live="polite">
            {over ? t('verb.over', { count: p.targets.length, max: p.maxTargets }) : verb}
          </li>
        </ul>
        {!p.sketch && (p.targets.length > 0 || p.anchor || p.componentTargets.length > 0) && (
          <button type="button" data-testid="clear-targets" onClick={p.onClearTargets} className="shrink-0 rounded-md px-1.5 py-0.5 type-label text-(--semantic-color-action-link) transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring">{t('clear')}</button>
        )}
        {/* 收起：与 ⌘/、画布工具栏的「输入框」是同一开关；箭头朝着胶囊要贴的那条边 */}
        <IconButton size="2xs" tip="bottom-end" label={t('collapse.label')} hint={`${CMD}/`} desc={t('collapse.desc')} data-testid="composer-collapse" onClick={p.dock.onToggle}>
          <CollapseIcon size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {shots.length > 0 && (
        <ul className="mb-2.5 flex flex-wrap gap-2 px-0.5" aria-label={t('shots.label')}>
          {shots.map((sh) => (
            <li key={sh.key} className="group relative">
              <img src={sh.url} alt={sh.name} className="size-16 rounded-md border border-border-subtle object-cover" />
              {!sh.id && <span className="absolute inset-0 grid place-items-center"><span className="inverse rounded-sm px-1.5 type-caption">{t('shots.uploading')}</span></span>}
              <button
                type="button" aria-label={t('shots.remove', { name: sh.name })} onClick={() => removeShot(sh.key)}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-pill bg-surface-raised text-text-secondary shadow-(--semantic-elevation-raised) transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring"
              ><X size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative min-h-7">
        {/* 可见的占位文案是这层叠在上面的 span：能轮播、能带动效；原生 placeholder 仍在（透明），给读屏与测试用。聚焦后隐去，输入区只剩光标 */}
        <Placeholder phrases={phrases} active={text.length === 0 && !focused} />
        <textarea
          id="chat-input" data-testid="composer-input" ref={taRef} name="content" rows={1} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          className="scroll relative z-10 block w-full resize-none bg-transparent px-1 type-heading3 leading-7 text-text-primary caret-text-primary placeholder:text-transparent outline-none"
          placeholder={placeholder}
        />
      </div>
      {/* 冲突理由就地写在发送键上方：发送键只是 aria-disabled，输入照旧可改——换个目标或等这一轮完事就能发（A11Y-007 / IA-009） */}
      {shownReason && <p data-testid="send-blocked-reason" role="status" className="mt-2 px-1 text-right type-label text-warning">{shownReason}</p>}
      {/* 工具条允许换行：390px 视口放不下「通道 + 参考图 + 屏数 + 版数 + 发送」一整行，右侧档位组折到下一行而不是撑破外框 */}
      <div ref={barRef} className="composer-bar mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
        {/* 左组不能写 min-w-0：里面的控件都是 shrink-0，盒子缩了内容不缩，只会溢出去压在右边的档位上，
            而「放不下就换行」也因为左组总能缩到放得下而永远不触发（RESP-004） */}
        <div className="flex flex-1 items-center gap-2">
          {/* 通道选择（REQ-CORE-011）。清单来自服务端，只含标识与显示名 */}
          {p.runnersFailed ? (
            <button type="button" data-testid="runners-failed" onClick={p.onReloadRunners} className="min-w-0 truncate rounded-md px-1.5 py-1 type-label text-warning transition-colors duration-(--semantic-motion-duration-fast) state-layer focus-ring">
              {t('runnersFailed')}
            </button>
          ) : p.runners.length > 0 && <RunnerSelect runners={p.runners} value={p.runnerId} onChange={p.onRunnerChange} maxWidth={bar.runnerMax} />}
          {/* 投递会话（REQ-AGENT-003 v0.34）：只在通道是本机 agent 时出现，与通道选择一样跨会话记忆 */}
          {agentRunner && <SessionSelect tool={p.sessionTool ?? 'claude-code'} sessions={p.sessions} reason={p.sessionsReason} value={p.sessionId} onChange={p.onSessionChange} onOpen={p.onSessionsOpen} />}
          {/* 参考图入口（REQ-CORE-012）。贴图与拖入同样可用，这个按钮是给不知道能贴的人看的 */}
          <input
            ref={fileRef} type="file" accept={IMAGE_MEDIA_TYPES.join(',')} multiple className="sr-only" tabIndex={-1}
            onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
          />
          <IconButton
            size="sm" label={t('addImage.label')} desc={t('addImage.desc')} tip="top"
            data-testid="add-image" onClick={() => fileRef.current?.click()}
            unavailable={!visionOk && t('addImage.noVision')}
          ><ImagePlus size={16} /></IconButton>
        </div>
        {/* 档位（REQ-CORE-003 / REQ-CORE-006）：屏数只在造时出现（几张不同的屏）；版数造改都有（同一屏的几种画法）；两者以分隔线隔开，不做同形并排 */}
        {/* 档位组自身也能换行：≤ 48rem 视口里输入框只有约 240px 宽，屏数 + 版数 + 发送一行放不下时各自折行、靠右 */}
        <div className="ml-auto flex items-center justify-end gap-2">
          {/* 本机 agent 通道没有档位（固定 1 版、屏数由会话自定），腾出的位置给会话下拉；改组件一次一个也没有档位 */}
          {p.sketch?.extra}
          {!p.sketch && creating && !agentRunner && !compOnly && (
            <Segmented label={t('count.label')} testId="count" value={p.count} options={SCREEN_COUNT_OPTIONS.map((o) => ({ value: o, label: o === 'auto' ? t('count.auto') : String(o) }))} onChange={p.onCount} />
          )}
          {!p.sketch && creating && !agentRunner && !compOnly && <span className="h-5 w-px bg-border-subtle" aria-hidden="true" />}
          {!p.sketch && !agentRunner && !compOnly && <Segmented label={t('versions.label')} testId="versions" value={p.versions} options={Array.from({ length: MAX_VERSIONS }, (_, i) => ({ value: i + 1, label: t('versions.option', { count: i + 1 }) }))} onChange={p.onVersions} compact />}
          {/* 这个 40px 插槽永远是发送键（停止归作业 chip 上的 ×）；反色实心只给此刻唯一的主动作 */}
          <IconButton
            type="submit" size="sm" tone={text.trim() ? 'invert' : 'default'} label={compOnly ? t('send.component') : creating ? (p.sketch ? t('send.draft') : t('send.create')) : t('send.edit')} hint="Enter" tip="top-end"
            className={text.trim() ? 'rounded-pill' : 'fill rounded-pill'} data-testid="composer-send"
            unavailable={p.blockedReason ?? localReason ?? (!text.trim() && (compOnly ? t('send.emptyComponent') : creating ? (p.sketch ? t('send.emptyDraft') : t('send.emptyCreate')) : t('send.emptyEdit')))}
          >
            {sending ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <ArrowUp size={16} />}
          </IconButton>
        </div>
      </div>
    </form>
    {/* 收起后的胶囊（v1.16）：同一条边、同一位置；点它或按 ⌘/ 展开、光标回输入区；也能像输入框一样拖。拖过之后松手的那次 click 不算点 */}
    {p.hidden && (
      <button
        ref={pillRef} type="button" data-testid="composer-pill" data-dock={edge}
        aria-label={t(text.trim() ? 'pill.ariaContinue' : 'pill.ariaWrite', { shortcut: `${CMD}/` })} onPointerDown={startDrag}
        onClick={(e) => { const skip = dragged.current && e.detail > 0; dragged.current = false; if (!skip) p.dock.onToggle(); }}
        className="composer-pill chrome state-layer focus-ring inline-flex h-9 cursor-grab touch-none select-none items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 type-label font-medium text-text-primary [@media(pointer:coarse)]:h-11"
      ><PenLine size={14} aria-hidden="true" />{pillText}</button>
    )}
    </div>
    <span role="status" className="sr-only">{said}</span>
    </>
  );
}

// 挪位置的把手（composer-grip，v1.16）：按住拖与拖动词行的空白处一样；聚焦后 ← / → / ↓ 停到左边 / 右边 / 底边的正中；
// 点一下（或 Enter / 空格）开菜单选边——这是拖动的单指针替代（WCAG 2.5.7）。方向键先于菜单触发器处理：↓ 在那里本是「打开菜单」。
// 窄视口只停底边：左右两项置灰并写明原因，← / → 只播报原因（在 place 里）
function DockGrip({ edge, narrow, onPointerDown, dragged, onPlace }: { edge: DockEdge; narrow: boolean; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; dragged: { current: boolean }; onPlace: (to: DockEdge) => void }) {
  const t = useT(composerMessages);
  const [open, setOpen] = useState(false);
  // 按下那一刻菜单开没开：开着时点把手是关菜单（菜单自己也可能在按下时因「点到外面」先关了，不能再按 click 把它翻回来）
  const openAtDown = useRef(false);
  const descId = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const to: DockEdge | null = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowDown' ? 'bottom' : null;
    if (!to) return;
    e.preventDefault();
    onPlace(to);
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton
          size="2xs" tip="bottom-start" label={t('dock.gripLabel')} desc={narrow ? t('dock.gripDescNarrow') : t('dock.gripDesc')}
          data-testid="composer-grip" aria-describedby={descId} className="cursor-grab touch-none"
          onPointerDown={(e) => { openAtDown.current = open; onPointerDown(e); }} onKeyDown={onKey}
          // 指针点按才在这里开关菜单（按下时已被拖动接管）；键盘的 Enter / 空格由菜单触发器自己处理，click 的 detail 为 0
          onClick={(e) => { const skip = dragged.current; dragged.current = false; if (!skip && e.detail > 0) setOpen(!openAtDown.current); }}
        ><GripVertical size={14} aria-hidden="true" /></IconButton>
      </DropdownMenu.Trigger>
      <span id={descId} className="sr-only">{t(narrow ? 'dock.nowNarrow' : 'dock.nowKeys', { edge: t(`dock.edgeIn.${edge}`) })}</span>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top" align="start" sideOffset={8} collisionPadding={12} data-testid="composer-dock-menu"
          // 菜单开着时的 Esc / 方向键归它自己，不漏给画布快捷键
          onKeyDown={(e) => e.stopPropagation()}
          style={{ transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }}
          className="menu z-50 min-w-44 p-1.5"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 type-overline font-semibold text-text-secondary">{t('dock.menuLabel')}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={edge} onValueChange={(v) => onPlace(v as DockEdge)}>
            {(['left', 'right', 'bottom'] as const).map((d) => (
              <DropdownMenu.RadioItem key={d} value={d} disabled={narrow && d !== 'bottom'} data-testid={`composer-dock-${d}`} className={`${ITEM_CLS} data-[disabled]:pointer-events-none data-[disabled]:opacity-(--semantic-state-disabled-opacity)`}>
                <span className="min-w-0 flex-1">{t(`dock.edge.${d}`)}</span>
                <DropdownMenu.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {narrow && <p className="px-2.5 pb-1 pt-1.5 type-caption text-text-secondary">{t('dock.menuNarrow')}</p>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// 分段控件（屏数 / 版数）：radiogroup 语义，方向键换档
function Segmented<T extends string | number>({ label, testId, value, options, onChange, compact }: { label: string; testId: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (idx + delta + options.length) % options.length;
    onChange(options[next].value);
    (ref.current?.querySelector(`[data-testid="${testId}-${String(options[next].value)}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} title={label} data-testid={`${testId}-group`} className="seg h-8 shrink-0">
      {options.map((o, i) => (
        <button
          key={String(o.value)} type="button" role="radio" aria-checked={i === idx} tabIndex={i === idx ? 0 : -1} data-testid={`${testId}-${String(o.value)}`}
          onClick={() => onChange(o.value)} onKeyDown={onKey}
          className={`h-7 ${compact ? 'min-w-9 px-1' : 'min-w-7 px-1.5'} type-label tabular-nums ${i === idx ? '' : 'state-layer'} focus-ring`}
        >{o.label}</button>
      ))}
    </div>
  );
}

// 占位文案：多条时轮播（尊重 reduced-motion 则停在第一条），换词时新词从下方浮现
function Placeholder({ phrases, active }: { phrases: string[]; active: boolean }) {
  const [i, setI] = useState(0);
  const key = phrases.join('\n');
  useEffect(() => { setI(0); }, [key]);
  useEffect(() => {
    if (!active || phrases.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % phrases.length), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [active, phrases.length]);
  if (!active) return null;
  const text = phrases[i % phrases.length];
  return (
    <span key={text} aria-hidden="true" className="phrase-in pointer-events-none absolute inset-x-0 top-0 block truncate px-1 type-heading3 leading-7 text-text-secondary">
      {text}
    </span>
  );
}

// 通道下拉：Radix Select 承担键盘导航、焦点归还与定位；外观在 styles.css 的 .menu。
// 云端模型与本机 agent 分两组。
// maxWidth：输入框差一点放不下时截短触发器（px，由 Composer 量出来）
export function RunnerSelect({ runners, value, onChange, disabled, testId = 'runner-select', maxWidth }: { runners: RunnerOptionDto[]; value: string; onChange: (id: string) => void; disabled?: boolean; testId?: string; maxWidth?: number | null }) {
  // 「管理模型…」只加 ?settings=models、不动地址里别的参数：草稿本页的 ?d=<草稿> 是看板上开着的那张，整体换掉会把它收起（PAGE-SKETCH）
  const t = useT(composerMessages);
  const [, setParams] = useSearchParams();
  // 只列可用项（REQ-CORE-013）：不可用的去设置页看原因，这里不灰化陈列
  const usable = runners.filter((r) => r.available);
  const cloud = usable.filter((r) => r.runner.kind !== 'agent');
  const agents = usable.filter((r) => r.runner.kind === 'agent');
  const cur = usable.find((r) => r.id === value);
  return (
    <Select.Root value={cur?.id} onValueChange={(v) => { if (v === MANAGE_ID) setParams((q) => { q.set('settings', 'models'); return q; }); else onChange(v); }} disabled={disabled}>
      <Select.Trigger
        aria-label={t('runner.label')} data-testid={testId} data-value={value} style={maxWidth ? { maxWidth } : undefined}
        className="fill group flex h-9 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2.5 type-label font-medium text-text-primary disabled:pointer-events-none sm:max-w-56 state-layer focus-ring"
      >
        {/* 当前通道名直接渲染（v0.78）：Radix 默认要等选项挂上后才把名字填进来，输入框首次量宽时触发器还是空的，宽度量小了 */}
        <span className="min-w-0 truncate"><Select.Value placeholder={usable.length ? t('runner.choose') : t('runner.none')}>{cur ? <span className="flex min-w-0 items-center gap-2"><VendorIcon vendor={cur.vendor} size={14} className="shrink-0" /><span className="truncate">{cur.label}</span></span> : undefined}</Select.Value></span>
        <Select.Icon className="flex shrink-0 opacity-60 transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" side="top" align="start" sideOffset={8} collisionPadding={12}
          // 下拉开着时的 Esc / 方向键 / 字母键归它自己，不漏给画布快捷键（画布的 Esc 会顺手清掉选中）
          onKeyDown={(e) => e.stopPropagation()}
          className="menu z-50 min-w-64 max-w-[min(22rem,calc(100vw-1.5rem))] p-1.5"
        >
          <Select.Viewport>
            <RunnerGroup label={t('runner.cloud')} items={cloud} />
            {cloud.length > 0 && agents.length > 0 && <Select.Separator className="my-1.5 h-px bg-border-subtle" />}
            <RunnerGroup label={t('runner.agents')} items={agents} />
            {usable.length === 0 && <p className="px-2.5 py-2 type-label text-text-secondary">{t('runner.noneVerified')}</p>}
            <Select.Separator className="my-1.5 h-px bg-border-subtle" />
            {/* 做成选项而不是普通按钮：Radix Select 的内容区只让方向键在选项间走，普通按钮键盘够不着；
                选中它不改通道、只跳设置页 */}
            <Select.Item value={MANAGE_ID} textValue={t('runner.manage')} data-testid="manage-channels" className={ITEM_CLS}>
              <Select.ItemText><span className="inline-flex items-center gap-2"><Settings2 size={14} aria-hidden="true" />{t('runner.manageItem')}</span></Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

const MANAGE_ID = '__manage_channels__';
const ITEM_CLS = 'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:bg-(--semantic-color-surface-selected) data-[highlighted]:text-text-primary data-[state=checked]:text-text-primary';

// 投递会话下拉（REQ-AGENT-003 v0.34 / v0.68）。Claude Code：本机正在运行的交互式会话，起过名的显示名字、派生名（目录 + 后缀）显示会话 UUID，
// 每项带目录名与 idle / busy。Codex：线程库里的用户线程，显示名字（没起过名就是标题），每项带目录名、开在哪个应用、已打开 / 未打开——
// 未打开的投递时由 Codex 桌面版打开。打开即让父组件重取列表；当前值不在列表里时显示占位「选择会话」（记住的会话已关闭）。
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
// 各工具的分组名与空列表文案在 composer 命名空间的 session.<键>.group / empty，应用名在 session.app.*
const TOOL_KEY = { 'claude-code': 'claudeCode', codex: 'codex' } as const satisfies Record<AgentTool, string>;
export function SessionSelect({ tool, sessions, reason, value, onChange, onOpen, disabled, testId = 'session-select' }: { tool: AgentTool; sessions: AgentSessionDto[] | null; reason?: string; value: string; onChange: (id: string) => void; onOpen: () => void; disabled?: boolean; testId?: string }) {
  const t = useT(composerMessages);
  const items = sessions ?? [];
  const current = items.some((s) => s.sessionId === value) ? value : undefined;
  // Codex 线程没起过名时 name 是标题（首条消息），比 UUID 好认；Claude Code 的派生名只是目录 + 后缀，显示 UUID
  const label = (s: AgentSessionDto) => (s.named || s.tool === 'codex' ? s.name : s.sessionId);
  return (
    <Select.Root value={current} onValueChange={onChange} disabled={disabled} onOpenChange={(open) => { if (open) onOpen(); }}>
      <Select.Trigger
        aria-label={t('session.label')} data-testid={testId} data-value={current ?? ''}
        className="fill group flex h-9 min-w-0 max-w-44 items-center gap-1.5 rounded-md px-2.5 type-label font-medium text-text-primary disabled:pointer-events-none sm:max-w-56 state-layer focus-ring"
      >
        <span className="min-w-0 truncate"><Select.Value placeholder={t('session.choose')} /></span>
        <Select.Icon className="flex shrink-0 opacity-60 transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        {/* 会话可能有几十个：内容高度封顶在触发器上方的可用空间，Radix 的 Viewport 自己滚（滚动条隐藏，上下端给箭头提示，RESP-016） */}
        <Select.Content position="popper" side="top" align="start" sideOffset={8} collisionPadding={12} onKeyDown={(e) => e.stopPropagation()} className="menu z-50 flex max-h-[var(--radix-select-content-available-height)] min-w-72 max-w-[min(26rem,calc(100vw-1.5rem))] flex-col p-1.5">
          <Select.ScrollUpButton className="flex h-6 shrink-0 items-center justify-center text-text-secondary"><ChevronUp size={14} aria-hidden="true" /></Select.ScrollUpButton>
          <Select.Viewport className="min-h-0 flex-1">
            <Select.Group>
              <Select.Label className="px-2.5 pb-1 pt-1.5 type-overline font-semibold text-text-secondary">{t(`session.${TOOL_KEY[tool]}.group`)}</Select.Label>
              {sessions === null && <p className="px-2.5 py-2 type-label text-text-secondary">{t('session.searching')}</p>}
              {sessions?.length === 0 && <p className="px-2.5 py-2 type-label text-text-secondary" data-testid="session-empty">{reason ?? t(`session.${TOOL_KEY[tool]}.empty`)}</p>}
              {items.map((s) => (
                <Select.Item key={s.sessionId} value={s.sessionId} textValue={label(s)} data-testid="session-option" data-named={s.named ? '' : undefined} data-open={s.open ? '' : undefined} className={ITEM_CLS}>
                  <span className="min-w-0 flex-1">
                    <Select.ItemText><span className={s.named || s.tool === 'codex' ? '' : 'font-mono type-label'}>{label(s)}</span></Select.ItemText>
                    <span className="mt-0.5 flex items-center gap-1.5 type-caption text-text-secondary">
                      <span className="truncate">{basename(s.cwd)}</span>
                      {s.app && <span className="shrink-0">{t(`session.app.${s.app}`)}</span>}
                      {s.tool === 'codex'
                        ? <span className="fill shrink-0 rounded-sm px-1.5">{s.open ? t('session.open') : t('session.notOpen')}</span>
                        : <span className={`shrink-0 rounded-sm px-1.5 ${s.status === 'busy' ? 'tint-warning' : 'fill'}`}>{s.status === 'busy' ? t('session.busy') : s.status === 'idle' ? t('session.idle') : t('session.unknown')}</span>}
                      {s.unverifiedVersion !== undefined && <span className="tint-warning shrink-0 rounded-sm px-1.5" data-testid="session-unverified">{s.unverifiedVersion ? t('session.unverifiedVersion', { version: s.unverifiedVersion }) : t('session.unverified')}</span>}
                    </span>
                  </span>
                  <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Viewport>
          <Select.ScrollDownButton className="flex h-6 shrink-0 items-center justify-center text-text-secondary"><ChevronDown size={14} aria-hidden="true" /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function RunnerGroup({ label, items }: { label: string; items: RunnerOptionDto[] }) {
  if (!items.length) return null;
  return (
    <Select.Group>
      <Select.Label className="px-2.5 pb-1 pt-1.5 type-overline font-semibold text-text-secondary">{label}</Select.Label>
      {items.map((r) => (
        <Select.Item key={r.id} value={r.id} textValue={r.label} className={ITEM_CLS}>
          <span className="min-w-0 flex-1 truncate">
            {/* 只给图标 + 显示名：选通道时认的是名字，模型 id 是配置细节，在设置弹层的通道管理器里看 */}
            <Select.ItemText><span className="inline-flex items-center gap-2"><VendorIcon vendor={r.vendor} size={14} />{r.label}</span></Select.ItemText>
          </span>
          <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
        </Select.Item>
      ))}
    </Select.Group>
  );
}
