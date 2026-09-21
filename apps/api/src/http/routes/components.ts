import { Hono } from 'hono';
import { createComponentSchema, updateComponentSchema } from '@quilt/core';
import { parseBody, requireUser, type Env } from '../app.ts';
import { createComponent, updateComponent, deleteComponent } from '../../services/components.ts';

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

componentRoutes.delete('/v1/components/:componentId', async (c) => {
  await deleteComponent(requireUser(c).id, c.req.param('componentId'));
  return c.body(null, 204);
});
