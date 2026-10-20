import type { ScreenDto } from '@quilt/core/browser';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn, IconButton } from '@/ui/ui';
import { relTime, useNow } from '@/sketch/relTime';

// 记录栏（PAGE-SKETCH，REQ-CORE-040）：右侧一列，全部草稿按创建时间倒序，每项缩略图 + 名字 + 相对时间；生成中的标「生成中」，
// 正打开的那张铺选中高亮色；点一项把它摆上看板。开合是本机的视图偏好（页面记在 localStorage）。
// 开合钮常驻右上角同一个位置（与左上的切换器 chip 同一圈 12 px 外边距）；列表浮在看板上（v1.17），开合不改看板，上沿与看板上沿齐平，
// 不压顶部那一行里的草稿工具条；窄视口下连输入框也盖住
export function DraftRail({ open, onToggle, drafts, openId, generating, onPick, onShotError }: {
  open: boolean; onToggle: () => void;
  /** null = 草稿本还在加载 */
  drafts: ScreenDto[] | null;
  openId: string | null;
  generating: ReadonlySet<string>;
  onPick: (id: string) => void;
  onShotError: () => void;
}) {
  const now = useNow();
  return (
    <>
      <div className="absolute right-3 top-3 z-30">
        <IconButton size="xs" tip="bottom-end" label={open ? '收起记录栏' : '展开记录栏'} data-testid="rail-toggle" aria-expanded={open} aria-controls="sketch-rail" onClick={onToggle}
          className="chrome">
          {open ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
        </IconButton>
      </div>
      {open && (
        <aside id="sketch-rail" data-testid="sketch-rail" aria-label="草稿记录" className="chrome slide-in-right absolute bottom-4 right-3 top-[var(--chrome-top)] z-30 flex w-[var(--sketch-rail-w)] flex-col overflow-hidden rounded-lg">
          <h2 className="panel-head flex h-10 shrink-0 items-center px-3 type-label font-semibold text-text-secondary">草稿{drafts?.length ? ` · ${drafts.length}` : ''}</h2>
          {drafts === null ? (
            // 加载态按真实一行的结构占位（IA-006）
            <ul className="flex flex-col gap-1 p-1.5" aria-hidden="true">
              {[0, 1, 2].map((i) => <li key={i} className="flex items-center gap-2.5 p-1.5"><span className="size-12 shrink-0 rounded-sm bg-(--semantic-color-surface-sunken)" /><span className="h-3 flex-1 rounded-sm bg-(--semantic-color-surface-sunken)" /></li>)}
            </ul>
          ) : drafts.length === 0 ? (
            <p className="p-4 type-label text-text-secondary">还没有草稿。在下方写一句话，出第一张。</p>
          ) : (
            <ul className="scroll flex min-h-0 flex-1 flex-col gap-1 p-1.5">
              {drafts.map((s) => {
                const busy = generating.has(s.id);
                const current = s.id === openId;
                const thumb = s.thumbUrl ?? s.screenshotUrl;
                return (
                  <li key={s.id}>
                    <button type="button" data-testid="rail-item" data-draft-id={s.id} data-generating={busy ? 'true' : undefined} aria-current={current ? 'true' : undefined} onClick={() => onPick(s.id)}
                      className={cn('state-layer focus-ring flex w-full items-center gap-2.5 rounded-md p-1.5 text-left', current && 'bg-(--semantic-color-surface-selected)')}>
                      {/* 组件画框的截图是透明底（API-CORE-016 草稿）：垫看板底色，与看板上看到的一致；页面垫设计稿的白 */}
                      <span className={cn('grid size-12 shrink-0 place-items-center overflow-hidden rounded-sm border border-border-subtle', s.frame === 'component' ? 'bg-(--semantic-color-surface-canvas)' : 'bg-neutral-0')}>
                        {thumb
                          ? <img src={thumb} alt="" loading="lazy" draggable={false} onError={onShotError} className={cn('size-full', s.frame === 'component' ? 'object-contain' : 'object-cover object-top')} />
                          : <span className="size-full bg-(--semantic-color-surface-sunken)" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-body text-text-primary">{s.name}</span>
                        <span className={cn('block type-caption', busy ? 'text-text-primary' : 'text-text-secondary')}>{busy ? '生成中' : relTime(s.updatedAt, now)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      )}
    </>
  );
}
