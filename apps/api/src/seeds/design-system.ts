import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { arg, flag, done } from './_lib.ts';

// pnpm seed:design-system --project <id> --bump：把设计系统 version 抬升 1（制造版本冲突）
const projectId = arg('project');
if (!flag('bump')) { console.error('only --bump is supported'); process.exit(2); }
const [ds] = await db.update(schema.designSystems).set({ version: sql`${schema.designSystems.version} + 1`, updatedAt: new Date() }).where(eq(schema.designSystems.projectId, projectId)).returning({ version: schema.designSystems.version });
if (!ds) { console.error('project not found'); process.exit(2); }
await done({ projectId, version: ds.version });
