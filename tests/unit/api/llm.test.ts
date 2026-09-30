import { test, before } from 'node:test';
import assert from 'node:assert/strict';

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
