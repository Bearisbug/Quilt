import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib.ts';

// TC-CORE-031 一键安装冷启动（REQ-CORE-017）：把 apps/cli 打成 npm 包 → 在临时目录里 npx 装起来 → 空 QUILT_HOME 冷启动 →
// 初始化 / 迁移 / 前端 / 预览域 / MCP 全部就绪 → 建项目落到 PGlite → 关掉再起（秒开、数据还在）。全程不碰仓库的 .data 与 ~/.quilt。
const RUN = process.env.RUN ?? '001';
const PORT = 3410; const PREVIEW = 3411;
const API = `http://127.0.0.1:${PORT}`;
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_loglevel: 'error' } });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'quilt-install-'));
const home = path.join(tmp, 'home');
let child: ChildProcess | null = null;
let out = '';
const start = async (label: string) => {
  out = '';
  child = spawn('npx', ['--yes', '--prefix', tmp, 'quilt', '--home', home, '--port', String(PORT), '--preview-port', String(PREVIEW), '--no-open'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, QUILT_HOME: '', DATABASE_URL: '', PATH: process.env.PATH } });
  child.stdout!.on('data', (d) => { out += d.toString(); });
  child.stderr!.on('data', (d) => { out += d.toString(); });
  const t0 = Date.now();
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`${label}：进程提前退出 ${child.exitCode}\n${out.slice(-1200)}`);
    const ok = await fetch(`${API}/v1/health`).then((r) => r.ok).catch(() => false);
    if (ok) return Date.now() - t0;
    await sleep(500);
  }
  throw new Error(`${label}：120 s 内未就绪\n${out.slice(-1200)}`);
};
const stop = async () => { if (!child) return; child.kill('SIGTERM'); await new Promise((r) => { child!.on('exit', r); setTimeout(r, 5000); }); child = null; };

try {
  // 0 打包：前端 → CLI bundle → npm pack；装进临时 prefix（就是 npx 用户拿到的东西）
  sh('pnpm', ['--filter', '@quilt/web', 'build'], ROOT);
  sh('pnpm', ['--filter', 'quilt-canvas', 'build'], ROOT);
  const tgz = sh('npm', ['pack', '--pack-destination', tmp], path.join(ROOT, 'apps/cli')).trim().split('\n').pop()!;
  const bytes = (await readFile(path.join(tmp, tgz))).byteLength;
  sh('npm', ['install', '--no-audit', '--no-fund', '--prefix', tmp, path.join(tmp, tgz)], tmp);
  expect(existsSync(path.join(tmp, 'node_modules/.bin/quilt')), '安装后没有 quilt 可执行文件');
  expect(!existsSync(path.join(tmp, 'node_modules/playwright')), '包不该带 playwright（会在安装时下载浏览器），应为 playwright-core');

  // 1 冷启动：空目录 → 初始化 → 就绪；主页是打包的前端；预览域与 MCP 活着；配置指向本机
  const cold = await start('冷启动');
  expect(existsSync(path.join(home, 'config.env')) && existsSync(path.join(home, 'db')), 'QUILT_HOME 未初始化');
  const cfgText = await readFile(path.join(home, 'config.env'), 'utf8');
  expect(/QUILT_SECRETS_KEY=\S{20,}/.test(cfgText) && /PREVIEW_SIGNING_SECRET=\S{20,}/.test(cfgText), 'config.env 缺随机密钥');
  const index = await fetch(`${API}/`).then((r) => r.text());
  expect(index.includes('<div id="root">') && /\/assets\/.*\.js/.test(index), '主页不是打包的前端');
  const asset = index.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(asset && (await fetch(`${API}${asset}`)).headers.get('content-type')?.includes('javascript'), '静态资源没有正确的 Content-Type');
  const cfg = await fetch(`${API}/v1/config`).then((r) => r.json()) as { previewOrigin: string; local: boolean; home: string; version: string };
  expect(cfg.local === true && cfg.previewOrigin === `http://127.0.0.1:${PREVIEW}` && cfg.home === home, `运行时配置不对：${JSON.stringify(cfg)}`);
  expect((await fetch(`http://127.0.0.1:${PREVIEW}/healthz`)).ok, '预览域未就绪');
  const mcp = await fetch(`${API}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'install-test', version: '0' } } }) });
  expect(mcp.status === 200, `MCP initialize ${mcp.status}`);
  const spa = await fetch(`${API}/p/does-not-exist`).then((r) => r.text());
  expect(spa.includes('<div id="root">'), 'SPA 路径未回退到 index.html');
  // 2 建项目落到 PGlite
  const created = await fetch(`${API}/v1/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cold start', deviceType: 'mobile' }) });
  expect(created.status === 201, `建项目 ${created.status}`);
  const pid = ((await created.json()) as { project: { id: string } }).project.id;
  expect((await readdir(path.join(home, 'db'))).length > 0, 'PGlite 目录为空');
  // 3 停掉再起：秒开、数据还在
  await stop();
  const warm = await start('二次启动');
  const list = await fetch(`${API}/v1/projects`).then((r) => r.json()) as { items: { id: string }[] };
  expect(list.items.some((p) => p.id === pid), '二次启动后项目丢了');
  expect(!/首次运行/.test(out), '二次启动仍走了首次初始化');
  await stop();
  console.log(`✅ TC-CORE-031 通过 包 ${Math.round(bytes / 1024)} KB；冷启动 ${cold} ms、二次 ${warm} ms；PGlite 落库、SPA / 预览域 / MCP 就绪`);
  console.log(`\n=== RUN-${RUN} INSTALL === {"通过":1}`);
} catch (e) {
  console.log(`❌ TC-CORE-031 失败 ${(e as Error).message.split('\n')[0].slice(0, 400)}`);
  console.log(out.slice(-2000));
  console.log(`\n=== RUN-${RUN} INSTALL === {"失败":1}`);
  process.exitCode = 1;
} finally {
  await stop();
  await rm(tmp, { recursive: true, force: true });
}
