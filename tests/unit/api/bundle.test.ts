import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

// 打包形态（TC-CORE-031）：db/client.ts 有顶层 await，esbuild 把依赖它的模块都包成异步初始化函数；两个这样的模块互相静态 import 时，
// 各自 await 对方还没落定的初始化，顶层 await 永不落定，事件循环排空后 node 以退出码 13 退出。按 apps/cli/build.mjs 同样的参数打一遍，
// 静态 import 图里不许有环（要互相引用就在调用处 await import，见 services/projects.ts）
const root = path.resolve(import.meta.dirname, '../../..');

test('打包入口的静态 import 图没有环', async () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const { metafile } = await build({
    entryPoints: [path.join(root, 'apps/api/src/main.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent',
    external: Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]),
    alias: { playwright: 'playwright-core' },
  });
  const edges = new Map(Object.entries(metafile.inputs).map(([file, input]) => [file, input.imports.filter((i) => i.kind === 'import-statement' && !i.external).map((i) => i.path)]));
  const cycles: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (file: string, trail: string[]) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'open') { cycles.push([...trail.slice(trail.indexOf(file)), file].join(' → ')); return; }
    state.set(file, 'open');
    for (const next of edges.get(file) ?? []) visit(next, [...trail, file]);
    state.set(file, 'done');
  };
  for (const file of edges.keys()) visit(file, []);
  assert.deepEqual(cycles, []);
});

// 浏览器边界（PERF-3 v1.06）：前端只经 @quilt/core/browser 引 core；这个出口打出来的依赖里不许有 linkedom 一系与预览运行时 / prelude——
// 它们只在服务端用，进了前端包要多解析几百 KB，也没人发现（v1.05 之前前端包里有 29 处 xmlMode）
test('@quilt/core/browser 不带服务端才用的模块，前端只从它引 core', async () => {
  const { metafile } = await build({
    entryPoints: [path.join(root, 'packages/core/src/browser.ts')],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent',
  });
  const banned = Object.keys(metafile.inputs).filter((f) => /linkedom|htmlparser2|css-select|cssom|\/runtime\.ts$|\/prelude\.ts$|\/inject\.ts$|\/lint\.ts$|\/outline\.ts$|\/components\.ts$|\/export\.ts$/.test(f));
  assert.deepEqual(banned, [], `浏览器出口带进了：${banned.join(', ')}`);
  // grep 没匹配时退出码是 1，这里只看输出
  const { spawnSync } = await import('node:child_process');
  const hits = spawnSync('grep', ['-rln', "from '@quilt/core'", path.join(root, 'apps/web/src')], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(hits, [], '前端应从 @quilt/core/browser 引 core');
});
