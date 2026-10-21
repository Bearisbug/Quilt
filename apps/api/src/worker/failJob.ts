import { and, eq, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { emitJobEvent } from '../lib/events.ts';
import { pointCurrentToFirstCandidate, deriveLinks } from '../services/screens.ts';
import { failureText, jobLocale, type ErrorClass, type JobKind } from '@quilt/core';

// input：失败文案按作业的语言写（REQ-CORE-046，input.locale）
type FailedJob = { id: string; kind: string; projectId: string; input: unknown };

// 进程在造屏 / 改屏中途退出时，runGenerate / runEditScreens 在 finally 里的收尾没跑（进程被杀时 finally 不执行）：按作业自己的
// screen_planned 事件与修订补做——候选批让 current 指向第 1 版（改屏候选只在 current 仍是它的基线时），一版都没落的新屏删掉
// （空屏占着路由，指向它的链接也不再显示为断链），再重派生应用地图
export async function settleInterrupted(job: { id: string; projectId: string }) {
  const planned = (await db.select({ data: schema.jobEvents.data }).from(schema.jobEvents).where(and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.type, 'screen_planned'))))
    .map((e) => (e.data as { screenId?: string }).screenId).filter((id): id is string => !!id);
  const batches = await db.selectDistinct({ screenId: schema.screenRevisions.screenId, base: schema.screenRevisions.parentRevisionId }).from(schema.screenRevisions)
    .where(and(eq(schema.screenRevisions.jobId, job.id), isNotNull(schema.screenRevisions.candidateIndex)));
  const produced = await db.select({ id: schema.screenRevisions.id }).from(schema.screenRevisions).where(eq(schema.screenRevisions.jobId, job.id)).limit(1);
  if (!planned.length && !produced.length) return;
  await db.transaction(async (tx) => {
    for (const b of batches) await pointCurrentToFirstCandidate(tx, b.screenId, job.id, b.base ?? undefined);
    if (planned.length) await tx.delete(schema.screens).where(and(inArray(schema.screens.id, planned), isNull(schema.screens.currentRevisionId)));
    await deriveLinks(tx, job.projectId);
  });
}

// 失败收尾（§16 v1.03）：领取后的异常、启动时上次没跑完的作业、job.timeout 扫到的超时作业都走这里——
// 回填空的助手消息（否则对话一直显示「排队中…」）、补做中断收尾、发 failed。每一步各自兜错，一步失败不挡后面
export async function finishFailed(job: FailedJob, errorClass: ErrorClass, message: string) {
  await db.update(schema.messages).set({ content: failureText(job.kind as JobKind, errorClass, message, 0, jobLocale(job) ?? 'zh') })
    .where(and(eq(schema.messages.jobId, job.id), eq(schema.messages.role, 'assistant'), eq(schema.messages.content, ''))).catch((e) => console.error(`[job ${job.id}] message`, e));
  await settleInterrupted(job).catch((e) => console.error(`[job ${job.id}] settle`, e));
  await emitJobEvent(job.id, 'failed', { errorClass, message }).catch(() => {});
}

/** 条件地把作业置为 failed（只认 statuses 里的源状态）并收尾；返回是否真的改到了 */
export async function failJob(jobId: string, errorClass: ErrorClass, message: string, statuses: ('queued' | 'running')[] = ['queued', 'running']): Promise<boolean> {
  const [row] = await db.update(schema.generationJobs)
    .set({ status: 'failed', finishedAt: new Date(), output: sql`coalesce(${schema.generationJobs.output}, '{}'::jsonb) || ${JSON.stringify({ errorClass, message })}::jsonb` })
    .where(and(eq(schema.generationJobs.id, jobId), inArray(schema.generationJobs.status, statuses)))
    .returning({ id: schema.generationJobs.id, kind: schema.generationJobs.kind, projectId: schema.generationJobs.projectId, input: schema.generationJobs.input });
  if (!row) return false;
  await finishFailed(row, errorClass, message);
  return true;
}
