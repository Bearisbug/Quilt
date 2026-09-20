import { createServer, type Server } from 'node:http';

// 本地 OpenAI 兼容桩（REQ-CORE-013 用例用）：只认一个 Key，回固定内容；记录收到的请求供断言。
// 用它验证的是「通道 → 驱动 → 端点」这条管道，不是模型质量。
export type StubHit = { model: string; hasImage: boolean; auth: string | undefined; user: string; system: string };
export function startOpenAiStub(opts: { port: number; apiKey: string; reply: string | ((hit: StubHit) => string) }): { server: Server; hits: StubHit[]; url: string; close: () => Promise<void> } {
  const hits: StubHit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${opts.apiKey}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid api key' } })); return; }
      const j = JSON.parse(body || '{}') as { model?: string; messages?: { role: string; content: unknown }[] };
      const user = j.messages?.find((m) => m.role === 'user');
      const userText = typeof user?.content === 'string' ? user.content : Array.isArray(user?.content) ? (user!.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') : '';
      const systemText = (j.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const hit: StubHit = { system: systemText, model: j.model ?? '', hasImage: Array.isArray(user?.content) && (user!.content as { type: string }[]).some((p) => p.type === 'image_url'), auth: req.headers.authorization, user: userText };
      hits.push(hit);
      const text = typeof opts.reply === 'function' ? opts.reply(hit) : opts.reply;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }));
    });
  });
  server.listen(opts.port, '127.0.0.1');
  return { server, hits, url: `http://127.0.0.1:${opts.port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}
