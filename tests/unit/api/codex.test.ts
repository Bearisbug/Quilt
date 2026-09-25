import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, open, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Codex 接入（ADR-020）：线程库里只列用户自己开的线程、写锁文件判断已打开；codex exec 的 JSONL 取最后一条回复与用量。
// config 在模块加载时读 QUILT_CODEX_HOME，所以先建假 Codex 目录、设好环境变量，再动态 import
let home: string;
let sessions: typeof import('../../../apps/api/src/lib/codexSessions.ts');
let llm: typeof import('../../../apps/api/src/lib/llm.ts');
let held: FileHandle;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'quilt-unit-codex-'));
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, source TEXT, originator TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER)`);
  const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('01a0d6fc-0000-7000-8000-000000000001', '设计稿', '把首页改成分组列表', '/Users/me/Quilt', 'vscode', 'Codex Desktop', 'user', 0, 3000);
  add.run('01a0d6fc-0000-7000-8000-000000000002', null, '  帮我看看\n这个报错  ', '/Users/me/app', 'vscode', null, 'user', 0, 2000);
  add.run('01a0d6fc-0000-7000-8000-000000000003', null, '终端里的对话', '/Users/me/cli', 'cli', 'codex_cli_rs', 'user', 0, 1000);
  add.run('01a0d6fc-0000-7000-8000-000000000004', null, '无头 exec', '/tmp', 'exec', 'codex_exec', 'user', 0, 4000);
  add.run('01a0d6fc-0000-7000-8000-000000000005', null, '子 agent', '/tmp', '{"subagent":{}}', 'Codex Desktop', 'subagent', 0, 5000);
  add.run('01a0d6fc-0000-7000-8000-000000000006', '归档了', '归档', '/tmp', 'vscode', 'Codex Desktop', 'user', 1, 6000);
  db.close();
  await mkdir(path.join(home, 'thread-writer-locks'));
  // 打开着 = 有进程占着写锁：本进程打开 0001 的锁文件不放；0002 的锁文件在但没人占（进程被杀后留下的残留），应判为未打开
  await writeFile(path.join(home, 'thread-writer-locks', '01a0d6fc-0000-7000-8000-000000000001.lock'), '');
  await writeFile(path.join(home, 'thread-writer-locks', '01a0d6fc-0000-7000-8000-000000000002.lock'), '');
  held = await open(path.join(home, 'thread-writer-locks', '01a0d6fc-0000-7000-8000-000000000001.lock'), 'r');
  process.env.QUILT_CODEX_HOME = home;
  sessions = await import('../../../apps/api/src/lib/codexSessions.ts');
  llm = await import('../../../apps/api/src/lib/llm.ts');
});
after(async () => { await held.close(); await rm(home, { recursive: true, force: true }); });

test('线程列表：只列未归档的用户线程（桌面版 / VS Code / 终端），按最近活跃排序', async () => {
  const { items, reason } = await sessions.listCodexThreads();
  assert.equal(reason, undefined);
  assert.deepEqual(items.map((t) => t.sessionId.slice(-1)), ['1', '2', '3']);
  const [desktop, vscode, cli] = items;
  assert.deepEqual([desktop.name, desktop.named, desktop.app, desktop.open], ['设计稿', true, 'desktop', true]);
  // 没起过名：name 取标题并压空白，named=false；锁文件在但没人占着 = 未打开
  assert.deepEqual([vscode.name, vscode.named, vscode.app, vscode.open], ['帮我看看 这个报错', false, 'vscode', false]);
  assert.equal(cli.app, 'cli');
  assert.ok(items.every((t) => t.tool === 'codex' && t.status === 'unknown'));
});

test('按 id 找线程：exec / 子 agent / 归档的都当不存在', async () => {
  assert.equal((await sessions.findCodexThread('01a0d6fc-0000-7000-8000-000000000002'))?.cwd, '/Users/me/app');
  for (const n of ['4', '5', '6', '9']) assert.equal(await sessions.findCodexThread(`01a0d6fc-0000-7000-8000-00000000000${n}`), null);
});

test('codex exec 事件：取最后一条 agent_message，用量相加，失败带原因', () => {
  const ok = llm.parseCodexEvents([
    '{"type":"thread.started","thread_id":"t"}', 'not json',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"<div>final</div>"}}',
    '{"type":"turn.completed","usage":{"input_tokens":20316,"cached_input_tokens":14000,"output_tokens":40,"reasoning_output_tokens":12}}',
  ]);
  assert.deepEqual(ok, { text: '<div>final</div>', tokensIn: 20316, tokensOut: 52, error: undefined });
  assert.equal(llm.parseCodexEvents(['{"type":"turn.failed","error":{"message":"429 rate limited"}}']).error, '429 rate limited');
  assert.equal(llm.parseCodexEvents(['{"type":"error","message":"not logged in"}']).error, 'not logged in');
});
