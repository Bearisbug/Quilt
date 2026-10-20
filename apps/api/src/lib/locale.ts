import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, Next } from 'hono';
import { parseLocale, pickLocale, type Locale } from '@quilt/core';

// 界面语言（REQ-CORE-046，ADR-034）：每个请求一进来就按 X-Quilt-Locale / Accept-Language 定下语言，
// 路由用 c.get('locale')，服务层（拿不到 c）用 requestLocale()——请求处理期间的异步调用都能读到同一个值。
// uiLocale 是网页端明说的界面语言（只认 X-Quilt-Locale），建作业时只有它才记进 input.locale；MCP、脚本不带这个头
type Store = { locale: Locale; uiLocale: Locale | null };
const store = new AsyncLocalStorage<Store>();

export async function localeMiddleware(c: Context, next: Next) {
  const uiLocale = parseLocale(c.req.header('x-quilt-locale'));
  const locale = pickLocale(uiLocale, c.req.header('accept-language'));
  c.set('locale', locale);
  c.set('uiLocale', uiLocale);
  await store.run({ locale, uiLocale }, next);
}

/** 当前请求的界面语言；不在请求里（worker、启动任务）时中文 */
export const requestLocale = (): Locale => store.getStore()?.locale ?? 'zh';
/** 当前请求带的 X-Quilt-Locale；没带或不在请求里时 null */
export const requestUiLocale = (): Locale | null => store.getStore()?.uiLocale ?? null;

/**
 * 当作不在请求里跑 fn（期间 requestLocale() 为中文、requestUiLocale() 为 null）。worker 领到作业时用它：作业的失败原因是原始原因，
 * 一律中文，由 failureText 按界面语言译；进程内队列在建作业的请求里同步起跑，不这样的话通道、本机工具的报错会跟着那个（或排在前面的别的）请求的语言
 */
export const outsideRequest = <T>(fn: () => T): T => store.run({ locale: 'zh', uiLocale: null }, fn);

/** 一句写给人看的话按语言取一边；缺省取当前请求的语言 */
export const tr = (zh: string, en: string, locale: Locale = requestLocale()): string => (locale === 'en' ? en : zh);
/** 草稿本的名字不落死（API-CORE-046）：接口与预览文档按语言给，存下的那个名字不读 */
export const sketchbookName = (locale: Locale = requestLocale()): string => tr('草稿本', 'Sketchbook', locale);
/** 名字列表：中文用顿号，英文用逗号 */
export const listJoin = (items: string[], locale: Locale): string => items.join(locale === 'en' ? ', ' : '、');
/** 英文的「N 个东西」：1 用单数，其余加 s（「3 screens」） */
export const countEn = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
