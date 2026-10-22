import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

// 请求日志（§21 v1.29）：慢请求与 5xx 逐条写、只写路由模板；5 分钟汇总带 4xx / 5xx 与 p50 / p95。reqlog 加载时读 config，先把数据目录指到临时目录
let dir: string;
let log: typeof import('../../../apps/api/src/lib/reqlog.ts');
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'quilt-reqlog-'));
  process.env.QUILT_DATA_DIR = dir;
  log = await import('../../../apps/api/src/lib/reqlog.ts');
});
after(() => rm(dir, { recursive: true, force: true }));

test('慢请求与 5xx 逐条写，只写路由模板不写地址与查询串；快的 2xx / 4xx 只进汇总', async () => {
  const app = new Hono();
  app.use('*', log.requestLog('preview'));
  app.get('/p/:projectId/:screenId', async (c) => { if (c.req.query('slow')) await new Promise((r) => setTimeout(r, 230)); return c.text('ok'); });
  app.get('/boom', () => { throw new Error('x'); });
  app.onError((_e, c) => c.text('err', 500));
  await app.request('/p/proj-1/screen-1?t=secret-token');
  await app.request('/p/proj-1/screen-2?t=secret-token&slow=1');
  await app.request('/boom');
  await app.request('/nope');
  log.flushRequestStats();
  await log.requestLogFlushed();
  const text = await readFile(log.requestLogFile(), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3, text);
  assert.match(lines[0], /\[req\] preview GET \/p\/:projectId\/:screenId 200 2\d\d -$/);
  assert.match(lines[1], /\[req\] preview GET \/boom 500 \d+ -$/);
  assert.match(lines[2], /\[req\] 5m preview n=4 4xx=1 5xx=1 p50=\d+ p95=2\d\d$/);
  assert.ok(!text.includes('secret-token') && !text.includes('proj-1'), '日志里不该有实际地址与签名');
});

test('汇总之后清零：下一窗没有请求就不写', async () => {
  const before = (await readFile(log.requestLogFile(), 'utf8')).length;
  log.flushRequestStats();
  await log.requestLogFlushed();
  assert.equal((await readFile(log.requestLogFile(), 'utf8')).length, before);
});
