#!/usr/bin/env node
// codex 桩（TC-AGENT-012）：API 以 QUILT_CODEX_BIN / QUILT_CODEX_OPENER 指向本文件、QUILT_CODEX_HOME 指向假 Codex 目录启动。
// 它只做 Quilt 会用到的四件事，并把每次调用记进 $QUILT_CODEX_HOME/stub-log.jsonl 供用例断言：
//   --version                         → 版本号（通道目录的 hint）
//   queue --thread <id> --message <t> → 记下这条消息，回「Queued message …」（真 codex 的确认句式）；线程 id 以 ffff 结尾时模拟失败
//   codex://threads/<id>（打开深链接）→ 记下，并建该线程的写锁文件——等于桌面版把它打开了
//   exec --json … -                   → 读 stdin，按真 codex 的 JSONL 事件回一段产出；另记下参数与是否带着 API Key
// 「Codex 窗口」那一侧（读队列、经 MCP 回写、收口）由用例脚本扮演，不在这里。
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.QUILT_CODEX_HOME;
if (!home) { console.error('QUILT_CODEX_HOME not set'); process.exit(2); }
const rec = (o) => appendFileSync(path.join(home, 'stub-log.jsonl'), JSON.stringify({ at: Date.now(), ...o }) + '\n');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === '--version') { console.log('codex-cli 0.0.0-stub'); process.exit(0); }

if (args[0] === 'queue') {
  const thread = opt('--thread'); const message = opt('--message');
  if (thread?.endsWith('ffff')) { console.error('Error: thread not found'); process.exit(1); }
  rec({ cmd: 'queue', thread, message });
  console.log(`Queued message ${crypto.randomUUID()} for thread ${thread}.`);
  process.exit(0);
}

if (args[0]?.startsWith('codex://threads/')) {
  const thread = args[0].slice('codex://threads/'.length);
  rec({ cmd: 'open', url: args[0], thread });
  mkdirSync(path.join(home, 'thread-writer-locks'), { recursive: true });
  writeFileSync(path.join(home, 'thread-writer-locks', `${thread}.lock`), '');
  process.exit(0);
}

if (args[0] === 'exec') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', async () => {
    // 验证（只回 OK）故意拖 18 s：真 codex 冷启动约 20 s，超过前端普通请求的 15 s 上限——用来守住验证请求单独的等待上限
    if (/Reply with exactly the word OK/.test(input)) await new Promise((r) => setTimeout(r, 18_000));
    rec({ cmd: 'exec', args, cwd: process.cwd(), hasApiKey: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY), promptChars: input.length, promptHead: input.slice(0, 160) });
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    out({ type: 'thread.started', thread_id: crypto.randomUUID() });
    out({ type: 'turn.started' });
    // 探测（API-CORE-022）问的是「只回 OK」；其余一律回一张带标记的整屏，改屏 / 造屏都能用
    const name = input.match(/(?:screen|Screen) "([^"]+)"/)?.[1] ?? 'Screen 1';
    const text = /Reply with exactly the word OK/.test(input) ? 'OK'
      : `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="h-14 flex items-center px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">${name} (by codex stub)</h1></header><main class="flex-1 px-4 py-6"><a href="/s1" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Home</a></main></div>`;
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 20000, cached_input_tokens: 12000, output_tokens: 300, reasoning_output_tokens: 0 } });
  });
} else {
  console.error(`codex stub: unsupported args ${args.join(' ')}`);
  process.exit(2);
}
