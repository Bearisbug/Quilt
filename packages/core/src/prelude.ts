import { kebab, colorVarsCss, type Tokens } from './tokens.ts';
import { fontFace } from './fonts.ts';
import { RUNTIME_JS } from './runtime.ts';

// 每版 HTML 的 <head> 由服务端拼装（ADR-005）：token CSS 变量 + Tailwind 映射 + 内联运行时。模型不生成这部分。
export function buildPrelude(tokens: Tokens): string {
  const colorVars = colorVarsCss(tokens.colors);
  const radiusVars = Object.entries(tokens.radius).map(([k, v]) => `--radius-${k}:${v}`).join(';');
  const twColors = Object.keys(tokens.colors).map((k) => `'${kebab(k)}':'rgb(var(--color-${kebab(k)}-rgb) / <alpha-value>)'`).join(',');
  const twRadius = Object.keys(tokens.radius).map((k) => `'${k}':'var(--radius-${k})'`).join(',');
  const font = fontFace(tokens.typography);
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(font.link ? [font.link] : []),
    '<script src="https://cdn.tailwindcss.com"></script>',
    `<script>tailwind.config={theme:{extend:{colors:{${twColors}},borderRadius:{${twRadius}},fontFamily:{sans:${JSON.stringify(font.families)}}}}}</script>`,
    `<style>:root{${colorVars};${radiusVars}}html,body{margin:0;min-height:100%;background:var(--color-background);color:var(--color-on-background);font-family:${font.stack};-webkit-font-smoothing:antialiased}::view-transition-old(root),::view-transition-new(root){animation-duration:220ms}</style>`,
    '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>',
    `<script data-quilt-runtime>${RUNTIME_JS}</script>`,
  ].join('\n');
}

// 叠层屏（v0.63 REQ-PROTO-005）：呈现方式是元数据，不重烤修订——预览域下发与截图时临时注入透明背景，
// 压在别的屏上时露出底下那一屏（截图 omitBackground 拍成带 alpha 的 PNG，卡片再铺暗底）。只认第一个 </head>
export function withOverlayStyle(html: string): string {
  const tag = '<style data-quilt-overlay>html,body{background:transparent}</style>';
  return html.includes('</head>') ? html.replace('</head>', `${tag}\n</head>`) : `${tag}\n${html}`;
}

// 预览下发时把修订里存的运行时换成当前版本（v0.34）：运行时是 Quilt 的代码，不是设计稿的一部分，修一处快捷键转发
// 不该等每张屏再出一版修订才生效。带 data-quilt-runtime 标记的是 v0.34 起的写法；更早的修订只能靠开头那句代码认。
// 导出产物不走这里（它有自己的 EXPORT_RUNTIME）。
const RUNTIME_BLOCK = /<script data-quilt-runtime>[\s\S]*?<\/script>|<script>\(function \(\) \{\s*var state = \(window\.__quiltState[\s\S]*?<\/script>/;
export function withCurrentRuntime(html: string): string {
  return html.replace(RUNTIME_BLOCK, () => `<script data-quilt-runtime>${RUNTIME_JS}</script>`);
}
