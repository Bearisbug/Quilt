import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureText } from '@quilt/core';

test('failureText：开头按作业种类，原因不带供应商原始报文', () => {
  const gemini = 'gemini 503 {"error":{"code":503,"message":"This model is currently experiencing high demand","status":"UNAVAILABLE"}}';
  const t = failureText('generate', 'provider', gemini);
  assert.ok(t.startsWith('造屏失败：模型服务暂时不可用（HTTP 503）'), t);
  assert.ok(!/[{}]|gemini|UNAVAILABLE/.test(t), t);
  assert.ok(t.includes('重试') && t.includes('换一个模型'), t);
  assert.ok(failureText('edit_screens', 'provider', 'openai-compatible 401 {"error":{"message":"invalid api key"}}').startsWith('改屏失败：模型的 Key 被拒绝（HTTP 401）'));
  assert.ok(failureText('edit_screens', 'provider', 'openai-compatible 401 x').includes('设置 → 模型'));
  assert.ok(failureText('chat', 'provider', 'agent-sdk: API Error: 429 rate limited').startsWith('回答失败：模型限流（HTTP 429）'));
  assert.ok(failureText('generate', 'provider', 'agent-sdk: API Error: 400 Claude Code 2.1.263 does not support this model').startsWith('造屏失败：模型拒绝了这次请求（HTTP 400）'));
  assert.ok(failureText('generate', 'provider', 'openai-compatible fetch failed: ECONNREFUSED').startsWith('造屏失败：连不上模型或它没有回应'));
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

test('failureText：输出到上限被截断单列原因，报文里的上限数字不当成 HTTP 状态', () => {
  const a = failureText('edit_screens', 'provider', 'gemini output hit the token limit (finishReason=MAX_TOKENS)');
  assert.ok(a.startsWith('改屏失败：模型这次要写的内容超过了单次输出上限，结果不完整，没有保存。'), a);
  assert.ok(a.includes('拆成几次'), a);
  const b = failureText('edit_screens', 'provider', "agent-sdk: API Error: Claude's response exceeded the 500 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.");
  assert.ok(b.startsWith('改屏失败：模型这次要写的内容超过了单次输出上限'), b);
});

test('failureText：没有「重试」的作业写各自再发一次的入口（v1.17，作业 chip 上只有能原样重试的四类带「重试」）', () => {
  for (const [kind, want] of [['export_prototype', '「导出原型」'], ['regenerate_subtree', '「重生成这块」'], ['apply_design_system', '设计系统面板'], ['propose_design_system', '设计系统面板']] as const) {
    for (const cls of [undefined, 'system', 'quality', 'provider', 'agent'] as const) {
      const t = failureText(kind, cls, 'HTTP 500 upstream');
      assert.ok(t.includes(want) && !t.includes('重试'), `${kind}/${cls ?? '无类别'}：${t}`);
    }
    // Key 被拒、模型拒绝请求：下一步先修模型，再说从哪儿再发一次
    for (const msg of ['HTTP 401 unauthorized', 'HTTP 403 forbidden', 'HTTP 400 bad request']) {
      const t = failureText(kind, 'provider', msg);
      assert.ok(t.includes(want) && !t.includes('重试'), `${kind}/${msg}：${t}`);
    }
  }
  assert.ok(failureText('edit_screens', 'system', 'boom').includes('点「重试」'), '能重试的作业照旧写「点「重试」」');
});

// 英文版（REQ-CORE-046）：逐句对应中文版，英文界面里不夹中文
test('failureText 英文版：开头按作业种类，原因与下一步逐句对应中文版', () => {
  const gemini = 'gemini 503 {"error":{"code":503,"message":"This model is currently experiencing high demand","status":"UNAVAILABLE"}}';
  const t = failureText('generate', 'provider', gemini, 0, 'en');
  assert.ok(t.startsWith('Generation failed: the model service is temporarily unavailable (HTTP 503). '), t);
  assert.ok(!/[{}]|gemini|UNAVAILABLE/.test(t), t);
  assert.ok(t.includes('“Retry”') && t.includes('another model'), t);
  assert.equal(failureText('edit_screens', 'provider', 'openai-compatible 401 x', 0, 'en'),
    'Edit failed: the model’s key was rejected (HTTP 401). Check this model’s key in Settings → Models, or send again with another model');
  assert.ok(failureText('chat', 'provider', 'agent-sdk: API Error: 429 rate limited', 0, 'en').startsWith('Reply failed: the model is rate limited (HTTP 429)'));
  assert.ok(failureText('generate', 'provider', 'API Error: 400 nope', 0, 'en').startsWith('Generation failed: the model rejected this request (HTTP 400)'));
  assert.ok(failureText('generate', 'provider', 'fetch failed: ECONNREFUSED', 0, 'en').startsWith('Generation failed: could not reach the model, or it did not respond'));
  assert.ok(failureText('edit_screens', 'provider', 'gemini output hit the token limit (finishReason=MAX_TOKENS)', 0, 'en').endsWith('. Split this request into several smaller ones'));
  assert.ok(failureText('generate', 'timeout', 'job exceeded 480s', 0, 'en').startsWith('Generation failed: it did not finish within the time limit. Click “Retry”'));
  assert.equal(failureText('edit_screens', 'validation', 'revision conflict', 0, 'en').split('. ')[0], 'Edit failed: this screen was changed while the job was running');
  assert.ok(!failureText('generate', 'validation', 'something odd happened', 0, 'en').includes('something odd'));
  assert.ok(failureText('regenerate_subtree', undefined, undefined, 0, 'en').startsWith('Regenerating this block failed. '));
  assert.ok(failureText(null, 'system', 'x', 0, 'en').startsWith('Job failed: Quilt hit an internal error'));
});

test('failureText 英文版：已保留的屏分单复数', () => {
  assert.ok(failureText('generate', 'provider', 'gemini 503 x', 1, 'en').includes('(HTTP 503); 1 screen kept. '));
  assert.ok(failureText('generate', 'provider', 'gemini 503 x', 2, 'en').includes('(HTTP 503); 2 screens kept. '));
});

test('failureText 英文版：中文原因换成英文，认不得的退回按类别的通用原因', () => {
  assert.ok(failureText('edit_component', 'validation', '组件必须恰好一个根元素，现在有 0 个', 0, 'en').startsWith('Component edit failed: a component must have exactly one root element; this one has 0. '));
  assert.ok(failureText('generate', 'system', 'Quilt 重启时作业未完成', 0, 'en').startsWith('Generation failed: the job had not finished when Quilt restarted. '));
  assert.ok(failureText('generate', 'provider', '本机没有找到 codex 命令：安装 Codex 并运行 codex 用 ChatGPT 账号登录', 0, 'en').startsWith('Generation failed: the codex command was not found on this machine; install Codex'));
  // 「模型不可用：…」「投递失败：…」：后半句认得就接上，认不得只说前半句；v1.24 之前落库的「通道…」原文同样认得
  assert.ok(failureText('generate', 'validation', '模型不可用：模型没有密钥', 0, 'en').startsWith('Generation failed: the model is unavailable: the model has no key. '));
  assert.ok(failureText('generate', 'validation', '通道不可用：通道没有密钥', 0, 'en').startsWith('Generation failed: the model is unavailable: the model has no key. '));
  assert.ok(failureText('chat', 'validation', '聊天只能用「本机 Claude 订阅」通道', 0, 'en').startsWith('Reply failed: chat only works with a Local Claude subscription model. '));
  assert.ok(failureText('generate', 'validation', '通道不可用：boom', 0, 'en').startsWith('Generation failed: the model is unavailable. '));
  assert.ok(failureText('generate', 'agent', '投递失败：写入会话 inbox 超时', 0, 'en').startsWith('Generation failed: delivery failed: timed out writing to the session inbox. '));
  assert.ok(failureText('generate', 'agent', '一句表里没有的中文', 0, 'en').startsWith('Generation failed: the local session did not finish. '));
  assert.ok(failureText('generate', 'validation', '一句表里没有的中文', 0, 'en').startsWith('Generation failed: the model output did not pass the checks. '));
  // 同样的输入中文版照旧原样写中文原因
  assert.ok(failureText('generate', 'agent', '一句表里没有的中文').startsWith('造屏失败：一句表里没有的中文。'));
});

test('failureText 英文版：没有「重试」的作业写各自再发一次的入口，下一步首字母大写、整句不夹中文', () => {
  for (const [kind, want] of [['export_prototype', '“Export prototype”'], ['regenerate_subtree', '“Regenerate block”'], ['apply_design_system', 'design system panel'], ['propose_design_system', 'design system panel']] as const) {
    for (const cls of [undefined, 'system', 'quality', 'provider', 'agent'] as const) {
      const t = failureText(kind, cls, 'HTTP 500 upstream', 0, 'en');
      assert.ok(t.includes(want) && !t.includes('“Retry”'), `${kind}/${cls ?? '无类别'}：${t}`);
    }
  }
  const kinds = ['generate', 'edit_screens', 'edit_component', 'regenerate_subtree', 'apply_design_system', 'propose_design_system', 'export_prototype', 'ingest_screen', 'chat', null] as const;
  const msgs = ['HTTP 401 x', 'HTTP 400 x', 'HTTP 502 x', 'output token maximum', 'revision conflict', 'odd', '组件里不能再放别的共享组件', '通道不可用：通道已删除或不属于该账号', '模型不可用：模型已删除或不属于该账号', '表里没有的中文', ''];
  for (const kind of kinds) for (const cls of [undefined, 'provider', 'timeout', 'agent', 'system', 'validation', 'quality'] as const) for (const msg of msgs) {
    const t = failureText(kind, cls, msg, 2, 'en');
    assert.ok(!/[\u3400-\u9fff「」，。；：]/.test(t), `${kind}/${cls}/${msg}：${t}`);
    assert.match(t, /\. [A-Z]/, t);
  }
});

test('failureText：只改选中的几块要动外面一层（v1.50）——模型通道与本机会话同一句，下一步是选到外层', () => {
  for (const cls of ['validation', 'agent'] as const) {
    assert.equal(failureText('regenerate_subtree', cls, 'needs outer element'), '重做这一块失败：要改的是它外面那一层，只改选中的这块做不到。按 Shift+↑ 选到外层再说一遍');
    assert.equal(failureText('regenerate_subtree', cls, 'needs outer element', 0, 'en'), 'Regenerating this block failed: this change needs the element around it, so it cannot be done on the selected block alone. Press Shift+↑ to select the element around it and send again');
  }
  // 会话写的 summary 带句号、大小写不同也认
  assert.ok(failureText('regenerate_subtree', 'agent', 'Needs outer element.').includes('选到外层'));
  // 别的本机会话失败照旧
  assert.ok(failureText('regenerate_subtree', 'agent', 'gave up').startsWith('重做这一块失败：本机会话没有完成'));
});
