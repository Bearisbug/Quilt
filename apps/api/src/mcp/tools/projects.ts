import { z } from 'zod';
import { eq, and, asc, desc, lt, isNull } from 'drizzle-orm';
import { MAX_SCREENS_PER_GENERATE, MAX_VERSIONS, PRESENTATIONS, DRAFT_FRAME_CHOICES, anchorSchema, routeSchema, variantNameSchema, copyDraftSchema, createDraftSchema, type DeviceType, type Runner, type Presentation, type DraftFrameChoice } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { problems } from '../../lib/errors.ts';
import { createProject, getProjectDetail, listProjects, ownedProject, projectDto, designSystemDto, updateProject, deleteProject } from '../../services/projects.ts';
import { messageDto } from '../../http/routes/projects.ts';
import { ensureSketchbook, isSketchbook, copyDraft, createDraft } from '../../services/sketchbook.ts';
import type { ToolCtx } from '../ctx.ts';

// 项目：列 / 建 / 详情 / 改名与简介 / 删；造屏与改屏两条主路（API-CORE-010 的投影）；对话记录；应用地图；草稿本（API-CORE-046～048）
export function registerProjectTools(c: ToolCtx) {
  const { server, user, wrap, read, write, prep, runJob, runnerInput, attachmentsInput, componentsInput, requestId } = c;

  server.registerTool('quilt.list_projects', {
    description: 'List the user\'s projects (the sketchbook is not one of them — see quilt.get_sketchbook).',
  }, wrap(async () => {
    read();
    return (await listProjects(user.id)).items;
  }));

  // 草稿本（REQ-CORE-040 / ADR-030）：一个不进项目列表的项目，草稿是它的屏；读写都走项目工具，校验同 API-CORE-010 的草稿本规则
  server.registerTool('quilt.get_sketchbook', {
    description: 'The user\'s sketchbook: a hidden project for one-off component or page drafts in a free style, or in the design system of the project a draft references (refProjectId; created on first call). Returns { projectId }; read drafts with quilt.get_project / quilt.get_screen, make a new draft with quilt.generate_screens (no count/versions/anchor; frame auto | component | mobile | desktop) and revise one with quilt.edit_screens (exactly one screenId). Move a finished draft into a project with quilt.copy_draft.',
  }, wrap(async () => {
    read();
    return { projectId: (await ensureSketchbook(user.id)).id };
  }));

  // 写回项目（REQ-CORE-041 / REQ-CORE-044，ADR-031 / ADR-032）：screenId 是草稿，REST 的 screenId（覆盖的目标屏）在这里叫 targetScreenId
  server.registerTool('quilt.copy_draft', {
    description: 'Write a sketchbook draft\'s current version into a project. as "screen": a new screen; as "component": a new shared component (one root, no <script>/<style>); name defaults to the draft\'s name, and restyle then starts one edit job rewriting it to that project\'s design system (default: true unless the draft already references that project; runner as in quilt.generate_screens — poll it with quilt.get_job). as "overwrite": a new revision of the project\'s screen targetScreenId written as-is (no restyle), expectedRevisionId = its current revision (409 revision-conflict if it moved, 409 screen-busy while a job is on it); with qid only that element and its subtree is replaced by the draft (404 element-not-found, 409 component-locked inside a shared component instance), the rest stays; quilt.restore_revision brings back previousRevisionId. A one-off snapshot: later edits on either side do not sync. Returns { screen | component, job?, revisionId?, previousRevisionId? }.',
    inputSchema: { ...copyDraftSchema.shape, screenId: z.string().uuid(), targetScreenId: z.string().uuid().optional() },
  }, wrap(async (a) => {
    write();
    const { screenId, targetScreenId, ...rest } = a;
    const parsed = copyDraftSchema.safeParse({ ...rest, screenId: targetScreenId });
    if (!parsed.success) throw problems.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.') === 'screenId' ? 'targetScreenId' : i.path.join('.'), message: i.message })));
    return (await copyDraft(user, screenId as string, parsed.data, { idempotencyKey: null, requestId })).result;
  }));

  // 从屏建草稿（REQ-CORE-043，ADR-032）：带上那一屏或其中一块的当前内容，参照来源项目，写回目标记成来源屏与 qid
  server.registerTool('quilt.create_draft', {
    description: 'Start a sketchbook draft from a project screen (fromScreenId) or one element of it (qid): the draft\'s first version is that content (frame component for an element, else the project\'s device), it references the source project\'s design system and remembers the screen and qid as its write-back target — revise it with quilt.edit_screens / quilt.regenerate_subtree in the sketchbook, then write it back with quilt.copy_draft as "overwrite". 404 element-not-found when qid is not on the screen. Returns { screen }.',
    inputSchema: createDraftSchema.shape,
  }, wrap(async (a) => {
    write();
    return (await createDraft(user, createDraftSchema.parse(a), { idempotencyKey: null, requestId })).result;
  }));

  server.registerTool('quilt.create_project', {
    description: 'Create a project (mobile 390×844 or desktop 1280×800) with a seed-color-derived design system, or start from one of your design presets (presetId from quilt.list_design_presets).',
    inputSchema: { name: z.string().min(1).max(80), deviceType: z.enum(['mobile', 'desktop']), seedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), presetId: z.string().uuid().optional() },
  }, wrap(async (a) => {
    write();
    const r = await createProject(user.id, a as { name: string; deviceType: DeviceType; seedColor?: string; presetId?: string });
    return { project: projectDto(r.project), designSystem: designSystemDto(r.designSystem) };
  }));

  // agent 用的投影（v0.65）：画布那份详情带每屏签名 URL、整份设计系统、全部链接与素材，42 屏的项目约 78 K 字符，
  // 而 agent 拿它多半只为取 currentRevisionId。链接走 get_app_map、设计系统走 get_design_contract、结构走 get_outline
  server.registerTool('quilt.get_project', {
    description: 'Compact project overview: screens (id, name, route, currentRevisionId, presentation, variant, deviations, pending candidates, dangling link count, position), shared components, design system version, active jobs and open annotation count. Links are in quilt.get_app_map, the design system in quilt.get_design_contract, screen structure in quilt.get_outline.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const d = await getProjectDetail(user.id, a.projectId as string);
    const dangling = new Map<string, number>();
    for (const l of d.links) if (!l.toScreenId) dangling.set(l.fromScreenId, (dangling.get(l.fromScreenId) ?? 0) + 1);
    return {
      project: { id: d.project.id, name: d.project.name, kind: d.project.kind, deviceType: d.project.deviceType, brief: d.project.brief, exemplarScreenId: d.project.exemplarScreenId },
      designSystem: { version: d.designSystem.version, seedColor: d.designSystem.seedColor, colorMode: d.designSystem.colorMode },
      screens: d.screens.map((s) => ({
        id: s.id, name: s.name, route: s.route, currentRevisionId: s.currentRevisionId, presentation: s.presentation, ...(s.frame ? { frame: s.frame } : {}),
        ...(s.refProjectId ? { refProjectId: s.refProjectId } : {}), ...(s.targetScreenId ? { targetScreenId: s.targetScreenId, targetQid: s.targetQid } : {}),
        ...(s.variantOf ? { variantOf: s.variantOf, variantName: s.variantName } : {}),
        deviations: s.deviations, ...(s.pendingCandidates ? { pendingCandidates: s.pendingCandidates } : {}), ...(dangling.get(s.id) ? { danglingLinks: dangling.get(s.id) } : {}),
        x: s.x, y: s.y,
      })),
      components: d.components.map((c) => ({ id: c.id, name: c.name, version: c.version, nav: c.nav, usedBy: c.usedBy, x: c.x, y: c.y })),
      activeJobs: d.activeJobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, runner: j.runner })),
      openAnnotations: d.annotations.filter((x) => x.status === 'open').length,
    };
  }));

  // 工具名保留为公开契约；内部映射到 v0.31 的 generate（count 缺省 auto = 规划器定屏数）
  // v0.51 与 REST 同义的全部选项：anchor 定摆放位置；route + name (+ fromScreenId) 是懒生成（跳过规划器）；runner 选通道；attachmentIds 是参考图；componentIds 把共享组件的完整 HTML 带进上下文
  server.registerTool('quilt.generate_screens', {
    description: 'Generate screens from a description using Quilt\'s server-side model: omit count to let the planner decide (4–6 for an empty project, a 2–6 screen sub-flow otherwise), or pass count 1–4. versions 1–4 = candidate versions per new screen (adopt with quilt.adopt_candidate). anchor {x,y} centers the first new screen on that canvas point (a group lays out to the right of it); route + name (+ fromScreenId as the reference screen) generates exactly that one missing screen without the planner; runner picks a channel (from quilt.list_runners; default = the account\'s default channel); attachmentIds are reference images (quilt.create_upload_url with an image mediaType); componentIds put those shared components\' full HTML in context. variantOf + variantName (both) generate a state VARIANT of that default screen (same route; e.g. variantName "empty", "error", "logged out") — no planner, the default screen is the reference. presentation "overlay" marks a lazily generated screen as a bottom sheet / dialog presented over another screen. In the sketchbook (quilt.get_sketchbook) it makes exactly one draft: only prompt, runner, attachmentIds and frame (auto = the model declares it with data-frame on the root; component | mobile | desktop) apply. Returns a job — poll quilt.get_job.',
    inputSchema: {
      projectId: z.string().uuid(),
      prompt: z.string().min(1).max(8000),
      count: z.number().int().min(1).max(MAX_SCREENS_PER_GENERATE).optional(),
      versions: z.number().int().min(1).max(MAX_VERSIONS).optional(),
      anchor: anchorSchema.optional(),
      route: routeSchema.optional(),
      name: z.string().trim().min(1).max(80).optional(),
      fromScreenId: z.string().uuid().optional(),
      runner: runnerInput,
      attachmentIds: attachmentsInput,
      componentIds: componentsInput,
      variantOf: z.string().uuid().optional(),
      variantName: variantNameSchema.optional(),
      presentation: z.enum(PRESENTATIONS).optional(),
      frame: z.enum(DRAFT_FRAME_CHOICES).optional(),
    },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    const runner = a.runner as Runner | undefined;
    if (!!a.variantOf !== !!a.variantName) throw problems.validation([{ path: 'variantName', message: 'variantOf and variantName go together' }]);
    const { imageKeys } = await prep(project.id, a.attachmentIds);
    return runJob(project.id, {
      kind: 'generate',
      input: {
        prompt: a.prompt as string, count: (a.count as number | undefined) ?? (isSketchbook(project) ? 1 : 'auto'), versions: (a.versions as number | undefined) ?? 1,
        anchor: a.anchor as { x: number; y: number } | undefined, route: a.route as string | undefined, name: a.name as string | undefined,
        fromScreenId: a.fromScreenId as string | undefined, runner, imageKeys, componentIds: a.componentIds as string[] | undefined,
        variantOf: a.variantOf as string | undefined, variantName: a.variantName as string | undefined, presentation: a.presentation as Presentation | undefined,
        frame: a.frame as DraftFrameChoice | undefined,
      },
    });
  }));

  server.registerTool('quilt.edit_screens', {
    description: 'Revise one or more screens with an instruction (server-side model). runner / attachmentIds / componentIds as in quilt.generate_screens. Returns a job.',
    inputSchema: {
      projectId: z.string().uuid(),
      screenIds: z.array(z.string().uuid()).min(1).max(20),
      prompt: z.string().min(1).max(8000),
      versions: z.number().int().min(1).max(MAX_VERSIONS).optional(),
      runner: runnerInput,
      attachmentIds: attachmentsInput,
      componentIds: componentsInput,
    },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    const runner = a.runner as Runner | undefined;
    const { imageKeys } = await prep(project.id, a.attachmentIds);
    return runJob(project.id, {
      kind: 'edit_screens',
      input: { screenIds: a.screenIds as string[], prompt: a.prompt as string, versions: (a.versions as number | undefined) ?? 1, runner, imageKeys, componentIds: a.componentIds as string[] | undefined },
    });
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

  // 删：与 API-CORE-031 同一套守卫；MCP 侧没有二次确认，不可逆写进工具说明
  server.registerTool('quilt.delete_project', {
    description: 'Delete a project and everything in it (screens, revisions, jobs, messages, assets, components). Irreversible and unconfirmed — 409 project-busy while any job is queued or running.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    await deleteProject(user.id, a.projectId as string);
    return { projectId: a.projectId, deleted: true };
  }));

  server.registerTool('quilt.get_app_map', {
    description: 'Routes and links between screens; toScreenId null = dangling link.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const project = await ownedProject(user.id, a.projectId as string);
    const screens = await db.select({ screenId: schema.screens.id, route: schema.screens.route, name: schema.screens.name, purpose: schema.screens.purpose }).from(schema.screens).where(and(eq(schema.screens.projectId, project.id), isNull(schema.screens.variantOf)));
    const links = await db.select().from(schema.links).where(eq(schema.links.projectId, project.id));
    return { nodes: screens, edges: links.map((l) => ({ fromScreenId: l.fromScreenId, qid: l.elementQid, href: l.href, toScreenId: l.toScreenId })) };
  }));

  // 对话记录（API-CORE-011）：游标分页，同一时间戳助手排在用户之前（倒序取、再 reverse 后用户在前）
  server.registerTool('quilt.list_messages', {
    description: 'Conversation of a project: user prompts and assistant receipts (with jobId / affectedScreenIds), oldest first within the page. For older pages pass nextCursor as cursor.',
    inputSchema: { projectId: z.string().uuid(), cursor: z.iso.datetime().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, wrap(async (a) => {
    read();
    const project = await ownedProject(user.id, a.projectId as string);
    const limit = (a.limit as number | undefined) ?? 50;
    const where = a.cursor ? and(eq(schema.messages.projectId, project.id), lt(schema.messages.createdAt, new Date(a.cursor as string))) : eq(schema.messages.projectId, project.id);
    const rows = await db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.createdAt), asc(schema.messages.role)).limit(limit + 1);
    const page = rows.slice(0, limit).reverse();
    return { items: await Promise.all(page.map((m) => messageDto(m))), nextCursor: rows.length > limit ? rows[limit - 1].createdAt.toISOString() : null };
  }));
}
