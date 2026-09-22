import { Hono } from 'hono';
import { createComponentSchema, updateComponentSchema, applyComponentElementEditSchema } from '@quilt/core';
import { parseBody, requireUser, type Env } from '../app.ts';
import { createComponent, updateComponent, applyComponentElementEdit, deleteComponent } from '../../services/components.ts';

// API-EDIT-004 共享组件（REQ-EDIT-006）：建（直接给 HTML / 从屏里提取并同步）、改（内容带乐观锁并回刷 / 只挪位置）、删
export const componentRoutes = new Hono<Env>();

componentRoutes.post('/v1/projects/:projectId/components', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, createComponentSchema);
  return c.json(await createComponent(user.id, c.req.param('projectId'), input), 201);
});

componentRoutes.patch('/v1/components/:componentId', async (c) => {
  const user = requireUser(c);
  const patch = await parseBody(c, updateComponentSchema);
  return c.json(await updateComponent(user.id, c.req.param('componentId'), patch));
});

// API-EDIT-005（v0.57）：组件里的元素直改，与屏的 API-EDIT-001 同一套 op，乐观并发用组件版本号
componentRoutes.post('/v1/components/:componentId/elements/:qid', async (c) => {
  const user = requireUser(c);
  const { ops, expectedVersion } = await parseBody(c, applyComponentElementEditSchema);
  return c.json(await applyComponentElementEdit(user.id, c.req.param('componentId'), c.req.param('qid'), ops, expectedVersion));
});

componentRoutes.delete('/v1/components/:componentId', async (c) => {
  await deleteComponent(requireUser(c).id, c.req.param('componentId'));
  return c.body(null, 204);
});
