import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { updateScreenSchema, restoreRevisionSchema, applyElementEditSchema, updateDesignSystemSchema, L } from '@quilt/core';
import { applyElementEdit, updateDesignSystem } from '../../services/edit.ts';
import { db, schema } from '../../db/client.ts';
import { problems, isUniqueViolation } from '../../lib/errors.ts';
import { notifyCanvas } from '../../lib/events.ts';
import { parseBody, requireUser, type Env } from '../app.ts';
import { ownedScreen, deriveLinks, listRevisions, getRevision, revisionDto, adoptCandidate, deleteScreen, setFamilyPresentation, setDraftFrame, restoreRevision } from '../../services/screens.ts';
import { screenDtos, ownedProject } from '../../services/projects.ts';
import { isSketchbook } from '../../services/sketchbook.ts';
import { enqueueScreenshot } from '../../services/jobs.ts';

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
  // 分组（REQ-CORE-050）：元数据、不建修订；变体的分组跟默认屏，草稿没有分组
  if (patch.group !== undefined && screen.variantOf) throw problems.unprocessable([{ path: 'group', message: L('变体跟默认屏同一组，移分组请移默认屏', 'A variant is in the same group as its default screen; move the default screen instead') }]);
  if (patch.group !== undefined && isSketchbook(project)) throw problems.unprocessable([{ path: 'group', message: L('草稿没有分组', 'Drafts have no groups') }]);
  const { presentation, frame, group, surfaceId: _surfaceId, ...rest } = patch;
  let reshoot: string[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.screens).set({ ...rest, ...(group !== undefined ? { groupName: group } : {}), updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
      if (group !== undefined) await tx.update(schema.screens).set({ groupName: group }).where(eq(schema.screens.variantOf, screen.id));
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
  // 已结清的旧候选可能已被 screenshot.prune 清掉整屏截图（v1.27 ADR-037），它成了当前版、卡片要用，当场重拍
  if (!(await getRevision(screen.id, c.req.param('revisionId'))).screenshotKey) await enqueueScreenshot(c.req.param('revisionId'));
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

// API-CORE-015：只把 current 指回那一版，不建新修订（v1.43 ADR-039）。那一版的截图用不了时重拍：
// 可能已被 screenshot.prune 清掉，也可能是按另一种呈现方式或另一个尺寸拍的（restoreRevision 已把它作废）
screenRoutes.post('/v1/screens/:screenId/revisions/:revisionId/restore', async (c) => {
  const user = requireUser(c);
  const { screen, project } = await ownedScreen(user.id, c.req.param('screenId'));
  const target = await getRevision(screen.id, c.req.param('revisionId'));
  const { expectedRevisionId } = await parseBody(c, restoreRevisionSchema);
  const rev = await restoreRevision(project, screen, target, expectedRevisionId);
  if (!rev.screenshotKey) await enqueueScreenshot(rev.id);
  await notifyCanvas(project.id, { reason: 'revision', screenId: screen.id, revisionId: rev.id });
  return c.json({ revision: await revisionDto(rev) });
});
