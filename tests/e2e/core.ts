// docs/TEST.md CORE 域 AI 执行脚本入口（RUN= / ONLY= / LIVE_LLM=0 用法不变）。环境准备与共用部分在 core/shared.ts；
// 用例按组分在 core/ 下，按原来的顺序依次引入——前面的用例会留下后面用到的项目与状态，顺序不能打乱
import { browser, consoleErrors, summary } from './core/shared.ts';
await import('./core/generate.ts');
await import('./core/focus.ts');
await import('./core/rounds.ts');
await import('./core/overlays.ts');
await import('./core/screenshots.ts');
await import('./core/backend.ts');

await browser.close();
summary();
if (consoleErrors.length) console.log('pageerrors:', consoleErrors.slice(0, 5));
