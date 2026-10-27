import { z } from 'zod';
import { DEVICE_TYPES, PRESENTATIONS, type Presentation } from './device.ts';
import { TOKEN_COLOR_KEYS } from './tokens.ts';
import { COMPONENT_NAME_RE, MAX_COMPONENT_HTML_BYTES } from './component-meta.ts';
import { ROUND_PRESETS } from './contract.ts';
import { localeSchema } from './i18n.ts';
import { surfaceNameSchema, groupNameSchema, surfaceStatesInputSchema, type SurfaceStates, type RevisionStates } from './states.ts';

// 契约 schema（§8 / §9 / §24）：服务端校验与前端类型的唯一出处。
// v0.31：三种 generate 合一（整组 / 单屏 / 懒生成都是 `generate`）；历史行里的旧 kind 只读保留
// propose_states（REQ-CORE-051）：按这一端的屏建议维度与事件，只产出提案（output.proposal），由用户勾选后经 API-CORE-054 保存
export const JOB_KINDS = ['generate', 'edit_screens', 'regenerate_subtree', 'apply_design_system', 'propose_design_system', 'export_prototype', 'ingest_screen', 'chat', 'edit_component', 'propose_states'] as const;
// 一次「造」最多几张不同的屏（屏数档位 1–4 / auto）与同一屏最多几版候选（REQ-CORE-003 / REQ-CORE-015）
export const MAX_SCREENS_PER_GENERATE = 4;
export const MAX_VERSIONS = 4;
export const SCREEN_COUNT_OPTIONS = [1, 2, 3, 4, 'auto'] as const;
export type ScreenCount = (typeof SCREEN_COUNT_OPTIONS)[number];
// 作业执行者（ADR-015）：model = worker 跑云端 / 自建通道；agent = 投递到本机 Claude Code 会话
export const JOB_RUNNERS = ['model', 'agent'] as const;
export type JobRunner = (typeof JOB_RUNNERS)[number];
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ERROR_CLASSES = ['provider', 'lint', 'timeout', 'validation', 'system', 'agent'] as const;
// component（v0.46）：共享组件提取 / 同步 / 改组件后的确定性回刷（REQ-EDIT-006）；sketch：草稿写回项目（API-CORE-047）；fork：从屏建草稿的第一版（API-CORE-048）
export const SOURCE_KINDS = ['generate', 'edit', 'subtree', 'manual', 'restore', 'apply_ds', 'agent_ingest', 'component', 'sketch', 'fork'] as const;

// 草稿本（REQ-CORE-040 / ADR-030）：一个 kind=sketchbook 的项目，草稿是它的屏。画框 = 草稿在看板上怎么摆：
// component 按根元素自身大小居中，mobile / desktop 给对应视口；auto 只出现在请求里，由模型在根元素的 data-frame 上声明
export const PROJECT_KINDS = ['app', 'sketchbook'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const DRAFT_FRAMES = ['component', 'mobile', 'desktop'] as const;
export type DraftFrame = (typeof DRAFT_FRAMES)[number];
export const DRAFT_FRAME_CHOICES = ['auto', ...DRAFT_FRAMES] as const;
export type DraftFrameChoice = (typeof DRAFT_FRAME_CHOICES)[number];
/** 新草稿的名字：这句话的第一行、前 20 个字（API-CORE-010 草稿本规则） */
export function draftNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0].trim();
  const chars = Array.from(line);
  return (chars.length > 20 ? chars.slice(0, 20).join('') : line) || '草稿';
}
/** 从屏拿来的草稿名（API-CORE-048）：来源屏名；只带一块时接「 · 」与那一块可见文字的前 10 个字 */
export function forkDraftName(screenName: string, blockText?: string): string {
  const head = Array.from(blockText?.trim() ?? '').slice(0, 10).join('').trimEnd();
  return head ? `${screenName} · ${head}` : screenName;
}
export const JOB_EVENT_TYPES = ['screen_planned', 'screen_html_ready', 'screen_screenshot_ready', 'progress', 'succeeded', 'failed', 'cancelled'] as const;

export const deviceTypeSchema = z.enum(DEVICE_TYPES);
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #3B5BDB');
export const routeSchema = z.string().regex(/^\/[a-z0-9-]*(\/[a-z0-9-]+)*$/, 'route like /settings');

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  deviceType: deviceTypeSchema,
  seedColor: hexColorSchema.optional(),
  // 按设计预设开局（v0.40 `REQ-CORE-021`）：给了就用它初始化设计系统与素材，省掉「建完再套」
  presetId: z.uuid().optional(),
});

// runner 先于 jobInputSchemas 定义，供生成类作业带上「这一轮由谁来做」（REQ-CORE-011）
export const LLM_DRIVERS = ['agent-sdk', 'codex', 'anthropic', 'gemini', 'openai', 'stub'] as const;
export const AGENT_TOOLS = ['claude-code', 'codex'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export const runnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), driver: z.enum(LLM_DRIVERS), model: z.string().trim().min(1).max(80) }),
  // 本机 agent（REQ-AGENT-003 v0.34）：投递到本机某个 Claude Code 会话（sessionId = 登记处里的会话 UUID）或 Codex 线程（v0.68，sessionId = 线程 UUID）
  z.object({ kind: z.literal('agent'), tool: z.enum(AGENT_TOOLS), sessionId: z.uuid() }),
  // 账号自建通道（REQ-CORE-013）：作业里只记 id，凭据由 worker 运行时解密——换 Key 不必重发作业
  z.object({ kind: z.literal('channel'), channelId: z.uuid() }),
]);
export type Runner = z.infer<typeof runnerSchema>;

// ---- 参考图（REQ-CORE-012 / API-CORE-019）----
// 只收位图三种：模型视觉输入普遍支持这三类，SVG 是可执行文档、不进这条路。
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const createAttachmentSchema = z.object({
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  bytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
});
export type AttachmentDto = { id: string; mediaType: string; bytes: number; url: string };

const coord = z.number().int().min(-1_000_000).max(1_000_000);
export const anchorSchema = z.object({ x: coord, y: coord });
const screenCountSchema = z.union([z.number().int().min(1).max(MAX_SCREENS_PER_GENERATE), z.literal('auto')]);
const versionsSchema = z.number().int().min(1).max(MAX_VERSIONS);
// 共享组件（REQ-EDIT-006）：造 / 改时框选的组件，完整 HTML 进上下文；一次最多带 10 个
export const MAX_COMPONENT_TARGETS = 10;
const componentIdsSchema = z.array(z.uuid()).max(MAX_COMPONENT_TARGETS).optional();

