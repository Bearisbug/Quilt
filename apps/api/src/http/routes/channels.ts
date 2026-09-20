import { Hono } from 'hono';
import { createChannelSchema, updateChannelSchema } from '@quilt/core';
import { parseBody, requireUser, type Env } from '../app.ts';
import { channelDto, createChannel, deleteChannel, listChannels, probeRunner, runnerCatalog, updateChannel } from '../../services/channels.ts';

// 生成通道可配置（REQ-CORE-013）：API-CORE-020~023。密钥只进不出——所有响应经 channelDto，不含明文。
export const channelRoutes = new Hono<Env>();

channelRoutes.get('/v1/runners', async (c) => { c.header('Cache-Control', 'no-store'); return c.json(await runnerCatalog(requireUser(c))); });
channelRoutes.post('/v1/runners/:runnerId/probe', async (c) => c.json(await probeRunner(requireUser(c), decodeURIComponent(c.req.param('runnerId')))));

channelRoutes.get('/v1/channels', async (c) => { c.header('Cache-Control', 'no-store'); return c.json({ items: (await listChannels(requireUser(c).id)).map(channelDto) }); });
channelRoutes.post('/v1/channels', async (c) => c.json({ channel: channelDto(await createChannel(requireUser(c).id, await parseBody(c, createChannelSchema))) }, 201));
channelRoutes.patch('/v1/channels/:id', async (c) => c.json({ channel: channelDto(await updateChannel(requireUser(c).id, c.req.param('id'), await parseBody(c, updateChannelSchema))) }));
channelRoutes.delete('/v1/channels/:id', async (c) => { await deleteChannel(requireUser(c).id, c.req.param('id')); return c.body(null, 204); });
