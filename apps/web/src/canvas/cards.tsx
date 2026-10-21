import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { ComponentDto, ScreenDto } from '@quilt/core/browser';
import { useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';

// 画布上的屏卡片与组件卡（v1.07 从 CanvasView.tsx 抽出）：memo 化，props 只给这一张卡的标量与稳定的动作表——
// 拖一张卡、框选、截图档位变化时，只有受影响的那几张重渲染，不再整片画布跟着跑
export type CardKind = 'screen' | 'component';
/** 卡片发起的动作：由 CanvasView 给出一份引用不变的表，每个方法转调它最近一次渲染里的实现 */
export type CardActions = {
  shotError: () => void;
  shotGiveUp: (id: string, failed: boolean) => void;
  shotShown: (id: string, src: string) => void;
  retryShot: (id: string) => void;
  cardFocus: (id: string) => void;
  cardKey: (e: ReactKeyboardEvent<HTMLElement>, kind: CardKind, id: string) => void;
  dragStart: (e: ReactPointerEvent, kind: CardKind, id: string) => void;
  enterScreen: (id: string) => void;
  enterComponent: (id: string) => void;
  dangling: (screenId: string, hrefs: string[]) => void;
  candidates: (jobId: string, screenId: string) => void;
  gesture: (id: string, el: HTMLElement | null) => void;
  compFrame: (id: string, el: HTMLIFrameElement | null) => void;
  watchOnscreen: (el: HTMLElement | null) => (() => void) | undefined;
};

// 鼠标点卡片不把焦点留在卡片上，焦点照旧回到页面：卡片只是键盘停靠点，鼠标点过之后按住空格仍要是平移、Delete / F 这些单键照常
export const keepPointerFocus = (e: ReactMouseEvent) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); };

type ScreenCardProps = {
  s: ScreenDto; idx: number; x: number; y: number;
  selected: boolean; focused: boolean; live: boolean; dragging: boolean;
  /** 卡片显示哪一张截图（原图或缩略图，v1.02 ADR-029） */
  shotUrl: string | null; shotFailed: boolean; shotRetry: number;
  working: boolean; dangling?: string[];
  exemplar: boolean; variants: number; tabbable: boolean; panReady: boolean;
  /** 有候选未采用：卡片后面的错位底板（stacked）与角标；candExpanded = 这一屏的候选正就地展开 */
  stacked: boolean; candExpanded: boolean;
  /** 聚焦屏（或退出聚焦后留着的那一张）的 iframe，垫在截图之上 */
  frame?: ReactNode;
  /** 聚焦屏卡内的变体胶囊与角标 */
  chrome?: ReactNode;
  act: CardActions;
};

