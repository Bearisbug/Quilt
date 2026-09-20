import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { emitJobEvent } from '../lib/events.ts';
import { findSession, injectMessage } from '../lib/claudeSessions.ts';
import { registerAgentHooks } from '../services/jobs.ts';
import { deriveLinks } from '../services/screens.ts';
import type { JobRow } from '../services/projects.ts';

// 本机 agent 投递（REQ-AGENT-003 / ADR-015 v0.34）：runner=agent 的作业由这里投递到用户选定的本机 Claude Code 会话——
// 往它的 inbox socket 写一行用户消息；会话在自己的窗口里做、经 MCP 回写，最后调 quilt.finish_job 收口。
// 这里只管三件事：组提示词并投递、计时（30 分钟没收口算失败）、收口时把作业收成终态。
// 回写守卫（带 jobId 的 update_screen 必须传 expectedRevisionId）在 ingestScreen 里，这里只负责把 id 写进提示词。
const timers = new Map<string, NodeJS.Timeout>();
const mcpUrl = () => `http://127.0.0.1:${config.apiPort}/mcp`;

async function buildPrompt(job: JobRow): Promise<string> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, job.projectId));
  // generate / edit_screens 带 screenIds；regenerate_subtree 带单个 screenId + qid（只重写该子树）
  const input = job.input as { prompt: string; screenIds?: string[]; screenId?: string; qid?: string };
  const ids = input.screenIds?.length ? input.screenIds : input.screenId ? [input.screenId] : [];
  const screens = ids.length ? await db.select().from(schema.screens).where(inArray(schema.screens.id, ids)) : [];
  const targets = screens.length
    ? screens.map((s) => `- ${s.name} (${s.route}) screenId=${s.id} expectedRevisionId=${s.currentRevisionId ?? 'none'}`).join('\n')
    : '- none: create new screen(s) with quilt.create_screen (pick routes that do not collide with the app map)';
  const scope = job.kind === 'regenerate_subtree' && input.qid
    ? `Scope: rewrite ONLY the element with data-qid="${input.qid}" (and its subtree) on the target screen. Keep every other element identical — same data-qid values, text and classes — and push the whole screen back with quilt.update_screen.`
    : '';
  return [
    `[Quilt] The Quilt canvas delivered a job to this session (job ${job.id}).`,
    `You are working on the Quilt project "${project.name}" (projectId ${project.id}, ${project.deviceType}) through the Quilt MCP server "quilt" at ${mcpUrl()}. If this session has no MCP server named "quilt", run \`claude mcp add --transport http quilt ${mcpUrl()}\` and reconnect it (/mcp) before continuing.`,
    project.brief ? `App brief: ${project.brief}` : '',
    `Instruction from the user:\n${input.prompt}`,
    scope,
    `Target screens:\n${targets}`,
    `Rules: pass jobId="${job.id}" on EVERY quilt.update_screen / quilt.create_screen call; for update_screen pass the expectedRevisionId listed above. If you get 409 revision-conflict, call quilt.get_screen and redo the change on the current version.`,
    'Steps: quilt.get_design_contract → read each target screen with quilt.get_screen → write the revised HTML following the contract (token classes only, recipes verbatim, routes from the app map) → quilt.validate_screen until it reports no violations → quilt.update_screen (or create_screen). Do not modify any files on disk; all output goes through the MCP tools.',
    `When you are done, call quilt.finish_job with jobId="${job.id}" and a one-line summary (status "failed" with the reason if you could not do it). Quilt keeps the job open until this call.`,
  ].filter(Boolean).join('\n\n');
}

function disarm(jobId: string) { const t = timers.get(jobId); if (t) { clearTimeout(t); timers.delete(jobId); } }
function arm(job: JobRow) {
  disarm(job.id);
  const elapsed = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
  const remaining = Math.max(1000, config.agentJobTimeoutMs - elapsed);
  const t = setTimeout(() => { void finishAgentJob(job, 'failed', { errorClass: 'timeout', message: `投递后 ${config.agentJobTimeoutMs / 60000} 分钟没有收口（quilt.finish_job），视为未完成` }).catch((e) => console.error(`[agent ${job.id}]`, e)); }, remaining);
  t.unref();
  timers.set(job.id, t);
}

