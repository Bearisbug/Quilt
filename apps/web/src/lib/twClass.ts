import { COLOR_CLASS_NAMES, type Tokens } from '@quilt/core';

// 检查器「类名」一行一个时的说明与换档（v0.96 PAGE-CANVAS「类名编辑」）。纯函数。
// 取值按 Tailwind v3 默认（屏用的是 Play CDN v3）；prelude 只改写了颜色、圆角四档与字体，这两样按本项目设计系统取

export type ClassInfo = {
  /** 一句中文说明：作用 + 实际取值 */
  text: string;
  /** 说明表收录了这个类 */
  known: boolean;
  /** 颜色类：前缀（bg / text / border……）、token 名（不是 token 色时为 null）、色块 */
  color?: { prefix: string; token: string | null; swatch?: string };
};
type Ctx = { tokens?: Pick<Tokens, 'colors' | 'radius'>; column?: boolean };
type Parsed = { variants: string[]; important: boolean; negative: boolean; base: string };

// 变体前缀：按 : 拆，任意值方括号里的 : 不算
export function parseClass(cls: string): Parsed {
  const parts: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of cls) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ':' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  let base = cur;
  const important = base.startsWith('!');
  if (important) base = base.slice(1);
  const negative = base.startsWith('-');
  if (negative) base = base.slice(1);
  return { variants: parts, important, negative, base };
}
const joinClass = (p: Parsed) => [...p.variants, `${p.important ? '!' : ''}${p.negative ? '-' : ''}${p.base}`].join(':');

const VARIANT: Record<string, string> = {
  hover: '悬停时', focus: '获焦时', 'focus-visible': '键盘获焦时', 'focus-within': '内部获焦时', active: '按下时', disabled: '禁用时',
  visited: '访问过时', checked: '选中时', first: '第一个', last: '最后一个', odd: '奇数项', even: '偶数项', empty: '为空时',
  'group-hover': '父级悬停时', 'group-focus': '父级获焦时', 'peer-checked': '前面的选框选中时', 'peer-focus': '前面的输入框获焦时',
  placeholder: '占位文字', before: '前置伪元素', after: '后置伪元素', selection: '选中文字', marker: '列表标记',
  dark: '暗色下', sm: '宽度 ≥ 640px 时', md: '宽度 ≥ 768px 时', lg: '宽度 ≥ 1024px 时', xl: '宽度 ≥ 1280px 时', '2xl': '宽度 ≥ 1536px 时',
  'motion-reduce': '减少动态效果时', 'motion-safe': '允许动效时', print: '打印时',
};

// —— 刻度 ——
const SPACING = ['0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96'];
const spacingPx = (v: string) => (v === 'px' ? 1 : Number(v) * 4);
const MAX_W: [string, string][] = [['xs', '320px'], ['sm', '384px'], ['md', '448px'], ['lg', '512px'], ['xl', '576px'], ['2xl', '672px'], ['3xl', '768px'], ['4xl', '896px'], ['5xl', '1024px'], ['6xl', '1152px'], ['7xl', '1280px']];
const TEXT_SIZE: [string, string][] = [['xs', '12px（行高 16px）'], ['sm', '14px（行高 20px）'], ['base', '16px（行高 24px）'], ['lg', '18px（行高 28px）'], ['xl', '20px（行高 28px）'], ['2xl', '24px（行高 32px）'], ['3xl', '30px（行高 36px）'], ['4xl', '36px（行高 40px）'], ['5xl', '48px'], ['6xl', '60px'], ['7xl', '72px'], ['8xl', '96px'], ['9xl', '128px']];
const WEIGHT: [string, string][] = [['thin', '100'], ['extralight', '200'], ['light', '300'], ['normal', '400'], ['medium', '500'], ['semibold', '600'], ['bold', '700'], ['extrabold', '800'], ['black', '900']];
const LEADING: [string, string][] = [['none', '1'], ['tight', '1.25'], ['snug', '1.375'], ['normal', '1.5'], ['relaxed', '1.625'], ['loose', '2']];
const LEADING_PX = ['3', '4', '5', '6', '7', '8', '9', '10'];
const TRACKING: [string, string][] = [['tighter', '-0.05em'], ['tight', '-0.025em'], ['normal', '0'], ['wide', '0.025em'], ['wider', '0.05em'], ['widest', '0.1em']];
const SHADOW: [string, string][] = [['none', '无阴影'], ['sm', '小阴影'], ['', '阴影'], ['md', '中阴影'], ['lg', '大阴影'], ['xl', '更大阴影'], ['2xl', '特大阴影']];
const OPACITY = ['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60', '65', '70', '75', '80', '85', '90', '95', '100'];
const BORDER_W = ['0', '', '2', '4', '8'];
const RING_W = ['0', '1', '2', '', '4', '8'];
const Z = ['0', '10', '20', '30', '40', '50'];
const DURATION = ['0', '75', '100', '150', '200', '300', '500', '700', '1000'];
const COUNT_12 = Array.from({ length: 12 }, (_, i) => String(i + 1));
const CLAMP = ['1', '2', '3', '4', '5', '6'];

