import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { storage, recordKeys } from '../lib/storage.ts';
import { recordSafe, type ModelCallPurpose, type RecordEventInput, type RecordingDto } from '@quilt/core';

// 本机使用记录（REQ-CORE-047 / ADR-035）：开关在 users.record_usage，服务端写任何记录前都读它（INV-CORE-007）。
// 模型调用、MCP 事件与归档写不进去时只在服务日志记一行，不挡作业与删除（§15）
const warn = (what: string, e: unknown) => console.warn(`[record] ${what} 没记上：${(e as Error).message}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

export async function isRecording(userId: string): Promise<boolean> {
  const [u] = await db.select({ on: schema.users.recordUsage }).from(schema.users).where(eq(schema.users.id, userId));
  return !!u?.on;
}

async function recordingForProject(projectId: string): Promise<boolean> {
  const [r] = await db.select({ on: schema.users.recordUsage }).from(schema.projects).innerJoin(schema.users, eq(schema.users.id, schema.projects.ownerId)).where(eq(schema.projects.id, projectId));
  return !!r?.on;
}

// API-CORE-049：三个计数是全部已记的，关掉后不清零；占用是 records/ 前缀的合计字节。
// model_calls 不带用户（本地单用户），按全表计
export async function recordingSwitch(userId: string): Promise<Pick<RecordingDto, 'enabled' | 'since'>> {
  const [u] = await db.select({ enabled: schema.users.recordUsage, since: schema.users.recordSince }).from(schema.users).where(eq(schema.users.id, userId));
  return { enabled: !!u?.enabled, since: u?.since?.toISOString() ?? null };
}

export async function recordingStatus(userId: string): Promise<RecordingDto> {
  const [u] = await db.select({ enabled: schema.users.recordUsage, since: schema.users.recordSince }).from(schema.users).where(eq(schema.users.id, userId));
  const [events] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.recordEvents).where(eq(schema.recordEvents.userId, userId));
  const [calls] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.modelCalls);
  const objects = await storage.listDeep(`${recordKeys.root}/`);
  return {
    enabled: !!u?.enabled, since: u?.since?.toISOString() ?? null,
    events: events.n, modelCalls: calls.n, archived: objects.filter((o) => recordKeys.isArchiveEntry(o.key)).length,
    bytes: objects.reduce((n, o) => n + o.bytes, 0), dir: storage.localPath(recordKeys.root),
  };
}

// API-CORE-050：从关到开时 since 置为现在；开与关各写一条 type=record 的事件，同一事务里改开关——
// 事件批按同一行加共享锁读开关，关掉之后提交的批次读到关，关掉的这一条就是最后一条。重复设同一个值什么都不动
export async function setRecording(userId: string, enabled: boolean, requestId: string): Promise<RecordingDto> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ on: schema.users.recordUsage }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
    if (!u || u.on === enabled) return;
    const at = new Date();
    await tx.update(schema.users).set(enabled ? { recordUsage: true, recordSince: at } : { recordUsage: false }).where(eq(schema.users.id, userId));
    await tx.insert(schema.recordEvents).values({ userId, source: 'web', sessionId: requestId, seq: 1, at, type: 'record', data: { enabled } }).onConflictDoNothing();
  });
  return recordingStatus(userId);
}

// API-CORE-051：写入前读开关、与写入同一事务（§16「关掉记录时别的标签页还在发事件」），关着整批丢弃；
// (session_id, seq) 撞了跳过。path 没有单独的列，放进 data
export async function recordEvents(userId: string, sessionId: string, events: RecordEventInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ on: schema.users.recordUsage }).from(schema.users).where(eq(schema.users.id, userId)).for('share');
    if (!u?.on) return;
    await tx.insert(schema.recordEvents).values(events.map((e) => {
      const data = e.data || e.path ? recordSafe({ ...e.data, ...(e.path ? { path: e.path } : {}) }) : null;
      return { userId, source: 'web', sessionId, seq: e.seq, at: new Date(e.at), page: e.page, type: e.type, target: e.target ?? null, projectId: e.projectId ?? null, screenId: e.screenId ?? null, data };
    })).onConflictDoNothing();
  });
}

// API-AGENT-002：一次 MCP 工具调用一条 source=mcp、type=tool 的事件；session_id 是服务端为这次 HTTP 请求生成的 mcp:<uuid>，seq 在请求里从 1 起
export async function recordToolCall(userId: string, call: { sessionId: string; seq: number; at: Date; tool: string; args: unknown; ok: boolean; error: string | null; ms: number }): Promise<void> {
  try {
    if (!(await isRecording(userId))) return;
    const args = recordSafe(call.args ?? {}) as Record<string, unknown>;
    await db.insert(schema.recordEvents).values({
      userId, source: 'mcp', sessionId: call.sessionId, seq: call.seq, at: call.at, type: 'tool', target: call.tool,
      projectId: uuidOrNull(args.projectId), screenId: uuidOrNull(args.screenId),
      data: { tool: call.tool, args, ok: call.ok, ...(call.error ? { error: call.error } : {}), ms: call.ms },
    }).onConflictDoNothing();
  } catch (e) { warn(`MCP ${call.tool}`, e); }
}

export type ModelCallAttempt = { attempt: number; ok: boolean; error?: string; at: string };
export type ModelCallRecord = {
  userId: string; jobId: string; projectId: string; seq: number; purpose: ModelCallPurpose; runner: string; driver: string | null; model: string | null;
  ok: boolean; error: string | null; attempts: ModelCallAttempt[]; tokensIn: number; tokensOut: number; imageKeys: string[];
  system: string | null; prompt: string; response: string | null; startedAt: Date; finishedAt: Date;
};

// ENT-ModelCall：正文 { system, prompt, imageKeys, response, attempts[] } 进 records/model-calls/<日期>/<id>.json，行里只存键；
// 调用方不传通道密钥与端点，正文里也就没有
export async function recordModelCall(c: ModelCallRecord): Promise<void> {
  try {
    if (!(await isRecording(c.userId))) return;
    const id = crypto.randomUUID();
    const bodyKey = recordKeys.modelCall(c.startedAt, id);
    await storage.put(bodyKey, JSON.stringify({ system: c.system, prompt: c.prompt, imageKeys: c.imageKeys, response: c.response, attempts: c.attempts }), 'application/json');
    await db.insert(schema.modelCalls).values({
      id, jobId: c.jobId, projectId: c.projectId, seq: c.seq, purpose: c.purpose, runner: c.runner, driver: c.driver, model: c.model,
      ok: c.ok, error: c.error, attempts: c.attempts.length, tokensIn: c.tokensIn, tokensOut: c.tokensOut, imageKeys: c.imageKeys.length ? c.imageKeys : null,
      bodyKey, startedAt: c.startedAt, finishedAt: c.finishedAt,
    });
  } catch (e) { warn(`模型调用 ${c.jobId}#${c.seq}`, e); }
}