/** 收口：running → succeeded / failed。screenIds = 本作业名下修订所在屏；已被取消（不再 running）时返回 false 不动 */
export async function finishAgentJob(job: JobRow, status: 'succeeded' | 'failed', extra: Record<string, unknown>): Promise<boolean> {
  disarm(job.id);
  const revs = await db.select({ screenId: schema.screenRevisions.screenId }).from(schema.screenRevisions).where(eq(schema.screenRevisions.jobId, job.id));
  const screenIds = Array.from(new Set(revs.map((r) => r.screenId)));
  const done = await db.transaction(async (tx) => {
    const [cur] = await tx.select({ output: schema.generationJobs.output }).from(schema.generationJobs).where(eq(schema.generationJobs.id, job.id));
    const output = { ...((cur?.output as Record<string, unknown> | null) ?? {}), screenIds, ...extra };
    const [updated] = await tx.update(schema.generationJobs).set({ status, finishedAt: new Date(), output })
      .where(and(eq(schema.generationJobs.id, job.id), eq(schema.generationJobs.status, 'running'))).returning();
    if (!updated) return false;
    const names = screenIds.length ? (await tx.select({ name: schema.screens.name }).from(schema.screens).where(inArray(schema.screens.id, screenIds))).map((s) => s.name).join('、') : '';
    const summary = typeof extra.summary === 'string' && extra.summary ? `：${extra.summary}` : '';
    const content = status === 'succeeded'
      ? (screenIds.length ? `本机 agent 已完成：更新了 ${screenIds.length} 屏（${names}）${summary}` : `本机 agent 已完成（没有回写屏幕）${summary}`)
      : `本机 agent 未完成（${String(extra.message ?? extra.errorClass ?? '')}）`;
    await tx.update(schema.messages).set({ content, affectedScreenIds: screenIds }).where(and(eq(schema.messages.jobId, job.id), eq(schema.messages.role, 'assistant')));
    if (screenIds.length) { await deriveLinks(tx, job.projectId); await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, job.projectId)); }
    return true;
  });
  if (done) await emitJobEvent(job.id, status, { ...(status === 'failed' ? { errorClass: extra.errorClass, message: extra.message } : {}), screenIds });
  return done;
}

export async function deliverAgentJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id, jobId));
  if (!job || job.status !== 'queued' || job.runner !== 'agent') return;
  const [claimed] = await db.update(schema.generationJobs).set({ status: 'running', startedAt: new Date() })
    .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, 'queued'))).returning();
  if (!claimed) return;
  const sessionId = (claimed.input as { runner?: { sessionId?: string } }).runner?.sessionId ?? '';
  const session = await findSession(sessionId);
  if (!session) { await finishAgentJob(claimed, 'failed', { errorClass: 'agent', message: '会话已关闭或不存在，没有投递出去' }); return; }
  try { await injectMessage(session.socketPath, await buildPrompt(claimed)); }
  catch (e) { await finishAgentJob(claimed, 'failed', { errorClass: 'agent', message: `投递失败：${(e as Error).message}` }); return; }
  const delivery = { sessionId: session.sessionId, name: session.named ? session.name : session.sessionId, deliveredAt: new Date().toISOString() };
  await db.update(schema.generationJobs).set({ output: { delivery } }).where(eq(schema.generationJobs.id, jobId));
  await emitJobEvent(jobId, 'progress', { stage: 'delivered', session: delivery.name });
  arm({ ...claimed, output: { delivery } });
}

export function cancelAgentJob(jobId: string) { disarm(jobId); }

// 启动：注册挂钩；上次进程没跑完的 running agent 作业按 startedAt 重新计时（会话还在外面干活，不标失败）
export async function startAgentDelivery() {
  registerAgentHooks({ run: (id) => { void deliverAgentJob(id).catch((e) => console.error(`[agent ${id}]`, e)); }, cancel: cancelAgentJob });
  const running = await db.select().from(schema.generationJobs).where(and(eq(schema.generationJobs.status, 'running'), eq(schema.generationJobs.runner, 'agent')));
  for (const j of running) arm(j);
  if (running.length) console.log(`[agent] re-armed ${running.length} delivered job(s)`);
}
