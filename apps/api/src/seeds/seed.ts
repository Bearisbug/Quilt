import { rm } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { createProject } from '../services/projects.ts';
import { createChannel } from '../services/channels.ts';
import { OWNER, userByEmail, done, flag } from './_lib.ts';

// pnpm seed [--empty]：重置测试基线（TEST.md §3）——清掉默认用户名下的全部项目（级联删除屏 / 修订 / 作业 / 台账 / 通道），
// 用户行本身保留（API 进程按 email 解析它），对象目录只删这些项目的子目录。--empty 不建示例项目（PAGE-FIRST 用例）。
// v0.34 起没有「系统预置」通道：.env 里有 GEMINI_API_KEY 就顺手建一条已验证的 Gemini 通道，真实生成的用例才有云端通道可用。
const owner = await userByEmail(OWNER);
const projects = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, owner.id));
for (const p of projects) await rm(path.join(config.dataDir, 'objects', 'projects', p.id), { recursive: true, force: true });
await db.delete(schema.projects).where(eq(schema.projects.ownerId, owner.id));
await db.delete(schema.channels).where(eq(schema.channels.userId, owner.id));
await db.delete(schema.usageEntries).where(eq(schema.usageEntries.userId, owner.id));
let channelNote = '';
if (config.geminiApiKey) {
  const model = config.llmDriver === 'gemini' && config.model ? config.model : 'gemini-3.7-flash';
  const ch = await createChannel(owner.id, { kind: 'gemini', label: `Gemini ${model.replace(/^gemini-/, '')}`, model, apiKey: config.geminiApiKey });
  await db.update(schema.channels).set({ status: 'verified', lastProbeAt: new Date() }).where(eq(schema.channels.id, ch.id));
  channelNote = `; channel ${ch.label}`;
}
if (!flag('empty')) {
  await createProject(owner.id, { name: 'Demo Mobile', deviceType: 'mobile', seedColor: '#3B5BDB' });
  await createProject(owner.id, { name: 'Demo Desktop', deviceType: 'desktop', seedColor: '#3B5BDB' });
}
await done(`seeded: ${OWNER} (${flag('empty') ? 'no projects' : 'Demo Mobile / Demo Desktop'}${channelNote}); ${projects.length} old projects removed`);
