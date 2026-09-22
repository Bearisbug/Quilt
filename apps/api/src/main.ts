// 单进程入口（ADR-010 v0.32）：迁移 → 回填 → 默认用户 → API + 静态前端 + 预览域 → worker + agentDelivery → 打开浏览器。
// 开发（pnpm dev）与打包（npx quilt-canvas）走同一个入口，区别只在 config 的来源。
import './lib/http-agent.ts';
import { spawn } from 'node:child_process';
import { config } from './config.ts';
import { runMigrations } from './db/migrate.ts';
import { backfillSemanticColors, backfillComponentQids } from './db/backfill.ts';
import { localUser } from './services/user.ts';
import { startHttp } from './http/server.ts';
import { startWorker } from './worker/index.ts';

await runMigrations();
// 回填不是启动条件：数据库里有一行算不出来也要让人能打开画布，缺的键下一次写设计系统仍会补上
const backfilled = await backfillSemanticColors().catch((e) => { console.error('[quilt] 语义色回填失败', e); return 0; });
if (backfilled) console.log(`[quilt] 语义色回填 ${backfilled} 个项目`);
const qidded = await backfillComponentQids().catch((e) => { console.error('[quilt] 组件 qid 回填失败', e); return 0; });
if (qidded) console.log(`[quilt] 组件 qid 回填 ${qidded} 个组件`);
await localUser();
startHttp();
await startWorker();
console.log(`[quilt] v${config.version} · data ${config.dataDir} · ${config.databaseUrl ? 'postgres' : 'pglite'}`);

if (config.openBrowser) {
  const url = config.webOrigin;
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try { spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就让用户自己点日志里的地址 */ }
  console.log(`[quilt] open ${url}`);
}
