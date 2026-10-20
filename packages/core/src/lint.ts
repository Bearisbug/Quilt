import { parseHTML } from 'linkedom';
import { COLOR_CLASS_NAMES } from './tokens.ts';
import type { Locale } from './i18n.ts';

// 设计契约 lint（ADR-005 实证规则集）：单根 / 无 script / 无 style / 禁裸 hex / 禁 arbitrary value /
// 禁默认调色板类 / 禁内联 style / 链接只指向应用路由。断链单列，不计违规（应用地图派生 REQ-PROTO-002）。
export type LintViolation = { rule: string; message: string; qid?: string; sample?: string };
export type LintReport = { passed: boolean; firstTry: boolean; violations: LintViolation[]; danglingRoutes: string[] };

const TW_PALETTE =
  /(?:^|\s)(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d{1,3})?(?=\s|$)/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const ARBITRARY = /\[[^\]]+\]/;

// locale 是 message 的语言（REQ-CORE-046），缺省中文：落进修订 lintReport 的报告保持中文，只有当场返回给请求方的（quilt.validate_screen）按请求的语言
export function lintScreenBody(bodyHtml: string, allowedRoutes: string[], firstTry = true, locale: Locale = 'zh'): LintReport {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh);
  const violations: LintViolation[] = [];
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const body = document.body;
  const roots = Array.from(body.children).filter((el) => el.tagName !== 'SCRIPT');
  if (roots.length !== 1) violations.push({ rule: 'single-root', message: t(`body 顶层元素数为 ${roots.length}，应为 1`, `The body has ${roots.length} top-level elements; it should have 1`) });
  if (body.querySelector('script')) violations.push({ rule: 'no-script', message: t('含 <script>：可以用（图表库等），但离线或 CDN 失效时这块会退化', 'Contains <script>: allowed (chart libraries and the like), but this part degrades offline or when the CDN is down') });
  if (body.querySelector('style')) violations.push({ rule: 'no-style', message: t('含 <style>：可以用，但里面的颜色与尺寸不随设计系统变', 'Contains <style>: allowed, but the colors and sizes in it do not follow the design system') });

  for (const el of Array.from(body.querySelectorAll('*'))) {
    const qid = el.getAttribute('data-qid') ?? undefined;
    const cls = el.getAttribute('class') ?? '';
    const style = el.getAttribute('style') ?? '';
    if (HEX.test(cls) || HEX.test(style)) violations.push({ rule: 'no-raw-hex', message: t('裸色值：换主题时这处颜色不会跟着变', 'Raw color value: this color will not change with the theme'), qid, sample: (cls + ' ' + style).trim().slice(0, 120) });
    if (ARBITRARY.test(cls)) violations.push({ rule: 'no-arbitrary', message: t('Tailwind 任意值：不在设计系统的尺寸 / 颜色刻度里，换主题不跟着变', 'Tailwind arbitrary value: outside the design system size / color scales, so it does not change with the theme'), qid, sample: cls.slice(0, 120) });
    const m = cls.match(TW_PALETTE);
    if (m) violations.push({ rule: 'token-colors-only', message: t(`默认调色板类：换主题不跟着变；设计系统的颜色类是 ${COLOR_CLASS_NAMES.join('/')}`, `Default palette class: it does not change with the theme; the design system color classes are ${COLOR_CLASS_NAMES.join('/')}`), qid, sample: m[0].trim() });
    if (style) violations.push({ rule: 'no-inline-style', message: t('内联 style：不随设计系统变', 'Inline style: does not follow the design system'), qid, sample: style.slice(0, 120) });
  }

  // 导航源三种（REQ-PROTO-001）：href / data-href / form action 同规；表单必须带应用路由 action（form-action）
  const danglingRoutes = new Set<string>();
  for (const [selector, attr] of NAV_SOURCES) {
    for (const el of Array.from(body.querySelectorAll(selector))) {
      const href = el.getAttribute(attr) ?? '';
      if (href.startsWith('/')) { if (!allowedRoutes.includes(href)) danglingRoutes.add(href); }
      else if (!(attr !== 'action' && href === '#')) violations.push({ rule: 'internal-links-only', message: t(`${attr} 只能指向 / 开头的应用路由`, `${attr} can only point to an app route starting with /`), qid: el.getAttribute('data-qid') ?? undefined, sample: href });
    }
  }
  for (const f of Array.from(body.querySelectorAll('form'))) {
    if (!(f.getAttribute('action') ?? '').startsWith('/')) violations.push({ rule: 'form-action', message: t('表单必须带 action="/route"（提交后去的屏）', 'A form must have action="/route" (the screen to go to after submitting)'), qid: f.getAttribute('data-qid') ?? undefined, sample: f.getAttribute('action') ?? t('(无 action)', '(no action)') });
  }

  const dedup = violations.filter((v, i, arr) => arr.findIndex((x) => x.rule === v.rule && x.sample === v.sample) === i);
  return { passed: dedup.length === 0, firstTry, violations: dedup, danglingRoutes: Array.from(danglingRoutes) };
}

const NAV_SOURCES: [string, string][] = [['a[href]', 'href'], ['[data-href]', 'data-href'], ['form[action]', 'action']];

// 应用地图派生（ADR-008）：从修订 HTML 抽三种导航源（href / data-href / form action）的 /… 路由，按元素 qid 记录。
export function extractLinks(bodyHtml: string): { qid: string; href: string }[] {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const out: { qid: string; href: string }[] = [];
  for (const [selector, attr] of NAV_SOURCES) {
    for (const el of Array.from(document.body.querySelectorAll(selector))) {
      const href = el.getAttribute(attr) ?? '';
      if (href.startsWith('/')) out.push({ qid: el.getAttribute('data-qid') ?? '', href });
    }
  }
  return out;
}
