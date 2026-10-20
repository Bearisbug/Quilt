import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { DEVICE_SIZE, isPreviewMessage, type DeviceType, type ParentToPreview, type ScreenDto } from '@quilt/core/browser';
import { loadConfig } from '@/lib/api';
import { markPalette, useResolvedMode } from '@/lib/theme';
import { useLocale, useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

/** 「换一块」点中的元素：写回要它的 qid，「换掉 …」那句要标签与文字 */
export type PickedElement = { qid: string; tag: string; text: string };

// 预览框的高度上限：26rem 与视口高的 46% 取小。手机屏因此按高度缩、桌面屏按弹层宽度缩，整个视口都露出来、不裁切
const MAX_H_REM = 26;
const MAX_H_VH = 0.46;
// 外框 1px 边线，量到的宽要扣掉两侧
const EDGE = 2;
// 「换掉 …」那句里文字最多带几个字（按码点截，不把 emoji 截成半个）
const TEXT_MAX = 24;

const clip = (s: string) => { const cs = Array.from(s.trim()); return cs.length > TEXT_MAX ? `${cs.slice(0, TEXT_MAX).join('')}…` : cs.join(''); };

// 写回弹层「换一块」的目标屏活预览（FLOW-SKETCH-COPY S4，REQ-CORE-044）：预览域的 iframe 一直在选元素态，协议同画布的聚焦屏（ADR-003）——
// 就绪后下发 quilt:mode inspect（带当前外观的标记色，换外观重发），点中元素由运行时框出并回 quilt:select。父页的 picked 是选中的事实源，
// 变了就用 quilt:highlight 同步常驻框；点在共享组件实例里的不收（服务端同样会拒，/errors/component-locked），把框挪回原来那一块并就地说明。
// 打开时有 initialQid（草稿的写回目标那一块）就用 quilt:reselect 预选，元素已不在则回 quilt:deselect。
// 只认这个 iframe 发来、来源是预览域、形状过 previewMessageSchema 的消息。目标屏出了新修订由调用方换 key 重挂。
// 就绪看门同草稿看板：load 后 2 s 还没 quilt:ready 多半是签名过期，经 onStale 重取地址重载一次，仍不行给「重试」
export function TargetPicker({ screen, deviceType, picked, initialQid, onPick, onEscape, onStale }: {
  screen: ScreenDto;
  /** 目标项目的设备形态：iframe 的视口 */
  deviceType: DeviceType;
  picked: PickedElement | null;
  initialQid: string | null;
  onPick: (el: PickedElement | null) => void;
  /** 焦点在 iframe 里时弹层收不到 Esc，由运行时转发过来 */
  onEscape: () => void;
  /** 预览签名过期时重取目标项目详情，返回这一屏的新值 */
  onStale: () => Promise<ScreenDto | null>;
}) {
  const t = useT(sketchMessages);
  const view = DEVICE_SIZE[deviceType];
  const wrapRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  // 地址钉住：签名换窗口也不重载正在点选的预览，只有看门判定过期时才换
  const [src, setSrc] = useState(screen.previewUrl);
  const [loadKey, setLoadKey] = useState(0);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // 点在共享组件里、预选的那一块已不在：就地说明，下一次点中别的元素时撤掉
  const [note, setNote] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const w = el.clientWidth - EDGE;
      const h = Math.min(MAX_H_REM * rem, window.innerHeight * MAX_H_VH) - EDGE;
      setRoom((r) => (r && r.w === w && r.h === h ? r : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const scale = room ? Math.max(0.05, Math.min(1, room.w / view.w, room.h / view.h)) : 0;

  const fetchOrigin = () => { setFailed(false); loadConfig().then((c) => setOrigin(c.previewOrigin)).catch(() => setFailed(true)); };
  useEffect(fetchOrigin, []);
  const post = useCallback((msg: ParentToPreview) => { if (origin) iframeRef.current?.contentWindow?.postMessage(msg, origin); }, [origin]);

  // 消息处理读最近一次渲染的 props；window 上的监听按预览域挂一次
  const latest = useRef({ picked, initialQid, onPick, onEscape });
  latest.current = { picked, initialQid, onPick, onEscape };
  useEffect(() => {
    if (!origin) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== iframeRef.current?.contentWindow || !isPreviewMessage(e.data)) return;
      const m = e.data;
      const p = latest.current;
      if (m.type === 'quilt:ready') {
        readyRef.current = true; setReady(true); setFailed(false);
        post({ type: 'quilt:mode', mode: 'inspect', marks: markPalette() });
        // 重载过（签名过期）就接回用户已点中的那一块，否则预选写回目标
        const q = p.picked?.qid ?? p.initialQid;
        if (q) post({ type: 'quilt:reselect', qid: q });
      }
      if (m.type === 'quilt:select') {
        if (m.component) { post({ type: 'quilt:highlight', qid: p.picked?.qid ?? null }); setNote(t('lockedName', { name: m.component })); return; }
        setNote(null);
        p.onPick({ qid: m.qid, tag: m.tag, text: m.text });
      }
      if (m.type === 'quilt:deselect') { setNote(t('blockGone')); p.onPick(null); }
      if (m.type === 'quilt:key' && m.key === 'Escape') p.onEscape();
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [origin, post, t]);

  // 父页清掉或换了选中（写回撞上「元素已不在」）时，常驻框跟着走；就绪之前不发，就绪时由上面的预选接手
  const pickedQid = picked?.qid ?? null;
  useEffect(() => { if (readyRef.current) post({ type: 'quilt:highlight', qid: pickedQid }); }, [pickedQid, post]);
  // 换外观、换界面语言时重发一次：屏内的选中框、悬停框跟着换色，修改标记跟着换字（§13.1）
  const themeMode = useResolvedMode();
  const locale = useLocale();
  useEffect(() => { if (readyRef.current) post({ type: 'quilt:mode', mode: 'inspect', marks: markPalette() }); }, [themeMode, locale, post]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const reloadFresh = async () => {
    const fresh = await onStale();
    if (fresh?.previewUrl) setSrc(fresh.previewUrl);
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
  const retry = () => { if (!origin) { fetchOrigin(); return; } setFailed(false); retried.current = true; void reloadFresh(); };

  return (
    <div ref={wrapRef} role="group" aria-label={t('picker.label', { name: screen.name })} data-testid="target-picker" data-ready={ready ? 'true' : undefined} className="w-full">
      {room && (
        // 外框是用户设计稿的白（同画布卡片），1px 边线把它和弹层底分开；iframe 按设备视口渲染再整体缩小
        <div className="relative mx-auto overflow-hidden rounded-md border border-border-subtle bg-neutral-0" style={{ width: Math.round(view.w * scale) + EDGE, height: Math.round(view.h * scale) + EDGE }}>
          <div className="absolute left-0 top-0" style={{ width: view.w, height: view.h, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            {origin && src && (
              <iframe
                key={loadKey} ref={iframeRef} src={src} title={t('picker.frameTitle', { name: screen.name })} sandbox="allow-scripts allow-same-origin allow-forms"
                onLoad={onLoad} inert={!ready} tabIndex={ready ? undefined : -1}
                className="absolute left-0 top-0 block size-full border-0 bg-neutral-0"
                // 预览文档按 light 渲染；不写会继承外壳的 dark，浏览器给 iframe 铺一层不透明底（同草稿看板）
                style={{ colorScheme: 'light' }}
              />
            )}
          </div>
          {!ready && !failed && (
            <div className="draft-skeleton absolute inset-0 grid place-items-center">
              <span role="status" className="max-w-[calc(100%-1.5rem)] truncate rounded-sm px-3 py-1.5 type-label inverse">{t('picker.loading', { name: screen.name })}</span>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 grid place-items-center bg-(--semantic-color-surface-sunken)">
              <button type="button" data-testid="target-picker-retry" onClick={retry}
                className="state-layer focus-ring whitespace-nowrap rounded-sm border border-warning bg-surface-raised px-3 py-1.5 type-label font-semibold text-warning">{t('picker.retry')}</button>
            </div>
          )}
        </div>
      )}
      <p className="mt-2 type-label" aria-live="polite">
        {picked
          ? <span data-testid="copy-picked" className="text-text-primary">
            {/* 标签与文字作为整件嵌进句子（<el/>、<txt/>），不经插值：元素文字里的尖括号不会被当成标记 */}
            <Trans ns={sketchMessages.ns} i18nKey={picked.text.trim() ? 'picker.pickedText' : 'picker.picked'} components={{ el: <code>&lt;{picked.tag}&gt;</code>, txt: <>{clip(picked.text)}</> }} />
          </span>
          : <span className="text-text-secondary">{t('picker.hint')}</span>}
      </p>
      {note && <p data-testid="copy-locked" className="mt-1 type-label text-warning">{note}</p>}
    </div>
  );
}
