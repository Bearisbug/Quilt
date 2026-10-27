import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConventions, withConventions, estimateJob, presetPrompt, presetNote, missingPagePrompt, variantPrompt, ROUND_PRESET_PROMPTS, LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT, craftRules, screenSystemPrompt, chatSystemPrompt, newProjectDesign, tokensFromSeed, lintScreenBody, NEUTRAL_PALETTE, type CreateJobInput } from '@quilt/core';

test('parseConventions / withConventions 往返：追加、替换、清空、只吃到下一节', () => {
  const md = '# D\n\nintro\n\n## 组件\n- x\n';
  assert.deepEqual(parseConventions(md), []);
  const w = withConventions(md, ['A', ' B ']);
  assert.ok(w.endsWith('\n## 约定\n- A\n- B\n'), w);
  assert.deepEqual(parseConventions(w), ['A', 'B']);
  const w2 = withConventions(w, ['C']);
  assert.deepEqual(parseConventions(w2), ['C']);
  assert.equal((w2.match(/## 约定/g) ?? []).length, 1);
  assert.equal(withConventions(w2, []), md);
  assert.deepEqual(parseConventions('## 约定\n- one\n\n## 后面\n- not'), ['one']);
});

test('estimateJob：造 / 改 / 局部 / 聊天 / 改组件 / 回刷', () => {
  const job = (j: unknown) => estimateJob(j as CreateJobInput, 10);
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 'auto', versions: 1 } }), { calls: 7, screens: 5 });
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 2, versions: 3 } }), { calls: 8, screens: 6 });
  assert.deepEqual(job({ kind: 'generate', input: { prompt: 'p', count: 1, versions: 1, route: '/x' } }), { calls: 2, screens: 1 });
  assert.deepEqual(job({ kind: 'edit_screens', input: { screenIds: ['a', 'b'], prompt: 'p', versions: 2 } }), { calls: 4, screens: 4 });
  assert.deepEqual(job({ kind: 'regenerate_subtree', input: {} }), { calls: 1, screens: 1 });
  assert.deepEqual(job({ kind: 'chat', input: {} }), { calls: 8, screens: 0 });
  assert.deepEqual(job({ kind: 'edit_component', input: {} }), { calls: 1, screens: 0 });
  assert.deepEqual(job({ kind: 'apply_design_system', input: {} }), { calls: 0, screens: 0 });
});

test('estimateJob：造变体按钉死路由算（1 屏、不规划、不补链）', () => {
  assert.deepEqual(estimateJob({ kind: 'generate', input: { prompt: 'p', count: 'auto', versions: 2, variantOf: 'x', variantName: '空态' } } as unknown as CreateJobInput, 10), { calls: 2, screens: 2 });
});

test('系统代发轮次的提示词底稿与附加要求（REQ-CORE-026 v0.74）：拼接与反解往返', () => {
  assert.equal(presetPrompt(LINK_REPAIR_PROMPT, ''), LINK_REPAIR_PROMPT, '留空 = 与重试同一份提示词');
  assert.equal(presetPrompt(LINK_REPAIR_PROMPT, '  '), LINK_REPAIR_PROMPT);
  const p = presetPrompt(CONVENTIONS_REGENERATE_PROMPT, ' 标题用衬线字体 ');
  assert.equal(p, `${CONVENTIONS_REGENERATE_PROMPT}\n\nADDITIONAL REQUIREMENTS FROM THE USER: 标题用衬线字体`);
  assert.equal(presetNote(p, CONVENTIONS_REGENERATE_PROMPT), '标题用衬线字体');
  assert.equal(presetNote(LINK_REPAIR_PROMPT, LINK_REPAIR_PROMPT), '');
  assert.equal(presetNote(p, LINK_REPAIR_PROMPT), null, '不是这份底稿');
  assert.equal(presetNote('随便一句话', missingPagePrompt('/help')), null);
  assert.equal(presetNote(presetPrompt(missingPagePrompt('/help'), '带搜索'), missingPagePrompt('/help')), '带搜索');
  assert.equal(ROUND_PRESET_PROMPTS.link_repair, LINK_REPAIR_PROMPT);
  assert.equal(variantPrompt('空态'), 'The 空态 state');
});

