import { and, eq, gte, sql, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { estimateJob, type UsageDto, type CreateJobInput } from '@quilt/core';
import type { UserRow } from './user.ts';

// REQ-CORE-008：用量台账（只增）。v0.32 本地版无硬上限——花的是用户自己的 Key / 订阅，台账只为可见。
function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, month: start.toISOString().slice(0, 7) };
}

// 在途预估：queued / running 作业按 payload 派生（agent 作业计 0），不落库；只作展示与动词行
export async function inflightUsage(userId: string): Promise<{ calls: number; screens: number }> {
  const rows = await db.select({ kind: schema.generationJobs.kind, input: schema.generationJobs.input, runner: schema.generationJobs.runner }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.createdBy, userId), inArray(schema.generationJobs.status, ['queued', 'running'])));
  let calls = 0; let screens = 0;
  for (const r of rows) {
    if (r.runner === 'agent') continue;
    const e = estimateJob({ kind: r.kind, input: r.input } as CreateJobInput, 0);
    calls += e.calls; screens += e.screens;
  }
  return { calls, screens };
}

export async function monthlyUsage(user: UserRow): Promise<UsageDto> {
  const { start, month } = monthBounds();
  const where = and(eq(schema.usageEntries.userId, user.id), gte(schema.usageEntries.createdAt, start));
  const [row] = await db.select({
    screens: sql<number>`coalesce(sum(${schema.usageEntries.screens}), 0)::int`,
    tokensIn: sql<number>`coalesce(sum(${schema.usageEntries.tokensIn}), 0)::int`,
    tokensOut: sql<number>`coalesce(sum(${schema.usageEntries.tokensOut}), 0)::int`,
  }).from(schema.usageEntries).where(where);
  const byDriver = await db.select({
    driver: sql<string>`coalesce(${schema.usageEntries.driver}, '')`, model: sql<string>`coalesce(${schema.usageEntries.model}, '')`,
    screens: sql<number>`coalesce(sum(${schema.usageEntries.screens}), 0)::int`,
    tokensIn: sql<number>`coalesce(sum(${schema.usageEntries.tokensIn}), 0)::int`,
    tokensOut: sql<number>`coalesce(sum(${schema.usageEntries.tokensOut}), 0)::int`,
  }).from(schema.usageEntries).where(where).groupBy(schema.usageEntries.driver, schema.usageEntries.model).orderBy(sql`3 desc`);
  return { month, screens: row.screens, tokensIn: row.tokensIn, tokensOut: row.tokensOut, byDriver: byDriver.filter((d) => d.driver), inflight: await inflightUsage(user.id) };
}

export async function recordUsage(userId: string, jobId: string, tokensIn: number, tokensOut: number, screens: number, driver?: string, model?: string): Promise<void> {
  await db.insert(schema.usageEntries).values({ userId, jobId, tokensIn, tokensOut, screens, driver, model }).onConflictDoNothing();
}
