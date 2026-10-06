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

// 输出到上限被截断（§17 LLM 一行，v0.90）：API 类驱动把半截文字当产出返回，会被存成丢了后半段的残屏；
// 同样的请求重试还会截在同一处，所以不重试。本地起一个假端点，三家各按自己的停止原因回
test('API 类驱动：停止原因是输出上限 → 不可重试的 ProviderError；正常结束照常返回', async () => {
  let cut = true;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (url.includes('/messages')) res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: '<div>half' }], stop_reason: cut ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      else if (url.includes(':generateContent')) res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '<div>half' }] }, finishReason: cut ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }));
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
