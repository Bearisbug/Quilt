import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

// 协作通道（v1.32 REQ-CORE-048，API-CORE-053）：请求带界面语言、后台标签页离开、事件流重连的宽限；跟随链与跟随连成一圈时谁停下
const win = new Window({ url: 'http://localhost:6688/p/x' });
Object.assign(globalThis, { window: win, document: win.document, localStorage: win.localStorage });
const sent: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  sent.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
  return new Response(null, { status: 204 });
}) as typeof fetch;
const { Presence, followLeader, shouldYield } = await import('@/lib/collab');

const ME = { id: '11111111-1111-4111-8111-111111111111', name: '甲', color: 1 };
const peer = (clientId: string, name: string) => ({ type: 'presence' as const, data: { clientId, person: { id: `${clientId.slice(0, 8)}-2222-4222-8222-222222222222`, name, color: 2 }, state: {}, at: new Date().toISOString() } });
const setHidden = (hidden: boolean) => {
  Object.defineProperty(win.document, 'hidden', { value: hidden, configurable: true });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
};

test('上报带 X-Quilt-Locale；转到后台发 left、不再发，回到前台补发当前状态', () => {
  sent.length = 0;
  const p = new Presence('p1', () => ME);
  p.touch();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].headers['X-Quilt-Locale'], '上报应带界面语言');
  setHidden(true);
  assert.deepEqual(sent.at(-1)!.body, { clientId: p.clientId, left: true });
  assert.ok(sent.at(-1)!.headers['X-Quilt-Locale'], 'left 也应带界面语言');
  const n = sent.length;
  p.touch();
  assert.equal(sent.length, n, '后台时不发');
  setHidden(false);
  assert.equal(sent.length, n + 1);
  assert.equal((sent.at(-1)!.body as { clientId: string }).clientId, p.clientId);
  assert.ok('person' in sent.at(-1)!.body, '回到前台发的是当前状态');
  p.dispose();
});

test('事件流重连：2 s 内重新出现的人留着，没出现的才删', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = new Presence('p1', () => ME);
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    p.handle(peer(a, '乙')); p.handle(peer(b, '丙'));
    let left = 0;
    p.onPeer((x) => { if (!x) left++; });
    p.reset();
    assert.equal(p.getPeers().length, 2, '重连当下不清空');
    p.handle(peer(a, '乙'));
    mock.timers.tick(1999);
    assert.equal(p.getPeers().length, 2);
    mock.timers.tick(1);
    assert.deepEqual(p.getPeers().map((x) => x.person.name), ['乙'], '没重新出现的丙删掉');
    assert.equal(left, 1, '删人时发一次离开通知');
    p.dispose();
  } finally { mock.timers.reset(); }
});

// 人：A 是自己；following 写成 [跟谁, 开始时刻]
const ID = { A: 'aaaaaaaa-0000-4000-8000-000000000000', B: 'bbbbbbbb-0000-4000-8000-000000000000', C: 'cccccccc-0000-4000-8000-000000000000' };
type Who = keyof typeof ID;
const people = (spec: Partial<Record<Who, [Who, number] | null>>) => (Object.keys(spec) as Who[]).map((k) => {
  const f = spec[k];
  return { clientId: `${k}-tab`, person: { id: ID[k], name: k, color: 1 }, state: f ? { following: { id: ID[f[0]], since: f[1] } } : {}, at: 0 };
});

test('跟随链：顺着 following 走到不再跟随别人的人；下一个人不在线就停在当前这个', () => {
  assert.equal(followLeader(people({ B: ['C', 1], C: null }), ID.A, ID.B).leader?.person.name, 'C');
  assert.equal(followLeader(people({ B: ['C', 1] }), ID.A, ID.B).leader?.person.name, 'B', '丙不在线：停在乙');
  assert.equal(followLeader(people({ B: null }), ID.A, ID.B).loop, false);
  assert.equal(followLeader(people({}), ID.A, ID.B).leader, null, '乙不在线');
});

test('跟随连成一圈：圈里最后开始跟随的人留下，跟随他的人停下；圈解开前 followLeader 报 loop', () => {
  // 两人：甲 2000 跟乙，乙 1000 跟甲——甲是最后开始的，乙停下
  const two = people({ B: ['A', 1000] });
  assert.equal(followLeader(two, ID.A, ID.B).loop, true);
  assert.equal(shouldYield(two, ID.A, { id: ID.B, since: 2000 }), false, '甲最后开始，甲留下');
  assert.equal(shouldYield(people({ A: ['B', 2000] }), ID.B, { id: ID.A, since: 1000 }), true, '乙跟着最后开始的甲，乙停下');
  // 三人：甲 3000 跟乙，乙 1000 跟丙，丙 2000 跟甲——丙停下，甲乙照旧
  assert.equal(shouldYield(people({ B: ['C', 1000], C: ['A', 2000] }), ID.A, { id: ID.B, since: 3000 }), false);
  assert.equal(shouldYield(people({ A: ['B', 3000], C: ['A', 2000] }), ID.B, { id: ID.C, since: 1000 }), false);
  assert.equal(shouldYield(people({ A: ['B', 3000], B: ['C', 1000] }), ID.C, { id: ID.A, since: 2000 }), true);
  // 同时点（时刻相同）：person.id 大的留下（乙），甲停下；乙那边算出同样的结论
  assert.equal(shouldYield(people({ B: ['A', 5000] }), ID.A, { id: ID.B, since: 5000 }), true);
  assert.equal(shouldYield(people({ A: ['B', 5000] }), ID.B, { id: ID.A, since: 5000 }), false);
  // 不含自己的圈（乙丙互相跟随）：自己不让，跟随链报 loop、等他们自己解开
  const others = people({ B: ['C', 1], C: ['B', 2] });
  assert.equal(shouldYield(others, ID.A, { id: ID.B, since: 3 }), false);
  assert.equal(followLeader(others, ID.A, ID.B).loop, true);
});
