import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { COLLAB_COLORS } from '@quilt/core/browser';
import { Button, Input, cn } from '@/ui/ui';
import { COLLAB_ON, collabColor, newPerson, saveMe, useMe } from '@/lib/collab';
import { useToast } from '@/lib/toast';
import { useT } from '@/i18n';
import collabMessages from '@/i18n/locales/collab';

// 设置「系统」里的「协作」一组（v1.32 REQ-CORE-048）：改名与换色，只记在这个浏览器里；还没填过名字时这里也能填
export function CollabSettings() {
  const t = useT(collabMessages);
  const toast = useToast();
  const me = useMe();
  const [name, setName] = useState(me?.name ?? '');
  useEffect(() => { setName(me?.name ?? ''); }, [me?.name]);
  const color = me?.color ?? 1;
  const save = (next: { name?: string; color?: number }) => {
    const n = (next.name ?? name).trim();
    if (!n) return;
    saveMe(me ? { ...me, name: n, color: next.color ?? color } : newPerson(n, next.color ?? color));
  };
  return (
    <>
      <p className="mt-1 type-label text-text-secondary">{t('settings.hint')}</p>
      <form className="mt-3 flex max-w-sm items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim() || name.trim() === me?.name) return; save({}); toast(t('settings.saved')); }}>
        <label className="flex-1">
          <span className="block type-label font-medium text-text-secondary">{t('settings.name')}</span>
          <Input data-testid="collab-settings-name" className="mt-1.5 w-full" value={name} maxLength={24} autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </label>
        <Button type="submit" data-testid="collab-settings-save" aria-disabled={!name.trim() || name.trim() === me?.name || undefined}>{t('settings.save')}</Button>
      </form>
      <fieldset className="mt-4" data-testid="collab-colors">
        <legend className="type-label font-medium text-text-secondary">{t('settings.color')}</legend>
        <div className="mt-2 flex gap-2">
          {Array.from({ length: COLLAB_COLORS }, (_, i) => i + 1).map((n) => (
            <label key={n} className="relative grid size-8 cursor-pointer place-items-center rounded-full outline-offset-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-(--focus-ring-color)" style={{ background: collabColor(n) }}>
              <input type="radio" name="collab-color" value={n} checked={color === n} aria-label={t('settings.colorN', { n })} className="sr-only"
                onChange={() => { if (me) saveMe({ ...me, color: n }); else if (name.trim()) save({ color: n }); }} />
              <Check size={16} aria-hidden="true" className={cn(color !== n && 'invisible')} style={{ color: COLLAB_ON }} />
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}
