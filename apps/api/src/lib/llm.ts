import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { sha256 } from './signing.ts';
import { codexBin } from './agentCli.ts';
import { tr } from './locale.ts';
import { EDIT_BLOCK, SKETCH_GENERATOR_MARK, type DraftFrame } from '@quilt/core';

// LLM 适配层（§17 Claude API）。驱动：anthropic（生产，API key）| agent-sdk（本机 Claude 订阅，仅开发）| codex（本机 Codex 订阅，v0.68）
// | gemini | openai（兼容端点）| stub（测试故障注入/回放）。
// cacheRead / cacheWrite（v1.05）：读缓存、写缓存的输入 token，已含在 tokensIn 里；报不出的驱动不给
export type LlmResult = { text: string; tokensIn: number; tokensOut: number; model: string; ms: number; cacheRead?: number; cacheWrite?: number };
export class ProviderError extends Error { constructor(msg: string, public retryable: boolean) { super(msg); } }
// 输出到上限被截断（§17，v0.90）：截掉的是屏的后半段与收尾脚本，原样返回会被存成一版残屏；同样的请求重试还会截在同一处
const cutOff = (driver: string, reason: string) => new ProviderError(`${driver} output hit the token limit (${reason})`, false);

// 参考图（REQ-CORE-012）：正文以 base64 随请求走，不给模型发 URL——签名 URL 会过期，
// 而且让供应商回源取图等于把可用性押在我们的对象存储上。
export type LlmImage = { mediaType: string; dataBase64: string };
// effort（§17 v1.05）：按调用类型定思考深度——规划、提炼这类只出短 JSON 的调用用 low，出屏与改屏用 medium；
// 只有 Anthropic 系的两个驱动（anthropic、agent-sdk）认它，其余驱动忽略
export type LlmEffort = 'low' | 'medium' | 'high';
export type LlmArgs = { system: string; prompt: string; images?: LlmImage[]; model?: string; maxTokens?: number; signal?: AbortSignal; idleMs?: number; effort?: LlmEffort };
// 流式调用的空闲超时（§17 v1.03）：两次流事件之间超过它就判失败；整屏重写的桌面屏要写几分钟，不能用总超时
const STREAM_IDLE_MS = 120_000;

export interface Llm {
  /** 该驱动能否接受参考图；不能的驱动在建作业时就被挡掉，不会走到这里（REQ-CORE-012） */
  readonly vision: boolean;
  complete(args: LlmArgs): Promise<LlmResult>;
}

class AnthropicLlm implements Llm {
  readonly vision = true;
  private client: import('@anthropic-ai/sdk').default | null = null;
  // 凭据与端点可由账号自建通道给出（REQ-CORE-013）；缺省回落到 .env
  constructor(private apiKey?: string, private baseUrl?: string) {}
  // 流式（§17 v1.03）：输出上限 64000，整屏重写的桌面屏要写几分钟——非流式 120 s 总超时写不完；空闲超时不重试，同样的请求大概率再卡一次
  async complete({ system, prompt, images, model = config.model, maxTokens = 64000, signal, idleMs = STREAM_IDLE_MS, effort }: LlmArgs) {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey ?? config.anthropicApiKey, baseURL: this.baseUrl, maxRetries: 0 });
    }
    const t0 = Date.now();
    const idle = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const kick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), idleMs); };
    // 预热（ADR-012 v1.05）：max_tokens 0 只写系统提示的缓存、不生成，扇出之前发一次
    if (maxTokens === 0) {
      try {
        const msg = await this.client.messages.create({ model, max_tokens: 0, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: prompt }] }, { signal, timeout: 60_000 });
        const u = msg.usage;
        return { text: '', tokensIn: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tokensOut: 0, model, ms: Date.now() - t0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      } catch (e) {
        const status = (e as { status?: number }).status;
        throw new ProviderError(`anthropic warm-up ${status ?? ''} ${(e as Error).message}`, false);
      }
    }
    try {
      kick();
      const stream = this.client.messages.stream(
        {
          model, max_tokens: maxTokens,
          ...(effort ? { output_config: { effort } } : {}),
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          // 图在文字之前：参考图要先被看到，后面的指令才有指代对象
          messages: [{ role: 'user', content: [
            ...(images ?? []).map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.dataBase64 } })),
            { type: 'text' as const, text: prompt },
          ] }],
        },
        { signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal, timeout: 30 * 60_000 },
      );
      stream.on('streamEvent', kick);
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'max_tokens') throw cutOff('anthropic', 'stop_reason=max_tokens');
      const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      return { text, tokensIn: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), tokensOut: msg.usage.output_tokens, model, ms: Date.now() - t0, cacheRead: msg.usage.cache_read_input_tokens ?? 0, cacheWrite: msg.usage.cache_creation_input_tokens ?? 0 };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (idle.signal.aborted && !signal?.aborted) throw new ProviderError(`anthropic stream idle for ${idleMs / 1000}s`, false);
      const status = (e as { status?: number }).status;
      throw new ProviderError(`anthropic ${status ?? ''} ${(e as Error).message}`, status === 429 || (status ?? 500) >= 500);
    } finally { clearTimeout(timer); }
  }
}

