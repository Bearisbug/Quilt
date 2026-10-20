import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { L, createMessageSchema, copyDraftSchema, fontFamilySchema, fontUrlSchema, componentNameSchema, updateComponentSchema, createChannelSchema } from '@quilt/core';
import { localeMiddleware, requestLocale, requestUiLocale, outsideRequest, tr, listJoin, countEn } from '../../../apps/api/src/lib/locale.ts';
import { Problem, problems, problemResponse, ISSUE_EN } from '../../../apps/api/src/lib/errors.ts';
import { setupHint, toolAvailable } from '../../../apps/api/src/lib/agentCli.ts';
import type { Env } from '../../../apps/api/src/http/app.ts';

// 接口错误文案的英文版（REQ-CORE-046）：problems.* 的 title、zod 自定义 message 的英文登记、worker 的语言作用域与本机 agent 提示
const CJK = /[\u3400-\u9fff]/;

// 改造前的中文 title，逐字不变（e2e 与 MCP 调用方读它们）；新加 problems.* 时在这里登记
const ZH: Record<keyof typeof problems, string> = {
  validation: '请求参数不合法', unprocessable: '请求参数不合法', forbidden: '签名无效', previewTokenInvalid: '预览签名无效或过期', notFound: '资源不存在',
  elementNotFound: '元素在当前修订中不存在', routeTaken: '路由在项目内已占用', screenBusy: '目标屏有进行中的作业', componentBusy: '组件「Nav」正在改，等这一轮完事',
  projectBusy: '项目有进行中的作业，先取消或等它完成', revisionConflict: '修订已被更新', componentLocked: '这个元素属于共享组件「Nav」，改组件或先脱离共享',
  componentNameTaken: '组件名在项目内已占用', versionConflict: '设计系统版本冲突', jobFinished: '作业已结束', jobNotFinished: '作业尚未完成',
  lintFailed: 'HTML 违反设计契约', rateLimited: '请求过于频繁', providerUnavailable: 'LLM 供应商不可用',
};
const ARGS: Partial<Record<keyof typeof problems, unknown[]>> = { componentBusy: ['Nav'], componentLocked: ['Nav'], rateLimited: [3], validation: [[]], unprocessable: [[]], lintFailed: [[]] };
const make = (name: keyof typeof problems): Problem => (problems[name] as (...a: unknown[]) => Problem)(...(ARGS[name] ?? []));

test('problems.*：中文 title 逐字不变，英文 title 不带中文，type / status / 扩展字段两种语言一样', () => {
  assert.deepEqual(Object.keys(problems).sort(), Object.keys(ZH).sort(), '新加的 problems.* 要在 ZH 里登记中文 title');
  for (const name of Object.keys(ZH) as (keyof typeof problems)[]) {
    const p = make(name);
    const zh = p.body('zh');
    const en = p.body('en');
    assert.equal(zh.title, ZH[name], name);
    assert.equal(p.title, ZH[name], `${name}：Problem.title 恒为中文（日志读它）`);
    assert.ok(typeof en.title === 'string' && en.title.length > 0 && !CJK.test(en.title), `${name} 的英文 title：${en.title}`);
    assert.deepEqual({ ...en, title: '' }, { ...zh, title: '' }, `${name}：除 title 外两种语言一样`);
  }
  // 插值的组件名两种语言都带上，扩展字段里的组件名不翻
  assert.equal(problems.componentBusy('Nav').body('en').title, 'Component “Nav” is being edited; wait for this round to finish');
  assert.equal(problems.componentLocked('Nav').body('en').component, 'Nav');
  assert.equal(problems.rateLimited(3).body('en').retryAfter, 3);
});

