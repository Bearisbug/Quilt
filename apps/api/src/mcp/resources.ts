import { z } from 'zod';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { Problem } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { locateAttachment } from '../services/attachments.ts';
import { ownedProject } from '../services/projects.ts';
import { ownedScreen, getRevision, exemplarBody, currentBody } from '../services/screens.ts';
import { designContract } from '../services/ingest.ts';
import type { ToolCtx } from './ctx.ts';

// 资源与提示词：只读投影，给 agent 按 URI 取 DESIGN.md / tokens / 应用地图 / 样板屏 / 单屏 HTML 与截图 / 参考图
export function registerResources(c: ToolCtx) {
  const { server, user, read } = c;
  const text = (uri: string, mime: string, body: string) => ({ contents: [{ uri, mimeType: mime, text: body }] });
  const tpl = (uri: string) => new ResourceTemplate(uri, { list: undefined });

  server.registerResource('design-md', tpl('quilt://projects/{projectId}/design.md'), { title: 'DESIGN.md', description: 'Project design system document', mimeType: 'text/markdown' }, async (uri, vars) => {
    read();
    const contract = await designContract(user.id, String(vars.projectId));
    return text(uri.href, 'text/markdown', contract.designMd);
  });
  server.registerResource('tokens', tpl('quilt://projects/{projectId}/tokens.json'), { title: 'tokens.json', mimeType: 'application/json' }, async (uri, vars) => {
    read();
    const contract = await designContract(user.id, String(vars.projectId));
    return text(uri.href, 'application/json', JSON.stringify({ tokens: contract.tokens, colorClasses: contract.colorClasses, components: contract.components }, null, 2));
  });
  server.registerResource('app-map', tpl('quilt://projects/{projectId}/app-map.json'), { title: 'app-map.json', mimeType: 'application/json' }, async (uri, vars) => {
    read();
    const project = await ownedProject(user.id, String(vars.projectId));
    const screens = await db.select({ screenId: schema.screens.id, route: schema.screens.route, name: schema.screens.name }).from(schema.screens).where(eq(schema.screens.projectId, project.id));
    const links = await db.select().from(schema.links).where(eq(schema.links.projectId, project.id));
    return text(uri.href, 'application/json', JSON.stringify({ nodes: screens, edges: links.map((l) => ({ fromScreenId: l.fromScreenId, href: l.href, toScreenId: l.toScreenId })) }, null, 2));
  });
  // 样板屏（REQ-CORE-016）：用户钦定的 exemplarScreenId，没钦定就回落到最早建的那张整屏
  server.registerResource('golden', tpl('quilt://projects/{projectId}/golden'), { title: 'Exemplar screen', description: 'The project\'s exemplar screen (style anchor) to match density and rhythm', mimeType: 'text/html' }, async (uri, vars) => {
    read();
    const project = await ownedProject(user.id, String(vars.projectId));
    const ex = await exemplarBody(project);
    return text(uri.href, 'text/html', ex?.body ?? '');
  });
  server.registerResource('screen-html', tpl('quilt://projects/{projectId}/screens/{screenId}/html'), { title: 'Screen HTML', mimeType: 'text/html' }, async (uri, vars) => {
    read();
    const { screen } = await ownedScreen(user.id, String(vars.screenId));
    return text(uri.href, 'text/html', (await currentBody(screen.id)) ?? '');
  });
  server.registerResource('screen-screenshot', tpl('quilt://projects/{projectId}/screens/{screenId}/screenshot'), { title: 'Screen screenshot', mimeType: 'image/png' }, async (uri, vars) => {
    read();
    const { screen } = await ownedScreen(user.id, String(vars.screenId));
    if (!screen.currentRevisionId) throw new Problem(404, '/errors/not-found', 'no revision');
    const rev = await getRevision(screen.id, screen.currentRevisionId);
    if (!rev.screenshotKey) throw new Problem(409, '/errors/job-not-finished', 'screenshot not ready');
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: (await storage.get(rev.screenshotKey)).toString('base64') }] };
  });
  server.registerResource('attachment', tpl('quilt://projects/{projectId}/attachments/{attachmentId}'), { title: 'Reference image', description: 'A reference image the user attached to a canvas message (REQ-CORE-012)', mimeType: 'image/png' }, async (uri, vars) => {
    read();
    await ownedProject(user.id, String(vars.projectId));
    const found = await locateAttachment(String(vars.projectId), String(vars.attachmentId));
    if (!found) throw new Problem(404, '/errors/not-found', 'attachment not found');
    return { contents: [{ uri: uri.href, mimeType: found.mediaType, blob: found.buf.toString('base64') }] };
  });

  const prompt = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });
  server.registerPrompt('quilt.new-screen', { description: 'Write a new screen for a project with your own model', argsSchema: { projectId: z.string(), route: z.string(), brief: z.string() } },
    (a) => prompt(`Read quilt://projects/${a.projectId}/design.md, tokens.json, app-map.json and golden. Write the screen for route ${a.route}: ${a.brief}. Default to the contract from quilt.get_design_contract — its tokens and recipes are this project's shared vocabulary, not a gate; where the design needs something they cannot express, write it directly and accept that hardcoded values will not follow a later theme change. quilt.validate_screen tells you which deviations you are taking; then quilt.create_screen.`));
  server.registerPrompt('quilt.sync-from-canvas', { description: 'Pull the latest screens into the codebase', argsSchema: { projectId: z.string() } },
    (a) => prompt(`Call quilt.get_project for ${a.projectId}; for each screen fetch quilt.get_screen and implement/update the corresponding component in this repo, keeping data-qid values as comments for future sync.`));
  server.registerPrompt('quilt.audit-drift', { description: 'Compare code against the canvas and report drift', argsSchema: { projectId: z.string() } },
    (a) => prompt(`Compare each screen in project ${a.projectId} (quilt.get_screen) with its implementation in this repo. Report layout/color/copy drift per screen and propose fixes.`));
}
