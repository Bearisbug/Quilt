import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureText } from '@quilt/core';

test('failureText：开头按作业种类，原因不带供应商原始报文', () => {
  const gemini = 'gemini 503 {"error":{"code":503,"message":"This model is currently experiencing high demand","status":"UNAVAILABLE"}}';
  const t = failureText('generate', 'provider', gemini);
  assert.ok(t.startsWith('造屏失败：模型服务暂时不可用（HTTP 503）'), t);
  assert.ok(!/[{}]|gemini|UNAVAILABLE/.test(t), t);
  assert.ok(t.includes('重试') && t.includes('换一个通道'), t);
  assert.ok(failureText('edit_screens', 'provider', 'openai-compatible 401 {"error":{"message":"invalid api key"}}').startsWith('改屏失败：通道的 Key 被拒绝（HTTP 401）'));
  assert.ok(failureText('edit_screens', 'provider', 'openai-compatible 401 x').includes('设置 → 生成通道'));
  assert.ok(failureText('chat', 'provider', 'agent-sdk: API Error: 429 rate limited').startsWith('回答失败：通道限流（HTTP 429）'));
  assert.ok(failureText('generate', 'provider', 'agent-sdk: API Error: 400 Claude Code 2.1.263 does not support this model').startsWith('造屏失败：通道拒绝了这次请求（HTTP 400）'));
  assert.ok(failureText('generate', 'provider', 'openai-compatible fetch failed: ECONNREFUSED').startsWith('造屏失败：连不上模型通道或它没有回应'));
  // 中文原因原样保留（本机没装 codex 这类说明本身就是下一步）
  assert.ok(failureText('generate', 'provider', '本机没有找到 codex 命令：安装 Codex').includes('本机没有找到 codex 命令'));
});

test('failureText：改组件不再叫「生成失败」；校验类给中文原因，英文内部原因先译', () => {
  const c = failureText('edit_component', 'validation', '组件必须恰好一个根元素，现在有 0 个');
  assert.ok(c.startsWith('改组件失败：组件必须恰好一个根元素，现在有 0 个。'), c);
  assert.ok(c.includes('重试'), c);
  assert.equal(failureText('edit_screens', 'validation', 'revision conflict').split('。')[0], '改屏失败：这一屏在作业跑的时候被改过');
  assert.equal(failureText('generate', 'validation', 'route already exists').split('。')[0], '造屏失败：这个路由已经有屏了');
  // 译不了的英文不外露
  const u = failureText('generate', 'validation', 'something odd happened');
  assert.ok(!u.includes('something odd'), u);
  assert.ok(failureText('generate', 'timeout', 'job exceeded 480s').startsWith('造屏失败：超过时限没做完'));
  assert.ok(failureText('generate', 'system', 'Quilt 重启时作业未完成').startsWith('造屏失败：Quilt 重启时作业未完成'));
  assert.ok(failureText('generate', 'provider', 'gemini 503 x', 2).includes('已保留 2 屏'));
  assert.ok(failureText('regenerate_subtree', undefined, undefined).startsWith('重做这一块失败'));
});