export const variantNameSchema = z.string().trim().min(1).max(20);
// 界面语言（REQ-CORE-046）：写屏上文字的四种作业可带，建作业时服务端按请求的 X-Quilt-Locale 填（不看请求体），提示词据此补一句语言要求
const jobLocaleSchema = localeSchema.optional();
// 选元素时按住 Shift 多选（REQ-EDIT-002 v1.26）：同一屏或同一张组件卡里最多 8 块
export const MAX_SUBTREE_BLOCKS = 8;
const qidSchema = z.string().regex(/^q\d+$/);
export const jobInputSchemas = {
  // 造（REQ-CORE-003 / REQ-CORE-014 / REQ-PROTO-003）：count 是屏数档位（1 单屏规划、2–4 与 auto 整组规划）；
  // versions 是每张新屏的候选版数；anchor 是画布世界坐标；route 钉死即懒生成（跳过规划器，fromScreenId 作来源屏参考）
  generate: z.object({
    prompt: z.string().trim().min(1).max(8000),
    count: screenCountSchema.default(1),
    versions: versionsSchema.default(1),
    anchor: anchorSchema.optional(),
    route: routeSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    fromScreenId: z.uuid().optional(),
    runner: runnerSchema.optional(),
    imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    componentIds: componentIdsSchema,
    // 造变体（v0.62 REQ-CORE-025）：二者同给 = 钉死默认屏的路由、跳过规划器；呈现方式（v0.63）只在懒生成 / 造变体时生效，整组规划由规划器逐屏给
    variantOf: z.uuid().optional(),
    variantName: variantNameSchema.optional(),
    presentation: z.enum(PRESENTATIONS).optional(),
    // 画框（REQ-CORE-040）：只对草稿本的新草稿有效，其他项目带它由建作业校验拒掉
    frame: z.enum(DRAFT_FRAME_CHOICES).optional(),
    // 参照项目（REQ-CORE-042）：新草稿从第一版起就参照它，同样只对草稿本的新草稿有效
    refProjectId: z.uuid().optional(),
    // 端（REQ-CORE-049）：新屏落在哪一端，缺省第一端；group 是给新屏的分组（REQ-CORE-050），整组规划时规划器逐屏给、这里给了就都用它
    surfaceId: z.uuid().optional(),
    group: groupNameSchema.optional(),
    locale: jobLocaleSchema,
  }).refine((v) => !!v.variantOf === !!v.variantName, { path: ['variantName'], message: 'variantOf 与 variantName 要一起给' }),
  edit_screens: z.object({ prompt: z.string().trim().min(1).max(8000), screenIds: z.array(z.uuid()).min(1).max(20), versions: versionsSchema.default(1), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(), componentIds: componentIdsSchema, locale: jobLocaleSchema }),
  // 改共享组件（REQ-EDIT-006）：一次一个；成功后所有用到它的屏确定性回刷（零 LLM）
  edit_component: z.object({ componentId: z.uuid(), prompt: z.string().trim().min(1).max(8000), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(), locale: jobLocaleSchema }),
  // 子树重生成（REQ-EDIT-002）：runner 可单独选（检查器里有自己的通道 / 会话选择器，记忆独立于输入框）；草稿里只改一块时可带参考图（REQ-CORE-045）。
  // qids（v1.26）：按住 Shift 选的几块一次改完，要含 qid、不重复；互不包含要看那一版的 HTML，由建作业时查
  regenerate_subtree: z.object({
    screenId: z.uuid(), qid: qidSchema,
    qids: z.array(qidSchema).min(2).max(MAX_SUBTREE_BLOCKS).refine((a) => new Set(a).size === a.length, 'qids 里有重复的块').optional(),
    prompt: z.string().trim().min(1).max(4000), expectedRevisionId: z.uuid(), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(), locale: jobLocaleSchema,
  }).refine((v) => !v.qids || v.qids.includes(v.qid), { path: ['qids'], message: 'qids 要含 qid' }),
  apply_design_system: z.object({ screenIds: z.union([z.literal('all'), z.array(z.uuid()).min(1)]) }),
  // 设计系统提炼（REQ-EDIT-003）：只产出提案（output.proposal），写入由 API-EDIT-002 在预览确认后完成
  propose_design_system: z.object({ instruction: z.string().trim().min(1).max(4000), screenId: z.uuid().optional(), runner: runnerSchema.optional() }),
  // 端（REQ-CORE-049）：只导出这一端的屏，缺省第一端
  export_prototype: z.object({ surfaceId: z.uuid().optional() }),
  ingest_screen: z.object({ name: z.string().trim().min(1).max(80), route: routeSchema, html: z.string().min(1), screenId: z.uuid().optional(), expectedRevisionId: z.uuid().optional() }),
  // 聊天（REQ-CORE-023 v0.45）：screenIds 是「用户此刻选中的屏」这一条上下文提示，不是目标锁——助手自己定范围
  chat: z.object({ prompt: z.string().trim().min(1).max(8000), screenIds: z.array(z.uuid()).max(20).optional(), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() }),
  propose_states: z.object({ surfaceId: z.uuid(), runner: runnerSchema.optional(), locale: jobLocaleSchema }),
} as const;

