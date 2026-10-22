import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePresence, leavePresence, presenceSnapshot, subscribePresence, sweepPresence, PRESENCE_TTL_MS } from '../../../apps/api/src/lib/presence.ts';
import type { PresenceEventDto } from '@quilt/core';

// 协作显示的在线状态（v1.32 API-CORE-053）：按项目分、只推给同一项目的订阅者；离开或 15 s 没消息即推 presence_left
const P = '11111111-1111-4111-8111-111111111111'; const Q = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: '乙', color: 2 };

test('更新推给同一项目的订阅者，别的项目收不到；快照是每个标签页的最新状态', () => {
  const got: PresenceEventDto[] = []; const other: PresenceEventDto[] = [];
  const off = subscribePresence(P, (e) => got.push(e)); const off2 = subscribePresence(Q, (e) => other.push(e));
  updatePresence(P, A, person, { cursor: { x: 1, y: 2 } });
  updatePresence(P, A, person, { cursor: { x: 3, y: 4 } });
  updatePresence(P, B, person, { selected: [Q] });
  assert.equal(got.length, 3); assert.equal(other.length, 0);
  const snap = presenceSnapshot(P);
  assert.deepEqual(snap.map((e) => e.type === 'presence' && [e.data.clientId, e.data.state]), [[A, { cursor: { x: 3, y: 4 } }], [B, { selected: [Q] }]]);
  leavePresence(P, A);
  assert.deepEqual(got.at(-1), { type: 'presence_left', data: { clientId: A } });
  leavePresence(P, A);
  assert.equal(got.length, 4, '已经离开的再离开一次不再推');
  leavePresence(P, B);
  assert.deepEqual(presenceSnapshot(P), []);
  off(); off2();
});

test('15 s 没消息即离开：过期的推 presence_left，没过期的留着', () => {
  const got: PresenceEventDto[] = [];
  const off = subscribePresence(P, (e) => got.push(e));
  const t0 = 1_000_000;
  updatePresence(P, A, person, {}, t0);
  updatePresence(P, B, person, {}, t0 + 10_000);
  sweepPresence(t0 + PRESENCE_TTL_MS + 1);
  assert.deepEqual(got.filter((e) => e.type === 'presence_left').map((e) => e.data.clientId), [A]);
  assert.deepEqual(presenceSnapshot(P).map((e) => e.type === 'presence' && e.data.clientId), [B]);
  leavePresence(P, B); off();
});
