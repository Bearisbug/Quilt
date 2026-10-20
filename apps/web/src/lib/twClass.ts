import { COLOR_CLASS_NAMES, type Tokens } from '@quilt/core/browser';
import { tOf } from '@/i18n';
import twMessages from '@/i18n/locales/twclass';

// 检查器「类名」一行一个时的说明与换档（v0.96 PAGE-CANVAS「类名编辑」）。纯函数。
// 取值按 Tailwind v3 默认（屏用的是 Play CDN v3）；prelude 只改写了颜色、圆角四档与字体，这两样按本项目设计系统取

type ClassInfo = {
  /** 一句说明（界面语言）：作用 + 实际取值 */
  text: string;
  /** 说明表收录了这个类 */
  known: boolean;
  /** 颜色类：前缀（bg / text / border……）、token 名（不是 token 色时为 null）、色块 */
  color?: { prefix: string; token: string | null; swatch?: string };
};
type Ctx = { tokens?: Pick<Tokens, 'colors' | 'radius'>; column?: boolean };
type Parsed = { variants: string[]; important: boolean; negative: boolean; base: string };

// 变体前缀：按 : 拆，任意值方括号里的 : 不算
function parseClass(cls: string): Parsed {
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

const t = tOf(twMessages);
const M = twMessages.zh;
// 说明表（i18n/locales/twclass.ts）的键是类名或前缀的驼峰写法：flex-1 → flex1、bg-gradient-to-r → bgGradientToR、min-w → minW。
// 按类名反查键时只认这张表里的写法，不是表里的类（含 toString 这类原型上的名字）一律查不到
const classOf = (key: string) => key.replace(/[A-Z]|(?<=[a-z])\d/g, (c) => `-${c.toLowerCase()}`);
const byClass = <O extends object>(o: O) => new Map(Object.keys(o).map((k) => [classOf(k), k as Extract<keyof O, string>]));
const isIn = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

const VARIANT = byClass(M.variant);

// —— 刻度 ——
const SPACING = ['0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96'];
const spacingPx = (v: string) => (v === 'px' ? 1 : Number(v) * 4);
const MAX_W: [string, string][] = [['xs', '320px'], ['sm', '384px'], ['md', '448px'], ['lg', '512px'], ['xl', '576px'], ['2xl', '672px'], ['3xl', '768px'], ['4xl', '896px'], ['5xl', '1024px'], ['6xl', '1152px'], ['7xl', '1280px']];
// 字号档：字号、行高（5xl 起行高为 1，不写）
const TEXT_SIZE: [string, string, string?][] = [['xs', '12px', '16px'], ['sm', '14px', '20px'], ['base', '16px', '24px'], ['lg', '18px', '28px'], ['xl', '20px', '28px'], ['2xl', '24px', '32px'], ['3xl', '30px', '36px'], ['4xl', '36px', '40px'], ['5xl', '48px'], ['6xl', '60px'], ['7xl', '72px'], ['8xl', '96px'], ['9xl', '128px']];
const WEIGHT: [string, string][] = [['thin', '100'], ['extralight', '200'], ['light', '300'], ['normal', '400'], ['medium', '500'], ['semibold', '600'], ['bold', '700'], ['extrabold', '800'], ['black', '900']];
const LEADING: [string, string][] = [['none', '1'], ['tight', '1.25'], ['snug', '1.375'], ['normal', '1.5'], ['relaxed', '1.625'], ['loose', '2']];
const LEADING_PX = ['3', '4', '5', '6', '7', '8', '9', '10'];
const TRACKING: [string, string][] = [['tighter', '-0.05em'], ['tight', '-0.025em'], ['normal', '0'], ['wide', '0.025em'], ['wider', '0.05em'], ['widest', '0.1em']];
const SHADOW = ['none', 'sm', '', 'md', 'lg', 'xl', '2xl'] as const;
const OPACITY = ['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60', '65', '70', '75', '80', '85', '90', '95', '100'];
const BORDER_W = ['0', '', '2', '4', '8'];
const RING_W = ['0', '1', '2', '', '4', '8'];
const Z = ['0', '10', '20', '30', '40', '50'];
const DURATION = ['0', '75', '100', '150', '200', '300', '500', '700', '1000'];
const COUNT_12 = Array.from({ length: 12 }, (_, i) => String(i + 1));
const CLAMP = ['1', '2', '3', '4', '5', '6'];

// 间距 / 尺寸类前缀（长的在前，min-w 先于 m）：[类名前缀, 说明表的键]
const SIZED = ([
  'spaceX', 'spaceY', 'gapX', 'gapY', 'gap', 'minW', 'minH', 'maxH', 'size', 'basis',
  'insetX', 'insetY', 'inset', 'top', 'right', 'bottom', 'left', 'start', 'end', 'translateX', 'translateY', 'indent',
  'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'p', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'm', 'w', 'h',
] satisfies (keyof typeof M.sized)[]).map((k) => [classOf(k), k] as const);
type ColorKey = keyof typeof M.colorLabel;
const COLOR_PREFIX: ColorKey[] = [
  'ringOffset', 'bg', 'text', 'border', 'ring', 'outline', 'divide', 'fill', 'stroke', 'from', 'via', 'to', 'placeholder', 'accent', 'caret', 'decoration', 'shadow',
];
const TW_PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/;
const SIDES = byClass(M.side);
const ALIGN = byClass(M.align.lines);
const PLAIN_COLOR = byClass(M.plainColor);
const SIZE_WORD = byClass(M.sizeWord);

const STATIC = byClass(M.static);

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const opt = <T,>(list: [string, T][], key: string) => list.find(([k]) => k === key)?.[1];
const rem = (v: string) => (/^\[.+\]$/.test(v) ? v.slice(1, -1) : null);

// 圆角各档的实际取值：sm / md / lg / full 来自设计系统（prelude 改写了），其余是 Tailwind 默认
function radii(ctx: Ctx): [string, number][] {
  const r = ctx.tokens?.radius;
  const n = (v: string | undefined, d: number) => (v ? (v.endsWith('px') ? parseFloat(v) : v.endsWith('rem') ? parseFloat(v) * 16 : d) : d);
  return [
    ['none', 0], ['sm', n(r?.sm, 2)], ['', 4], ['md', n(r?.md, 6)], ['lg', n(r?.lg, 8)],
    ['xl', 12], ['2xl', 16], ['3xl', 24], ['full', n(r?.full, 9999)],
  ];
}
// 圆角说明：side 是方向（rounded-t-* 的 t，没有方向时 undefined），value 是这一档的取值说明
function radiusText(side: string | undefined, key: string, value: string): string {
  const s = side && t(`side.${SIDES.get(side)!}`);
  if (key === 'none') return s ? t('radius.noneSide', { side: s }) : t('radius.none');
  if (key === 'full') return s ? t('radius.fullSide', { side: s }) : t('radius.full');
  return s ? t('radius.valueSide', { side: s, value }) : t('radius.value', { value });
}

function colorInfo(key: ColorKey, value: string, ctx: Ctx): ClassInfo {
  const prefix = classOf(key);
  const label = t(`colorLabel.${key}`);
  const [name, alpha] = value.split('/');
  if (COLOR_CLASS_NAMES.includes(name)) {
    const swatch = ctx.tokens?.colors[camel(name) as keyof Tokens['colors']];
    return { text: t(alpha ? 'color.tokenAlpha' : 'color.token', { label, name, alpha }), known: true, color: { prefix, token: name, swatch } };
  }
  const plain = PLAIN_COLOR.get(name);
  if (plain) return { text: t(alpha ? 'color.plainAlpha' : 'color.plain', { label, name: t(`plainColor.${plain}`), alpha }), known: true, color: { prefix, token: null } };
  if (TW_PALETTE.test(name)) return { text: t(alpha ? 'color.paletteAlpha' : 'color.palette', { label, name, alpha }), known: true, color: { prefix, token: null } };
  const raw = rem(name);
  if (raw) return { text: t(alpha ? 'color.rawAlpha' : 'color.raw', { label, value: raw, alpha }), known: true, color: { prefix, token: null, swatch: /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : undefined } };
  return { text: t('unknown'), known: false };
}

function sizeValue(prefix: string, v: string, neg: boolean): string | null {
  const sign = neg ? '-' : '';
  if (SPACING.includes(v)) return `${sign}${spacingPx(v)}px`;
  const raw = rem(v);
  if (raw) return `${sign}${raw}`;
  if (/^\d+\/\d+$/.test(v)) { const [a, b] = v.split('/').map(Number); return `${sign}${+(a / b * 100).toFixed(4)}%`; }
  if (v === 'screen') return t(prefix.includes('h') ? 'screenHeight' : 'screenWidth');
  const word = SIZE_WORD.get(v);
  return word ? t(`sizeWord.${word}`) : null;
}

export function explainClass(cls: string, ctx: Ctx = {}): ClassInfo {
  const p = parseClass(cls.trim());
  if (!p.base) return { text: '', known: false };
  const inner = explainBase(p, ctx);
  if (!inner.known) return inner;
  const cond = p.variants.map((v) => { const k = VARIANT.get(v); return k ? t(`variant.${k}`) : t('variantOther', { variant: v }); }).join(t('variantJoin'));
  const text = cond ? t('withVariants', { cond, text: inner.text }) : inner.text;
  return { ...inner, text: p.important ? t('important', { text }) : text };
}

function explainBase({ base, negative }: Parsed, ctx: Ctx): ClassInfo {
  const ok = (text: string): ClassInfo => ({ text, known: true });
  const fixed = STATIC.get(base);
  if (fixed) return ok(t(`static.${fixed}`));
  // 对齐：按同一元素有没有 flex-col 说成纵向或横向
  const axis = (cross: boolean) => (cross ? (ctx.column ? 'horizontal' : 'vertical') : (ctx.column ? 'vertical' : 'horizontal'));
  let m = /^items-(.+)$/.exec(base);
  let a = m && ALIGN.get(m[1]);
  if (a) return ok(t(`align.${axis(true)}.${a}`));
  m = /^justify-(.+)$/.exec(base);
  a = m && ALIGN.get(m[1]);
  if (a) return ok(t(`align.${axis(false)}.${a}`));
  m = /^content-(.+)$/.exec(base);
  a = m && ALIGN.get(m[1]);
  if (a) return ok(t(`align.lines.${a}`));
  // 字号 / 文字色
  m = /^text-(.+)$/.exec(base);
  if (m) {
    const v = m[1];
    const size = TEXT_SIZE.find(([k]) => k === v);
    if (size) return ok(size[2] ? t('fontSizeLeading', { size: size[1], leading: size[2] }) : t('fontSize', { size: size[1] }));
    return colorInfo('text', v, ctx);
  }
  m = /^font-(.+)$/.exec(base);
  if (m) { const w = opt(WEIGHT, m[1]); if (w) return ok(t('fontWeight', { value: w })); }
  m = /^leading-(.+)$/.exec(base);
  if (m) { const l = opt(LEADING, m[1]); if (l) return ok(t('lineHeightRatio', { value: l })); if (LEADING_PX.includes(m[1])) return ok(t('lineHeight', { value: `${Number(m[1]) * 4}px` })); }
  m = /^tracking-(.+)$/.exec(base);
  if (m) { const tr = opt(TRACKING, m[1]); if (tr) return ok(t('letterSpacing', { value: tr })); }
  m = /^line-clamp-(\d+)$/.exec(base);
  if (m) return ok(t('lineClamp', { count: Number(m[1]) }));
  // 圆角
  m = /^rounded(?:-(.+))?$/.exec(base);
  if (m) {
    const parts = (m[1] ?? '').split('-').filter(Boolean);
    const side = parts[0] && SIDES.has(parts[0]) ? parts.shift()! : undefined;
    const key = parts.join('-');
    const hit = radii(ctx).find(([k]) => k === key);
    const raw = rem(key);
    if (hit) return ok(radiusText(side, key, ctx.tokens && ['sm', 'md', 'lg'].includes(key) ? t('radius.token', { px: hit[1], step: key }) : `${hit[1]}px`));
    if (raw) return ok(radiusText(side, key, raw));
  }
  // 阴影 / 透明度 / 层级 / 时长
  m = /^shadow(?:-(.+))?$/.exec(base);
  if (m) { const s = m[1] ?? ''; if (isIn(SHADOW, s)) return ok(t(`shadow.${s || 'default'}`)); if (s === 'inner') return ok(t('shadow.inner')); return colorInfo('shadow', s, ctx); }
  m = /^opacity-(\d+)$/.exec(base);
  if (m) return ok(t('opacity', { value: m[1] }));
  m = /^z-(.+)$/.exec(base);
  if (m) return ok(m[1] === 'auto' ? t('zAuto') : t('z', { value: `${negative ? '-' : ''}${m[1]}` }));
  m = /^(duration|delay)-(\d+)$/.exec(base);
  if (m) return ok(t(m[1] === 'duration' ? 'duration' : 'delay', { value: m[2] }));
  // 边框宽度 / 边框色
  m = /^border(?:-([trblxyse]))?(?:-(.+))?$/.exec(base);
  if (m) {
    const v = m[2] ?? '';
    if (BORDER_W.includes(v)) { const value = v === '' ? 1 : v; return ok(m[1] ? t('border.widthSide', { side: t(`side.${SIDES.get(m[1])!}`), value }) : t('border.width', { value })); }
    if (!m[1]) return colorInfo('border', v, ctx);
  }
  m = /^ring(?:-(.+))?$/.exec(base);
  if (m) { const v = m[1] ?? ''; if (RING_W.includes(v)) return ok(t('ring', { value: v === '' ? 3 : v })); if (/^offset-\d+$/.test(v)) return ok(t('ringOffset', { value: v.slice(7) })); }
  m = /^outline-(\d+)$/.exec(base);
  if (m) return ok(t('outline', { value: m[1] }));
  m = /^outline-offset-(\d+)$/.exec(base);
  if (m) return ok(t('outlineOffset', { value: m[1] }));
  // 网格
  m = /^grid-cols-(\d+)$/.exec(base);
  if (m) return ok(t('gridCols', { value: m[1] }));
  m = /^grid-rows-(\d+)$/.exec(base);
  if (m) return ok(t('gridRows', { value: m[1] }));
  m = /^(col|row)-span-(\d+)$/.exec(base);
  if (m) return ok(t(m[1] === 'col' ? 'colSpan' : 'rowSpan', { count: Number(m[2]) }));
  m = /^(col|row)-start-(\d+)$/.exec(base);
  if (m) return ok(t(m[1] === 'col' ? 'colStart' : 'rowStart', { value: m[2] }));
  // 变换 / 滤镜
  m = /^rotate-(\d+)$/.exec(base);
  if (m) return ok(t('rotate', { value: `${negative ? '-' : ''}${m[1]}` }));
  m = /^scale-(\d+)$/.exec(base);
  if (m) return ok(t('scale', { value: m[1] }));
  m = /^(backdrop-)?blur(?:-(.+))?$/.exec(base);
  if (m) return ok(m[2] ? t(m[1] ? 'backdropBlurValue' : 'blurValue', { value: m[2] }) : t(m[1] ? 'backdropBlur' : 'blur'));
  // 最大宽度的命名档
  m = /^max-w-(.+)$/.exec(base);
  if (m) { const w = opt(MAX_W, m[1]); if (w) return ok(t('maxWidth', { value: w })); if (m[1] === 'prose') return ok(t('maxWidthProse')); const v = sizeValue('max-w', m[1], false); if (v) return ok(t('maxWidth', { value: v })); }
  // 间距 / 尺寸
  for (const [prefix, key] of SIZED) {
    if (!base.startsWith(`${prefix}-`)) continue;
    const v = sizeValue(prefix, base.slice(prefix.length + 1), negative);
    if (v) return ok(t(`sized.${key}`, { value: v }));
  }
  // 其余带颜色的前缀
  for (const key of COLOR_PREFIX) {
    const prefix = classOf(key);
    if (base.startsWith(`${prefix}-`)) return colorInfo(key, base.slice(prefix.length + 1), ctx);
  }
  return { text: t('unknown'), known: false };
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
    [/^shadow(?:-(none|sm|md|lg|xl|2xl))?$/, 'shadow', [...SHADOW]],
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
    const side = parts[0] && SIDES.has(parts[0]) ? parts.shift()! : '';
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
