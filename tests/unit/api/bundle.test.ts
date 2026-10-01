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
