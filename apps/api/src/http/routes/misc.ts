import { Hono } from 'hono';
import path from 'node:path';
import { requireUser, type Env } from '../app.ts';
import { monthlyUsage } from '../../services/usage.ts';
import { problems } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { verifyObject } from '../../lib/signing.ts';
import { attachmentKey, storeUpload } from '../../services/attachments.ts';
import { config } from '../../config.ts';
import type { ConfigDto } from '@quilt/core';

export const miscRoutes = new Hono<Env>();

miscRoutes.get('/v1/health', (c) => c.json({ status: 'ok', llm: config.llmDriver, model: config.model, storage: config.storageDriver }));

// API-CORE-028：运行时配置（前端启动时取一次；预览域地址随打包 / 开发环境变）
miscRoutes.get('/v1/config', (c) => c.json({ previewOrigin: config.previewOrigin, version: config.version, local: true, home: config.dataDir } satisfies ConfigDto));

// /v1/runners 已迁到 routes/channels.ts（API-CORE-023：预置 + 本机 + 账号自建的统一目录）

// API-CORE-017
miscRoutes.get('/v1/me/usage', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await monthlyUsage(requireUser(c)));
});

// API-CORE-019 直传接收：签名校验 + 类型大小复核（签发时报的 bytes 只是声明，到货的才算数）
// 路径带 projectId：key 的形状是 projects/<pid>/attachments/<id>.<ext>，签名签的就是这个 key，
// 所以 URL 必须把 pid 一起带回来才拼得出同一个 key
miscRoutes.put('/v1/attachments/:projectId/:id', async (c) => {
  const mediaType = c.req.query('mt') ?? '';
  const key = attachmentKey(c.req.param('projectId'), c.req.param('id'), mediaType);
  if (!verifyObject(key, Number(c.req.query('exp') ?? 0), c.req.query('sig') ?? '')) throw problems.previewTokenInvalid();
  await storeUpload(key, mediaType, Buffer.from(await c.req.arrayBuffer()));
  return c.body(null, 204);
});

// fs 存储驱动的签名对象读取（截图 / 修订 HTML 下载）；修订不可变，允许缓存。
const TYPES: Record<string, string> = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
miscRoutes.get('/v1/objects/:key{.+}', async (c) => {
  const key = decodeURIComponent(c.req.param('key'));
  const exp = Number(c.req.query('exp') ?? 0);
  const sig = c.req.query('sig') ?? '';
  if (!verifyObject(key, exp, sig)) throw problems.forbidden();
  let body: Buffer;
  try { body = await storage.get(key); } catch { throw problems.notFound(); }
  c.header('Content-Type', TYPES[path.extname(key)] ?? 'application/octet-stream');
  c.header('Cache-Control', 'private, max-age=300, immutable');
  return c.body(new Uint8Array(body));
});