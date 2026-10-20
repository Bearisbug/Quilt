import { Hono } from 'hono';
import { copyDraftSchema, createDraftSchema, type SketchbookDto } from '@quilt/core';
import { parseBody, requireUser, type Env } from '../app.ts';
import { ensureSketchbook, copyDraft, createDraft } from '../../services/sketchbook.ts';

// 草稿本（REQ-CORE-040～044）：草稿与版本的读写全部复用项目接口，这里只有取草稿本、从屏建草稿与写回项目三条
export const sketchbookRoutes = new Hono<Env>();

// API-CORE-046：没有就先建出来（ADR-030）
sketchbookRoutes.get('/v1/sketchbook', async (c) => {
  const user = requireUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ projectId: (await ensureSketchbook(user.id)).id } satisfies SketchbookDto);
});

// API-CORE-048：从项目的一屏或其中一块建草稿（ADR-032）；同一个 Idempotency-Key 返回首次结果
sketchbookRoutes.post('/v1/sketchbook/drafts', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, createDraftSchema);
  const { result, reused } = await createDraft(user, input, { idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId') });
  return c.json(result, reused ? 200 : 201);
});

// API-CORE-047：一次性快照进目标项目，restyle 时再建一个改写作业（ADR-031），或原样覆盖目标屏 / 其中一块（ADR-032）；同一个 Idempotency-Key 返回首次结果
sketchbookRoutes.post('/v1/sketchbook/drafts/:screenId/copy', async (c) => {
  const user = requireUser(c);
  const input = await parseBody(c, copyDraftSchema);
  const { result, reused } = await copyDraft(user, c.req.param('screenId'), input, { idempotencyKey: c.req.header('idempotency-key') ?? null, requestId: c.get('requestId') });
  return c.json(result, reused ? 200 : 201);
});
