import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftNameFromPrompt, forkDraftName, frameFromBody, shotSpecFor, createMessageSchema, updateScreenSchema, copyDraftSchema, createDraftSchema, previewMessageSchema,
  sketchSystemPrompt, sketchRules, forkBody, overwriteBody, SKETCH_GENERATOR_MARK, SOURCE_KINDS, COLOR_CLASS_NAMES, craftRules, defaultComponents, tokensFromSeed,
  DRAFT_FRAME_CHOICES, DEVICE_SIZE, type SketchReference,
} from '@quilt/core';

// 草稿本（REQ-CORE-040～045）的纯函数与 schema：名字、画框解析、截图尺寸、请求校验、预览消息、草稿提示词（含参照项目）、从屏取块与覆盖写回

test('draftNameFromPrompt：取第一行、前 20 个字（按码点）、空串回落「草稿」', () => {
  assert.equal(draftNameFromPrompt('一个音乐播放器的迷你控制条，深色毛玻璃'), '一个音乐播放器的迷你控制条，深色毛玻璃');
  assert.equal(draftNameFromPrompt('  记账 App 首页  \n要有本月支出\r\n和预算'), '记账 App 首页');
  assert.equal(draftNameFromPrompt('第一行\r\n第二行'), '第一行');
  // 超 20 字截断：中文、英文、混排都按字数算
  assert.equal(draftNameFromPrompt('一二三四五六七八九十一二三四五六七八九十多出来的'), '一二三四五六七八九十一二三四五六七八九十');
  assert.equal(draftNameFromPrompt('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrst');
  // emoji 是一个码点两个 UTF-16 单元：按码点截，不会截出半个代理对
  const emoji = draftNameFromPrompt('🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵');
  assert.equal(Array.from(emoji).length, 20);
  assert.equal(emoji, '🎵'.repeat(20));
  assert.ok(!/[\uD800-\uDBFF]$/.test(draftNameFromPrompt(`${'字'.repeat(19)}🎵🎵`)), '末尾不能是落单的高位代理');
  assert.equal(draftNameFromPrompt(`${'字'.repeat(19)}🎵🎵`), `${'字'.repeat(19)}🎵`);
  // 正好 20 字不截
  assert.equal(draftNameFromPrompt('一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四五六七八九十');
  // 空串、只有空白、第一行为空（trim 后取第一行）
  assert.equal(draftNameFromPrompt(''), '草稿');
  assert.equal(draftNameFromPrompt('   \n  '), '草稿');
  assert.equal(draftNameFromPrompt('\n\n下一行才有字'), '下一行才有字');
});

test('frameFromBody：只看 body 里第一个元素的开始标签，引号三种写法都认', () => {
  assert.equal(frameFromBody('<div data-frame="component" class="w-[360px]">x</div>'), 'component');
  assert.equal(frameFromBody("<main data-frame='mobile' class=\"min-h-dvh\"></main>"), 'mobile');
  assert.equal(frameFromBody('<section data-frame=desktop class="min-h-dvh"></section>'), 'desktop');
  assert.equal(frameFromBody('<div data-frame=desktop>x</div>'), 'desktop');
  assert.equal(frameFromBody('<div class="p-4" data-frame = "mobile">x</div>'), 'mobile');
  // 前导空白与注释跳过
  assert.equal(frameFromBody('\n  <!-- hero --> <!-- 第二条 -->\n<div data-frame="mobile"></div>'), 'mobile');
  // 根前面的字体样式表、<style>、<script> 跳过（与截图和测量取草稿根的办法一致）
  assert.equal(frameFromBody('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>.a{color:red}</style><script>var x="<div>"</script>\n<div data-frame="desktop"></div>'), 'desktop');
  assert.equal(frameFromBody('<STYLE>.a{}</STYLE><meta name="x"><section data-frame="mobile"></section>'), 'mobile');
  // 只认第一个元素：后代上的 data-frame 不算
  assert.equal(frameFromBody('<div class="card"><div data-frame="desktop"></div></div>'), null);
  assert.equal(frameFromBody('<div></div><div data-frame="mobile"></div>'), null);
  // 取值不认识、属性名只是前缀相同、根本没有元素
  assert.equal(frameFromBody('<div data-frame="tablet">x</div>'), null);
  assert.equal(frameFromBody('<div data-frame="mobile-ish">x</div>'), null);
  assert.equal(frameFromBody('<div data-frames="mobile">x</div>'), null);
  assert.equal(frameFromBody('<div data-framework="mobile">x</div>'), null);
  assert.equal(frameFromBody('just text'), null);
  assert.equal(frameFromBody(''), null);
});

test('shotSpecFor：草稿按画框，null 按组件；普通项目按设备形态、不看画框', () => {
  const sketch = { kind: 'sketchbook', deviceType: 'mobile' };
  assert.deepEqual(shotSpecFor(sketch, { frame: 'mobile' }), { size: { w: 390, h: 844 }, rootOnly: false });
  assert.deepEqual(shotSpecFor(sketch, { frame: 'desktop' }), { size: { w: 1280, h: 800 }, rootOnly: false });
  assert.deepEqual(shotSpecFor(sketch, { frame: 'component' }), { size: DEVICE_SIZE.desktop, rootOnly: true });
  // 新草稿第一版落库前 frame 还没定：按组件拍根元素
  assert.deepEqual(shotSpecFor(sketch, { frame: null }), { size: DEVICE_SIZE.desktop, rootOnly: true });
  assert.deepEqual(shotSpecFor({ kind: 'app', deviceType: 'mobile' }, { frame: null }), { size: { w: 390, h: 844 }, rootOnly: false });
  assert.deepEqual(shotSpecFor({ kind: 'app', deviceType: 'desktop' }, { frame: null }), { size: { w: 1280, h: 800 }, rootOnly: false });
  // 普通项目的屏不该有画框；万一有，也照项目的设备形态拍
  assert.deepEqual(shotSpecFor({ kind: 'app', deviceType: 'mobile' }, { frame: 'desktop' }), { size: { w: 390, h: 844 }, rootOnly: false });
});

test('createMessageSchema：frame 取 auto / component / mobile / desktop，别的值拒；不带时不补默认', () => {
  for (const frame of DRAFT_FRAME_CHOICES) assert.equal(createMessageSchema.parse({ content: '一张卡片', frame }).frame, frame);
  assert.deepEqual([...DRAFT_FRAME_CHOICES], ['auto', 'component', 'mobile', 'desktop']);
  assert.equal(createMessageSchema.parse({ content: '一张卡片' }).frame, undefined);
  const bad = createMessageSchema.safeParse({ content: '一张卡片', frame: 'tablet' });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error?.issues[0].path, ['frame']);
});

test('updateScreenSchema：frame 只收三种画框（不收 auto），可单独作为一次 PATCH', () => {
  for (const frame of ['component', 'mobile', 'desktop']) assert.deepEqual(updateScreenSchema.parse({ frame }), { frame });
  assert.equal(updateScreenSchema.safeParse({ frame: 'auto' }).success, false);
  assert.equal(updateScreenSchema.safeParse({ frame: 'tablet' }).success, false);
  assert.equal(updateScreenSchema.safeParse({}).success, false);
});

test('copyDraftSchema：as 三选一、restyle 不给时不补（缺省由服务端按参照项目定）、name 修空白且非空', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(copyDraftSchema.parse({ projectId, as: 'screen' }), { projectId, as: 'screen' });
  assert.equal(copyDraftSchema.parse({ projectId, as: 'component', restyle: false }).restyle, false);
  assert.equal(copyDraftSchema.parse({ projectId, as: 'screen', name: '  Player Bar  ' }).name, 'Player Bar');
  assert.equal(copyDraftSchema.safeParse({ projectId, as: 'screen', name: '   ' }).success, false);
  assert.equal(copyDraftSchema.safeParse({ projectId, as: 'screen', name: 'x'.repeat(81) }).success, false);
  assert.equal(copyDraftSchema.safeParse({ projectId, as: 'page' }).success, false);
  assert.equal(copyDraftSchema.safeParse({ projectId: 'not-a-uuid', as: 'screen' }).success, false);
  assert.equal(copyDraftSchema.safeParse({ as: 'screen' }).success, false);
  const runner = { kind: 'model', driver: 'stub', model: 'stub' };
  assert.deepEqual(copyDraftSchema.parse({ projectId, as: 'screen', runner }).runner, runner);
});