// 间距 / 尺寸类前缀（长的在前，min-w 先于 m）：名称、能不能取负值
const SIZED: [string, string][] = [
  ['space-x', '子元素横向间距'], ['space-y', '子元素纵向间距'], ['gap-x', '列间隙'], ['gap-y', '行间隙'], ['gap', '子元素间隙'],
  ['min-w', '最小宽度'], ['min-h', '最小高度'], ['max-h', '最大高度'], ['size', '宽高'], ['basis', '弹性基准尺寸'],
  ['inset-x', '左右偏移'], ['inset-y', '上下偏移'], ['inset', '四边偏移'], ['top', '距上'], ['right', '距右'], ['bottom', '距下'], ['left', '距左'], ['start', '距起始侧'], ['end', '距结束侧'],
  ['translate-x', '横向平移'], ['translate-y', '纵向平移'], ['indent', '首行缩进'],
  ['px', '左右内边距'], ['py', '上下内边距'], ['pt', '上内边距'], ['pr', '右内边距'], ['pb', '下内边距'], ['pl', '左内边距'], ['ps', '起始侧内边距'], ['pe', '结束侧内边距'], ['p', '内边距'],
  ['mx', '左右外边距'], ['my', '上下外边距'], ['mt', '上外边距'], ['mr', '右外边距'], ['mb', '下外边距'], ['ml', '左外边距'], ['ms', '起始侧外边距'], ['me', '结束侧外边距'], ['m', '外边距'],
  ['w', '宽度'], ['h', '高度'],
];
const COLOR_PREFIX: [string, string][] = [
  ['ring-offset', '外环间隙色'], ['bg', '背景色'], ['text', '文字色'], ['border', '边框色'], ['ring', '外环色'], ['outline', '描边色'], ['divide', '分隔线色'],
  ['fill', '填充色'], ['stroke', '线条色'], ['from', '渐变起始色'], ['via', '渐变中间色'], ['to', '渐变结束色'], ['placeholder', '占位文字色'],
  ['accent', '控件强调色'], ['caret', '光标色'], ['decoration', '下划线色'], ['shadow', '阴影色'],
];
const TW_PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/;
const SIDES: Record<string, string> = { t: '上', r: '右', b: '下', l: '左', x: '左右', y: '上下', s: '起始侧', e: '结束侧', tl: '左上', tr: '右上', br: '右下', bl: '左下' };

