import { z } from 'zod';

// 端与状态（REQ-CORE-049、REQ-CORE-051，ADR-040、ADR-041；API-CORE-054、API-CORE-016 状态条目）。
// 端上定义一组维度（每个维度几个取值、一个缺省）与事件，屏的 HTML 用 data-when / data-s-* 写好各取值下显示什么；
// 只属于一页的状态写在屏里的 <script type="application/json" data-quilt-states> 声明块。纯函数，前后端共用
export const MAX_SURFACES = 6;
export const MAX_SURFACE_DIMS = 6;
export const MAX_SURFACE_EVENTS = 6;
export const MAX_PAGE_DIMS = 4;
export const MAX_PAGE_EVENTS = 4;
export const MIN_DIM_VALUES = 2;
export const MAX_DIM_VALUES = 8;
export const EVENT_MS = { min: 500, max: 10_000, default: 2500 } as const;
export const STATE_KEY_RE = /^[a-z][a-z0-9-]{0,23}$/;

const keySchema = z.string().regex(STATE_KEY_RE, '键只能是小写字母开头的字母、数字与连字符，最长 24 个');
const nameSchema = z.string().trim().min(1).max(20);
export const surfaceNameSchema = z.string().trim().min(1).max(20);
export const groupNameSchema = z.string().trim().min(1).max(20);

const valueSchema = z.object({ key: keySchema, name: nameSchema });
const dimSchema = z.object({
  key: keySchema, name: nameSchema, values: z.array(valueSchema).min(MIN_DIM_VALUES).max(MAX_DIM_VALUES), default: keySchema,
  // 删掉的维度只标 retired（ADR-041）：右栏不再显示，运行时仍按它原来的缺省取值算
  retired: z.boolean().optional(),
}).refine((d) => d.values.some((v) => v.key === d.default), { path: ['default'], message: '缺省取值要是这个维度的取值之一' })
  .refine((d) => new Set(d.values.map((v) => v.key)).size === d.values.length, { path: ['values'], message: '取值的键重复了' });
const eventSchema = z.object({ key: keySchema, name: nameSchema, ms: z.number().int().min(EVENT_MS.min).max(EVENT_MS.max).optional() });
export type StateValue = z.infer<typeof valueSchema>;
export type StateDim = z.infer<typeof dimSchema>;
export type StateEvent = z.infer<typeof eventSchema>;
export type SurfaceStates = { dims: StateDim[]; events: StateEvent[] };
export const EMPTY_STATES: SurfaceStates = { dims: [], events: [] };

const statesSchema = (maxDims: number, maxEvents: number) => z.object({ dims: z.array(dimSchema).max(maxDims * 4), events: z.array(eventSchema).max(maxEvents) })
  .refine((s) => s.dims.filter((d) => !d.retired).length <= maxDims, { path: ['dims'], message: `至多 ${maxDims} 个维度` })
  .refine((s) => new Set(s.dims.map((d) => d.key)).size === s.dims.length, { path: ['dims'], message: '维度的键重复了' })
  .refine((s) => new Set(s.events.map((e) => e.key)).size === s.events.length, { path: ['events'], message: '事件的键重复了' });
/** 端上的维度与事件（字段 surfaces.states） */
export const surfaceStatesSchema = statesSchema(MAX_SURFACE_DIMS, MAX_SURFACE_EVENTS);
/** 屏里声明块的形状同端上的，上限更小 */
export const pageStatesSchema = statesSchema(MAX_PAGE_DIMS, MAX_PAGE_EVENTS);

// 改端时提交的维度（API-CORE-054）：新加的维度、取值、事件可以不带键，由服务端从名字转出（assignStateKeys）
const valueInput = z.object({ key: keySchema.optional(), name: nameSchema });
const dimInput = z.object({ key: keySchema.optional(), name: nameSchema, values: z.array(valueInput).min(MIN_DIM_VALUES).max(MAX_DIM_VALUES), default: z.union([keySchema, z.number().int().min(0)]).optional() });
const eventInput = z.object({ key: keySchema.optional(), name: nameSchema, ms: z.number().int().min(EVENT_MS.min).max(EVENT_MS.max).optional() });
export const surfaceStatesInputSchema = z.object({ dims: z.array(dimInput).max(MAX_SURFACE_DIMS), events: z.array(eventInput).max(MAX_SURFACE_EVENTS) });
export type SurfaceStatesInput = z.infer<typeof surfaceStatesInputSchema>;

/** 名字转键：先去变音符号转 kebab-case，转不出以字母开头的 ASCII 时用 prefix + 序号（d1、v1、e1），与 taken 撞了加序号 */
export function stateKeyFrom(name: string, taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  if (slug && !used.has(slug)) return slug;
  const base = slug || prefix;
  for (let n = slug ? 2 : 1; ; n++) if (!used.has(`${base}${slug ? '-' : ''}${n}`)) return `${base}${slug ? '-' : ''}${n}`;
}

