import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { chatSystemPrompt, chatUserPrompt, type ChatScreen, type DeviceType, type Presentation } from '@quilt/core';
import type { ProjectRow, JobRow } from '../services/projects.ts';

// 聊天回合（REQ-CORE-023 / ADR-018）：借 Claude Agent SDK 的回路——循环、会话记忆（resume）、上下文压缩都是它的；
// Quilt 只组稳定前缀、挂自己的 MCP、把每次工具调用翻成一句话进度、把最后一段文字当回执。
// 内置文件 / shell 工具关掉、不读任何本机设置与 CLAUDE.md：助手能碰的只有 quilt.* 工具，所以权限门可以放开。
const MAX_TURNS = 40;
const REPLY_MAX = 12_000;
const mcpUrl = () => `http://127.0.0.1:${config.apiPort}/mcp`;

export class ChatFailure extends Error { constructor(public errorClass: 'provider' | 'timeout', msg: string) { super(msg); } }
export type ChatTurnArgs = {
  job: JobRow; project: ProjectRow; designMd: string; designVersion: number; model?: string;
  images: { mediaType: string; dataBase64: string }[]; signal: AbortSignal;
  onStep: (step: string) => void;
};
export type ChatTurnResult = { reply: string; sessionId: string | null; tokensIn: number; tokensOut: number; produced: { screenId: string; revisionId: string }[] };

// 工具调用 → 一句话进度（在跑作业行与折叠横条都显示）。工具名经 SDK 会带 mcp__quilt__ 前缀，只认后缀
function stepLabel(tool: string, input: unknown, names: Map<string, string>): string {
  const key = tool.replace(/^mcp__quilt__/, '').replace(/^quilt[._]/, '');
  const i = (input ?? {}) as Record<string, unknown>;
  const screen = (id: unknown) => (typeof id === 'string' && names.has(id) ? `「${names.get(id)}」` : '');
  const named = typeof i.name === 'string' ? `「${i.name}」` : '';
  switch (key) {
    case 'get_outline': return '正在看项目大纲';
    case 'get_project': case 'get_app_map': case 'list_revisions': return '正在看项目';
    case 'get_design_contract': return '正在读设计系统';
    case 'get_screen': return `正在读${screen(i.screenId) || '一屏'}`;
    case 'get_screenshot': return `正在看${screen(i.screenId) || '截图'}`;
    case 'update_screen': return `正在改${named || screen(i.screenId) || '一屏'}`;
    case 'patch_screen': return `正在改${screen(i.screenId) || '一屏'}`;
    case 'append_upload': return '正在写入一屏';
    case 'create_screen': return `正在造${named || '新屏'}`;
    case 'update_design_system': return '正在改设计系统';
    case 'update_project': return '正在改项目简介';
    case 'validate_screen': return '正在检查偏离';
    default: return `正在调用 ${key}`;
  }
}

type RunOutcome = { ok: true; reply: string } | { ok: false; error: string; maxTurns?: boolean };
type RunResult = RunOutcome & { sessionId: string | null; tokensIn: number; tokensOut: number };

// 会话文件丢了（用户清了 ~/.claude、Claude Code 升级换了格式）：resume 会立刻报错。认几个已知措辞，换新会话重来一次
const lostSession = (msg: string) => /session|resume|conversation/i.test(msg);