// ---- 归档（API-CORE-018 / API-CORE-031 / storage.gc）：删之前取行，删掉之后写清单、拷对象，最后才清对象前缀 ----
// 对象拷到 records/archive/<日期>/<name>/ 下、保留 projects/<id>/ 之后的路径；清单最后写，有清单的才算一份归档
export type PendingArchive = { name: string; projectId: string; manifest: Record<string, unknown>; prefixes: string[] };

/** 删屏之前：这一屏（family 是它连同变体的 id）的行与全部修订行；开关关着返回 null */
export async function archiveScreen(projectId: string, screenId: string, family: string[]): Promise<PendingArchive | null> {
  try {
    if (!family.length || !(await recordingForProject(projectId))) return null;
    const screens = await db.select().from(schema.screens).where(inArray(schema.screens.id, family));
    const revisions = await db.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.screenId, family));
    return { name: `screen-${screenId}`, projectId, manifest: { kind: 'screen', projectId, screens, revisions }, prefixes: family.map((id) => `projects/${projectId}/screens/${id}/`) };
  } catch (e) { warn(`归档屏 ${screenId}`, e); return null; }
}

/** 删端之前：端的行，连同这一端的屏与全部修订的行；对象是这些屏的前缀 */
export async function archiveSurface(projectId: string, surface: typeof schema.surfaces.$inferSelect, screenIds: string[]): Promise<PendingArchive | null> {
  try {
    if (!(await recordingForProject(projectId))) return null;
    const screens = screenIds.length ? await db.select().from(schema.screens).where(inArray(schema.screens.id, screenIds)) : [];
    const revisions = screenIds.length ? await db.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.screenId, screenIds)) : [];
    return { name: `surface-${surface.id}`, projectId, manifest: { kind: 'surface', projectId, surface, screens, revisions }, prefixes: screenIds.map((id) => `projects/${projectId}/screens/${id}/`) };
  } catch (e) { warn(`归档端 ${surface.id}`, e); return null; }
}