test('previewMessageSchema：收 quilt:draft-size，缺字段或类型不对拒', () => {
  const msg = { type: 'quilt:draft-size', screenId: 's1', w: 320, h: 96 };
  assert.deepEqual(previewMessageSchema.parse(msg), msg);
  assert.equal(previewMessageSchema.safeParse({ type: 'quilt:draft-size', screenId: 's1', w: 320 }).success, false);
  assert.equal(previewMessageSchema.safeParse({ type: 'quilt:draft-size', w: 320, h: 96 }).success, false);
  assert.equal(previewMessageSchema.safeParse({ ...msg, w: '320' }).success, false);
});

test('sketchSystemPrompt：以生成器标记开头，auto 要模型在根元素上声明画框，给定画框直接写明，不带设计系统', () => {
  const auto = sketchSystemPrompt('auto');
  assert.ok(auto.startsWith(SKETCH_GENERATOR_MARK), auto.slice(0, 80));
  for (const f of ['component', 'mobile', 'desktop']) assert.ok(auto.includes(`data-frame="${f}"`), `auto 时要列出 data-frame="${f}"`);
  assert.match(auto, /FRAME: auto/);

  const mobile = sketchSystemPrompt('mobile');
  assert.ok(mobile.startsWith(SKETCH_GENERATOR_MARK));
  assert.ok(mobile.includes('data-frame="mobile"') && /390.844/.test(mobile), '给定 mobile 时写明画框与视口');
  assert.ok(!mobile.includes('data-frame="desktop"') && !mobile.includes('data-frame="component"'), '给定画框时不再让模型选');
  assert.ok(sketchSystemPrompt('desktop').includes('data-frame="desktop"'));
  assert.ok(sketchSystemPrompt('component').includes('data-frame="component"'));

  // 造屏提示词里的设计系统、配方、参考屏、素材、审美基线一样都不带；也不要求用 token 类
  for (const p of [auto, mobile]) {
    for (const section of ['\nDESIGN SYSTEM\n', 'COMPONENT RECIPES', 'REFERENCE SCREENS', 'PROJECT ASSETS', 'APP CONTEXT', 'AESTHETIC BASELINE']) assert.ok(!p.includes(section), `草稿提示词不该带「${section.trim()}」`);
    assert.ok(!p.includes(craftRules('mobile')) && !p.includes(craftRules('desktop')), '草稿提示词不该带出屏的审美规则');
    for (const token of ['bg-primary', 'text-on-primary', 'bg-surface', 'text-on-surface', 'border-outline-variant']) assert.ok(!p.includes(token), `草稿提示词不该要求 token 类 ${token}`);
    assert.match(p, /href="#"/, '草稿的链接一律 href="#"');
  }
});

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

