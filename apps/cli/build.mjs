// 打包（REQ-CORE-017 / ADR-010 v0.32）：把 apps/api + packages/core 捆成一个 ESM 文件，node_modules 全部外置（由本包的 dependencies 提供）；
// 前端静态文件与迁移 SQL 一起复制进 dist。`playwright` 换成 `playwright-core`：不在 npm install 时下载浏览器，截图优先用本机 Chrome / Edge。
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const dist = path.join(here, 'dist');
const webDist = path.join(root, 'apps/web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) { console.error('apps/web/dist 不存在：先跑 pnpm --filter @quilt/web build'); process.exit(1); }

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
// 只外置本包 dependencies 里登记的第三方包（安装时会到位）；workspace 包（@quilt/core）与其余 import 一律打进 bundle。
// @material/material-color-utilities 故意不登记：它的 ESM 用无扩展名相对导入，Node 原生加载不了，只能由 esbuild 解析后打进来
const external = Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]);
await build({
  entryPoints: [path.join(root, 'apps/api/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(dist, 'server.mjs'),
  external,
  alias: { playwright: 'playwright-core' },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
await cp(path.join(root, 'apps/api/drizzle'), path.join(dist, 'drizzle'), { recursive: true });
await cp(webDist, path.join(dist, 'web'), { recursive: true });
await writeFile(path.join(dist, 'version.json'), JSON.stringify({ version: pkg.version }));
console.log(`built quilt-canvas ${pkg.version} → ${dist}`);
