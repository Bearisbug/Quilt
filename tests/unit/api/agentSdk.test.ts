import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSdkOutput, agentSdkTurn, ProviderError } from '../../../apps/api/src/lib/llm.ts';

// 本机 Claude 订阅（§17 Claude Agent SDK，v0.71）：API 报错时 SDK 的 result 仍是 subtype=success，只在 is_error 上标出、
// 错误原文放在 result 里——当成产出往下传，改组件就报「0 个根元素」、通道验证照样通过
test('agent-sdk result: success → text + usage; is_error → ProviderError carrying the API text', () => {
  const ok = agentSdkOutput({ subtype: 'success', is_error: false, result: '<div>ok</div>', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
  assert.deepEqual(ok, { text: '<div>ok</div>', tokensIn: 100, tokensOut: 5, cacheRead: 90, cacheWrite: 0 });

  const msg = 'API Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required.';
  assert.throws(() => agentSdkOutput({ subtype: 'success', is_error: true, api_error_status: 400, result: msg }),
    (e: unknown) => e instanceof ProviderError && e.message.includes('2.1.280 or newer') && !e.retryable);
  assert.throws(() => agentSdkOutput({ subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 overloaded' }),
    (e: unknown) => e instanceof ProviderError && e.retryable);
  assert.throws(() => agentSdkOutput({ subtype: 'error_during_execution', is_error: true }), (e: unknown) => e instanceof ProviderError && e.retryable);
});

// 输出超过单次上限（§17 Claude Agent SDK，v0.90）：SDK 自带的 Claude Code 发「接着写」续上，result 只装最后一段——
// Omnivia「管理总览」改屏落下的就是后一段，侧边栏、页头都丢了。消息序列照实测录的（输出上限 1200 token，60 行分 3 段）
test('agent-sdk turn: the text is every reply of the turn in order, not just the last one', async () => {
  async function* turn() {
    yield { type: 'system', subtype: 'init' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '<aside>side</aside><section class="border border-' }] } };
    yield { type: 'user', message: { content: [{ type: 'text', text: 'Output token limit hit. Resume directly' }] } };
    yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'outline-variant">tail</section>' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'outline-variant">tail</section>', usage: { input_tokens: 10, output_tokens: 7 } };
  }
  assert.deepEqual(await agentSdkTurn(turn()), { text: '<aside>side</aside><section class="border border-outline-variant">tail</section>', tokensIn: 10, tokensOut: 7, cacheRead: 0, cacheWrite: 0 });

  // 续写用尽：最后一条是合成的报错消息（带 error），result 是报错原文且 is_error——按失败处理，不拼出半截产出
  const msg = "API Error: Claude's response exceeded the 32000 output token maximum.";
  async function* exhausted() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '<div>part' }] } };
    yield { type: 'assistant', error: 'max_output_tokens', message: { content: [{ type: 'text', text: msg }] } };
    yield { type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: msg };
  }
  await assert.rejects(agentSdkTurn(exhausted()), (e: unknown) => e instanceof ProviderError && e.message.includes('output token maximum') && !e.retryable);
});
