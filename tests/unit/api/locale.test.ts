import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { L } from '@quilt/core';
import { localeMiddleware, requestLocale, requestUiLocale } from '../../../apps/api/src/lib/locale.ts';
import { Problem, problems, problemResponse, localizeDeep } from '../../../apps/api/src/lib/errors.ts';
import type { Env } from '../../../apps/api/src/http/app.ts';

// 界面语言（REQ-CORE-046）：中间件按 X-Quilt-Locale / Accept-Language 定语言，problem 的出口按它取文案
function app() {
  const a = new Hono<Env>();
  a.use('*', localeMiddleware);
  a.onError((err, c) => problemResponse(c, err as Problem));
  // 服务层拿不到 c：经 requestLocale() / requestUiLocale() 读，await 之后也还在
  a.get('/who', async (c) => { await new Promise((r) => setTimeout(r, 5)); return c.json({ locale: c.get('locale'), ui: c.get('uiLocale'), service: requestLocale(), serviceUi: requestUiLocale() }); });
  a.get('/missing', () => { throw problems.notFound(); });
  a.get('/invalid', () => { throw problems.validation([{ path: 'runner', message: L('会话已关闭或不存在，重新选一个', 'The session is closed or gone; pick another') }, { path: 'variantName', message: 'variantOf 与 variantName 要一起给' }, { path: 'x', message: 'Invalid input' }]); });
  return a;
}
const get = (path: string, headers: Record<string, string> = {}) => app().request(path, { headers });

test('中间件：X-Quilt-Locale 优先，记成 uiLocale；路由与服务层读到同一个值', async () => {
  const r = await (await get('/who', { 'X-Quilt-Locale': 'en', 'Accept-Language': 'zh-CN' })).json();
  assert.deepEqual(r, { locale: 'en', ui: 'en', service: 'en', serviceUi: 'en' });
});

test('中间件：没有 X-Quilt-Locale 时按 Accept-Language，uiLocale 为 null（不往作业里记语言）', async () => {
  assert.deepEqual(await (await get('/who', { 'Accept-Language': 'en-US,en;q=0.9' })).json(), { locale: 'en', ui: null, service: 'en', serviceUi: null });
  assert.deepEqual(await (await get('/who', { 'Accept-Language': '*' })).json(), { locale: 'zh', ui: null, service: 'zh', serviceUi: null });
  assert.deepEqual(await (await get('/who')).json(), { locale: 'zh', ui: null, service: 'zh', serviceUi: null });
});

test('请求之外（worker、启动任务）requestLocale() 是中文', () => {
  assert.equal(requestLocale(), 'zh');
  assert.equal(requestUiLocale(), null);
});

test('problem 出口：title 按界面语言，type 不变；不带语言头仍是原来的中文', async () => {
  const en = await get('/missing', { 'X-Quilt-Locale': 'en' });
  assert.equal(en.status, 404);
  assert.equal(en.headers.get('content-type'), 'application/problem+json');
  assert.deepEqual(await en.json(), { type: '/errors/not-found', title: 'Not found', status: 404 });
  assert.deepEqual(await (await get('/missing')).json(), { type: '/errors/not-found', title: '资源不存在', status: 404 });
});

test('problem 出口：errors[].message 写成 L() 的按语言取；zod 的中文 message 经 ISSUE_EN 反查；没登记的原样', async () => {
  const en = await (await get('/invalid', { 'X-Quilt-Locale': 'en' })).json() as { title: string; errors: { path: string; message: string }[] };
  assert.equal(en.title, 'Invalid request parameters');
  assert.deepEqual(en.errors.map((e) => e.message), ['The session is closed or gone; pick another', 'variantOf and variantName must be given together', 'Invalid input']);
  const zh = await (await get('/invalid', { 'X-Quilt-Locale': 'zh' })).json() as { title: string; errors: { message: string }[] };
  assert.equal(zh.title, '请求参数不合法');
  assert.deepEqual(zh.errors.map((e) => e.message), ['会话已关闭或不存在，重新选一个', 'variantOf 与 variantName 要一起给', 'Invalid input']);
});

test('Problem.title 恒为中文（日志与旧调用方），body() 展开 extra 里任意一层的 L()', () => {
  const p = new Problem(404, '/errors/not-found', L('资源不存在', 'Not found'), { detail: L('导出文件已清理', 'The export file was cleaned up'), component: '顶栏' });
  assert.equal(p.title, '资源不存在');
  assert.equal(p.message, '资源不存在');
  assert.deepEqual(p.body('en'), { type: '/errors/not-found', title: 'Not found', status: 404, detail: 'The export file was cleaned up', component: '顶栏' });
  assert.deepEqual(localizeDeep({ a: [{ b: L('甲', 'A') }] }, 'en'), { a: [{ b: 'A' }] });
});
