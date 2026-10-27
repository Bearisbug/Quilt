import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isPreviewMessage, type ParentToPreview, type ScreenDto } from '@quilt/core/browser';
import { markPalette, useResolvedMode } from '@/lib/theme';
import { recordPreview } from '@/lib/recorder';
import { frameSide } from '@/lib/frameZoom';
import type { SelectMessage } from '@/canvas/frameMessages';
import { cn } from '@/ui/ui';
import { useLocale, useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';

type Size = { w: number; h: number };
type Shown = { id: string; rev: string | null; dims?: string };
const fit = (nat: Size, room: Size | null) => (room ? Math.max(0.05, Math.min(1, room.w / nat.w, room.h / nat.h)) : 1);
const same = (a: Shown | null, b: ScreenDto | null) => (!a && !b) || (!!a && !!b && a.id === b.id && a.rev === b.currentRevisionId);
// 换 DOM 之后等运行时回 quilt:swapped（整份重写时是新文档的 quilt:ready）再压叠层；等不到就不再等，免得一直卡住后面的同步
const LANDED_MS = 5000;

/**
 * 设备台（PAGE-FULLVIEW「设备台」，FLOW-FULLVIEW S3 / S5 / S7 / S8）：当前这一屏的活 iframe，视口按端的设备，放到中栏能放下的最大、最大 1:1，
 * 放不下用 zoom 等比缩小（同草稿本看板）。地址钉住只加载一次，之后换屏、出新版都经 quilt:swap 送进同一个文档；叠层屏底下先垫 under。
 * 状态取值（quilt:states）在每次就绪后重发，换 DOM 时运行时自己留着；屏里点了站内链接只上报，跳去哪由页面定
 */
export function DeviceStage({ screen, under, size, previewOrigin, dimsKey, values, playRef, picking, pickQids, onPick, climbRef, onNavigate, onOverlayDismiss, onEscape, onShortcut, onStale, onPreviewError }: {
  screen: ScreenDto;
  /** 叠层屏单独打开时垫在底下的整屏（这一端第一张整屏）；screen 不是叠层或这一端没有整屏时为 null */
  under: ScreenDto | null;
  size: Size;
  previewOrigin: string;
  /** 端上的维度与事件（序列化）：变了就把底下这一屏原地再送一次，运行时从新下发的 head 里拿到当前的维度 */
  dimsKey: string;
  values: Record<string, string>;
  /** 页面播事件用（状态栏的「事件」）：设备台就绪后挂上 */
  playRef: RefObject<((key: string, ms?: number) => void) | null>;
  picking: boolean; pickQids: string[]; onPick: (m: SelectMessage) => void;
  climbRef: RefObject<((dir: 'up' | 'down') => void) | null>;
  onNavigate: (href: string) => void;
  onOverlayDismiss: () => void;
  onEscape: () => void;
  onShortcut: (code: string, alt: boolean) => void;
  onStale: () => Promise<{ screens: ScreenDto[] } | null>;
  onPreviewError: (s: ScreenDto) => void;
}) {
  const t = useT(fullviewMessages);
  const roomRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = fit(size, room);

  const base = screen.presentation === 'overlay' && under ? under : screen;
  const layer = base === screen ? null : screen;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 地址钉住：签名每 30 分钟换一个窗口，换了也不重载；pinned 是这个地址加载出来的那一屏那一版
  const [src, setSrc] = useState(base.previewUrl);
  const pinned = useRef<Shown | null>(base.previewUrl ? { id: base.id, rev: base.currentRevisionId, dims: dimsKey } : null);
  useEffect(() => { if (!src && base.previewUrl) { pinned.current = { id: base.id, rev: base.currentRevisionId, dims: dimsKey }; setSrc(base.previewUrl); } }, [src, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loadKey, setLoadKey] = useState(0);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [readySeq, setReadySeq] = useState(0);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  // iframe 里此刻摆着的：底下那一屏与压在上面的叠层（各记屏与修订）
  const shown = useRef<{ base: Shown | null; layer: Shown | null }>({ base: null, layer: null });
  const landed = useRef<(() => void) | null>(null);
  const post = (msg: ParentToPreview) => iframeRef.current?.contentWindow?.postMessage(msg, previewOrigin);

  const htmlOf = async (s: ScreenDto): Promise<string> => {
    const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`preview ${r.status}`); return r.text(); };
    try { if (s.previewUrl) return await get(s.previewUrl); } catch { /* 签名过期：重取一次地址 */ }
    const fresh = (await onStale())?.screens.find((x) => x.id === s.id)?.previewUrl;
    if (!fresh) throw new Error('preview unavailable');
    return get(fresh);
  };
  // 同步成「底下 base、上面 layer」：一次只跑一轮，跑完再看一眼最新的目标，换屏连按时只追最后那一屏
  const want = useRef({ base, layer });
  want.current = { base, layer };
  const dimsRef = useRef(dimsKey);
  dimsRef.current = dimsKey;
  const syncing = useRef(false);
  const again = useRef(false);
  const sync = async () => {
    if (syncing.current) { again.current = true; return; }
    syncing.current = true;
    try {
      do {
        again.current = false;
        const { base: b, layer: l } = want.current;
        if (!same(shown.current.base, b) || shown.current.base?.dims !== dimsRef.current) {
          let html: string;
          try { html = await htmlOf(b); } catch { onPreviewError(b); return; }
          // 同一屏换新版留在原处（S7），换了屏回到顶部
          const keepScroll = shown.current.base?.id === b.id;
          await new Promise<void>((done) => {
            const timer = window.setTimeout(done, LANDED_MS);
            landed.current = () => { window.clearTimeout(timer); done(); };
            post({ type: 'quilt:swap', html, route: b.route, ...(keepScroll ? { keepScroll } : null) });
          });
          shown.current = { base: { id: b.id, rev: b.currentRevisionId, dims: dimsRef.current }, layer: null };
        }
        if (!same(shown.current.layer, l)) {
          if (shown.current.layer) post({ type: 'quilt:overlay-close' });
          shown.current.layer = null;
          if (l) {
            let html: string;
            try { html = await htmlOf(l); } catch { onPreviewError(l); return; }
            post({ type: 'quilt:overlay', html, route: l.route });
            shown.current.layer = { id: l.id, rev: l.currentRevisionId };
          }
        }
      } while (again.current);
    } finally { syncing.current = false; }
  };
  useEffect(() => { if (ready) void sync(); }, [ready, readySeq, base.id, base.currentRevisionId, layer?.id, layer?.currentRevisionId, dimsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 每次就绪（首次加载、整份重写之后）重发模式与取值；换外观、换界面语言时重发模式，屏内标记跟着换色、换字
  const themeMode = useResolvedMode();
  const locale = useLocale();
  useEffect(() => { if (ready) post({ type: 'quilt:mode', mode: picking ? 'inspect' : 'interact', marks: markPalette() }); }, [ready, readySeq, themeMode, locale, picking]); // eslint-disable-line react-hooks/exhaustive-deps
  const valuesKey = JSON.stringify(values);
  useEffect(() => { if (ready) post({ type: 'quilt:states', values: JSON.parse(valuesKey) as Record<string, string> }); }, [ready, readySeq, valuesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    playRef.current = ready ? (key, ms) => post({ type: 'quilt:event', key, ...(ms ? { ms } : null) }) : null;
    return () => { playRef.current = null; };
  }, [ready, playRef]); // eslint-disable-line react-hooks/exhaustive-deps
  // 选元素点中的几块由页面定（输入框里的胶囊），每次点中之后按页面的决定再对一次框
  const [selSeq, setSelSeq] = useState(0);
  const framed = picking ? pickQids.join(',') : '';
  useLayoutEffect(() => {
    if (!ready || !picking) return;
    const qids = framed ? framed.split(',') : [];
    post({ type: 'quilt:highlight', qid: qids[qids.length - 1] ?? null, ...(qids.length > 1 ? { qids } : null) });
  }, [ready, readySeq, picking, framed, selSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    climbRef.current = ready && picking ? (dir) => post({ type: 'quilt:climb', dir }) : null;
    return () => { climbRef.current = null; };
  }, [climbRef, ready, picking]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers = useRef({ onPick, onNavigate, onOverlayDismiss, onEscape, onShortcut, picking });
  handlers.current = { onPick, onNavigate, onOverlayDismiss, onEscape, onShortcut, picking };
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== previewOrigin || e.source !== iframeRef.current?.contentWindow || !isPreviewMessage(e.data)) return;
      const m = e.data;
      const h = handlers.current;
      recordPreview(m, { screenId: shown.current.layer?.id ?? shown.current.base?.id ?? '' });
      if (m.type === 'quilt:ready') {
        // 不是换 DOM 引起的整份重写，就是地址重新加载：摆着的是钉住的那一屏
        if (landed.current) { landed.current(); landed.current = null; } else shown.current = { base: pinned.current, layer: null };
        readyRef.current = true; setReady(true); setReadySeq((n) => n + 1); setFailed(false); retried.current = false;
      }
      if (m.type === 'quilt:swapped') { landed.current?.(); landed.current = null; }
      if (m.type === 'quilt:select') { setSelSeq((n) => n + 1); if (h.picking) h.onPick(m); }
      if (m.type === 'quilt:navigate') h.onNavigate(m.href);
      if (m.type === 'quilt:overlay-dismiss') h.onOverlayDismiss();
      // 焦点在页面里时父页收不到键盘：Esc、⌘ 与 ⌥ 组合键靠运行时转发
      if (m.type === 'quilt:key' && m.key === 'Escape') h.onEscape();
      else if (m.type === 'quilt:key' && m.code && (m.metaKey || m.ctrlKey || m.altKey)) h.onShortcut(m.code, m.altKey && !m.metaKey && !m.ctrlKey);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [previewOrigin]);

  // 就绪看门：load 之后 2 s 还没收到 quilt:ready，多半是签名过期——重取地址重载一次，仍不行给「重试」
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const reloadFresh = async () => {
    const fresh = (await onStale())?.screens.find((s) => s.id === want.current.base.id);
    if (fresh?.previewUrl) { pinned.current = { id: fresh.id, rev: fresh.currentRevisionId, dims: dimsRef.current }; setSrc(fresh.previewUrl); }
    landed.current = null;
    readyRef.current = false; setReady(false); setLoadKey((k) => k + 1);
  };
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
    <div ref={roomRef} className="absolute inset-0 grid place-items-center" data-testid="device-stage">
      <div className="draft-frame" data-frame="page" data-scale={scale} style={{ width: size.w * scale, height: size.h * scale }}>
        {/* 缩小用 zoom，不用 transform：iframe 里仍按设备视口排版、按目标倍率原生绘制（同草稿本看板） */}
        <div className="absolute left-0 top-0 overflow-hidden" style={{ width: size.w, height: size.h, zoom: scale }}>
          {!ready && <div className="draft-skeleton absolute inset-0" />}
          {src && (
            <iframe
              key={loadKey} ref={iframeRef} src={src} title={screen.name} data-testid="device-iframe" sandbox="allow-scripts allow-same-origin allow-forms"
              onLoad={onLoad} inert={!ready} tabIndex={ready ? undefined : -1}
              className={cn('absolute left-0 top-0 block border-0 bg-neutral-0 transition-opacity duration-(--semantic-motion-duration-fast) ease-(--semantic-motion-easing-standard)', ready ? 'opacity-100' : 'opacity-0')}
              style={{ width: frameSide(size.w, scale), height: frameSide(size.h, scale), colorScheme: 'light' }}
            />
          )}
        </div>
        {!ready && !failed && (
          <span className="absolute left-1/2 top-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-sm px-3 py-1.5 type-label inverse">
            <span className="sk-dot shrink-0" aria-hidden="true" /><span className="truncate" role="status">{t('stage.loading')}</span>
          </span>
        )}
        {failed && (
          <button type="button" data-testid="device-retry" onClick={() => { setFailed(false); retried.current = true; void reloadFresh(); }}
            className="state-layer focus-ring absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-warning bg-surface-raised px-3 py-1.5 type-label font-semibold text-warning shadow-(--semantic-elevation-raised)">{t('stage.retry')}</button>
        )}
      </div>
    </div>
  );
}
