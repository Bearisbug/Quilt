// 由 src/preview-runtime.js（预览运行时源码，受 tsc 检查）生成 src/runtime.ts 的字符串常量 RUNTIME_JS（ADR-003）。
// @quilt/core 不经构建、以 TS 源码被直接引用，运行时又要作为文本内联进每张屏的 prelude，所以源码与常量各放一份：
// 改了 preview-runtime.js 跑 pnpm --filter @quilt/core gen:runtime；带 --check 只比对不写（tests/unit/core/runtime.test.ts 用它）。
// 常量从 IIFE 开头取到结尾（文件头的 @ts-check 与说明不进），去掉只给 tsc 看的 JSDoc 块——它们会让每张屏的文档多出约 2.6 KB
import { readFile, writeFile } from 'node:fs/promises';

const out = new URL('../src/runtime.ts', import.meta.url);
const src = await readFile(new URL('../src/preview-runtime.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('(function () {')).replace(/\/\*\*[\s\S]*?\*\/\s*/g, '').trimEnd();
// 运行时以 <script data-quilt-runtime>…</script> 内联，prelude.ts 的 RUNTIME_BLOCK 也按第一个 </script> 认块尾
if (/<\/script/i.test(body)) throw new Error('preview-runtime.js 里不能出现 </script>');
const text = `// 生成文件，别手改：源码在 preview-runtime.js，改完跑 pnpm --filter @quilt/core gen:runtime（scripts/gen-runtime.mjs）\nexport const RUNTIME_JS = ${JSON.stringify(body)};\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(out, 'utf8')) !== text) { console.error('src/runtime.ts 与 preview-runtime.js 不一致：跑 pnpm --filter @quilt/core gen:runtime'); process.exit(1); }
} else await writeFile(out, text);
