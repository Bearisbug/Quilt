import { Hono } from 'hono';
import { updateRecordingSchema, recordEventsBatchSchema, recordEventBytes, RECORD_EVENT_MAX_BYTES, L } from '@quilt/core';
import { parseBody, requireUser, type Env } from '../app.ts';
import { problems } from '../../lib/errors.ts';
import { recordingStatus, setRecording, recordEvents, recordingSwitch } from '../../services/record.ts';

// 本机使用记录（REQ-CORE-047 / ADR-035）：开关、状态与浏览器的事件批。来源校验同全部 /v1/*（app.ts）
export const recordRoutes = new Hono<Env>();

// API-CORE-049
recordRoutes.get('/v1/record', async (c) => {
  c.header('Cache-Control', 'no-store');
  // brief=1：浏览器每 60 s 重取开关用，只回 { enabled, since }，不数条数、不走 records/ 统计占用
  if (c.req.query('brief') === '1') return c.json(await recordingSwitch(requireUser(c).id));
  return c.json(await recordingStatus(requireUser(c).id));
});

// API-CORE-050
recordRoutes.patch('/v1/record', async (c) => {
  const user = requireUser(c);
  const { enabled } = await parseBody(c, updateRecordingSchema);
  c.header('Cache-Control', 'no-store');
  return c.json(await setRecording(user.id, enabled, `record:${crypto.randomUUID()}`));
});

// API-CORE-051：1–200 条、单条序列化后 ≤ 16 KB，否则整批不写；开关关着整批丢弃，照样 204
recordRoutes.post('/v1/record/events', async (c) => {
  const user = requireUser(c);
  const batch = await parseBody(c, recordEventsBatchSchema);
  const big = batch.events.findIndex((e) => recordEventBytes(e) > RECORD_EVENT_MAX_BYTES);
  if (big >= 0) throw problems.validation([{ path: `events.${big}`, message: L(`单条事件序列化后不能超过 ${RECORD_EVENT_MAX_BYTES / 1024} KB`, `An event must be at most ${RECORD_EVENT_MAX_BYTES / 1024} KB when serialized`) }]);
  await recordEvents(user.id, batch.sessionId, batch.events);
  return c.body(null, 204);
});
