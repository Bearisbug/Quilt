import { defineMessages } from '@/i18n';

// 预览运行时画在屏里的修改标记角标（§13.1「画布标记」）：父页经 quilt:mode 的 marks.labels 下发（lib/theme.ts 的 markPalette）
export default defineMessages('preview', {
  marks: { working: '修改中…', done: '已更新' },
}, {
  marks: { working: 'Editing…', done: 'Updated' },
});