// 美学基线（ADR-028 v0.92）：出屏系统提示里恰好一段、在输出规则之后与 DESIGN SYSTEM 之前；设备行只进自己的设备；
// 聊天助手同样带。规则只用 token 类与 Tailwind 默认刻度——任意值、hex、内联样式会被 lint 记成偏离，规则自己不能带头
test('craftRules：位置、设备行、聊天也带、不含任意值 / hex / 内联样式、长度上限；输出规则里的改句', () => {
  const reg = [{ route: '/home', name: 'Home' }];
  for (const device of ['mobile', 'desktop'] as const) {
    const d = newProjectDesign('App', device, '#3B5BDB');
    const sys = screenSystemPrompt({ name: 'App', description: 'd' }, device, d.tokens, d.designMd, d.components, reg, []);
    const craft = craftRules(device);
    assert.equal(sys.split('\nAESTHETIC BASELINE (').length - 1, 1, `${device}: 应恰好一段`);
    assert.ok(sys.includes(craft), device);
    assert.ok(sys.indexOf('OUTPUT RULES') < sys.indexOf('\nAESTHETIC BASELINE (') && sys.indexOf('\nAESTHETIC BASELINE (') < sys.indexOf('\nDESIGN SYSTEM\n'), `${device}: 应在输出规则与 DESIGN SYSTEM 之间`);
    assert.equal(craft.includes('- Mobile:'), device === 'mobile');
    assert.equal(craft.includes('- Desktop:'), device === 'desktop');
    assert.ok(!/\[|#[0-9a-f]{3,8}\b|style=|`|\$\{/i.test(craft), `${device}: 规则里不该有任意值、hex、内联样式或模板残留`);
    assert.ok(craft.length <= 4800, `${device}: ${craft.length} 字超出预算`);
    // 输出规则里的改句（ADR-027 ④、ADR-028 ④）
    assert.ok(!sys.includes('Shadows: shadow-sm by default.') && sys.includes('Shadows: none on in-flow content'), device);
    assert.ok(sys.includes('picsum returns a RANDOM photo') && sys.includes('else the app name alone as a text wordmark'), device);
    assert.ok(sys.includes('h-11 (44px) on mobile and h-8 (32px) on desktop'), device);
    assert.ok(sys.includes('using any lucide icon name') && sys.includes('rounded-full only for avatars') && !sys.includes('are the house scale'), device);
    const chat = chatSystemPrompt({ app: { name: 'App', description: 'd' }, device, designMd: 'x', screens: [], projectId: 'p', jobId: 'j', designVersion: 1 });
    assert.ok(chat.includes(craft) && chat.indexOf(craft) < chat.indexOf('\nDESIGN SYSTEM\n'), `${device}: 聊天助手也带、在 DESIGN SYSTEM 之前`);
  }
});

// 新建项目的设计系统（ADR-028 v0.92）：中性色板的对比度（发丝线低于盲评机械指标里「粗线」的 1.5:1）、sharp 圆角档、按设备的配方不带胶囊与大圆角且 lint 干净、DESIGN.md 与之同口径
const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('newProjectDesign：中性色板对比度、sharp 圆角、配方无胶囊无大圆角且 lint 干净、DESIGN.md 同口径', () => {
  for (const mode of ['light', 'dark'] as const) {
    const c = tokensFromSeed('#3B5BDB', { palette: NEUTRAL_PALETTE[mode], colorMode: mode }).colors;
    for (const bg of [c.surface, c.background]) {
      assert.ok(contrast(c.outlineVariant, bg) < 1.5, `${mode}: 发丝线 ${contrast(c.outlineVariant, bg).toFixed(2)}:1 太重`);
      assert.ok(contrast(c.outline, bg) >= 3, `${mode}: 输入框边框 ${contrast(c.outline, bg).toFixed(2)}:1 不到 3:1`);
      assert.ok(contrast(c.onSurfaceVariant, bg) >= 4.5, `${mode}: 次要文字 ${contrast(c.onSurfaceVariant, bg).toFixed(2)}:1 不到 4.5:1`);
    }
    assert.ok(contrast(c.onSurfaceVariant, c.surfaceVariant) >= 4.5 && contrast(c.onSecondaryContainer, c.secondaryContainer) >= 7, mode);
  }
  for (const device of ['mobile', 'desktop'] as const) {
    const d = newProjectDesign('App', device, '#3B5BDB');
    assert.deepEqual(d.tokens.radius, { sm: '2px', md: '4px', lg: '8px', full: '9999px' });
    assert.deepEqual(d.palette, NEUTRAL_PALETTE);
    assert.equal(d.tokens.colors.primary, tokensFromSeed('#3B5BDB').colors.primary, '强调色仍由种子色派生');
    for (const r of d.components) {
      const pill = /rounded-full/.test(r.html) && !['Avatar', 'Badge', 'ProgressBar'].includes(r.name);
      assert.ok(!pill && !/rounded-(xl|2xl|3xl)|shadow/.test(r.html), `${device} ${r.name}: 不该是胶囊、大圆角或带阴影`);
    }
    const body = `<div class="min-h-dvh flex flex-col bg-background text-on-background">${d.components.map((r) => (r.html.includes('</') || r.html.startsWith('<input') ? r.html : `${r.html}</${r.html.match(/^<([a-z]+)/)![1]}>`)).join('')}</div>`;
    assert.deepEqual(lintScreenBody(body, ['/home'], true).violations, [], `${device}: 配方本身不该有偏离`);
    for (const h of ['## Overview', '## Colors', '## Typography', '## Layout', '## Elevation', '## Shapes', '## Components', "## Do's and Don'ts"]) assert.ok(d.designMd.includes(h), `${device}: DESIGN.md 缺 ${h}`);
    assert.ok(d.designMd.includes('No pill buttons') && d.designMd.includes(d.components.map((r) => r.name).join(', ')), device);
  }
});

test('只改选中的几块（REQ-EDIT-002 v1.50）：单块与多块的提示词都要求只改里面、不用脚本挪元素，要动外面时只回 <quilt-needs-outer/>', async () => {
  const { subtreeUserPrompt, subtreeBlocksUserPrompt, NEEDS_OUTER_REPLY, NEEDS_OUTER_RE } = await import('@quilt/core');
  const one = subtreeUserPrompt('Home', '/home', '<p>x</p>', '挪到右边');
  const many = subtreeBlocksUserPrompt('Home', '/home', [{ qid: 'q1', html: '<p>a</p>' }, { qid: 'q2', html: '<p>b</p>' }], '挪到右边');
  for (const p of [one, many]) {
    assert.ok(p.includes(NEEDS_OUTER_REPLY) && /do not add a <script> that moves elements/.test(p) && /parents?, (?:its |their )?siblings/.test(p), p);
    // 规则写在原 HTML 之前，原 HTML 照旧是提示词末尾
    assert.ok(p.indexOf(NEEDS_OUTER_REPLY) < p.indexOf('<p>'), p);
  }
  assert.ok(many.includes(`${NEEDS_OUTER_REPLY} instead of the blocks`), many);
  for (const reply of [NEEDS_OUTER_REPLY, '<quilt-needs-outer />', '```html\n<quilt-needs-outer>\n```']) assert.ok(NEEDS_OUTER_RE.test(reply), reply);
  assert.ok(!NEEDS_OUTER_RE.test('<quilt-block qid="q1">\n<p>a</p>\n</quilt-block>'));
});
