import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { emitJobEvent } from '../lib/events.ts';
import { findSession, injectMessage } from '../lib/claudeSessions.ts';
import { findCodexThread, openCodexThread, queueCodexMessage } from '../lib/codexSessions.ts';
import { registerAgentHooks } from '../services/jobs.ts';
import { deriveLinks } from '../services/screens.ts';
import type { JobRow } from '../services/projects.ts';
import type { AgentTool } from '@quilt/core';

// 本机 agent 投递（REQ-AGENT-003 / ADR-015 v0.34）：runner=agent 的作业由这里投递到用户选定的本机 Claude Code 会话——
// 往它的 inbox socket 写一行用户消息；会话在自己的窗口里做、经 MCP 回写，最后调 quilt.finish_job 收口。
// Codex 线程（v0.68 ADR-020）：执行 codex queue 排进线程的队列，线程开在哪个 Codex 窗口就由哪个取走；没打开就让桌面版打开它。
// 这里只管三件事：组提示词并投递、计时（30 分钟没收口算失败）、收口时把作业收成终态。
// 回写守卫（带 jobId 的 update_screen 必须传 expectedRevisionId）在 ingestScreen 里，这里只负责把 id 写进提示词。
const timers = new Map<string, NodeJS.Timeout>();
const mcpUrl = () => `http://127.0.0.1:${config.apiPort}/mcp`;

// 没接 quilt MCP 时怎么接：Claude Code 接上后 /mcp 重连即可；Codex 线程在打开时加载 MCP 配置，接入后得新开或重开线程
const MCP_SETUP: Record<AgentTool, (url: string) => string> = {
  'claude-code': (url) => `If this session has no MCP server named "quilt", run \`claude mcp add --transport http quilt ${url}\` and reconnect it (/mcp) before continuing.`,
  codex: (url) => `If this thread has no MCP tools from a server named "quilt", do not attempt the job: tell the user to run \`codex mcp add quilt --url ${url}\` and then start a new Codex thread or reopen this one (MCP servers are loaded when a thread is opened), then send the job again from the Quilt canvas.`,
};

async function buildPrompt(job: JobRow): Promise<string> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, job.projectId));
  // generate / edit_screens 带 screenIds；regenerate_subtree 带单个 screenId + qid（只重写该子树）
  const input = job.input as { prompt: string; screenIds?: string[]; screenId?: string; qid?: string };
  const ids = input.screenIds?.length ? input.screenIds : input.screenId ? [input.screenId] : [];
  const screens = ids.length ? await db.select().from(schema.screens).where(inArray(schema.screens.id, ids)) : [];
  const targets = screens.length
    ? screens.map((s) => `- ${s.name} (${s.route}) screenId=${s.id} expectedRevisionId=${s.currentRevisionId ?? 'none'}${s.presentation === 'overlay' ? ' — an OVERLAY screen: keep its root transparent (bg-transparent) and its close action linking back' : ''}`).join('\n')
    : '- none: create new screen(s) with quilt.create_screen (pick routes that do not collide with the app map)';
  const scope = job.kind === 'regenerate_subtree' && input.qid
    ? `Scope: rewrite ONLY the element with data-qid="${input.qid}" (and its subtree) on the target screen. Keep every other element identical: change it with quilt.patch_screen (find = that element's current HTML from quilt.get_screen, replace = the new HTML) instead of resending the whole screen.`
    : '';
  return [
    `[Quilt] The Quilt canvas delivered a job to this session (job ${job.id}).`,
    `You are working on the Quilt project "${project.name}" (projectId ${project.id}, ${project.deviceType}) through the Quilt MCP server "quilt" at ${mcpUrl()}. ${MCP_SETUP[toolOf(job)](mcpUrl())}`,
    project.brief ? `App brief: ${project.brief}` : '',
    `Instruction from the user:\n${input.prompt}`,
    scope,
    `Target screens:\n${targets}`,
    `Rules: pass jobId="${job.id}" on EVERY quilt.update_screen / quilt.create_screen call; for update_screen pass the expectedRevisionId listed above. If you get 409 revision-conflict, call quilt.get_screen and redo the change on the current version.`,
    'Steps: quilt.get_design_contract → read each target screen with quilt.get_screen (the body with data-qid) → make the change → write it back: quilt.patch_screen for a partial change (find/replace, only the changed text), quilt.update_screen for a rewrite, quilt.create_screen for a new screen. The contract\'s tokens and recipes are the shared vocabulary, not a gate: quilt.validate_screen reports deviations as advice — fix dangling routes and anything you did not intend, keep deliberate choices such as a chart library or a colour the tokens cannot express. Keep each call\'s HTML under ~8 KB: a larger screen goes through quilt.create_upload_url + quilt.append_upload chunks and uploadId. Do not modify any files on disk; all output goes through the MCP tools.',
    `When you are done, call quilt.finish_job with jobId="${job.id}" and a one-line summary (status "failed" with the reason if you could not do it). Quilt keeps the job open until this call.`,
  ].filter(Boolean).join('\n\n');
}

const toolOf = (job: JobRow): AgentTool => ((job.input as { runner?: { tool?: AgentTool } }).runner?.tool === 'codex' ? 'codex' : 'claude-code');

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
  const tool = toolOf(claimed);
  const claude = tool === 'claude-code' ? await findSession(sessionId) : null;
  const codex = tool === 'codex' ? await findCodexThread(sessionId) : null;
  const session = claude ?? codex;
  if (!session) { await finishAgentJob(claimed, 'failed', { errorClass: 'agent', message: '会话已关闭或不存在，没有投递出去' }); return; }
  let opened = false;
  try {
    const prompt = await buildPrompt(claimed);
    if (claude) await injectMessage(claude.socketPath, prompt);
    else if (codex) {
      await queueCodexMessage(codex.sessionId, prompt);
      // 线程没在任何 Codex 窗口里打开：消息只会躺在队列里，让桌面版打开它（会切到前台）才会被取走
      if (!codex.open) { await openCodexThread(codex.sessionId); opened = true; }
    }
  } catch (e) { await finishAgentJob(claimed, 'failed', { errorClass: 'agent', message: `投递失败：${(e as Error).message}` }); return; }
  // Codex 线程没起过名时 name 是标题（首条消息），比 UUID 好认，照用
  const delivery = { tool, sessionId: session.sessionId, name: session.named || tool === 'codex' ? session.name : session.sessionId, deliveredAt: new Date().toISOString(), ...(tool === 'codex' ? { opened } : {}) };
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
