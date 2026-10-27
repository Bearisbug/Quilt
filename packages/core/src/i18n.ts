// 界面语言（DESIGN REQ-CORE-046，ADR-034）：Quilt 自己的界面与服务端提示用中文或英文。
// 网页端每个请求带 X-Quilt-Locale；没有这个头时看 Accept-Language；两者都没有时中文（MCP、脚本等现有调用方照旧拿到中文）。
import { z } from 'zod';

export const LOCALES = ['zh', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

/** X-Quilt-Locale 的取值：只认 zh / en（不分大小写），别的值当没有这个头 */
export function parseLocale(value?: string | null): Locale | null {
  const v = value?.trim().toLowerCase();
  return v === 'zh' || v === 'en' ? v : null;
}

/**
 * 请求的界面语言：X-Quilt-Locale 有效就用它；否则取 Accept-Language 里优先级最高的那一项，以 zh 开头为中文、其余英文；
 * 两者都没有时中文。Accept-Language 只有 `*`（Node 的 fetch 缺省就带这个）视同没有
 */
export function pickLocale(xQuiltLocale?: string | null, acceptLanguage?: string | null): Locale {
  const explicit = parseLocale(xQuiltLocale);
  if (explicit) return explicit;
  const ranked = (acceptLanguage ?? '').split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.split(';').map((s) => s.trim());
      const q = Number(params.find((p) => p.startsWith('q='))?.slice(2) ?? 1);
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 1, i };
    })
    .filter((t) => t.tag && t.tag !== '*' && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const first = ranked[0]?.tag;
  if (!first) return 'zh';
  return first.startsWith('zh') ? 'zh' : 'en';
}

/** 一句双语文案：服务端在出口按请求的界面语言取一边（problem 的 title、errors[].message 等） */
export type Localized = { zh: string; en: string };
export const L = (zh: string, en: string): Localized => ({ zh, en });
export const isLocalized = (v: unknown): v is Localized =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && typeof (v as Localized).zh === 'string' && typeof (v as Localized).en === 'string';
export const textIn = (m: string | Localized, locale: Locale): string => (typeof m === 'string' ? m : m[locale]);

/** 作业是在哪种界面语言下建的：input.locale 只在带 X-Quilt-Locale 的请求建的作业里有，没有时为 null */
export function jobLocale(job: { input: unknown }): Locale | null {
  return parseLocale((job.input as { locale?: string } | null)?.locale);
}

// 生成内容跟界面语言（REQ-CORE-046）：只有这几种作业写屏上的可见文字（造屏、改屏、改组件、重生成一块；草稿本的新稿与改稿也是它们），
// 提示词只给它们补语言要求；input.locale 每种作业都记，回执、进度与失败文案按它写
export const LOCALE_JOB_KINDS: readonly string[] = ['generate', 'edit_screens', 'edit_component', 'regenerate_subtree', 'propose_states'];
const LANGUAGE_NAME: Record<Locale, string> = { zh: 'Simplified Chinese', en: 'English' };
/** 提示词末尾那一句语言要求；排在其它「跟着请求的语言写」的规则之后，以它为准 */
export const uiLanguageRule = (locale: Locale): string =>
  `LANGUAGE: unless the request explicitly asks for a language, write all visible text on the screen in ${LANGUAGE_NAME[locale]}. This takes precedence over any other language rule above.`;
/** 给提示词补上语言要求：作业带 locale 且是写屏上文字的那几种才补；不带的（MCP、脚本建的）原样返回，文案语言照旧跟着提示词 */
export function withUiLanguage(prompt: string, job: { kind: string; input: unknown }): string {
  const locale = jobLocale(job);
  return locale && LOCALE_JOB_KINDS.includes(job.kind) ? `${prompt}\n\n${uiLanguageRule(locale)}` : prompt;
}