// 作业输入按种类的类型（CH-2 v1.06）：读点用 inputOf(job, kind) 取，schema 加字段、改字段时 tsc 能指出每个读点
export type JobInputOf<K extends keyof typeof jobInputSchemas> = z.output<(typeof jobInputSchemas)[K]>;
// 不分种类读输入时的形状（前端按 kind 反推覆盖屏集、作业行文案）：每个字段取它在各种类里类型的并集，全部可选
type JobInputUnion = { [K in keyof typeof jobInputSchemas]: JobInputOf<K> }[keyof typeof jobInputSchemas];
// 有的种类输入带字符串索引签名（keyof 是整个 string），按具名字段取，不然具体字段名会被吞掉
type KeysOf<T> = T extends unknown ? keyof { [K in keyof T as string extends K ? never : K]: T[K] } : never;
type FieldOf<T, F extends PropertyKey> = T extends unknown ? (F extends keyof T ? T[F] : never) : never;
export type AnyJobInput = { [F in KeysOf<JobInputUnion>]?: FieldOf<JobInputUnion, F> };
export function inputOf<K extends keyof typeof jobInputSchemas>(job: { kind: string; input: unknown }, kind: K): JobInputOf<K> {
  if (job.kind !== kind) throw new Error(`作业种类是 ${job.kind}，不是 ${kind}`);
  return job.input as JobInputOf<K>;
}
export const createJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generate'), input: jobInputSchemas.generate }),
  z.object({ kind: z.literal('edit_screens'), input: jobInputSchemas.edit_screens }),
  z.object({ kind: z.literal('regenerate_subtree'), input: jobInputSchemas.regenerate_subtree }),
  z.object({ kind: z.literal('apply_design_system'), input: jobInputSchemas.apply_design_system }),
  z.object({ kind: z.literal('propose_design_system'), input: jobInputSchemas.propose_design_system }),
  z.object({ kind: z.literal('export_prototype'), input: jobInputSchemas.export_prototype }),
  z.object({ kind: z.literal('ingest_screen'), input: jobInputSchemas.ingest_screen }),
  z.object({ kind: z.literal('chat'), input: jobInputSchemas.chat }),
  z.object({ kind: z.literal('edit_component'), input: jobInputSchemas.edit_component }),
  z.object({ kind: z.literal('propose_states'), input: jobInputSchemas.propose_states }),
]);
export type CreateJobInput = z.infer<typeof createJobSchema>;
// 建作业请求（API-CORE-006）：作业之外可带参考图 id，服务端解析成 input.imageKeys
export const createJobRequestSchema = createJobSchema.and(z.object({ attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() }));

// 用量预估（REQ-CORE-008）：发送前、建作业、「按新约定重生成」确认三处共用这一个函数。
// 每屏每版一次模型调用（v0.43 起没有修复轮）；造屏另有规划 1 次、入口屏补链至多 1 次——钉死路由的懒生成不规划、
// 有来源屏时仍补链，造变体两样都没有。apply_design_system / export 是确定性的，不占调用。
export function estimateJob(input: CreateJobInput, allScreens: number): { calls: number; screens: number } {
  switch (input.kind) {
    case 'generate': {
      const pinned = !!input.input.route || !!input.input.variantOf;
      const n = pinned ? 1 : input.input.count === 'auto' ? 5 : input.input.count;
      const screens = n * input.input.versions;
      return { calls: screens + (input.input.variantOf ? 0 : input.input.route ? 1 : 2), screens };
    }
    case 'edit_screens': { const screens = input.input.screenIds.length * input.input.versions; return { calls: screens, screens }; }
    case 'regenerate_subtree': return { calls: 1, screens: 1 };
    case 'propose_design_system': return { calls: 1, screens: 0 };
    // 聊天一轮是 3–8 次工具调用外加模型往返，按上限估：超时 3 + 8 分钟
    case 'chat': return { calls: 8, screens: 0 };
    // 改组件只有一次模型调用；之后的回刷是确定性的，不占调用
    case 'edit_component': return { calls: 1, screens: 0 };
    case 'propose_states': return { calls: 1, screens: 0 };
    case 'apply_design_system': return { calls: 0, screens: 0 };
    default: void allScreens; return { calls: 0, screens: 0 };
  }
}

export const createMessageSchema = z.object({
  // 正文只在带「修改」还原的隐藏参数时可空（见下）
  content: z.string().trim().max(8000),
  // 聊天（REQ-CORE-023 v0.45）：mode="chat" 时不看目标，targetScreenIds 转成上下文提示，count / versions / anchor 忽略
  mode: z.enum(['chat']).optional(),
  targetScreenIds: z.array(z.uuid()).max(20).optional(),
  // 共享组件目标（REQ-EDIT-006）：只有组件没有屏 = 改这个组件（恰好 1 个）；与屏 / 锚点同在 = 它们的完整 HTML 进上下文
  targetComponentIds: componentIdsSchema,
  // 造 / 改共用的档位（REQ-CORE-003 / REQ-CORE-006）：有目标时 count 忽略
  count: screenCountSchema.optional(),
  versions: versionsSchema.optional(),
  anchor: anchorSchema.optional(),
  runner: runnerSchema.optional(),
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  // 「修改」还原的隐藏参数（REQ-CORE-026 v0.74）：出变体 / 补缺失页是钉死路由的造，补链 / 按新约定重生成是改、提示词由服务端拼。
  // 带了它们时 content 可空；写了字，变体就是它的提示词，其余作为附加要求接在固定提示词之后
  variantOf: z.uuid().optional(),
  variantName: variantNameSchema.optional(),
  route: routeSchema.optional(),
  fromScreenId: z.uuid().optional(),
  preset: z.enum(ROUND_PRESETS).optional(),
  // 画框（REQ-CORE-040）：只对草稿本的新草稿有效
  frame: z.enum(DRAFT_FRAME_CHOICES).optional(),
  // 参照项目（REQ-CORE-042）：只对草稿本的新草稿有效；改稿的参照在草稿上设（API-CORE-012）
  refProjectId: z.uuid().optional(),
  // 端（REQ-CORE-049）：造屏时新屏落在哪一端，透传给 generate；草稿本里带它由草稿本规则拒掉
  surfaceId: z.uuid().optional(),
}).refine((v) => !!v.variantOf === !!v.variantName, { path: ['variantName'], message: 'variantOf 与 variantName 要一起给' })
  .refine((v) => v.content.length > 0 || (v.mode !== 'chat' && !!(v.variantOf || v.route || v.preset)), { path: ['content'], message: '先写点什么' });
// 重试一轮（REQ-CORE-026 v0.72 / API-CORE-034）：只换通道，其余照原作业
export const retryMessageSchema = z.object({ runner: runnerSchema.optional() });

// 项目级持久记忆（REQ-CORE-016 / API-CORE-027）
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  brief: z.string().max(2000).optional(),
  exemplarScreenId: z.uuid().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');
// 候选整组采用（API-CORE-025）
export const adoptGroupSchema = z.object({ index: z.number().int().min(0).max(MAX_VERSIONS - 1) });

