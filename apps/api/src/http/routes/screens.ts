import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { updateScreenSchema, restoreRevisionSchema, applyElementEditSchema, updateDesignSystemSchema, createAnnotationSchema, updateAnnotationSchema, sendAnnotationsSchema, L } from '@quilt/core';
import { applyElementEdit, updateDesignSystem } from '../../services/edit.ts';
import { db, schema } from '../../db/client.ts';
import { problems, isUniqueViolation } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { notifyCanvas } from '../../lib/events.ts';
import { parseBody, requireUser, type Env } from '../app.ts';
import { ownedScreen, hasActiveJob, createRevision, deriveLinks, listRevisions, getRevision, revisionDto, adoptCandidate, deleteScreen, setFamilyPresentation, setDraftFrame } from '../../services/screens.ts';
import { screenDtos, ownedProject } from '../../services/projects.ts';
import { isSketchbook } from '../../services/sketchbook.ts';
import { enqueueScreenshot } from '../../services/jobs.ts';
import { jobDto } from '../../services/projects.ts';
import * as annotations from '../../services/annotations.ts';

export const screenRoutes = new Hono<Env>();

// API-CORE-012
screenRoutes.patch('/v1/screens/:screenId', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  const patch = await parseBody(c, updateScreenSchema);
  // 变体（v0.62）：路由与呈现方式属于默认屏，变体改不了；变体名只对变体有意义
  if (patch.route !== undefined && screen.variantOf) throw problems.unprocessable([{ path: 'route', message: L('变体与默认屏同路由，改路由请改默认屏', 'A variant shares the route of its default screen; change the route on the default screen') }]);
  if (patch.presentation !== undefined && screen.variantOf && patch.presentation !== screen.presentation) throw problems.unprocessable([{ path: 'presentation', message: L('变体随默认屏的呈现方式，改呈现方式请改默认屏', 'A variant follows the presentation of its default screen; change it on the default screen') }]);
  if (patch.variantName !== undefined && !screen.variantOf) throw problems.unprocessable([{ path: 'variantName', message: L('只有变体才有状态名', 'Only state variants have a state name') }]);
  // 画框只对草稿有效（REQ-CORE-040）
  if (patch.frame !== undefined && !isSketchbook(project)) throw problems.unprocessable([{ path: 'frame', message: L('画框只对草稿有效', 'Frames only apply to drafts') }]);
  // 组件与页面之间不能互换（v1.17）：组件按自身大小、页面按视口排，换过去显示就乱；只有手机页与桌面页之间能改
  if (patch.frame !== undefined && screen.frame && (patch.frame === 'component') !== (screen.frame === 'component')) throw problems.unprocessable([{ path: 'frame', message: L('组件与页面之间不能换画框，只能在手机页与桌面页之间改', 'A draft cannot switch between Component and a page frame; you can only switch between Mobile page and Desktop page') }]);
  // 参照项目只对草稿有效（REQ-CORE-042）：得是本人的普通项目，null 回到自由风格；不建修订，从下一轮出稿、改稿起生效（ADR-033）
  if (patch.refProjectId !== undefined && !isSketchbook(project)) throw problems.unprocessable([{ path: 'refProjectId', message: L('参照项目只对草稿有效', 'Reference projects only apply to drafts') }]);
  if (patch.refProjectId && (await ownedProject(user.id, patch.refProjectId)).kind !== 'app') throw problems.notFound();
  const { presentation, frame, ...rest } = patch;
  let reshoot: string[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.screens).set({ ...rest, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
      if (presentation && presentation !== screen.presentation) reshoot = await setFamilyPresentation(tx, screen.id, presentation);
      if (frame && frame !== screen.frame) reshoot = [...reshoot, ...await setDraftFrame(tx, screen.id, frame)];
      if (patch.route && patch.route !== screen.route) {
        // 变体与默认屏同路由：默认屏改路由，变体跟着改
        await tx.update(schema.screens).set({ route: patch.route }).where(eq(schema.screens.variantOf, screen.id));
        await deriveLinks(tx, project.id);
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw problems.routeTaken();
    throw e;
  }
  for (const id of reshoot) await enqueueScreenshot(id);
  await notifyCanvas(project.id, { reason: 'updated', screenId: screen.id });
  const [updated] = await db.select().from(schema.screens).where(eq(schema.screens.id, screen.id));
  return c.json({ screen: (await screenDtos(project, [updated]))[0] });
});

// API-CORE-018
screenRoutes.delete('/v1/screens/:screenId', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  await deleteScreen(project.id, screen.id);
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
  await notifyCanvas(project.id, { reason: 'revision', screenId: screen.id, revisionId: c.req.param('revisionId') });
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

// API-CORE-015：以旧版内容建新修订（source_kind=restore），父修订是被回溯到的那一版——沿父链取历史指令时不经过已放弃的分支（ADR-012 v0.87）。
// 截图重拍：旧版的截图可能是按另一种呈现方式拍的（v0.63 切过整屏 / 叠层）
screenRoutes.post('/v1/screens/:screenId/revisions/:revisionId/restore', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  const source = await getRevision(screen.id, c.req.param('revisionId'));
  const { expectedRevisionId } = await parseBody(c, restoreRevisionSchema);
  const html = (await storage.get(source.htmlKey)).toString('utf8');
  const rev = await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
    const r = await createRevision(tx, { projectId: project.id, screenId: screen.id, html, sourceKind: 'restore', lintReport: source.lintReport, expectedRevisionId, parentRevisionId: source.id });
    if (!r) throw problems.revisionConflict();
    await deriveLinks(tx, project.id);
    return r;
  });
  await enqueueScreenshot(rev.id);
  await notifyCanvas(project.id, { reason: 'revision', screenId: screen.id, revisionId: rev.id });
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