const STATIC: Record<string, string> = {
  block: '块级显示', 'inline-block': '行内块显示', inline: '行内显示', flex: '弹性布局', 'inline-flex': '行内弹性布局', grid: '网格布局', 'inline-grid': '行内网格布局',
  hidden: '隐藏', contents: '自身不生成盒子', table: '表格布局', 'flow-root': '独立排版上下文',
  'flex-row': '子元素横向排列', 'flex-col': '子元素纵向排列', 'flex-row-reverse': '子元素横向倒序排列', 'flex-col-reverse': '子元素纵向倒序排列',
  'flex-wrap': '子元素允许换行', 'flex-nowrap': '子元素不换行', 'flex-1': '占满剩余空间', 'flex-auto': '按内容伸缩', 'flex-initial': '可收缩不伸展', 'flex-none': '不伸缩',
  grow: '可伸展占空', 'grow-0': '不伸展', shrink: '可收缩', 'shrink-0': '不收缩',
  'self-start': '自身靠起点', 'self-center': '自身居中', 'self-end': '自身靠终点', 'self-stretch': '自身拉伸', 'self-auto': '自身按父级对齐',
  'place-items-center': '子元素在格子里居中', 'place-content-center': '内容整体居中',
  relative: '相对定位', absolute: '绝对定位', fixed: '固定定位（相对视口）', sticky: '粘性定位', static: '默认定位',
  'overflow-hidden': '超出部分裁掉', 'overflow-auto': '超出时可滚动', 'overflow-scroll': '始终可滚动', 'overflow-visible': '超出部分照常显示',
  'overflow-x-auto': '横向超出时可滚动', 'overflow-y-auto': '纵向超出时可滚动', 'overflow-x-hidden': '横向超出裁掉', 'overflow-y-hidden': '纵向超出裁掉', 'overflow-clip': '超出部分裁掉（不可滚）',
  'text-left': '文字左对齐', 'text-center': '文字居中', 'text-right': '文字右对齐', 'text-justify': '文字两端对齐', 'text-start': '文字靠起始侧', 'text-end': '文字靠结束侧',
  'text-wrap': '文字自动换行', 'text-nowrap': '文字不换行', 'text-balance': '标题各行长度均衡', 'text-pretty': '避免末行孤字', 'text-ellipsis': '超出显示省略号', 'text-clip': '超出直接裁掉',
  uppercase: '字母全大写', lowercase: '字母全小写', capitalize: '单词首字母大写', 'normal-case': '不改大小写', italic: '斜体', 'not-italic': '正体',
  underline: '下划线', overline: '上划线', 'line-through': '删除线', 'no-underline': '去掉下划线', truncate: '单行显示，超出加省略号',
  'whitespace-nowrap': '不换行', 'whitespace-normal': '正常换行', 'whitespace-pre': '保留空白不换行', 'whitespace-pre-wrap': '保留空白并换行', 'whitespace-pre-line': '保留换行符',
  'break-words': '长单词可断行', 'break-all': '任意字符处可断行', 'break-normal': '默认断行', antialiased: '字体灰度抗锯齿', 'subpixel-antialiased': '字体亚像素抗锯齿', 'tabular-nums': '数字等宽',
  'font-sans': '无衬线字体', 'font-serif': '衬线字体', 'font-mono': '等宽字体',
  'border-solid': '实线边框', 'border-dashed': '虚线边框', 'border-dotted': '点线边框', 'border-none': '无边框', 'border-collapse': '表格边框合并',
  'ring-inset': '外环画在内侧', 'outline-none': '去掉默认描边', outline: '描边 1px',
  'cursor-pointer': '鼠标变手形', 'cursor-default': '默认鼠标', 'cursor-not-allowed': '鼠标显示禁止', 'cursor-text': '鼠标显示文本光标', 'cursor-move': '鼠标显示移动', 'cursor-grab': '鼠标显示抓手',
  'select-none': '文字不可选中', 'select-text': '文字可选中', 'select-all': '点一下选中全部文字', 'pointer-events-none': '不接收点击', 'pointer-events-auto': '接收点击',
  transition: '过渡动画（颜色、透明度、阴影、变换）', 'transition-all': '所有属性过渡（布局属性也会跟着动，建议点名属性）', 'transition-colors': '颜色过渡', 'transition-opacity': '透明度过渡', 'transition-transform': '变换过渡', 'transition-shadow': '阴影过渡', 'transition-none': '无过渡',
  'ease-linear': '匀速', 'ease-in': '缓入（先慢后快，界面交互里显得发钝）', 'ease-out': '缓出（先快后慢）', 'ease-in-out': '缓入缓出',
  'animate-spin': '旋转动画', 'animate-pulse': '呼吸闪烁动画', 'animate-bounce': '弹跳动画', 'animate-ping': '扩散动画', 'animate-none': '无动画',
  'object-cover': '图片裁切填满', 'object-contain': '图片完整显示', 'object-center': '图片居中', 'aspect-square': '宽高比 1:1', 'aspect-video': '宽高比 16:9', 'aspect-auto': '按内容宽高比',
  'sr-only': '只给读屏软件读，界面上不显示', 'not-sr-only': '取消只给读屏软件',
  'list-none': '列表无标记', 'list-disc': '列表圆点标记', 'list-decimal': '列表数字标记', 'list-inside': '列表标记在内侧',
  'appearance-none': '去掉浏览器默认外观', 'resize-none': '不可拖动调整大小', 'resize-y': '可纵向拖动调整大小', resize: '可拖动调整大小',
  'bg-cover': '背景图铺满裁切', 'bg-contain': '背景图完整显示', 'bg-center': '背景图居中', 'bg-no-repeat': '背景图不重复',
  'bg-gradient-to-r': '从左到右渐变', 'bg-gradient-to-l': '从右到左渐变', 'bg-gradient-to-b': '从上到下渐变', 'bg-gradient-to-t': '从下到上渐变', 'bg-gradient-to-br': '向右下渐变', 'bg-gradient-to-tr': '向右上渐变', 'bg-gradient-to-bl': '向左下渐变', 'bg-gradient-to-tl': '向左上渐变',
  'divide-x': '子元素之间竖分隔线', 'divide-y': '子元素之间横分隔线', group: '标记父级：供子元素的 group- 变体引用', peer: '标记兄弟：供后面元素的 peer- 变体引用',
  container: '按断点限宽的容器', isolate: '独立层叠上下文', transform: '启用变换', 'will-change-transform': '预告会变换（性能提示）',
  'grid-cols-none': '不分网格列', 'col-span-full': '跨满所有列', 'line-clamp-none': '不限行数', 'mx-auto': '左右外边距自动（水平居中）',
};

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const opt = <T,>(list: [string, T][], key: string) => list.find(([k]) => k === key)?.[1];
const rem = (v: string) => (/^\[.+\]$/.test(v) ? v.slice(1, -1) : null);

