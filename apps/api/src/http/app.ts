import { Hono, type Context } from 'hono';
import { z, type ZodType } from 'zod';
import { Problem, problems, problemResponse } from '../lib/errors.ts';
import { localUser, type UserRow } from '../services/user.ts';
import { requestSource } from '../lib/origin.ts';

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

  // 来源校验（§15 v0.75，ADR-016 修订）：无鉴权的前提是请求确实来自本机画布或本机客户端，Host / Origin 不在名单里一律 403
  const fromLocal = async (c: AppContext, next: () => Promise<void>) => {
    if (!requestSource.allows(c.req.header('host'), c.req.header('origin'))) throw new Problem(403, '/errors/forbidden', '请求来源不在本机名单（Host / Origin）');
    await next();
  };
  app.use('/v1/*', fromLocal);
  app.use('/mcp', fromLocal);

  // 本地单用户壳（ADR-016）：无鉴权，每个 /v1 请求都是默认用户；服务只绑 127.0.0.1，来源校验见上。
  // 对象 / 上传 / 附件直传仍按 URL 签名校验（URL 会被贴进预览页与对象链接）。
  app.use('/v1/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/v1/health' || path === '/v1/config' || path.startsWith('/v1/objects/') || path.startsWith('/v1/uploads/') || path.startsWith('/v1/attachments/')) return next();
    c.set('user', await localUser());
    await next();
  });

  // 路径里的资源 id 都是 UUID（§14 v0.77）：不是的直接 404——原样进 uuid 列的查询会被 Postgres 报 22P02，落成 500
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidParams = async (c: AppContext, next: () => Promise<void>) => {
    if (!Object.values(c.req.param()).every((v) => UUID.test(v))) throw problems.notFound();
    await next();
  };
  for (const p of ['projects', 'screens', 'jobs', 'components', 'annotations', 'assets', 'design-presets', 'channels']) app.use(`/v1/${p}/:id/*`, uuidParams);
  app.use('/v1/projects/:projectId/messages/:id/*', uuidParams);
  app.use('/v1/screens/:screenId/revisions/:id/*', uuidParams);

  return app;
}

export const requireUser = (c: AppContext): UserRow => {
  const u = c.get('user');
  if (!u) throw new Problem(500, '/errors/internal', '默认用户未解析');
  return u;
};

export async function parseBody<T extends ZodType>(c: AppContext, schema: T, invalid: (errors: unknown) => Problem = problems.validation): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = {}; }
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function parseQuery<T extends ZodType>(c: AppContext, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw problems.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
