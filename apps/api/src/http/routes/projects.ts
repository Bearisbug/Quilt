import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, desc, asc, lt, inArray, isNull } from 'drizzle-orm';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, ROUND_PRESET_PROMPTS, missingPagePrompt, variantPrompt, presetPrompt, presetNote, createProjectSchema, createJobSchema, createMessageSchema, retryMessageSchema, createAttachmentSchema, updateProjectSchema, cursorQuerySchema, listJobsQuerySchema, type MessageDto, type LinkDto, type CreateJobInput, type JobKind, type ProjectEventDto, type Runner, createPresetSchema, applyPresetSchema } from '@quilt/core';
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
import { findCodexThread } from '../../lib/codexSessions.ts';
import { subscribeProject } from '../../lib/events.ts';

// 本机 agent 作业的助手回执：写明投给了谁。Claude Code 会话没起过名时显示 UUID；Codex 线程没起过名时 name 就是标题，照用（v0.68）
async function deliveredText(runner?: { tool?: string; sessionId?: string }): Promise<string> {
  const id = runner?.sessionId ?? '';
  if (runner?.tool === 'codex') return `已投递到本机 Codex 线程「${(await findCodexThread(id))?.name ?? id}」：它做完会经 MCP 收口，结果回写到画布`;
  const s = await findSession(id);
  return `已投递到本机 Claude Code 会话「${s ? (s.named ? s.name : s.sessionId) : id}」：它做完会经 MCP 收口，结果回写到画布`;
}

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
// 系统拼的提示词后面接了「修改」时写的附加要求（REQ-CORE-026 v0.74），描述里一并写出
const withNote = (note: string | null, sep: string) => (note ? `${sep}${note}` : '');
function describeJob(input: CreateJobInput): string | null {
  switch (input.kind) {
    case 'generate': return input.input.variantOf ? `出「${input.input.variantName}」状态变体：${input.input.prompt}` : input.input.route ? `生成缺失的页面 ${input.input.route}${withNote(presetNote(input.input.prompt, missingPagePrompt(input.input.route)), '：')}` : `新建${input.input.count === 'auto' ? '一组屏' : input.input.count > 1 ? ` ${input.input.count} 屏` : '一屏'}${input.input.versions > 1 ? `（${input.input.versions} 版候选）` : ''}：${input.input.prompt}`;
    case 'regenerate_subtree': return `重生成选中区域：${input.input.prompt}`;
    case 'apply_design_system': return input.input.screenIds === 'all' ? '把最新设计系统回刷到所有屏' : `把最新设计系统回刷到 ${input.input.screenIds.length} 屏`;
    case 'propose_design_system': return `提炼设计系统约定：${input.input.instruction}`;
    case 'export_prototype': return '导出单文件原型';
    case 'edit_screens': {
      const n = input.input.screenIds.length;
      const link = presetNote(input.input.prompt, LINK_REPAIR_PROMPT);
      const conv = presetNote(input.input.prompt, CONVENTIONS_REGENERATE_PROMPT);
      return link !== null ? `补链：把 ${n} 屏的按钮 / 表单连上路由${withNote(link, '。附加要求：')}` : conv !== null ? `按新约定重生成 ${n} 屏${withNote(conv, '。附加要求：')}` : input.input.prompt;
    }
    case 'chat': return input.input.prompt;
    case 'edit_component': return `改组件：${input.input.prompt}`;
    default: return null;
  }
}
projectRoutes.post('/v1/projects/:projectId/jobs', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const input = await parseBody(c, createJobSchema);
  const content = describeJob(input);
  // 输入里带的通道决定执行者：本机 agent（如检查器里选了会话的子树重生成）投递到会话，其余入 worker 队列
  const jobRunner = (input.input as { runner?: { kind?: string; tool?: string; sessionId?: string } }).runner;
  const agent = jobRunner?.kind === 'agent';
  const { job, assistantMessage, reused } = await createJob({ user, projectId: project.id, input, idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId'), runner: agent ? 'agent' : 'model', withMessage: content ? { content } : undefined });
  if (agent && assistantMessage && !reused) {
    await db.update(schema.messages).set({ content: await deliveredText(jobRunner) }).where(eq(schema.messages.id, assistantMessage.id));
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
  // 共享组件目标（REQ-EDIT-006）：只有组件、没有屏也没有锚点 = 改这个组件（恰好 1 个）；其余情况它们的完整 HTML 进上下文
  const compTargets = body.mode !== 'chat' && body.targetComponentIds?.length ? body.targetComponentIds : null;
  if (compTargets) await assertOwnComponents(project.id, compTargets);
  // 「修改」还原的隐藏参数（REQ-CORE-026 v0.74）：出变体 / 补缺失页是钉死路由的造，补链 / 按新约定重生成是改；聊天时忽略
  const chat = body.mode === 'chat';
  const pinned = !chat && !!(body.variantOf || body.route);
  const preset = chat ? undefined : body.preset;
  if (pinned && targets) throw problems.validation([{ path: 'targetScreenIds', message: '出变体 / 补缺失页是造屏，不能同时带目标屏' }]);
  if (!chat && body.variantOf && body.route) throw problems.validation([{ path: 'route', message: '出变体与补缺失页不能同时给' }]);
  if (preset && (!targets || pinned)) throw problems.validation([{ path: 'targetScreenIds', message: '补链 / 按新约定重生成要带目标屏' }]);
  const editComponent = !!compTargets && !targets && !body.anchor && !pinned;
  if (editComponent && compTargets!.length !== 1) throw problems.validation([{ path: 'targetComponentIds', message: '一次只能改一个组件' }]);
  // 改组件只走模型通道：它是一次调用 + 确定性回刷，没有「投递到会话再收口」这条路
  if (editComponent && body.runner?.kind === 'agent') throw problems.validation([{ path: 'runner', message: '改组件请换一个模型通道，本机会话不接这类作业' }]);
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
  const componentIds = compTargets ?? undefined;
  const input: CreateJobInput = body.mode === 'chat'
    ? { kind: 'chat', input: { prompt: body.content, screenIds: targets ?? undefined, runner, imageKeys } }
    : editComponent
    ? { kind: 'edit_component', input: { componentId: compTargets![0], prompt: body.content, runner, imageKeys } }
    : targets
    ? { kind: 'edit_screens', input: { prompt: preset ? presetPrompt(ROUND_PRESET_PROMPTS[preset], body.content) : body.content, screenIds: targets, versions, runner, imageKeys, componentIds } }
    : body.variantOf
    ? { kind: 'generate', input: { prompt: body.content || variantPrompt(body.variantName!), count: 1, versions, variantOf: body.variantOf, variantName: body.variantName, runner, imageKeys, componentIds } }
    : body.route
    ? { kind: 'generate', input: { prompt: presetPrompt(missingPagePrompt(body.route), body.content), count: 1, versions, route: body.route, fromScreenId: body.fromScreenId, runner, imageKeys, componentIds } }
    : { kind: 'generate', input: { prompt: body.content, count: body.count ?? (screenCount === 0 ? 'auto' : 1), versions, anchor: body.anchor, runner, imageKeys, componentIds } };
  // 带隐藏参数的轮次，消息正文按 API-CORE-006 的口径写成描述（正文是提示词还是附加要求，由作业输入反解）
  const content = pinned || preset ? describeJob(input)! : body.content;
  // 通道选「交给本机 Claude Code」（REQ-CORE-011 / ADR-015 v0.34）：同样是作业（runner=agent），由 agentDelivery 投递到选中的会话，
  // 不入 worker 队列、不记 LLM 用量；助手消息在会话收口（quilt.finish_job）时回填。
  const [res, status] = await startRound(c, user, project.id, input, runner, { content, attachments }, targets);
  return c.json(res, status);
});

// 组件目标（发消息）与原作业里的组件（重试，API-CORE-034 v0.77）同一句 400：得都还在本项目里
async function assertOwnComponents(projectId: string, ids: string[]) {
  const want = Array.from(new Set(ids));
  const mine = await db.select({ id: schema.components.id }).from(schema.components).where(and(eq(schema.components.projectId, projectId), inArray(schema.components.id, want)));
  if (mine.length !== want.length) throw problems.validation([{ path: 'targetComponentIds', message: '有组件不属于这个项目或已被删除' }]);
}

// 建一轮（消息 + 作业）并给出响应体：发消息与重试共用。本机 agent 的轮次助手回执立刻写明投给了谁
async function startRound(c: Context<Env>, user: ReturnType<typeof requireUser>, projectId: string, input: CreateJobInput, runner: Runner | undefined, message: { content: string; attachments: StoredAttachment[] }, targets: string[] | null) {
  const agent = runner?.kind === 'agent';
  const { job, userMessage, assistantMessage, reused } = await createJob({ user, projectId, input, idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId'), runner: agent ? 'agent' : 'model', withMessage: message });
  if (reused) {
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.jobId, job.id));
    const u = msgs.find((m) => m.role === 'user'); const a = msgs.find((m) => m.role === 'assistant');
    return [{ userMessage: u && await messageDto(u), assistantMessage: a && await messageDto(a), job: jobDto(job) }, 200] as const;
  }
  if (agent) {
    const [assistant] = await db.update(schema.messages).set({ content: await deliveredText(runner?.kind === 'agent' ? runner : undefined), affectedScreenIds: targets ?? [] }).where(eq(schema.messages.id, assistantMessage!.id)).returning();
    return [{ userMessage: await messageDto(userMessage!), assistantMessage: await messageDto(assistant), job: jobDto(job) }, 202] as const;
  }
  return [{ userMessage: await messageDto(userMessage!), assistantMessage: await messageDto(assistantMessage!), job: jobDto(job) }, 202] as const;
}

// API-CORE-034（v0.72 REQ-CORE-026）：重试一轮。复制原作业输入、只换通道——系统代发的轮次（补链、按新约定重生成）
// 消息正文是描述而不是提示词，所以不能按消息正文重拼请求；参考图按 id 复用，正文已不在存储里时同发消息一样报 400
const RETRYABLE: JobKind[] = ['generate', 'edit_screens', 'edit_component', 'chat'];
projectRoutes.post('/v1/projects/:projectId/messages/:messageId/retry', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  const body = await parseBody(c, retryMessageSchema);
  const [msg] = await db.select().from(schema.messages).where(and(eq(schema.messages.id, c.req.param('messageId')), eq(schema.messages.projectId, project.id), eq(schema.messages.role, 'user')));
  const [old] = msg?.jobId ? await db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id, msg.jobId)) : [];
  if (!msg || !old) throw problems.notFound();
  if (!RETRYABLE.includes(old.kind as JobKind)) throw problems.validation([{ path: 'messageId', message: '这一轮不能重试' }]);
  if (old.status === 'queued' || old.status === 'running') throw problems.jobNotFinished();
  const prev = old.input as { runner?: Runner; screenIds?: string[]; componentId?: string; componentIds?: string[] };
  // 原作业的目标可能已被删：组件在这里查（与发消息同一句 400），目标屏与 variantOf 由 createJob 查（404 / 422）
  const comps = [...(prev.componentId ? [prev.componentId] : []), ...(prev.componentIds ?? [])];
  if (comps.length) await assertOwnComponents(project.id, comps);
  const requested = body.runner ?? prev.runner;
  if (old.kind === 'edit_component' && requested?.kind === 'agent') throw problems.validation([{ path: 'runner', message: '改组件请换一个模型通道，本机会话不接这类作业' }]);
  const attachments = await resolveForMessage(project.id, (msg.attachments as StoredAttachment[]).map((a) => a.id));
  if (attachments.length && requested?.kind === 'model' && !driverSupportsVision(requested.driver)) {
    throw problems.validation([{ path: 'runner', message: `「${requested.driver}」通道不支持参考图，换一个支持视觉的通道再发` }]);
  }
  if (requested?.kind === 'channel') await ownedChannelOrThrow(user.id, requested.channelId);
  const runner = old.kind === 'chat' ? await chatRunner(user.id, requested) : requested;
  const input = { kind: old.kind, input: { ...prev, runner, imageKeys: attachments.length ? attachments.map((a) => a.key) : undefined } } as CreateJobInput;
  const [res, status] = await startRound(c, user, project.id, input, runner, { content: msg.content, attachments }, prev.screenIds ?? null);
  return c.json(res, status);
});