/** 删项目之前：项目、端、设计系统、屏、修订、消息、作业与作业事件、组件、素材的行；对象是 projects/<id>/ 下的全部 */
export async function archiveProject(projectId: string): Promise<PendingArchive | null> {
  try {
    if (!(await recordingForProject(projectId))) return null;
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const surfaces = await db.select().from(schema.surfaces).where(eq(schema.surfaces.projectId, projectId));
    const designSystems = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, projectId));
    const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, projectId));
    const revisions = screens.length ? await db.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.screenId, screens.map((s) => s.id))) : [];
    const messages = await db.select().from(schema.messages).where(eq(schema.messages.projectId, projectId));
    const jobs = await db.select().from(schema.generationJobs).where(eq(schema.generationJobs.projectId, projectId));
    const jobEvents = jobs.length ? await db.select().from(schema.jobEvents).where(inArray(schema.jobEvents.jobId, jobs.map((j) => j.id))) : [];
    const components = await db.select().from(schema.components).where(eq(schema.components.projectId, projectId));
    const assets = await db.select().from(schema.assets).where(eq(schema.assets.projectId, projectId));
    return { name: `project-${projectId}`, projectId, manifest: { kind: 'project', project, surfaces, designSystems, screens, revisions, messages, jobs, jobEvents, components, assets }, prefixes: [`projects/${projectId}/`] };
  } catch (e) { warn(`归档项目 ${projectId}`, e); return null; }
}

/** 草稿本里新草稿失败或取消后删掉的空草稿：删除时 returning 拿到的行就是清单（没有修订、没有对象）；不是草稿本的屏不归档 */
export async function archiveDrafts(projectId: string, rows: (typeof schema.screens.$inferSelect)[]): Promise<void> {
  if (!rows.length) return;
  try {
    const [p] = await db.select({ kind: schema.projects.kind }).from(schema.projects).where(eq(schema.projects.id, projectId));
    if (p?.kind !== 'sketchbook' || !(await recordingForProject(projectId))) return;
  } catch (e) { warn(`归档空草稿 ${rows[0].id}`, e); return; }
  for (const s of rows) await saveArchive({ name: `screen-${s.id}`, projectId, manifest: { kind: 'screen', projectId, screens: [s], revisions: [] }, prefixes: [] });
}

export async function saveArchive(a: PendingArchive | null): Promise<void> {
  if (!a) return;
  try {
    const at = new Date();
    const dir = recordKeys.archive(at, a.name);
    const base = `projects/${a.projectId}/`;
    for (const prefix of a.prefixes) for (const o of await storage.listDeep(prefix)) await storage.copy(o.key, `${dir}/${o.key.slice(base.length)}`);
    // 作业事件里有截图的签名地址：清单与别的记录一样去掉签名（INV-CORE-006），字符串不截断
    await storage.put(`${dir}/manifest.json`, JSON.stringify(recordSafe(JSON.parse(JSON.stringify({ ...a.manifest, archivedAt: at })), Infinity)), 'application/json');
  } catch (e) { warn(`归档 ${a.name}`, e); }
}

/** storage.gc 清掉没发出的参考图之前（§17）：开关开着就拷到 records/archive/<日期>/attachments/ */
export async function archiveAttachment(projectId: string, key: string): Promise<void> {
  try {
    if (await recordingForProject(projectId)) await storage.copy(key, recordKeys.archivedAttachment(new Date(), key));
  } catch (e) { warn(`归档参考图 ${key}`, e); }
}
