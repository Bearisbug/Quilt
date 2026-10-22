import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Crosshair, FolderInput, Minimize2, Trash2 } from 'lucide-react';
import { DEVICE_SIZE, DRAFT_PAD, isPreviewMessage, type DraftFrame, type DraftFrameChoice, type ParentToPreview, type ProjectDetailDto, type ScreenDto } from '@quilt/core/browser';
import { markPalette, useResolvedMode } from '@/lib/theme';
import { recordPreview } from '@/lib/recorder';
import { frameSide } from '@/lib/frameZoom';
import type { SelectMessage } from '@/canvas/frameMessages';
import { cn, IconButton } from '@/ui/ui';
import { ChoiceGroup } from '@/sketch/ChoiceGroup';
import { DraftVersions } from '@/sketch/DraftVersions';
import { RefSelect, type RefProjects } from '@/sketch/RefSelect';
import { useLocale, useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

export type StageState = 'empty' | 'generating' | 'draft';
type Size = { w: number; h: number };

// 画框只在页面之间换（API-CORE-012 v1.17）：组件按自身大小、页面按视口排，两者不能互换，组件草稿不显示这一项
// 显示名在 sketch 命名空间的 frames.<取值>
const PAGE_FRAMES = ['mobile', 'desktop'] as const;
// 空看板的三条示例：组件、手机页、桌面页各一条，点了填进输入框（文案在 stage.examples.<键>）
const EXAMPLES = ['player', 'ledger', 'pricing'] as const;
// 顶部那一行里工具条与两头（切换器 chip、记录栏开关）的间距，也是工具条底边到看板上沿的间隙
const TOP_GAP = 12;
// 组件画框（API-CORE-016 草稿）：第一次上报前 iframe 按桌面视口渲染，与截图同一个视口（shotSpecFor）；之后视口就是量到的根元素框
const COMPONENT_VIEW = DEVICE_SIZE.desktop;
// 组件画框的视口 = 根元素的框 + 四周各 DRAFT_PAD 的透明边（预览文档的 body 内边距）：根的阴影、外发光不被视口裁掉
const viewOf = (box: Size | null): Size => (box ? { w: box.w + 2 * DRAFT_PAD, h: box.h + 2 * DRAFT_PAD } : COMPONENT_VIEW);
// 等不到尺寸上报时露出整个桌面视口：按「框 + 透明边 = 桌面视口」倒推，视口不变
const FALLBACK_BOX: Size = { w: COMPONENT_VIEW.w - 2 * DRAFT_PAD, h: COMPONENT_VIEW.h - 2 * DRAFT_PAD };
// 画框还没定（新草稿第一版落库前、「自动」）或组件还没报尺寸时骨架的大小
const PLACEHOLDER: Size = { w: 480, h: 320 };
// 组件画框的草稿就绪后等尺寸上报的上限：等不到（下发的文档里没有测量脚本）就把整个视口露出来，不让骨架一直挂着。
// 测量脚本等文档 load（图片、字体到齐）才报第一次，外链图片慢时要两三秒，等得太短会先露出整块桌面视口再跳回组件大小
const SIZE_WAIT_MS = 6000;
// 视口刚按上报值改过之后这段时间里的缩小上报，当成根元素跟着视口缩的回声（见 DraftFrameView）
const ECHO_MS = 400;

const frameSize = (frame: DraftFrameChoice | null | undefined): Size => (frame === 'mobile' || frame === 'desktop' ? DEVICE_SIZE[frame] : PLACEHOLDER);
// 放不下就等比缩小、不裁切，放得下不放大（PAGE-SKETCH）
const fit = (nat: Size, room: Size | null) => (room ? Math.max(0.05, Math.min(1, room.w / nat.w, room.h / nat.h)) : 1);

type StageProps = {
  state: StageState;
  /** 看板上打开的草稿；null = 看板空着（或本页刚发的新草稿还没落成屏） */
  draft: ScreenDto | null;
  /** 本页发出、还没落成屏的新草稿用的画框：骨架按它的形状占位 */
  pendingFrame: DraftFrameChoice | null;
  /** 在做这张草稿（或新草稿）的作业此刻到哪一步 */
  progress: string | null;
  /** 这张草稿被作业占着：删除与回到旧版先挡住，原因写这里 */
  busy: string | null;
  previewOrigin: string | null;
  onExample: (text: string) => void;
  onRename: (name: string) => void;
  onFrame: (frame: DraftFrame) => void;
  onRestored: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onCollapse: () => void;
  /** 焦点在草稿里时按的 Esc（运行时转发）：先去胶囊、再收起，优先级由页面定 */
  onEscape: () => void;
  /** 焦点在草稿 iframe 里时运行时转发上来的 ⌘ 组合键（⌘E、⌘/），交给页面的键位表 */
  onShortcut: (code: string) => void;
  /** 预览签名过期时重取详情（API-CORE-004），返回新的详情 */
  onStale: () => Promise<ProjectDetailDto | null>;
  /** 参照（REQ-CORE-042）：候选项目与改参照 */
  refs: RefProjects;
  onRef: (projectId: string | null) => void;
  /** 草稿工具条上的「选元素」开关（REQ-CORE-045）：关着时草稿照常可点可滚 */
  picking: boolean;
  onPicking: (on: boolean) => void;
  /** 选元素点中的几块（输入框里的胶囊，最后点中的排最后）：草稿里框着它们；空 = 改整张 */
  pickQids: string[];
  /** 运行时报上来的点选（带 additive / replace，v1.26），加选减选的规则在页面 */
  onPick: (m: SelectMessage) => void;
  /** 草稿 iframe 就绪且开着选元素时，由看板填上：让输入框把 Shift+↑ / Shift+↓ 转成逐级选（`quilt:climb`） */
  climbRef?: { current: ((dir: 'up' | 'down') => void) | null };
  /** 草稿工具条的实际底边 + 间隙（px，相对外壳顶）：页面拿它当看板的上沿；没有草稿（工具条不在）时 null */
  onTopRow: (bottom: number | null) => void;
};

// 看板（PAGE-SKETCH v1.16、v1.17）：顶部那一行以下的整块区域（外壳的 --stage-*），输入框（或胶囊）与记录栏都浮在它上面，只放一张草稿。
// 空着时正中一句提示与三条示例；新草稿生成中是骨架（只呼吸）与一句进度；有内容时是预览域的活 iframe（可点可滚，链接惰性），
// 在看板里居中，按画框放到能放下的最大、最大 1:1，放不下等比缩小、不裁切。草稿工具条在顶部那一行，不占看板的高度
export function DraftStage(p: StageProps) {
  const t = useT(sketchMessages);
  const ref = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const draftId = p.draft?.id;
  // 工具条落位：夹在项目切换器与右上角的记录栏开关之间，对着看板居中（记录栏浮在看板上、开合不挪它），放不下就贴向一头、
  // 再放不下才折行（与输入框横向落点同一个 clamp）；实际底边报给页面当看板的上沿。看板、工具条、切换器（断线提示出现时变宽）任一变了尺寸都重摆。
  // 直接写这个元素的 left / max-width：它们只由这里定，不进 React 的 style
  const onTopRow = p.onTopRow;
  useLayoutEffect(() => {
    const bar = barRef.current; const stage = ref.current;
    if (!bar || !stage) { onTopRow(null); return; }
    const head = document.querySelector('[data-testid="project-switcher"]')?.closest('header') ?? null;
    const place = () => {
      const shell = stage.offsetParent?.getBoundingClientRect();
      if (!shell) return;
      // 窄屏：切换器与开合钮之间只剩两百来像素，折行会折成好几行把看板压没——单独占顶部那一行下面一整行，不折行，放不下的在条里横着滚（styles.css .draft-toolbar）
      if (matchMedia('(max-width: 48rem)').matches) {
        bar.style.top = `${(head ? head.getBoundingClientRect().bottom - shell.top : 0) + TOP_GAP}px`;
        bar.style.left = `${TOP_GAP}px`;
        bar.style.maxWidth = `${Math.max(0, shell.width - 2 * TOP_GAP)}px`;
        onTopRow(bar.offsetTop + bar.offsetHeight + TOP_GAP);
        return;
      }
      bar.style.top = '';
      const toggle = document.querySelector('[data-testid="rail-toggle"]')?.getBoundingClientRect();
      const lo = (head ? head.getBoundingClientRect().right - shell.left : 0) + TOP_GAP;
      const hi = (toggle ? toggle.left - shell.left : shell.width) - TOP_GAP;
      bar.style.maxWidth = `${Math.max(0, hi - lo)}px`;
      const w = bar.offsetWidth;
      const center = stage.offsetLeft + stage.offsetWidth / 2;
      bar.style.left = `${Math.max(lo, Math.min(center - w / 2, hi - w))}px`;
      onTopRow(bar.offsetTop + bar.offsetHeight + TOP_GAP);
    };
    place();
    const ro = new ResizeObserver(place);
    for (const el of [bar, stage, head]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [draftId, onTopRow]);
  const [room, setRoom] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setRoom((v) => (v && v.w === r.width && v.h === r.height ? v : { w: r.width, h: r.height })); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <>
    {p.draft && <DraftToolbar key={p.draft.id} {...p} draft={p.draft} barRef={barRef} />}
    <main ref={ref} data-testid="sketch-stage" data-state={p.state} aria-label={t('stage.label')} className="absolute bottom-[var(--stage-bottom)] left-[var(--stage-left)] right-[var(--stage-right)] top-[var(--chrome-top)] grid place-items-center">
      {p.draft ? (
        <section data-testid="draft-view" data-draft-id={p.draft.id} data-frame={p.draft.frame ?? ''} aria-label={t('stage.draft', { name: p.draft.name })}>
          {/* 换一张草稿、新草稿第一版落地才整个重挂（之前没有地址可载）；之后出新版、换画框都在 DraftFrameView 里原地换（PAGE-SKETCH「看板」） */}
          <DraftFrameView
            key={`${p.draft.id}|${p.draft.currentRevisionId ? 'live' : 'pending'}`} draft={p.draft} avail={room} progress={p.progress} previewOrigin={p.previewOrigin} onEscape={p.onEscape} onShortcut={p.onShortcut} onStale={p.onStale}
            picking={p.picking} pickQids={p.pickQids} onPick={p.onPick} climbRef={p.climbRef}
          />
        </section>
      ) : p.state === 'generating' ? (
        <Skeleton nat={frameSize(p.pendingFrame)} scale={fit(frameSize(p.pendingFrame), room)} label={p.progress ?? t('queued')} />
      ) : (
        <div data-testid="sketch-empty" className="fade-up flex max-w-lg flex-col items-center gap-2 px-4 text-center">
          <h1 className="type-heading2 font-semibold text-text-primary [text-wrap:balance]">{t('stage.emptyTitle')}</h1>
          <p className="type-label text-text-secondary [text-wrap:pretty]">{t('stage.emptyBody')}</p>
          <ul className="mt-3 flex flex-col items-center gap-2" aria-label={t('stage.examplesLabel')}>
            {EXAMPLES.map((id) => { const text = t(`stage.examples.${id}`); return (
              <li key={id}><button type="button" data-testid="sketch-example" onClick={() => p.onExample(text)} className="state-layer focus-ring fill rounded-pill px-3.5 py-1.5 type-label text-text-secondary">{text}</button></li>
            ); })}
          </ul>
        </div>
      )}
    </main>
    </>
  );
}

// 草稿工具条（顶部那一行的 chrome）：名字（点了就地改名）与「来自」、画框（页面草稿在手机页 / 桌面页之间二选一）、参照、「选元素」开关、版本、
// 写回项目（这条里唯一铺填充底的按钮）、删除、收起
function DraftToolbar({ draft, busy, progress, onRename, onFrame, onRestored, onCopy, onDelete, onCollapse, refs, onRef, picking, onPicking, barRef }: StageProps & { draft: ScreenDto; barRef: RefObject<HTMLDivElement | null> }) {
  const t = useT(sketchMessages);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const landed = !!draft.currentRevisionId;
  // 改名即存：空名或没改动当放弃（与项目改名同一口径）；Enter 与失焦提交，Esc 放弃。
  // 只收一次尾：改名框卸载时浏览器可能再补一个 blur，不能把同一个名字提交两遍；键盘收尾的把焦点还给名字（A11Y-013）
  const active = useRef(false);
  const nameBtn = useRef<HTMLButtonElement>(null);
  const finish = (save: boolean, fromKey: boolean) => {
    if (!active.current) return;
    active.current = false;
    setEditing(false);
    const v = name.trim();
    if (save && v && v !== draft.name) onRename(v);
    if (fromKey) requestAnimationFrame(() => nameBtn.current?.focus());
  };
  return (
    // 顶部那一行里的一条毛玻璃（v1.16）：左端名字（点了就地改名），有写回目标时名字下一行小字「来自…」，其后是控件；放不下一行就折行。
    // 横向落位与 max-width 由看板量了直接写上（见 DraftStage），层级与切换器、记录栏开关同一档：组件四周那圈透明边（DRAFT_PAD）伸上来也压不住它
    <div ref={barRef} data-testid="draft-toolbar" className="draft-toolbar chrome absolute top-3 z-30 flex min-h-10 w-max flex-wrap items-center justify-center gap-1 rounded-lg px-1 py-0.5">
      <span data-testid="draft-name" className="flex min-w-0 max-w-72 flex-col items-start">
        {editing ? (
          <input autoFocus aria-label={t('toolbar.renameLabel', { name: draft.name })} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => finish(true, false)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); finish(true, true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); } }}
            className="focus-ring fill h-8 w-48 min-w-0 rounded-md px-2.5 type-label font-medium text-text-primary" />
        ) : (
          <button ref={nameBtn} type="button" aria-label={t('toolbar.nameLabel', { name: draft.name })} onClick={() => { setName(draft.name); active.current = true; setEditing(true); }}
            className="state-layer focus-ring h-7 max-w-full truncate rounded-md px-2 type-body font-medium text-text-primary">{draft.name}</button>
        )}
        {/* 写回目标（REQ-CORE-044）：从屏拿来的、覆盖写回过的草稿记着它；那一屏已被删时服务端给 null，不写 */}
        {draft.target && (
          <span data-testid="draft-origin" className="max-w-full truncate px-2 pb-0.5 type-caption text-text-secondary">
            {t(draft.targetQid ? 'toolbar.originBlock' : 'toolbar.origin', { project: draft.target.projectName, screen: draft.target.screenName })}
          </span>
        )}
      </span>
      <Divider />
      {landed && (draft.frame === 'mobile' || draft.frame === 'desktop') && <><ChoiceGroup label={t('toolbar.frame')} testId="draft-frame" value={draft.frame} options={PAGE_FRAMES.map((value) => ({ value, label: t(`frames.${value}`) }))} onChange={(f) => { if (f !== draft.frame) onFrame(f); }} /><Divider /></>}
      {landed && (
        <>
          <RefSelect refs={refs} value={draft.refProjectId} onChange={onRef} testId="draft-ref" side="bottom" className="text-text-secondary data-[state=open]:bg-(--semantic-color-surface-selected) data-[state=open]:text-text-primary" />
          <Divider />
          {/* 开着时草稿进选择元素态，链接与表单不响应（PAGE-SKETCH） */}
          <IconButton size="xs" tip="bottom" label={t('toolbar.pick.label')} desc={t('toolbar.pick.desc')} active={picking} aria-pressed={picking} data-testid="draft-pick" onClick={() => onPicking(!picking)}><Crosshair size={14} aria-hidden="true" /></IconButton>
        </>
      )}
      {landed && <Divider />}
      {/* 作业在跑时的一句进度：放在工具条里，草稿本身照常可点可滚 */}
      {busy && landed && <span role="status" className="flex min-w-0 items-center gap-1.5 truncate px-1.5 type-label text-text-secondary"><span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />{progress ?? t('toolbar.editing')}</span>}
      {landed && <DraftVersions draft={draft} busy={busy} onRestored={onRestored} />}
      <button type="button" data-testid="draft-copy" aria-disabled={!landed || undefined} onClick={() => { if (landed) onCopy(); }}
        className="state-layer focus-ring fill inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 type-label font-medium text-text-primary aria-disabled:cursor-not-allowed">
        {/* 窄屏只留图标（文字留给读屏），工具条折成两行而不是三行 */}
        <FolderInput size={14} aria-hidden="true" /><span className="max-sm:sr-only">{t('toolbar.copy')}</span>
      </button>
      <IconButton size="xs" tip="bottom" label={t('toolbar.remove.label')} desc={t('toolbar.remove.desc')} data-testid="draft-delete" unavailable={busy ? t('toolbar.remove.busy', { reason: busy }) : false} onClick={onDelete}><Trash2 size={14} aria-hidden="true" /></IconButton>
      <IconButton size="xs" tip="bottom-end" label={t('toolbar.collapse.label')} hint="Esc" desc={t('toolbar.collapse.desc')} data-testid="draft-collapse" onClick={onCollapse}><Minimize2 size={14} aria-hidden="true" /></IconButton>
    </div>
  );
}

