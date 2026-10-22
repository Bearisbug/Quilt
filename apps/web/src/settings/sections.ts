import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';

// 设置弹层的分节（§13 设置弹层，v1.24 三节）：画布页与草稿本页首屏就要按 URL 的 ?settings=<id> 判断开哪一节，弹层本身按需加载，分节表单放这里；
// 各节名字在 settings 命名空间的 sections.<id>
export const SETTINGS_SECTIONS = ['usage', 'models', 'system'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// v1.24 之前的四节地址照旧能开（书签、旧链接）：开了之后地址换成新值
const LEGACY = new Map<string, SettingsSection>([['runners', 'models'], ['appearance', 'system'], ['language', 'system'], ['record', 'system']]);

/** ?settings= 的原值 → 要开的节；没有参数为 null，不认识的值回「用量」 */
export const settingsSectionOf = (v: string | null): SettingsSection | null =>
  v === null ? null : SETTINGS_SECTIONS.find((s) => s === v) ?? LEGACY.get(v) ?? 'usage';

/** 设置弹层的开关与当前节都在 URL 上（INT-020）：刷新保持；换节、关闭都是参数微调（replace），不改地址里别的参数 */
export function useSettingsSection() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('settings');
  const section = settingsSectionOf(raw);
  const setSection = useCallback((v: SettingsSection | null) => setParams((q) => { if (v) q.set('settings', v); else q.delete('settings'); return q; }, { replace: true }), [setParams]);
  // 旧值或不认识的值：开的是哪一节，地址就写哪一节
  useEffect(() => { if (section && raw !== section) setSection(section); }, [raw, section, setSection]);
  return [section, setSection] as const;
}
