import { useState, type KeyboardEvent, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Overlay, useModal } from '@/ui/modal';
import { IconButton } from '@/ui/ui';

export type ViewerImage = { id: string; url: string; caption: string };

// 参考图大图预览（REQ-CORE-026 v0.72）：整个对话已加载的参考图是一组，按时间顺序左右切换、翻到头不循环。
// 当前是哪一张由父组件按「消息 + 图」定位后给出（v0.74）：对话列表在预览开着时变了，序号跟着变、图不换；这里再夹一道越界保护。
// 焦点陷阱 / Esc / 背景 inert / 关闭归还焦点由 useModal 管（A11Y-004 / A11Y-005）；初始焦点落在容器上，←/→ 立即可用。
// 两端的翻页键用 aria-disabled 而不是 disabled：原生 disabled 会让刚按下它的焦点掉到 body（A11Y-013）
export function ImageViewer({ images, index, onIndex, returnTo, onClose }: { images: ViewerImage[]; index: number; onIndex: (i: number) => void; returnTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const i = Math.min(Math.max(0, index), images.length - 1);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const ref = useModal<HTMLDivElement>(onClose, returnTo, undefined, { initialFocus: 'self' });
  const img = images[i];
  const first = i === 0; const last = i === images.length - 1;
  const go = (d: number) => onIndex(Math.min(images.length - 1, Math.max(0, i + d)));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  };
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="image-viewer-title" tabIndex={-1} onKeyDown={onKeyDown} data-testid="image-viewer" data-index={i}
        className="fade-up flex size-full max-w-6xl flex-col gap-3 outline-none">
        <div className="flex items-center gap-3 text-sm text-white">
          <p id="image-viewer-title" aria-live="polite" className="min-w-0 flex-1 truncate">
            <span className="font-medium tabular-nums">参考图 {i + 1} / {images.length}</span>
            {img.caption && <span className="text-white/70"> · 「{img.caption}」</span>}
          </p>
          <IconButton label="关闭" hint="Esc" size="sm" tip="bottom" onClick={onClose} className="text-white hover:bg-white/15 hover:text-white"><X size={18} aria-hidden="true" /></IconButton>
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-3">
          <IconButton label="上一张" hint="←" size="sm" tip="top" unavailable={first && '已经是第一张'} onClick={() => go(-1)} data-testid="viewer-prev" className="text-white hover:bg-white/15 hover:text-white"><ChevronLeft size={22} aria-hidden="true" /></IconButton>
          {/* 点图外的空白处关闭，与点遮罩一致：这一层铺满了遮罩，遮罩自己的点击收不到 */}
          <div className="grid min-h-0 min-w-0 flex-1 place-items-center self-stretch" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            {broken.has(img.id)
              ? <p className="text-sm text-white/70">参考图已过期</p>
              : <img key={img.id} src={img.url} alt={`参考图 ${i + 1}`} data-testid="viewer-image"
                  className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
                  onError={() => setBroken((s) => new Set(s).add(img.id))} />}
          </div>
          <IconButton label="下一张" hint="→" size="sm" tip="top" unavailable={last && '已经是最后一张'} onClick={() => go(1)} data-testid="viewer-next" className="text-white hover:bg-white/15 hover:text-white"><ChevronRight size={22} aria-hidden="true" /></IconButton>
        </div>
      </div>
    </Overlay>
  );
}
