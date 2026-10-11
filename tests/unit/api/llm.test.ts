import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// 重试退避期间被取消 / 超时（§11 running→cancelled、§17 LLM 一行，v0.79）：醒来后不再发下一次调用；
// agent-sdk 驱动收到已中止的信号直接拒——对已中止的信号挂监听不会触发，不先判一次就会拉起 SDK 跑完整次调用。
// config 在模块加载时读 LLM_STUB，所以先设好再动态 import：stub 驱动每次都回可重试的 503
let llm: typeof import('../../../apps/api/src/lib/llm.ts');
before(async () => {
  process.env.LLM_STUB = '503';
  llm = await import('../../../apps/api/src/lib/llm.ts');
});

test('退避期间中止：立刻返回、不再发下一次调用', async () => {
  const stub = llm.llmFor('stub');
  const orig = stub.complete.bind(stub);
  let calls = 0;
  stub.complete = (a) => { calls += 1; return orig(a); };
  const abort = new AbortController();
  const t0 = Date.now();
  await assert.rejects(llm.completeWithRetry({ system: '', prompt: 'x', driver: 'stub', signal: abort.signal }, () => abort.abort()), (e: unknown) => e instanceof llm.ProviderError);
  assert.equal(calls, 1, `退避之后又调了 ${calls - 1} 次`);
  assert.ok(Date.now() - t0 < 1000, `中止后还等完了退避（${Date.now() - t0} ms）`);
});

test('agent-sdk：信号已中止就不发起调用', async () => {
  await assert.rejects(llm.llmFor('agent-sdk').complete({ system: '', prompt: 'x', signal: AbortSignal.abort() }), (e: unknown) => e instanceof llm.ProviderError && /aborted/.test(e.message));
});

// Anthropic 驱动是流式的（§17 v1.03）：假端点按 SSE 回一条消息，文字分段送出
function sseMessage(res: http.ServerResponse, chunks: string[], stop: string, stallAfterStart = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if (stallAfterStart) return;
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const c of chunks) ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } });
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: chunks.length } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

// 输出到上限被截断（§17 LLM 一行，v0.90）：API 类驱动把半截文字当产出返回，会被存成丢了后半段的残屏；
// 同样的请求重试还会截在同一处，所以不重试。本地起一个假端点，三家各按自己的停止原因回
test('API 类驱动：停止原因是输出上限 → 不可重试的 ProviderError；正常结束照常返回', async () => {
  let cut = true;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('/messages')) { sseMessage(res, ['<div>half'], cut ? 'max_tokens' : 'end_turn'); return; }
      res.setHeader('content-type', 'application/json');
      if (url.includes(':generateContent')) res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '<div>half' }] }, finishReason: cut ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }));
      else res.end(JSON.stringify({ choices: [{ message: { content: '<div>half' }, finish_reason: cut ? 'length' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const specs = (['anthropic', 'gemini', 'openai'] as const).map((driver) => ({ driver, apiKey: 'k', baseUrl }));
  try {
    for (const s of specs) {
      await assert.rejects(llm.llmFor(s).complete({ system: 's', prompt: 'p', model: 'm' }), (e: unknown) => e instanceof llm.ProviderError && /token limit/.test(e.message) && !e.retryable, s.driver);
    }
    cut = false;
    for (const s of specs) assert.equal((await llm.llmFor(s).complete({ system: 's', prompt: 'p', model: 'm' })).text, '<div>half', s.driver);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// 输出上限与流式（§17 v1.03）：整屏重写的桌面屏要 3–4 万字符。三家各带多大的上限、Anthropic 走流式且长输出不截断；
// 流卡住时按空闲超时判失败、不可重试；OpenAI 兼容端点不收大上限（400 点名 max_tokens）时去掉上限重发一次
test('API 类驱动：输出上限、流式长输出、空闲超时、兼容端点回落', async () => {
  const seen: Record<string, unknown>[] = [];
  let mode: 'long' | 'stall' | 'reject' = 'long';
  const long = Array.from({ length: 400 }, (_, i) => `<p data-i="${i}">${'x'.repeat(90)}</p>`);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      seen.push({ url: req.url, ...body });
      const url = req.url ?? '';
      if (url.includes('/messages')) { sseMessage(res, long, 'end_turn', mode === 'stall'); return; }
      res.setHeader('content-type', 'application/json');
      if (url.includes(':generateContent')) { res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: long.join('') }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })); return; }
      if (mode === 'reject' && 'max_tokens' in body) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'max_tokens must be <= 8192' } })); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: long.join('') }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const spec = (driver: 'anthropic' | 'gemini' | 'openai') => ({ driver, apiKey: 'k', baseUrl });
  try {
    for (const d of ['anthropic', 'gemini', 'openai'] as const) {
      const r = await llm.llmFor(spec(d)).complete({ system: 's', prompt: 'p', model: 'm' });
      assert.equal(r.text.length, long.join('').length, `${d} 长输出被截断`);
    }
    const [a, g, o] = seen;
    assert.equal(a.stream, true); assert.equal(a.max_tokens, 64000);
    assert.equal((g.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens, 65536);
    assert.equal(o.max_tokens, 32768);
    mode = 'stall';
    await assert.rejects(llm.llmFor(spec('anthropic')).complete({ system: 's', prompt: 'p', model: 'm', idleMs: 300 }), (e: unknown) => e instanceof llm.ProviderError && /idle/.test(e.message) && !e.retryable);
    mode = 'reject'; seen.length = 0;
    const r = await llm.llmFor(spec('openai')).complete({ system: 's', prompt: 'p', model: 'm' });
    assert.equal(r.text.length, long.join('').length);
    assert.deepEqual(seen.map((x) => 'max_tokens' in x), [true, false], '400 点名 max_tokens 后应去掉上限重发一次');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