export const ScreenCard = memo(function ScreenCard({ s, idx, x, y, selected, focused, live, dragging, shotUrl, shotFailed, shotRetry, working, dangling, exemplar, variants, tabbable, panReady, stacked, candExpanded, frame, chrome, act }: ScreenCardProps) {
  const t = useT(canvasMessages);
  const desktop = s.width > 600;
  const gestureRef = useCallback((el: HTMLDivElement | null) => act.gesture(s.id, el), [act, s.id]);
  const onGiveUp = useCallback((failed: boolean) => act.shotGiveUp(s.id, failed), [act, s.id]);
  const onShown = useCallback((src: string) => act.shotShown(s.id, src), [act, s.id]);
  return (
    <>
      {stacked && [2, 1].map((k) => <div key={k} className={`cand-ghost${desktop ? ' desktop' : ''}`} aria-hidden="true" style={{ width: s.width, height: s.height, transform: `translate(${x + 14 * k}px, ${y + 10 * k}px)`, opacity: 1 - 0.25 * k }} />)}
      <div ref={act.watchOnscreen} data-testid="screen-card" data-route={s.route} data-variant={s.variantOf ? 'true' : undefined} data-presentation={s.presentation} className={`card${desktop ? ' desktop' : ''}${s.presentation === 'overlay' ? ' overlay' : ''}${selected ? ' selected' : ''}${focused ? ' focused' : ''}${live ? ' live' : ''}${dragging ? ' dragging' : ''}`} style={{ width: s.width, height: s.height, transform: `translate(${x}px, ${y}px)` }}>
        <div className="label">{s.variantOf && <span className="chip fill">{t('card.variant')}</span>}{s.presentation === 'overlay' && <span className="chip fill">{t('card.overlay')}</span>}<b>{s.name}</b> {s.route}{exemplar ? ` · ${t('card.exemplar')}` : ''}{variants ? ` · ${t('card.variants', { count: variants })}` : ''}{s.deviations ? ` · ${t('deviations', { count: s.deviations })}` : ''}</div>
        {/* 圆角裁切只包截图 / 骨架 / iframe 这一层（v0.80）：裁整张卡的话，画在卡片上方的标签一起被裁掉 */}
        <div className="card-clip">
          {/* 截图（或骨架）始终垫在底下（v0.76）：聚焦时 iframe 盖在上面、收到 quilt:ready 前透明，就绪才接班（卡片加 live，底层藏起）——
              双击即撤掉截图的话，iframe 加载的 1 s 多里整张卡是白的，深色屏黑→白→黑 */}
          {s.screenshotUrl ? (
            <CardShot url={shotUrl!} width={s.width} height={s.height} alt={s.name} onError={act.shotError}
              retryKey={shotRetry} onGiveUp={onGiveUp} onShown={onShown}
              fallback={<CardSkeleton desktop={desktop} delay={(idx % 6) * -230} />} failed={<CardSkeleton desktop={desktop} delay={0} failed />} />
          ) : (
            <CardSkeleton desktop={desktop} delay={(idx % 6) * -230} status={s.currentRevisionId ? 'shooting' : 'generating'} />
          )}
          {frame}
        </div>
        {/* 截图取不到（v0.83）：盖在手势层之上、卡片正中，点了从头再取；聚焦时 iframe 接班，不出 */}
        {!focused && s.screenshotUrl && shotFailed && (
          <button type="button" className="shot-retry state-layer nopan" data-testid="shot-retry" onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => { ev.stopPropagation(); act.retryShot(s.id); }}>{t('card.shotRetry')}</button>
        )}
        {/* 同一张卡同时有未结清候选时错开一行：两者右上同位、同底色同尺寸，叠在一起会把角标整块盖住 */}
        {!focused && working && <span className={`working${s.pendingCandidates ? ' below' : ''}`} data-testid="card-working">{t('card.working')}</span>}
        {!focused && <div ref={gestureRef} className={`gesture${panReady ? '' : ' nopan'}`} role="button" tabIndex={tabbable ? 0 : -1} aria-label={`${s.name} ${s.route}`}
          onFocus={() => act.cardFocus(s.id)} onKeyDown={(ev) => act.cardKey(ev, 'screen', s.id)} onMouseDown={keepPointerFocus}
          onPointerDown={(ev) => act.dragStart(ev, 'screen', s.id)} onDoubleClick={(ev) => { ev.stopPropagation(); act.enterScreen(s.id); }} />}
        {chrome}
        {dangling && (
          <button type="button" className="warn state-layer focus-ring nopan cursor-pointer" style={{ pointerEvents: 'auto' }} title={t('card.danglingTitle', { hrefs: dangling.join(', ') })} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); act.dangling(s.id, dangling); }}>
            {t('card.dangling', { count: dangling.length, href: dangling[0] })}{dangling.length > 1 ? ' …' : ''}
          </button>
        )}
      </div>
      {/* 待采用的候选批（REQ-CORE-015）：角标就地展开 / 收起。画在卡片之外、与卡片同位的一层槽位里——
          卡片自带 transform 是独立层叠上下文，角标留在卡片里时 z-index 再高也盖不过展开层，
          「再点一次角标收起」就永远点不到（展开层第 0 格的 iframe 正压在这一角） */}
      {s.pendingCandidates && !focused && (
        <div className={`cand-badge-slot${candExpanded ? ' expanded' : ''}`} style={{ width: s.width, transform: `translate(${x}px, ${y}px)` }}>
          <button type="button" className="cand-badge state-layer focus-ring nopan" data-testid="candidate-badge" data-route={s.route} data-count={s.pendingCandidates.count} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); act.candidates(s.pendingCandidates!.jobId, s.id); }}>
            {t('card.candidates', { count: s.pendingCandidates.count })}
          </button>
        </div>
      )}
    </>
  );
});

type ComponentCardProps = {
  c: ComponentDto; x: number; y: number; w: number; h: number;
  /** iframe 的平移：把量到的根元素对齐卡片左上角（没量到时不平移） */
  shift: string | undefined;
  ready: boolean; selected: boolean; focused: boolean; dragging: boolean; tabbable: boolean; panReady: boolean;
  screenW: number; screenH: number;
  act: CardActions;
};

