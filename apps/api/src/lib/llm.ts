import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { sha256 } from './signing.ts';
import { codexBin } from './agentCli.ts';

// LLM 适配层（§17 Claude API）。驱动：anthropic（生产，API key）| agent-sdk（本机 Claude 订阅，仅开发）| codex（本机 Codex 订阅，v0.68）
// | gemini | openai（兼容端点）| stub（测试故障注入/回放）。
export type LlmResult = { text: string; tokensIn: number; tokensOut: number; model: string; ms: number };
export class ProviderError extends Error { constructor(msg: string, public retryable: boolean) { super(msg); } }

// 参考图（REQ-CORE-012）：正文以 base64 随请求走，不给模型发 URL——签名 URL 会过期，
// 而且让供应商回源取图等于把可用性押在我们的对象存储上。
export type LlmImage = { mediaType: string; dataBase64: string };
export type LlmArgs = { system: string; prompt: string; images?: LlmImage[]; model?: string; maxTokens?: number; signal?: AbortSignal };

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
  async complete({ system, prompt, images, model = config.model, maxTokens = 12000, signal }: LlmArgs) {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey ?? config.anthropicApiKey, baseURL: this.baseUrl, maxRetries: 0 });
    }
    const t0 = Date.now();
    try {
      const msg = await this.client.messages.create(
        {
          model, max_tokens: maxTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          // 图在文字之前：参考图要先被看到，后面的指令才有指代对象
          messages: [{ role: 'user', content: [
            ...(images ?? []).map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.dataBase64 } })),
            { type: 'text' as const, text: prompt },
          ] }],
        },
        { signal, timeout: 120_000 },
      );
      const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      return { text, tokensIn: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), tokensOut: msg.usage.output_tokens, model, ms: Date.now() - t0 };
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new ProviderError(`anthropic ${status ?? ''} ${(e as Error).message}`, status === 429 || (status ?? 500) >= 500);
    }
  }
}

class AgentSdkLlm implements Llm {
  // 参考图（REQ-CORE-012）：query() 除了纯字符串还接受 AsyncIterable<SDKUserMessage>，
  // 而 SDKUserMessage.message 就是 Anthropic 的 MessageParam，内容块可以带 image。
  // 带图时切到这个形态；不带图仍走字符串，少一层包装。
  readonly vision = true;
  async complete({ system, prompt, images, model = config.model, signal }: LlmArgs) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'quilt-api/0.1.0' };
    delete env.ANTHROPIC_API_KEY;
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
    const q = query({ prompt: promptArg, options: { systemPrompt: { type: 'custom', prompt: system }, tools: [], maxTurns: 1, model, permissionMode: 'dontAsk', settingSources: [], env, abortController: abort } });
    for await (const m of q) {
      if (m.type === 'result') {
        const r = m as { subtype: string; result?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } };
        if (r.subtype !== 'success') throw new ProviderError(`agent-sdk ${r.subtype}`, true);
        const u = r.usage ?? {};
        return { text: String(r.result ?? ''), tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tokensOut: u.output_tokens ?? 0, model, ms: Date.now() - t0 };
      }
    }
    throw new ProviderError('agent-sdk: no result', true);
  }
}

// 本机 Codex 订阅（v0.68 ADR-020）：每次拉起本机 codex exec，复用它的 ChatGPT 登录态。
// --ephemeral：不在用户的 Codex 历史里留会话；空的临时目录 + 只读沙箱：它是出 HTML 的，不该去翻用户的仓库。
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

class CodexLlm implements Llm {
  readonly vision = true;
  async complete({ system, prompt, images, model, signal }: LlmArgs) {
    const bin = codexBin();
    if (!bin) throw new ProviderError('本机没有找到 codex 命令：安装 Codex 并运行 codex 用 ChatGPT 账号登录', false);
    const t0 = Date.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'quilt-codex-'));
    try {
      const files = await Promise.all((images ?? []).map(async (im, i) => {
        const f = path.join(dir, `reference-${i + 1}.${im.mediaType.split('/')[1] ?? 'png'}`);
        await writeFile(f, Buffer.from(im.dataBase64, 'base64'));
        return f;
      }));
      // 提示词用 - 从 stdin 读，放在 -i 之前：-i 收多个值，放后面会把 - 当成图片路径吃掉
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, ...(model ? ['-m', model] : []), '-', ...files.flatMap((f) => ['-i', f])];
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
        child.once('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(new ProviderError(`codex 启动失败：${e.message}`, false)); });
        child.once('close', (c) => { signal?.removeEventListener('abort', onAbort); if (buf) out.push(buf); resolve({ code: c, lines: out, stderr: err }); });
        child.stdin.end(`${system}\n\n---\n\n${prompt}`);
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
  async complete({ system, prompt, images, model = config.model, maxTokens = 12000, signal }: LlmArgs) {
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
        config: { systemInstruction: system, maxOutputTokens: maxTokens + 8000, abortSignal: signal, httpOptions: { timeout: 120_000 } },
      });
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
  async complete({ system, prompt, images, model = config.model, maxTokens = 12000, signal }: LlmArgs) {
    const t0 = Date.now();
    const content = images?.length
      ? [...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.dataBase64}` } })), { type: 'text', text: prompt }]
      : prompt;
    const timeout = AbortSignal.timeout(120_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new ProviderError(`openai-compatible fetch failed: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`openai-compatible ${res.status} ${body}`, res.status === 429 || res.status >= 500);
    }
    const data = await res.json() as { choices?: { message?: { content?: string | { type: string; text?: string }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const raw = data.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '';
    if (!text) throw new ProviderError('openai-compatible empty response', true);
    return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0, model, ms: Date.now() - t0 };
  }
}

class StubLlm implements Llm {
  readonly vision = true;
  async complete({ prompt, model = config.model }: LlmArgs) {
    if (config.llmStub === '503') throw new ProviderError('stub 503', true);
    const isPlan = prompt.startsWith('App:');
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
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}
