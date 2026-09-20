import type { Context } from 'hono';

// 统一错误信封 RFC 9457（设计文档 §14）。type 为相对 URI，requestId 为扩展字段。
export class Problem extends Error {
  constructor(public status: number, public type: string, public title: string, public extra: Record<string, unknown> = {}) {
    super(title);
  }
}

export const problems = {
  validation: (errors: unknown) => new Problem(400, '/errors/validation', '请求参数不合法', { errors }),
  // 内容本身不合规（类型 / 大小 / 数量超限）按 422；素材上传整条路径统一用它，同一端点不要两个状态码
  unprocessable: (errors: unknown) => new Problem(422, '/errors/validation', '请求参数不合法', { errors }),
  forbidden: () => new Problem(403, '/errors/forbidden', '签名无效'),
  previewTokenInvalid: () => new Problem(403, '/errors/preview-token-invalid', '预览签名无效或过期'),
  notFound: () => new Problem(404, '/errors/not-found', '资源不存在'),
  elementNotFound: () => new Problem(404, '/errors/element-not-found', '元素在当前修订中不存在'),
  routeTaken: () => new Problem(409, '/errors/route-taken', '路由在项目内已占用'),
  screenBusy: () => new Problem(409, '/errors/screen-busy', '目标屏有进行中的作业'),
  projectBusy: () => new Problem(409, '/errors/project-busy', '项目有进行中的作业，先取消或等它完成'),
  revisionConflict: () => new Problem(409, '/errors/revision-conflict', '修订已被更新'),
  versionConflict: () => new Problem(409, '/errors/version-conflict', '设计系统版本冲突'),
  jobFinished: () => new Problem(409, '/errors/job-finished', '作业已结束'),
  jobNotFinished: () => new Problem(409, '/errors/job-not-finished', '作业尚未完成'),
  lintFailed: (violations: unknown) => new Problem(422, '/errors/lint-failed', 'HTML 违反设计契约', { violations }),
  rateLimited: (retryAfterSec: number) => new Problem(429, '/errors/rate-limited', '请求过于频繁', { retryAfter: retryAfterSec }),
  providerUnavailable: () => new Problem(503, '/errors/provider-unavailable', 'LLM 供应商不可用'),
};

// drizzle 把 pg 错误包在 cause 里；唯一约束冲突（23505）两层都要看
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

export function problemResponse(c: Context, p: Problem) {
  const requestId = c.get('requestId') as string | undefined;
  const body = { type: p.type, title: p.title, status: p.status, requestId, ...p.extra };
  const headers: Record<string, string> = { 'Content-Type': 'application/problem+json' };
  if (typeof p.extra.retryAfter === 'number') headers['Retry-After'] = String(p.extra.retryAfter);
  return c.body(JSON.stringify(body), p.status as 400, headers);
}
