import type { ScreenDto } from '@quilt/core/browser';
import { Check, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button, cn, IconButton } from '@/ui/ui';
import { relTime, useNow } from '@/sketch/relTime';
import { COLLAB_ON, collabColor, type Peer } from '@/lib/collab';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

// 记录栏（PAGE-SKETCH，REQ-CORE-040）：右侧一列，全部草稿按创建时间倒序，每项缩略图 + 名字 + 相对时间；生成中的标「生成中」，
// 正打开的那张铺选中高亮色；点一项把它摆上看板。开合是本机的视图偏好（页面记在 localStorage）。
// 开合钮常驻右上角同一个位置（与左上的切换器 chip 同一圈 12 px 外边距）；列表浮在看板上（v1.17），开合不改看板，上沿与看板上沿齐平，
// 不压顶部那一行里的草稿工具条；窄视口下连输入框也盖住。
// 勾选模式（REQ-CORE-052，FLOW-SKETCH-MOVE S1）：顶部「选择」进入，每项缩略图左上角出复选框、点一项是勾上或去掉，生成中的不能勾；
// 底部常驻「取消」，勾了以后多一个「搬进项目…（N）」。勾不勾得上（上限 20 张）由页面判
export function DraftRail({ open, onToggle, drafts, openId, generating, onPick, onShotError, viewers, selecting, checked, onSelecting, onCheck, onMove }: {
  open: boolean; onToggle: () => void;
  selecting: boolean; checked: readonly string[]; onSelecting: (on: boolean) => void; onCheck: (id: string) => void; onMove: () => void;
  /** 协作显示（v1.32）：每张草稿此刻有谁在看 */
  viewers?: Record<string, Peer[]>;
  /** null = 草稿本还在加载 */
  drafts: ScreenDto[] | null;
  openId: string | null;
  generating: ReadonlySet<string>;
  onPick: (id: string) => void;
  onShotError: () => void;
}) {
  const now = useNow();
  const t = useT(sketchMessages);
  return (
    <>
      <div className="absolute right-3 top-3 z-30">
        <IconButton size="xs" tip="bottom-end" label={open ? t('rail.collapse') : t('rail.expand')} data-testid="rail-toggle" aria-expanded={open} aria-controls="sketch-rail" onClick={onToggle}
          className="chrome">
          {open ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
        </IconButton>
      </div>
      {open && (
        <aside id="sketch-rail" data-testid="sketch-rail" aria-label={t('rail.label')} className="chrome slide-in-right absolute bottom-4 right-3 top-[var(--chrome-top)] z-30 flex w-[var(--sketch-rail-w)] flex-col overflow-hidden rounded-lg">
          <div className="panel-head flex h-10 shrink-0 items-center gap-2 pl-3 pr-1.5">
            <h2 className="min-w-0 flex-1 truncate type-label font-semibold text-text-secondary">{selecting ? t('rail.selectHeading') : drafts?.length ? t('rail.headingCount', { n: drafts.length }) : t('rail.heading')}</h2>
            {!selecting && !!drafts?.length && (
              <button type="button" data-testid="rail-select" onClick={() => onSelecting(true)} className="state-layer focus-ring inline-flex h-7 shrink-0 items-center rounded-sm px-2 type-label font-medium text-(--semantic-color-action-link)">{t('rail.select')}</button>
            )}
          </div>
          {drafts === null ? (
            // 加载态按真实一行的结构占位（IA-006）
            <ul className="flex flex-col gap-1 p-1.5" aria-hidden="true">
              {[0, 1, 2].map((i) => <li key={i} className="flex items-center gap-2.5 p-1.5"><span className="size-12 shrink-0 rounded-sm bg-(--semantic-color-surface-sunken)" /><span className="h-3 flex-1 rounded-sm bg-(--semantic-color-surface-sunken)" /></li>)}
            </ul>
          ) : drafts.length === 0 ? (
            <p className="p-4 type-label text-text-secondary">{t('rail.empty')}</p>
          ) : (
            <ul className="scroll flex min-h-0 flex-1 flex-col gap-1 p-1.5">
              {drafts.map((s) => {
                const busy = generating.has(s.id);
                const current = s.id === openId;
                const thumb = s.thumbUrl ?? s.screenshotUrl;
                const on = selecting && checked.includes(s.id);
                return (
                  <li key={s.id}>
                    <button type="button" data-testid="rail-item" data-draft-id={s.id} data-generating={busy ? 'true' : undefined} aria-current={current && !selecting ? 'true' : undefined}
                      {...(selecting ? { role: 'checkbox', 'aria-checked': on, 'aria-disabled': busy || undefined, 'aria-label': t('rail.check', { name: s.name }) } : null)}
                      onClick={() => { if (!selecting) onPick(s.id); else if (!busy) onCheck(s.id); }}
                      className={cn('state-layer focus-ring flex w-full items-center gap-2.5 rounded-md p-1.5 text-left', (selecting ? on : current) && 'bg-(--semantic-color-surface-selected)', selecting && busy && 'cursor-not-allowed')}>
                      {/* 组件画框的截图是透明底（API-CORE-016 草稿）：垫看板底色，与看板上看到的一致；页面垫设计稿的白 */}
                      <span className="relative shrink-0">
                        <span className={cn('grid size-12 place-items-center overflow-hidden rounded-sm border border-border-subtle', s.frame === 'component' ? 'bg-(--semantic-color-surface-canvas)' : 'bg-neutral-0')}>
                          {thumb
                            ? <img src={thumb} alt="" loading="lazy" draggable={false} onError={onShotError} className={cn('size-full', s.frame === 'component' ? 'object-contain' : 'object-cover object-top')} />
                            : <span className="size-full bg-(--semantic-color-surface-sunken)" />}
                        </span>
                        {selecting && !busy && (
                          <span aria-hidden="true" data-testid="rail-check" className={cn('absolute -left-1 -top-1 grid size-4 place-items-center rounded-sm', on ? 'bg-primary text-on-primary' : 'border border-border-strong bg-surface-raised')}>
                            {on && <Check size={12} strokeWidth={3} />}
                          </span>
                        )}
                        {/* 正在看这张草稿的人（v1.32）：至多 3 个小头像叠在缩略图右下角；名字给读屏 */}
                        {!!viewers?.[s.id]?.length && (
                          <span data-testid="rail-viewers" className="absolute -bottom-1 -right-1 flex -space-x-1">
                            {viewers[s.id].slice(0, 3).map((x) => (
                              <span key={x.person.id} title={x.person.name} className="grid size-4 place-items-center rounded-full text-[9px] font-semibold ring-2 ring-(--semantic-color-surface-raised)" style={{ background: collabColor(x.person.color), color: COLLAB_ON }}>
                                <span aria-hidden="true">{Array.from(x.person.name)[0]}</span><span className="sr-only">{x.person.name}</span>
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-body text-text-primary">{s.name}</span>
                        <span className={cn('block type-caption', busy ? 'text-text-primary' : 'text-text-secondary')}>{busy ? t('rail.generating') : relTime(s.updatedAt, now)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selecting && (
            <div className="flex shrink-0 items-center justify-end gap-2 p-2 shadow-[inset_0_var(--semantic-layout-hairline)_0_var(--semantic-color-border-subtle)]">
              <Button size="sm" data-testid="rail-select-cancel" onClick={() => onSelecting(false)}>{t('rail.cancel')}</Button>
              {checked.length > 0 && <Button size="sm" variant="primary" data-testid="rail-move" onClick={onMove}>{t('rail.move', { n: checked.length })}</Button>}
            </div>
          )}
        </aside>
      )}
    </>
  );
}
