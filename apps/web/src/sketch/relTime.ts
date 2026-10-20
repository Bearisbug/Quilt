import { useEffect, useState } from 'react';

/** 「3 分钟前」：从绝对时刻与当前时钟推出来（COMP-009），一周以外写日期 */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} 天前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
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
