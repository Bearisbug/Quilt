import { Hono } from 'hono';
import { requireUser, type Env } from '../app.ts';
import { problems } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { randomToken, signObject, verifyObject } from '../../lib/signing.ts';
import { config } from '../../config.ts';
import { ownedProject } from '../../services/projects.ts';
import { listSessions, sessionDto } from '../../lib/claudeSessions.ts';
import { listCodexThreads } from '../../lib/codexSessions.ts';

export const agentRoutes = new Hono<Env>();

// API-AGENT-010：本机会话（会话下拉打开时取；建作业时服务端再校验一次）。tool=codex 列 Codex 线程库里的用户线程（v0.68），
// 读不到线程库时带 reason 给下拉写明原因
agentRoutes.get('/v1/agent/sessions', async (c) => {
  requireUser(c);
  c.header('Cache-Control', 'no-store');
  if (c.req.query('tool') === 'codex') return c.json(await listCodexThreads());
  return c.json({ items: (await listSessions()).map(sessionDto) });
});

// API-AGENT-003：大 payload 上传（签名 PUT，10 分钟，≤ 2 MB）
agentRoutes.post('/v1/projects/:projectId/uploads', async (c) => {
  const user = requireUser(c);
  await ownedProject(user.id, c.req.param('projectId'));
  const uploadId = randomToken(16);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const key = `uploads/${uploadId}.html`;
  // 签发即建空上传位：quilt.append_upload 只认签发过的（v0.77）
  await storage.put(key, '', 'text/html');
  return c.json({ uploadId, putUrl: `${config.apiOrigin}/v1/uploads/${uploadId}?exp=${exp}&sig=${signObject(key, exp)}`, expiresAt: new Date(exp * 1000).toISOString() });
});
agentRoutes.put('/v1/uploads/:uploadId', async (c) => {
  const key = `uploads/${c.req.param('uploadId')}.html`;
  if (!verifyObject(key, Number(c.req.query('exp') ?? 0), c.req.query('sig') ?? '')) throw problems.forbidden();
  const body = Buffer.from(await c.req.arrayBuffer());
  if (body.byteLength > 2 * 1024 * 1024) throw problems.validation([{ path: 'body', message: 'max 2 MB' }]);
  await storage.put(key, body, 'text/html; charset=utf-8');
  return c.body(null, 204);
});
