import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuid } from '../../../apps/web/src/lib/uuid.ts';

// 前端的 id 不依赖 crypto.randomUUID（只在安全上下文里有，§15「局域网访问」v1.30）：getRandomValues 拼出的 v4 UUID
test('uuid：v4 格式（版本位 4、变体位 8–b），1000 个不重复', () => {
  const all = Array.from({ length: 1000 }, uuid);
  assert.ok(all.every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)), `格式不对：${all.find((u) => !/^[0-9a-f-]{36}$/.test(u))}`);
  assert.equal(new Set(all).size, 1000);
});
