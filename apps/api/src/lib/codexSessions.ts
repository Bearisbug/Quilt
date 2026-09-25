import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentSessionDto } from '@quilt/core';
import { config } from '../config.ts';
import { codexBin } from './agentCli.ts';

// 本机 Codex 线程（REQ-AGENT-003 v0.68 / ADR-020 / API-AGENT-010）。Codex 没有 Claude Code 那种 inbox socket，投递走文档化的
// `codex queue --thread <id> --message …`：Codex 的每个 app-server（桌面版、VS Code 插件、终端）都开着同一个队列库，
// 线程在哪个窗口里打开就由哪个取走、排在当前这一轮之后执行。线程清单读 Codex 自己的线程库（只读）；打开与否看写锁文件
// 此刻有没有进程占着——只看文件在不在不行：进程被杀掉时锁文件会留下（实测），误判成「已打开」就不会去开深链接，消息没人取。
// 线程库文件名带版本号（state_5.sqlite），升级可能换名：取目录里编号最大的那个。
export type CodexThread = AgentSessionDto & { tool: 'codex' };

function stateDb(): string | null {
  let names: string[] = [];
  try { names = readdirSync(config.codexHome); } catch { return null; }
  const hits = names.map((n) => ({ n, v: Number(n.match(/^state_(\d+)\.sqlite$/)?.[1] ?? NaN) })).filter((x) => Number.isFinite(x.v));
  if (!hits.length) return null;
  return path.join(config.codexHome, hits.sort((a, b) => b.v - a.v)[0].n);
}

type Row = { id: string; name: string | null; title: string | null; cwd: string | null; source: string | null; originator: string | null; updated_at_ms: number | null };
// 只列用户自己开的对话：thread_source=user、来源为桌面版 / VS Code 插件（source=vscode）或终端（cli）；
// 无头 exec、子 agent、审查线程不是用户能看着干活的窗口，不列
const WHERE = `archived = 0 AND thread_source = 'user' AND source IN ('vscode', 'cli')`;
const COLS = 'id, name, title, cwd, source, originator, updated_at_ms';

/** 读线程库；读不了（目录不存在、Node < 22.13 没有 node:sqlite、表结构变了）时带原因返回空 */
async function query(sql: string, ...args: (string | number)[]): Promise<{ rows: Row[]; reason?: string }> {
  const file = stateDb();
  if (!file) return { rows: [], reason: `没有找到 Codex 线程库（${config.codexHome}）` };
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); } catch { return { rows: [], reason: '读取 Codex 线程库需要 Node ≥ 22.13' }; }
  let db: import('node:sqlite').DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    return { rows: db.prepare(sql).all(...args) as unknown as Row[] };
  } catch (e) {
    return { rows: [], reason: `读取 Codex 线程库失败：${(e as Error).message}` };
  } finally { db?.close(); }
}

const lockDir = () => path.join(config.codexHome, 'thread-writer-locks');
/** 被进程占着的写锁 = 此刻打开着的线程。lsof 查占用（macOS / Linux 自带，查几个文件约 0.3 s）；
 *  没有 lsof（Windows）时退回「锁文件在即打开」 */
async function openThreadIds(): Promise<Set<string>> {
  let files: string[] = [];
  try { files = readdirSync(lockDir()).filter((n) => n.endsWith('.lock')); } catch { return new Set(); }
  if (!files.length) return new Set();
  const ids = (names: string[]) => new Set(names.map((n) => path.basename(n, '.lock')));
  return new Promise((resolve) => {
    // 有文件没被占用时 lsof 退出码是 1，但占着的那些照样输出在 stdout，所以按输出解析、不看退出码
    execFile('lsof', ['-F', 'n', '--', ...files], { cwd: lockDir(), timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(ids(files)); return; }
      resolve(ids(stdout.split('\n').filter((l) => l.startsWith('n') && l.endsWith('.lock')).map((l) => path.basename(l.slice(1)))));
    });
  });
}
const toDto = (r: Row, open: Set<string>): CodexThread => {
  const name = (r.name ?? '').trim();
  return {
    tool: 'codex', sessionId: r.id, name: name || (r.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || r.id, named: !!name, cwd: r.cwd ?? '',
    status: 'unknown', open: open.has(r.id),
    app: r.source === 'cli' ? 'cli' : r.originator === 'Codex Desktop' ? 'desktop' : 'vscode',
    updatedAt: new Date(r.updated_at_ms ?? 0).toISOString(),
  };
};

let cache: { at: number; items: CodexThread[]; reason?: string } | null = null;
/** 最近活跃的 50 个用户线程（打开与否都列）；缓存 2 s（下拉打开与建作业校验共用） */
export async function listCodexThreads(): Promise<{ items: CodexThread[]; reason?: string }> {
  if (cache && Date.now() - cache.at < 2000) return cache;
  const { rows, reason } = await query(`SELECT ${COLS} FROM threads WHERE ${WHERE} ORDER BY updated_at_ms DESC LIMIT 50`);
  const open = await openThreadIds();
  cache = { at: Date.now(), items: rows.map((r) => toDto(r, open)), reason };
  return cache;
}

/** 按 id 找线程（不受前 50 的限制）：建作业校验与投递都用它 */
export async function findCodexThread(id: string): Promise<CodexThread | null> {
  const { rows } = await query(`SELECT ${COLS} FROM threads WHERE ${WHERE} AND id = ?`, id);
  return rows[0] ? toDto(rows[0], await openThreadIds()) : null;
}

function run(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** 排一条用户消息进线程的队列；codex 回「Queued message … for thread …」即算投递出去 */
export async function queueCodexMessage(threadId: string, message: string): Promise<void> {
  const bin = codexBin();
  if (!bin) throw new Error('本机没有找到 codex 命令');
  const out = await run(bin, ['queue', '--thread', threadId, '--message', message], 20_000);
  if (!/Queued message/i.test(out)) throw new Error(`codex queue 没有确认入队：${out.trim().slice(0, 200)}`);
}

/** 让 Codex 桌面版打开线程（会切到前台），它打开时取走排队的消息 */
export async function openCodexThread(threadId: string): Promise<void> {
  const url = `codex://threads/${threadId}`;
  const [bin, ...pre] = config.codexOpener ? [config.codexOpener]
    : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
  await run(bin, [...pre, url], 10_000);
}
