import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordSafe, recordEventBytes, recordEventsBatchSchema, RECORD_EVENT_MAX_BYTES, RECORD_STRING_MAX } from '@quilt/core';

// 本机使用记录（REQ-CORE-047 / ADR-035）的纯函数：字符串截断与去签名、单条大小、批大小与类型校验、记录的对象键与归档项判定、
// fs 对象存储的递归列举与拷贝。config 在模块加载时读 QUILT_DATA_DIR，先指到临时目录再动态 import，不碰仓库的 .data
let dataDir: string;
let store: typeof import('../../../apps/api/src/lib/storage.ts');
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'quilt-record-'));
  process.env.QUILT_DATA_DIR = dataDir;
  store = await import('../../../apps/api/src/lib/storage.ts');
});
after(() => rm(dataDir, { recursive: true, force: true }));

test('recordSafe：超过 2000 字的字符串换成长度，正好 2000 字的留原文，嵌套对象与数组逐层处理', () => {
  const long = 'x'.repeat(RECORD_STRING_MAX + 500);
  const exact = 'y'.repeat(RECORD_STRING_MAX);
  assert.deepEqual(recordSafe({ html: long, name: 'Home', n: 3, ok: true, none: null, list: [long, 'a'], deep: { text: exact } }),
    { html: 2500, name: 'Home', n: 3, ok: true, none: null, list: [2500, 'a'], deep: { text: exact } });
  assert.equal(recordSafe(long), 2500);
  // max 换成 Infinity 就只去签名、不截断（归档清单用）
  assert.equal(recordSafe(long, Infinity), long);
});

test('recordSafe：签名地址去掉签名参数值，地址其余部分留着；\\u0000 去掉', () => {
  assert.equal(recordSafe('http://localhost:3100/v1/objects/projects%2Fp%2Fa.png?exp=1760000000&sig=AbC-123_x'), 'http://localhost:3100/v1/objects/projects%2Fp%2Fa.png?exp=-&sig=-');
  assert.equal(recordSafe('http://127.0.0.1:3101/p/pid/sid?rev=r1&t=tok.en&lang=zh'), 'http://127.0.0.1:3101/p/pid/sid?rev=r1&t=-&lang=zh');
  assert.equal(recordSafe('https://b.s3.amazonaws.com/k?X-Amz-Credential=AK%2F1&X-Amz-Signature=deadbeef'), 'https://b.s3.amazonaws.com/k?X-Amz-Credential=-&X-Amz-Signature=-');
  assert.deepEqual(recordSafe({ events: [{ screenshotUrl: '/v1/attachments/p/a?exp=1&sig=zz&mt=image%2Fpng' }] }), { events: [{ screenshotUrl: '/v1/attachments/p/a?exp=-&sig=-&mt=image%2Fpng' }] });
  assert.equal(recordSafe('a\u0000b'), 'ab');
  // 不是签名参数的不动
  assert.equal(recordSafe('https://example.com/?q=1&sign=keep'), 'https://example.com/?q=1&sign=keep');
});

test('recordEventBytes：按 UTF-8 字节计，中文一个字 3 字节', () => {
  assert.equal(recordEventBytes({ a: 'x' }), 9);
  assert.equal(recordEventBytes({ a: '字' }), 11);
  const big = { seq: 1, at: '2026-10-21T00:00:00.000Z', page: 'canvas', type: 'input', data: { text: '字'.repeat(6000) } };
  assert.ok(recordEventBytes(big) > RECORD_EVENT_MAX_BYTES);
});

test('recordEventsBatchSchema：1–200 条；type 不在枚举里、缺 sessionId 都不过', () => {
  const ev = (seq: number, type = 'click') => ({ seq, at: '2026-10-21T08:00:00.000Z', page: 'canvas', type });
  const ok = (events: unknown[]) => recordEventsBatchSchema.safeParse({ sessionId: 's1', events }).success;
  assert.ok(ok([ev(1)]));
  assert.ok(ok(Array.from({ length: 200 }, (_, i) => ev(i + 1))));
  assert.ok(!ok([]));
  assert.ok(!ok(Array.from({ length: 201 }, (_, i) => ev(i + 1))));
  assert.ok(!ok([ev(1, 'hover')]));
  assert.ok(!ok([ev(0)]), 'seq 从 1 起');
  assert.ok(!recordEventsBatchSchema.safeParse({ events: [ev(1)] }).success);
});

test('recordKeys：模型调用正文与归档按本机日期分目录；归档项只认清单与移进来的参考图', () => {
  const at = new Date(2026, 9, 21, 23, 59);
  assert.equal(store.recordDay(at), '2026-10-21');
  assert.equal(store.recordDay(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(store.recordKeys.modelCall(at, 'c1'), 'records/model-calls/2026-10-21/c1.json');
  assert.equal(store.recordKeys.archive(at, 'screen-s1'), 'records/archive/2026-10-21/screen-s1');
  assert.equal(store.recordKeys.archivedAttachment(at, 'projects/p1/attachments/a1.png'), 'records/archive/2026-10-21/attachments/a1.png');
  const entry = store.recordKeys.isArchiveEntry;
  assert.ok(entry('records/archive/2026-10-21/screen-s1/manifest.json'));
  assert.ok(entry('records/archive/2026-10-21/project-p1/manifest.json'));
  assert.ok(entry('records/archive/2026-10-21/attachments/a1.png'));
  assert.ok(!entry('records/archive/2026-10-21/screen-s1/screens/s1/r1.html'));
  assert.ok(!entry('records/archive/2026-10-21/project-p1/screens/s1/manifest.json'));
  assert.ok(!entry('records/model-calls/2026-10-21/c1.json'));
});

test('fs 对象存储：listDeep 递归列出键与字节数，copy 建好目录再拷，localPath 是数据目录下的绝对路径', async () => {
  const { storage } = store;
  await storage.put('projects/p1/screens/s1/r1.html', '<p>hi</p>', 'text/html');
  await storage.put('projects/p1/screens/s1/r1.png', Buffer.alloc(10), 'image/png');
  await storage.put('projects/p1/attachments/a1.png', Buffer.alloc(3), 'image/png');
  const listed = (await storage.listDeep('projects/p1/')).sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(listed, [
    { key: 'projects/p1/attachments/a1.png', bytes: 3 },
    { key: 'projects/p1/screens/s1/r1.html', bytes: 9 },
    { key: 'projects/p1/screens/s1/r1.png', bytes: 10 },
  ]);
  assert.deepEqual(await storage.listDeep('records/'), [], '前缀不存在时是空表');
  await storage.copy('projects/p1/screens/s1/r1.html', 'records/archive/2026-10-21/screen-s1/screens/s1/r1.html');
  assert.equal((await storage.get('records/archive/2026-10-21/screen-s1/screens/s1/r1.html')).toString(), '<p>hi</p>');
  assert.equal(storage.localPath('records'), path.join(dataDir, 'objects', 'records'));
  assert.equal(await readFile(path.join(dataDir, 'objects', 'records/archive/2026-10-21/screen-s1/screens/s1/r1.html'), 'utf8'), '<p>hi</p>');
});
