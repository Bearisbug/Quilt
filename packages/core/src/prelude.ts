import { kebab, type Tokens } from './tokens.ts';
import { fontFace } from './fonts.ts';
import { RUNTIME_JS } from './runtime.ts';

// 每版 HTML 的 <head> 由服务端拼装（ADR-005）：token CSS 变量 + Tailwind 映射 + 内联运行时。模型不生成这部分。
export function buildPrelude(tokens: Tokens): string {
  const colorVars = Object.entries(tokens.colors).map(([k, v]) => `--color-${kebab(k)}:${v}`).join(';');
  const radiusVars = Object.entries(tokens.radius).map(([k, v]) => `--radius-${k}:${v}`).join(';');
  const twColors = Object.keys(tokens.colors).map((k) => `'${kebab(k)}':'var(--color-${kebab(k)})'`).join(',');
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

// 预览下发时把修订里存的运行时换成当前版本（v0.34）：运行时是 Quilt 的代码，不是设计稿的一部分，修一处快捷键转发
// 不该等每张屏再出一版修订才生效。带 data-quilt-runtime 标记的是 v0.34 起的写法；更早的修订只能靠开头那句代码认。
// 导出产物不走这里（它有自己的 EXPORT_RUNTIME）。
const RUNTIME_BLOCK = /<script data-quilt-runtime>[\s\S]*?<\/script>|<script>\(function \(\) \{\s*var state = \(window\.__quiltState[\s\S]*?<\/script>/;
export function withCurrentRuntime(html: string): string {
  return html.replace(RUNTIME_BLOCK, () => `<script data-quilt-runtime>${RUNTIME_JS}</script>`);
}
