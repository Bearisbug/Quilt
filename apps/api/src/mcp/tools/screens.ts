import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENT_BYTES, PRESENTATIONS, elementOpSchema, routeSchema, type ElementOp, type Presentation } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { config } from '../../config.ts';
import { Problem, problems, isUniqueViolation } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { randomToken, signObject } from '../../lib/signing.ts';
import { createUpload } from '../../services/attachments.ts';
import { ownedProject } from '../../services/projects.ts';
import { ownedScreen, getRevision, projectOutline, deriveLinks, deleteScreen, currentBody } from '../../services/screens.ts';
import { ingestScreen, validateScreenHtml } from '../../services/ingest.ts';
import { applyElementEdit } from '../../services/edit.ts';
import { updateComponent } from '../../services/components.ts';
import type { ToolCtx } from '../ctx.ts';

// 屏：大纲 / 读 HTML 与截图 / agent 自带 HTML 推屏（含直传）/ 补路由 / 删 / 摆放 / 零 token 直改
export function registerScreenTools(c: ToolCtx) {
  const { server, user, wrap, read, write, coord } = c;

  // 项目大纲（REQ-CORE-023 / ADR-018）：每屏一份确定性结构摘要，聊天助手先看目录再决定读哪张整屏；本机会话同样可用
  server.registerTool('quilt.get_outline', {
    description: 'Structural outline of every screen (or just screenIds): landmarks, headings, links, buttons, inputs and images with their data-qid and text, at most 40 lines per screen. Read this before quilt.get_screen to decide which screens you actually need in full.',
    inputSchema: { projectId: z.string().uuid(), screenIds: z.array(z.string().uuid()).max(50).optional() },
  }, wrap(async (a) => {
    read();
    return projectOutline(user.id, a.projectId as string, a.screenIds as string[] | undefined);
  }));

  // 只给 body（v0.64）：prelude 是 Quilt 每次写入时重拼的（其中 14 K 是预览运行时），agent 用不上，回写时还会被原样抄回来
  server.registerTool('quilt.get_screen', {
    description: 'Current HTML of a screen: the body content with data-qid attributes — exactly what create_screen / update_screen / patch_screen take (Quilt adds the <head> with tokens and runtime itself).',
    inputSchema: { screenId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    return ((await currentBody(screen.id)) ?? '').trim();
  }));

  server.registerTool('quilt.get_screenshot', {
    description: 'Screenshot (PNG) of a screen\'s current revision, returned as an image.',
    inputSchema: { screenId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    if (!screen.currentRevisionId) throw new Problem(404, '/errors/not-found', 'no revision');
    const rev = await getRevision(screen.id, screen.currentRevisionId);
    if (!rev.screenshotKey) throw new Problem(409, '/errors/job-not-finished', 'screenshot not ready yet');
    const png = await storage.get(rev.screenshotKey);
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
  }));

  server.registerTool('quilt.validate_screen', {
    description: 'Check screen HTML against the design contract without saving. Returns deviations (advisory — they never block a write) and dangling routes.',
    inputSchema: { projectId: z.string().uuid(), html: z.string().min(1) },
  }, wrap(async (a) => {
    read();
    return validateScreenHtml(user.id, a.projectId as string, a.html as string);
  }));

  server.registerTool('quilt.create_screen', {
    description: 'Push your own HTML as a new screen. Keep html in one call under ~8 KB — a long tool argument makes your streamed response fragile ("Connection lost mid-response"); for a bigger screen use create_upload_url + append_upload in ≤ 8 KB chunks and pass uploadId. Server injects data-qid + design tokens, records any contract deviations (never rejected), stores a revision and screenshots it. presentation "overlay" = a bottom sheet / dialog the player presents over the screen it opened from (default "push"): its root must be bg-transparent — see the overlay rule in quilt.get_design_contract. componentsOverwritten in the result names shared-component instances whose edited copy was replaced by the component (change the component with quilt.update_component instead). Pass jobId (given in the prompt when Quilt launched you) so the revision counts as that job\'s output.',
    inputSchema: { projectId: z.string().uuid(), name: z.string().min(1).max(80), route: routeSchema, html: z.string().optional(), uploadId: z.string().optional(), jobId: z.string().uuid().optional(), presentation: z.enum(PRESENTATIONS).optional() },
  }, wrap(async (a) => {
    write();
    return ingestScreen(user.id, a.projectId as string, { name: a.name as string, route: a.route as string, html: a.html as string | undefined, uploadId: a.uploadId as string | undefined, jobId: a.jobId as string | undefined, presentation: a.presentation as Presentation | undefined });
  }));

  // v0.51：name / route 可选——只换 HTML 不必重传它们，缺省沿用该屏当前值
  server.registerTool('quilt.update_screen', {
    description: 'Replace an existing screen\'s HTML (new revision). To change part of a screen use quilt.patch_screen instead of resending it; a full rewrite over ~8 KB goes through create_upload_url + append_upload chunks and uploadId. name and route are optional and default to the screen\'s current ones. expectedRevisionId guards against concurrent edits and is REQUIRED when jobId is given (use the revision id from the prompt, quilt.get_outline or quilt.get_project; on 409 call quilt.get_screen and redo on the current version).',
    inputSchema: {
      projectId: z.string().uuid(), screenId: z.string().uuid(), name: z.string().min(1).max(80).optional(), route: z.string().optional(),
      html: z.string().optional(), uploadId: z.string().optional(), expectedRevisionId: z.string().uuid().optional(), jobId: z.string().uuid().optional(),
      presentation: z.enum(PRESENTATIONS).optional(),
    },
  }, wrap(async (a) => {
    write();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    return ingestScreen(user.id, a.projectId as string, {
      name: (a.name as string | undefined) ?? screen.name, route: (a.route as string | undefined) ?? screen.route,
      html: a.html as string | undefined, uploadId: a.uploadId as string | undefined, screenId: screen.id,
      expectedRevisionId: a.expectedRevisionId as string | undefined, jobId: a.jobId as string | undefined, presentation: a.presentation as Presentation | undefined,
    });
  }));

  // 按锚点改屏（v0.64）：只传改动。整屏重发会让单条模型响应长到流式中断——实测改几行也要重发 20 K 字符。
  // 所有 edit 先在内存里依次套上，任一条找不到 / 多处匹配就整批报错不落库；成功后走 update_screen 同一条写入路径
  const editSchema = z.object({ find: z.string().min(1).max(8000), replace: z.string().max(16000), all: z.boolean().optional() });
  server.registerTool('quilt.patch_screen', {
    description: 'Edit part of a screen without resending it: each edit replaces the literal text find (copied from quilt.get_screen, data-qid attributes included) with replace, in order, on the current body. find must match exactly once unless all=true. Any edit that misses or is ambiguous fails the whole call with 422 (errors[].path = edits.<i>.find) and nothing is written. Same result, conflicts and jobId rule as quilt.update_screen.',
    inputSchema: { screenId: z.string().uuid(), expectedRevisionId: z.string().uuid(), edits: z.array(editSchema).min(1).max(50), jobId: z.string().uuid().optional() },
  }, wrap(async (a) => {
    write();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    let body = (await currentBody(screen.id)) ?? '';
    const errors: { path: string; message: string; matches: number }[] = [];
    (a.edits as { find: string; replace: string; all?: boolean }[]).forEach((e, i) => {
      const matches = body.split(e.find).length - 1;
      if (matches === 0 || (matches > 1 && !e.all)) { errors.push({ path: `edits.${i}.find`, message: matches ? `matches ${matches} places; make find longer or pass all=true` : 'not found in the current body', matches }); return; }
      body = e.all ? body.split(e.find).join(e.replace) : body.replace(e.find, () => e.replace);
    });
    if (errors.length) throw problems.unprocessable(errors);
    return ingestScreen(user.id, screen.projectId, { name: screen.name, route: screen.route, html: body, screenId: screen.id, expectedRevisionId: a.expectedRevisionId as string, jobId: a.jobId as string | undefined });
  }));

  // 分块上传（v0.64）：大屏拆成多次小调用写进同一个 HTML 上传位，再把 uploadId 交给 create_screen / update_screen
  server.registerTool('quilt.append_upload', {
    description: 'Append one chunk (≤ 16,000 chars; aim for ≤ 8 KB per call) to an HTML upload from quilt.create_upload_url, so a large screen is written over several short calls. offset = the chars already uploaded (0 for the first chunk, then the chars value the previous call returned): a mismatch returns 409 with the current chars, so a retried chunk is never appended twice. When done pass uploadId to create_screen / update_screen (the upload is consumed by that write).',
    inputSchema: { uploadId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), offset: z.number().int().min(0), chunk: z.string().min(1).max(16000) },
  }, wrap(async (a) => {
    write();
    const key = `uploads/${a.uploadId as string}.html`;
    const before = (await storage.get(key).catch(() => null))?.toString('utf8') ?? '';
    // 按位置续写：重试同一段（上次其实写成功了、只是回包丢了）时 offset 对不上，报出当前长度让调用方接着写
    if (a.offset !== before.length) throw new Problem(409, '/errors/upload-offset', `upload has ${before.length} chars, offset was ${a.offset}`, { chars: before.length });
    const next = before + (a.chunk as string);
    if (Buffer.byteLength(next) > config.maxScreenHtmlBytes) throw problems.unprocessable([{ path: 'chunk', message: `upload would be ${Buffer.byteLength(next)} bytes, the screen limit is ${config.maxScreenHtmlBytes}` }]);
    await storage.put(key, next, 'text/html');
    return { uploadId: a.uploadId, chars: next.length };
  }));

  // 直传（v0.60 合并了 create_upload_url 与 create_attachment_upload_url）：mediaType 决定去处——
  // text/html 是大屏 HTML（API-AGENT-004，签名 PUT 后把 uploadId 交给 create_screen / update_screen），
  // image/* 是参考图（API-CORE-019，attachmentId 交给 attachmentIds）。两条路的签名与过期各自不变
  server.registerTool('quilt.create_upload_url', {
    description: 'Signed PUT URL (10 minutes) for a direct upload. mediaType text/html (default): an HTML upload slot for a screen larger than ~8 KB — fill it with quilt.append_upload chunks (or PUT the file), then pass the returned uploadId to create_screen / update_screen. mediaType image/png | image/jpeg | image/webp (bytes required, ≤ 5 MB): a reference image for generate_screens / edit_screens / edit_component — PUT the raw bytes, then pass the returned attachmentId in attachmentIds.',
    inputSchema: { projectId: z.string().uuid(), mediaType: z.enum(['text/html', ...IMAGE_MEDIA_TYPES]).optional(), bytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES).optional() },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    const mediaType = (a.mediaType as string | undefined) ?? 'text/html';
    if (mediaType === 'text/html') {
      const uploadId = randomToken(16);
      const exp = Math.floor(Date.now() / 1000) + 600;
      return { mediaType, uploadId, putUrl: `${config.apiOrigin}/v1/uploads/${uploadId}?exp=${exp}&sig=${signObject(`uploads/${uploadId}.html`, exp)}`, projectId: project.id };
    }
    if (typeof a.bytes !== 'number') throw problems.validation([{ path: 'bytes', message: 'bytes is required for an image upload' }]);
    const u = await createUpload(project.id, { mediaType, bytes: a.bytes });
    return { mediaType, ...u, putUrl: `${config.apiOrigin}${u.putUrl}` };
  }));

  server.registerTool('quilt.link_screens', {
    description: 'Resolve a dangling link by giving an existing screen the route that other screens link to.',
    inputSchema: { screenId: z.string().uuid(), route: routeSchema },
  }, wrap(async (a) => {
    write();
    const { screen, project } = await ownedScreen(user.id, a.screenId as string);
    if (screen.variantOf) throw problems.unprocessable([{ path: 'screenId', message: 'a state variant shares its default screen\'s route; link the default screen instead' }]);
    try {
      await db.transaction(async (tx) => {
        await tx.update(schema.screens).set({ route: a.route as string, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
        await tx.update(schema.screens).set({ route: a.route as string }).where(eq(schema.screens.variantOf, screen.id));
        await deriveLinks(tx, project.id);
      });
    } catch (e) { if (isUniqueViolation(e)) throw problems.routeTaken(); throw e; }
    return { screenId: screen.id, route: a.route };
  }));

  // 删：与 API-CORE-018 同一套守卫；MCP 侧没有二次确认，不可逆写进工具说明
  server.registerTool('quilt.delete_screen', {
    description: 'Delete a screen (irreversible); deleting a default screen also deletes its state variants. 409 screen-busy while a job is running on it or on one of its variants; the app map is re-derived afterwards.',
    inputSchema: { screenId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    const { screen, project } = await ownedScreen(user.id, a.screenId as string);
    await deleteScreen(project.id, screen.id);
    return { screenId: screen.id, deleted: true };
  }));

  // 摆放：屏走 API-CORE-012 的 x / y，组件走 API-EDIT-004 PATCH 只挪位置（不升版不回刷）；逐张成败，与画布批量移动同一条路径
  const posSchema = z.object({ id: z.string().uuid(), x: coord, y: coord });
  type Pos = { id: string; x: number; y: number };
  server.registerTool('quilt.move_screens', {
    description: 'Place screens and shared components on the canvas (world coordinates, integer px; a mobile screen is 390×844, desktop 1280×800). Each item is written on its own: failures are reported per id, the rest still move.',
    inputSchema: { screens: z.array(posSchema).max(200).optional(), components: z.array(posSchema).max(50).optional() },
  }, wrap(async (a) => {
    write();
    const moved = { screens: [] as string[], components: [] as string[] };
    const failed: { id: string; error: string }[] = [];
    const attempt = async (id: string, into: string[], fn: () => Promise<unknown>) => {
      try { await fn(); into.push(id); }
      catch (e) { failed.push({ id, error: e instanceof Problem ? e.type : (e as Error).message }); }
    };
    for (const s of (a.screens as Pos[] | undefined) ?? []) {
      await attempt(s.id, moved.screens, async () => {
        const { screen } = await ownedScreen(user.id, s.id);
        await db.update(schema.screens).set({ x: s.x, y: s.y, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
      });
    }
    for (const cm of (a.components as Pos[] | undefined) ?? []) await attempt(cm.id, moved.components, () => updateComponent(user.id, cm.id, { x: cm.x, y: cm.y }));
    return { moved, failed };
  }));

  // 元素直改（API-EDIT-001）：零 token，确定性 DOM 变换落新修订；共享组件实例里只放行 detach
  server.registerTool('quilt.edit_element', {
    description: 'Zero-token direct edit of one element (by data-qid): ops text | classes | style | link (route or null) | remove | detach. Deterministic DOM change → new revision (source_kind=manual). 409 component-locked inside a shared component instance (only detach is allowed there); 409 revision-conflict on a stale expectedRevisionId.',
    inputSchema: { screenId: z.string().uuid(), qid: z.string().regex(/^q\d+$/), ops: z.array(elementOpSchema).min(1).max(10), expectedRevisionId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    return { revision: await applyElementEdit(user.id, a.screenId as string, a.qid as string, a.ops as ElementOp[], a.expectedRevisionId as string) };
  }));
}
