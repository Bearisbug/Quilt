import { useState, type FormEvent } from 'react';
import type { DeviceType, SurfaceDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { useT } from '@/i18n';
import fullviewMessages from '@/i18n/locales/fullview';
import commonMessages from '@/i18n/locales/common';

// 加一端弹层（FLOW-SURFACE S2，API-CORE-054）：端名 + 设备。重名、超上限、名字不合规都写在名字框下面，弹层留着改
export function SurfaceDialog({ projectId, returnTo, onClose, onCreated }: { projectId: string; returnTo?: React.RefObject<HTMLElement | null>; onClose: () => void; onCreated: (s: SurfaceDto) => void }) {
  const t = useT(fullviewMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose, returnTo);
  const [name, setName] = useState('');
  const [deviceType, setDeviceType] = useState<DeviceType>('desktop');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!name.trim()) { setError(t('dialog.nameRequired')); return; }
    setPending(true);
    try {
      const { surface } = await api.surfaces.create(projectId, { name: name.trim(), deviceType });
      onCreated(surface);
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.type === '/errors/surface-name-taken') setError(t('surface.nameTaken'));
      else if (err instanceof ApiError && err.type === '/errors/validation') setError((err.problem as { errors?: { message: string }[] }).errors?.[0]?.message ?? err.problem.title);
      else setError(err instanceof ApiError ? err.problem.title : t('dialog.failed'));
    }
  };

  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="ns-title" tabIndex={-1} data-testid="surface-dialog" className="sheet w-full max-w-sm p-5 fade-up outline-none" onSubmit={submit} noValidate>
        <h2 id="ns-title" className="type-heading3 font-semibold">{t('dialog.title')}</h2>
        <div className="mt-4 space-y-4">
          <Field label={t('dialog.name')} htmlFor="ns-name" error={error ?? undefined}>
            <Input id="ns-name" name="name" value={name} autoFocus maxLength={20} autoComplete="off" placeholder={t('dialog.namePlaceholder')}
              onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
              aria-invalid={error ? true : undefined} aria-describedby={error ? 'ns-name-error' : undefined} />
          </Field>
          <fieldset>
            <legend className="mb-1.5 block type-label font-medium text-text-secondary">{t('dialog.device')}</legend>
            <div className="seg w-full">
              {(['mobile', 'desktop'] as const).map((d) => (
                <label key={d} data-state={deviceType === d ? 'on' : 'off'} className={`focus-ring is-field flex h-8 flex-1 cursor-pointer items-center justify-center type-body${deviceType === d ? '' : ' state-layer'}`}>
                  <input type="radio" name="deviceType" value={d} className="sr-only" checked={deviceType === d} onChange={() => setDeviceType(d)} />
                  {t(d === 'mobile' ? 'dialog.mobile' : 'dialog.desktop')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <p className="mt-3 type-label text-text-secondary">{t('dialog.note')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button type="submit" variant="primary" pending={pending} data-testid="surface-dialog-submit">{t('dialog.submit')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
