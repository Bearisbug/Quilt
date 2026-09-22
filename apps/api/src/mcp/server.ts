import { z } from 'zod';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, and, asc, desc, lt } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { Problem, problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { listJobEvents } from '../lib/events.ts';
import { driverSupportsVision } from '../lib/llm.ts';
import { locateAttachment, createUpload, resolveForMessage } from '../services/attachments.ts';
import { createJob, ownedJob, cancelJob, listJobs, enqueueScreenshot } from '../services/jobs.ts';
import { finishAgentJob } from '../worker/agentDelivery.ts';
import { updateDesignSystem, applyElementEdit } from '../services/edit.ts';
import { createProject, getProjectDetail, listProjects, jobDto, ownedProject, projectDto, designSystemDto, updateProject, deleteProject, screenDtos } from '../services/projects.ts';
import { ownedScreen, getRevision, listRevisions, exemplarBody, projectOutline, hasActiveJob, createRevision, deriveLinks, revisionDto, adoptCandidate, listCandidates, clearExemplarIfDeleted } from '../services/screens.ts';
import { ingestScreen, validateScreenHtml, designContract } from '../services/ingest.ts';
import { createComponent, updateComponent, deleteComponent, ownedComponent } from '../services/components.ts';
import { listAssets, createAsset, deleteAsset } from '../services/assets.ts';
import { listPresets, createPreset, deletePreset, applyPreset } from '../services/presets.ts';
import * as annotations from '../services/annotations.ts';
import { runnerCatalog, listChannels } from '../services/channels.ts';
import { messageDto } from '../http/routes/projects.ts';
import { COLOR_MODES, FONT_SOURCES, fontFamilySchema, fontUrlSchema, paletteSchema, componentNameSchema, MAX_COMPONENT_HTML_BYTES, MAX_CONVENTIONS, MAX_VERSIONS, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_COMPONENT_TARGETS, IMAGE_MEDIA_TYPES, JOB_RUNNERS, ANNOTATION_STATUSES, runnerSchema, anchorSchema, routeSchema, elementOpSchema, type ColorMode, type DeviceType, type FontSource, type Palette, type Runner, type JobRunner, type CreateJobInput, type ElementOp } from '@quilt/core';
import type { UserRow } from '../services/user.ts';

// MCP server（API-AGENT-002）：每请求无状态构建；工具/资源/提示词都是 REST 服务层的投影。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分。
export function buildMcpServer(user: UserRow): McpServer {
  const server = new McpServer({ name: 'quilt', version: '0.1.0' }, { instructions: 'Quilt is an infinite-canvas AI design tool. Use quilt.get_design_contract before writing HTML yourself; quilt.validate_screen reports deviations from it without saving (advisory — a write is never rejected for them); push with quilt.create_screen / quilt.update_screen. Long-running generation tools return a job — poll quilt.get_job. When the Quilt canvas delivered a job to this session, pass that jobId on every create/update call and close it with quilt.finish_job when done. Everything the canvas can do has a tool here: revisions (get_revision / restore_revision / adopt_candidate), placement (move_screens), assets, design presets, export, job management (list_jobs / cancel_job / get_job_events), annotations and zero-token element edits (edit_element).' });
  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
  const wrap = <A extends Record<string, unknown>>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try { const r = await fn(args); return typeof r === 'object' && r !== null && 'content' in (r as object) ? (r as ReturnType<typeof ok>) : ok(r); }
    catch (e) {
      const p = e instanceof Problem ? { type: e.type, title: e.title, status: e.status, ...e.extra } : { type: '/errors/internal', title: (e as Error).message, status: 500 };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(p) }] };
    }
  };
  const read = () => {};
  const write = () => {};
  const idem = () => `mcp-${crypto.randomUUID()}`;
  const requestId = 'mcp';
  // 造 / 改类作业的 runner 与参考图（v0.51）：与 API-CORE-010 同一套校验——账号自建通道要属于自己、带图的通道要支持视觉、
  // 附件要真传完（取不到判非法，不静默丢图）；本机会话是否活着由 createJob 查。runner.kind=agent 的作业投递到会话、不入队列
  const checkRunner = async (runner: Runner | undefined) => { if (runner?.kind === 'channel' && !(await listChannels(user.id)).some((c) => c.id === runner.channelId)) throw problems.notFound(); return runner; };
  const prep = async (projectId: string, runner: Runner | undefined, attachmentIds: unknown) => {
    await checkRunner(runner);
    const attachments = await resolveForMessage(projectId, attachmentIds as string[] | undefined);
    if (attachments.length && runner?.kind === 'model' && !driverSupportsVision(runner.driver)) throw problems.validation([{ path: 'runner', message: `「${runner.driver}」通道不支持参考图，换一个支持视觉的通道再发` }]);
    return { imageKeys: attachments.length ? attachments.map((x) => x.key) : undefined };
  };
  const runJob = async (projectId: string, input: CreateJobInput) => {
    const agent = (input.input as { runner?: Runner }).runner?.kind === 'agent';
    const r = await createJob({ user, projectId, input, idempotencyKey: idem(), requestId, runner: agent ? 'agent' : 'model' });
    return jobDto(r.job);
  };
  const runnerInput = runnerSchema.optional();
  const attachmentsInput = z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional();
  const componentsInput = z.array(z.string().uuid()).max(MAX_COMPONENT_TARGETS).optional();
  const coord = z.number().int().min(-1_000_000).max(1_000_000);

  // ---- 高层（Quilt 自己的模型通道，对标 Stitch）----
  server.registerTool('quilt.list_projects', { description: 'List the user\'s projects.' }, wrap(async () => { read(); return (await listProjects(user.id)).items; }));
  server.registerTool('quilt.create_project', { description: 'Create a project (mobile 390×844 or desktop 1280×800) with a seed-color-derived design system, or start from one of your design presets (presetId from quilt.list_design_presets).', inputSchema: { name: z.string().min(1).max(80), deviceType: z.enum(['mobile', 'desktop']), seedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), presetId: z.string().uuid().optional() } },
    wrap(async (a) => { write(); const r = await createProject(user.id, a as { name: string; deviceType: DeviceType; seedColor?: string; presetId?: string }); return { project: projectDto(r.project), designSystem: designSystemDto(r.designSystem) }; }));
  server.registerTool('quilt.get_project', { description: 'Project detail: screens (with routes, revision ids, preview/screenshot URLs), links (app map), active jobs.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { read(); return getProjectDetail(user.id, a.projectId as string); }));
  // 工具名保留为公开契约；内部映射到 v0.31 的 generate（count 缺省 auto = 规划器定屏数）
  // v0.51 与 REST 同义的全部选项：anchor 定摆放位置；route + name (+ fromScreenId) 是懒生成（跳过规划器）；runner 选通道；attachmentIds 是参考图；componentIds 把共享组件的完整 HTML 带进上下文
  server.registerTool('quilt.generate_screens', { description: 'Generate screens from a description using Quilt\'s server-side model: omit count to let the planner decide (4–6 for an empty project, a 2–6 screen sub-flow otherwise), or pass count 1–4. Options: anchor {x,y} centers the first new screen on that canvas point (the rest of the row goes to its right); route + name (+ fromScreenId as the reference screen) generates exactly that one missing screen without the planner; runner picks a channel (from quilt.list_runners; default = the account\'s default channel); attachmentIds are reference images (quilt.create_attachment_upload_url); componentIds put those shared components\' full HTML in context. Returns a job; poll quilt.get_job.', inputSchema: { projectId: z.string().uuid(), prompt: z.string().min(1).max(8000), count: z.number().int().min(1).max(4).optional(), versions: z.number().int().min(1).max(4).optional(), anchor: anchorSchema.optional(), route: routeSchema.optional(), name: z.string().trim().min(1).max(80).optional(), fromScreenId: z.string().uuid().optional(), runner: runnerInput, attachmentIds: attachmentsInput, componentIds: componentsInput } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const runner = a.runner as Runner | undefined; const { imageKeys } = await prep(project.id, runner, a.attachmentIds); return runJob(project.id, { kind: 'generate', input: { prompt: a.prompt as string, count: (a.count as number | undefined) ?? 'auto', versions: (a.versions as number | undefined) ?? 1, anchor: a.anchor as { x: number; y: number } | undefined, route: a.route as string | undefined, name: a.name as string | undefined, fromScreenId: a.fromScreenId as string | undefined, runner, imageKeys, componentIds: a.componentIds as string[] | undefined } }); }));
  server.registerTool('quilt.edit_screens', { description: 'Revise one or more screens with an instruction (server-side model). runner / attachmentIds / componentIds as in quilt.generate_screens. Returns a job.', inputSchema: { projectId: z.string().uuid(), screenIds: z.array(z.string().uuid()).min(1).max(20), prompt: z.string().min(1).max(8000), versions: z.number().int().min(1).max(4).optional(), runner: runnerInput, attachmentIds: attachmentsInput, componentIds: componentsInput } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const runner = a.runner as Runner | undefined; const { imageKeys } = await prep(project.id, runner, a.attachmentIds); return runJob(project.id, { kind: 'edit_screens', input: { prompt: a.prompt as string, screenIds: a.screenIds as string[], versions: (a.versions as number | undefined) ?? 1, runner, imageKeys, componentIds: a.componentIds as string[] | undefined } }); }));
  server.registerTool('quilt.list_revisions', { description: 'Revisions of a screen (newest first) with parentRevisionId and candidateIndex — candidates of one job are siblings; the screen\'s current revision is in quilt.get_project.', inputSchema: { screenId: z.string().uuid() } },
    wrap(async (a) => { read(); const { screen } = await ownedScreen(user.id, a.screenId as string); return listRevisions(screen.id); }));
  server.registerTool('quilt.get_job', { description: 'Job status/output (queued | running | succeeded | failed | cancelled).', inputSchema: { jobId: z.string().uuid() } },
    wrap(async (a) => { read(); const [row] = await db.select({ j: schema.generationJobs }).from(schema.generationJobs).innerJoin(schema.projects, eq(schema.projects.id, schema.generationJobs.projectId)).where(and(eq(schema.generationJobs.id, a.jobId as string), eq(schema.projects.ownerId, user.id))); if (!row) throw new Problem(404, '/errors/not-found', 'job not found'); return jobDto(row.j); }));
  // 项目大纲（REQ-CORE-023 / ADR-018）：每屏一份确定性结构摘要，聊天助手先看目录再决定读哪张整屏；本机会话同样可用
  server.registerTool('quilt.get_outline', { description: 'Structural outline of every screen (or just screenIds): landmarks, headings, links, buttons, inputs and images with their data-qid and text, at most 40 lines per screen. Read this before quilt.get_screen to decide which screens you actually need in full.', inputSchema: { projectId: z.string().uuid(), screenIds: z.array(z.string().uuid()).max(50).optional() } },
    wrap(async (a) => { read(); return projectOutline(user.id, a.projectId as string, a.screenIds as string[] | undefined); }));
  server.registerTool('quilt.get_screen', { description: 'Current HTML of a screen (with data-qid attributes).', inputSchema: { screenId: z.string().uuid() } },
    wrap(async (a) => { read(); const { screen } = await ownedScreen(user.id, a.screenId as string); if (!screen.currentRevisionId) return ''; const rev = await getRevision(screen.id, screen.currentRevisionId); return (await storage.get(rev.htmlKey)).toString('utf8'); }));
  server.registerTool('quilt.get_screenshot', { description: 'Screenshot (PNG) of a screen\'s current revision, returned as an image.', inputSchema: { screenId: z.string().uuid() } },
    wrap(async (a) => { read(); const { screen } = await ownedScreen(user.id, a.screenId as string); if (!screen.currentRevisionId) throw new Problem(404, '/errors/not-found', 'no revision'); const rev = await getRevision(screen.id, screen.currentRevisionId); if (!rev.screenshotKey) throw new Problem(409, '/errors/job-not-finished', 'screenshot not ready yet'); const png = await storage.get(rev.screenshotKey); return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] }; }));

  // ---- 底层原语（agent 自带模型）----
  server.registerTool('quilt.get_design_contract', { description: 'Machine-checkable design contract: tokens, allowed color classes, component recipes, shared components (place them by reference — see sharedComponents[].placement), rules, routes, DESIGN.md.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { read(); return designContract(user.id, a.projectId as string); }));
  // 改设计系统（v0.42）：此前 MCP 只能读契约——本机 agent 按截图手写了 42 屏却没法让画布的色板对齐真机，
  // 严格契约换来的「改一次 token、全部屏跟着变」在 MCP 侧根本兑现不了。applyToScreens 顺带发一次确定性回刷（零模型调用）
  server.registerTool('quilt.update_design_system', {
    description: 'Change this project\'s design system: seed color, font (fontFamily + fontSource google|system|url; fontUrl = an https stylesheet with @font-face when fontSource is url), radius scale, brand palette (exact hex per token key), color mode, DESIGN.md. Pass expectedVersion from quilt.get_design_contract. applyToScreens=true also re-bakes every existing screen with the new tokens (deterministic, no model calls) and returns the job.',
    inputSchema: {
      projectId: z.string().uuid(),
      expectedVersion: z.number().int().min(1),
      seedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      fontFamily: fontFamilySchema.optional(),
      fontSource: z.enum(FONT_SOURCES).optional(),
      fontUrl: fontUrlSchema.nullable().optional(),
      radiusScale: z.enum(['sharp', 'default', 'round']).optional(),
      palette: paletteSchema.nullable().optional(),
      colorMode: z.enum(COLOR_MODES).optional(),
      designMd: z.string().max(20000).optional(),
      // 约定节整体替换（v0.51）：quilt.propose_design_system 的产出经 agent 确认后从这里写回
      conventions: z.array(z.string().trim().min(1).max(300)).max(MAX_CONVENTIONS).optional(),
      applyToScreens: z.boolean().optional(),
    },
  }, wrap(async (a) => {
    write();
    const designSystem = await updateDesignSystem(user.id, a.projectId as string, {
      expectedVersion: a.expectedVersion as number,
      seedColor: a.seedColor as string | undefined,
      fontFamily: a.fontFamily as string | undefined,
      fontSource: a.fontSource as FontSource | undefined,
      fontUrl: a.fontUrl as string | null | undefined,
      radiusScale: a.radiusScale as 'sharp' | 'default' | 'round' | undefined,
      palette: a.palette as Palette | null | undefined,
      colorMode: a.colorMode as ColorMode | undefined,
      designMd: a.designMd as string | undefined,
      conventions: a.conventions as string[] | undefined,
    });
    if (!a.applyToScreens) return { designSystem, job: null };
    const r = await createJob({ user, projectId: a.projectId as string, input: { kind: 'apply_design_system', input: { screenIds: 'all' } }, idempotencyKey: idem(), requestId });
    return { designSystem, job: jobDto(r.job) };
  }));
  // 改项目名与应用简介（v0.42）：brief 进每次生成的 prompt，建完才发现写错时此前无从修改
  server.registerTool('quilt.update_project', {
    description: 'Rename the project, rewrite its brief, or set the exemplar screen (exemplarScreenId: the style anchor every generation matches; null = back to the default). The brief goes into every generation prompt, so a wrong one skews everything Quilt generates.',
    inputSchema: { projectId: z.string().uuid(), name: z.string().trim().min(1).max(80).optional(), brief: z.string().max(2000).optional(), exemplarScreenId: z.string().uuid().nullable().optional() },
  }, wrap(async (a) => {
    write();
    if (a.name === undefined && a.brief === undefined && a.exemplarScreenId === undefined) throw problems.validation([{ path: 'name', message: 'nothing to change' }]);
    return projectDto(await updateProject(user.id, a.projectId as string, { name: a.name as string | undefined, brief: a.brief as string | undefined, exemplarScreenId: a.exemplarScreenId as string | null | undefined }));
  }));
  // 共享组件（v0.46 REQ-EDIT-006）：本机 agent 也能建 / 改项目级组件；改完所有用它的屏确定性回刷（零模型调用）
  server.registerTool('quilt.create_component', {
    description: 'Create a shared component: a project-level HTML fragment (tab bar, app bar, sidebar, footer…) that screens place by reference with <tag data-component="Name"></tag> and Quilt fills in on every write. html = one root element, no <script>/<style>; per-screen content goes in data-slot="…" elements; for navigation mark the active link with aria-current="page". Returns the component (see quilt.get_design_contract → sharedComponents for placement).',
    inputSchema: { projectId: z.string().uuid(), name: componentNameSchema, html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES) },
  }, wrap(async (a) => { write(); return createComponent(user.id, a.projectId as string, { name: a.name as string, html: a.html as string }); }));
  server.registerTool('quilt.update_component', {
    description: 'Replace a shared component\'s HTML (and/or rename it). Every screen that places it is re-baked deterministically — returns applied (screen ids) and skipped (screens with a running job; they pick up the new version when that job lands). expectedVersion comes from sharedComponents[] in quilt.get_design_contract; 409 version-conflict when stale.',
    inputSchema: { componentId: z.string().uuid(), html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES).optional(), name: componentNameSchema.optional(), expectedVersion: z.number().int().min(1) },
  }, wrap(async (a) => { write(); return updateComponent(user.id, a.componentId as string, { html: a.html as string | undefined, name: a.name as string | undefined, expectedVersion: a.expectedVersion as number }); }));
  server.registerTool('quilt.validate_screen', { description: 'Check screen HTML against the design contract without saving. Returns deviations (advisory — they never block a write) and dangling routes.', inputSchema: { projectId: z.string().uuid(), html: z.string().min(1) } },
    wrap(async (a) => { read(); return validateScreenHtml(user.id, a.projectId as string, a.html as string); }));
  server.registerTool('quilt.create_screen', { description: 'Push your own HTML as a new screen. Server injects data-qid + design tokens, records any contract deviations (never rejected), stores a revision and screenshots it. Pass jobId (given in the prompt when Quilt launched you) so the revision counts as that job\'s output.', inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(80), route: z.string().regex(/^\/[a-z0-9-]*(\/[a-z0-9-]+)*$/), html: z.string().optional(), uploadId: z.string().optional(), jobId: z.string().uuid().optional() } },
    wrap(async (a) => { write(); return ingestScreen(user.id, a.projectId as string, { name: a.name as string, route: a.route as string, html: a.html as string | undefined, uploadId: a.uploadId as string | undefined, jobId: a.jobId as string | undefined }); }));
  // v0.51：name / route 可选——只换 HTML 不必重传它们，缺省沿用该屏当前值
  server.registerTool('quilt.update_screen', { description: 'Replace an existing screen\'s HTML (new revision); name and route are optional and default to the screen\'s current ones. expectedRevisionId guards against concurrent edits and is REQUIRED when jobId is given (use the revision id from the prompt or quilt.get_project; on 409 call quilt.get_screen and redo on the current version).', inputSchema: { projectId: z.string().uuid(), screenId: z.string().uuid(), name: z.string().min(1).max(80).optional(), route: z.string().optional(), html: z.string().optional(), uploadId: z.string().optional(), expectedRevisionId: z.string().uuid().optional(), jobId: z.string().uuid().optional() } },
    wrap(async (a) => { write(); const { screen } = await ownedScreen(user.id, a.screenId as string); return ingestScreen(user.id, a.projectId as string, { name: (a.name as string | undefined) ?? screen.name, route: (a.route as string | undefined) ?? screen.route, html: a.html as string | undefined, uploadId: a.uploadId as string | undefined, screenId: screen.id, expectedRevisionId: a.expectedRevisionId as string | undefined, jobId: a.jobId as string | undefined }); }));
  server.registerTool('quilt.create_upload_url', { description: 'For HTML larger than ~64 KB: get a signed PUT URL, upload the HTML, then pass uploadId to create_screen/update_screen.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const { randomToken, signObject } = await import('../lib/signing.ts'); const uploadId = randomToken(16); const exp = Math.floor(Date.now() / 1000) + 600; return { uploadId, putUrl: `${config.apiOrigin}/v1/uploads/${uploadId}?exp=${exp}&sig=${signObject(`uploads/${uploadId}.html`, exp)}`, projectId: project.id }; }));
  server.registerTool('quilt.link_screens', { description: 'Resolve a dangling link by giving an existing screen the route that other screens link to.', inputSchema: { screenId: z.string().uuid(), route: z.string().regex(/^\/[a-z0-9-]*(\/[a-z0-9-]+)*$/) } },
    wrap(async (a) => { write(); const { screen, project } = await ownedScreen(user.id, a.screenId as string); const { deriveLinks } = await import('../services/screens.ts'); await db.transaction(async (tx) => { await tx.update(schema.screens).set({ route: a.route as string, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id)); await deriveLinks(tx, project.id); }); return { screenId: screen.id, route: a.route }; }));
  // 投递到本机会话的作业由会话自己收口（REQ-AGENT-003 v0.34）：只认 running 的 agent 作业，取消 / 已结束的一律 409
  server.registerTool('quilt.finish_job', { description: 'Close a job that the Quilt canvas delivered to this session (the jobId is in the delivered prompt). Call it once when you are done: status "succeeded" (default) with a one-line summary, or "failed" with the reason. Quilt keeps the job open until this call.', inputSchema: { jobId: z.string().uuid(), status: z.enum(['succeeded', 'failed']).optional(), summary: z.string().max(2000).optional() } },
    wrap(async (a) => {
      write();
      const job = await ownedJob(user.id, a.jobId as string);
      if (job.runner !== 'agent' || job.status !== 'running') throw problems.jobFinished();
      const failed = a.status === 'failed';
      const summary = (a.summary as string | undefined)?.trim() || undefined;
      const done = await finishAgentJob(job, failed ? 'failed' : 'succeeded', { summary, ...(failed ? { errorClass: 'agent', message: summary ?? '会话报告未完成' } : {}) });
      if (!done) throw problems.jobFinished();
      return { jobId: job.id, status: failed ? 'failed' : 'succeeded' };
    }));
  server.registerTool('quilt.get_app_map', { description: 'Routes and links between screens; toScreenId null = dangling link.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { read(); const project = await ownedProject(user.id, a.projectId as string); const screens = await db.select({ screenId: schema.screens.id, route: schema.screens.route, name: schema.screens.name, purpose: schema.screens.purpose }).from(schema.screens).where(eq(schema.screens.projectId, project.id)); const links = await db.select().from(schema.links).where(eq(schema.links.projectId, project.id)); return { nodes: screens, edges: links.map((l) => ({ fromScreenId: l.fromScreenId, qid: l.elementQid, href: l.href, toScreenId: l.toScreenId })) }; }));

  // ---- 与画布同面（v0.51 REQ-AGENT-002）：画布能做的每一件事都有工具，只有通道的增删改（含密钥）留在设置页 ----
  // 删：与 API-CORE-018 / API-EDIT-004 DELETE / API-CORE-031 同一套守卫；MCP 侧没有二次确认，不可逆写进工具说明
  server.registerTool('quilt.delete_screen', { description: 'Delete a screen (irreversible). 409 screen-busy while a job is running on it; the app map is re-derived afterwards.', inputSchema: { screenId: z.string().uuid() } },
    wrap(async (a) => { write(); const { screen, project } = await ownedScreen(user.id, a.screenId as string); await db.transaction(async (tx) => { if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy(); await tx.delete(schema.screens).where(eq(schema.screens.id, screen.id)); await clearExemplarIfDeleted(tx, project.id, screen.id); await deriveLinks(tx, project.id); }); return { screenId: screen.id, deleted: true }; }));
  server.registerTool('quilt.delete_component', { description: 'Delete a shared component. Screens keep the HTML already expanded in them; it just stops following the component.', inputSchema: { componentId: z.string().uuid() } },
    wrap(async (a) => { write(); await deleteComponent(user.id, a.componentId as string); return { componentId: a.componentId, deleted: true }; }));
  server.registerTool('quilt.delete_project', { description: 'Delete a project and everything in it (screens, revisions, jobs, messages, assets, components). Irreversible and unconfirmed — 409 project-busy while any job is queued or running.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { write(); await deleteProject(user.id, a.projectId as string); return { projectId: a.projectId, deleted: true }; }));
  // 修订：取旧版 HTML（直接给文本，agent 拿到就能重推）、回溯、采用候选（单屏 / 整组）、列候选——API-CORE-014 / 015 / 025 / 026
  server.registerTool('quilt.get_revision', { description: 'One revision of a screen: metadata (seq, parentRevisionId, candidateIndex, lintReport) plus its full HTML — enough to push it back with quilt.update_screen.', inputSchema: { screenId: z.string().uuid(), revisionId: z.string().uuid() } },
    wrap(async (a) => { read(); const { screen } = await ownedScreen(user.id, a.screenId as string); const rev = await getRevision(screen.id, a.revisionId as string); return { revision: await revisionDto(rev), html: (await storage.get(rev.htmlKey)).toString('utf8') }; }));
  server.registerTool('quilt.restore_revision', { description: 'Roll a screen back to an earlier revision: creates a new revision (source_kind=restore) with that content and makes it current. expectedRevisionId must be the screen\'s current revision (409 revision-conflict otherwise); 409 screen-busy while a job runs on it.', inputSchema: { screenId: z.string().uuid(), revisionId: z.string().uuid(), expectedRevisionId: z.string().uuid() } },
    wrap(async (a) => {
      write();
      const { screen, project } = await ownedScreen(user.id, a.screenId as string);
      const source = await getRevision(screen.id, a.revisionId as string);
      const html = (await storage.get(source.htmlKey)).toString('utf8');
      const rev = await db.transaction(async (tx) => {
        if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
        const r = await createRevision(tx, { projectId: project.id, screenId: screen.id, html, sourceKind: 'restore', lintReport: source.lintReport, expectedRevisionId: a.expectedRevisionId as string });
        if (!r) throw problems.revisionConflict();
        if (source.screenshotKey) await tx.update(schema.screenRevisions).set({ screenshotKey: source.screenshotKey }).where(eq(schema.screenRevisions.id, r.id));
        await deriveLinks(tx, project.id);
        return { ...r, screenshotKey: source.screenshotKey };
      });
      if (!rev.screenshotKey) await enqueueScreenshot(rev.id);
      return { revision: await revisionDto(rev) };
    }));
  server.registerTool('quilt.list_candidates', { description: 'Candidate revisions a job produced, grouped by screen (index = version number, settled = a version was adopted).', inputSchema: { jobId: z.string().uuid() } },
    wrap(async (a) => { read(); const job = await ownedJob(user.id, a.jobId as string); return listCandidates(await ownedProject(user.id, job.projectId), job.id); }));
  server.registerTool('quilt.adopt_candidate', { description: 'Make one candidate revision the screen\'s current version and settle its batch (no new revision, no model call). 409 revision-conflict if the screen was edited on top of another version since; 409 screen-busy while a job runs on it.', inputSchema: { screenId: z.string().uuid(), revisionId: z.string().uuid() } },
    wrap(async (a) => { write(); const { screen, project } = await ownedScreen(user.id, a.screenId as string); await db.transaction(async (tx) => { await adoptCandidate(tx, screen, a.revisionId as string); await deriveLinks(tx, project.id); }); const [updated] = await db.select().from(schema.screens).where(eq(schema.screens.id, screen.id)); return { screen: (await screenDtos(project, [updated]))[0] }; }));
  server.registerTool('quilt.adopt_candidates', { description: 'Adopt version `index` (0-based) on every screen a job produced candidates for. Per-screen success: screens without that index, edited since, or busy are listed in skipped — read adopted/skipped, do not treat the call as all-or-nothing.', inputSchema: { jobId: z.string().uuid(), index: z.number().int().min(0).max(MAX_VERSIONS - 1) } },
    wrap(async (a) => {
      write();
      const job = await ownedJob(user.id, a.jobId as string);
      const project = await ownedProject(user.id, job.projectId);
      const cands = await listCandidates(project, job.id);
      const adopted: string[] = []; const skipped: string[] = [];
      for (const s of cands.screens) {
        const rev = s.revisions.find((r) => r.index === a.index);
        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, s.screenId));
        if (!rev || !screen) { skipped.push(s.screenId); continue; }
        try { await db.transaction((tx) => adoptCandidate(tx, screen, rev.id)); adopted.push(s.screenId); }
        catch (e) { if (e instanceof Problem) skipped.push(s.screenId); else throw e; }
      }
      if (adopted.length) await db.transaction((tx) => deriveLinks(tx, project.id));
      return { adopted, skipped };
    }));
  // 摆放：屏走 API-CORE-012 的 x / y，组件走 API-EDIT-004 PATCH 只挪位置（不升版不回刷）；逐张成败，与画布批量移动同一条路径
  const posSchema = z.object({ id: z.string().uuid(), x: coord, y: coord });
  server.registerTool('quilt.move_screens', { description: 'Place screens and shared components on the canvas (world coordinates, integer px; a mobile screen is 390×844, desktop 1280×800). Each item is written on its own: failures are reported per id, the rest still move.', inputSchema: { screens: z.array(posSchema).max(200).optional(), components: z.array(posSchema).max(50).optional() } },
    wrap(async (a) => {
      write();
      const moved = { screens: [] as string[], components: [] as string[] };
      const failed: { id: string; error: string }[] = [];
      const attempt = async (id: string, into: string[], fn: () => Promise<unknown>) => { try { await fn(); into.push(id); } catch (e) { failed.push({ id, error: e instanceof Problem ? e.type : (e as Error).message }); } };
      type Pos = { id: string; x: number; y: number };
      for (const s of (a.screens as Pos[] | undefined) ?? []) await attempt(s.id, moved.screens, async () => { const { screen } = await ownedScreen(user.id, s.id); await db.update(schema.screens).set({ x: s.x, y: s.y, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id)); });
      for (const c of (a.components as Pos[] | undefined) ?? []) await attempt(c.id, moved.components, () => updateComponent(user.id, c.id, { x: c.x, y: c.y }));
      return { moved, failed };
    }));
  // 元素直改（API-EDIT-001）：零 token，确定性 DOM 变换落新修订；共享组件实例里只放行 detach
  server.registerTool('quilt.edit_element', { description: 'Zero-token direct edit of one element (by data-qid): ops text | classes | style | link (route or null) | remove | detach. Deterministic DOM change → new revision (source_kind=manual). 409 component-locked inside a shared component instance (only detach is allowed there); 409 revision-conflict on a stale expectedRevisionId.', inputSchema: { screenId: z.string().uuid(), qid: z.string().regex(/^q\d+$/), ops: z.array(elementOpSchema).min(1).max(10), expectedRevisionId: z.string().uuid() } },
    wrap(async (a) => { write(); return { revision: await applyElementEdit(user.id, a.screenId as string, a.qid as string, a.ops as ElementOp[], a.expectedRevisionId as string) }; }));
  // 其余四种作业（API-CORE-006）：子树重生成、AI 改组件、提炼约定（产出给 agent 自己确认）、导出原型
  server.registerTool('quilt.regenerate_subtree', { description: 'AI-rewrite one element subtree (by data-qid) with an instruction; siblings keep their qids. expectedRevisionId must be current. Returns a job.', inputSchema: { screenId: z.string().uuid(), qid: z.string().regex(/^q\d+$/), prompt: z.string().min(1).max(4000), expectedRevisionId: z.string().uuid(), runner: runnerInput } },
    wrap(async (a) => { write(); const { screen, project } = await ownedScreen(user.id, a.screenId as string); const runner = await checkRunner(a.runner as Runner | undefined); return runJob(project.id, { kind: 'regenerate_subtree', input: { screenId: screen.id, qid: a.qid as string, prompt: a.prompt as string, expectedRevisionId: a.expectedRevisionId as string, runner } }); }));
  server.registerTool('quilt.edit_component', { description: 'AI-revise a shared component with an instruction (one model call), then re-bake every screen that places it. Returns a job. runner.kind=agent is not accepted here — use quilt.update_component to write the HTML yourself.', inputSchema: { componentId: z.string().uuid(), prompt: z.string().min(1).max(8000), runner: runnerInput, attachmentIds: attachmentsInput } },
    wrap(async (a) => { write(); const { component, project } = await ownedComponent(user.id, a.componentId as string); const runner = a.runner as Runner | undefined; if (runner?.kind === 'agent') throw problems.validation([{ path: 'runner', message: '改组件请换一个模型通道，本机会话不接这类作业' }]); const { imageKeys } = await prep(project.id, runner, a.attachmentIds); return runJob(project.id, { kind: 'edit_component', input: { componentId: component.id, prompt: a.prompt as string, runner, imageKeys } }); }));
  server.registerTool('quilt.propose_design_system', { description: 'Ask the model to distil an instruction (optionally with one revised screen as the example) into absolute design conventions and token changes. Returns a job; the proposal is in output.proposal { summary, conventions[], tokens?, regenerate } — review it, then write what you accept with quilt.update_design_system (conventions, seedColor, fontFamily, radiusScale).', inputSchema: { projectId: z.string().uuid(), instruction: z.string().min(1).max(4000), screenId: z.string().uuid().optional(), runner: runnerInput } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const runner = await checkRunner(a.runner as Runner | undefined); return runJob(project.id, { kind: 'propose_design_system', input: { instruction: a.instruction as string, screenId: a.screenId as string | undefined, runner } }); }));
  server.registerTool('quilt.export_prototype', { description: 'Build a single offline HTML prototype of all screens (hash routing, no model calls). Returns a job; when it succeeds call quilt.get_export for the download URL.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); return runJob(project.id, { kind: 'export_prototype', input: {} }); }));
  server.registerTool('quilt.get_export', { description: 'Download URL (signed, 5 minutes) and size of a finished export_prototype job; 409 job-not-finished before that.', inputSchema: { jobId: z.string().uuid() } },
    wrap(async (a) => { read(); const job = await ownedJob(user.id, a.jobId as string); const key = (job.output as { exportKey?: string } | null)?.exportKey; if (job.kind !== 'export_prototype' || job.status !== 'succeeded' || !key) throw problems.jobNotFinished(); const body = await storage.get(key); return { jobId: job.id, url: await storage.signedUrl(key), bytes: body.byteLength }; }));
  // 通道目录（API-CORE-023，响应不含密钥）与参考图直传（API-CORE-019）：给 runner / attachmentIds 两个字段取值
  server.registerTool('quilt.list_runners', { description: 'Generation channels this account can use: id, label, available, vision and the `runner` object to pass to generate_screens / edit_screens / regenerate_subtree / edit_component / propose_design_system. `default` is what jobs use when you pass no runner. Never includes keys.' },
    wrap(async () => { read(); return runnerCatalog(user); }));
  server.registerTool('quilt.create_attachment_upload_url', { description: 'Reference image for generate_screens / edit_screens / edit_component: returns a signed PUT URL (10 minutes; png | jpeg | webp, ≤ 5 MB). PUT the raw bytes there, then pass attachmentId in attachmentIds.', inputSchema: { projectId: z.string().uuid(), mediaType: z.enum(IMAGE_MEDIA_TYPES), bytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES) } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const u = await createUpload(project.id, { mediaType: a.mediaType as string, bytes: a.bytes as number }); return { ...u, putUrl: `${config.apiOrigin}${u.putUrl}` }; }));
  // 作业管理：列表 / 取消 / 事件（API-CORE-029 / 009 / 008——拉取式，不是 SSE）
  server.registerTool('quilt.list_jobs', { description: 'Jobs of a project, newest first (default 50). runner filters model | agent.', inputSchema: { projectId: z.string().uuid(), runner: z.enum(JOB_RUNNERS).optional(), limit: z.number().int().min(1).max(100).optional() } },
    wrap(async (a) => { read(); const project = await ownedProject(user.id, a.projectId as string); return { items: (await listJobs(project.id, { runner: a.runner as JobRunner | undefined, limit: (a.limit as number | undefined) ?? 50 })).map(jobDto) }; }));
  server.registerTool('quilt.cancel_job', { description: 'Cancel a queued or running job (409 job-finished if it already ended). Revisions it already wrote stay.', inputSchema: { jobId: z.string().uuid() } },
    wrap(async (a) => { write(); return { job: jobDto(await cancelJob(await ownedJob(user.id, a.jobId as string))) }; }));
  server.registerTool('quilt.get_job_events', { description: 'Events of a job with seq > after (screen_planned | screen_html_ready | screen_screenshot_ready | progress | succeeded | failed | cancelled). Pull-style: pass the last seq you saw.', inputSchema: { jobId: z.string().uuid(), after: z.number().int().min(0).optional() } },
    wrap(async (a) => { read(); const job = await ownedJob(user.id, a.jobId as string); return { items: (await listJobEvents(job.id, (a.after as number | undefined) ?? 0)).map((e) => ({ seq: e.seq, type: e.type, data: e.data, at: e.createdAt.toISOString() })) }; }));
  // 素材（API-CORE-032）：create 读服务端本机文件——MCP 与 Quilt 同机是本地版前提（ADR-016）；不走 multipart 也不收 base64
  server.registerTool('quilt.list_assets', { description: 'Project assets (logos, illustrations) with their stable preview-origin URLs — the same list as assets[] in the design contract.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { read(); return { items: await listAssets(user.id, a.projectId as string) }; }));
  server.registerTool('quilt.create_asset', { description: 'Upload a project asset from a file on this machine (Quilt runs locally, so the absolute path is read server-side): svg | png | jpeg | webp by content, ≤ 5 MB, ≤ 50 per project. Returns the asset with the URL to use in screens.', inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(80).optional() } },
    wrap(async (a) => {
      write();
      const p = a.path as string;
      if (!path.isAbsolute(p)) throw problems.validation([{ path: 'path', message: 'path must be absolute' }]);
      let body: Buffer;
      try { body = await readFile(p); } catch { throw new Problem(404, '/errors/not-found', `file not found: ${p}`); }
      return { asset: await createAsset(user.id, a.projectId as string, { name: (a.name as string | undefined) ?? path.basename(p), body }) };
    }));
  server.registerTool('quilt.delete_asset', { description: 'Delete a project asset. Revisions that already reference its URL will show a broken image.', inputSchema: { assetId: z.string().uuid() } },
    wrap(async (a) => { write(); await deleteAsset(user.id, a.assetId as string); return { assetId: a.assetId, deleted: true }; }));
  // 设计预设（API-CORE-033）：账号级，跨项目复用一套视觉
  server.registerTool('quilt.list_design_presets', { description: 'Account-level design presets (seed color, font, radius, palette, DESIGN.md, asset copies) reusable across projects.' },
    wrap(async () => { read(); return { items: await listPresets(user.id) }; }));
  server.registerTool('quilt.create_design_preset', { description: 'Snapshot a project\'s design system (its inputs, not computed tokens) as a preset; includeAssets (default true) copies its assets too.', inputSchema: { projectId: z.string().uuid(), name: z.string().trim().min(1).max(80), includeAssets: z.boolean().optional() } },
    wrap(async (a) => { write(); return { preset: await createPreset(user.id, { projectId: a.projectId as string, name: a.name as string, includeAssets: a.includeAssets as boolean | undefined }) }; }));
  server.registerTool('quilt.apply_design_preset', { description: 'Write a preset into a project\'s design system (tokens recomputed, preset assets copied in as new assets). expectedVersion from quilt.get_design_contract (409 version-conflict when stale); applyToScreens=true also re-bakes every screen and returns that job.', inputSchema: { projectId: z.string().uuid(), presetId: z.string().uuid(), expectedVersion: z.number().int().min(1), applyToScreens: z.boolean().optional() } },
    wrap(async (a) => { write(); const project = await ownedProject(user.id, a.projectId as string); const { assetsCopied, skipped } = await applyPreset(user.id, project.id, { presetId: a.presetId as string, expectedVersion: a.expectedVersion as number }); const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id)); const job = a.applyToScreens ? await runJob(project.id, { kind: 'apply_design_system', input: { screenIds: 'all' } }) : null; return { designSystem: designSystemDto(ds), assetsCopied, skipped, job }; }));
  server.registerTool('quilt.delete_design_preset', { description: 'Delete a preset (projects that already applied it are unaffected).', inputSchema: { presetId: z.string().uuid() } },
    wrap(async (a) => { write(); await deletePreset(user.id, a.presetId as string); return { presetId: a.presetId, deleted: true }; }));
  // 批注（API-EDIT-003）：列 / 改 / 删 / 发送；不提供建——气泡 rect 要在画布里量，agent 给不出
  server.registerTool('quilt.list_annotations', { description: 'Element annotations the user left on screens. With screenId: every annotation of that screen (any status); with projectId only: the unresolved ones (open | sent) across the project.', inputSchema: { projectId: z.string().uuid(), screenId: z.string().uuid().optional() } },
    wrap(async (a) => { read(); const project = await ownedProject(user.id, a.projectId as string); return { items: a.screenId ? await annotations.listForScreen(user.id, a.screenId as string) : await annotations.listOpenForProject(project.id) }; }));
  server.registerTool('quilt.update_annotation', { description: 'Edit an annotation\'s note or status (open | sent | resolved) — e.g. mark it resolved after you applied it yourself.', inputSchema: { annotationId: z.string().uuid(), note: z.string().trim().min(1).max(2000).optional(), status: z.enum(ANNOTATION_STATUSES).optional() } },
    wrap(async (a) => { write(); if (a.note === undefined && a.status === undefined) throw problems.validation([{ path: 'note', message: 'note or status required' }]); return { annotation: await annotations.update(user.id, a.annotationId as string, { note: a.note as string | undefined, status: a.status as string | undefined }) }; }));
  server.registerTool('quilt.delete_annotation', { description: 'Delete an annotation.', inputSchema: { annotationId: z.string().uuid() } },
    wrap(async (a) => { write(); await annotations.remove(user.id, a.annotationId as string); return { annotationId: a.annotationId, deleted: true }; }));
  server.registerTool('quilt.send_annotations', { description: 'Send annotations to the server-side model: one edit_screens job per screen; they become sent, then resolved when the job succeeds.', inputSchema: { projectId: z.string().uuid(), annotationIds: z.array(z.string().uuid()).min(1).max(50) } },
    wrap(async (a) => { write(); const { jobs } = await annotations.send(user, a.projectId as string, a.annotationIds as string[], requestId); return { jobs: jobs.map(jobDto) }; }));
  // 对话记录（API-CORE-011）：游标分页，同一时间戳助手排在用户之前（倒序取、再 reverse 后用户在前）
  server.registerTool('quilt.list_messages', { description: 'Conversation of a project: user prompts and assistant receipts (with jobId / affectedScreenIds), oldest first within the page. For older pages pass nextCursor as cursor.', inputSchema: { projectId: z.string().uuid(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } },
    wrap(async (a) => {
      read();
      const project = await ownedProject(user.id, a.projectId as string);
      const limit = (a.limit as number | undefined) ?? 50;
      const where = a.cursor ? and(eq(schema.messages.projectId, project.id), lt(schema.messages.createdAt, new Date(a.cursor as string))) : eq(schema.messages.projectId, project.id);
      const rows = await db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.createdAt), asc(schema.messages.role)).limit(limit + 1);
      const page = rows.slice(0, limit).reverse();
      return { items: await Promise.all(page.map((m) => messageDto(m))), nextCursor: rows.length > limit ? rows[limit - 1].createdAt.toISOString() : null };
    }));

  // ---- resources ----
  const text = (uri: string, mime: string, body: string) => ({ contents: [{ uri, mimeType: mime, text: body }] });
  server.registerResource('design-md', new ResourceTemplate('quilt://projects/{projectId}/design.md', { list: undefined }), { title: 'DESIGN.md', description: 'Project design system document', mimeType: 'text/markdown' },
    async (uri, vars) => { read(); const c = await designContract(user.id, String(vars.projectId)); return text(uri.href, 'text/markdown', c.designMd); });
  server.registerResource('tokens', new ResourceTemplate('quilt://projects/{projectId}/tokens.json', { list: undefined }), { title: 'tokens.json', mimeType: 'application/json' },
    async (uri, vars) => { read(); const c = await designContract(user.id, String(vars.projectId)); return text(uri.href, 'application/json', JSON.stringify({ tokens: c.tokens, colorClasses: c.colorClasses, components: c.components }, null, 2)); });
  server.registerResource('app-map', new ResourceTemplate('quilt://projects/{projectId}/app-map.json', { list: undefined }), { title: 'app-map.json', mimeType: 'application/json' },
    async (uri, vars) => { read(); const project = await ownedProject(user.id, String(vars.projectId)); const screens = await db.select({ screenId: schema.screens.id, route: schema.screens.route, name: schema.screens.name }).from(schema.screens).where(eq(schema.screens.projectId, project.id)); const links = await db.select().from(schema.links).where(eq(schema.links.projectId, project.id)); return text(uri.href, 'application/json', JSON.stringify({ nodes: screens, edges: links.map((l) => ({ fromScreenId: l.fromScreenId, href: l.href, toScreenId: l.toScreenId })) }, null, 2)); });
  // 样板屏（REQ-CORE-016）：用户钦定的 exemplarScreenId，没钦定就回落到最早 lint 通过的屏
  server.registerResource('golden', new ResourceTemplate('quilt://projects/{projectId}/golden', { list: undefined }), { title: 'Exemplar screen', description: 'The project\'s exemplar screen (style anchor) to match density and rhythm', mimeType: 'text/html' },
    async (uri, vars) => { read(); const project = await ownedProject(user.id, String(vars.projectId)); const ex = await exemplarBody(project); return text(uri.href, 'text/html', ex?.body ?? ''); });
  server.registerResource('screen-html', new ResourceTemplate('quilt://projects/{projectId}/screens/{screenId}/html', { list: undefined }), { title: 'Screen HTML', mimeType: 'text/html' },
    async (uri, vars) => { read(); const { screen } = await ownedScreen(user.id, String(vars.screenId)); if (!screen.currentRevisionId) return text(uri.href, 'text/html', ''); const rev = await getRevision(screen.id, screen.currentRevisionId); return text(uri.href, 'text/html', (await storage.get(rev.htmlKey)).toString('utf8')); });
  server.registerResource('screen-screenshot', new ResourceTemplate('quilt://projects/{projectId}/screens/{screenId}/screenshot', { list: undefined }), { title: 'Screen screenshot', mimeType: 'image/png' },
    async (uri, vars) => { read(); const { screen } = await ownedScreen(user.id, String(vars.screenId)); if (!screen.currentRevisionId) throw new Problem(404, '/errors/not-found', 'no revision'); const rev = await getRevision(screen.id, screen.currentRevisionId); if (!rev.screenshotKey) throw new Problem(409, '/errors/job-not-finished', 'screenshot not ready'); return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: (await storage.get(rev.screenshotKey)).toString('base64') }] }; });
  server.registerResource('attachment', new ResourceTemplate('quilt://projects/{projectId}/attachments/{attachmentId}', { list: undefined }), { title: 'Reference image', description: 'A reference image the user attached to a canvas message (REQ-CORE-012)', mimeType: 'image/png' },
    async (uri, vars) => { read(); await ownedProject(user.id, String(vars.projectId)); const found = await locateAttachment(String(vars.projectId), String(vars.attachmentId)); if (!found) throw new Problem(404, '/errors/not-found', 'attachment not found'); return { contents: [{ uri: uri.href, mimeType: found.mediaType, blob: found.buf.toString('base64') }] }; });

  // ---- prompts ----
  const prompt = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });
  server.registerPrompt('quilt.new-screen', { description: 'Write a new screen for a project with your own model', argsSchema: { projectId: z.string(), route: z.string(), brief: z.string() } },
    (a) => prompt(`Read quilt://projects/${a.projectId}/design.md, tokens.json, app-map.json and golden. Write the screen for route ${a.route}: ${a.brief}. Default to the contract from quilt.get_design_contract — its tokens and recipes are this project's shared vocabulary, not a gate; where the design needs something they cannot express, write it directly and accept that hardcoded values will not follow a later theme change. quilt.validate_screen tells you which deviations you are taking; then quilt.create_screen.`));
  server.registerPrompt('quilt.sync-from-canvas', { description: 'Pull the latest screens into the codebase', argsSchema: { projectId: z.string() } },
    (a) => prompt(`Call quilt.get_project for ${a.projectId}; for each screen fetch quilt.get_screen and implement/update the corresponding component in this repo, keeping data-qid values as comments for future sync.`));
  server.registerPrompt('quilt.audit-drift', { description: 'Compare code against the canvas and report drift', argsSchema: { projectId: z.string() } },
    (a) => prompt(`Compare each screen in project ${a.projectId} (quilt.get_screen) with its implementation in this repo. Report layout/color/copy drift per screen and propose fixes.`));
  return server;
}
