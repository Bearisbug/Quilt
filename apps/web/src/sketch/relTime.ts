import { useEffect, useState } from 'react';
import { tOf } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

const t = tOf(sketchMessages);

/** 「3 分钟前」：从绝对时刻与当前时钟推出来（COMP-009），一周以外写日期 */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.minutes', { count: Math.floor(s / 60) });
  if (s < 86_400) return t('time.hours', { count: Math.floor(s / 3600) });
  if (s < 7 * 86_400) return t('time.days', { count: Math.floor(s / 86_400) });
  const d = new Date(iso);
  return t('time.date', { month: d.getMonth() + 1, day: d.getDate() });
}

/** 相对时间的时钟：每分钟重读一次，切回前台立即重读——后台标签页里计时器被节流，不能等下一拍（COMP-009） */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const sync = () => setNow(Date.now());
    const t = window.setInterval(sync, 60_000);
    document.addEventListener('visibilitychange', sync);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', sync); };
  }, []);
  return now;
}
