import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { DesignPresetDto } from '@quilt/core';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Field, Input } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { Overlay, useModal } from '@/ui/modal';

const noop = () => {};

// 新建项目弹窗（REQ-CORE-002）：项目切换器底部与 PAGE-FIRST 共用。
// 不传 onClose 就是 PAGE-FIRST 的形态——没有别处可去，所以没有「取消」、Esc 与点遮罩都不关。
export function CreateProjectDialog({ onClose, returnTo, fallback }: { onClose?: () => void; returnTo?: React.RefObject<HTMLElement | null>; fallback?: React.RefObject<HTMLElement | null> }) {
  const navigate = useNavigate();
  const toast = useToast();
  const ref = useModal<HTMLFormElement>(onClose ?? noop, returnTo, fallback);
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
    if (!name.trim()) { setError('请输入项目名'); return; }
    setPending(true);
    try {
      // 不传 seedColor：服务端取默认值，生成后在设计系统面板里改（REQ-CORE-002）
      const { project } = await api.projects.create({ name: name.trim(), deviceType, ...(presetId ? { presetId } : {}) });
      navigate(`/p/${project.id}`);
      onClose?.();
    } catch (err) {
      setPending(false);
      setError(err instanceof ApiError ? err.problem.title : '创建失败');
      toast('创建项目失败', 'error');
    }
  };

  return (
    <Overlay onClose={onClose ?? noop}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="np-title" tabIndex={-1} className="w-full max-w-sm rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none" onSubmit={submit} noValidate>
        <h2 id="np-title" className="text-sm font-semibold">新建项目</h2>
        <div className="mt-4 space-y-4">
          <Field label="项目名" htmlFor="np-name" error={error ?? undefined}>
            <Input id="np-name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：PawPal" maxLength={80} autoComplete="off" />
          </Field>
          <fieldset>
            <legend className="mb-1.5 block text-xs font-medium text-muted">设备形态（创建后不可改）</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['mobile', 'desktop'] as const).map((d) => (
                <label key={d} className={`flex h-9 cursor-pointer items-center justify-center rounded-md border text-sm ${deviceType === d ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted hover:border-line-strong'}`}>
                  <input type="radio" name="deviceType" value={d} className="sr-only" checked={deviceType === d} onChange={() => setDeviceType(d)} />
                  {d === 'mobile' ? '手机 390×844' : '桌面 1280×800'}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        {presets.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <label htmlFor="np-preset" className="block text-xs font-medium text-muted">设计预设</label>
            <Select id="np-preset" data-testid="np-preset" value={presetId} onChange={setPresetId} aria-label="设计预设"
              options={[{ value: '', label: '不用预设 · 默认配色' }, ...presets.map((p) => ({ value: p.id, label: p.assetCount ? `${p.name}（含 ${p.assetCount} 个素材）` : p.name }))]} />
          </div>
        )}
        {/* 种子色不在这一步问：建项目时用户还没见过任何屏幕，对品牌色没有判断依据。
            先用服务端默认值出图，看得见效果之后再去设计系统面板改并回刷全部屏。 */}
        <p className="mt-3 text-xs text-muted">配色与字体先用默认值，生成后可在设计系统面板里调整并一键回刷全部屏。</p>
        <div className="mt-5 flex justify-end gap-2">
          {onClose && <Button onClick={onClose}>取消</Button>}
          <Button type="submit" variant="primary" pending={pending}>创建</Button>
        </div>
      </form>
    </Overlay>
  );
}
