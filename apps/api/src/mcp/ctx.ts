import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runnerSchema, MAX_ATTACHMENTS_PER_MESSAGE, MAX_COMPONENT_TARGETS, type Runner, type CreateJobInput } from '@quilt/core';
import { Problem } from '../lib/errors.ts';
import { requestLocale } from '../lib/locale.ts';
import { resolveForMessage } from '../services/attachments.ts';
import { createJob } from '../services/jobs.ts';
import { jobDto } from '../services/projects.ts';
import type { UserRow } from '../services/user.ts';

// 每个工具文件共用的一套东西：server 与当前用户、错误包装、作业入队。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分——read() / write() 只留作将来 SaaS 加权限的插点。
export function makeCtx(server: McpServer, user: UserRow) {
  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] });
  // Problem 按 RFC 7807 的字段原样给 agent（type / title / status + extra，文案按请求的界面语言，MCP 客户端通常不带语言头即中文），
  // 其它异常一律 500；测试与 agent 都按 type 字符串判
  const wrap = <A extends Record<string, unknown>>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      const r = await fn(args);
      return typeof r === 'object' && r !== null && 'content' in (r as object) ? (r as ReturnType<typeof ok>) : ok(r);
    } catch (e) {
      const p = e instanceof Problem ? e.body(requestLocale()) : { type: '/errors/internal', title: (e as Error).message, status: 500 };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(p) }] };
    }
  };
  const read = () => {};
  const write = () => {};
  const idem = () => `mcp-${crypto.randomUUID()}`;
  const requestId = 'mcp';
  // 造 / 改类作业的参考图（v0.51）：附件要真传完，取不到判非法、不静默丢图。通道是否属于本人、带图时是否支持视觉、
  // 本机会话是否活着都由 createJob 统一查（CH-2）；runner.kind=agent 的作业投递到会话、不入队列
  const prep = async (projectId: string, attachmentIds: unknown) => {
    const attachments = await resolveForMessage(projectId, attachmentIds as string[] | undefined);
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
  return { server, user, ok, wrap, read, write, idem, requestId, prep, runJob, runnerInput, attachmentsInput, componentsInput, coord };
}
export type ToolCtx = ReturnType<typeof makeCtx>;
