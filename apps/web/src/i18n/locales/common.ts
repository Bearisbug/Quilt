import { defineMessages } from '@/i18n';

// 跨区域共用的几个动作词（术语表见 ADR-034）。只在这里列真正处处一样的词，某一处要换说法就放进它自己的命名空间
export default defineMessages('common', {
  close: '关闭',
  cancel: '取消',
  retry: '重试',
  undo: '撤销',
  delete: '删除',
  copy: '复制',
}, {
  close: 'Close',
  cancel: 'Cancel',
  retry: 'Retry',
  undo: 'Undo',
  delete: 'Delete',
  copy: 'Copy',
});
