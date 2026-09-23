import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runnerSchema, MAX_ATTACHMENTS_PER_MESSAGE, MAX_COMPONENT_TARGETS, type Runner, type CreateJobInput } from '@quilt/core';
import { Problem, problems } from '../lib/errors.ts';
import { driverSupportsVision } from '../lib/llm.ts';
import { resolveForMessage } from '../services/attachments.ts';
import { createJob } from '../services/jobs.ts';
import { jobDto } from '../services/projects.ts';
import { listChannels } from '../services/channels.ts';
import type { UserRow } from '../services/user.ts';

// 每个工具文件共用的一套东西：server 与当前用户、错误包装、作业入队。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分——read() / write() 只留作将来 SaaS 加权限的插点。
export function makeCtx(server: McpServer, user: UserRow) {
  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] });
  // Problem 按 RFC 7807 的字段原样给 agent（type / title / status + extra），其它异常一律 500；测试与 agent 都按 type 字符串判
  const wrap = <A extends Record<string, unknown>>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      const r = await fn(args);
      return typeof r === 'object' && r !== null && 'content' in (r as object) ? (r as ReturnType<typeof ok>) : ok(r);
    } catch (e) {
      const p = e instanceof Problem ? { type: e.type, title: e.title, status: e.status, ...e.extra } : { type: '/errors/internal', title: (e as Error).message, status: 500 };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(p) }] };
    }
  };
  const read = () => {};
  const write = () => {};
  const idem = () => `mcp-${crypto.randomUUID()}`;
  const requestId = 'mcp';
  // 造 / 改类作业的 runner 与参考图（v0.51）：与 API-CORE-010 同一套校验——账号自建通道要属于自己、带图的通道要支持视觉、
  // 附件要真传完（取不到判非法，不静默丢图）；本机会话是否活着由 createJob 查。runner.kind=agent 的作业投递到会话、不入队列
  const checkRunner = async (runner: Runner | undefined) => {
    if (runner?.kind === 'channel' && !(await listChannels(user.id)).some((c) => c.id === runner.channelId)) throw problems.notFound();
    return runner;
  };
  const prep = async (projectId: string, runner: Runner | undefined, attachmentIds: unknown) => {
    await checkRunner(runner);
    const attachments = await resolveForMessage(projectId, attachmentIds as string[] | undefined);
    if (attachments.length && runner?.kind === 'model' && !driverSupportsVision(runner.driver)) {
      throw problems.validation([{ path: 'runner', message: `「${runner.driver}」通道不支持参考图，换一个支持视觉的通道再发` }]);
    }
    return { imageKeys: attachments.length ? attachments.map((x) => x.key) : undefined };
  };
  const runJob = async (projectId: string, input: CreateJobInput) => {
    const agent = (input.input as { runner?: Runner }).runner?.kind === 'agent';
    const r = await createJob({ user, projectId, input, idempotencyKey: idem(), requestId, runner: agent ? 'agent' : 'model' });
    return jobDto(r.job);
  };
  const runnerInput = runnerSchema.optional();
  const attachmentsInput = z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional();
  const componentsInput = z.array(z.string().uuid()).max(MAX_COMPONENT_TARGETS).optional();
  const coord = z.number().int().min(-1_000_000).max(1_000_000);
  return { server, user, ok, wrap, read, write, idem, requestId, checkRunner, prep, runJob, runnerInput, attachmentsInput, componentsInput, coord };
}
export type ToolCtx = ReturnType<typeof makeCtx>;