// 出口按请求的语言：X-Quilt-Locale 优先，其次 Accept-Language；detail 与 errors[].message 一起换
function app() {
  const a = new Hono<Env>();
  a.use('*', localeMiddleware);
  a.onError((err, c) => problemResponse(c, err as Problem));
  a.get('/busy', () => { throw problems.screenBusy(); });
  a.get('/export', () => { throw new Problem(404, '/errors/not-found', L('资源不存在', 'Not found'), { detail: L('导出文件已清理（超过 24 小时），重新导出一次', 'The export file was cleaned up (older than 24 hours); export again') }); });
  // 同 parseBody：zod 的 issue 原样进 errors[]，自定义中文 message 在出口按 ISSUE_EN 换
  a.post('/channels', async (c) => {
    const r = createChannelSchema.safeParse(await c.req.json());
    if (!r.success) throw problems.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return c.json({ ok: true });
  });
  return a;
}
const call = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app().request(path, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('出口：英文请求拿到英文 title / detail / errors[].message，不带语言头的照旧中文', async () => {
  assert.deepEqual(await (await call('/busy', { 'X-Quilt-Locale': 'en' })).json(), { type: '/errors/screen-busy', title: 'The target screen has a job in progress', status: 409 });
  assert.deepEqual(await (await call('/busy', { 'Accept-Language': 'en-GB,en;q=0.8' })).json(), { type: '/errors/screen-busy', title: 'The target screen has a job in progress', status: 409 });
  assert.deepEqual(await (await call('/busy')).json(), { type: '/errors/screen-busy', title: '目标屏有进行中的作业', status: 409 });
  assert.deepEqual(await (await call('/export', { 'X-Quilt-Locale': 'en' })).json(), { type: '/errors/not-found', title: 'Not found', status: 404, detail: 'The export file was cleaned up (older than 24 hours); export again' });
  assert.equal((await (await call('/export')).json() as { detail: string }).detail, '导出文件已清理（超过 24 小时），重新导出一次');

  const bad = { kind: 'openai', label: 'x', model: 'm' };
  const en = await (await call('/channels', { 'X-Quilt-Locale': 'en' }, bad)).json() as { title: string; errors: { path: string; message: string }[] };
  assert.equal(en.title, 'Invalid request parameters');
  assert.deepEqual(en.errors.find((e) => e.path === 'endpoint'), { path: 'endpoint', message: 'OpenAI-compatible channels need an endpoint' });
  assert.ok(en.errors.every((e) => !CJK.test(e.message)), JSON.stringify(en.errors));
  const zh = await (await call('/channels', {}, bad)).json() as { errors: { path: string; message: string }[] };
  assert.deepEqual(zh.errors.find((e) => e.path === 'endpoint'), { path: 'endpoint', message: 'OpenAI 兼容通道必须填端点' });
});

test('ISSUE_EN：core schema 里每一条中文自定义 message 都登记了英文', () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  const results = [
    createMessageSchema.safeParse({ content: '' }),
    createMessageSchema.safeParse({ content: 'x', variantOf: uuid }),
    copyDraftSchema.safeParse({ projectId: uuid, as: 'overwrite', restyle: true }),
    fontFamilySchema.safeParse('!!'),
    fontUrlSchema.safeParse('http://example.com/a.css'),
    componentNameSchema.safeParse('<nav>'),
    updateComponentSchema.safeParse({ name: 'Nav' }),
    createChannelSchema.safeParse({ kind: 'openai', label: 'x', model: 'm' }),
    createChannelSchema.safeParse({ kind: 'openai', label: 'x', model: 'm', endpoint: 'https://example.com/v1' }),
  ];
  const messages = new Set(results.flatMap((r) => (r.success ? [] : r.error.issues.map((i) => i.message))).filter((m) => CJK.test(m)));
  for (const m of messages) assert.ok(ISSUE_EN[m] && !CJK.test(ISSUE_EN[m]), `没登记英文：${m}`);
  // 反过来：登记的每一条都真有 schema 会报（schema 改了措辞时这里提醒把旧键换掉）
  assert.deepEqual([...messages].sort(), Object.keys(ISSUE_EN).sort());
});

test('outsideRequest：worker 当作不在请求里——进程内队列在英文请求里同步起跑，原始原因照样中文；出来后回到请求的语言', async () => {
  const a = new Hono<Env>();
  a.use('*', localeMiddleware);
  a.get('/', async (c) => {
    const job = await outsideRequest(async () => { await new Promise((r) => setTimeout(r, 1)); return { locale: requestLocale(), ui: requestUiLocale(), text: tr('已取消', 'Cancelled') }; });
    return c.json({ request: requestLocale(), job, after: tr('已取消', 'Cancelled') });
  });
  assert.deepEqual(await (await a.request('/', { headers: { 'X-Quilt-Locale': 'en' } })).json(), { request: 'en', job: { locale: 'zh', ui: null, text: '已取消' }, after: 'Cancelled' });
  assert.equal(tr('已取消', 'Cancelled', 'en'), 'Cancelled');
});

test('列表与计数：中文顿号、英文逗号；英文单复数', () => {
  assert.equal(listJoin(['首页', '设置'], 'zh'), '首页、设置');
  assert.equal(listJoin(['Home', 'Settings'], 'en'), 'Home, Settings');
  assert.equal(countEn(1, 'screen'), '1 screen');
  assert.equal(countEn(3, 'screen'), '3 screens');
});

test('本机 agent 的安装提示与不可用原因按请求的语言，命令原样保留', async () => {
  const a = new Hono<Env>();
  a.use('*', localeMiddleware);
  a.get('/', (c) => c.json({ claude: setupHint('claude-code'), codex: setupHint('codex'), unknown: toolAvailable('cursor').hint }));
  const zh = await (await a.request('/')).json() as Record<string, string>;
  assert.ok(CJK.test(zh.claude) && CJK.test(zh.codex), JSON.stringify(zh));
  assert.ok(zh.codex.includes('codex mcp add quilt --url'));
  assert.equal(zh.unknown, '本机 agent 只支持 Claude Code 与 Codex（cursor 尚未接入）');
  const en = await (await a.request('/', { headers: { 'X-Quilt-Locale': 'en' } })).json() as Record<string, string>;
  assert.ok(!CJK.test(en.claude) && !CJK.test(en.codex), JSON.stringify(en));
  assert.ok(en.codex.includes('codex mcp add quilt --url') && en.claude.includes('npm i -g @anthropic-ai/claude-code'));
  assert.equal(en.unknown, 'Local agents only support Claude Code and Codex (cursor is not supported yet)');
});
