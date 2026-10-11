// 设置弹层的分节（§13 导航）：画布页首屏就要按 URL 的 ?settings=<id> 判断开哪一节，弹层本身按需加载，分节表单放这里
export const SETTINGS_SECTIONS = [
  { id: 'usage', label: '本月用量' },
  { id: 'runners', label: '生成通道' },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export const isSettingsSection = (v: string | null): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);
