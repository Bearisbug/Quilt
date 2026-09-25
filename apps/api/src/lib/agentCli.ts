import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '@quilt/core';
import { config } from '../config.ts';

// 本机 agent CLI 的可用性（REQ-CORE-013 本机通道 / REQ-AGENT-003）：只看 PATH 上有没有 claude / codex——装了才谈得上开着会话。
// 投给哪个会话另由 lib/claudeSessions、lib/codexSessions 决定。放 lib 而不是 worker：services/channels 与 services/jobs 都要问。
export const AGENT_BIN: Record<AgentTool, string> = { 'claude-code': 'claude', codex: 'codex' };
const mcpUrl = () => `http://127.0.0.1:${config.apiPort}/mcp`;
export const SETUP_HINT: Record<AgentTool, string> = {
  'claude-code': '安装 Claude Code：npm i -g @anthropic-ai/claude-code，在终端运行 claude 完成登录并让这个会话开着；在会话里执行设置页给的 claude mcp add … quilt 命令接入 Quilt。画布派的活会投递到你在输入框旁选中的那个会话。',
  // 线程在打开时加载 MCP 配置，接入后要新开或重开线程；Codex 默认每次调 MCP 工具都要批准，投来的作业才能自己跑完得预先放行（ADR-020）
  get codex() { return `安装 Codex（桌面版，或 npm i -g @openai/codex），运行 codex 用 ChatGPT 账号登录；执行 codex mcp add quilt --url ${mcpUrl()} 接入 Quilt，再在 ~/.codex/config.toml 的 [mcp_servers.quilt] 下加一行 default_tools_approval_mode = "approve"（不加的话每次调 Quilt 工具都要你在 Codex 里点批准）；接入后新开或重开线程才会加载。画布派的活会投递到你在输入框旁选中的 Codex 线程；线程没打开时 Quilt 会让 Codex 桌面版打开它。`; },
};

// PATH 上找命令（不用 which：Windows 没有），结果缓存 10 s——通道目录每次刷新都会问
const found = new Map<string, { at: number; path: string | null }>();
export function findOnPath(bin: string): string | null {
  const hit = found.get(bin);
  if (hit && Date.now() - hit.at < 10_000) return hit.path;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  let result: string | null = null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { accessSync(p, constants.X_OK); result = p; break; } catch { /* next */ }
    }
    if (result) break;
  }
  found.set(bin, { at: Date.now(), path: result });
  return result;
}

/** codex 命令的路径：测试可用 QUILT_CODEX_BIN 换成桩 */
export const codexBin = (): string | null => config.codexBin || findOnPath(AGENT_BIN.codex);

const versions = new Map<string, string | undefined>();
function safeVersion(bin: string): string | undefined {
  if (versions.has(bin)) return versions.get(bin);
  let v: string | undefined;
  try { v = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch { v = undefined; }
  versions.set(bin, v);
  return v;
}

export function toolAvailable(tool: string = 'claude-code'): { ok: boolean; hint: string; version?: string } {
  if (tool !== 'claude-code' && tool !== 'codex') return { ok: false, hint: `本机 agent 只支持 Claude Code 与 Codex（${tool} 尚未接入）` };
  const p = tool === 'codex' ? codexBin() : findOnPath(AGENT_BIN[tool]);
  if (!p) return { ok: false, hint: `本机没有找到 ${AGENT_BIN[tool]} 命令。${SETUP_HINT[tool]}` };
  return { ok: true, hint: '', version: safeVersion(p) };
}
