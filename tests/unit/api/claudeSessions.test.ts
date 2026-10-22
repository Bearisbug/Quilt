import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// 本机 Claude Code 会话列表（API-AGENT-010）：登记处一个进程一份 <pid>.json，同一会话被两个活进程登记时只列一条（最近活跃的那份）。
// config 在模块加载时读 QUILT_CLAUDE_SESSIONS_DIR，所以先建假登记处、设好环境变量，再动态 import
let dir: string;
let sessions: typeof import('../../../apps/api/src/lib/claudeSessions.ts');
const servers: net.Server[] = [];
const SID = '7d0c1e9a-0000-4000-8000-000000000001';

async function register(pid: number, updatedAt: number): Promise<string> {
  const socketPath = path.join(dir, `${pid}.sock`);
  const server = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  await writeFile(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: SID, cwd: '/Users/me/app', kind: 'interactive', peerProtocol: 1, version: '2.1.300',
    messagingSocketPath: socketPath, name: '同一会话', nameSource: 'user', status: 'idle', updatedAt,
  }));
  return socketPath;
}

let newer: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'quilt-unit-cc-'));
  await register(101, 1_000);
  newer = await register(102, 2_000);
  process.env.QUILT_CLAUDE_SESSIONS_DIR = dir;
  sessions = await import('../../../apps/api/src/lib/claudeSessions.ts');
});
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(dir, { recursive: true, force: true });
});

test('同一会话被两个活进程登记：只列一条，留最近活跃的那份；投递也找它', async () => {
  const items = await sessions.listSessions();
  assert.equal(items.length, 1);
  assert.equal(items[0].sessionId, SID);
  assert.equal(items[0].socketPath, newer);
  assert.equal(items[0].updatedAt, new Date(2_000).toISOString());
  assert.equal((await sessions.findSession(SID))?.socketPath, newer);
});