test('copyDraftSchema as=overwrite：screenId 与 expectedRevisionId 必填，restyle:true 拒，qid 只收 q<数字>', () => {
  const base = { projectId: ID(1), as: 'overwrite' as const };
  const ok = { ...base, screenId: ID(2), expectedRevisionId: ID(3) };
  assert.deepEqual(copyDraftSchema.parse(ok), ok);
  assert.deepEqual(copyDraftSchema.parse({ ...ok, qid: 'q12', restyle: false }), { ...ok, qid: 'q12', restyle: false });
  const paths = (v: unknown) => { const r = copyDraftSchema.safeParse(v); assert.equal(r.success, false); return r.error!.issues.map((i) => i.path.join('.')).sort(); };
  assert.deepEqual(paths(base), ['expectedRevisionId', 'screenId']);
  assert.deepEqual(paths({ ...base, screenId: ID(2) }), ['expectedRevisionId']);
  assert.deepEqual(paths({ ...ok, restyle: true }), ['restyle']);
  assert.deepEqual(paths({ ...ok, qid: 'main' }), ['qid']);
  assert.deepEqual(paths({ ...ok, screenId: 'nope' }), ['screenId']);
  // 新屏 / 组件不要求目标屏与修订
  assert.equal(copyDraftSchema.safeParse({ projectId: ID(1), as: 'screen', restyle: true }).success, true);
});

