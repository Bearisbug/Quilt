import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, desc, asc, lt, inArray } from 'drizzle-orm';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, createProjectSchema, createJobSchema, createMessageSchema, createAttachmentSchema, updateProjectSchema, cursorQuerySchema, listJobsQuerySchema, type MessageDto, type LinkDto, type CreateJobInput, type JobKind, type ProjectEventDto, type Runner, createPresetSchema, applyPresetSchema } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { parseBody, parseQuery, requireUser, type Env } from '../app.ts';
import { createProject, deleteProject, getProjectDetail, listProjects, ownedProject, updateProject, projectDto, designSystemDto, jobDto } from '../../services/projects.ts';
import { createJob, listJobs } from '../../services/jobs.ts';
import { createUpload, dtos as attachmentDtos, resolveForMessage, type StoredAttachment } from '../../services/attachments.ts';
import { createAsset, deleteAsset, listAssets } from '../../services/assets.ts';
import { applyPreset, createPreset, deletePreset, listPresets } from '../../services/presets.ts';
import { driverSupportsVision } from '../../lib/llm.ts';
import { listChannels } from '../../services/channels.ts';
const ownedChannelOrThrow = async (userId: string, id: string) => { if (!(await listChannels(userId)).some((c) => c.id === id)) throw problems.notFound(); };
// 聊天通道（REQ-CORE-023）：Agent SDK 只认 Claude——必须是 agent-sdk 通道；缺省取第一条已验证的，一条都没有就点名去设置页加
const CHAT_CHANNEL_HINT = '聊天需要「本机 Claude 订阅」通道：去设置页添加并验证一条';
async function chatRunner(userId: string, runner: Runner | undefined): Promise<Runner> {
  const mine = await listChannels(userId);
  if (runner) {
    const ok = (runner.kind === 'channel' && mine.find((c) => c.id === runner.channelId)?.kind === 'agent-sdk') || (runner.kind === 'model' && runner.driver === 'agent-sdk');
    if (!ok) throw problems.validation([{ path: 'runner', message: CHAT_CHANNEL_HINT }]);
    return runner;
  }
  const ch = mine.find((c) => c.kind === 'agent-sdk' && c.status === 'verified');
  if (!ch) throw problems.validation([{ path: 'runner', message: CHAT_CHANNEL_HINT }]);
  return { kind: 'channel', channelId: ch.id };
}
import { problems } from '../../lib/errors.ts';
import { findSession } from '../../lib/claudeSessions.ts';
import { subscribeProject } from '../../lib/events.ts';

export const projectRoutes = new Hono<Env>();

// API-CORE-003
projectRoutes.post('/v1/projects', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, createProjectSchema);
  const { project, designSystem } = await createProject(user.id, input);
  return c.json({ project: projectDto(project), designSystem: designSystemDto(designSystem) }, 201);
});

// API-CORE-005
projectRoutes.get('/v1/projects', async (c) => {
  const user = requireUser(c);
  const q = parseQuery(c, cursorQuerySchema);
  c.header('Cache-Control', 'no-store');
  return c.json(await listProjects(user.id, q.cursor, q.limit));
});

// API-CORE-004
projectRoutes.get('/v1/projects/:projectId', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await getProjectDetail(user.id, c.req.param('projectId')));
});

// API-CORE-027：应用简介 / 样板屏 / 改名（REQ-CORE-016）
projectRoutes.patch('/v1/projects/:projectId', async (c) => {
  const user = requireUser(c);
  const patch = await parseBody(c, updateProjectSchema);
  return c.json({ project: projectDto(await updateProject(user.id, c.req.param('projectId'), patch)) });
});