// 圆角各档的实际取值：sm / md / lg / full 来自设计系统（prelude 改写了），其余是 Tailwind 默认
function radii(ctx: Ctx): [string, number, string][] {
  const r = ctx.tokens?.radius;
  const n = (v: string | undefined, d: number) => (v ? (v.endsWith('px') ? parseFloat(v) : v.endsWith('rem') ? parseFloat(v) * 16 : d) : d);
  return [
    ['none', 0, '无圆角'], ['sm', n(r?.sm, 2), ''], ['', 4, ''], ['md', n(r?.md, 6), ''], ['lg', n(r?.lg, 8), ''],
    ['xl', 12, ''], ['2xl', 16, ''], ['3xl', 24, ''], ['full', n(r?.full, 9999), '全圆'],
  ];
}
const radiusLabel = (key: string, px: number, ctx: Ctx) =>
  key === 'none' ? '无圆角' : key === 'full' ? '全圆' : `${px}px${ctx.tokens && ['sm', 'md', 'lg'].includes(key) ? `（设计系统 ${key} 档）` : ''}`;

function colorInfo(prefix: string, label: string, value: string, ctx: Ctx): ClassInfo {
  const [name, alpha] = value.split('/');
  const pct = alpha ? `，${alpha}% 不透明` : '';
  if (COLOR_CLASS_NAMES.includes(name)) {
    const swatch = ctx.tokens?.colors[camel(name) as keyof Tokens['colors']];
    return { text: `${label} ${name}${pct}`, known: true, color: { prefix, token: name, swatch } };
  }
  const plain: Record<string, string> = { white: '白色', black: '黑色', transparent: '透明', current: '跟随文字色', inherit: '继承父级' };
  if (plain[name]) return { text: `${label}：${plain[name]}${pct}（非 token 色）`, known: true, color: { prefix, token: null } };
  if (TW_PALETTE.test(name)) return { text: `${label}：Tailwind 色 ${name}${pct}（非 token 色，偏离设计系统）`, known: true, color: { prefix, token: null } };
  const raw = rem(name);
  if (raw) return { text: `${label}：${raw}${pct}（任意值，非 token 色）`, known: true, color: { prefix, token: null, swatch: /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : undefined } };
  return { text: '未收录', known: false };
}

