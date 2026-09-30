import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageDto } from '@quilt/core';
import { mergeMessages } from '../../../apps/web/src/lib/messages.ts';

const m = (id: string, content = id) => ({ id, content }) as unknown as MessageDto;

test('mergeMessages：晚到的旧快照不抹掉本页刚追加的一轮', () => {
  assert.deepEqual(mergeMessages([m('a'), m('b')], [m('u1'), m('r1')]).map((x) => x.id), ['a', 'b', 'u1', 'r1']);
});

test('mergeMessages：快照里已有的以快照为准，不重复', () => {
  const merged = mergeMessages([m('a'), m('u1', '服务端版本'), m('r1', '已更新 1 屏')], [m('u1', '本地版本'), m('r1', '')]);
  assert.deepEqual(merged.map((x) => x.id), ['a', 'u1', 'r1']);
  assert.equal(merged[2].content, '已更新 1 屏');
});

test('mergeMessages：没有本地追加时就是快照本身', () => {
  assert.deepEqual(mergeMessages([m('a')], []).map((x) => x.id), ['a']);
  assert.deepEqual(mergeMessages([], [m('u1')]).map((x) => x.id), ['u1']);
});