export const updateScreenSchema = z.object({
  x: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  y: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  route: routeSchema.optional(),
  // 变体名只对变体有效、route 只对默认屏有效（v0.62）；呈现方式是元数据、改了不重烤修订（v0.63）——三条规则在路由层判
  variantName: variantNameSchema.optional(),
  presentation: z.enum(PRESENTATIONS).optional(),
  // 画框只对草稿有效（REQ-CORE-040），元数据、改了不建修订、截图重拍
  frame: z.enum(DRAFT_FRAMES).optional(),
  // 参照项目只对草稿有效（REQ-CORE-042 / ADR-033）：本人的普通项目，null 回到自由风格；元数据，从下一轮起生效
  refProjectId: z.uuid().nullable().optional(),
  // 分组（REQ-CORE-050）：元数据，不建修订；null = 未分组。变体的分组跟默认屏，在路由层判
  group: groupNameSchema.nullable().optional(),
  // 屏不能换端（API-CORE-012）：要换就删了重造，或从草稿本搬
  surfaceId: z.never({ error: '屏不能换端：删了重造，或从草稿本搬进来' }).optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');

// 端（REQ-CORE-049 / API-CORE-054）：设备建好不能改；states 整份替换，删掉的维度由服务端标 retired 留着
export const createSurfaceSchema = z.object({ name: surfaceNameSchema, deviceType: deviceTypeSchema });
export const updateSurfaceSchema = z.object({
  name: surfaceNameSchema.optional(),
  states: surfaceStatesInputSchema.optional(),
  deviceType: z.never({ error: '端的设备建好不能改' }).optional(),
  expectedVersion: z.number().int().min(1),
}).refine((v) => v.name !== undefined || v.states !== undefined, 'empty patch');
export type SurfaceDto = { id: string; projectId: string; name: string; deviceType: (typeof DEVICE_TYPES)[number]; position: number; states: SurfaceStates; version: number };
/** propose_states 作业的产出（output.proposal）：建议的维度与事件，不落库 */
export type StatesProposalDto = { summary: string; dims: { name: string; values: string[] }[]; events: { name: string; ms?: number }[] };

// 草稿搬进项目（REQ-CORE-052 / API-CORE-055）：每张只搬当前这一版，页面草稿成这一端的屏、组件草稿成共享组件，之后草稿删掉
export const MAX_MOVE_DRAFTS = 20;
export const moveDraftsSchema = z.object({
  draftIds: z.array(z.uuid()).min(1).max(MAX_MOVE_DRAFTS).refine((a) => new Set(a).size === a.length, '草稿重复了'),
  projectId: z.uuid(),
  surfaceId: z.uuid(),
  group: groupNameSchema.optional(),
  restyle: z.boolean().optional(),
  runner: runnerSchema.optional(),
});
export type MoveDraftsInput = z.infer<typeof moveDraftsSchema>;
// 草稿落进项目时的名字（API-CORE-047 / API-CORE-055；搬进项目的弹层按同一套规则预先写出来）。
// 放成屏的路由：名字转 kebab-case（先去掉变音符号），全是中文这类转不出来的用 /screen；在这一端内去重
export function draftRoute(name: string, taken: string[]): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const base = `/${slug || 'screen'}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let k = 2;
  while (used.has(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}
// 组件名：只留组件名允许的字符（字母、数字、空格、下划线、连字符），转不出来的叫 Component；与项目里已有的撞了（不分大小写）加序号
export function draftComponentName(name: string, taken: string[]): string {
  const base = Array.from(name.replace(/[^\p{L}\p{N} _-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').trim()).slice(0, 37).join('').trim() || 'Component';
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let k = 2;
  while (used.has(`${base} ${k}`.toLowerCase())) k++;
  return `${base} ${k}`;
}

// 草稿写回项目（REQ-CORE-041 / REQ-CORE-044，API-CORE-047）：screen / component 是一次性快照，restyle 时再发一次按设计系统改写的作业；
// overwrite 把草稿原样写成目标屏 screenId 的一条新修订，带 qid 只换那一块（ADR-032）。restyle 不给时由服务端按草稿的参照项目定
export const copyDraftSchema = z.object({
  projectId: z.uuid(),
  as: z.enum(['screen', 'component', 'overwrite']),
  screenId: z.uuid().optional(),
  qid: z.string().regex(/^q\d+$/).optional(),
  expectedRevisionId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  restyle: z.boolean().optional(),
  runner: runnerSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.as !== 'overwrite') return;
  if (!v.screenId) ctx.addIssue({ code: 'custom', path: ['screenId'], message: '覆盖要给目标屏' });
  if (!v.expectedRevisionId) ctx.addIssue({ code: 'custom', path: ['expectedRevisionId'], message: '覆盖要给目标屏确认时的当前修订' });
  if (v.restyle) ctx.addIssue({ code: 'custom', path: ['restyle'], message: '覆盖原样写入，不改写' });
});
export type CopyDraftInput = z.infer<typeof copyDraftSchema>;
// 从屏建草稿（REQ-CORE-043 / API-CORE-048）：整屏或其中一块（qid）
export const createDraftSchema = z.object({ fromScreenId: z.uuid(), qid: z.string().regex(/^q\d+$/).optional() });
export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export const restoreRevisionSchema = z.object({ expectedRevisionId: z.uuid() });

export const elementOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().max(4000) }),
  z.object({ type: z.literal('classes'), value: z.string().max(2000) }),
  z.object({ type: z.literal('style'), value: z.string().max(2000) }),
  z.object({ type: z.literal('link'), value: z.string().max(200).nullable() }),
  z.object({ type: z.literal('remove') }),
  // 脱离共享（REQ-EDIT-006）：唯一允许落在共享组件实例上的直改
  z.object({ type: z.literal('detach') }),
]);
// 直改的一条操作（API-EDIT-001）：前端与服务端同一个类型，从 schema 推导
export type ElementOp = z.infer<typeof elementOpSchema>;
export const applyElementEditSchema = z.object({ ops: z.array(elementOpSchema).min(1).max(10), expectedRevisionId: z.uuid() });
// 组件里的元素直改（v0.57 `REQ-EDIT-006`）：组件不是屏，没有修订，乐观并发用组件版本号。
// detach 不收——「脱离共享」说的是把某一屏里的实例摘出来，对组件本体不成立。
export const componentElementOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().max(4000) }),
  z.object({ type: z.literal('classes'), value: z.string().max(2000) }),
  z.object({ type: z.literal('style'), value: z.string().max(2000) }),
  z.object({ type: z.literal('link'), value: z.string().max(200).nullable() }),
  z.object({ type: z.literal('remove') }),
]);
export const applyComponentElementEditSchema = z.object({ ops: z.array(componentElementOpSchema).min(1).max(10), expectedVersion: z.number().int().positive() });

// 字体候选（v0.44 起只是面板的候选提示，不再是白名单）：来源为 google 时任意 Google Fonts 族名都收
export const FONT_FAMILIES = ['Inter', 'Manrope', 'DM Sans', 'Roboto', 'Nunito', 'Space Grotesk', 'Archivo'] as const;
// 字体来源（v0.44 `REQ-EDIT-003`）：google = Google Fonts 族名；system = 本机字体，不发外链；url = 自带 @font-face 的样式表链接
export const FONT_SOURCES = ['google', 'system', 'url'] as const;
export type FontSource = (typeof FONT_SOURCES)[number];
// 族名会进 <link href>、CSS font-family 与 Tailwind 配置的 JS 字符串，所以不收引号、分号、尖括号、反斜杠
export const fontFamilySchema = z.string().trim().regex(/^-?[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u, '族名只能是字母、数字、空格与连字符');
export const fontUrlSchema = z.string().trim().max(500).regex(/^https:\/\/[^\s"'<>]+$/, '字体样式表必须是 https 链接');
// 品牌色板（v0.35 `REQ-EDIT-005`）：逐键覆盖种子派生值，亮 / 暗各一套，colorMode 选当前生效的那套
export const COLOR_MODES = ['light', 'dark'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
// partialRecord：色板是「逐键覆盖」，给一个键也合法；z.record 会要求 26 个键全给
export const paletteMapSchema = z.partialRecord(z.enum(TOKEN_COLOR_KEYS), hexColorSchema);
export const paletteSchema = z.object({ light: paletteMapSchema, dark: paletteMapSchema.optional() });
export type Palette = z.infer<typeof paletteSchema>;

// 项目素材（v0.35 `REQ-CORE-019`）：SVG 进得来——它是 logo 的原生格式，位图放大就糊
export const ASSET_MEDIA_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_ASSETS_PER_PROJECT = 50;
export type AssetDto = { id: string; name: string; mediaType: string; bytes: number; width: number; height: number; url: string; createdAt: string };

// 设计预设（v0.40 `REQ-CORE-021`）：存设计系统的**输入**而不是算好的 tokens——套用时按当时的引擎重算，
// 引擎补了新色键（如 v0.35 的语义色）老预设跟着受益
export const createPresetSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  includeAssets: z.boolean().optional(),
});
export const applyPresetSchema = z.object({ presetId: z.uuid(), expectedVersion: z.number().int().min(1) });
export type DesignPresetDto = {
  id: string; name: string; seedColor: string; fontFamily: string; fontSource: FontSource; fontUrl: string | null; radiusScale: 'sharp' | 'default' | 'round';
  palette: Palette | null; colorMode: ColorMode; designMd: string; assetCount: number; createdAt: string;
};

export const MAX_CONVENTIONS = 20;
export const updateDesignSystemSchema = z.object({
  seedColor: hexColorSchema.optional(),
  fontFamily: fontFamilySchema.optional(),
  fontSource: z.enum(FONT_SOURCES).optional(),
  fontUrl: fontUrlSchema.nullable().optional(),
  radiusScale: z.enum(['sharp', 'default', 'round']).optional(),
  designMd: z.string().max(20000).optional(),
  // 约定节整体替换（REQ-EDIT-003）：预览确认后的唯一写入口
  conventions: z.array(z.string().trim().min(1).max(300)).max(MAX_CONVENTIONS).optional(),
  // 品牌色板：给对象即整份替换，给 null 即清空回到纯种子派生（v0.35 `REQ-EDIT-005`）
  palette: paletteSchema.nullable().optional(),
  colorMode: z.enum(COLOR_MODES).optional(),
  expectedVersion: z.number().int().min(1),
});
/** propose_design_system 作业的产出（output.proposal） */
export type DesignProposalDto = {
  summary: string;
  conventions: string[];
  tokens?: { seedColor?: string; fontFamily?: (typeof FONT_FAMILIES)[number]; radiusScale?: 'sharp' | 'default' | 'round' };
  regenerate: boolean;
};

// ---- 共享组件（REQ-EDIT-006 / API-EDIT-004）----
export const componentNameSchema = z.string().trim().regex(COMPONENT_NAME_RE, '组件名只能是字母、数字、空格、下划线与连字符，最长 40 字');
export const createComponentSchema = z.union([
  // 直接给 HTML（MCP / 新建空组件）
  z.object({ name: componentNameSchema, html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES) }),
  // 从屏里提取（检查器「记为共享组件」）：applyToScreens 缺省 true = 其他屏里对应的元素也换成它
  z.object({ name: componentNameSchema, fromScreenId: z.uuid(), qid: z.string().regex(/^q\d+$/), applyToScreens: z.boolean().optional() }),
]);
export const updateComponentSchema = z.object({
  name: componentNameSchema.optional(),
  html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES).optional(),
  x: coord.optional(),
  y: coord.optional(),
  // 改 html / name 必带（乐观锁，409 version-conflict）；只挪位置不带
  expectedVersion: z.number().int().min(1).optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch')
  .refine((v) => (v.html === undefined && v.name === undefined) || v.expectedVersion !== undefined, { path: ['expectedVersion'], message: '改内容或改名要带 expectedVersion' });
export type ComponentDto = {
  id: string; projectId: string; name: string; summary: string; html: string; slots: string[];
  /** 提取时分出了激活 / 未激活两套类的导航型组件：展开时按屏路由标激活项 */
  nav: boolean;
  x: number; y: number; version: number;
  /** 画布上活渲染它的预览域地址（带版本，改完即换） */
  previewUrl: string;
  /** 当前修订里放着它的屏 */
  usedBy: string[];
  createdAt: string; updatedAt: string;
};

// cursor 是上一页的 nextCursor（ISO 时间）；别的字符串 new Date() 出来是 Invalid Date，序列化时 500（v0.77 起 400）
export const cursorQuerySchema = z.object({ cursor: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

// ---------- AGENT 域（v0.32：本地版无 OAuth、无派活任务；本机 agent 是被投递的 Claude Code 会话）----------
export const listJobsQuerySchema = z.object({ runner: z.enum(JOB_RUNNERS).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
/** 运行时配置（API-CORE-028）：前端启动时取一次 */
/** secretsConfigured（v0.78）：服务端配了 QUILT_SECRETS_KEY；为 false 时通道管理器提前说明、需要 API Key 的通道存不了 */
export type ConfigDto = { previewOrigin: string; version: string; local: true; home: string; secretsConfigured: boolean };

// 响应 DTO（前端据此生成类型）
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export type DesignSystemDto = { id: string; projectId: string; seedColor: string; tokens: unknown; palette: Palette | null; colorMode: ColorMode; designMd: string; components: unknown; version: number };
export type ScreenDto = {
  id: string; projectId: string; name: string; route: string; purpose: string; x: number; y: number; width: number; height: number;
  currentRevisionId: string | null; currentRevisionSeq: number | null; screenshotUrl: string | null; previewUrl: string | null; lintPassed: boolean | null; deviations: number;
  /** 截图缩到 1/4 的缩略图（v1.02 ADR-029）：画布全景下卡片用它；还没生成时为 null，卡片用 screenshotUrl */
  thumbUrl: string | null;
  /** 待采用的候选批（REQ-CORE-015）：current 所属批次未结清且有 ≥ 2 版 */
  pendingCandidates: { jobId: string; count: number } | null;
  /** 状态变体（v0.62）：variantOf 指向默认屏、variantName 是状态名；默认屏两者皆空 */
  variantOf: string | null; variantName: string | null;
  /** 呈现方式（v0.63）：overlay 屏播放时压在当前屏上 */
  presentation: Presentation;
  /** 画框（REQ-CORE-040）：只在草稿本的屏上有值，null = 非草稿或新草稿还没定 */
  frame: DraftFrame | null;
  /** 参照项目（REQ-CORE-042）与写回目标（REQ-CORE-044）：只在草稿上有值；targetQid 空 = 整屏 */
  refProjectId: string | null; targetScreenId: string | null; targetQid: string | null;
  /** 写回目标那一屏所在的项目与屏名（服务端派生）；没有写回目标或那一屏已被删时为 null */
  target: { projectId: string; projectName: string; screenName: string } | null;
  /** 所属端（REQ-CORE-049）：草稿为 null；group 是分组（REQ-CORE-050），null = 未分组 */
  surfaceId: string | null; group: string | null;
  /** 当前修订里的页内状态与写到的取值（ADR-041）；没有修订或旧修订为 null */
  states: RevisionStates | null;
  updatedAt: string;
};
export type LinkDto = { fromScreenId: string; qid: string; href: string; toScreenId: string | null };
/** 设置页配置、前端下拉直接渲染的可选通道清单（只含标识与显示名） */
// ---- 生成通道可配置（REQ-CORE-013 / API-CORE-020~023）----
// agent-sdk = 本机 Claude 订阅：复用服务端机器上的 `claude` 登录态；codex = 本机 Codex 订阅（v0.68 ADR-020）：复用 `codex` 的 ChatGPT 登录态。
// 两者都没有 Key 也没有端点，只需要选模型（REQ-CORE-013）
export const CHANNEL_KINDS = ['anthropic', 'gemini', 'openai', 'agent-sdk', 'codex'] as const;
/** 用本机登录态、不收 Key 的通道类型 */
export const LOCAL_CHANNEL_KINDS: readonly ChannelKind[] = ['agent-sdk', 'codex'];
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_VENDORS = ['anthropic', 'claude-subscription', 'codex-subscription', 'google', 'openai', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'openrouter', 'ollama', 'siliconflow', 'custom'] as const;
export type ChannelVendor = (typeof CHANNEL_VENDORS)[number];
export const CHANNEL_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
/** 厂商预设：只决定默认端点与图标，模型名由用户填（型号更新太快，不预填） */
export const VENDOR_PRESETS: Record<ChannelVendor, { label: string; kind: ChannelKind; endpoint: string }> = {
  anthropic: { label: 'Anthropic', kind: 'anthropic', endpoint: 'https://api.anthropic.com' },
  'claude-subscription': { label: '本机 Claude 订阅', kind: 'agent-sdk', endpoint: '' },
  'codex-subscription': { label: '本机 Codex 订阅', kind: 'codex', endpoint: '' },
  google: { label: 'Google Gemini', kind: 'gemini', endpoint: 'https://generativelanguage.googleapis.com' },
  openai: { label: 'OpenAI', kind: 'openai', endpoint: 'https://api.openai.com/v1' },
  deepseek: { label: 'DeepSeek', kind: 'openai', endpoint: 'https://api.deepseek.com/v1' },
  qwen: { label: '通义千问', kind: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  moonshot: { label: 'Moonshot / Kimi', kind: 'openai', endpoint: 'https://api.moonshot.cn/v1' },
  zhipu: { label: '智谱 GLM', kind: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4' },
  openrouter: { label: 'OpenRouter', kind: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  ollama: { label: 'Ollama（本机）', kind: 'openai', endpoint: 'http://localhost:11434/v1' },
  siliconflow: { label: 'SiliconFlow', kind: 'openai', endpoint: 'https://api.siliconflow.cn/v1' },
  custom: { label: '自定义 OpenAI 兼容端点', kind: 'openai', endpoint: '' },
};
const endpointSchema = z.string().trim().url().max(300).transform((u) => u.replace(/\/+$/, ''));
export const createChannelSchema = z.object({
  kind: z.enum(CHANNEL_KINDS),
  vendor: z.enum(CHANNEL_VENDORS).optional(),
  label: z.string().trim().min(1).max(60),
  endpoint: endpointSchema.optional(),
  model: z.string().trim().min(1).max(80),
  // 本机订阅走的是机器上的登录态，没有 Key 可填
  apiKey: z.string().max(500).optional(),
}).refine((v) => v.kind !== 'openai' || !!v.endpoint, { path: ['endpoint'], message: 'OpenAI 兼容的模型必须填端点' })
  .refine((v) => LOCAL_CHANNEL_KINDS.includes(v.kind) || !!v.apiKey, { path: ['apiKey'], message: '这类模型必须填 API Key' });
export const updateChannelSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  endpoint: endpointSchema.optional(),
  model: z.string().trim().min(1).max(80).optional(),
  // 空串 = 不改（编辑面板里密钥框留空的语义）
  apiKey: z.string().max(500).optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');
export type ChannelDto = { id: string; kind: ChannelKind; vendor: ChannelVendor; label: string; endpoint: string | null; model: string; apiKeyHint: string | null; status: ChannelStatus; lastProbeAt: string | null; lastError: string | null; createdAt: string };
export type ProbeResultDto = { ok: boolean; latencyMs?: number; detail?: string; error?: string };
export type RunnerOptionDto = {
  id: string; label: string; hint?: string; runner: Runner; available: boolean; unavailableReason?: string; vision: boolean;
  /** builtin = 本机 agent（Claude Code，看 PATH）；channel = 用户自己配的通道（v0.34 起云端通道只有这一种来源） */
  source: 'builtin' | 'channel';
  /** 只用于图标 */
  vendor: ChannelVendor;
  status?: ChannelStatus;
  /** 通道类型（`source=channel` 时）：聊天模式只列 `agent-sdk`（REQ-CORE-023） */
  channelKind?: ChannelKind;
  /** 本机通道的安装 / 配置步骤（REQ-CORE-013） */
  setupHint?: string;
  channelId?: string;
};
export type JobDto = { id: string; projectId: string; kind: JobKind; status: JobStatus; runner: JobRunner; input: unknown; output: unknown; createdAt: string; startedAt: string | null; finishedAt: string | null };
/** 项目级事件（API-CORE-030）：只是「有变化」的提示——screen_changed 带 screenId / revisionId，job_changed 带 jobId 与作业事件类型 */
export type ProjectEventDto = { type: 'screen_changed' | 'job_changed'; data: unknown; at: string };

// 协作显示（v1.32 REQ-CORE-048，API-CORE-053）：每个标签页一个 clientId，每个浏览器一个协作者身份；状态只存在服务进程内存里
export const COLLAB_COLORS = 8;
const finite = z.number().finite();
export const presencePersonSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(24), color: z.number().int().min(1).max(COLLAB_COLORS) });
export const presenceStateSchema = z.object({
  /** 指针：画布上是世界坐标，草稿本里是草稿画框的原始尺寸坐标 */
  cursor: z.object({ x: finite, y: finite }).optional(),
  /** 视口在世界坐标里的框（跟随用；草稿本不发） */
  view: z.object({ x: finite, y: finite, w: finite.positive(), h: finite.positive() }).optional(),
  selected: z.array(z.uuid()).max(200).optional(),
  focus: z.object({ id: z.uuid(), kind: z.enum(['screen', 'component']), mode: z.enum(['interact', 'inspect']), route: z.string().max(200).optional() }).optional(),
  drag: z.array(z.object({ id: z.uuid(), x: finite, y: finite })).max(200).optional(),
  /** 这个标签页发出、还在跑的作业 */
  jobs: z.array(z.uuid()).max(20).optional(),
  /** 草稿本：正看的草稿与草稿里选中的块 */
  draft: z.uuid().optional(),
  blocks: z.array(z.string().min(1).max(40)).max(8).optional(),
  /** 正在看的那一端（REQ-CORE-049）与全屏视图里正看的那一屏（PAGE-FULLVIEW） */
  surface: z.uuid().optional(),
  screen: z.uuid().optional(),
  /** 正在跟随的人（person.id）与开始跟随的时刻（ms）：顺着它找跟随链的领头人，连成一圈时按它决定谁停下 */
  following: z.object({ id: z.uuid(), since: z.number().int().nonnegative() }).optional(),
});
export const presenceInputSchema = z.union([
  z.object({ clientId: z.uuid(), left: z.literal(true) }),
  z.object({ clientId: z.uuid(), person: presencePersonSchema, state: presenceStateSchema }),
]);
export type PresencePerson = z.infer<typeof presencePersonSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type PresenceInput = z.infer<typeof presenceInputSchema>;
/** API-CORE-030 推的协作事件：presence 是某个标签页的全量状态，presence_left 是它离开了 */
export type PresenceEventDto = { type: 'presence'; data: { clientId: string; person: PresencePerson; state: PresenceState; at: string } } | { type: 'presence_left'; data: { clientId: string } };
/** 本机会话（API-AGENT-010）：Claude Code 正在运行的会话，或 Codex 线程库里的用户线程（v0.68）。
 *  named=false：Claude Code 是派生名（目录 + 后缀，前端显示 UUID），Codex 是没起过名、name 取的是标题。
 *  open：Claude Code 恒为 true；Codex = 线程此刻在某个 Codex 窗口里打开着。app：Codex 线程开在哪（桌面版 / VS Code / 终端）。
 *  unverifiedVersion（v1.06）：Claude Code 版本没用真实会话验证过投递时给出版本号（登记里没写版本时为空串），下拉标「此版本未验证」 */
export type AgentSessionDto = { tool: AgentTool; sessionId: string; name: string; named: boolean; cwd: string; status: 'idle' | 'busy' | 'unknown'; open: boolean; app?: 'desktop' | 'vscode' | 'cli'; updatedAt: string; unverifiedVersion?: string };
export type JobEventDto = { seq: number; type: JobEventType; data: unknown; at: string };
export type MessageDto = { id: string; projectId: string; role: 'user' | 'assistant'; content: string; attachments: AttachmentDto[]; jobId: string | null; jobKind: JobKind | null; affectedScreenIds: string[]; createdAt: string };
export type ProjectDto = { id: string; name: string; deviceType: (typeof DEVICE_TYPES)[number]; status: 'active' | 'archived'; brief: string; exemplarScreenId: string | null; kind: ProjectKind; createdAt: string; updatedAt: string };
/** 草稿本（API-CORE-046）：草稿与版本的读写都走项目接口 */
export type SketchbookDto = { projectId: string };
/** 草稿写回的结果（API-CORE-047）：screen / component 二选一，restyle 时带改写作业；覆盖时带新修订与覆盖前那一版（回溯用） */
export type CopyDraftResultDto = { screen?: ScreenDto; component?: ComponentDto; job?: JobDto; revisionId?: string; previousRevisionId?: string };
export type ProjectDetailDto = { project: ProjectDto; designSystem: DesignSystemDto; surfaces: SurfaceDto[]; screens: ScreenDto[]; links: LinkDto[]; activeJobs: JobDto[]; assets: AssetDto[]; components: ComponentDto[] };
/** 搬进项目的结果（API-CORE-055）：改写作业建不出来时不回滚，带 restyleError */
export type MoveDraftsResultDto = { screens: ScreenDto[]; components: ComponentDto[]; jobs: JobDto[]; restyleError?: string };
export type RevisionDto = { id: string; screenId: string; seq: number; sourceKind: SourceKind; jobId: string | null; parentRevisionId: string | null; candidateIndex: number | null; candidateSettledAt: string | null; htmlUrl: string; screenshotUrl: string | null; thumbUrl: string | null; lintReport: unknown; createdAt: string };
/** 候选覆盖层的数据（API-CORE-026）：列 = 版本、行 = 屏 */
export type CandidatesDto = { jobId: string; versions: number; screens: { screenId: string; name: string; route: string; width: number; height: number; currentRevisionId: string | null; settled: boolean; revisions: { id: string; index: number; seq: number; screenshotUrl: string | null; thumbUrl: string | null; htmlUrl: string; previewUrl: string }[] }[] };
/** 用量台账（REQ-CORE-008，v0.32 无上限只作展示） */
export type UsageDto = { month: string; screens: number; tokensIn: number; tokensOut: number; byDriver: { driver: string; model: string; screens: number; tokensIn: number; tokensOut: number }[]; inflight: { calls: number; screens: number } };

// 用量看板（API-CORE-052，v1.24 ADR-036）。模型键：台账有通道 id 时就是它；没有时恰有一个通道同驱动同模型就归它，否则 `driver:model`
export const USAGE_RANGES = ['7d', '30d', 'all'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const usageStatsQuerySchema = z.object({
  range: z.enum(USAGE_RANGES),
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
});
/** 某一模型键在这一格里的量：Token 或作业次数 */
export type UsageByModel = Record<string, number>;
export type UsageStatsDto = {
  range: UsageRange;
  /** 所选范围的第一天与最后一天（按 utcOffset 的自然日，YYYY-MM-DD） */
  from: string; to: string;
  unit: 'day' | 'week';
  totals: { jobs: number; tokensIn: number; tokensOut: number; screens: number; sketchScreens: number; maxJobTokens: number };
  /** 全部时间里出现过的模型，按全部时间的 Token 降序；数是所选范围内的 */
  models: { key: string; label: string; modelId: string; driver: string; deleted: boolean; tokensIn: number; tokensOut: number; jobs: number; lastAt: string | null }[];
  buckets: { from: string; to: string; jobs: number; tokens: UsageByModel }[];
  /** id 为 null 的一项是迁移前就找不到项目的旧记录，界面写「已删除的项目」 */
  projects: { id: string | null; name: string | null; deleted: boolean; sketchbook: boolean; tokens: number; screens: number; byModel: UsageByModel }[];
  /** kind 为 other 的是没有快照的旧记录 */
  kinds: { kind: JobKind | 'other'; jobs: number; byModel: UsageByModel }[];
  /** 固定是含今天的近 90 天，与 range 无关 */
  activity: { from: string; to: string; days: { date: string; jobs: number }[]; topModel: string | null; topShare: number | null };
  inflight: { calls: number; screens: number };
};

// 本机使用记录（REQ-CORE-047，ADR-035；API-CORE-049～051）
export type RecordingDto = { enabled: boolean; since: string | null; events: number; modelCalls: number; archived: number; bytes: number; dir: string | null };
export const updateRecordingSchema = z.object({ enabled: z.boolean() });
export const RECORD_EVENT_TYPES = ['view', 'click', 'key', 'input', 'change', 'attach', 'drag', 'viewport', 'select', 'preview', 'toast', 'job', 'record', 'tool'] as const;
export type RecordEventType = (typeof RECORD_EVENT_TYPES)[number];
export const recordEventSchema = z.object({
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  page: z.string().max(200),
  path: z.string().max(2000).optional(),
  type: z.enum(RECORD_EVENT_TYPES),
  target: z.string().max(400).optional(),
  projectId: z.uuid().optional(),
  screenId: z.uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RecordEventInput = z.infer<typeof recordEventSchema>;
/** 一批 1–200 条；单条序列化后 ≤ 16 KB 由路由另查（zod 量不了序列化长度） */
export const recordEventsBatchSchema = z.object({ sessionId: z.string().min(1).max(100), events: z.array(recordEventSchema).min(1).max(200) });
export const RECORD_EVENT_MAX_BYTES = 16 * 1024;
/** 记录里超过这个长度的字符串只记长度（§9 record_events.data） */
export const RECORD_STRING_MAX = 2000;
export const MODEL_CALL_PURPOSES = ['plan', 'screen', 'edit', 'subtree', 'component', 'propose', 'chat', 'warmup', 'agent'] as const;
export type ModelCallPurpose = (typeof MODEL_CALL_PURPOSES)[number];
export type ProblemDto = { type: string; title: string; status: number; detail?: string; requestId: string; [k: string]: unknown };

// 使用记录里的值（§9 record_events.data、INV-CORE-006）：超过 max 的字符串换成它的长度（数字），其余字符串去掉 URL 里的签名参数值；
// \u0000 去掉（jsonb 存不下）。也从 @quilt/core/browser 导出，浏览器端可以先过一遍；服务端对发来的批次、MCP 参数与归档清单都过它
const SIGNED_PARAM = /([?&](?:sig|exp|t|token|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&#\s"'<>]+/g;
export function recordSafe(v: unknown, max: number = RECORD_STRING_MAX): unknown {
  if (typeof v === 'string') return v.length > max ? v.length : v.replace(SIGNED_PARAM, '$1-').replace(/\u0000/g, '');
  if (Array.isArray(v)) return v.map((x) => recordSafe(x, max));
  if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recordSafe(x, max)]));
  }
  return v;
}
/** 一条事件序列化后的字节数，与 RECORD_EVENT_MAX_BYTES 比（API-CORE-051） */
export const recordEventBytes = (e: unknown): number => new TextEncoder().encode(JSON.stringify(e)).length;