function sizeValue(prefix: string, v: string, neg: boolean): string | null {
  const sign = neg ? '-' : '';
  if (SPACING.includes(v)) return `${sign}${spacingPx(v)}px`;
  const raw = rem(v);
  if (raw) return `${sign}${raw}`;
  if (/^\d+\/\d+$/.test(v)) { const [a, b] = v.split('/').map(Number); return `${sign}${+(a / b * 100).toFixed(4)}%`; }
  const words: Record<string, string> = { auto: '自动', full: '100%', min: '按最小内容', max: '按最大内容', fit: '适应内容', none: '不限' };
  if (v === 'screen') return prefix.includes('h') ? '100% 视口高度' : '100% 视口宽度';
  if (['svh', 'lvh', 'dvh'].includes(v)) return { svh: '小视口高度', lvh: '大视口高度', dvh: '动态视口高度' }[v]!;
  return words[v] ?? null;
}

export function explainClass(cls: string, ctx: Ctx = {}): ClassInfo {
  const p = parseClass(cls.trim());
  if (!p.base) return { text: '', known: false };
  const inner = explainBase(p, ctx);
  if (!inner.known) return inner;
  const cond = p.variants.map((v) => VARIANT[v] ?? `${v} 时`).join('、');
  return { ...inner, text: `${cond ? `${cond}，` : ''}${inner.text}${p.important ? '（强制）' : ''}` };
}

