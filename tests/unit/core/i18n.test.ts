import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLocale, parseLocale, withUiLanguage, uiLanguageRule, jobLocale, textIn, L, failureText } from '@quilt/core';

// 界面语言（REQ-CORE-046）：X-Quilt-Locale 优先，其次 Accept-Language，两者都没有时中文
test('pickLocale：X-Quilt-Locale 有效就用它，不看 Accept-Language', () => {
  assert.equal(pickLocale('en', 'zh-CN,zh;q=0.9'), 'en');
  assert.equal(pickLocale('zh', 'en-US'), 'zh');
  assert.equal(pickLocale(' EN ', null), 'en');
});

test('pickLocale：没有 X-Quilt-Locale（或取值不认识）时按 Accept-Language 优先级最高的一项，以 zh 开头为中文、其余英文', () => {
  assert.equal(pickLocale(null, 'zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(pickLocale(undefined, 'zh-TW'), 'zh');
  assert.equal(pickLocale(null, 'en-US,en;q=0.9,zh-CN;q=0.8'), 'en');
  assert.equal(pickLocale(null, 'fr-FR'), 'en');
  assert.equal(pickLocale('fr', 'ja'), 'en');
  assert.equal(pickLocale(null, 'en;q=0.5, zh-CN;q=0.9'), 'zh');
  assert.equal(pickLocale(null, 'zh;q=0, en'), 'en');
});

test('pickLocale：两者都没有、或 Accept-Language 只有 *（Node 的 fetch 缺省带它）时中文——MCP 与脚本照旧拿中文', () => {
  assert.equal(pickLocale(), 'zh');
  assert.equal(pickLocale(null, ''), 'zh');
  assert.equal(pickLocale(null, '*'), 'zh');
  assert.equal(pickLocale('', '  '), 'zh');
});

test('parseLocale 只认 zh / en', () => {
  assert.equal(parseLocale('zh'), 'zh');
  assert.equal(parseLocale('EN'), 'en');
  assert.equal(parseLocale('zh-CN'), null);
  assert.equal(parseLocale(null), null);
});

test('withUiLanguage：带 locale 的写屏作业在提示词末尾补一句语言要求', () => {
  const sys = 'SYSTEM PROMPT';
  const en = withUiLanguage(sys, { kind: 'generate', input: { prompt: '做一个登录页', locale: 'en' } });
  assert.equal(en, `${sys}\n\n${uiLanguageRule('en')}`);
  assert.match(en, /unless the request explicitly asks for a language, write all visible text on the screen in English/);
  for (const kind of ['edit_screens', 'edit_component', 'regenerate_subtree']) {
    assert.match(withUiLanguage(sys, { kind, input: { locale: 'zh' } }), /in Simplified Chinese\. This takes precedence/, kind);
  }
});

test('withUiLanguage：不带 locale（MCP、脚本建的）或不写屏上文字的作业原样返回', () => {
  const sys = 'SYSTEM PROMPT';
  assert.equal(withUiLanguage(sys, { kind: 'generate', input: { prompt: 'x' } }), sys);
  assert.equal(withUiLanguage(sys, { kind: 'edit_screens', input: { locale: 'fr' } }), sys);
  assert.equal(withUiLanguage(sys, { kind: 'propose_design_system', input: { locale: 'en' } }), sys);
  assert.equal(withUiLanguage(sys, { kind: 'chat', input: { locale: 'en' } }), sys);
});

test('jobLocale / textIn / L', () => {
  assert.equal(jobLocale({ input: { locale: 'en' } }), 'en');
  assert.equal(jobLocale({ input: {} }), null);
  assert.equal(jobLocale({ input: null }), null);
  assert.equal(textIn(L('资源不存在', 'Not found'), 'en'), 'Not found');
  assert.equal(textIn(L('资源不存在', 'Not found'), 'zh'), '资源不存在');
  assert.equal(textIn('原样', 'en'), '原样');
});

test('failureText 缺省 locale 是中文，与不传时逐字相同', () => {
  const a = failureText('generate', 'timeout', 'x');
  assert.equal(failureText('generate', 'timeout', 'x', 0, 'zh'), a);
  assert.ok(a.startsWith('造屏失败：超过时限没做完'), a);
});