class AgentSdkLlm implements Llm {
  // 参考图（REQ-CORE-012）：query() 除了纯字符串还接受 AsyncIterable<SDKUserMessage>，
  // 而 SDKUserMessage.message 就是 Anthropic 的 MessageParam，内容块可以带 image。
  // 带图时切到这个形态；不带图仍走字符串，少一层包装。
  readonly vision = true;
  async complete({ system, prompt, images, model = config.model, signal, effort }: LlmArgs) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'quilt-api/0.1.0' };
    delete env.ANTHROPIC_API_KEY;
    // 对已中止的信号挂监听不会触发：不先判一次，取消 / 超时之后发来的调用会整次跑完、照样消耗订阅额度
    if (signal?.aborted) throw new ProviderError('agent-sdk: aborted', false);
    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort());
    const t0 = Date.now();
    const promptArg = images?.length
      ? (async function* () {
          yield {
            type: 'user' as const, parent_tool_use_id: null,
            message: { role: 'user' as const, content: [
              ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.dataBase64 } })),
              { type: 'text' as const, text: prompt },
            ] },
          };
        })()
      : prompt;
    // 不读本机的任何东西（ADR-018 v1.05）：settingSources 为空只挡住设置文件，Claude Code 仍会按工作目录注入那个仓库的 auto-memory、
    // 用户邮箱与 git 环境，并把每次调用存成一个会话——所以在空的临时目录里跑、关掉 auto-memory、不落会话
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'quilt-agent-sdk-'));
    try {
      const q = query({ prompt: promptArg, options: { systemPrompt: { type: 'custom', prompt: system }, tools: [], maxTurns: 1, model, permissionMode: 'dontAsk', settingSources: [], settings: { autoMemoryEnabled: false }, persistSession: false, cwd, ...(effort ? { effort } : {}), env, abortController: abort } });
      return { ...await agentSdkTurn(q), model, ms: Date.now() - t0 };
    } finally { await rm(cwd, { recursive: true, force: true }).catch(() => {}); }
  }
}

type AgentSdkReply = { type: 'assistant'; error?: string; message: { content: { type: string; text?: string }[] } };
/** 一轮的产出（§17，v0.90）：输出超过单次上限时 SDK 自带的 Claude Code 发「接着写」续上（最多 3 次），
 *  result 只装最后一段——文字取这一轮所有回答按序拼接；合成的报错消息（带 error）不算 */
export async function agentSdkTurn(q: AsyncIterable<{ type: string; subtype?: string }>): Promise<{ text: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }> {
  const texts: string[] = [];
  for await (const m of q) {
    if (m.type === 'assistant' && !(m as AgentSdkReply).error) {
      for (const b of (m as AgentSdkReply).message.content) if (b.type === 'text' && b.text) texts.push(b.text);
    }
    if (m.type === 'result') return agentSdkOutput(m as AgentSdkResult, texts);
  }
  throw new ProviderError('agent-sdk: no result', true);
}