const Divider = () => <span className="mx-0.5 h-4 w-px shrink-0 bg-border-subtle" aria-hidden="true" />;


// 生成中的占位：与画布骨架同一个呼吸（styles.css 的 .draft-skeleton，只动 opacity），正中一枚反色标签写进度
function Skeleton({ nat, scale, label }: { nat: Size; scale: number; label: string }) {
  const t = useT(sketchMessages);
  return (
    <div className="draft-frame draft-skeleton" style={{ width: nat.w * scale, height: nat.h * scale }} role="img" aria-label={t('stage.skeletonLabel')}>
      <span className="absolute left-1/2 top-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 truncate rounded-sm px-3 py-1.5 type-label inverse">
        <span className="sk-dot shrink-0" aria-hidden="true" /><span className="truncate" role="status">{label}</span>
      </span>
    </div>
  );
}

// 草稿的活 iframe（API-CORE-016）：交互方式与画布聚焦屏一致——就绪后下发 quilt:mode（带当前外观的标记色）：「选元素」关着是 interact，
// 链接与表单由运行时惰性处理（草稿里的链接都是 #），这里不接导航；开着是 inspect，点中的元素回 quilt:select（REQ-CORE-045）。
// 只认这个 iframe 发来、来源是预览域、形状过 previewMessageSchema 的消息。
// 手机页 / 桌面页给对应视口；组件画框（画框还没定的按组件）的视口就是 quilt:draft-size 报的根元素框，iframe 透明，四周露出看板底色。
// 就绪看门同画布：load 后 2 s 还没 quilt:ready 多半是签名过期，重取详情换新地址重载一次，仍不行给「重试」
type FrameProps = Pick<StageProps, 'previewOrigin' | 'onEscape' | 'onShortcut' | 'onStale' | 'picking' | 'pickQids' | 'onPick' | 'climbRef'> & {
  draft: ScreenDto; avail: Size | null; progress: string | null;
};
function DraftFrameView({ draft, avail, progress, previewOrigin, onEscape, onShortcut, onStale, picking, pickQids, onPick, climbRef }: FrameProps) {
  const t = useT(sketchMessages);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 地址钉住：签名每 30 分钟换一个窗口，换了也不重载正在看的草稿；新的一版经 quilt:swap 送进去（见下），换画框只改视口
  const [src, setSrc] = useState(draft.previewUrl);
  const [loadKey, setLoadKey] = useState(0);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  // 运行时每发一次 quilt:ready 加一：新的一版改了设计系统时运行时整份重写，换上来的是新运行时，模式与框选要重发
  const [readySeq, setReadySeq] = useState(0);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  // 组件画框量到的根元素框；boxRef 与上次改视口的时刻给消息处理判回声用
  const [box, setBox] = useState<Size | null>(null);
  const boxRef = useRef<Size | null>(null);
  const resizedAt = useRef(0);
  // 只有视口真的变了才记时刻：等不到上报时退回的桌面视口与上报前的视口是同一个，记了会把随后到的真实上报当成回声丢掉，组件就卡在整块桌面视口里
  const applyBox = (next: Size) => {
    const prev = viewOf(boxRef.current); const to = viewOf(next);
    if (prev.w !== to.w || prev.h !== to.h) resizedAt.current = performance.now();
    boxRef.current = next;
    setBox(next);
  };
  const live = !!draft.currentRevisionId && !!src && !!previewOrigin;
  const component = (draft.frame ?? 'component') === 'component';
  const nat: Size = component && box ? box : frameSize(draft.frame);
  const view: Size = component ? viewOf(box) : nat;
  // 组件的透明边伸到看板上：iframe 往左上挪一圈，外层不裁
  const bleed = component && !!box;
  const scale = fit(nat, avail);
  const shown = live && ready && (!component || !!box);

  const post = (msg: ParentToPreview) => { if (previewOrigin) iframeRef.current?.contentWindow?.postMessage(msg, previewOrigin); };
  const themeMode = useResolvedMode();
  const locale = useLocale();
  // 换外观、换界面语言时重发一次：屏内的标记跟着换色、换字（§13.1）
  useEffect(() => { if (ready) post({ type: 'quilt:mode', mode: picking ? 'inspect' : 'interact', marks: markPalette() }); }, [ready, readySeq, themeMode, locale, picking]); // eslint-disable-line react-hooks/exhaustive-deps
  // 草稿里框着哪几块由父页定：输入框里的胶囊。运行时点中就先框上（按着 Shift 点的等这里画），
  // 每次点中之后按父页的决定再对一次——点在草稿根上不出胶囊（等同改整张），框要撤掉；合并到外层、超过上限时框跟着胶囊走
  const [selSeq, setSelSeq] = useState(0);
  const framed = picking ? pickQids.join(',') : '';
  useEffect(() => {
    if (!ready || !picking) return;
    const qids = framed ? framed.split(',') : [];
    post({ type: 'quilt:highlight', qid: qids[qids.length - 1] ?? null, ...(qids.length > 1 ? { qids } : null) });
  }, [ready, readySeq, picking, framed, selSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  // 输入框是空的、有胶囊时，Shift+↑ / Shift+↓ 由输入框转来这里走层级（v1.28）
  useEffect(() => {
    if (!climbRef) return;
    climbRef.current = ready && picking ? (dir) => post({ type: 'quilt:climb', dir }) : null;
    return () => { climbRef.current = null; };
  }, [climbRef, ready, picking]); // eslint-disable-line react-hooks/exhaustive-deps
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const shortcutRef = useRef(onShortcut);
  shortcutRef.current = onShortcut;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  useEffect(() => {
    if (!previewOrigin) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== previewOrigin || e.source !== iframeRef.current?.contentWindow || !isPreviewMessage(e.data)) return;
      const m = e.data;
      recordPreview(m, { screenId: draft.id });
      if (m.type === 'quilt:ready') { readyRef.current = true; setReady(true); setReadySeq((n) => n + 1); setFailed(false); }
      if (m.type === 'quilt:draft-size' && m.screenId === draft.id) {
        const w = Math.max(48, Math.ceil(m.w));
        const h = Math.max(32, Math.ceil(m.h));
        const cur = boxRef.current;
        // 根元素按视口比例定尺寸（w-1/2、h-[60vh] 一类）时，视口刚收到上报值，它就跟着再缩一截、再报一个更小的框，跟下去会一路缩到底。
        // 视口刚改过的这一小段里的缩小当成这种回声，不跟；交互里真缩小（收起一块）的照常跟
        const echo = !!cur && performance.now() - resizedAt.current < ECHO_MS;
        const next = cur && echo ? { w: Math.max(cur.w, w), h: Math.max(cur.h, h) } : { w, h };
        if (cur?.w !== next.w || cur?.h !== next.h) applyBox(next);
      }
      if (m.type === 'quilt:select') {
        setSelSeq((n) => n + 1);
        if (pickingRef.current) pickRef.current(m);
      }
      // 焦点在草稿里时父页收不到键盘：Esc 与 ⌘ 组合键靠运行时转发，交给页面同一套处理
      if (m.type === 'quilt:key' && m.key === 'Escape') escape.current();
      else if (m.type === 'quilt:key' && m.code && (m.metaKey || m.ctrlKey)) shortcutRef.current(m.code);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [previewOrigin, draft.id]);
  useEffect(() => {
    if (!component || !ready || box) return;
    const t = window.setTimeout(() => { if (!boxRef.current) applyBox(FALLBACK_BOX); }, SIZE_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [component, ready, box]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // iframe 里正显示的是哪一版：初次加载与整页重载是地址里的那版，原地换之后是换上去的那版
  const shownRev = useRef(draft.currentRevisionId);
  const reloadFresh = async () => {
    const d = await onStale();
    const fresh = d?.screens.find((s) => s.id === draft.id);
    if (fresh?.previewUrl) { setSrc(fresh.previewUrl); shownRev.current = fresh.currentRevisionId; }
    readyRef.current = false; setReady(false); setLoadKey((k) => k + 1);
  };
  // 新的一版原地换（PAGE-SKETCH「看板」，同画布的聚焦态热更新）：取新版 HTML 经 quilt:swap 送进去，iframe 不重载、不出骨架，滚动位置留着；
  // 签名过期取不到时重取详情再取一次，仍取不到才整页重载
  useEffect(() => {
    const rev = draft.currentRevisionId;
    if (!ready || !rev || !draft.previewUrl || rev === shownRev.current) return;
    let stale = false;
    const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`preview ${r.status}`); return r.text(); };
    void (async () => {
      let html: string;
      try { html = await get(draft.previewUrl!); }
      catch {
        const fresh = (await onStale())?.screens.find((s) => s.id === draft.id)?.previewUrl;
        if (!fresh) throw new Error('preview unavailable');
        html = await get(fresh);
      }
      if (stale) return;
      shownRev.current = rev;
      post({ type: 'quilt:swap', html, route: draft.route, keepScroll: true });
    })().catch(() => { if (!stale) { shownRev.current = rev; void reloadFresh(); } });
    return () => { stale = true; };
  }, [ready, draft.currentRevisionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onLoad = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (readyRef.current) return;
      if (retried.current) { setFailed(true); return; }
      retried.current = true;
      void reloadFresh();
    }, 2000);
  };

  return (
    <div className="draft-frame" data-frame={component ? 'component' : 'page'} style={{ width: nat.w * scale, height: nat.h * scale }}>
      {/* 按看板缩小用 zoom，不用 transform：iframe 在里面仍按草稿的视口排版，按目标倍率原生绘制。Chromium 在带缩放变换的跨域 iframe 里用 GPU 合成时，
          会把同时带 backdrop-filter 与 box-shadow 的元素画错——一片灰色渐变盖住邻近的内容（2026-10-20 有头 Edge 实测，无头复现不出） */}
      <div className={cn('absolute left-0 top-0', bleed ? 'overflow-visible' : 'overflow-hidden')} style={{ width: nat.w, height: nat.h, zoom: scale }}>
        {!shown && <div className="draft-skeleton absolute inset-0" />}
        {live && (
          <iframe
            key={loadKey} ref={iframeRef} src={src!} title={draft.name} data-testid="draft-iframe" sandbox="allow-scripts allow-same-origin allow-forms"
            onLoad={onLoad} inert={!shown} tabIndex={shown ? undefined : -1}
            className={cn('absolute left-0 top-0 block border-0 transition-opacity duration-(--semantic-motion-duration-fast) ease-(--semantic-motion-easing-standard)', !component && 'bg-neutral-0', shown ? 'opacity-100' : 'opacity-0')}
            // color-scheme 与预览文档一致：不一致时浏览器给 iframe 铺一层不透明底，组件画框的透明背景就透不出来。预览文档不声明 color-scheme，
            // 用的是 light；这里不写会继承外壳（暗色外观下是 dark），写 normal 也不行——外壳的 <meta name="color-scheme" content="light dark"> 让它在暗色偏好下按 dark 算
            style={{ width: frameSide(view.w, scale), height: frameSide(view.h, scale), colorScheme: 'light', ...(bleed ? { left: -DRAFT_PAD, top: -DRAFT_PAD } : null) }}
          />
        )}
      </div>
      {!shown && !failed && (
        <span className="absolute left-1/2 top-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-sm px-3 py-1.5 type-label inverse">
          <span className="sk-dot shrink-0" aria-hidden="true" /><span className="truncate" role="status">{!draft.currentRevisionId ? progress ?? t('stage.generating') : t('stage.loading')}</span>
        </span>
      )}
      {failed && (
        <button type="button" data-testid="draft-retry" onClick={() => { setFailed(false); void reloadFresh(); }}
          className="state-layer focus-ring absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-warning bg-surface-raised px-3 py-1.5 type-label font-semibold text-warning shadow-(--semantic-elevation-raised)">{t('stage.retry')}</button>
      )}
    </div>
  );
}
