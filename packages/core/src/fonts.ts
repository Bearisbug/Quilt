import type { Tokens } from './tokens.ts';

// 字体来源（v0.44 `REQ-EDIT-003`）：族名会进 <link href> 属性、CSS font-family 与 Tailwind 配置的 JS 字符串
// 三种上下文，能进来的族名已由 fontFamilySchema 限成字母 / 数字 / 空格 / 连字符；这里只负责拼 <link> 与字体栈。
// google：照旧发 fonts.googleapis 链接；system：不发任何外链，族名后面跟本机字体栈；url：发用户给的样式表链接。
const GENERIC = new Set(['system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji', 'fangsong']);
// CSS 关键字与 -apple-system 这类厂商关键字不能加引号——加了就变成一个叫 "system-ui" 的字体名
const quote = (family: string) => (GENERIC.has(family) || family.startsWith('-') ? family : `"${family}"`);
const SYSTEM_STACK = ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'];
const WEB_STACK = ['system-ui', 'sans-serif'];
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// lazyLink 给导出件（v1.41 `API-PROTO-002`）：样式表先按 print 加载、到了再切成 all，不阻塞后面的脚本与渲染——
// 连不上字体服务又不报错时（被墙、弱网），阻塞写法会让页面停在这张样式表上整屏空白；不跑脚本的环境走 <noscript> 里的普通写法
export type FontFace = { link: string; lazyLink: string; families: string[]; stack: string };
export function fontFace(typography: Tokens['typography']): FontFace {
  const source = typography.fontSource ?? 'google';
  const head = quote(typography.fontFamily);
  const families = [head, ...(source === 'system' ? SYSTEM_STACK : WEB_STACK).filter((f) => f !== head)];
  const href = source === 'google'
    ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(typography.fontFamily)}:wght@400;500;600;700&display=swap`
    : source === 'url' && typography.fontUrl ? escapeAttr(typography.fontUrl) : '';
  const preconnect = source === 'google' ? '<link rel="preconnect" href="https://fonts.googleapis.com">\n' : '';
  const sheet = `<link href="${href}" rel="stylesheet">`;
  const link = href ? `${preconnect}${sheet}` : '';
  const lazyLink = href ? `${preconnect}<link href="${href}" rel="stylesheet" media="print" onload="this.media='all'">\n<noscript>${sheet}</noscript>` : '';
  return { link, lazyLink, families, stack: families.join(',') };
}
