// 收集全部命名空间（REQ-CORE-046）：locales/ 下每个文件是一个命名空间，导入时由 defineMessages 注册进 i18next。
// main.tsx 第一行导入本文件，首帧之前全部注册完；单测不经过这里，被测模块导入自己用的命名空间文件即可
import type { Bundle } from '@/i18n';

const modules = import.meta.glob<{ default: Bundle }>('./locales/*.ts', { eager: true });
for (const [path, mod] of Object.entries(modules)) {
  const file = path.slice(path.lastIndexOf('/') + 1, -'.ts'.length);
  if (mod.default?.ns !== file) console.error(`[i18n] ${path} 的命名空间应与文件名同名（defineMessages('${file}', …)）`);
}
