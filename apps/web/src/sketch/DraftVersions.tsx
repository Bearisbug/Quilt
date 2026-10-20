import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { ChevronDown, History } from 'lucide-react';
import type { RevisionDto, ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, cn } from '@/ui/ui';
import { relTime, useNow } from '@/sketch/relTime';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';
import commonMessages from '@/i18n/locales/common';

// 有显示名的修订来源（sketch 命名空间 versions.source.<种类>）；其余种类原样写出
const SOURCE_NAMED = ['generate', 'edit', 'subtree', 'restore', 'manual', 'agent_ingest', 'fork'] as const;
const isNamed = (k: string): k is (typeof SOURCE_NAMED)[number] => (SOURCE_NAMED as readonly string[]).includes(k);

// 草稿的「版本」弹层（REQ-CORE-040，Q-SKETCH-2）：每改一轮是屏的一条修订，按缩略图倒序列出；「回到这一版」走 API-CORE-015，
// 以那一版的内容建新一版，expectedRevisionId 取当前版——列表过期（别处又改过）时服务端回 409，这里重取列表让用户再选一次。
// 锚定浮层用 Radix Popover：Esc、点外面关闭、焦点进出由它负责；Esc 被它消费（preventDefault），不会连带收起看板
export function DraftVersions({ draft, busy, onRestored }: { draft: ScreenDto; busy: string | null; onRestored: () => void }) {
  const toast = useToast();
  const now = useNow();
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RevisionDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const load = () => { setLoadError(false); api.screens.revisions(draft.id).then((r) => setItems(r.items)).catch(() => setLoadError(true)); };
  // 开着时出了新的一版（改完一轮、别处回到旧版）跟着重取
  useEffect(() => { if (open) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, draft.id, draft.currentRevisionId]);

  const restore = async (r: RevisionDto) => {
    if (!draft.currentRevisionId || busy || pending) return;
    setPending(r.id);
    try {
      await api.screens.restore(draft.id, r.id, draft.currentRevisionId);
      toast(t('versions.restored', { seq: r.seq }));
      setOpen(false);
      onRestored();
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/revision-conflict') { toast(t('versions.conflict'), 'error'); load(); onRestored(); }
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast(t('versions.busy', { name: draft.name }), 'error');
      else toast(e instanceof ApiError ? e.problem.title : t('versions.failed'), 'error');
    } finally { setPending(null); }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="draft-versions" className="state-layer focus-ring group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 type-label font-medium text-text-secondary data-[state=open]:bg-(--semantic-color-surface-selected) data-[state=open]:text-text-primary">
        <History size={14} aria-hidden="true" />{draft.currentRevisionSeq ? t('versions.triggerSeq', { seq: draft.currentRevisionSeq }) : t('versions.trigger')}
        <ChevronDown size={14} aria-hidden="true" className="transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-testid="versions-popover" side="bottom" align="center" sideOffset={8} collisionPadding={12} aria-label={t('versions.label', { name: draft.name })}
          // 从触发器那条边长出来（MOTION-007）
          style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
          className="menu z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] flex-col p-1.5 outline-none"
        >
          <p className="px-2 pb-1.5 pt-1 type-caption text-text-secondary">{busy ?? t('versions.hint')}</p>
          {loadError && <p role="alert" className="flex items-center justify-between gap-2 px-2 py-1.5 type-label text-error"><span>{t('versions.loadFailed')}</span><Button size="sm" onClick={load}>{tc('retry')}</Button></p>}
          {items === null ? (!loadError && <p role="status" className="px-2 py-2 type-label text-text-secondary">{t('versions.loading')}</p>) : (
            <ul className="scroll -mr-1.5 flex min-h-0 flex-col gap-1 pr-1.5">
              {items.map((r) => {
                const current = r.id === draft.currentRevisionId;
                const thumb = r.thumbUrl ?? r.screenshotUrl;
                return (
                  <li key={r.id} data-testid="version-item" data-revision-id={r.id} data-current={current || undefined} className={cn('flex items-center gap-2.5 rounded-sm p-1.5', current && 'bg-(--semantic-color-surface-selected)')}>
                    <span className={cn('grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-sm border border-border-subtle', draft.frame === 'component' ? 'bg-(--semantic-color-surface-canvas)' : 'bg-neutral-0')}>
                      {thumb ? <img src={thumb} alt={t('versions.item', { seq: r.seq })} loading="lazy" className={cn('size-full', draft.frame === 'component' ? 'object-contain' : 'object-cover object-top')} /> : <span className="size-full bg-(--semantic-color-surface-sunken)" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block type-label font-medium text-text-primary">{t(current ? 'versions.itemCurrent' : 'versions.item', { seq: r.seq })}</span>
                      <span className="block type-caption text-text-secondary">{isNamed(r.sourceKind) ? t(`versions.source.${r.sourceKind}`) : r.sourceKind} · {relTime(r.createdAt, now)}</span>
                    </span>
                    {!current && (
                      <Button size="sm" data-testid="version-restore" pending={pending === r.id} aria-disabled={busy ? true : undefined} className="aria-disabled:cursor-not-allowed" onClick={() => void restore(r)}>{t('versions.restore')}</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