export async function runChatTurn(a: ChatTurnArgs): Promise<ChatTurnResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const input = a.job.input as { prompt: string; screenIds?: string[] };
  const rows = await db.select().from(schema.screens).where(eq(schema.screens.projectId, a.project.id)).orderBy(schema.screens.createdAt);
  const screens: ChatScreen[] = rows.map((s) => ({ id: s.id, name: s.name, route: s.route, purpose: s.purpose || undefined, currentRevisionId: s.currentRevisionId, presentation: s.presentation as Presentation }));
  const names = new Map(rows.map((s) => [s.id, s.name]));
  const { componentCards } = await import('../services/components.ts');
  const system = chatSystemPrompt({
    app: { name: a.project.name, description: 'existing app being discussed', brief: a.project.brief },
    device: a.project.deviceType as DeviceType, designMd: a.designMd, screens, projectId: a.project.id, jobId: a.job.id, designVersion: a.designVersion,
    // 共享组件卡（REQ-EDIT-006）：助手改导航这类东西要走 quilt.update_component，而不是逐屏改副本
    components: await componentCards(a.project.id),
  });
  const text = chatUserPrompt(input.prompt, screens.filter((s) => input.screenIds?.includes(s.id)));
  // cwd 固定：SDK 按 cwd 归档会话文件（~/.claude/projects/<cwd 编码>/），换目录就找不到上一轮
  const cwd = path.join(config.dataDir, 'chat');
  await mkdir(cwd, { recursive: true });
  // 与 AgentSdkLlm 同一做法：去掉 ANTHROPIC_API_KEY，走机器上 claude 的登录态（这条通道就是「本机 Claude 订阅」）
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'quilt-api/0.1.0' };
  delete env.ANTHROPIC_API_KEY;

  const run = async (resume: string | undefined): Promise<RunResult> => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (a.signal.aborted) abort.abort(); else a.signal.addEventListener('abort', onAbort);
    // 参考图（REQ-CORE-012）：带图时用消息流形态，内容块里放 image；不带图仍是字符串
    const promptArg = a.images.length
      ? (async function* () {
          yield {
            type: 'user' as const, parent_tool_use_id: null,
            message: { role: 'user' as const, content: [
              ...a.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.dataBase64 } })),
              { type: 'text' as const, text },
            ] },
          };
        })()
      : text;
    let sessionId: string | null = null;
    let tokensIn = 0; let tokensOut = 0;
    try {
      const q = query({
        prompt: promptArg,
        options: {
          systemPrompt: { type: 'custom', prompt: system },
          tools: [], settingSources: [], cwd, env, abortController: abort,
          mcpServers: { quilt: { type: 'http', url: mcpUrl(), alwaysLoad: true } },
          permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
          maxTurns: MAX_TURNS, model: a.model, resume, persistSession: true,
        },
      });
      for await (const m of q) {
        if ('session_id' in m && typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;
        if (m.type === 'assistant') {
          for (const block of m.message.content) if (block.type === 'tool_use') a.onStep(stepLabel(block.name, block.input, names));
        }
        if (m.type === 'result') {
          const u = m.usage;
          tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          tokensOut = u.output_tokens ?? 0;
          if (m.subtype === 'success') return { ok: true, reply: String(m.result ?? '').trim().slice(0, REPLY_MAX), sessionId, tokensIn, tokensOut };
          return { ok: false, error: m.errors?.[0] ?? m.subtype, maxTurns: m.subtype === 'error_max_turns', sessionId, tokensIn, tokensOut };
        }
      }
      return { ok: false, error: 'agent-sdk: no result', sessionId, tokensIn, tokensOut };
    } catch (e) {
      return { ok: false, error: (e as Error).message, sessionId, tokensIn, tokensOut };
    } finally { a.signal.removeEventListener('abort', onAbort); }
  };

  let r = await run(a.project.chatSessionId ?? undefined);
  if (!r.ok && a.project.chatSessionId && !a.signal.aborted && lostSession(r.error)) {
    console.warn(`[chat ${a.job.id}] resume ${a.project.chatSessionId} failed (${r.error.slice(0, 120)}); starting a new session`);
    r = await run(undefined);
  }
  if (!r.ok) {
    if (a.signal.aborted) throw new ChatFailure('timeout', '聊天回合被中止');
    throw new ChatFailure('provider', r.maxTurns ? `助手在 ${MAX_TURNS} 轮工具调用内没有收口` : r.error);
  }
  // 会话 id 记在项目上（一个项目一条会话）；resume 失败换了新会话时这里就换成新 id
  if (r.sessionId && r.sessionId !== a.project.chatSessionId) await db.update(schema.projects).set({ chatSessionId: r.sessionId }).where(eq(schema.projects.id, a.project.id));
  // 助手经 MCP 回写的修订带了本作业 jobId：认领回来，affectedScreenIds 与应用地图派生由此算
  const revs = await db.select({ screenId: schema.screenRevisions.screenId, revisionId: schema.screenRevisions.id }).from(schema.screenRevisions).where(eq(schema.screenRevisions.jobId, a.job.id));
  return { reply: r.reply, sessionId: r.sessionId, tokensIn: r.tokensIn, tokensOut: r.tokensOut, produced: revs };
}