function explainBase({ base, negative }: Parsed, ctx: Ctx): ClassInfo {
  const ok = (text: string): ClassInfo => ({ text, known: true });
  if (STATIC[base]) return ok(STATIC[base]);
  // 对齐：按同一元素有没有 flex-col 说成纵向或横向
  const axis = (cross: boolean) => (cross ? (ctx.column ? '横向' : '纵向') : (ctx.column ? '纵向' : '横向'));
  const ALIGN: Record<string, string> = { start: '靠起点', end: '靠终点', center: '居中', baseline: '按文字基线对齐', stretch: '拉伸填满', between: '两端对齐、间距均分', around: '四周间距均分', evenly: '间距完全均分', normal: '默认' };
  let m = /^items-(.+)$/.exec(base);
  if (m && ALIGN[m[1]]) return ok(`子元素${axis(true)}${ALIGN[m[1]]}`);
  m = /^justify-(.+)$/.exec(base);
  if (m && ALIGN[m[1]]) return ok(`子元素${axis(false)}${ALIGN[m[1]]}`);
  m = /^content-(.+)$/.exec(base);
  if (m && ALIGN[m[1]]) return ok(`多行内容整体${ALIGN[m[1]]}`);
  // 字号 / 文字色
  m = /^text-(.+)$/.exec(base);
  if (m) { const size = opt(TEXT_SIZE, m[1]); if (size) return ok(`字号 ${size}`); return colorInfo('text', '文字色', m[1], ctx); }
  m = /^font-(.+)$/.exec(base);
  if (m) { const w = opt(WEIGHT, m[1]); if (w) return ok(`字重 ${w}`); }
  m = /^leading-(.+)$/.exec(base);
  if (m) { const l = opt(LEADING, m[1]); if (l) return ok(`行高 ${l} 倍`); if (LEADING_PX.includes(m[1])) return ok(`行高 ${Number(m[1]) * 4}px`); }
  m = /^tracking-(.+)$/.exec(base);
  if (m) { const t = opt(TRACKING, m[1]); if (t) return ok(`字距 ${t}`); }
  m = /^line-clamp-(\d+)$/.exec(base);
  if (m) return ok(`最多显示 ${m[1]} 行，超出省略`);
  // 圆角
  m = /^rounded(?:-(.+))?$/.exec(base);
  if (m) {
    const parts = (m[1] ?? '').split('-').filter(Boolean);
    const side = parts[0] && SIDES[parts[0]] ? SIDES[parts.shift()!] : '';
    const key = parts.join('-');
    const hit = radii(ctx).find(([k]) => k === key);
    const raw = rem(key);
    if (hit) return ok(`${side ? `${side}` : ''}圆角 ${radiusLabel(key, hit[1], ctx)}`.replace('圆角 无圆角', '无圆角').replace('圆角 全圆', '圆角：全圆'));
    if (raw) return ok(`${side}圆角 ${raw}`);
  }
  // 阴影 / 透明度 / 层级 / 时长
  m = /^shadow(?:-(.+))?$/.exec(base);
  if (m) { const s = opt(SHADOW, m[1] ?? ''); if (s) return ok(s); if (m[1] === 'inner') return ok('内阴影'); return colorInfo('shadow', '阴影色', m[1]!, ctx); }
  m = /^opacity-(\d+)$/.exec(base);
  if (m) return ok(`不透明度 ${m[1]}%`);
  m = /^z-(.+)$/.exec(base);
  if (m) return ok(m[1] === 'auto' ? '层级自动' : `层级 ${negative ? '-' : ''}${m[1]}`);
  m = /^(duration|delay)-(\d+)$/.exec(base);
  if (m) return ok(`${m[1] === 'duration' ? '过渡时长' : '过渡延迟'} ${m[2]}ms`);
  // 边框宽度 / 边框色
  m = /^border(?:-([trblxyse]))?(?:-(.+))?$/.exec(base);
  if (m) {
    const side = m[1] ? SIDES[m[1]] : ''; const v = m[2] ?? '';
    if (BORDER_W.includes(v)) return ok(`${side}边框 ${v === '' ? 1 : v}px`);
    if (!m[1]) return colorInfo('border', '边框色', v, ctx);
  }
  m = /^ring(?:-(.+))?$/.exec(base);
  if (m) { const v = m[1] ?? ''; if (RING_W.includes(v)) return ok(`外环 ${v === '' ? 3 : v}px`); if (/^offset-\d+$/.test(v)) return ok(`外环间隙 ${v.slice(7)}px`); }
  m = /^outline-(\d+)$/.exec(base);
  if (m) return ok(`描边 ${m[1]}px`);
  m = /^outline-offset-(\d+)$/.exec(base);
  if (m) return ok(`描边与元素间隙 ${m[1]}px`);
  // 网格
  m = /^grid-cols-(\d+)$/.exec(base);
  if (m) return ok(`${m[1]} 列网格`);
  m = /^grid-rows-(\d+)$/.exec(base);
  if (m) return ok(`${m[1]} 行网格`);
  m = /^(col|row)-span-(\d+)$/.exec(base);
  if (m) return ok(`跨 ${m[2]} ${m[1] === 'col' ? '列' : '行'}`);
  m = /^(col|row)-start-(\d+)$/.exec(base);
  if (m) return ok(`从第 ${m[2]} ${m[1] === 'col' ? '列' : '行'}线开始`);
  // 变换 / 滤镜
  m = /^rotate-(\d+)$/.exec(base);
  if (m) return ok(`旋转 ${negative ? '-' : ''}${m[1]}°`);
  m = /^scale-(\d+)$/.exec(base);
  if (m) return ok(`缩放到 ${m[1]}%`);
  m = /^(backdrop-)?blur(?:-(.+))?$/.exec(base);
  if (m) return ok(`${m[1] ? '背景' : ''}模糊${m[2] ? ` ${m[2]}` : ''}`);
  // 最大宽度的命名档
  m = /^max-w-(.+)$/.exec(base);
  if (m) { const w = opt(MAX_W, m[1]); if (w) return ok(`最大宽度 ${w}`); if (m[1] === 'prose') return ok('最大宽度约 65 个字符'); const v = sizeValue('max-w', m[1], false); if (v) return ok(`最大宽度 ${v}`); }
  // 间距 / 尺寸
  for (const [prefix, label] of SIZED) {
    if (!base.startsWith(`${prefix}-`)) continue;
    const v = sizeValue(prefix, base.slice(prefix.length + 1), negative);
    if (v) return ok(`${label} ${v}`);
  }
  // 其余带颜色的前缀
  for (const [prefix, label] of COLOR_PREFIX) {
    if (base.startsWith(`${prefix}-`)) return colorInfo(prefix, label, base.slice(prefix.length + 1), ctx);
  }
  return { text: '未收录', known: false };
}

// —— 换档 ——
// 一组有序的档位：取当前档的下标、前后挪一格。返回 null = 不是这类、或到头了
function stepIn(list: string[], cur: string, dir: 1 | -1): string | null {
  const i = list.indexOf(cur);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < list.length ? list[j] : null;
}
const withSuffix = (prefix: string, v: string) => (v === '' ? prefix : `${prefix}-${v}`);

