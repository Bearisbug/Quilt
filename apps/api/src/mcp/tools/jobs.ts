import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { JOB_RUNNERS, type JobRunner, type Runner } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { Problem, problems } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { listJobEvents } from '../../lib/events.ts';
import { ownedJob, cancelJob, listJobs } from '../../services/jobs.ts';
import { ownedProject, jobDto } from '../../services/projects.ts';
import { ownedScreen } from '../../services/screens.ts';
import { ownedComponent } from '../../services/components.ts';
import { runnerCatalog } from '../../services/channels.ts';
import { finishAgentJob } from '../../worker/agentDelivery.ts';
import type { ToolCtx } from '../ctx.ts';

// 作业：状态 / 列表 / 取消 / 事件（拉取式，不是 SSE）；其余四种作业的入口；通道目录；投递到本机会话的作业由会话自己收口
export function registerJobTools(c: ToolCtx) {
  const { server, user, wrap, read, write, checkRunner, prep, runJob, runnerInput, attachmentsInput } = c;

  server.registerTool('quilt.get_job', {
    description: 'Job status/output (queued | running | succeeded | failed | cancelled).',
    inputSchema: { jobId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const [row] = await db.select({ j: schema.generationJobs }).from(schema.generationJobs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.generationJobs.projectId))
      .where(and(eq(schema.generationJobs.id, a.jobId as string), eq(schema.projects.ownerId, user.id)));
    if (!row) throw new Problem(404, '/errors/not-found', 'job not found');
    return jobDto(row.j);
  }));

  server.registerTool('quilt.list_jobs', {
    description: 'Jobs of a project, newest first (default 50). runner filters model | agent.',
    inputSchema: { projectId: z.string().uuid(), runner: z.enum(JOB_RUNNERS).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, wrap(async (a) => {
    read();
    const project = await ownedProject(user.id, a.projectId as string);
    return { items: (await listJobs(project.id, { runner: a.runner as JobRunner | undefined, limit: (a.limit as number | undefined) ?? 50 })).map(jobDto) };
  }));

  server.registerTool('quilt.cancel_job', {
    description: 'Cancel a queued or running job (409 job-finished if it already ended). Revisions it already wrote stay.',
    inputSchema: { jobId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    return { job: jobDto(await cancelJob(await ownedJob(user.id, a.jobId as string))) };
  }));

  server.registerTool('quilt.get_job_events', {
    description: 'Events of a job with seq > after (screen_planned | screen_html_ready | screen_screenshot_ready | progress | succeeded | failed | cancelled). Pull-style: pass the last seq you saw.',
    inputSchema: { jobId: z.string().uuid(), after: z.number().int().min(0).optional() },
  }, wrap(async (a) => {
    read();
    const job = await ownedJob(user.id, a.jobId as string);
    return { items: (await listJobEvents(job.id, (a.after as number | undefined) ?? 0)).map((e) => ({ seq: e.seq, type: e.type, data: e.data, at: e.createdAt.toISOString() })) };
  }));

  // 投递到本机会话的作业由会话自己收口（REQ-AGENT-003 v0.34）：只认 running 的 agent 作业，取消 / 已结束的一律 409
  server.registerTool('quilt.finish_job', {
    description: 'Close a job that the Quilt canvas delivered to this session (the jobId is in the delivered prompt). Call it once when you are done: status "succeeded" (default) with a one-line summary, or "failed" with the reason. Quilt keeps the job open until this call.',
    inputSchema: { jobId: z.string().uuid(), status: z.enum(['succeeded', 'failed']).optional(), summary: z.string().max(2000).optional() },
  }, wrap(async (a) => {
    write();
    const job = await ownedJob(user.id, a.jobId as string);
    if (job.runner !== 'agent' || job.status !== 'running') throw problems.jobFinished();
    const failed = a.status === 'failed';
    const summary = (a.summary as string | undefined)?.trim() || undefined;
    const done = await finishAgentJob(job, failed ? 'failed' : 'succeeded', { summary, ...(failed ? { errorClass: 'agent', message: summary ?? '会话报告未完成' } : {}) });
    if (!done) throw problems.jobFinished();
    return { jobId: job.id, status: failed ? 'failed' : 'succeeded' };
  }));

  // 其余四种作业（API-CORE-006）：子树重生成、AI 改组件、提炼约定（产出给 agent 自己确认）、导出原型
  server.registerTool('quilt.regenerate_subtree', {
    description: 'AI-rewrite one element subtree (by data-qid) with an instruction; siblings keep their qids. expectedRevisionId must be current. Returns a job.',
    inputSchema: { screenId: z.string().uuid(), qid: z.string().regex(/^q\d+$/), prompt: z.string().min(1).max(4000), expectedRevisionId: z.string().uuid(), runner: runnerInput },
  }, wrap(async (a) => {
    write();
    const { screen, project } = await ownedScreen(user.id, a.screenId as string);
    const runner = await checkRunner(a.runner as Runner | undefined);
    return runJob(project.id, { kind: 'regenerate_subtree', input: { screenId: screen.id, qid: a.qid as string, prompt: a.prompt as string, expectedRevisionId: a.expectedRevisionId as string, runner } });
  }));

  server.registerTool('quilt.edit_component', {
    description: 'AI-revise a shared component with an instruction (one model call), then re-bake every screen that places it. Returns a job. runner.kind=agent is not accepted here — use quilt.update_component to write the HTML yourself.',
    inputSchema: { componentId: z.string().uuid(), prompt: z.string().min(1).max(8000), runner: runnerInput, attachmentIds: attachmentsInput },
  }, wrap(async (a) => {
    write();
    const { component, project } = await ownedComponent(user.id, a.componentId as string);
    const runner = a.runner as Runner | undefined;
    if (runner?.kind === 'agent') throw problems.validation([{ path: 'runner', message: '改组件请换一个模型通道，本机会话不接这类作业' }]);
    const { imageKeys } = await prep(project.id, runner, a.attachmentIds);
    return runJob(project.id, { kind: 'edit_component', input: { componentId: component.id, prompt: a.prompt as string, runner, imageKeys } });
  }));

  server.registerTool('quilt.propose_design_system', {
    description: 'Ask the model to distil an instruction (optionally with one revised screen as the example) into absolute design conventions and token changes. Returns a job; the proposal is in output.proposal { summary, conventions[], tokens?, regenerate } — review it, then write what you accept with quilt.update_design_system (conventions, seedColor, fontFamily, radiusScale).',
    inputSchema: { projectId: z.string().uuid(), instruction: z.string().min(1).max(4000), screenId: z.string().uuid().optional(), runner: runnerInput },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    const runner = await checkRunner(a.runner as Runner | undefined);
    return runJob(project.id, { kind: 'propose_design_system', input: { instruction: a.instruction as string, screenId: a.screenId as string | undefined, runner } });
  }));

  server.registerTool('quilt.export_prototype', {
    description: 'Build a single offline HTML prototype of all screens (hash routing, no model calls). Returns a job; when it succeeds call quilt.get_export for the download URL.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    return runJob(project.id, { kind: 'export_prototype', input: {} });
  }));

  server.registerTool('quilt.get_export', {
    description: 'Download URL (signed, 5 minutes) and size of a finished export_prototype job; 409 job-not-finished before that.',
    inputSchema: { jobId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const job = await ownedJob(user.id, a.jobId as string);
    const key = (job.output as { exportKey?: string } | null)?.exportKey;
    if (job.kind !== 'export_prototype' || job.status !== 'succeeded' || !key) throw problems.jobNotFinished();
    const body = await storage.get(key);
    return { jobId: job.id, url: await storage.signedUrl(key), bytes: body.byteLength };
  }));

  // 通道目录（API-CORE-023，响应不含密钥）：给 runner 字段取值
  server.registerTool('quilt.list_runners', {
    description: 'Generation channels this account can use: id, label, available, vision and the `runner` object to pass to generate_screens / edit_screens / regenerate_subtree / edit_component / propose_design_system. `default` is what jobs use when you pass no runner. Never includes keys.',
  }, wrap(async () => {
    read();
    return runnerCatalog(user);
  }));
}
