import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, bigserial, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

// 数据模型（设计文档 §7/§9），并发约束（§16）。字段口径以 §9 数据字典为准。
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const now = () => sql`now()`;

// 本地单用户壳（ADR-016）：只有一行 local@quilt.local；表与外键保留，SaaS 阶段加回登录即多账号
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: ts('created_at').notNull().default(now()),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  deviceType: text('device_type').notNull(),
  status: text('status').notNull().default('active'),
  // 持久记忆（REQ-CORE-016）：应用简介（首轮规划器扩写、面板可改）与样板屏（不建外键，屏删除时由服务层清空）
  brief: text('brief').notNull().default(''),
  exemplarScreenId: uuid('exemplar_screen_id'),
  // 聊天会话（REQ-CORE-023 v0.45）：Agent SDK 的会话 id，一个项目一条，每轮 resume；空 = 还没聊过
  chatSessionId: text('chat_session_id'),
  createdAt: ts('created_at').notNull().default(now()),
  updatedAt: ts('updated_at').notNull().default(now()),
}, (t) => [index('projects_owner_idx').on(t.ownerId, t.updatedAt)]);

export const designSystems = pgTable('design_systems', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  seedColor: text('seed_color').notNull(),
  tokens: jsonb('tokens').notNull(),
  // 品牌色板（v0.35 REQ-EDIT-005）：逐键覆盖种子派生值；空 = 纯派生。tokens 是两者合并后的成品，读的人不必知道来源
  palette: jsonb('palette'),
  colorMode: text('color_mode').notNull().default('light'),
  designMd: text('design_md').notNull(),
  components: jsonb('components').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: ts('updated_at').notNull().default(now()),
});

export const screens = pgTable('screens', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  route: text('route').notNull(),
  // 屏用途（ADR-012 屏注册表）：规划器落库，进每次调用的稳定前缀
  purpose: text('purpose').notNull().default(''),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  // 指向 screen_revisions.id；不建外键以避免循环依赖，由服务层保证
  currentRevisionId: uuid('current_revision_id'),
  createdAt: ts('created_at').notNull().default(now()),
  updatedAt: ts('updated_at').notNull().default(now()),
}, (t) => [uniqueIndex('screens_project_route_uq').on(t.projectId, t.route)]);

export const screenRevisions = pgTable('screen_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  screenId: uuid('screen_id').notNull().references(() => screens.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  // 修订树（ADR-014）：派生自哪一版；同作业同屏多版是候选（candidate_index 0..N−1），采用后同批一起结清
  parentRevisionId: uuid('parent_revision_id'),
  candidateIndex: integer('candidate_index'),
  candidateSettledAt: ts('candidate_settled_at'),
  htmlKey: text('html_key').notNull(),
  screenshotKey: text('screenshot_key'),
  sourceKind: text('source_kind').notNull(),
  jobId: uuid('job_id'),
  lintReport: jsonb('lint_report').notNull(),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('screen_revisions_screen_seq_uq').on(t.screenId, t.seq), index('screen_revisions_job_idx').on(t.jobId)]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  // REQ-CORE-012 参考图：[{ id, key, mediaType, bytes }]；正文在对象存储，这里只存 key
  attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),
  jobId: uuid('job_id'),
  affectedScreenIds: jsonb('affected_screen_ids').notNull().default(sql`'[]'::jsonb`),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [index('messages_project_created_idx').on(t.projectId, t.createdAt)]);

// 账号自建的生成通道（REQ-CORE-013 / ENT-Channel）。密钥按 ADR-013 加密，接口永不回显。
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  vendor: text('vendor').notNull(),
  label: text('label').notNull(),
  endpoint: text('endpoint'),
  model: text('model').notNull(),
  apiKeyEnc: text('api_key_enc'),
  apiKeyHint: text('api_key_hint'),
  status: text('status').notNull().default('unverified'),
  lastProbeAt: ts('last_probe_at'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().default(now()),
  updatedAt: ts('updated_at').notNull().default(now()),
}, (t) => [index('channels_user_idx').on(t.userId)]);