// API-CORE-006。非对话发起的作业也写进对话记录，让回刷/导出/局部重生成/懒生成在面板里有可见反馈。
function describeJob(input: CreateJobInput): string | null {
  switch (input.kind) {
    case 'generate': return input.input.route ? `生成缺失的页面 ${input.input.route}` : `新建${input.input.count === 'auto' ? '一组屏' : input.input.count > 1 ? ` ${input.input.count} 屏` : '一屏'}${input.input.versions > 1 ? `（${input.input.versions} 版候选）` : ''}：${input.input.prompt}`;
    case 'regenerate_subtree': return `重生成选中区域：${input.input.prompt}`;
    case 'apply_design_system': return input.input.screenIds === 'all' ? '把最新设计系统回刷到所有屏' : `把最新设计系统回刷到 ${input.input.screenIds.length} 屏`;
    case 'propose_design_system': return `提炼设计系统约定：${input.input.instruction}`;
    case 'export_prototype': return '导出单文件原型';
    case 'edit_screens': return input.input.prompt === LINK_REPAIR_PROMPT ? `补链：把 ${input.input.screenIds.length} 屏的按钮 / 表单连上路由` : input.input.prompt === CONVENTIONS_REGENERATE_PROMPT ? `按新约定重生成 ${input.input.screenIds.length} 屏` : input.input.prompt;
    case 'chat': return input.input.prompt;
    default: return null;
  }
}
projectRoutes.post('/v1/projects/:projectId/jobs', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const input = await parseBody(c, createJobSchema);
  const content = describeJob(input);
  // 输入里带的通道决定执行者：本机 agent（如检查器里选了会话的子树重生成）投递到会话，其余入 worker 队列
  const jobRunner = (input.input as { runner?: { kind?: string; sessionId?: string } }).runner;
  const agent = jobRunner?.kind === 'agent';
  const { job, assistantMessage, reused } = await createJob({ user, projectId: project.id, input, idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId'), runner: agent ? 'agent' : 'model', withMessage: content ? { content } : undefined });
  if (agent && assistantMessage && !reused) {
    const session = await findSession(jobRunner?.sessionId ?? '');
    const who = session ? (session.named ? session.name : session.sessionId) : jobRunner?.sessionId ?? '';
    await db.update(schema.messages).set({ content: `已投递到本机 Claude Code 会话「${who}」：它做完会经 MCP 收口，结果回写到画布` }).where(eq(schema.messages.id, assistantMessage.id));
  }
  return c.json({ job: jobDto(job) }, reused ? 200 : 202);
});

// API-CORE-010：消息驱动作业。动词由目标决定（v0.31）：有目标屏 → edit_screens；无 → generate。
projectRoutes.post('/v1/projects/:projectId/messages', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const body = await parseBody(c, createMessageSchema);
  const screenCount = (await db.select({ id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.projectId, project.id))).length;
  const targets = body.targetScreenIds?.length ? body.targetScreenIds : null;
  // 参考图（REQ-CORE-012）：先把 id 解析成真实存在的对象，取不到就判非法——
  // 用户看得见自己贴了图，静默丢掉比报错更糟
  const attachments = await resolveForMessage(project.id, body.attachmentIds);
  if (attachments.length && body.runner?.kind === 'model' && !driverSupportsVision(body.runner.driver)) {
    throw problems.validation([{ path: 'runner', message: `「${body.runner.driver}」通道不支持参考图，换一个支持视觉的通道再发` }]);
  }
  // 账号自建通道（REQ-CORE-013）：只记 id 进作业，凭据在 worker 运行时解密；先确认它属于当前账号
  if (body.runner?.kind === 'channel') await ownedChannelOrThrow(user.id, body.runner.channelId);
  // 聊天（REQ-CORE-023 v0.45）：不看目标——选中的屏只是上下文提示；通道必须是本机 Claude 订阅
  const runner = body.mode === 'chat' ? await chatRunner(user.id, body.runner) : body.runner;
  const imageKeys = attachments.length ? attachments.map((a) => a.key) : undefined;
  const versions = body.versions ?? 1;
  const input: CreateJobInput = body.mode === 'chat'
    ? { kind: 'chat', input: { prompt: body.content, screenIds: targets ?? undefined, runner, imageKeys } }
    : targets
    ? { kind: 'edit_screens', input: { prompt: body.content, screenIds: targets, versions, runner, imageKeys } }
    : { kind: 'generate', input: { prompt: body.content, count: body.count ?? (screenCount === 0 ? 'auto' : 1), versions, anchor: body.anchor, runner, imageKeys } };
  // 通道选「交给本机 Claude Code」（REQ-CORE-011 / ADR-015 v0.34）：同样是作业（runner=agent），由 agentDelivery 投递到选中的会话，
  // 不入 worker 队列、不记 LLM 用量；助手消息在会话收口（quilt.finish_job）时回填。
  const agent = runner?.kind === 'agent';
  const { job, userMessage, assistantMessage, reused } = await createJob({ user, projectId: project.id, input, idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId'), runner: agent ? 'agent' : 'model', withMessage: { content: body.content, attachments } });
  if (reused) {
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.jobId, job.id));
    const u = msgs.find((m) => m.role === 'user'); const a = msgs.find((m) => m.role === 'assistant');
    return c.json({ userMessage: u && await messageDto(u), assistantMessage: a && await messageDto(a), job: jobDto(job) }, 200);
  }
  if (agent) {
    const sessionId = runner && runner.kind === 'agent' ? runner.sessionId : '';
    const session = await findSession(sessionId);
    const who = session ? (session.named ? session.name : session.sessionId) : sessionId;
    const [assistant] = await db.update(schema.messages).set({ content: `已投递到本机 Claude Code 会话「${who}」：它做完会经 MCP 收口，结果回写到画布`, affectedScreenIds: targets ?? [] }).where(eq(schema.messages.id, assistantMessage!.id)).returning();
    return c.json({ userMessage: await messageDto(userMessage!), assistantMessage: await messageDto(assistant), job: jobDto(job) }, 202);
  }
  return c.json({ userMessage: await messageDto(userMessage!), assistantMessage: await messageDto(assistantMessage!), job: jobDto(job) }, 202);
});

