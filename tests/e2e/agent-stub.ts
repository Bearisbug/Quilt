import { mkdir, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { connectMcp, callTool } from './mcp-client.ts';

// 假会话（TC-AGENT-009）：模仿 Claude Code 的会话登记处（<pid>.json）+ inbox socket。API 以 QUILT_CLAUDE_SESSIONS_DIR 指向同一目录启动，
// 画布投递的提示词就会写到这里的 socket。收到后按指令里的关键字行动（环境对每个作业都一样，只能从提示词里区分）：
//   HANG → 什么都不做（供取消 / 屏锁用例）；FAIL → 直接 quilt.finish_job failed；STALE → 用假基线回写 → 409 → finish_job failed 带错误；
//   其余 → 按提示词里的 expectedRevisionId 回写后 finish_job succeeded
export type FakeSession = { sessionId: string; name: string; received: string[]; close: () => Promise<void> };
export async function startFakeSession(opts: { dir: string; name: string; nameSource: 'user' | 'derived'; status?: 'idle' | 'busy'; updatedAt?: number; mcpUrl?: string }): Promise<FakeSession> {
  await mkdir(opts.dir, { recursive: true });
  const sessionId = crypto.randomUUID();
  const pid = 100000 + Math.floor(Math.random() * 800000); // 假 pid，只作文件名
  const sock = path.join(opts.dir, `${pid}.sock`);
  const file = path.join(opts.dir, `${pid}.json`);
  const received: string[] = [];
  const log = (s: string) => console.log(`[fake-session ${opts.name}] ${s}`);

  const act = async (prompt: string) => {
    const jobId = prompt.match(/\(job ([0-9a-f-]{36})\)/)?.[1];
    const projectId = prompt.match(/projectId ([0-9a-f-]{36})/)?.[1];
    const target = prompt.match(/screenId=([0-9a-f-]{36}) expectedRevisionId=([0-9a-f-]{36}|none)/);
    if (!jobId || !projectId || !target) { log('prompt missing job / project / target'); return; }
    if (/HANG/.test(prompt)) { log('hanging'); return; }
    const mcp = await connectMcp(opts.mcpUrl);
    try {
      if (/FAIL/.test(prompt)) { await callTool(mcp, 'quilt.finish_job', { jobId, status: 'failed', summary: 'simulated failure' }); log('reported failure'); return; }
      const [, screenId, expected] = target;
      const screen = await callTool(mcp, 'quilt.get_screen', { screenId });
      // get_screen 给的是 body（v0.64）；去掉 qid 与脚本，改一处文案当标记
      const body = screen.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\sdata-qid="q\d+"/g, '').replace('Screen 1', 'Screen 1 (by fake session)').trim();
      const stale = /STALE/.test(prompt);
      const r = await callTool(mcp, 'quilt.update_screen', { projectId, screenId, name: 'Screen 1', route: '/s1', html: body, jobId, expectedRevisionId: stale ? '00000000-0000-4000-8000-000000000000' : expected === 'none' ? undefined : expected });
      if (r.isError) { await callTool(mcp, 'quilt.finish_job', { jobId, status: 'failed', summary: `update_screen error: ${r.text.slice(0, 160)}` }); log('update_screen failed → reported'); return; }
      await callTool(mcp, 'quilt.finish_job', { jobId, summary: 'rewrote Screen 1 as asked' });
      log('done');
    } finally { await mcp.close(); }
  };

  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d.toString('utf8'); });
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        try { const m = JSON.parse(line) as { message?: { content?: unknown } }; const text = m?.message?.content; if (typeof text === 'string') { received.push(text); void act(text).catch((e) => log(`act error ${(e as Error).message}`)); } }
        catch { log('non-JSON line ignored'); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const now = opts.updatedAt ?? Date.now();
  await writeFile(file, JSON.stringify({ pid, sessionId, cwd: process.cwd(), startedAt: now, version: '2.1.257', peerProtocol: 1, peerFeatures: [], kind: 'interactive', entrypoint: 'cli', messagingSocketPath: sock, name: opts.name, nameSource: opts.nameSource, status: opts.status ?? 'idle', updatedAt: now }));
  return { sessionId, name: opts.name, received, close: async () => { await new Promise<void>((r) => server.close(() => r())); await rm(file, { force: true }); await rm(sock, { force: true }); } };
}
