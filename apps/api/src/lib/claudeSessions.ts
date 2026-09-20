import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config.ts';
import type { AgentSessionDto } from '@quilt/core';

// 本机 Claude Code 会话（REQ-AGENT-003 v0.34 / API-AGENT-010）：Claude Code 给每个运行中的会话在 ~/.claude/sessions/<pid>.json
// 登记一份记录（名字、目录、idle/busy、会话间消息的 inbox socket），会话间的 SendMessage 走的就是这条 unix socket——
// 协议是换行分隔的 JSON，注入一条用户消息就是一行 {"type":"user","message":{"role":"user","content":…}}。
// 登记处与线上协议都没有文档（官方只承认导给 hook 的 CLAUDE_CODE_MESSAGING_SOCKET 环境变量），所以：
// 只认 peerProtocol=1 的记录；socket 探活去掉尸体；投递失败让作业直接失败并写明原因，不静默。
type Registry = {
  pid?: number; sessionId?: string; cwd?: string; kind?: string; peerProtocol?: number;
  messagingSocketPath?: string; name?: string; nameSource?: string; status?: string; updatedAt?: number;
};
export type LiveSession = AgentSessionDto & { socketPath: string };

/** 250 ms 连接探活（与 Claude Code 自己去尸体的做法一致） */
function alive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(250, () => done(false));
    s.connect({ path: socketPath });
  });
}

let cache: { at: number; items: LiveSession[] } | null = null;
/** 活着的交互式会话，最近活跃在前；结果缓存 2 s（下拉打开与建作业校验共用） */
export async function listSessions(): Promise<LiveSession[]> {
  if (cache && Date.now() - cache.at < 2000) return cache.items;
  let names: string[] = [];
  try { names = (await readdir(config.claudeSessionsDir)).filter((n) => n.endsWith('.json')); } catch { names = []; }
  const items = (await Promise.all(names.map(async (n): Promise<LiveSession | null> => {
    let rec: Registry;
    try { rec = JSON.parse(await readFile(path.join(config.claudeSessionsDir, n), 'utf8')) as Registry; } catch { return null; }
    if (!rec.sessionId || !rec.messagingSocketPath || rec.kind !== 'interactive' || rec.peerProtocol !== 1) return null;
    if (!(await alive(rec.messagingSocketPath))) return null;
    return {
      sessionId: rec.sessionId, name: rec.name ?? rec.sessionId, named: rec.nameSource === 'user', cwd: rec.cwd ?? '',
      status: rec.status === 'idle' || rec.status === 'busy' ? rec.status : 'unknown',
      updatedAt: new Date(rec.updatedAt ?? 0).toISOString(), socketPath: rec.messagingSocketPath,
    };
  }))).filter((x): x is LiveSession => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  cache = { at: Date.now(), items };
  return items;
}

export async function findSession(sessionId: string): Promise<LiveSession | null> {
  return (await listSessions()).find((s) => s.sessionId === sessionId) ?? null;
}

/** 面向前端的形态：不暴露 socket 路径 */
export const sessionDto = ({ socketPath: _s, ...rest }: LiveSession): AgentSessionDto => { void _s; return rest; };

/** 往会话 inbox 写一行用户消息；写成功即视为已投递（会话间协议的回执外部进程收不到） */
export function injectMessage(socketPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: socketPath });
    s.setTimeout(3000, () => { s.destroy(); reject(new Error('写入会话 inbox 超时')); });
    s.once('error', (e) => reject(new Error(`连不上会话 inbox：${e.message}`)));
    s.once('connect', () => { s.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n', () => resolve()); });
  });
}
