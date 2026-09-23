import { z } from 'zod';
import { DEVICE_TYPES, PRESENTATIONS, type Presentation } from './device.ts';
import { TOKEN_COLOR_KEYS } from './tokens.ts';
import { COMPONENT_NAME_RE, MAX_COMPONENT_HTML_BYTES } from './components.ts';

// 契约 schema（§8 / §9 / §24）：服务端校验与前端类型的唯一出处。
// v0.31：三种 generate 合一（整组 / 单屏 / 懒生成都是 `generate`）；历史行里的旧 kind 只读保留
export const JOB_KINDS = ['generate', 'edit_screens', 'regenerate_subtree', 'apply_design_system', 'propose_design_system', 'export_prototype', 'ingest_screen', 'chat', 'edit_component'] as const;
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
// component（v0.46）：共享组件提取 / 同步 / 改组件后的确定性回刷（REQ-EDIT-006）
export const SOURCE_KINDS = ['generate', 'edit', 'subtree', 'manual', 'restore', 'apply_ds', 'agent_ingest', 'component'] as const;
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
export const LLM_DRIVERS = ['agent-sdk', 'anthropic', 'gemini', 'openai', 'stub'] as const;
export const AGENT_TOOLS = ['claude-code'] as const;
export const runnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), driver: z.enum(LLM_DRIVERS), model: z.string().trim().min(1).max(80) }),
  // 本机 agent（REQ-AGENT-003 v0.34）：投递到本机某个正在运行的 Claude Code 会话，sessionId 是 Claude Code 登记处里的会话 UUID
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
  }).refine((v) => !!v.variantOf === !!v.variantName, { path: ['variantName'], message: 'variantOf 与 variantName 要一起给' }),
  edit_screens: z.object({ prompt: z.string().trim().min(1).max(8000), screenIds: z.array(z.uuid()).min(1).max(20), versions: versionsSchema.default(1), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(), componentIds: componentIdsSchema }),
  // 改共享组件（REQ-EDIT-006）：一次一个；成功后所有用到它的屏确定性回刷（零 LLM）
  edit_component: z.object({ componentId: z.uuid(), prompt: z.string().trim().min(1).max(8000), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() }),
  // 子树重生成（REQ-EDIT-002）：runner 可单独选（检查器里有自己的通道 / 会话选择器，记忆独立于输入框）
  regenerate_subtree: z.object({ screenId: z.uuid(), qid: z.string().regex(/^q\d+$/), prompt: z.string().trim().min(1).max(4000), expectedRevisionId: z.uuid(), runner: runnerSchema.optional() }),
  apply_design_system: z.object({ screenIds: z.union([z.literal('all'), z.array(z.uuid()).min(1)]) }),
  // 设计系统提炼（REQ-EDIT-003）：只产出提案（output.proposal），写入由 API-EDIT-002 在预览确认后完成
  propose_design_system: z.object({ instruction: z.string().trim().min(1).max(4000), screenId: z.uuid().optional(), runner: runnerSchema.optional() }),
  export_prototype: z.object({}),
  ingest_screen: z.object({ name: z.string().trim().min(1).max(80), route: routeSchema, html: z.string().min(1).max(262144), screenId: z.uuid().optional(), expectedRevisionId: z.uuid().optional() }),
  // 聊天（REQ-CORE-023 v0.45）：screenIds 是「用户此刻选中的屏」这一条上下文提示，不是目标锁——助手自己定范围
  chat: z.object({ prompt: z.string().trim().min(1).max(8000), screenIds: z.array(z.uuid()).max(20).optional(), runner: runnerSchema.optional(), imageKeys: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() }),
} as const;

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
]);
export type CreateJobInput = z.infer<typeof createJobSchema>;

// 用量预估（REQ-CORE-008）：发送前、建作业、「按新约定重生成」确认三处共用这一个函数。
// 修复轮按每屏最多 1 次算；apply_design_system / export 是确定性的，不占调用。
export function estimateJob(input: CreateJobInput, allScreens: number): { calls: number; screens: number } {
  switch (input.kind) {
    case 'generate': {
      const pinned = !!input.input.route || !!input.input.variantOf;
      const n = pinned ? 1 : input.input.count === 'auto' ? 5 : input.input.count;
      const screens = n * input.input.versions;
      return { calls: screens * 2 + (pinned ? 0 : 1), screens };
    }
    case 'edit_screens': { const screens = input.input.screenIds.length * input.input.versions; return { calls: screens * 2, screens }; }
    case 'regenerate_subtree': return { calls: 2, screens: 1 };
    case 'propose_design_system': return { calls: 1, screens: 0 };
    // 聊天一轮是 3–8 次工具调用外加模型往返，按上限估：超时 3 + 8 分钟
    case 'chat': return { calls: 8, screens: 0 };
    // 改组件只有一次模型调用；之后的回刷是确定性的，不占调用
    case 'edit_component': return { calls: 1, screens: 0 };
    case 'apply_design_system': return { calls: 0, screens: 0 };
    default: void allScreens; return { calls: 0, screens: 0 };
  }
}

export const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
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
});

// 项目级持久记忆（REQ-CORE-016 / API-CORE-027）
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  brief: z.string().max(2000).optional(),
  exemplarScreenId: z.uuid().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');
// 候选整组采用（API-CORE-025）
export const adoptGroupSchema = z.object({ index: z.number().int().min(0).max(MAX_VERSIONS - 1) });

// ---- 元素批注（REQ-EDIT-004 / API-EDIT-003）----
export const ANNOTATION_STATUSES = ['open', 'sent', 'resolved'] as const;
export const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export const createAnnotationSchema = z.object({
  qid: z.string().trim().min(1).max(64),
  note: z.string().trim().min(1).max(2000),
  anchorText: z.string().max(200).default(''),
  rect: rectSchema,
});
export const updateAnnotationSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(ANNOTATION_STATUSES).optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');
export const sendAnnotationsSchema = z.object({ annotationIds: z.array(z.uuid()).min(1).max(50) });

