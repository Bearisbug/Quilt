import { Hono, type Context } from 'hono';
import { z, type ZodType } from 'zod';
import { Problem, problems, problemResponse } from '../lib/errors.ts';
import { localUser, type UserRow } from '../services/user.ts';

export type Env = { Variables: { requestId: string; user: UserRow | null } };
export type AppContext = Context<Env>;

export function createApp() {
  const app = new Hono<Env>();

  // 排障关联 ID（§14）：透传或生成 X-Request-Id
  app.use('*', async (c, next) => {
    const rid = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', rid);
    c.set('user', null);
    await next();
    c.header('X-Request-Id', rid);
  });

  app.onError((err, c) => {
    if (err instanceof Problem) return problemResponse(c, err);
    console.error(`[${c.get('requestId')}]`, err);
    return problemResponse(c, new Problem(500, '/errors/internal', '服务器内部错误'));
  });
  app.notFound((c) => problemResponse(c, problems.notFound()));

  // 本地单用户壳（ADR-016）：无鉴权，每个 /v1 请求都是默认用户；服务只绑 127.0.0.1，进程边界即权限边界。
  // 对象 / 上传 / 附件直传仍按 URL 签名校验（URL 会被贴进预览页与对象链接）。
  app.use('/v1/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/v1/health' || path === '/v1/config' || path.startsWith('/v1/objects/') || path.startsWith('/v1/uploads/') || path.startsWith('/v1/attachments/')) return next();
    c.set('user', await localUser());
    await next();
  });

  return app;
}

export const requireUser = (c: AppContext): UserRow => {
  const u = c.get('user');
  if (!u) throw new Problem(500, '/errors/internal', '默认用户未解析');
  return u;
};

export async function parseBody<T extends ZodType>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = {}; }
  const r = schema.safeParse(raw);
  if (!r.success) throw problems.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function parseQuery<T extends ZodType>(c: AppContext, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw problems.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
