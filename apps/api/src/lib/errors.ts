import type { Context } from 'hono';
import { L, isLocalized, textIn, type Locale, type Localized } from '@quilt/core';
import { requestLocale } from './locale.ts';

// 统一错误信封 RFC 9457（设计文档 §14）。type 为相对 URI，requestId 为扩展字段。
// 文案按界面语言出（REQ-CORE-046）：title 与 extra 里任意一处（errors[].message、detail…）都可以写成 L('中文', 'English')，
// 出口（problemResponse、MCP 的错误包装）按请求的语言取一边；只写字符串的照原样给。title 属性恒为中文，日志与旧调用方读它
export class Problem extends Error {
  readonly titleText: string | Localized;
  constructor(public status: number, public type: string, title: string | Localized, public extra: Record<string, unknown> = {}) {
    super(textIn(title, 'zh'));
    this.titleText = title;
  }
  get title(): string { return this.message; }
  /** 按界面语言展开成 problem+json 的字段（不含 requestId） */
  body(locale: Locale): Record<string, unknown> {
    return { type: this.type, title: textIn(this.titleText, locale), status: this.status, ...(localizeDeep(this.extra, locale) as Record<string, unknown>) };
  }
}

/** 把值里所有 L(zh, en) 换成那一边的字符串；zod 的自定义 message 只能是字符串，英文登记在 ISSUE_EN（errors[].message 按原文反查） */
export function localizeDeep(v: unknown, locale: Locale, key?: string): unknown {
  if (isLocalized(v)) return v[locale];
  if (typeof v === 'string') return locale === 'en' && key === 'message' ? ISSUE_EN[v] ?? v : v;
  if (Array.isArray(v)) return v.map((x) => localizeDeep(x, locale, key));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localizeDeep(x, locale, k)]));
  }
  return v;
}

// @quilt/core schemas 里 zod 自定义 message 的英文（中文原文 → 英文）。schema 里新加中文 message 时在这里补一行
export const ISSUE_EN: Record<string, string> = {
  'variantOf 与 variantName 要一起给': 'variantOf and variantName must be given together',
  'qids 里有重复的块': 'qids has the same block more than once',
  'qids 要含 qid': 'qids must include qid',
  '先写点什么': 'Write something first',
  '覆盖要给目标屏': 'Choose the screen to replace',
  '覆盖要给目标屏确认时的当前修订': 'Replace whole screen needs the revision the target screen was at when you confirmed',
  '覆盖原样写入，不改写': 'Replace whole screen copies the draft as is, without rewriting it',
  '族名只能是字母、数字、空格与连字符': 'Font family names can only contain letters, digits, spaces and hyphens',
  '字体样式表必须是 https 链接': 'The font stylesheet must be an https URL',
  '组件名只能是字母、数字、空格、下划线与连字符，最长 40 字': 'Component names can only contain letters, digits, spaces, underscores and hyphens, up to 40 characters',
  '改内容或改名要带 expectedVersion': 'Changing the content or name requires expectedVersion',
  'OpenAI 兼容的模型必须填端点': 'OpenAI-compatible models need an endpoint',
  '这类模型必须填 API Key': 'This kind of model needs an API key',
};

export const problems = {
  validation: (errors: unknown) => new Problem(400, '/errors/validation', L('请求参数不合法', 'Invalid request parameters'), { errors }),
  // 内容本身不合规（类型 / 大小 / 数量超限）按 422；素材上传整条路径统一用它，同一端点不要两个状态码
  unprocessable: (errors: unknown) => new Problem(422, '/errors/validation', L('请求参数不合法', 'Invalid request parameters'), { errors }),
  forbidden: () => new Problem(403, '/errors/forbidden', L('签名无效', 'Invalid signature')),
  previewTokenInvalid: () => new Problem(403, '/errors/preview-token-invalid', L('预览签名无效或过期', 'Preview signature is invalid or expired')),
  notFound: () => new Problem(404, '/errors/not-found', L('资源不存在', 'Not found')),
  elementNotFound: () => new Problem(404, '/errors/element-not-found', L('元素在当前修订中不存在', 'The element is not in the current revision')),
  routeTaken: () => new Problem(409, '/errors/route-taken', L('路由在项目内已占用', 'The route is already taken in this project')),
  screenBusy: () => new Problem(409, '/errors/screen-busy', L('目标屏有进行中的作业', 'The target screen has a job in progress')),
  // 组件被 edit_component 作业占着（v0.57 `API-EDIT-005`）：直改中途顶版会让那个作业收尾时匹配不到行而整轮失败
  componentBusy: (name: string) => new Problem(409, '/errors/component-busy', L(`组件「${name}」正在改，等这一轮完事`, `Component “${name}” is being edited; wait for this round to finish`)),
  projectBusy: () => new Problem(409, '/errors/project-busy', L('项目有进行中的作业，先取消或等它完成', 'The project has a job in progress; cancel it or wait for it to finish')),
  revisionConflict: () => new Problem(409, '/errors/revision-conflict', L('修订已被更新', 'The revision has been updated')),
  // 共享组件（REQ-EDIT-006）：实例里的元素不能直改，改组件或先脱离共享；名字项目内唯一
  componentLocked: (component: string) => new Problem(409, '/errors/component-locked', L(`这个元素属于共享组件「${component}」，改组件或先脱离共享`, `This element belongs to the shared component “${component}”; edit the component or detach it first`), { component }),
  componentNameTaken: () => new Problem(409, '/errors/component-name-taken', L('组件名在项目内已占用', 'The component name is already taken in this project')),
  versionConflict: () => new Problem(409, '/errors/version-conflict', L('设计系统版本冲突', 'Design system version conflict')),
  jobFinished: () => new Problem(409, '/errors/job-finished', L('作业已结束', 'The job has already finished')),
  jobNotFinished: () => new Problem(409, '/errors/job-not-finished', L('作业尚未完成', 'The job has not finished yet')),
  lintFailed: (violations: unknown) => new Problem(422, '/errors/lint-failed', L('HTML 违反设计契约', 'The HTML violates the design contract'), { violations }),
  rateLimited: (retryAfterSec: number) => new Problem(429, '/errors/rate-limited', L('请求过于频繁', 'Too many requests'), { retryAfter: retryAfterSec }),
  providerUnavailable: () => new Problem(503, '/errors/provider-unavailable', L('LLM 供应商不可用', 'The LLM provider is unavailable')),
};

// drizzle 把 pg 错误包在 cause 里；唯一约束冲突（23505）两层都要看
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

// 出口按这个请求的界面语言出文案；不经语言中间件的应用（预览域）按 requestLocale() 的缺省中文
export function problemResponse(c: Context, p: Problem) {
  const requestId = c.get('requestId') as string | undefined;
  const { type, title, status, ...extra } = p.body((c.get('locale') as Locale | undefined) ?? requestLocale());
  const body = { type, title, status, requestId, ...extra };
  const headers: Record<string, string> = { 'Content-Type': 'application/problem+json' };
  if (typeof p.extra.retryAfter === 'number') headers['Retry-After'] = String(p.extra.retryAfter);
  return c.body(JSON.stringify(body), p.status as 400, headers);
}