/** 提交的维度落成端上的一份：补上缺的键（已有的键不变）；缺省给的是序号时取那个取值；上一份里有、这次没提交的维度标 retired 留着（ADR-041） */
export function assignStateKeys(input: SurfaceStatesInput, previous: SurfaceStates): SurfaceStates {
  const dimKeys = new Set([...previous.dims.map((d) => d.key), ...input.dims.flatMap((d) => (d.key ? [d.key] : []))]);
  const dims: StateDim[] = input.dims.map((d) => {
    const key = d.key ?? stateKeyFrom(d.name, dimKeys, 'd');
    dimKeys.add(key);
    const valueKeys = new Set(d.values.flatMap((v) => (v.key ? [v.key] : [])));
    const values = d.values.map((v) => {
      const k = v.key ?? stateKeyFrom(v.name, valueKeys, 'v');
      valueKeys.add(k);
      return { key: k, name: v.name };
    });
    const def = typeof d.default === 'number' ? values[d.default]?.key : d.default;
    return { key, name: d.name, values, default: def ?? values[0].key };
  });
  const sent = new Set(dims.map((d) => d.key));
  for (const old of previous.dims) if (!sent.has(old.key)) dims.push({ ...old, retired: true });
  const eventKeys = new Set([...previous.events.map((e) => e.key), ...input.events.flatMap((e) => (e.key ? [e.key] : []))]);
  const events = input.events.map((e) => {
    const key = e.key ?? stateKeyFrom(e.name, eventKeys, 'e');
    eventKeys.add(key);
    return { key, name: e.name, ...(e.ms !== undefined ? { ms: e.ms } : {}) };
  });
  return { dims, events };
}

/** 一版修订里的页内状态（字段 screen_revisions.states）：声明块里的维度与事件，加上这一版用 data-when / data-s-* 写到了哪些维度的哪些取值 */
export type RevisionStates = SurfaceStates & { uses: Record<string, string[]> };

const DECL_RE = /<script\b[^>]*\bdata-quilt-states\b[^>]*>([\s\S]*?)<\/script\s*>/i;
const WHEN_RE = /\bdata-when\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ATTR_RE = /data-s-([a-z][a-z0-9-]{0,23})\s*(?:\^|~|\||\*|\$)?=\s*\\?["']?([a-z][a-z0-9-]{0,23})/g;

/** data-when 的一段：dim:v1|v2 是维度取其中之一；@event 是事件播放中。空格分开的几段要同时成立 */
export type WhenPart = { dim: string; values: string[] } | { event: string };
export function whenParts(expr: string): WhenPart[] {
  return expr.trim().split(/\s+/).filter(Boolean).flatMap((part): WhenPart[] => {
    if (part.startsWith('@')) return part.length > 1 ? [{ event: part.slice(1) }] : [];
    const at = part.indexOf(':');
    if (at < 1) return [];
    return [{ dim: part.slice(0, at), values: part.slice(at + 1).split('|').filter(Boolean) }];
  });
}

/** 落修订时解析页内状态（ADR-041）：只看 body——运行时在 head 里，不会被当成屏的写法。声明块不合规时当没有 */
export function parseStates(body: string): RevisionStates {
  const decl = DECL_RE.exec(body)?.[1];
  let declared: SurfaceStates = EMPTY_STATES;
  if (decl) {
    try {
      const parsed = pageStatesSchema.safeParse(JSON.parse(decl));
      if (parsed.success) declared = parsed.data;
    } catch { /* 不是 JSON：当没有声明块 */ }
  }
  const uses: Record<string, Set<string>> = {};
  const add = (dim: string, value: string) => (uses[dim] ??= new Set()).add(value);
  for (const m of body.matchAll(WHEN_RE)) for (const p of whenParts(m[1] ?? m[2] ?? '')) if ('dim' in p) p.values.forEach((v) => add(p.dim, v));
  for (const m of body.matchAll(ATTR_RE)) add(m[1], m[2]);
  return { dims: declared.dims, events: declared.events, uses: Object.fromEntries(Object.entries(uses).map(([k, v]) => [k, [...v].sort()])) };
}

/** 页内状态里与端上维度或事件重名的键（API-CORE-016：页内那个不生效，偏离报告记一条） */
export function shadowedStateKeys(page: SurfaceStates, surface: SurfaceStates): string[] {
  const taken = new Set([...surface.dims.map((d) => d.key), ...surface.events.map((e) => e.key)]);
  return [...page.dims.map((d) => d.key), ...page.events.map((e) => e.key)].filter((k) => taken.has(k));
}

/** 这一屏没写到的取值（ADR-041）：维度的非缺省取值里不在 uses 里的；一个都没写过这个维度时 written 为 false */
export function missingValues(dim: StateDim, uses: Record<string, string[]> | null | undefined): { written: boolean; missing: string[] } {
  const got = uses?.[dim.key] ?? [];
  return { written: got.length > 0, missing: dim.values.map((v) => v.key).filter((k) => k !== dim.default && !got.includes(k)) };
}

// 下发与截图时把端上的维度交给运行时（API-CORE-016）：head 里放一个 JSON 块，运行时按它取缺省值。屏的 HTML 里不存它——端上的维度会变
export function withSurfaceStates(html: string, states: SurfaceStates | null | undefined): string {
  if (!states || (!states.dims.length && !states.events.length)) return html;
  const block = `<script type="application/json" data-quilt-surface-states>${JSON.stringify(states).replace(/</g, '\\u003c')}</script>`;
  const at = html.indexOf('</head>');
  return at < 0 ? `${block}${html}` : `${html.slice(0, at)}${block}${html.slice(at)}`;
}
