import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { updateScreenSchema, restoreRevisionSchema, applyElementEditSchema, updateDesignSystemSchema, createAnnotationSchema, updateAnnotationSchema, sendAnnotationsSchema } from '@quilt/core';
import { applyElementEdit, updateDesignSystem } from '../../services/edit.ts';
import { db, schema } from '../../db/client.ts';
import { problems, isUniqueViolation } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { parseBody, requireUser, type Env } from '../app.ts';
import { ownedScreen, hasActiveJob, createRevision, deriveLinks, listRevisions, getRevision, revisionDto, adoptCandidate, clearExemplarIfDeleted } from '../../services/screens.ts';
import { screenDtos } from '../../services/projects.ts';
import { enqueueScreenshot } from '../../services/jobs.ts';
import { jobDto } from '../../services/projects.ts';
import * as annotations from '../../services/annotations.ts';

export const screenRoutes = new Hono<Env>();

// API-CORE-012
screenRoutes.patch('/v1/screens/:screenId', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  const patch = await parseBody(c, updateScreenSchema);
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.screens).set({ ...patch, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
      if (patch.route && patch.route !== screen.route) await deriveLinks(tx, project.id);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw problems.routeTaken();
    throw e;
  }
  const [updated] = await db.select().from(schema.screens).where(eq(schema.screens.id, screen.id));
  return c.json({ screen: (await screenDtos(project, [updated]))[0] });
});

// API-CORE-018
screenRoutes.delete('/v1/screens/:screenId', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
    await tx.delete(schema.screens).where(eq(schema.screens.id, screen.id));
    await clearExemplarIfDeleted(tx, project.id, screen.id);
    await deriveLinks(tx, project.id);
  });
  return c.body(null, 204);
});

// API-CORE-025：采用候选（REQ-CORE-015）——只改 current 指针、结清同批，不建新修订、不计额度
screenRoutes.post('/v1/screens/:screenId/revisions/:revisionId/adopt', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  await db.transaction(async (tx) => {
    await adoptCandidate(tx, screen, c.req.param('revisionId'));
    await deriveLinks(tx, project.id);
  });
  const [updated] = await db.select().from(schema.screens).where(eq(schema.screens.id, screen.id));
  return c.json({ screen: (await screenDtos(project, [updated]))[0] });
});

// API-EDIT-001
screenRoutes.post('/v1/screens/:screenId/elements/:qid', async (c) => {
  const user = requireUser(c);
  const { ops, expectedRevisionId } = await parseBody(c, applyElementEditSchema);
  const revision = await applyElementEdit(user.id, c.req.param('screenId'), c.req.param('qid'), ops, expectedRevisionId);
  return c.json({ revision }, 201);
});

// API-EDIT-002
screenRoutes.put('/v1/projects/:projectId/design-system', async (c) => {
  const user = requireUser(c);
  const patch = await parseBody(c, updateDesignSystemSchema);
  return c.json({ designSystem: await updateDesignSystem(user.id, c.req.param('projectId'), patch) });
});

// API-CORE-013
screenRoutes.get('/v1/screens/:screenId/revisions', async (c) => {
  const user = requireUser(c);
  const { screen } = await ownedScreen(user.id, c.req.param('screenId'));
  c.header('Cache-Control', 'no-store');
  return c.json({ items: await listRevisions(screen.id) });
});

// API-CORE-014
screenRoutes.get('/v1/screens/:screenId/revisions/:revisionId', async (c) => {
  const user = requireUser(c);
  const { screen } = await ownedScreen(user.id, c.req.param('screenId'));
  const rev = await getRevision(screen.id, c.req.param('revisionId'));
  c.header('Cache-Control', 'private, max-age=300');
  return c.json({ revision: await revisionDto(rev) });
});

// API-CORE-015：以旧版内容建新修订（source_kind=restore），截图直接复用旧版。
screenRoutes.post('/v1/screens/:screenId/revisions/:revisionId/restore', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  const source = await getRevision(screen.id, c.req.param('revisionId'));
  const { expectedRevisionId } = await parseBody(c, restoreRevisionSchema);
  const html = (await storage.get(source.htmlKey)).toString('utf8');
  const rev = await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
    const r = await createRevision(tx, { projectId: project.id, screenId: screen.id, html, sourceKind: 'restore', lintReport: source.lintReport, expectedRevisionId });
    if (!r) throw problems.revisionConflict();
    if (source.screenshotKey) await tx.update(schema.screenRevisions).set({ screenshotKey: source.screenshotKey }).where(eq(schema.screenRevisions.id, r.id));
    await deriveLinks(tx, project.id);
    return { ...r, screenshotKey: source.screenshotKey };
  });
  if (!rev.screenshotKey) await enqueueScreenshot(rev.id);
  return c.json({ revision: await revisionDto(rev) }, 201);
});

// API-EDIT-003 元素批注（REQ-EDIT-004）
screenRoutes.get('/v1/screens/:screenId/annotations', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ items: await annotations.listForScreen(user.id, c.req.param('screenId')) });
});

screenRoutes.post('/v1/screens/:screenId/annotations', async (c) => {
  const user = requireUser(c);
  const body = await parseBody(c, createAnnotationSchema);
  return c.json({ annotation: await annotations.create(user.id, c.req.param('screenId'), body) }, 201);
});

screenRoutes.patch('/v1/annotations/:id', async (c) => {
  const user = requireUser(c);
  const body = await parseBody(c, updateAnnotationSchema);
  return c.json({ annotation: await annotations.update(user.id, c.req.param('id'), body) });
});

screenRoutes.delete('/v1/annotations/:id', async (c) => {
  const user = requireUser(c);
  await annotations.remove(user.id, c.req.param('id'));
  return c.body(null, 204);
});

// 按屏合并发送：每屏一条 edit_screens 作业
screenRoutes.post('/v1/projects/:projectId/annotations/send', async (c) => {
  const user = requireUser(c);
  const { annotationIds } = await parseBody(c, sendAnnotationsSchema);
  const { jobs } = await annotations.send(user, c.req.param('projectId'), annotationIds, c.get('requestId'));
  return c.json({ jobs: jobs.map(jobDto) }, 202);
});
