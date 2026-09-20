import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

// 配置来源（ADR-016）：打包运行时 QUILT_HOME 已由 bin 设好，密钥在 $QUILT_HOME/config.env（首次启动自动生成）；
// 仓库内开发时读仓库根的 .env（密钥纪律：只进 .env，仓内只有 .env.example）。
const home = process.env.QUILT_HOME ? path.resolve(process.env.QUILT_HOME) : null;
if (home) loadDotenv({ path: path.join(home, 'config.env'), quiet: true });
else loadDotenv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const env = (k: string, d?: string): string => {
  const v = process.env[k];
  if (v === undefined || v === '') { if (d !== undefined) return d; throw new Error(`missing env ${k}`); }
  return v;
};

const apiPort = Number(env('API_PORT', '3100'));
const previewPort = Number(env('PREVIEW_PORT', '3101'));

export const config = {
  /** 本地数据目录：打包运行时 = QUILT_HOME（默认 ~/.quilt）；仓库内开发 = 仓库根 .data */
  dataDir: home ?? path.resolve(import.meta.dirname, '../../../.data'),
  /** 留空 = 内置 PGlite（$dataDir/db）；设了 = 外部 Postgres（开发 docker / 将来 SaaS） */
  databaseUrl: process.env.DATABASE_URL ?? '',
  migrationsDir: process.env.QUILT_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, '../drizzle'),
  apiPort, previewPort,
  // 本地版只绑回环地址：MCP 免鉴权的前提就是这一条（§15 安全）
  bindHost: env('BIND_HOST', '127.0.0.1'),
  // 打包运行时静态前端由 API 进程托管，画布与 API 同源；开发时 Vite 在 5173 代理 /v1
  webDist: process.env.WEB_DIST && existsSync(process.env.WEB_DIST) ? path.resolve(process.env.WEB_DIST) : '',
  webOrigin: env('WEB_ORIGIN', home ? `http://localhost:${apiPort}` : 'http://localhost:5173'),
  apiOrigin: env('API_ORIGIN', `http://localhost:${apiPort}`),
  // 预览域与主站不同 origin 即够（无 cookie）：打包时用 127.0.0.1（Safari 不解析 *.localhost），开发保留 preview.localhost
  previewOrigin: env('PREVIEW_ORIGIN', home ? `http://127.0.0.1:${previewPort}` : `http://preview.localhost:${previewPort}`),
  openBrowser: env('QUILT_OPEN_BROWSER', '0') === '1',
  version: env('QUILT_VERSION', '0.1.0'),
  previewSigningSecret: env('PREVIEW_SIGNING_SECRET', 'dev-preview-secret-change-me'),
  llmDriver: env('LLM_DRIVER', 'agent-sdk') as 'agent-sdk' | 'anthropic' | 'gemini' | 'stub',
  llmStub: env('LLM_STUB', '') as '' | '503' | 'fixture',
  // 用户自填通道密钥的加密主密钥（ADR-013）；为空则拒绝保存含密钥的通道（fail closed）。打包运行时首次启动自动生成
  secretsKey: process.env.QUILT_SECRETS_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiVertex: env('GEMINI_VERTEX', '') === '1',
  gcpProject: env('GOOGLE_CLOUD_PROJECT', ''),
  gcpLocation: env('GOOGLE_CLOUD_LOCATION', 'global'),
  model: env('QUILT_MODEL', 'claude-sonnet-5'),
  modelInitial: env('QUILT_MODEL_INITIAL', 'claude-sonnet-5'),
  // 本机 agent（REQ-AGENT-003 v0.34）：Claude Code 会话登记处，投递按这里的记录找会话的 inbox socket。QUILT_CLAUDE_SESSIONS_DIR 只给测试桩用
  claudeSessionsDir: process.env.QUILT_CLAUDE_SESSIONS_DIR ? path.resolve(process.env.QUILT_CLAUDE_SESSIONS_DIR) : path.join(os.homedir(), '.claude', 'sessions'),
  agentJobTimeoutMs: 30 * 60_000,
  storageDriver: env('STORAGE_DRIVER', 'fs') as 'fs' | 's3',
  s3: { bucket: process.env.S3_BUCKET ?? '', region: process.env.S3_REGION ?? '', endpoint: process.env.S3_ENDPOINT ?? '', accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' },
  screenshotChannel: process.env.SCREENSHOT_BROWSER_CHANNEL ?? '',
  // §15 容量与限流
  workerConcurrency: Number(env('WORKER_CONCURRENCY', '20')),
  screenConcurrency: Number(env('SCREEN_CONCURRENCY', '4')),
  // 作业超时随预估调用数伸缩（REQ-CORE-008）：基数 + 每次调用 1 分钟，封顶 30 分钟
  jobTimeoutMs: { base: 3 * 60_000, perCall: 60_000, max: 30 * 60_000 },
  rateLimitJobsPerMinute: 10,
  maxScreensPerProject: 200,
  maxScreenHtmlBytes: 256 * 1024,
  previewTokenMinutes: 10,
  objectUrlMinutes: 5,
};
export type Config = typeof config;
