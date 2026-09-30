import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { arg, done } from './_lib.ts';

// pnpm seed:job --project <id> [--screen <id>] [--status running|queued] [--kind edit_screens] [--runner model|agent] [--tokens N] [--screens N] [--input '<json>']
// 构造进行中的作业（不入队，worker 不会处理），用于占用屏幕 / 取消记账 / 在途预估 / 台账展示用例。
// --runner agent：一个没投递出去、停在 queued 的本机 agent 作业（进程重启收口用例 TC-CORE-068），会话写在 --input 的 runner 里
const projectId = arg('project');
const screenId = process.argv.includes('--screen') ? arg('screen') : null;
const status = arg('status', 'running');
const kind = arg('kind', screenId ? 'edit_screens' : 'generate');
const runner = arg('runner', 'model');
const tokens = Number(arg('tokens', '0'));
const screens = Number(arg('screens', '0'));
const inputOverride = process.argv.includes('--input') ? (JSON.parse(arg('input')) as Record<string, unknown>) : null;
const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
if (!project) { console.error('project not found'); process.exit(2); }
const [job] = await db.insert(schema.generationJobs).values({
  projectId, createdBy: project.ownerId, kind, status, runner, targetScreenId: screenId,
  input: inputOverride ?? (screenId ? { prompt: 'seeded', screenIds: [screenId], versions: 1 } : { prompt: 'seeded', count: 1, versions: 1 }),
  output: tokens ? { seededTokens: tokens } : null, startedAt: status === 'running' ? new Date() : null,
}).returning();
if (tokens || screens) {
  // 取消时台账应记已消耗 token：由 worker 记账；种子作业无 worker，这里预写一条与作业绑定的台账（记在 stub 驱动名下，设置弹层按驱动分列能看到）
  await db.insert(schema.usageEntries).values({ userId: project.ownerId, jobId: job.id, tokensIn: Math.floor(tokens / 2), tokensOut: Math.ceil(tokens / 2), screens, driver: 'stub', model: 'seeded' });
}
await done({ jobId: job.id, status: job.status, targetScreenId: screenId });
