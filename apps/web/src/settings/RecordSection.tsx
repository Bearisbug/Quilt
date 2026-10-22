import { useEffect, useState } from 'react';
import type { RecordingDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { setRecordingEnabled } from '@/lib/recorder';
import { useToast } from '@/lib/toast';
import { Button } from '@/ui/ui';
import { Switch } from '@/ui/Switch';
import { intlLocale, useT } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import commonMessages from '@/i18n/locales/common';
import { copyText } from '@/lib/copy';

// 设置「系统」的使用记录组（FLOW-RECORD S1、S7；API-CORE-049 / 050）：开关、记什么不记什么、已记的条数与占用、存放位置。
// 读不出来时只这一组写错误，不挡同一节里的外观与语言
const errText = (e: unknown) => (e instanceof ApiError ? e.problem.title : e instanceof Error ? e.message : '');

const fmtBytes = (n: number) => {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 }).format(v);
};
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(intlLocale(), { ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
};

export function RecordSection({ titleId }: { titleId: string }) {
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
  const toast = useToast();
  const [rec, setRec] = useState<RecordingDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 改开关：先按用户点的显示，请求失败再退回（A11Y-013：保存中不禁用开关，重复点击忽略）
  const [pending, setPending] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);  // 空串 = 没有原因可写
  const load = () => { setLoadError(null); api.recording().then(setRec, (e: unknown) => setLoadError(errText(e))); };
  useEffect(load, []);

  const toggle = (on: boolean) => {
    if (pending !== null) return;
    setPending(on); setSaveError(null);
    api.setRecording(on).then(
      (r) => { setRec(r); setRecordingEnabled(r.enabled); },
      (e: unknown) => setSaveError(errText(e)),
    ).finally(() => setPending(null));
  };
  const copy = async (text: string) => { try { await copyText(text); toast(t('mcp.copied')); } catch { toast(t('mcp.copyFailed'), 'error'); } };

  if (loadError !== null) {
    return (
      <div role="alert" data-testid="record-error" className="tint-error mt-3 flex items-center justify-between gap-3 rounded-md px-3 py-2.5 type-label">
        <span className="min-w-0 [overflow-wrap:anywhere]">{loadError ? `${t('record.loadFailed')}：${loadError}` : t('record.loadFailed')}</span>
        <Button size="sm" onClick={load}>{tc('retry')}</Button>
      </div>
    );
  }
  if (!rec) return <div aria-hidden="true" className="mt-3 h-24 animate-pulse rounded-md fill motion-reduce:animate-none" />;
  const on = pending ?? rec.enabled;
  return (
    <div className="mt-3 max-w-xl">
      {/* 开关这一行与外观、语言的单选行同宽同内距：开关落在对勾那一列 */}
      <div className="flex min-h-11 max-w-sm items-center justify-between gap-4 px-3">
        <label htmlFor="record-toggle" className="type-body text-text-primary">{t('record.toggle')}</label>
        <Switch id="record-toggle" data-testid="record-toggle" checked={on} onCheckedChange={toggle} busy={pending !== null} aria-describedby={`${titleId}-hint`} />
      </div>
      {saveError !== null && <p role="alert" className="mt-1 type-label text-error [overflow-wrap:anywhere]">{t('record.saveFailed', { error: saveError || t('channels.probe.unknown') })}</p>}
      <p id={`${titleId}-hint`} className="mt-1 type-label leading-(--semantic-typography-body-line-height) text-text-secondary">{t('record.hint')}</p>
      {/* 关掉之后这两行照样显示：已记的不清零 */}
      <p data-testid="record-stats" className="mt-3 type-label tabular-nums text-text-secondary">
        {t('record.stats', { events: rec.events.toLocaleString(intlLocale()), calls: rec.modelCalls.toLocaleString(intlLocale()), archived: rec.archived.toLocaleString(intlLocale()), size: fmtBytes(rec.bytes) })}
        {' · '}{rec.since ? t('record.since', { time: fmtTime(rec.since) }) : t('record.neverOn')}
      </p>
      {/* 对象存储不在本机时没有本机路径，这一行不显示 */}
      {rec.dir && (
        <div className="mt-2 flex items-center gap-2" data-testid="record-dir">
          <span className="shrink-0 type-label text-text-secondary">{t('record.dir')}</span>
          <code className="fill min-w-0 flex-1 rounded-md px-2.5 py-1.5 font-mono type-label [overflow-wrap:anywhere]">{rec.dir}</code>
          <Button size="sm" aria-label={t('record.copyDir')} onClick={() => void copy(rec.dir!)}>{tc('copy')}</Button>
        </div>
      )}
    </div>
  );
}