export const updateScreenSchema = z.object({
  x: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  y: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  route: routeSchema.optional(),
  // 变体名只对变体有效、route 只对默认屏有效（v0.62）；呈现方式是元数据、改了不重烤修订（v0.63）——三条规则在路由层判
  variantName: variantNameSchema.optional(),
  presentation: z.enum(PRESENTATIONS).optional(),
}).refine((v) => Object.keys(v).length > 0, 'empty patch');

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

export const cursorQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

// ---------- AGENT 域（v0.32：本地版无 OAuth、无派活任务；本机 agent 是被投递的 Claude Code 会话）----------
export const listJobsQuerySchema = z.object({ runner: z.enum(JOB_RUNNERS).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
/** 运行时配置（API-CORE-028）：前端启动时取一次 */
export type ConfigDto = { previewOrigin: string; version: string; local: true; home: string };

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
  /** 待采用的候选批（REQ-CORE-015）：current 所属批次未结清且有 ≥ 2 版 */
  pendingCandidates: { jobId: string; count: number } | null;
  /** 状态变体（v0.62）：variantOf 指向默认屏、variantName 是状态名；默认屏两者皆空 */
  variantOf: string | null; variantName: string | null;
  /** 呈现方式（v0.63）：overlay 屏播放时压在当前屏上 */
  presentation: Presentation;
  updatedAt: string;
};
export type LinkDto = { fromScreenId: string; qid: string; href: string; toScreenId: string | null };
export type AnnotationDto = {
  id: string; screenId: string; qid: string; note: string; anchorText: string;
  rect: { x: number; y: number; w: number; h: number };
  status: (typeof ANNOTATION_STATUSES)[number]; sentJobId: string | null; createdAt: string;
};
/** 设置页配置、前端下拉直接渲染的可选通道清单（只含标识与显示名） */
// ---- 生成通道可配置（REQ-CORE-013 / API-CORE-020~023）----
// agent-sdk = 本机 Claude 订阅：复用服务端机器上的 `claude` 登录态，没有 Key 也没有端点，只需要选模型（REQ-CORE-013）
export const CHANNEL_KINDS = ['anthropic', 'gemini', 'openai', 'agent-sdk'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_VENDORS = ['anthropic', 'claude-subscription', 'google', 'openai', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'openrouter', 'ollama', 'siliconflow', 'custom'] as const;
export type ChannelVendor = (typeof CHANNEL_VENDORS)[number];
export const CHANNEL_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
/** 厂商预设：只决定默认端点与图标，模型名由用户填（型号更新太快，不预填） */
export const VENDOR_PRESETS: Record<ChannelVendor, { label: string; kind: ChannelKind; endpoint: string }> = {
  anthropic: { label: 'Anthropic', kind: 'anthropic', endpoint: 'https://api.anthropic.com' },
  'claude-subscription': { label: '本机 Claude 订阅', kind: 'agent-sdk', endpoint: '' },
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
}).refine((v) => v.kind !== 'openai' || !!v.endpoint, { path: ['endpoint'], message: 'OpenAI 兼容通道必须填端点' })
  .refine((v) => v.kind === 'agent-sdk' || !!v.apiKey, { path: ['apiKey'], message: '这类通道必须填 API Key' });
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
/** 本机正在运行的 Claude Code 会话（API-AGENT-010）：named=false 是派生名（目录 + 后缀），前端显示 UUID */
export type AgentSessionDto = { sessionId: string; name: string; named: boolean; cwd: string; status: 'idle' | 'busy' | 'unknown'; updatedAt: string };
export type JobEventDto = { seq: number; type: JobEventType; data: unknown; at: string };
export type MessageDto = { id: string; projectId: string; role: 'user' | 'assistant'; content: string; attachments: AttachmentDto[]; jobId: string | null; jobKind: JobKind | null; affectedScreenIds: string[]; createdAt: string };
export type ProjectDto = { id: string; name: string; deviceType: (typeof DEVICE_TYPES)[number]; status: 'active' | 'archived'; brief: string; exemplarScreenId: string | null; createdAt: string; updatedAt: string };
export type ProjectDetailDto = { project: ProjectDto; designSystem: DesignSystemDto; screens: ScreenDto[]; links: LinkDto[]; activeJobs: JobDto[]; annotations: AnnotationDto[]; assets: AssetDto[]; components: ComponentDto[] };
export type RevisionDto = { id: string; screenId: string; seq: number; sourceKind: SourceKind; jobId: string | null; parentRevisionId: string | null; candidateIndex: number | null; candidateSettledAt: string | null; htmlUrl: string; screenshotUrl: string | null; lintReport: unknown; createdAt: string };
/** 候选覆盖层的数据（API-CORE-026）：列 = 版本、行 = 屏 */
export type CandidatesDto = { jobId: string; versions: number; screens: { screenId: string; name: string; route: string; width: number; height: number; currentRevisionId: string | null; settled: boolean; revisions: { id: string; index: number; seq: number; screenshotUrl: string | null; htmlUrl: string; previewUrl: string }[] }[] };
/** 用量台账（REQ-CORE-008，v0.32 无上限只作展示） */
export type UsageDto = { month: string; screens: number; tokensIn: number; tokensOut: number; byDriver: { driver: string; model: string; screens: number; tokensIn: number; tokensOut: number }[]; inflight: { calls: number; screens: number } };
export type ProblemDto = { type: string; title: string; status: number; detail?: string; requestId: string; [k: string]: unknown };