test('createDraftSchema：fromScreenId 必填、qid 可选且只收 q<数字>', () => {
  assert.deepEqual(createDraftSchema.parse({ fromScreenId: ID(4) }), { fromScreenId: ID(4) });
  assert.deepEqual(createDraftSchema.parse({ fromScreenId: ID(4), qid: 'q7' }), { fromScreenId: ID(4), qid: 'q7' });
  assert.equal(createDraftSchema.safeParse({}).success, false);
  assert.equal(createDraftSchema.safeParse({ fromScreenId: 'x' }).success, false);
  assert.equal(createDraftSchema.safeParse({ fromScreenId: ID(4), qid: '7' }).success, false);
});

test('updateScreenSchema：refProjectId 收 uuid 与 null（回到自由风格），别的拒', () => {
  assert.deepEqual(updateScreenSchema.parse({ refProjectId: ID(5) }), { refProjectId: ID(5) });
  assert.deepEqual(updateScreenSchema.parse({ refProjectId: null }), { refProjectId: null });
  assert.equal(updateScreenSchema.safeParse({ refProjectId: 'p1' }).success, false);
  assert.ok((SOURCE_KINDS as readonly string[]).includes('fork') && (SOURCE_KINDS as readonly string[]).includes('sketch'), '修订来源要有 fork 与 sketch');
});

test('forkDraftName：整屏取屏名，一块接「 · 」与可见文字前 10 个字（按码点、去首尾空白），没有字只用屏名', () => {
  assert.equal(forkDraftName('Screen 1'), 'Screen 1');
  assert.equal(forkDraftName('首页', '  本月支出 ¥3,486.50 预算 ¥5,000  '), '首页 · 本月支出 ¥3,48');
  assert.equal(forkDraftName('首页', 'Item 1 of screen 2'), '首页 · Item 1 of');
  assert.equal(forkDraftName('首页', '🎵'.repeat(12)), `首页 · ${'🎵'.repeat(10)}`);
  assert.equal(forkDraftName('首页', '   '), '首页');
  assert.equal(forkDraftName('首页', ''), '首页');
});

const SCREEN = '<div data-qid="q1" class="min-h-dvh"><header data-qid="q2"><h1 data-qid="q3">Home</h1></header><main data-qid="q4"><p data-qid="q5">本月 <b data-qid="q6">¥320</b></p><style data-qid="q7">.x{}</style><script data-qid="q8">var s = "脚本里的字";</script></main><nav data-qid="q9" data-component="TabBar"><a data-qid="q10" href="/a">A</a></nav></div>';

test('forkBody：取整个 body 或那一块，来源 qid 不带走、按草稿从 q1 重编，可见文字不含脚本与样式', () => {
  const whole = forkBody(SCREEN)!;
  assert.ok(whole.html.startsWith('<div data-qid="q1" class="min-h-dvh">') && whole.html.includes('data-component="TabBar"'), whole.html.slice(0, 80));
  assert.equal((whole.html.match(/data-qid=/g) ?? []).length, 10);
  const block = forkBody(SCREEN, 'q4')!;
  assert.ok(block.html.startsWith('<main data-qid="q1">'), block.html);
  assert.deepEqual([...block.html.matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]), ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.ok(block.html.includes('<script') && block.html.includes('.x{}'), '草稿内容照带脚本与样式');
  assert.equal(block.text, '本月 ¥320');
  assert.equal(forkBody('<div data-qid="q1"><label data-qid="q2">Address</label><input data-qid="q3"><button data-qid="q4">Follow</button></div>', 'q1')!.text, 'Address Follow', '相邻元素的字之间补空格');
  assert.equal(forkBody(SCREEN, 'q99'), null);
});

