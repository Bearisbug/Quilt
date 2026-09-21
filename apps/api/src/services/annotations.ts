import { and, asc, eq, inArray } from 'drizzle-orm';
import { annotationsPrompt, type AnnotationDto } from '@quilt/core';
import { db, schema } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { ownedScreen, currentBody } from './screens.ts';
import { ownedProject, type JobRow } from './projects.ts';
import type { UserRow } from './user.ts';
import { createJob } from './jobs.ts';
import { assertNotLocked } from './components.ts';

type Row = typeof schema.annotations.$inferSelect;

export const dto = (r: Row): AnnotationDto => ({
  id: r.id, screenId: r.screenId, qid: r.qid, note: r.note, anchorText: r.anchorText,
  rect: r.rect as AnnotationDto['rect'], status: r.status as AnnotationDto['status'],
  sentJobId: r.sentJobId, createdAt: r.createdAt.toISOString(),
});

export async function listForScreen(ownerId: string, screenId: string): Promise<AnnotationDto[]> {
  await ownedScreen(ownerId, screenId);
  const rows = await db.select().from(schema.annotations).where(eq(schema.annotations.screenId, screenId)).orderBy(asc(schema.annotations.createdAt));
  return rows.map(dto);
}

// 项目内全部未处理的批注：画布一进来就要把气泡画出来，不必逐屏拉
export async function listOpenForProject(projectId: string): Promise<AnnotationDto[]> {
  const rows = await db.select({ a: schema.annotations }).from(schema.annotations)
    .innerJoin(schema.screens, eq(schema.annotations.screenId, schema.screens.id))
    .where(and(eq(schema.screens.projectId, projectId), inArray(schema.annotations.status, ['open', 'sent'])))
    .orderBy(asc(schema.annotations.createdAt));
  return rows.map((r) => dto(r.a));
}

export async function create(ownerId: string, screenId: string, input: { qid: string; note: string; anchorText: string; rect: unknown }): Promise<AnnotationDto> {
  const { screen } = await ownedScreen(ownerId, screenId);
  // 共享组件实例里的元素不收批注（REQ-EDIT-006）：批注发出去是改屏作业，改了副本也会被组件盖回去
  const body = await currentBody(screen.id);
  if (body) await assertNotLocked(screen.projectId, body, input.qid);
  const [row] = await db.insert(schema.annotations).values({ screenId, qid: input.qid, note: input.note, anchorText: input.anchorText, rect: input.rect }).returning();
  return dto(row);
}

async function owned(ownerId: string, id: string): Promise<Row> {
  const [row] = await db.select().from(schema.annotations).where(eq(schema.annotations.id, id));
  if (!row) throw problems.notFound();
  await ownedScreen(ownerId, row.screenId);
  return row;
}

export async function update(ownerId: string, id: string, patch: { note?: string; status?: string }): Promise<AnnotationDto> {
  await owned(ownerId, id);
  const [row] = await db.update(schema.annotations).set({ ...patch, updatedAt: new Date() }).where(eq(schema.annotations.id, id)).returning();
  return dto(row);
}

export async function remove(ownerId: string, id: string): Promise<void> {
  await owned(ownerId, id);
  await db.delete(schema.annotations).where(eq(schema.annotations.id, id));
}

// 发送（API-EDIT-003）：按屏分组，每屏合成一条 edit_screens 作业——N 屏 = N 次计费，而不是 N 条批注 = N 次。
// 置为 sent 并记下 jobId；作业终态由 worker 回写 resolved / 回落 open（见 worker/pipeline.ts）。
export async function send(user: UserRow, projectId: string, annotationIds: string[], requestId: string): Promise<{ jobs: JobRow[] }> {
  await ownedProject(user.id, projectId);
  const rows = await db.select({ a: schema.annotations, projectId: schema.screens.projectId }).from(schema.annotations)
    .innerJoin(schema.screens, eq(schema.annotations.screenId, schema.screens.id))
    .where(inArray(schema.annotations.id, annotationIds))
    .orderBy(asc(schema.annotations.createdAt));
  if (rows.length !== annotationIds.length || rows.some((r) => r.projectId !== projectId)) throw problems.validation([{ path: 'annotationIds', message: '批注不存在或不属于该项目' }]);

  const byScreen = new Map<string, Row[]>();
  for (const { a } of rows) byScreen.set(a.screenId, [...(byScreen.get(a.screenId) ?? []), a]);

  const jobs: JobRow[] = [];
  for (const [screenId, items] of byScreen) {
    const { job } = await createJob({
      user, projectId, requestId, idempotencyKey: null,
      input: { kind: 'edit_screens', input: { prompt: annotationsPrompt(items.map((i) => ({ qid: i.qid, note: i.note, anchorText: i.anchorText }))), screenIds: [screenId], versions: 1 } },
    });
    await db.update(schema.annotations).set({ status: 'sent', sentJobId: job.id, updatedAt: new Date() }).where(inArray(schema.annotations.id, items.map((i) => i.id)));
    jobs.push(job);
  }
  return { jobs };
}

// 作业终态回写：成功则该批次批注标为已处理，失败 / 取消回落为未处理
export async function settleByJob(jobId: string, ok: boolean): Promise<void> {
  await db.update(schema.annotations).set({ status: ok ? 'resolved' : 'open', updatedAt: new Date() })
    .where(and(eq(schema.annotations.sentJobId, jobId), eq(schema.annotations.status, 'sent')));
}
