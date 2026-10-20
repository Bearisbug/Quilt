import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { DesignPresetDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Field, Input } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { Overlay, useModal } from '@/ui/modal';
import { useT } from '@/i18n';
import projectMessages from '@/i18n/locales/shellProject';
import commonMessages from '@/i18n/locales/common';

const noop = () => {};

// 新建项目弹窗（REQ-CORE-002）：项目切换器底部与 PAGE-FIRST 共用。
// 不传 onClose 就是 PAGE-FIRST 的形态——没有别处可去，所以没有「取消」、Esc 与点遮罩都不关。
export function CreateProjectDialog({ onClose, returnTo }: { onClose?: () => void; returnTo?: React.RefObject<HTMLElement | null> }) {
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT(projectMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose ?? noop, returnTo);
  const [name, setName] = useState('');
  const [deviceType, setDeviceType] = useState<'mobile' | 'desktop'>('mobile');
  // 设计预设（REQ-CORE-021）：账号里存过才显示这一项，没存过不要给空下拉
  const [presets, setPresets] = useState<DesignPresetDto[]>([]);
  const [presetId, setPresetId] = useState('');
  useEffect(() => { api.presets.list().then((r) => setPresets(r.items)).catch(() => {}); }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('create.nameRequired')); return; }
    setPending(true);
    try {
      // 不传 seedColor：服务端取默认值，生成后在设计系统面板里改（REQ-CORE-002）
      const { project } = await api.projects.create({ name: name.trim(), deviceType, ...(presetId ? { presetId } : {}) });
      navigate(`/p/${project.id}`);
      onClose?.();
    } catch (err) {
      setPending(false);
      setError(err instanceof ApiError ? err.problem.title : t('create.failed'));
      toast(t('create.failedToast'), 'error');
    }
  };

  return (
    <Overlay onClose={onClose ?? noop}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="np-title" tabIndex={-1} className="sheet w-full max-w-sm p-5 fade-up outline-none" onSubmit={submit} noValidate>
        <h2 id="np-title" className="type-heading3 font-semibold">{t('create.title')}</h2>
        <div className="mt-4 space-y-4">
          <Field label={t('create.name')} htmlFor="np-name" error={error ?? undefined}>
            {/* 报过错后每次输入即时重验，填上即清；错误经 aria-describedby 关联到输入框（INT-003） */}
            <Input id="np-name" name="name" value={name} onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setError(null); }} placeholder={t('create.namePlaceholder')} maxLength={80} autoComplete="off"
              aria-invalid={error ? true : undefined} aria-describedby={error ? 'np-name-error' : undefined} />
          </Field>
          <fieldset>
            <legend className="mb-1.5 block type-label font-medium text-text-secondary">{t('create.device')}</legend>
            {/* 二选一用分段控件（.seg）：当前项靠 data-state=on 浮起滑块；单选框藏起来，键盘焦点环画在它所在的那一段上（is-field） */}
            <div className="seg w-full">
              {(['mobile', 'desktop'] as const).map((d) => (
                <label key={d} data-state={deviceType === d ? 'on' : 'off'} className={`focus-ring is-field flex h-8 flex-1 cursor-pointer items-center justify-center type-body${deviceType === d ? '' : ' state-layer'}`}>
                  <input type="radio" name="deviceType" value={d} className="sr-only" checked={deviceType === d} onChange={() => setDeviceType(d)} />
                  {t(d === 'mobile' ? 'create.mobile' : 'create.desktop')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        {presets.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <label htmlFor="np-preset" className="block type-label font-medium text-text-secondary">{t('create.preset')}</label>
            <Select id="np-preset" data-testid="np-preset" value={presetId} onChange={setPresetId} aria-label={t('create.preset')}
              options={[{ value: '', label: t('create.presetNone') }, ...presets.map((p) => ({ value: p.id, label: p.assetCount ? t('create.presetWithAssets', { name: p.name, count: p.assetCount }) : p.name }))]} />
          </div>
        )}
        {/* 种子色不在这一步问：建项目时用户还没见过任何屏幕，对品牌色没有判断依据。
            先用服务端默认值出图，看得见效果之后再去设计系统面板改并回刷全部屏。 */}
        <p className="mt-3 type-label text-text-secondary">{t('create.note')}</p>
        <div className="mt-5 flex justify-end gap-2">
          {onClose && <Button onClick={onClose}>{tc('cancel')}</Button>}
          <Button type="submit" variant="primary" pending={pending}>{t('create.submit')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
