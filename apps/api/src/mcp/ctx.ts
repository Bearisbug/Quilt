import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runnerSchema, MAX_ATTACHMENTS_PER_MESSAGE, MAX_COMPONENT_TARGETS, type Runner, type CreateJobInput } from '@quilt/core';
import { Problem } from '../lib/errors.ts';
import { requestLocale } from '../lib/locale.ts';
import { resolveForMessage } from '../services/attachments.ts';
import { createJob } from '../services/jobs.ts';
import { jobDto } from '../services/projects.ts';
import { recordToolCall } from '../services/record.ts';
import type { UserRow } from '../services/user.ts';

// 每个工具文件共用的一套东西：server 与当前用户、错误包装、作业入队。
// v0.32 本地版免鉴权：调用方就是本机用户，没有 scope 区分——read() / write() 只留作将来 SaaS 加权限的插点。
// httpRequestId：服务端为这次 HTTP 请求生成的 mcp:<uuid>（server 每请求建一个），使用记录拿它当 session_id
export function makeCtx(server: McpServer, user: UserRow, httpRequestId: string) {
  // 使用记录（REQ-CORE-047，API-AGENT-002）：每次工具调用记一条 source=mcp、type=tool 的事件，seq 在这次请求里从 1 起。
  // 工具名只在注册时知道，所以套在 registerTool 这一层；没有 inputSchema 的工具，SDK 只传 extra，参数记 {}
  type Handler = (...a: unknown[]) => Promise<CallToolResult>;
  let toolSeq = 0;
  const register = server.registerTool.bind(server) as (name: string, config: { inputSchema?: unknown }, cb: Handler) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: { inputSchema?: unknown }, cb: Handler) => register(name, config, async (...a: unknown[]) => {
    const seq = ++toolSeq; const at = new Date();
    const r = await cb(...a);
    await recordToolCall(user.id, { sessionId: httpRequestId, seq, at, tool: name, args: config.inputSchema ? a[0] : {}, ok: !r.isError, error: r.isError ? problemType(r) : null, ms: Date.now() - at.getTime() });
    return r;
  });
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

// wrap 包出来的错误结果正文是 problem JSON，取它的 type
function problemType(r: CallToolResult): string {
  try { return (JSON.parse((r.content[0] as { text: string }).text) as { type?: string }).type ?? '/errors/internal'; }
  catch { return '/errors/internal'; }
}
