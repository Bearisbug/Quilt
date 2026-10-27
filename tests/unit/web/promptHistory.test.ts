import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageDto } from '@quilt/core';
import { promptHistory } from '../../../apps/web/src/composer/history.ts';

const msg = (role: 'user' | 'assistant', content: string, ids: string[] = []) =>
  ({ id: crypto.randomUUID(), role, content, attachments: ids.map((id) => ({ id, mediaType: 'image/png', bytes: 1, url: `/o/${id}` })) }) as unknown as MessageDto;

// 消息接口按旧的在前给（GET /v1/projects/:id/messages）
test('promptHistory：只取用户发的有字的话，排成最近的在前，带上参考图', () => {
  const got = promptHistory([msg('user', '  '), msg('user', '加一个搜索框', ['a1', 'a2']), msg('assistant', '已改'), msg('user', '改成深色')]);
  assert.deepEqual(got, [
    { text: '改成深色', images: [] },
    { text: '加一个搜索框', images: [{ id: 'a1', url: '/o/a1' }, { id: 'a2', url: '/o/a2' }] },
  ]);
});

test('promptHistory：紧挨着的同一句同一组图只留一条，隔开的或图不同的都留', () => {
  const got = promptHistory([msg('user', 'A'), msg('user', 'B'), msg('user', 'A', ['x']), msg('user', 'A'), msg('assistant', ''), msg('user', 'A')]);
  assert.deepEqual(got.map((e) => `${e.text}${e.images.length}`), ['A0', 'A1', 'B0', 'A0']);
});