type AgentSdkResult = { subtype: string; is_error?: boolean; api_error_status?: number | null; result?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } };
/** SDK 的 result 消息 → 产出。API 报错（模型要求更新的 Claude Code、额度用完、过载）时 subtype 仍是 success，
 *  只在 is_error / api_error_status 上标出、错误原文在 result 里——不拦下的话它会被当成模型产出往下传（§17，v0.71） */
export function agentSdkOutput(r: AgentSdkResult, texts: string[] = []): { text: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number } {
  if (r.subtype !== 'success') throw new ProviderError(`agent-sdk ${r.subtype}`, true);
  if (r.is_error) {
    const status = r.api_error_status ?? 0;
    throw new ProviderError(`agent-sdk: ${String(r.result ?? '').trim().slice(0, 300)}`, status === 429 || status >= 500);
  }
  const u = r.usage ?? {};
  return { text: texts.length ? texts.join('') : String(r.result ?? ''), tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tokensOut: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

// 本机 Codex 订阅（v0.68 ADR-020）：每次拉起本机 codex exec，复用它的 ChatGPT 登录态。
// --ephemeral：不在用户的 Codex 历史里留会话；空的临时目录 + 只读沙箱：它是出 HTML 的，不该去翻用户的仓库。
// --ignore-user-config / --ignore-rules（v0.70）：不读用户的 config.toml——不起用户配的 MCP 服务（其中可能就有指向开发库的 quilt）、
// 不套用户的推理强度；技能关不掉，所以输入最前面明说不许调工具——实测不说的话它会先去读用户全局装的前端技能，
// 多一轮往返、多 2 万输入 token，同一屏 237 s → 加上这两样后 143 s。
// Codex 没有替换系统提示的入口（base_instructions 实测省不下 token，大头是工具定义），所以系统提示与任务拼进同一条输入，从 stdin 传。
// 参考图写成临时文件用 -i 传。事件是 JSONL：最后一条 agent_message 是产出，turn.completed 带用量。
export function parseCodexEvents(lines: string[]): { text: string; tokensIn: number; tokensOut: number; error?: string } {
  let text = ''; let tokensIn = 0; let tokensOut = 0; let error: string | undefined;
  for (const line of lines) {
    let ev: { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }; error?: { message?: string }; message?: string };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
    else if (ev.type === 'turn.completed') { tokensIn += ev.usage?.input_tokens ?? 0; tokensOut += (ev.usage?.output_tokens ?? 0) + (ev.usage?.reasoning_output_tokens ?? 0); }
    else if (ev.type === 'turn.failed') error = ev.error?.message ?? 'turn failed';
    else if (ev.type === 'error') error = ev.message ?? 'error';
  }
  return { text, tokensIn, tokensOut, error };
}

const CODEX_PREAMBLE = 'Answer directly in this single reply. Do not run shell commands, read or write files, load skills, or call any tools.';

class CodexLlm implements Llm {
  readonly vision = true;
  async complete({ system, prompt, images, model, signal }: LlmArgs) {
    const bin = codexBin();
    if (!bin) throw new ProviderError(tr('本机没有找到 codex 命令：安装 Codex 并运行 codex 用 ChatGPT 账号登录', 'The codex command was not found on this machine: install Codex and run codex to log in with your ChatGPT account'), false);
    const t0 = Date.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'quilt-codex-'));
    try {
      const files = await Promise.all((images ?? []).map(async (im, i) => {
        const f = path.join(dir, `reference-${i + 1}.${im.mediaType.split('/')[1] ?? 'png'}`);
        await writeFile(f, Buffer.from(im.dataBase64, 'base64'));
        return f;
      }));
      // 提示词用 - 从 stdin 读，放在 -i 之前：-i 收多个值，放后面会把 - 当成图片路径吃掉
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', dir, ...(model ? ['-m', model] : []), '-', ...files.flatMap((f) => ['-i', f])];
      const env = { ...process.env };
      delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; // 让它用 ChatGPT 登录态，而不是环境里恰好有的 API Key
      const { code, lines, stderr } = await new Promise<{ code: number | null; lines: string[]; stderr: string }>((resolve, reject) => {
        const child = spawn(bin, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const out: string[] = []; let buf = ''; let err = '';
        const onAbort = () => { child.kill('SIGTERM'); reject(new ProviderError('codex: aborted', false)); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (d: string) => { buf += d; const parts = buf.split('\n'); buf = parts.pop() ?? ''; out.push(...parts.filter(Boolean)); });
        child.stderr.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-4000); });
        child.once('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(new ProviderError(tr(`codex 启动失败：${e.message}`, `codex failed to start: ${e.message}`), false)); });
        child.once('close', (c) => { signal?.removeEventListener('abort', onAbort); if (buf) out.push(buf); resolve({ code: c, lines: out, stderr: err }); });
        child.stdin.end(`${CODEX_PREAMBLE}\n\n${system}\n\n---\n\n${prompt}`);
      });
      const r = parseCodexEvents(lines);
      if (r.error || !r.text) {
        const why = (r.error ?? stderr.trim().split('\n').slice(-2).join(' ')) || `exit ${code}`;
        throw new ProviderError(`codex ${why.slice(0, 300)}`, /429|rate|5\d\d|overloaded|timeout/i.test(why) || (!r.error && code !== 0 && !/login|auth/i.test(why)));
      }
      return { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, model: model ?? 'codex', ms: Date.now() - t0 };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Gemini（@google/genai）。两种计费路径：AI Studio（GEMINI_API_KEY）| Vertex AI（GEMINI_VERTEX=1 + GCP 项目/区域，
// 鉴权走应用默认凭据：GOOGLE_APPLICATION_CREDENTIALS 指向服务账号 JSON，或本机 `gcloud auth application-default login`）。
// 思考 token 计入输出；Gemini 3.x 的思考不能关，maxOutputTokens 要给足
class GeminiLlm implements Llm {
  readonly vision = true;
  private client: import('@google/genai').GoogleGenAI | null = null;
  constructor(private apiKey?: string, private baseUrl?: string) {}
  async complete({ system, prompt, images, model = config.model, maxTokens, signal }: LlmArgs) {
    if (!this.client) {
      const { GoogleGenAI } = await import('@google/genai');
      // 用户自填了 Key 就走 AI Studio 路径；只有 .env 预置且开了 GEMINI_VERTEX 才走 Vertex
      this.client = config.geminiVertex && !this.apiKey
        ? new GoogleGenAI({ vertexai: true, project: config.gcpProject, location: config.gcpLocation })
        : new GoogleGenAI({ apiKey: this.apiKey ?? config.geminiApiKey, ...(this.baseUrl ? { httpOptions: { baseUrl: this.baseUrl } } : {}) });
    }
    const t0 = Date.now();
    try {
      const parts = [...(images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.dataBase64 } })), { text: prompt }];
      const r = await this.client.models.generateContent({
        model, contents: [{ role: 'user', parts }],
        // 缺省给到模型上限 65536（含思考，§17 v1.03）；显式给的上限再留 8000 给思考。总超时放宽到 10 分钟，作业时限管总长
        config: { systemInstruction: system, maxOutputTokens: maxTokens === undefined ? 65536 : maxTokens + 8000, abortSignal: signal, httpOptions: { timeout: 10 * 60_000 } },
      });
      if (r.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw cutOff('gemini', 'finishReason=MAX_TOKENS');
      const text = r.text ?? '';
      if (!text) throw new ProviderError(`gemini empty response (${r.candidates?.[0]?.finishReason ?? 'no candidate'})`, true);
      const u = r.usageMetadata ?? {};
      return { text, tokensIn: u.promptTokenCount ?? 0, tokensOut: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), model, ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const status = (e as { status?: number }).status ?? Number((e as Error).message.match(/"code":\s*(\d+)/)?.[1] ?? 0);
      throw new ProviderError(`gemini ${status || ''} ${(e as Error).message.slice(0, 300)}`, status === 429 || status === 0 || status >= 500);
    }
  }
}