// API-CORE-029：作业列表（agent 面板：本机 agent 作业的状态 / 日志尾）
// API-CORE-031（v0.34）：删项目。有进行中的作业 409 /errors/project-busy
projectRoutes.delete('/v1/projects/:projectId', async (c) => {
  await deleteProject(requireUser(c).id, c.req.param('projectId'));
  return c.body(null, 204);
});

// API-CORE-030（v0.34）：项目级事件流——本机会话经 MCP 回写、别处建的作业、截图就绪都从这里通知画布。
// 不落表不续传：事件只是「有变化」的提示，画布收到就整体刷新；断线后画布重连，每次重连成功再整体重取一次补上断线期间的变化
projectRoutes.get('/v1/projects/:projectId/events', async (c) => {
  const user = requireUser(c);
  const project = await ownedProject(user.id, c.req.param('projectId'));
  return streamSSE(c, async (stream) => {
    let open = true;
    const queue: ProjectEventDto[] = [];
    const unsubscribe = await subscribeProject(project.id, (e) => { queue.push(e); });
    stream.onAbort(() => { open = false; unsubscribe(); });
    // 先写一行注释：经 Vite 代理时响应头要等第一次写才发出去，不写的话 EventSource 的 open 要等第一个 ping（15 s）
    await stream.write(': open\n\n');
    let idle = 0;
    while (open) {
      await stream.sleep(250);
      if (queue.length) {
        idle = 0;
        for (const e of queue.splice(0)) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          // 项目被删（v0.77）：这是最后一条，写完就结束；EventSource 重连拿到 404 后不再重连
          if ((e.data as { reason?: string } | null)?.reason === 'project_deleted') open = false;
        }
        continue;
      }
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
  // 请求体只有类型与大小两个字段，不合 schema 就是内容不合规：与直传复核同一个 422（API-CORE-019）
  const body = await parseBody(c, createAttachmentSchema, problems.unprocessable);
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
  // 地图节点只有默认屏（v0.62）：变体与默认屏同路由，边的目标也只解析到默认屏
  const screens = await db.select({ id: schema.screens.id, route: schema.screens.route }).from(schema.screens).where(and(eq(schema.screens.projectId, project.id), isNull(schema.screens.variantOf)));
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