export function stepClass(cls: string, dir: 1 | -1, ctx: Ctx = {}): string | null {
  const p = parseClass(cls.trim());
  const next = stepBase(p.base, dir, ctx);
  return next === null ? null : joinClass({ ...p, base: next });
}

function stepBase(base: string, dir: 1 | -1, ctx: Ctx): string | null {
  const keyed = (re: RegExp, prefix: string, list: string[]) => { const m = re.exec(base); if (!m) return undefined; const n = stepIn(list, m[1] ?? '', dir); return n === null ? null : withSuffix(prefix, n); };
  const tries: [RegExp, string, string[]][] = [
    [/^text-(xs|sm|base|lg|[2-9]?xl)$/, 'text', TEXT_SIZE.map(([k]) => k)],
    [/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, 'font', WEIGHT.map(([k]) => k)],
    [/^leading-(none|tight|snug|normal|relaxed|loose)$/, 'leading', LEADING.map(([k]) => k)],
    [/^leading-(\d+)$/, 'leading', LEADING_PX],
    [/^tracking-(tighter|tight|normal|wide|wider|widest)$/, 'tracking', TRACKING.map(([k]) => k)],
    [/^shadow(?:-(none|sm|md|lg|xl|2xl))?$/, 'shadow', SHADOW.map(([k]) => k)],
    [/^opacity-(\d+)$/, 'opacity', OPACITY],
    [/^z-(\d+)$/, 'z', Z],
    [/^duration-(\d+)$/, 'duration', DURATION],
    [/^delay-(\d+)$/, 'delay', DURATION],
    [/^grid-cols-(\d+)$/, 'grid-cols', COUNT_12],
    [/^grid-rows-(\d+)$/, 'grid-rows', COUNT_12],
    [/^col-span-(\d+)$/, 'col-span', COUNT_12],
    [/^row-span-(\d+)$/, 'row-span', COUNT_12],
    [/^line-clamp-(\d+)$/, 'line-clamp', CLAMP],
    [/^max-w-(xs|sm|md|lg|[2-7]?xl)$/, 'max-w', MAX_W.map(([k]) => k)],
    [/^ring(?:-(0|1|2|4|8))?$/, 'ring', RING_W],
  ];
  for (const [re, prefix, list] of tries) { const r = keyed(re, prefix, list); if (r !== undefined) return r; }
  // 边框宽度（带方向）
  let m = /^border(?:-([trblxyse]))?(?:-(0|2|4|8))?$/.exec(base);
  if (m) { const pre = m[1] ? `border-${m[1]}` : 'border'; const n = stepIn(BORDER_W, m[2] ?? '', dir); return n === null ? null : withSuffix(pre, n); }
  // 圆角：按本项目的实际取值排序后挪
  m = /^rounded(?:-(.+))?$/.exec(base);
  if (m) {
    const parts = (m[1] ?? '').split('-').filter(Boolean);
    const side = parts[0] && SIDES[parts[0]] ? parts.shift()! : '';
    const order = [...radii(ctx)].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    const n = stepIn(order, parts.join('-'), dir);
    if (n === null) return null;
    return ['rounded', side, n].filter(Boolean).join('-');
  }
  // 间距 / 尺寸：Tailwind 间距刻度
  for (const [prefix] of SIZED) {
    if (!base.startsWith(`${prefix}-`)) continue;
    const n = stepIn(SPACING, base.slice(prefix.length + 1), dir);
    return n === null ? null : `${prefix}-${n}`;
  }
  return null;
}

// 颜色类换 token 色：保留前缀、变体与透明度修饰符
export function withColorToken(cls: string, prefix: string, token: string): string {
  const p = parseClass(cls.trim());
  const alpha = p.base.slice(prefix.length + 1).split('/')[1];
  return joinClass({ ...p, base: `${prefix}-${token}${alpha ? `/${alpha}` : ''}` });
}

// 类名串 ↔ 一行一个：保存时按行序拼回，比较时按空白拆开、去掉空项
export const splitClasses = (s: string): string[] => s.split(/\s+/).filter(Boolean);
export const sameClasses = (a: string, b: string): boolean => splitClasses(a).join(' ') === splitClasses(b).join(' ');
