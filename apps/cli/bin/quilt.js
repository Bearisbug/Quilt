#!/usr/bin/env node
// `npx quilt-canvas`（REQ-CORE-017）：准备 $QUILT_HOME（默认 ~/.quilt）→ 首次生成 config.env 密钥 → 起服务并打开浏览器。
// 用法：quilt [--home <dir>] [--port <n>] [--preview-port <n>] [--no-open]
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('quilt [--home <dir>] [--port <n>] [--preview-port <n>] [--no-open]\n  数据与密钥在 --home（默认 ~/.quilt）；再次运行同一目录即恢复全部项目。');
  process.exit(0);
}
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error(`Quilt 需要 Node.js 22 或更新（当前 ${process.versions.node}）`); process.exit(1); }

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist');
const home = path.resolve(opt('home', process.env.QUILT_HOME || path.join(os.homedir(), '.quilt')));
for (const d of ['', 'db', 'objects', 'agent']) mkdirSync(path.join(home, d), { recursive: true });

// 首次运行：生成两把随机密钥写进 config.env（用户以后可在这里改 LLM_DRIVER / API Key 等）
const cfgPath = path.join(home, 'config.env');
if (!existsSync(cfgPath)) {
  writeFileSync(cfgPath, [
    '# Quilt 本机配置（由 quilt 首次启动生成）。改完重启 quilt 生效。',
    `QUILT_SECRETS_KEY=${randomBytes(32).toString('base64')}`,
    `PREVIEW_SIGNING_SECRET=${randomBytes(32).toString('base64')}`,
    '# 生成通道：agent-sdk = 本机 Claude 订阅（先在终端运行 claude 登录）| anthropic | gemini',
    'LLM_DRIVER=agent-sdk',
    'ANTHROPIC_API_KEY=',
    'GEMINI_API_KEY=',
    '',
  ].join('\n'));
  console.log(`[quilt] 首次运行：已初始化 ${home}`);
}

const port = opt('port', process.env.API_PORT || '3100');
const previewPort = opt('preview-port', process.env.PREVIEW_PORT || '3101');
Object.assign(process.env, {
  QUILT_HOME: home,
  API_PORT: port,
  PREVIEW_PORT: previewPort,
  WEB_DIST: path.join(dist, 'web'),
  QUILT_MIGRATIONS_DIR: path.join(dist, 'drizzle'),
  QUILT_VERSION: JSON.parse(readFileSync(path.join(dist, 'version.json'), 'utf8')).version,
  QUILT_OPEN_BROWSER: argv.includes('--no-open') ? '0' : '1',
});
process.on('SIGINT', () => { console.log('\n[quilt] bye'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
await import(path.join(dist, 'server.mjs'));
