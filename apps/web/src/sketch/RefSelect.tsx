import { useCallback, useEffect, useState } from 'react';
import { Select } from 'radix-ui';
import { Check, ChevronDown, Palette } from 'lucide-react';
import type { ProjectDto } from '@quilt/core/browser';
import { api } from '@/lib/api';
import { cn } from '@/ui/ui';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

export type RefProjects = { projects: ProjectDto[] | null; failed: boolean; reload: () => void };

// 参照项目的候选（REQ-CORE-042）：本人的普通项目，最近更新的在前；草稿本本身不在列表里（API-CORE-005 已排除，这里再挡一道）。
// 工具条与输入框共用一份，进页面取一次
export function useRefProjects(): RefProjects {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    api.projects.list()
      .then(({ items }) => setProjects(items.filter((p) => p.kind !== 'sketchbook').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))))
      .catch(() => setFailed(true));
  }, []);
  useEffect(reload, [reload]);
  return { projects, failed, reload };
}

// Radix Select 不收空串取值：「自由风格」用一个不会与项目 id（UUID）撞上的哨兵
const FREE = '__free__';
const ITEM_CLS = 'state-layer relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 type-body text-text-secondary outline-none data-[highlighted]:text-text-primary data-[state=checked]:bg-(--semantic-color-surface-selected) data-[state=checked]:text-text-primary';

// 「参照」下拉（REQ-CORE-042）：自由风格，或按某个项目的设计系统出稿与改稿。value = null 是自由风格；
// 参照的项目已被删时服务端把它记回 null，这里就显示自由风格。外观由调用方给（工具条里不铺底，输入框里铺填充底）；
// 列表没取到时换成一个「重试」，不当成没有项目
export function RefSelect({ refs, value, onChange, testId, side, className }: {
  refs: RefProjects; value: string | null; onChange: (projectId: string | null) => void; testId: string; side: 'top' | 'bottom'; className?: string;
}) {
  const t = useT(sketchMessages);
  // 只给下拉限宽（项目名在里面截断）；「没取到 · 重试」不截，英文比中文长也整句露出
  const base = 'group inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 type-label font-medium state-layer focus-ring';
  if (refs.failed) {
    return <button type="button" data-testid={testId} onClick={refs.reload} className={cn(base, 'text-warning')}>{t('ref.failed')}</button>;
  }
  const items = refs.projects ?? [];
  const cur = value ? items.find((p) => p.id === value) : undefined;
  // 列表还没回来时参照项目的名字未知：先写省略号，不闪一下「自由风格」
  const shown = cur?.name ?? (value ? '…' : t('ref.free'));
  return (
    <Select.Root value={value ?? FREE} onValueChange={(v) => { if (!v) return; const next = v === FREE ? null : v; if (next !== value) onChange(next); }}>
      <Select.Trigger aria-label={t('ref.trigger', { name: shown })} data-testid={testId} data-value={value ?? ''} className={cn(base, 'max-w-48', className)}>
        <Palette size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate"><Select.Value>{t('ref.value', { name: shown })}</Select.Value></span>
        <Select.Icon className="flex shrink-0 opacity-60 transition-transform duration-(--semantic-motion-duration-base) ease-(--semantic-motion-easing-standard) group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" side={side} align="start" sideOffset={8} collisionPadding={12}
          // 下拉开着时的 Esc / 方向键归它自己：不漏给页面的 Esc（收起看板）
          onKeyDown={(e) => e.stopPropagation()}
          className="menu z-50 flex max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-60 max-w-[min(22rem,calc(100vw-1.5rem))] flex-col p-1.5"
        >
          <Select.Viewport className="min-h-0 flex-1">
            <Select.Item value={FREE} textValue={t('ref.free')} data-testid={`${testId}-free`} className={ITEM_CLS}>
              <span className="min-w-0 flex-1">
                <Select.ItemText>{t('ref.free')}</Select.ItemText>
                <span className="mt-0.5 block type-caption text-text-secondary">{t('ref.freeHint')}</span>
              </span>
              <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
            </Select.Item>
            <Select.Separator className="my-1.5 h-px bg-border-subtle" />
            <Select.Group>
              <Select.Label className="px-2.5 pb-1 pt-1.5 type-overline font-semibold text-text-secondary">{t('ref.group')}</Select.Label>
              {refs.projects === null && <p role="status" className="px-2.5 py-2 type-label text-text-secondary">{t('ref.loading')}</p>}
              {refs.projects?.length === 0 && <p className="px-2.5 py-2 type-label text-text-secondary">{t('ref.empty')}</p>}
              {items.map((p) => (
                <Select.Item key={p.id} value={p.id} textValue={p.name} data-testid={`${testId}-option`} className={ITEM_CLS}>
                  <span className="min-w-0 flex-1">
                    <Select.ItemText><span className="block truncate">{p.name}</span></Select.ItemText>
                    <span className="mt-0.5 block type-caption text-text-secondary">{p.deviceType === 'mobile' ? t('device.mobile') : t('device.desktop')}</span>
                  </span>
                  <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