test('overwriteBody：整屏换成草稿；换一块时只替换那个元素的子树，根沿用原 qid，兄弟与组件实例原样', () => {
  const draft = '<section data-qid="q1" data-frame="component"><h2 data-qid="q2">新主区</h2></section>';
  assert.deepEqual(overwriteBody(SCREEN, draft), { body: draft, rootQid: null });
  const r = overwriteBody(SCREEN, draft, 'q4')!;
  assert.equal(r.rootQid, 'q4');
  assert.ok(r.body.includes('<section data-qid="q4" data-frame="component"><h2 data-qid="q11">新主区</h2></section>'), r.body);
  assert.ok(!r.body.includes('<main') && !r.body.includes('¥320'), '旧主区应整块换掉');
  assert.ok(r.body.includes('<header data-qid="q2"><h1 data-qid="q3">Home</h1></header>'), '兄弟不动');
  assert.ok(r.body.includes('<nav data-qid="q9" data-component="TabBar"><a data-qid="q10" href="/a">A</a></nav>'), '组件实例不动');
  assert.equal(overwriteBody(SCREEN, draft, 'q99'), null);
});

const REF: SketchReference = {
  app: { name: 'Ledger', description: 'existing app', brief: '记账 App，给上班族记日常开销。' },
  tokens: tokensFromSeed('#0CA678'), designMd: '# Ledger 设计系统\n## 约定\n- 金额一律 tabular-nums',
  components: defaultComponents('mobile'), registry: [{ route: '/home', name: 'Home', purpose: '总览' }, { route: '/add', name: 'Add' }],
};

test('sketchSystemPrompt 带参照项目：DESIGN.md、token 类、配方与路由表都在，风格与链接换成按它写，画框一节不变', () => {
  const p = sketchSystemPrompt('component', REF);
  assert.ok(p.startsWith(SKETCH_GENERATOR_MARK), p.slice(0, 80));
  assert.ok(p.includes('REFERENCE PROJECT: Ledger — 记账 App'), '写明参照项目与简介');
  assert.ok(p.includes('\nDESIGN SYSTEM\n# Ledger 设计系统') && p.includes('金额一律 tabular-nums'), '带 DESIGN.md 全文');
  assert.ok(p.includes(COLOR_CLASS_NAMES.join(', ')), '带 token 类清单');
  assert.ok(p.includes('COMPONENT RECIPES') && p.includes('PrimaryButton:'), '带组件配方');
  assert.ok(p.includes('/home (Home: 总览), /add (Add)'), '带路由表');
  assert.ok(p.includes('token classes') && !p.includes('There is no design system'), '风格一条换成按参照项目');
  assert.ok(p.includes('<a href="/route">') && !p.includes('every link and link-like action is href="#"'), '链接可写参照项目的路由');
  // stub 驱动按 FRAME 行定画框（apps/api/src/lib/llm.ts），参照段不能干扰它
  assert.deepEqual(p.match(/^FRAME: .*/gm), ['FRAME: component']);
  assert.ok(p.includes(sketchRules(true)) && !p.includes(sketchRules(false)));
  // 不带参照时与原来一样：自由风格
  assert.ok(sketchSystemPrompt('component').includes(sketchRules(false)) && !sketchSystemPrompt('component').includes('REFERENCE PROJECT'));
});

test('sketchRules：有无参照只差风格与链接两条，其余规则共用一份', () => {
  const free = sketchRules().split('\n');
  const ref = sketchRules(true).split('\n');
  assert.equal(free.length, ref.length);
  const diff = free.map((l, i) => (l === ref[i] ? null : l.slice(0, 8))).filter(Boolean);
  assert.deepEqual(diff, ['- Style:', '- Links:']);
});
