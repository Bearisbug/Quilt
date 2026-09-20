import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { verifyPreview } from '../lib/signing.ts';
import { storage } from '../lib/storage.ts';
import { withCurrentRuntime } from '@quilt/core';
import { readAsset } from '../services/assets.ts';

// 预览域服务（ADR-004 / API-CORE-016）：独立 origin、无 cookie、HMAC 签名、修订不可变可缓存。
// CSP 在 v0.43 放开到任意 https: 源——屏里允许用 Chart.js 这类开源库（REQ-CORE-022）。
// 安全边界没变：这是独立 origin、无 cookie、拿不到主站 storage，屏里的脚本只能影响它自己那张屏。
// 下发时把修订里存的运行时脚本换成当前版本（v0.34）：运行时是 Quilt 的代码，修复不该等每张屏再出一版修订。
export const previewApp = new Hono();

previewApp.get('/healthz', (c) => c.text('ok'));

previewApp.get('/p/:projectId/:screenId', async (c) => {
  const { projectId, screenId } = c.req.param();
  const rev = c.req.query('rev') ?? '';
  const token = c.req.query('t') ?? '';
  if (!verifyPreview(token, projectId)) return problem(c, 403, '/errors/preview-token-invalid', '预览签名无效或过期');
  const [row] = await db.select({ htmlKey: schema.screenRevisions.htmlKey })
    .from(schema.screenRevisions).innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .where(and(eq(schema.screenRevisions.id, rev), eq(schema.screenRevisions.screenId, screenId), eq(schema.screens.projectId, projectId)));
  if (!row) return problem(c, 404, '/errors/not-found', '修订不存在');
  const html = withCurrentRuntime((await storage.get(row.htmlKey)).toString('utf8'));
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'private, max-age=600, immutable');
  c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' 'unsafe-eval' https:; img-src * data: blob:; font-src https: data:; connect-src https:; frame-ancestors ${config.webOrigin}`);
  c.header('Referrer-Policy', 'no-referrer');
  // 父页需要 fetch 目标屏 HTML 做同 iframe 换屏（ADR-003）；URL 已带签名，只放行画布 origin
  c.header('Access-Control-Allow-Origin', config.webOrigin);
  c.header('Vary', 'Origin');
  return c.body(html);
});

// 项目素材（ADR-017）：不签名、不过期，凭 UUID 不可猜；URL 会被烤进修订 HTML，必须长期可用
previewApp.get('/a/:projectId/:assetId', async (c) => {
  const found = await readAsset(c.req.param('projectId'), c.req.param('assetId'));
  if (!found) return problem(c, 404, '/errors/not-found', '素材不存在');
  c.header('Content-Type', found.mediaType);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('X-Content-Type-Options', 'nosniff');
  // 素材本就不鉴权（ADR-017），这里放行任意来源：画布可能被 localhost / 127.0.0.1 / 局域网地址打开，
  // 锁成单一 origin 只会让另外几种入口的取色（画布要按素材亮度选底）拿不到像素，图本身照样显示
  c.header('Access-Control-Allow-Origin', '*');
  return c.body(new Uint8Array(found.body));
});

function problem(c: Context, status: 403 | 404, type: string, title: string) {
  c.header('Content-Type', 'application/problem+json');
  return c.body(JSON.stringify({ type, title, status }), status);
}
