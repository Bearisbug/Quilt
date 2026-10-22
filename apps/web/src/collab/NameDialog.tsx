import { useState } from 'react';
import { Overlay, useModal } from '@/ui/modal';
import { Button, Field, Input } from '@/ui/ui';
import { newPerson, pickColor, saveMe } from '@/lib/collab';
import { useT } from '@/i18n';
import collabMessages from '@/i18n/locales/collab';

// 第一次打开画布或草稿本时填名字（v1.32 REQ-CORE-048，PAGE-CANVAS「协作者」）：必填、不能跳过——Esc 与点遮罩都不关；
// 颜色取此刻在线的人里还没被用的第一个，设置「系统」里可以改名、换色
export function NameDialog({ taken }: { taken: number[] }) {
  const t = useT(collabMessages);
  const ref = useModal<HTMLFormElement>(() => {});
  const [name, setName] = useState('');
  const ok = name.trim().length > 0;
  return (
    <Overlay onClose={() => {}}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="collab-name-title" aria-describedby="collab-name-hint" data-testid="collab-name-dialog"
        className="sheet w-full max-w-xs p-5 fade-up outline-none" tabIndex={-1}
        onSubmit={(e) => { e.preventDefault(); if (ok) saveMe(newPerson(name, pickColor(taken))); }}>
        <h2 id="collab-name-title" className="type-heading3 font-semibold">{t('name.title')}</h2>
        <p id="collab-name-hint" className="mt-1 type-label text-text-secondary">{t('name.hint')}</p>
        <div className="mt-4">
          <Field label={t('name.label')} htmlFor="collab-name">
            <Input id="collab-name" data-testid="collab-name-input" value={name} maxLength={24} autoComplete="nickname" placeholder={t('name.placeholder')} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" variant="primary" data-testid="collab-name-start" aria-disabled={!ok || undefined}>{t('name.start')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
