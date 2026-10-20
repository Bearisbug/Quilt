import i18next, { type FlatNamespace, type TOptions } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { useSyncExternalStore } from 'react';
import { pickLocale, type Locale } from '@quilt/core/browser';

// 界面语言（REQ-CORE-046，ADR-034，§13 设置弹层「语言」）：中文 / 英文。缺省跟浏览器语言列表的第一项（以 zh 开头为中文，否则英文），
// 设置里选过的记在本机 localStorage 的 quilt:locale（zh / en）；切换即时生效、不刷新页面，<html lang> 跟着换（字阶的中文覆盖按它命中）。
// 文案按命名空间放在 locales/<命名空间>.ts，每个文件 export default defineMessages('<命名空间>', 中文, 英文)；导入即注册，
// 新命名空间还要在 i18next.d.ts 登记（不登记，useT / tOf 传它编译不过）。
// 组件里 useT(那个文件的默认导出) 取 t，普通函数里 tOf(…)。不在浏览器里（单测）时缺省中文。
export type { Locale };

const KEY = 'quilt:locale';
const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

// 与服务端判 Accept-Language 同一个函数：选过的（zh / en）优先，否则看浏览器语言列表的第一项
function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(KEY); } catch { /* 存储不可用：按浏览器语言 */ }
  return pickLocale(saved, (navigator.languages?.length ? navigator.languages : [navigator.language]).join(','));
}

const syncHtmlLang = (lng: string) => { if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[lng as Locale] ?? lng; };

// 同步初始化：资源随命名空间文件导入时注册，不走后端加载，所以首帧就是正确语言
void i18next.use(initReactI18next).init({
  lng: initialLocale(),
  supportedLngs: ['zh', 'en'],
  fallbackLng: false,
  resources: {},
  defaultNS: 'common',
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  // 缺键按缺陷处理（ui-constraints I18N-006）：两种语言的键由 defineMessages 在编译期对齐，运行时还缺多半是键名写错了
  saveMissing: true,
  missingKeyHandler: (lngs, ns, key) => console.error(`[i18n] 缺键 ${ns}:${key}（${lngs.join(', ')}）`),
});
syncHtmlLang(i18next.language);
i18next.on('languageChanged', syncHtmlLang);

// ---- 命名空间 ----
export type Messages = { readonly [key: string]: string | Messages };
/** 与中文同一套键、值都是字符串：英文缺键或多键都是类型错误 */
export type SameKeys<T> = { [K in keyof T]: T[K] extends string ? string : SameKeys<T[K]> };
type Paths<T, P extends string = ''> = { [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`> }[keyof T & string];
/** t 的键：点号连起来的路径；复数键（x_one / x_other）按 x 取，传 count 选形 */
export type MessageKey<T> = Paths<T> extends infer K ? (K extends `${infer B}_${'one' | 'other'}` ? B : K) : never;
export type Bundle<N extends string = string, Z extends Messages = Messages> = { readonly ns: N; readonly zh: Z; readonly en: SameKeys<Z> };
export type TFn<B extends Bundle> = (key: MessageKey<B['zh']>, options?: TOptions) => string;

/** 定义一个命名空间并注册进 i18next；en 的键必须与 zh 完全一致（缺键、多键在编译期报错） */
export function defineMessages<const N extends string, const Z extends Messages>(ns: N, zh: Z, en: NoInfer<SameKeys<Z>>): Bundle<N, Z> {
  i18next.addResourceBundle('zh', ns, zh, true, true);
  i18next.addResourceBundle('en', ns, en, true, true);
  return { ns, zh, en };
}

/** 组件里取 t：界面语言一换，用它的组件跟着重渲染 */
export function useT<B extends Bundle<FlatNamespace>>(bundle: B): TFn<B> {
  return useTranslation(bundle.ns).t as unknown as TFn<B>;
}

/** 组件之外（普通函数、模块里的工具）取 t：每次调用按当时的界面语言取文案；别在模块顶层调它求值，切语言后顶层常量不会变 */
export function tOf<B extends Bundle<FlatNamespace>>(bundle: B): TFn<B> {
  return i18next.getFixedT(null, bundle.ns) as unknown as TFn<B>;
}

// ---- 当前语言 ----
export const getLocale = (): Locale => (i18next.language === 'en' ? 'en' : 'zh');
/** 给 Intl / toLocaleString 用的语言标签（zh-CN / en），数字、日期、相对时间按界面语言排 */
export const intlLocale = (): string => HTML_LANG[getLocale()];

/** 换界面语言：记在本机、当场生效（用 useT / useLocale 的组件重渲染，<html lang> 跟着换） */
export function setLocale(next: Locale) {
  try { if (typeof window !== 'undefined') window.localStorage.setItem(KEY, next); } catch { /* 存不下就只对这次打开生效 */ }
  void i18next.changeLanguage(next);
}

const subscribe = (onChange: () => void) => { i18next.on('languageChanged', onChange); return () => i18next.off('languageChanged', onChange); };
/** 当前界面语言（React）：要随语言重算的副作用把它列进依赖，比如发进预览 iframe 的标记文字 */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale);