// OpenAI 兼容端点（REQ-CORE-013）：DeepSeek / Qwen / Moonshot / 智谱 / OpenRouter / Ollama / vLLM / LiteLLM 全走这一档。
// 用 fetch 不引 SDK：协议就是一个 POST，SDK 带来的重试与流式这里都不需要。参考图以 data URL 的 image_url 传。
class OpenAiCompatLlm implements Llm {
  readonly vision = true;
  constructor(private apiKey: string, private baseUrl: string) {}
  // 输出上限缺省 32768（§17 v1.03）：DeepSeek 一类端点不接受这么大的上限、回 400 点名 max_tokens——那就去掉上限按服务端缺省重发一次
  async complete({ system, prompt, images, model = config.model, maxTokens = 32768, signal }: LlmArgs) {
    const t0 = Date.now();
    const content = images?.length
      ? [...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.dataBase64}` } })), { type: 'text', text: prompt }]
      : prompt;
    const post = async (limit: number | null) => {
      const timeout = AbortSignal.timeout(10 * 60_000);
      try {
        return await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model, ...(limit === null ? {} : { max_tokens: limit }), messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        throw new ProviderError(`openai-compatible fetch failed: ${(e as Error).message}`, true);
      }
    };
    let res = await post(maxTokens);
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      if (!/max_(completion_)?tokens/i.test(body)) throw new ProviderError(`openai-compatible 400 ${body.slice(0, 300)}`, false);
      res = await post(null);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`openai-compatible ${res.status} ${body}`, res.status === 429 || res.status >= 500);
    }
    const data = await res.json() as { choices?: { message?: { content?: string | { type: string; text?: string }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (data.choices?.[0]?.finish_reason === 'length') throw cutOff('openai-compatible', 'finish_reason=length');
    const raw = data.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '';
    if (!text) throw new ProviderError('openai-compatible empty response', true);
    return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0, model, ms: Date.now() - t0 };
  }
}

class StubLlm implements Llm {
  readonly vision = true;
  async complete({ system, prompt, model = config.model }: LlmArgs) {
    if (config.llmStub === '503') throw new ProviderError('stub 503', true);
    // 指令里写 [stub-hold:<毫秒>]（随系统提示或用户提示进来）就先拖这么久再回，且不理会中止信号：
    // 用例靠它造出「作业在跑的那一阵」与「模型已经在回来的路上时被取消」（TEST.md §3）
    const hold = Number(/\[stub-hold:(\d+)\]/.exec(`${system}\n${prompt}`)?.[1] ?? 0);
    if (hold) await new Promise((r) => setTimeout(r, hold));
    const isPlan = prompt.startsWith('App:');
    // 改屏要补丁时（提示词里有补丁块的格式说明，ADR-007 v1.05）：[stub-patch] 回一块把第一个 <h1> 的文字换成「Patched title」的补丁，
    // [stub-patch-miss] 回一块在 CURRENT HTML 里找不到的补丁（流水线随后退回整屏提示词，再来的那次回固定整屏）
    const current = prompt.includes(EDIT_BLOCK.find) ? prompt.split('\nCURRENT HTML:\n')[1] : undefined;
    const h1 = current && /<h1[^>]*>[^<]*<\/h1>/.exec(current)?.[0];
    if (current && (prompt.includes('[stub-patch-miss]') || (prompt.includes('[stub-patch]') && h1))) {
      const [find, replace] = prompt.includes('[stub-patch-miss]') ? ['<h1 data-qid="q0">not in this screen</h1>', '<h1>x</h1>'] : [h1!, h1!.replace(/>[^<]*</, '>Patched title<')];
      return { text: `${EDIT_BLOCK.find}\n${find}\n${EDIT_BLOCK.sep}\n${replace}\n${EDIT_BLOCK.replace}`, tokensIn: 1000, tokensOut: 100, model, ms: 5 };
    }
    // 草稿（REQ-CORE-040）：画框先取提示里的 [stub-frame:<画框>]（模拟模型在 auto 时自选），其次取系统提示给定的，再次 component。
    // 草稿里只改一块（REQ-CORE-045，subtreeUserPrompt）回一个认得出的单元素，用例据此核对只换了那一块
    if (system.startsWith(SKETCH_GENERATOR_MARK)) {
      if (prompt.startsWith('Within the screen')) return { text: '<p class="mt-1 text-sm text-[#22d3ee]">Regenerated block</p>', tokensIn: 1000, tokensOut: 50, model, ms: 5 };
      const frame = (/\[stub-frame:(component|mobile|desktop)\]/.exec(prompt)?.[1] ?? /^FRAME: (component|mobile|desktop)\b/m.exec(system)?.[1] ?? 'component') as DraftFrame;
      return { text: fixtureDraft(frame, prompt.includes('[stub-script]')), tokensIn: 1000, tokensOut: 800, model, ms: 5 };
    }
    const text = isPlan
      ? JSON.stringify({ screens: [
          { name: 'Home', route: '/home', purpose: 'Overview', links: ['/list', '/settings'], sections: ['header', 'hero', 'list'] },
          { name: 'List', route: '/list', purpose: 'Items', links: ['/home', '/detail'], sections: ['header', 'filters', 'items'] },
          { name: 'Detail', route: '/detail', purpose: 'One item', links: ['/list'], sections: ['header', 'image', 'facts'] },
          { name: 'Settings', route: '/settings', purpose: 'Preferences', links: ['/home'], sections: ['header', 'toggles'] },
          { name: 'Profile', route: '/profile', purpose: 'Account', links: ['/home', '/settings'], sections: ['header', 'avatar', 'stats'] },
        ] })
      : fixtureScreen(prompt);
    return { text, tokensIn: 1000, tokensOut: 800, model, ms: 5 };
  }
}

function fixtureScreen(prompt: string): string {
  const name = prompt.match(/screen "([^"]+)"/)?.[1] ?? 'Screen';
  const links = [...prompt.matchAll(/(\/[a-z0-9-]+) \(/g)].map((m) => m[1]).slice(0, 4);
  const nav = links.map((r) => `<a href="${r}" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="home" class="w-5 h-5"></i>${r.slice(1)}</a>`).join('');
  return `<div class="min-h-dvh flex flex-col bg-background text-on-background">
<header class="h-14 flex items-center justify-between px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">${name}</h1><button type="button" class="w-10 h-10 flex items-center justify-center rounded-full"><i data-lucide="bell" class="w-5 h-5"></i></button></header>
<main class="flex-1 overflow-y-auto px-4 py-6 space-y-6">
<div class="bg-surface rounded-lg border border-outline-variant p-4"><label for="q" class="text-sm font-medium">Search</label><input id="q" name="q" class="w-full h-12 px-4 rounded-md bg-surface border border-outline-variant text-on-surface placeholder:text-on-surface-variant" placeholder="Search"></div>
<ul class="space-y-0">${[1, 2, 3].map((i) => `<li><a href="${links[0] ?? '/home'}" class="flex items-center gap-3 py-3 border-b border-outline-variant"><img src="https://picsum.photos/seed/${name}${i}/96/96" class="w-12 h-12 rounded-md object-cover" alt="item ${i}"><span class="flex-1 text-sm">Item ${i}</span><i data-lucide="chevron-right" class="w-5 h-5"></i></a></li>`).join('')}</ul>
<button type="button" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Primary action</button>
</main>
<nav class="sticky bottom-0 mt-auto grid grid-cols-4 bg-surface border-t border-outline-variant">${nav}</nav>
</div>`;
}

// 草稿 fixture：component 是一张定宽小卡片，mobile / desktop 是 min-h-dvh 的整页；都带一个 <h1>，[stub-patch] 才有得改。
// withScript（[stub-script]）在根里加一段 <style> 与 <script>：带脚本的草稿不能落成组件（API-CORE-047）
function fixtureDraft(frame: DraftFrame, withScript: boolean): string {
  const extra = withScript ? '\n<style>[data-frame]{box-shadow:0 0 24px #22d3ee}</style>\n<script>window.__stubDraft = true;</script>' : '';
  if (frame === 'component') {
    return `<div data-frame="component" class="w-[360px] rounded-2xl bg-[#111827] p-5 text-white">
<h1 class="text-lg font-semibold">Now playing</h1>
<p class="mt-1 text-sm text-white/70">Midnight City · M83</p>
<div class="mt-4 flex items-center gap-3"><button type="button" class="w-10 h-10 flex items-center justify-center rounded-full bg-white text-[#111827]" aria-label="Play"><i data-lucide="play" class="w-5 h-5"></i></button><div class="h-1.5 flex-1 rounded-full bg-white/20"><div class="h-1.5 w-2/5 rounded-full bg-[#22d3ee]"></div></div></div>${extra}
</div>`;
  }
  const pad = frame === 'mobile' ? 'px-4 py-6' : 'px-10 py-8';
  return `<div data-frame="${frame}" class="min-h-dvh flex flex-col bg-[#0b1020] text-white ${pad}">
<h1 class="text-2xl font-semibold">Weekly budget</h1>
<p class="mt-1 text-sm text-white/60">Oct 13 – Oct 19 · $640 of $900 spent</p>
<ul class="mt-6 divide-y divide-white/10">${['Groceries · $212', 'Transport · $96', 'Dining out · $184'].map((t) => `<li class="py-3 text-sm"><a href="#">${t}</a></li>`).join('')}</ul>${extra}
</div>`;
}

// 驱动按需装配并缓存（REQ-CORE-011）：同一账号可以在不同作业里用不同驱动，
// 所以不能像以前那样在模块加载时定成单例；缺省仍取 .env 的 LLM_DRIVER。
export type LlmDriver = 'agent-sdk' | 'codex' | 'anthropic' | 'gemini' | 'openai' | 'stub';
/** 一次调用要用的驱动与凭据。不带 apiKey / baseUrl 就回落到 .env（系统预置通道的路径） */
export type LlmSpec = { driver: LlmDriver; model?: string; apiKey?: string; baseUrl?: string };
// 实例按（驱动、端点、凭据哈希）缓存：同一账号可以有多条同驱动不同 Key 的通道（REQ-CORE-013）。
// 键里放的是 Key 的 sha256 而不是 Key 本身，避免内存里多一份明文索引。
const drivers = new Map<string, Llm>();
const specKey = (s: LlmSpec) => `${s.driver}|${s.baseUrl ?? ''}|${s.apiKey ? sha256(s.apiKey) : ''}`;
export function llmFor(spec: LlmDriver | LlmSpec = config.llmDriver): Llm {
  const s: LlmSpec = typeof spec === 'string' ? { driver: spec } : spec;
  const k = specKey(s);
  let inst = drivers.get(k);
  if (!inst) {
    if (drivers.size > 64) drivers.clear(); // 换过很多次 Key 的账号不至于让缓存无限长
    inst = s.driver === 'anthropic' ? new AnthropicLlm(s.apiKey, s.baseUrl)
      : s.driver === 'gemini' ? new GeminiLlm(s.apiKey, s.baseUrl)
      : s.driver === 'openai' ? new OpenAiCompatLlm(s.apiKey ?? '', s.baseUrl ?? 'https://api.openai.com/v1')
      : s.driver === 'codex' ? new CodexLlm()
      : s.driver === 'stub' ? new StubLlm() : new AgentSdkLlm();
    drivers.set(k, inst);
  }
  return inst;
}
export const llm: Llm = { vision: true, complete: (args) => llmFor().complete(args) };
/** 建作业时用来挡住「带图却选了没视觉的通道」（REQ-CORE-012） */
export const driverSupportsVision = (driver: LlmDriver = config.llmDriver): boolean => llmFor(driver).vision;

// 5xx/429 指数退避重试 2 次（§17）
export async function completeWithRetry(args: LlmArgs & { driver?: LlmDriver; spec?: LlmSpec }, onRetry?: (n: number, err: Error) => void): Promise<LlmResult> {
  const delays = [2000, 8000];
  const { driver, spec, ...rest } = args;
  for (let attempt = 0; ; attempt++) {
    try { return await llmFor(spec ?? driver).complete(rest); }
    catch (e) {
      const err = e as ProviderError;
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= delays.length || args.signal?.aborted) throw err;
      onRetry?.(attempt + 1, err);
      // 退避可被中止，醒来再判一次：取消或超时落在退避里时不再发下一次调用
      await new Promise<void>((r) => {
        if (args.signal?.aborted) { r(); return; }
        const done = () => { clearTimeout(t); args.signal?.removeEventListener('abort', done); r(); };
        const t = setTimeout(done, delays[attempt]);
        args.signal?.addEventListener('abort', done, { once: true });
      });
      if (args.signal?.aborted) throw err;
    }
  }
}
