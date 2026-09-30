import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSdkOutput, ProviderError } from '../../../apps/api/src/lib/llm.ts';

// 本机 Claude 订阅（§17 Claude Agent SDK，v0.71）：API 报错时 SDK 的 result 仍是 subtype=success，只在 is_error 上标出、
// 错误原文放在 result 里——当成产出往下传，改组件就报「0 个根元素」、通道验证照样通过
test('agent-sdk result: success → text + usage; is_error → ProviderError carrying the API text', () => {
  const ok = agentSdkOutput({ subtype: 'success', is_error: false, result: '<div>ok</div>', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
  assert.deepEqual(ok, { text: '<div>ok</div>', tokensIn: 100, tokensOut: 5 });

  const msg = 'API Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required.';
  assert.throws(() => agentSdkOutput({ subtype: 'success', is_error: true, api_error_status: 400, result: msg }),
    (e: unknown) => e instanceof ProviderError && e.message.includes('2.1.280 or newer') && !e.retryable);
  assert.throws(() => agentSdkOutput({ subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 overloaded' }),
    (e: unknown) => e instanceof ProviderError && e.retryable);
  assert.throws(() => agentSdkOutput({ subtype: 'error_during_execution', is_error: true }), (e: unknown) => e instanceof ProviderError && e.retryable);
});