export const generationJobs = pgTable('generation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('queued'),
  // 执行者（ADR-015 v0.32）：model = worker 队列；agent = 投递到本机 Claude Code 会话（agentDelivery）
  runner: text('runner').notNull().default('model'),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  idempotencyKey: text('idempotency_key'),
  // 目标屏（edit/subtree/restore 等）；generate 以项目为目标（target_screen_id 为空）
  targetScreenId: uuid('target_screen_id'),
  requestId: text('request_id'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [
  uniqueIndex('generation_jobs_idempotency_uq').on(t.projectId, t.idempotencyKey),
  // §16：目标屏无进行中作业
  uniqueIndex('generation_jobs_active_screen_uq').on(t.projectId, t.targetScreenId).where(sql`status in ('queued','running') and target_screen_id is not null`),
  // §16：项目级 generate 同时只有一个
  uniqueIndex('generation_jobs_active_project_uq').on(t.projectId).where(sql`status in ('queued','running') and kind = 'generate'`),
  // §16：一个项目一条聊天会话，回合逐个串行（REQ-CORE-023）
  uniqueIndex('generation_jobs_active_chat_uq').on(t.projectId).where(sql`status in ('queued','running') and kind = 'chat'`),
  index('generation_jobs_project_status_idx').on(t.projectId, t.status),
]);

export const jobEvents = pgTable('job_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jobId: uuid('job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('job_events_job_seq_uq').on(t.jobId, t.seq)]);

export const links = pgTable('links', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromScreenId: uuid('from_screen_id').notNull().references(() => screens.id, { onDelete: 'cascade' }),
  elementQid: text('element_qid').notNull(),
  href: text('href').notNull(),
  toScreenId: uuid('to_screen_id'),
}, (t) => [index('links_project_idx').on(t.projectId)]);

// 元素批注（REQ-EDIT-004）：挂在某屏某个 qid 上的一条自然语言改动说明。
// rect 是批注那一刻元素在屏文档里的矩形，父页据此在画布层画气泡（见 ADR-003）。
// 设计预设（v0.40 REQ-CORE-021）：账号级，存设计系统的输入；套用是按值复制，与项目解耦
export const designPresets = pgTable('design_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  seedColor: text('seed_color').notNull(),
  fontFamily: text('font_family').notNull(),
  // 字体来源（v0.44）：google / system / url；url 来源才有 font_url
  fontSource: text('font_source').notNull().default('google'),
  fontUrl: text('font_url'),
  radiusScale: text('radius_scale').notNull(),
  palette: jsonb('palette'),
  colorMode: text('color_mode').notNull().default('light'),
  designMd: text('design_md').notNull(),
  components: jsonb('components').notNull(),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [index('design_presets_owner_idx').on(t.ownerId, t.createdAt)]);

export const presetAssets = pgTable('preset_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  presetId: uuid('preset_id').notNull().references(() => designPresets.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mediaType: text('media_type').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [index('preset_assets_preset_idx').on(t.presetId, t.createdAt)]);

// 项目素材（v0.35 REQ-CORE-019）：正文在对象存储，行里只记元数据；URL 由预览域按 id 现拼，不入库
export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mediaType: text('media_type').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [index('assets_project_idx').on(t.projectId, t.createdAt)]);

export const annotations = pgTable('annotations', {
  id: uuid('id').primaryKey().defaultRandom(),
  screenId: uuid('screen_id').notNull().references(() => screens.id, { onDelete: 'cascade' }),
  qid: text('qid').notNull(),
  note: text('note').notNull(),
  anchorText: text('anchor_text').notNull().default(''),
  rect: jsonb('rect').notNull(),
  status: text('status').notNull().default('open'),
  sentJobId: uuid('sent_job_id'),
  createdAt: ts('created_at').notNull().default(now()),
  updatedAt: ts('updated_at').notNull().default(now()),
}, (t) => [index('annotations_screen_status_idx').on(t.screenId, t.status)]);

export const usageEntries = pgTable('usage_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').unique(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  screens: integer('screens').notNull().default(0),
  // 这笔用量出自哪个驱动 / 模型（REQ-CORE-011 通道可选后，同一账号会混用多个）
  driver: text('driver'),
  model: text('model'),
  createdAt: ts('created_at').notNull().default(now()),
}, (t) => [index('usage_entries_user_created_idx').on(t.userId, t.createdAt)]);
