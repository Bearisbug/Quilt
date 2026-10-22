import { IconButton, cn } from '@/ui/ui';
import { COLLAB_ON, collabColor, type Peer } from '@/lib/collab';
import { useT } from '@/i18n';
import collabMessages from '@/i18n/locales/collab';

const MAX = 5;

// 顶栏右侧那一行的协作者头像（v1.32 REQ-CORE-048）：按加入顺序，圆形、底色是他的颜色、写名字的第一个字；
// 悬停提示全名与他在做什么；点一下跟随，再点一下停止（following 与 onFollow 都按 person.id，他开着几个标签页也是一个人）。超过 5 人折成「+N」，自己不显示
export function PeerAvatars({ people, following, onFollow, describe, className }: {
  people: Peer[]; following: string | null; onFollow: (personId: string) => void; describe: (p: Peer) => string; className?: string;
}) {
  const t = useT(collabMessages);
  if (!people.length) return null;
  const shown = people.slice(0, MAX); const rest = people.slice(MAX);
  return (
    <div role="group" aria-label={t('avatars')} data-testid="peer-avatars" className={cn('flex items-center gap-1', className)}>
      {shown.map((p) => {
        const on = following === p.person.id;
        return (
          <IconButton key={p.person.id} size="xs" round tip="bottom-end" active={on} data-testid="peer-avatar" data-name={p.person.name} aria-pressed={on}
            label={on ? t('unfollow', { name: p.person.name }) : t('follow', { name: p.person.name })} desc={describe(p)} onClick={() => onFollow(p.person.id)}>
            <span aria-hidden="true" className={cn('grid size-7 place-items-center rounded-full type-label font-semibold', on && 'ring-2 ring-offset-2 ring-offset-(--semantic-color-surface-default)')}
              style={{ background: collabColor(p.person.color), color: COLLAB_ON, ['--tw-ring-color' as string]: collabColor(p.person.color) }}>
              {Array.from(p.person.name)[0]}
            </span>
          </IconButton>
        );
      })}
      {rest.length > 0 && (
        <span data-testid="peer-more" role="img" aria-label={t('more', { count: rest.length })} title={rest.map((p) => p.person.name).join('、')} className="chrome grid h-7 min-w-7 place-items-center rounded-pill px-1.5 type-label font-medium text-text-secondary">
          +{rest.length}
        </span>
      )}
    </div>
  );
}