// API-CORE-029：作业列表（agent 面板：本机 agent 作业的状态 / 日志尾）
// API-CORE-031（v0.34）：删项目。有进行中的作业 409 /errors/project-busy
projectRoutes.delete('/v1/projects/:projectId', async (c) => {
  await deleteProject(requireUser(c).id, c.req.param('projectId'));
  return c.body(null, 204);
});

// API-CORE-030（v0.34）：项目级事件流——本机会话经 MCP 回写、别处建的作业、截图就绪都从这里通知画布。
// 不落表不续传：事件只是「有变化」的提示，画布收到就整体刷新；断线由 EventSource 自己重连
projectRoutes.get('/v1/projects/:projectId/events', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  return streamSSE(c, async (stream) => {
    let open = true;
    const queue: ProjectEventDto[] = [];
    const unsubscribe = await subscribeProject(project.id, (e) => { queue.push(e); });
    stream.onAbort(() => { open = false; unsubscribe(); });
    let idle = 0;
    while (open) {
      await stream.sleep(250);
      if (queue.length) { idle = 0; for (const e of queue.splice(0)) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) }); continue; }
      idle += 250;
      if (idle >= 15_000) { idle = 0; await stream.writeSSE({ event: 'ping', data: '' }); }
    }
    unsubscribe();
  });
});

projectRoutes.get('/v1/projects/:projectId/jobs', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const q = parseQuery(c, listJobsQuerySchema);
  c.header('Cache-Control', 'no-store');
  return c.json({ items: (await listJobs(project.id, q)).map(jobDto) });
});

// API-CORE-019：参考图直传（REQ-CORE-012）。签发签名 PUT，正文直接进对象存储，不过 API 的 JSON 体。
// API-CORE-033 设计预设（REQ-CORE-021）：账号级，跨项目复用一套视觉
projectRoutes.post('/v1/design-presets', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, createPresetSchema);
  return c.json({ preset: await createPreset(user.id, input) }, 201);
});

projectRoutes.get('/v1/design-presets', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ items: await listPresets(user.id) });
});

projectRoutes.delete('/v1/design-presets/:presetId', async (c) => {
  const user = requireUser(c);
  await deletePreset(user.id, c.req.param('presetId'));
  return c.body(null, 204);
});

projectRoutes.post('/v1/projects/:projectId/design-preset', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, applyPresetSchema);
  const { assetsCopied, skipped } = await applyPreset(user.id, c.req.param('projectId'), input);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, c.req.param('projectId')));
  return c.json({ designSystem: designSystemDto(ds), assetsCopied, skipped });
});

