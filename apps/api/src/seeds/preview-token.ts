import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { signPreview } from '../lib/signing.ts';
import { arg, flag, done } from './_lib.ts';

// pnpm seed:preview-token --screen <id> [--expired]：打印预览 URL（可构造已过期签名）
const screenId = arg('screen');
const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
if (!screen?.currentRevisionId) { console.error('screen not found or has no revision'); process.exit(2); }
const exp = Math.floor(Date.now() / 1000) + (flag('expired') ? -600 : config.previewTokenMinutes * 60);
await done(`${config.previewOrigin}/p/${screen.projectId}/${screen.id}?rev=${screen.currentRevisionId}&t=${signPreview(screen.projectId, exp)}`);
