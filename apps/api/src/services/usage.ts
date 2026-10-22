import { and, eq, gte, sql, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { estimateJob, type UsageDto, type CreateJobInput, type Runner, type UsageRange, type UsageStatsDto } from '@quilt/core';
import type { UserRow } from './user.ts';
import { summarizeUsage } from './usageStats.ts';

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

// 记账时一并写下作业的项目、任务类型与通道（ADR-036）：之后项目、作业或通道删了，看板照样按它们归类
export async function recordUsage(userId: string, jobId: string, tokensIn: number, tokensOut: number, screens: number, driver?: string, model?: string, cache: { read: number; write: number } = { read: 0, write: 0 }): Promise<void> {
  const [job] = await db.select({ projectId: schema.generationJobs.projectId, projectName: schema.projects.name, kind: schema.generationJobs.kind, input: schema.generationJobs.input })
    .from(schema.generationJobs).leftJoin(schema.projects, eq(schema.projects.id, schema.generationJobs.projectId)).where(eq(schema.generationJobs.id, jobId));
  const runner = (job?.input as { runner?: Runner } | undefined)?.runner;
  const channelId = runner?.kind === 'channel' ? runner.channelId : null;
  const [channel] = channelId ? await db.select({ label: schema.channels.label }).from(schema.channels).where(eq(schema.channels.id, channelId)) : [];
  await db.insert(schema.usageEntries).values({
    userId, jobId, tokensIn, tokensOut, cacheReadTokens: cache.read, cacheWriteTokens: cache.write, screens, driver, model,
    projectId: job?.projectId ?? null, projectName: job?.projectName ?? null, kind: job?.kind ?? null, channelId, channelLabel: channel?.label ?? null,
  }).onConflictDoNothing();
}

// API-CORE-052：用量看板。台账只有 model 作业会记（本机 agent 作业花的是会话自己的额度），读的时候不按 runner 筛
export async function usageStats(user: UserRow, range: UsageRange, utcOffset: number): Promise<UsageStatsDto> {
  const u = schema.usageEntries;
  const [rows, channels, projects, inflight] = await Promise.all([
    db.select({ at: u.createdAt, tokensIn: u.tokensIn, tokensOut: u.tokensOut, screens: u.screens, driver: u.driver, model: u.model, projectId: u.projectId, projectName: u.projectName, kind: u.kind, channelId: u.channelId, channelLabel: u.channelLabel })
      .from(u).where(eq(u.userId, user.id)).orderBy(u.createdAt),
    db.select({ id: schema.channels.id, label: schema.channels.label, kind: schema.channels.kind, model: schema.channels.model }).from(schema.channels).where(eq(schema.channels.userId, user.id)),
    db.select({ id: schema.projects.id, name: schema.projects.name, kind: schema.projects.kind }).from(schema.projects).where(eq(schema.projects.ownerId, user.id)),
    inflightUsage(user.id),
  ]);
  return { ...summarizeUsage({ rows, channels, projects, range, utcOffset, now: new Date() }), inflight };
}
