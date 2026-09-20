import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

// 本机 agent CLI 的可用性（REQ-CORE-013 本机通道 / REQ-AGENT-003）：只看 PATH 上有没有 claude——装了才谈得上开着会话。
// 投给哪个会话另由 lib/claudeSessions 决定。放 lib 而不是 worker：services/channels 与 services/jobs 都要问。
export type AgentTool = 'claude-code';
export const AGENT_BIN: Record<AgentTool, string> = { 'claude-code': 'claude' };
export const SETUP_HINT: Record<AgentTool, string> = {
  'claude-code': '安装 Claude Code：npm i -g @anthropic-ai/claude-code，在终端运行 claude 完成登录并让这个会话开着；在会话里执行设置页给的 claude mcp add … quilt 命令接入 Quilt。画布派的活会投递到你在输入框旁选中的那个会话。',
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

const versions = new Map<string, string | undefined>();
function safeVersion(bin: string): string | undefined {
  if (versions.has(bin)) return versions.get(bin);
  let v: string | undefined;
  try { v = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch { v = undefined; }
  versions.set(bin, v);
  return v;
}

export function toolAvailable(tool: string | undefined): { ok: boolean; hint: string; version?: string } {
  if (tool && tool !== 'claude-code') return { ok: false, hint: `本机 agent 只支持 Claude Code（${tool} 尚未接入）` };
  const p = findOnPath(AGENT_BIN['claude-code']);
  if (!p) return { ok: false, hint: `本机没有找到 claude 命令。${SETUP_HINT['claude-code']}` };
  return { ok: true, hint: '', version: safeVersion(p) };
}
