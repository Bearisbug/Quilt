import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { Problem, problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { locateAttachment } from '../services/attachments.ts';
import { createJob, ownedJob } from '../services/jobs.ts';
import { finishAgentJob } from '../worker/agentDelivery.ts';
import { updateDesignSystem } from '../services/edit.ts';
import { createProject, getProjectDetail, listProjects, jobDto, ownedProject, projectDto, designSystemDto, updateProject } from '../services/projects.ts';
import { ownedScreen, getRevision, listRevisions, exemplarBody, projectOutline } from '../services/screens.ts';
import { ingestScreen, validateScreenHtml, designContract } from '../services/ingest.ts';
import { createComponent, updateComponent } from '../services/components.ts';
import { COLOR_MODES, FONT_SOURCES, fontFamilySchema, fontUrlSchema, paletteSchema, componentNameSchema, MAX_COMPONENT_HTML_BYTES, type ColorMode, type DeviceType, type FontSource, type Palette } from '@quilt/core';
import type { UserRow } from '../services/user.ts';

// MCP server（API-AGENT-002）：每请求无状态构建；工具/资源/提示词都是 REST 服务层的投影。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分。
export function buildMcpServer(user: UserRow): McpServer {
  const server = new McpServer({ name: 'quilt', version: '0.1.0' }, { instructions: 'Quilt is an infinite-canvas AI design tool. Use quilt.get_design_contract before writing HTML yourself; quilt.validate_screen reports deviations from it without saving (advisory — a write is never rejected for them); push with quilt.create_screen / quilt.update_screen. Long-running generation tools return a job — poll quilt.get_job. When the Quilt canvas delivered a job to this session, pass that jobId on every create/update call and close it with quilt.finish_job when done.' });
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

  // ---- 高层（Quilt 自己的模型通道，对标 Stitch）----
  server.registerTool('quilt.list_projects', { description: 'List the user\'s projects.' }, wrap(async () => { read(); return (await listProjects(user.id)).items; }));
  server.registerTool('quilt.create_project', { description: 'Create a project (mobile 390×844 or desktop 1280×800) with a seed-color-derived design system.', inputSchema: { name: z.string().min(1).max(80), deviceType: z.enum(['mobile', 'desktop']), seedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() } },
    wrap(async (a) => { write(); const r = await createProject(user.id, a as { name: string; deviceType: DeviceType; seedColor?: string }); return { project: projectDto(r.project), designSystem: designSystemDto(r.designSystem) }; }));
  server.registerTool('quilt.get_project', { description: 'Project detail: screens (with routes, revision ids, preview/screenshot URLs), links (app map), active jobs.', inputSchema: { projectId: z.string().uuid() } },
    wrap(async (a) => { read(); return getProjectDetail(user.id, a.projectId as string); }));
  // 工具名保留为公开契约；内部映射到 v0.31 的 generate（count 缺省 auto = 规划器定屏数）
  server.registerTool('quilt.generate_screens', { description: 'Generate screens from a description using Quilt\'s server-side model: omit count to let the planner decide (4–6 for an empty project, a 2–6 screen sub-flow otherwise), or pass count 1–4. Returns a job; poll quilt.get_job.', inputSchema: { projectId: z.string().uuid(), prompt: z.string().min(1).max(8000), count: z.number().int().min(1).max(4).optional(), versions: z.number().int().min(1).max(4).optional() } },
    wrap(async (a) => { write(); const r = await createJob({ user, projectId: a.projectId as string, input: { kind: 'generate', input: { prompt: a.prompt as string, count: (a.count as number | undefined) ?? 'auto', versions: (a.versions as number | undefined) ?? 1 } }, idempotencyKey: idem(), requestId }); return jobDto(r.job); }));
  server.registerTool('quilt.edit_screens', { description: 'Revise one or more screens with an instruction (server-side model). Returns a job.', inputSchema: { projectId: z.string().uuid(), screenIds: z.array(z.string().uuid()).min(1).max(20), prompt: z.string().min(1).max(8000), versions: z.number().int().min(1).max(4).optional() } },
    wrap(async (a) => { write(); const r = await createJob({ user, projectId: a.projectId as string, input: { kind: 'edit_screens', input: { prompt: a.prompt as string, screenIds: a.screenIds as string[], versions: (a.versions as number | undefined) ?? 1 } }, idempotencyKey: idem(), requestId }); return jobDto(r.job); }));
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
    });
    if (!a.applyToScreens) return { designSystem, job: null };
    const r = await createJob({ user, projectId: a.projectId as string, input: { kind: 'apply_design_system', input: { screenIds: 'all' } }, idempotencyKey: idem(), requestId });
    return { designSystem, job: jobDto(r.job) };
  }));
  // 改项目名与应用简介（v0.42）：brief 进每次生成的 prompt，建完才发现写错时此前无从修改
  server.registerTool('quilt.update_project', {
    description: 'Rename the project or rewrite its brief. The brief goes into every generation prompt, so a wrong one skews everything Quilt generates.',
    inputSchema: { projectId: z.string().uuid(), name: z.string().trim().min(1).max(80).optional(), brief: z.string().max(2000).optional() },
  }, wrap(async (a) => {
    write();
    return projectDto(await updateProject(user.id, a.projectId as string, { name: a.name as string | undefined, brief: a.brief as string | undefined }));
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
  server.registerTool('quilt.update_screen', { description: 'Replace an existing screen\'s HTML (new revision). expectedRevisionId guards against concurrent edits and is REQUIRED when jobId is given (use the revision id from the prompt or quilt.get_project; on 409 call quilt.get_screen and redo on the current version).', inputSchema: { projectId: z.string().uuid(), screenId: z.string().uuid(), name: z.string().min(1).max(80), route: z.string(), html: z.string().optional(), uploadId: z.string().optional(), expectedRevisionId: z.string().uuid().optional(), jobId: z.string().uuid().optional() } },
    wrap(async (a) => { write(); return ingestScreen(user.id, a.projectId as string, { name: a.name as string, route: a.route as string, html: a.html as string | undefined, uploadId: a.uploadId as string | undefined, screenId: a.screenId as string, expectedRevisionId: a.expectedRevisionId as string | undefined, jobId: a.jobId as string | undefined }); }));
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