// 共享组件卡（REQ-EDIT-006）：活渲染在预览域里，尺寸由它量根元素后上报；同一套选中 outline，拖动走 .gesture。
// iframe 与聚焦屏同样带 allow-same-origin：尺寸上报要按 origin 认，纯 allow-scripts 的沙箱 origin 是 "null" 对不上
export const ComponentCard = memo(function ComponentCard({ c, x, y, w, h, shift, ready, selected, focused, dragging, tabbable, panReady, screenW, screenH, act }: ComponentCardProps) {
  const t = useT(canvasMessages);
  const frameRef = useCallback((el: HTMLIFrameElement | null) => act.compFrame(c.id, el), [act, c.id]);
  const gestureRef = useCallback((el: HTMLDivElement | null) => act.gesture(c.id, el), [act, c.id]);
  return (
    <div ref={act.watchOnscreen} data-testid="component-card" data-name={c.name} data-ready={ready || undefined} className={`comp${ready ? ' live' : ''}${selected ? ' selected' : ''}${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}`} style={{ width: w, height: h, transform: `translate(${x}px, ${y}px)` }}>
      <div className="label"><b>{c.name}</b> · {t('usedIn', { count: c.usedBy.length })}</div>
      {/* 上报尺寸前：屏卡片那一套骨架垫着、iframe 透明，上报后 iframe 淡入（v0.76）。iframe 恒按整个设备渲染、平移到根元素左上角，由卡片裁切 */}
      <div className="card-clip">
        <div className="skeleton" aria-hidden="true" />
        <iframe ref={frameRef} className="nowheel nopan" src={c.previewUrl} title={c.name} sandbox="allow-scripts allow-same-origin" style={{ width: screenW, height: screenH, transform: shift }} />
      </div>
      {/* 交互态（与屏一致：双击进、Esc 出）。这层手势罩摘掉，指针才落得到 iframe 上；
          进的时候镜头同屏一样摆过去（CanvasView 的 focusComponent）：画布缩得很小时组件卡只有几十像素宽，不摆过去点不中 */}
      {!focused && <div ref={gestureRef} className={`gesture${panReady ? '' : ' nopan'}`} role="button" tabIndex={tabbable ? 0 : -1} aria-label={t('card.component', { name: c.name })}
        onFocus={() => act.cardFocus(c.id)} onKeyDown={(ev) => act.cardKey(ev, 'component', c.id)} onMouseDown={keepPointerFocus}
        onPointerDown={(ev) => act.dragStart(ev, 'component', c.id)} onDoubleClick={(ev) => { ev.stopPropagation(); act.enterComponent(c.id); }} />}
      {/* 交互态只用一个呼吸绿点：组件名已经写在卡片标签上，角标再重复一遍就是拿走卡片右上一整条。
          不是纯靠颜色表态——名字给了读屏，卡片本身还有标记色外框（A11Y-001） */}
      {focused && <span className="live-dot" role="status" aria-label={t('interacting')} title={t('interacting')} />}
    </div>
  );
});

// 屏卡片的占位：设备线框 + 整块呼吸；status 给了就是「截图中 / 生成中」这类状态标签（没有截图时），没给就是截图还在下载。
// failed = 截图重试到头仍取不到（v0.83）：线框不动、不呼吸、不带标签，说明与「重试」由卡片盖在手势层之上给（shot-retry）
function CardSkeleton({ desktop, delay, status, failed }: { desktop: boolean; delay: number; status?: 'shooting' | 'generating'; failed?: boolean }) {
  const t = useT(canvasMessages);
  return (
    <div className={`skeleton${desktop ? ' desktop' : ''}${failed ? ' failed' : ''}`} style={{ animationDelay: `${delay}ms` }} role="img" aria-label={failed ? t('card.skeleton.failed') : status === 'generating' ? t('card.generating') : status ? t('card.skeleton.shooting') : t('card.skeleton.loading')}>
      {desktop ? (
        <><div className="sk sk-side" /><div className="sk sk-topbar" /><div className="sk sk-title" /><div className="sk sk-grid"><i /><i /><i /></div><div className="sk sk-table" /></>
      ) : (
        <><div className="sk sk-appbar" /><div className="sk sk-hero" /><div className="sk sk-line" /><div className="sk sk-line short" /><div className="sk sk-card" /><div className="sk sk-card" /><div className="sk sk-cta" /><div className="sk sk-tabbar"><i /><i /><i /><i /></div></>
      )}
      {status && <div className="sk-label"><span className="sk-dot" />{t(`card.${status}`)}</div>}
    </div>
  );
}

// 卡片截图（v0.76）：截图地址变了（出新截图、签名换窗口）时新图叠在旧图上、透明，解码完成才接班；没有旧图时 fallback（骨架）留到那一刻——
// decoding=async 的图解码前那几帧画的是卡片白底，深色屏会闪一下白。仍是 loading=lazy：只有进了视野的卡才取图。
// 取图失败（多半是签名过期）交给父页静默重取签名；地址没变时那一下换不来新请求，所以同一地址自己隔 2 s、6 s 各再取一次（v0.83，DATA-006 退避限次）。
// 还取不到就收手：有旧图留旧图，没有就换成不动的 failed 并经 onGiveUp 报给卡片。地址变了或 retryKey 变了（点了「重试」）从头再来
const SHOT_RETRY_MS = [2000, 6000];
function CardShot({ url, width, height, alt, fallback, failed, retryKey, onError, onGiveUp, onShown }: { url: string; width: number; height: number; alt: string; fallback: ReactNode; failed: ReactNode; retryKey: number; onError?: () => void; onGiveUp?: (failed: boolean) => void; onShown?: (src: string) => void }) {
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
    void img.decode().catch(() => {}).then(() => { setShown({ src, key: k }); onShown?.(src); });
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