// API-CORE-032 项目素材（REQ-CORE-019）：multipart 直传，正文进对象存储
projectRoutes.post('/v1/projects/:projectId/assets', async (c) => {
  const user = requireUser(c);
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw problems.unprocessable([{ path: 'file', message: '缺少 file 字段' }]);
  const nameField = typeof form['name'] === 'string' ? form['name'].trim() : '';
  const asset = await createAsset(user.id, c.req.param('projectId'), {
    name: nameField || file.name || '素材',
    body: Buffer.from(await file.arrayBuffer()),
  });
  return c.json({ asset }, 201);
});

projectRoutes.get('/v1/projects/:projectId/assets', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ items: await listAssets(user.id, c.req.param('projectId')) });
});

projectRoutes.delete('/v1/assets/:assetId', async (c) => {
  const user = requireUser(c);
  await deleteAsset(user.id, c.req.param('assetId'));
  return c.body(null, 204);
});

projectRoutes.post('/v1/projects/:projectId/attachments', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const body = await parseBody(c, createAttachmentSchema);
  return c.json(await createUpload(project.id, body), 201);
});

// API-CORE-011
projectRoutes.get('/v1/projects/:projectId/messages', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const q = parseQuery(c, cursorQuerySchema);
  const where = q.cursor ? and(eq(schema.messages.projectId, project.id), lt(schema.messages.createdAt, new Date(q.cursor))) : eq(schema.messages.projectId, project.id);
  // 同一时间戳时 assistant 排在 user 之前（倒序取、再 reverse 后 user 在前）
  const rows = await db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.createdAt), asc(schema.messages.role)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit).reverse();
  const jobIds = Array.from(new Set(page.map((m) => m.jobId).filter((x): x is string => !!x)));
  const kinds = new Map((jobIds.length ? await db.select({ id: schema.generationJobs.id, kind: schema.generationJobs.kind }).from(schema.generationJobs).where(inArray(schema.generationJobs.id, jobIds)) : []).map((j) => [j.id, j.kind as JobKind]));
  const items = await Promise.all(page.map((m) => messageDto(m, kinds)));
  c.header('Cache-Control', 'no-store');
  return c.json({ items, nextCursor: rows.length > q.limit ? rows[q.limit - 1].createdAt.toISOString() : null });
});

// API-PROTO-001（派生视图，M1 即可用于断链标红）
projectRoutes.get('/v1/projects/:projectId/app-map', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const screens = await db.select({ id: schema.screens.id, route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, project.id));
  const links = await db.select().from(schema.links).where(eq(schema.links.projectId, project.id));
  const edges: LinkDto[] = links.map((l) => ({ fromScreenId: l.fromScreenId, qid: l.elementQid, href: l.href, toScreenId: l.toScreenId }));
  c.header('Cache-Control', 'no-store');
  return c.json({ nodes: screens.map((s) => ({ screenId: s.id, route: s.route })), edges });
});

// 附件 URL 是签名的、会过期，所以每次出 DTO 现签——与 screenDtos 同一惯例，因此是 async。
// jobKind 让对话面板知道哪条回执能「记为约定」（edit_screens）；列表路由批量查好传进来，单条时现查
export async function messageDto(m: typeof schema.messages.$inferSelect, kinds?: Map<string, JobKind>): Promise<MessageDto> {
  let jobKind: JobKind | null = null;
  if (m.jobId) {
    if (kinds) jobKind = kinds.get(m.jobId) ?? null;
    else { const [j] = await db.select({ kind: schema.generationJobs.kind }).from(schema.generationJobs).where(eq(schema.generationJobs.id, m.jobId)); jobKind = (j?.kind as JobKind | undefined) ?? null; }
  }
  return {
    id: m.id, projectId: m.projectId, role: m.role as 'user' | 'assistant', content: m.content,
    attachments: await attachmentDtos((m.attachments as StoredAttachment[]) ?? []),
    jobId: m.jobId, jobKind, affectedScreenIds: (m.affectedScreenIds as string[]) ?? [], createdAt: m.createdAt.toISOString(),
  };
}
