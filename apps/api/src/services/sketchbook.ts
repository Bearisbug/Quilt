import { and, eq, inArray } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import type { z } from 'zod';
import { db, schema } from '../db/client.ts';
import { Problem, problems, isUniqueViolation } from '../lib/errors.ts';
import { notifyCanvas } from '../lib/events.ts';
import { storage } from '../lib/storage.ts';
import { requestLocale, tr } from '../lib/locale.ts';
import {
  assembleDocument, buildPrelude, lintScreenBody, frameFromBody, expandComponents, forkBody, forkDraftName, overwriteBody, componentNameSchema, RESTYLE_PROMPT, DEVICE_SIZE, DRAFT_FRAMES, L,
  validateComponentHtml, classifyComponentHtml, componentSummary, textIn, MAX_COMPONENTS_PER_PROJECT, draftRoute, draftComponentName,
  type createMessageSchema, type CreateJobInput, type CopyDraftInput, type CopyDraftResultDto, type CreateDraftInput, type MoveDraftsInput, type MoveDraftsResultDto, type ScreenDto, type DeviceType, type DraftFrame, type LintReport, type Tokens, type Localized,
} from '@quilt/core';
import { createProject, ownedProject, screenDtos, jobDto, type ProjectRow, type JobRow } from './projects.ts';
import { ownedScreen, currentBody, createRevision, deriveLinks, deleteScreen, hasActiveJob } from './screens.ts';
import { createComponent, deleteComponent, sharedComponentsOf, assertNotLocked, componentDtos, componentSlot } from './components.ts';
import { createJob, enqueueScreenshot } from './jobs.ts';
import { surfaceFor } from './surfaces.ts';
import { archiveScreen, saveArchive } from './record.ts';
import type { UserRow } from './user.ts';

// 草稿本（REQ-CORE-040～045，ADR-030～033）：每个用户一个 kind=sketchbook 的项目，草稿是它的屏、每轮是屏的修订。
// 这里放五样：取 / 建草稿本，建作业时的草稿本规则（REST 与 MCP 共用），草稿的参照项目，从屏建草稿，草稿写回项目

export const isSketchbook = (p: { kind: string }): boolean => p.kind === 'sketchbook';

async function sketchbookOf(ownerId: string): Promise<ProjectRow | undefined> {
  return (await db.select().from(schema.projects).where(and(eq(schema.projects.ownerId, ownerId), eq(schema.projects.kind, 'sketchbook'))))[0];
}

// API-CORE-046：第一次取时建出来，开局同不选预设的新建项目（ADR-028）；设备形态 mobile 只为满足非空约束。
// 两个请求同时第一次到达：后到的撞上部分唯一索引 projects_sketchbook_uq，按 owner_id 重查拿到先到的那一个（INV-CORE-001）
export async function ensureSketchbook(ownerId: string): Promise<ProjectRow> {
  const found = await sketchbookOf(ownerId);
  if (found) return found;
  try {
    return (await createProject(ownerId, { name: tr('草稿本', 'Sketchbook'), deviceType: 'mobile' }, 'sketchbook')).project;
  } catch (e) {
    const again = isUniqueViolation(e) ? await sketchbookOf(ownerId) : undefined;
    if (!again) throw e;
    return again;
  }
}

// 草稿本规则（API-CORE-010 草稿本子条目，INV-CORE-003）：草稿本里只受理造一张新草稿与改一张草稿，各只出一版；
// 画框只给草稿本。不合规的字段一次全点出来
function reject(rules: [unknown, string, Localized][]): void {
  const errors = rules.filter(([hit]) => hit).map(([, path, message]) => ({ path, message }));
  if (errors.length) throw problems.validation(errors);
}

// 发消息（API-CORE-010）按请求字段点名：接上跳转 / 按新约定重生成在作业层只是一段提示词，只有这一层认得出来
export function assertSketchbookMessage(project: { kind: string }, body: z.infer<typeof createMessageSchema>): void {
  if (!isSketchbook(project)) return reject([[body.frame, 'frame', L('画框只对草稿本的新草稿有效', 'Frames only apply to new drafts in the Sketchbook')], [body.refProjectId, 'refProjectId', L('参照项目只对草稿本的新草稿有效', 'Reference projects only apply to new drafts in the Sketchbook')]]);
  reject([
    [body.mode, 'mode', L('草稿本没有聊天', 'The Sketchbook has no chat')],
    [body.targetComponentIds?.length, 'targetComponentIds', L('草稿本没有共享组件', 'The Sketchbook has no shared components')],
    [body.anchor, 'anchor', L('草稿不摆在画布上', 'Drafts are not placed on a canvas')],
    [body.count !== undefined && body.count !== 1, 'count', L('一次只出一张草稿', 'Only one draft at a time')],
    [(body.versions ?? 1) > 1, 'versions', L('草稿每轮只出一版', 'A draft gets only one version per round')],
    [body.variantOf, 'variantOf', L('草稿本不出变体', 'The Sketchbook does not make state variants')],
    [body.route, 'route', L('草稿的路由由服务端定', 'Draft routes are assigned by the server')],
    [body.preset, 'preset', L('草稿本没有接上跳转与按新约定重生成', 'The Sketchbook does not support Connect links or Regenerate with new conventions')],
    [(body.targetScreenIds?.length ?? 0) > 1, 'targetScreenIds', L('一次只能改一张草稿', 'You can edit only one draft at a time')],
    [body.refProjectId && body.targetScreenIds?.length, 'refProjectId', L('改稿的参照在草稿上设', 'Set the reference for an edit on the draft itself')],
    [body.surfaceId, 'surfaceId', L('草稿本没有端', 'The Sketchbook has no surfaces')],
  ]);
}

// 作业层（createJob 的入口校验，API-CORE-006 / 010 / 034 与 MCP 建作业工具共用）：路径按作业输入点名
export function assertSketchbookJob(project: { kind: string }, input: CreateJobInput): void {
  if (!isSketchbook(project)) return reject([[input.kind === 'generate' && input.input.frame, 'input.frame', L('画框只对草稿本的新草稿有效', 'Frames only apply to new drafts in the Sketchbook')], [input.kind === 'generate' && input.input.refProjectId, 'input.refProjectId', L('参照项目只对草稿本的新草稿有效', 'Reference projects only apply to new drafts in the Sketchbook')]]);
  if (input.kind === 'generate') {
    const i = input.input;
    return reject([
      [i.count !== 1, 'input.count', L('一次只出一张草稿', 'Only one draft at a time')],
      [i.versions > 1, 'input.versions', L('草稿每轮只出一版', 'A draft gets only one version per round')],
      [i.anchor, 'input.anchor', L('草稿不摆在画布上', 'Drafts are not placed on a canvas')],
      [i.variantOf, 'input.variantOf', L('草稿本不出变体', 'The Sketchbook does not make state variants')],
      [i.route, 'input.route', L('草稿的路由由服务端定', 'Draft routes are assigned by the server')],
      [i.componentIds?.length, 'input.componentIds', L('草稿本没有共享组件', 'The Sketchbook has no shared components')],
      [i.surfaceId, 'input.surfaceId', L('草稿本没有端', 'The Sketchbook has no surfaces')],
      [i.group, 'input.group', L('草稿本没有分组', 'The Sketchbook has no groups')],
    ]);
  }
  if (input.kind === 'edit_screens') {
    const i = input.input;
    return reject([
      [i.screenIds.length !== 1, 'input.screenIds', L('一次只能改一张草稿', 'You can edit only one draft at a time')],
      [i.versions > 1, 'input.versions', L('草稿每轮只出一版', 'A draft gets only one version per round')],
      [i.componentIds?.length, 'input.componentIds', L('草稿本没有共享组件', 'The Sketchbook has no shared components')],
    ]);
  }
  // 草稿里只改一块（REQ-CORE-045）：本来就是单屏单版；目标屏得是这个草稿本里的草稿，由 createJob 的 assertSubtreeTarget 按项目查
  if (input.kind === 'regenerate_subtree') return;
  reject([[true, 'kind', L('草稿本只受理新草稿（generate）、改草稿（edit_screens）与只改一块（regenerate_subtree）', 'The Sketchbook only accepts new drafts (generate), draft edits (edit_screens) and single-block edits (regenerate_subtree)')]]);
}

// 参照项目（REQ-CORE-042 / ADR-033）：草稿有它时出稿、改稿的提示词带它的设计契约，落库按它的 prelude 拼装。
// 项目删除时外键置空；读到这一步之前刚被删的同样当没有，退回自由风格
export async function draftReference(refProjectId: string | null): Promise<{ project: ProjectRow; ds: typeof schema.designSystems.$inferSelect; prelude: string } | null> {
  if (!refProjectId) return null;
  const [row] = await db.select({ project: schema.projects, ds: schema.designSystems }).from(schema.projects)
    .innerJoin(schema.designSystems, eq(schema.designSystems.projectId, schema.projects.id)).where(eq(schema.projects.id, refProjectId));
  return row ? { ...row, prelude: buildPrelude(row.ds.tokens as Tokens) } : null;
}

// 草稿的路由：界面不显示，只为满足屏的路由唯一；取 /draft-<n>，n 从草稿数 + 1 往上找空位
export function nextDraftRoute(taken: string[]): string {
  const used = new Set(taken);
  let n = taken.length + 1;
  while (used.has(`/draft-${n}`)) n++;
  return `/draft-${n}`;
}

// 草稿的画框（字段 screens.frame）：用户选定的优先；选「自动」时取模型在根元素上声明的 data-frame，没写或不认识按 component
export function draftFrame(chosen: string | undefined, body: string): DraftFrame {
  return (DRAFT_FRAMES as readonly string[]).includes(chosen ?? '') ? chosen as DraftFrame : frameFromBody(body) ?? 'component';
}

// 草稿不做设计契约 lint（ADR-030）：修订上记一份空报告，画布与版本列表读到的都是「无偏离」
export const DRAFT_LINT_REPORT: LintReport = { passed: true, firstTry: true, violations: [], danglingRoutes: [] };

// 幂等（§8 写端点约定：同一个键 24 小时内返回首次结果）：写回与建草稿多数没有作业行可借，本地版单进程，记在进程内；
// 同键并发到达的请求共用同一个 Promise，失败的不记
const remembered = new Map<string, { at: number; result: Promise<unknown> }>();
const IDEMPOTENCY_MS = 24 * 3600_000;
async function idempotent<T>(scope: string, key: string | null, run: () => Promise<T>): Promise<{ result: T; reused: boolean }> {
  if (!key) return { result: await run(), reused: false };
  const now = Date.now();
  for (const [k, v] of remembered) if (now - v.at > IDEMPOTENCY_MS) remembered.delete(k);
  const k = `${scope}|${key}`;
  const hit = remembered.get(k);
  if (hit) return { result: await (hit.result as Promise<T>), reused: true };
  const result = run();
  remembered.set(k, { at: now, result });
  result.catch(() => remembered.delete(k));
  return { result: await result, reused: false };
}

type WriteOpts = { idempotencyKey: string | null; requestId: string };
export const copyDraft = (user: UserRow, draftId: string, input: CopyDraftInput, opts: WriteOpts): Promise<{ result: CopyDraftResultDto; reused: boolean }> =>
  idempotent(`copy|${user.id}`, opts.idempotencyKey, () => copyOnce(user, draftId, input, opts.requestId));
export const moveDrafts = (user: UserRow, input: MoveDraftsInput, opts: WriteOpts): Promise<{ result: MoveDraftsResultDto; reused: boolean }> =>
  idempotent(`move|${user.id}`, opts.idempotencyKey, () => moveOnce(user, input, opts.requestId));
export const createDraft = (user: UserRow, input: CreateDraftInput, opts: WriteOpts): Promise<{ result: { screen: ScreenDto }; reused: boolean }> =>
  idempotent(`fork|${user.id}`, opts.idempotencyKey, () => forkOnce(user, input));

// API-CORE-048：从普通项目的一屏（或其中一块）建草稿（REQ-CORE-043，ADR-032）。第一版按来源项目的 prelude 拼装（source_kind=fork），不 lint；
// 参照项目是来源项目，写回目标是来源屏与 qid。来源屏里的共享组件实例原样带进来——草稿本没有这些组件，它们在草稿里就是普通 HTML，
// 写回时由目标项目的正式版展开盖回。不占来源屏的屏锁：之后来源屏被改，写回时由 expectedRevisionId 挡住
async function forkOnce(user: UserRow, input: CreateDraftInput): Promise<{ screen: ScreenDto }> {
  const { screen: source, project } = await ownedScreen(user.id, input.fromScreenId);
  if (project.kind !== 'app') throw problems.notFound();
  const body = await currentBody(source.id);
  if (!body?.trim()) throw problems.validation([{ path: 'fromScreenId', message: L('来源屏还没有内容', 'The source screen has no content yet') }]);
  const block = forkBody(body, input.qid);
  if (!block) throw problems.elementNotFound();
  const book = await ensureSketchbook(user.id);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
  const name = forkDraftName(source.name, input.qid ? block.text : undefined);
  const html = assembleDocument(block.html, buildPrelude(ds.tokens as Tokens), `${book.name} · ${name}`);
  // 整屏的画框按来源屏所在端的设备（REQ-CORE-049）
  const [surface] = source.surfaceId ? await db.select({ deviceType: schema.surfaces.deviceType }).from(schema.surfaces).where(eq(schema.surfaces.id, source.surfaceId)) : [];
  const frame: DraftFrame = input.qid ? 'component' : (surface?.deviceType ?? project.deviceType) === 'desktop' ? 'desktop' : 'mobile';
  // 路由 /draft-<n> 在事务里取：两个请求同时取到同一个号时后到的撞上路由唯一索引，重取一次号再来
  let created: { screenId: string; revisionId: string } | undefined;
  for (let attempt = 0; !created; attempt++) {
    try {
      created = await db.transaction(async (tx) => {
        const taken = (await tx.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, book.id))).map((r) => r.route);
        const [row] = await tx.insert(schema.screens).values({ projectId: book.id, name, route: nextDraftRoute(taken), x: 0, y: 0, frame, refProjectId: project.id, targetScreenId: source.id, targetQid: input.qid ?? null }).returning();
        const rev = await createRevision(tx, { projectId: book.id, screenId: row.id, html, sourceKind: 'fork', lintReport: DRAFT_LINT_REPORT });
        return { screenId: row.id, revisionId: rev!.id };
      });
    } catch (e) { if (!isUniqueViolation(e) || attempt >= 2) throw e; }
  }
  await enqueueScreenshot(created.revisionId);
  await notifyCanvas(book.id, { reason: 'revision', screenId: created.screenId, revisionId: created.revisionId });
  console.log(`[evt] draft_forked ${JSON.stringify({ draft_id: created.screenId, project_id: project.id, from_screen_id: source.id, block: !!input.qid })}`);
  const [row] = await db.select().from(schema.screens).where(eq(schema.screens.id, created.screenId));
  return { screen: (await screenDtos(book, [row]))[0] };
}

// 写回目标（REQ-CORE-044）：落成新屏或覆盖成功后，草稿记下这次写到了哪（换一块时是那块根的编号），写回弹层下次以它为缺省；落成组件不改它
async function rememberTarget(bookId: string, draftId: string, screenId: string, qid: string | null): Promise<void> {
  await db.update(schema.screens).set({ targetScreenId: screenId, targetQid: qid }).where(eq(schema.screens.id, draftId));
  await notifyCanvas(bookId, { reason: 'updated', screenId: draftId });
}

// API-CORE-047：草稿当前这一版原样复制成目标项目的屏或共享组件（零模型调用），restyle 时再对它发一次普通的改屏 / 改组件作业（ADR-031）；
// 或原样覆盖目标项目的一屏、屏里的一块（ADR-032）。一次性快照，之后两边各改各的（INV-CORE-004）。
// 改写作业建不出来（限流、会话已关）就撤掉这份复制，免得重试时多出一份
async function copyOnce(user: UserRow, draftId: string, input: CopyDraftInput, requestId: string): Promise<CopyDraftResultDto> {
  const { screen: draft, project: book } = await ownedScreen(user.id, draftId);
  if (!isSketchbook(book)) throw problems.notFound();
  const target = await ownedProject(user.id, input.projectId);
  if (target.kind !== 'app') throw problems.notFound();
  // 读请求到达这一刻的当前版：草稿正在改也不等、不挡，改完的新版不进项目（§16）
  const body = (await currentBody(draft.id))?.trim();
  if (!body) throw problems.validation([{ path: 'screenId', message: L('草稿还没有内容', 'The draft has no content yet') }]);
  const name = input.name ?? draft.name;
  // restyle 缺省（API-CORE-047）：草稿本来就按目标项目的设计系统写（参照项目就是它，ADR-033）时不必再改写，否则改写；覆盖一律原样写入（restyle:true 由 schema 拒掉）
  const restyle = input.as !== 'overwrite' && (input.restyle ?? draft.refProjectId !== target.id);
  const startRestyle = async (job: CreateJobInput, undo: () => Promise<void>): Promise<JobRow> => {
    try {
      return (await createJob({ user, projectId: target.id, input: job, idempotencyKey: null, requestId, runner: input.runner?.kind === 'agent' ? 'agent' : 'model' })).job;
    } catch (e) { await undo().catch(() => {}); throw e; }
  };
  const logCopied = () => console.log(`[evt] draft_copied ${JSON.stringify({ draft_id: draft.id, project_id: target.id, as: input.as, whole: !input.qid, restyle })}`);

  if (input.as === 'overwrite') {
    const out = await overwriteScreen(target, input, body);
    await rememberTarget(book.id, draft.id, out.screen.id, out.rootQid);
    logCopied();
    return { screen: out.screen, revisionId: out.revisionId, previousRevisionId: input.expectedRevisionId! };
  }

  if (input.as === 'component') {
    const named = componentNameSchema.safeParse(name);
    if (!named.success) throw problems.validation([{ path: 'name', message: named.error.issues[0].message }]);
    // 组件会被复制进每一屏，脚本与样式表放不进去（API-EDIT-004）；单独先查，消息直接告诉用户该怎么放
    if (parseHTML(`<!doctype html><html><body>${body}</body></html>`).document.body.querySelector('script, style')) {
      throw problems.validation([{ path: 'as', message: L('草稿里有脚本或样式表，组件放不下，放成屏', 'The draft has scripts or style sheets, which a component cannot hold; copy it as a screen') }]);
    }
    const { component } = await createComponent(user.id, target.id, { name: named.data, html: body });
    const job = restyle ? await startRestyle({ kind: 'edit_component', input: { componentId: component.id, prompt: RESTYLE_PROMPT, runner: input.runner } }, () => deleteComponent(user.id, component.id)) : undefined;
    logCopied();
    return { component, ...(job ? { job: jobDto(job) } : {}) };
  }

  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, target.id));
  const prelude = buildPrelude(ds.tokens as Tokens);
  const shared = await sharedComponentsOf(target.id);
  // 放成屏落在第一端（REQ-CORE-049）：路由去重与排位只看这一端；要放进别的端用「搬进项目」（API-CORE-055）
  const surface = await surfaceFor(target.id);
  const size = DEVICE_SIZE[surface.deviceType as DeviceType];
  let created: { screenId: string; revisionId: string };
  try {
    created = await db.transaction(async (tx) => {
      const others = await tx.select({ route: schema.screens.route, x: schema.screens.x }).from(schema.screens).where(eq(schema.screens.surfaceId, surface.id));
      const route = draftRoute(name, others.map((s) => s.route));
      // 从屏拿来的草稿可能带着来源项目的共享组件实例：按目标项目的正式版展开（ADR-032），目标项目没有同名组件的原样留着
      const expanded = expandComponents(body, shared, route).html;
      // 摆在最右一屏右侧，与造屏不带锚点时同一个间距（REQ-CORE-014）
      const x = others.reduce((m, s) => Math.max(m, s.x + size.w + 80), 0);
      const [s] = await tx.insert(schema.screens).values({ projectId: target.id, surfaceId: surface.id, name, route, x, y: 0 }).returning();
      const rev = await createRevision(tx, { projectId: target.id, screenId: s.id, html: assembleDocument(expanded, prelude, `${target.name} · ${name}`), sourceKind: 'sketch', lintReport: lintScreenBody(expanded, [...others.map((o) => o.route), route], true) });
      await deriveLinks(tx, target.id);
      await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, target.id));
      return { screenId: s.id, revisionId: rev!.id };
    });
  } catch (e) { if (isUniqueViolation(e)) throw problems.routeTaken(); throw e; }
  const job = restyle ? await startRestyle({ kind: 'edit_screens', input: { prompt: RESTYLE_PROMPT, screenIds: [created.screenId], versions: 1, runner: input.runner } }, () => deleteScreen(target.id, created.screenId)) : undefined;
  await enqueueScreenshot(created.revisionId);
  await notifyCanvas(target.id, { reason: 'revision', screenId: created.screenId, revisionId: created.revisionId });
  await rememberTarget(book.id, draft.id, created.screenId, null);
  const [row] = await db.select().from(schema.screens).where(eq(schema.screens.id, created.screenId));
  logCopied();
  return { screen: (await screenDtos(target, [row]))[0], ...(job ? { job: jobDto(job) } : {}) };
}

// as=overwrite（REQ-CORE-044，ADR-032）：草稿当前版原样写成目标屏的一条新修订（source_kind=sketch，父修订是原来的当前版），不改写、不动已有修订，
// 之后能用 API-CORE-015 回到覆盖前那一版（INV-CORE-005）。目标屏有在跑的作业不写（§16「写回时目标屏正在改」），当前版已不是确认时那一版也不写
// （§16「写回时目标屏已被别处改过」）；两道在落修订的事务里各再判一次
async function overwriteScreen(target: ProjectRow, input: CopyDraftInput, draftBody: string): Promise<{ screen: ScreenDto; revisionId: string; rootQid: string | null }> {
  const [screen] = await db.select().from(schema.screens).where(and(eq(schema.screens.id, input.screenId!), eq(schema.screens.projectId, target.id)));
  if (!screen) throw problems.notFound();
  if (await hasActiveJob(db, target.id, screen.id)) throw problems.screenBusy();
  if (screen.currentRevisionId !== input.expectedRevisionId) throw problems.revisionConflict();
  const current = (await currentBody(screen.id)) ?? '';
  const replaced = overwriteBody(current, draftBody, input.qid);
  if (!replaced) throw problems.elementNotFound();
  // 共享组件实例里的元素不能换（与直改同一把锁）：换进去的内容在下一次写入时就被组件正式版盖回
  if (input.qid) await assertNotLocked(target.id, current, input.qid);
  // 共享组件占位照常按目标项目的正式版展开（草稿里改到的实例被盖回），照常 lint
  const expanded = expandComponents(replaced.body, await sharedComponentsOf(target.id), screen.route).html;
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(screen.surfaceId ? eq(schema.screens.surfaceId, screen.surfaceId) : eq(schema.screens.projectId, target.id))).map((r) => r.route);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, target.id));
  const html = assembleDocument(expanded, buildPrelude(ds.tokens as Tokens), `${target.name} · ${screen.name}`);
  const rev = await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, target.id, screen.id)) throw problems.screenBusy();
    const r = await createRevision(tx, { projectId: target.id, screenId: screen.id, html, sourceKind: 'sketch', lintReport: lintScreenBody(expanded, routes, true), expectedRevisionId: input.expectedRevisionId });
    if (!r) throw problems.revisionConflict();
    await deriveLinks(tx, target.id);
    await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, target.id));
    return r;
  });
  await enqueueScreenshot(rev.id);
  await notifyCanvas(target.id, { reason: 'revision', screenId: screen.id, revisionId: rev.id });
  const [row] = await db.select().from(schema.screens).where(eq(schema.screens.id, screen.id));
  return { screen: (await screenDtos(target, [row]))[0], revisionId: rev.id, rootQid: replaced.rootQid };
}

// API-CORE-055（ADR-042）：几张草稿一次搬进项目的一端——每张只搬当前这一版，页面草稿成这一端的屏、组件草稿成共享组件，之后草稿删掉。
// 一个事务（INV-CORE-012）：先锁住全部草稿行，任一张不在草稿本、正在生成或校验不过就整批不动；改写作业在提交之后建，建不出来不回滚
async function moveOnce(user: UserRow, input: MoveDraftsInput, requestId: string): Promise<MoveDraftsResultDto> {
  const book = await sketchbookOf(user.id);
  if (!book) throw problems.notFound();
  const target = await ownedProject(user.id, input.projectId);
  if (target.kind !== 'app') throw problems.notFound();
  const surface = await surfaceFor(target.id, input.surfaceId);
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, target.id));
  const prelude = buildPrelude(ds.tokens as Tokens);
  const shared = await sharedComponentsOf(target.id);
  const size = DEVICE_SIZE[surface.deviceType as DeviceType];
  // 本机使用记录（REQ-CORE-047）照删屏一样归档草稿；事务没成就不写
  const archives = await Promise.all(input.draftIds.map((id) => archiveScreen(book.id, id, [id])));
  let made: { screens: { id: string; revisionId: string; restyle: boolean }[]; components: { id: string; restyle: boolean }[] };
  try {
    made = await db.transaction(async (tx) => {
      const rows = await tx.select().from(schema.screens).where(and(inArray(schema.screens.id, input.draftIds), eq(schema.screens.projectId, book.id))).for('update');
      if (rows.length !== input.draftIds.length) throw problems.notFound();
      for (const r of rows) if (await hasActiveJob(tx, book.id, r.id)) throw problems.screenBusy();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items: { draft: typeof rows[number]; body: string; component: boolean }[] = [];
      const issues: { path: string; message: Localized }[] = [];
      for (const [i, id] of input.draftIds.entries()) {
        const draft = byId.get(id)!;
        const body = (await currentBody(draft.id))?.trim();
        if (!body) { issues.push({ path: `draftIds.${i}`, message: L(`「${draft.name}」还没有内容`, `“${draft.name}” has no content yet`) }); continue; }
        const component = draft.frame === 'component';
        if (component && parseHTML(`<!doctype html><html><body>${body}</body></html>`).document.body.querySelector('script, style')) {
          issues.push({ path: `draftIds.${i}`, message: L(`「${draft.name}」里有脚本或样式表，放不进组件`, `“${draft.name}” has scripts or style sheets, which a component cannot hold`) });
          continue;
        }
        if (component) {
          const v = validateComponentHtml(body, requestLocale());
          if (!v.ok) { issues.push({ path: `draftIds.${i}`, message: L(`「${draft.name}」：${v.error}`, `“${draft.name}”: ${v.error}`) }); continue; }
        }
        items.push({ draft, body, component });
      }
      if (issues.length) throw problems.validation(issues);
      const comps = await tx.select({ name: schema.components.name }).from(schema.components).where(eq(schema.components.projectId, target.id));
      const compCount = items.filter((it) => it.component).length;
      if (comps.length + compCount > MAX_COMPONENTS_PER_PROJECT) throw problems.validation([{ path: 'draftIds', message: L(`每个项目最多 ${MAX_COMPONENTS_PER_PROJECT} 个共享组件`, `A project can have at most ${MAX_COMPONENTS_PER_PROJECT} shared components`) }]);
      const others = await tx.select({ route: schema.screens.route, x: schema.screens.x }).from(schema.screens).where(eq(schema.screens.surfaceId, surface.id));
      const taken = others.map((o) => o.route);
      const names = comps.map((c) => c.name);
      // 按勾选顺序摆在这一端最右一屏右侧，排成一行，间距同造屏（REQ-CORE-014）
      let x = others.reduce((m, s) => Math.max(m, s.x + size.w + 80), 0);
      const out: typeof made = { screens: [], components: [] };
      // restyle 缺省同 API-CORE-047：草稿本来就参照目标项目的不改写，其余改写
      const restyleOf = (d: typeof rows[number]) => input.restyle ?? d.refProjectId !== target.id;
      for (const it of items) {
        if (it.component) {
          const name = draftComponentName(it.draft.name, names);
          names.push(name);
          const c = classifyComponentHtml(it.body);
          const [row] = await tx.insert(schema.components).values({ projectId: target.id, name, html: c.html, activeClass: c.activeClass, inactiveClass: c.inactiveClass, summary: componentSummary(c.html), ...componentSlot(comps.length + out.components.length) }).returning();
          out.components.push({ id: row.id, restyle: restyleOf(it.draft) });
          continue;
        }
        const route = draftRoute(it.draft.name, taken);
        taken.push(route);
        const expanded = expandComponents(it.body, shared, route).html;
        const [s] = await tx.insert(schema.screens).values({ projectId: target.id, surfaceId: surface.id, groupName: input.group ?? null, name: it.draft.name, route, x, y: 0 }).returning();
        x += size.w + 80;
        out.screens.push({ id: s.id, revisionId: '', restyle: restyleOf(it.draft) });
        const rev = await createRevision(tx, { projectId: target.id, screenId: s.id, html: assembleDocument(expanded, prelude, `${target.name} · ${it.draft.name}`), sourceKind: 'sketch', lintReport: lintScreenBody(expanded, taken, true) });
        out.screens[out.screens.length - 1].revisionId = rev!.id;
      }
      await tx.delete(schema.screens).where(inArray(schema.screens.id, input.draftIds));
      if (out.screens.length) await deriveLinks(tx, target.id);
      await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, target.id));
      return out;
    });
  } catch (e) { if (isUniqueViolation(e)) throw problems.routeTaken(); throw e; }
  for (const a of archives) await saveArchive(a);
  for (const id of input.draftIds) await storage.deletePrefix(`projects/${book.id}/screens/${id}/`).catch((e) => console.warn(`[move drafts] ${id}: ${(e as Error).message}`));
  for (const s of made.screens) await enqueueScreenshot(s.revisionId);
  await notifyCanvas(book.id, { reason: 'moved' });
  await notifyCanvas(target.id, { reason: 'moved' });
  // 改写：搬来的屏一起建一个改屏作业，每个组件一个改组件作业；建不出来（限流、会话已关）就停下，已搬的留在项目里
  const jobs: JobRow[] = [];
  let restyleError: string | undefined;
  const runner = input.runner?.kind === 'agent' ? 'agent' : 'model';
  const restyle: CreateJobInput[] = [
    ...(made.screens.some((s) => s.restyle) ? [{ kind: 'edit_screens', input: { prompt: RESTYLE_PROMPT, screenIds: made.screens.filter((s) => s.restyle).map((s) => s.id), versions: 1, runner: input.runner } } as CreateJobInput] : []),
    ...made.components.filter((c) => c.restyle).map((c) => ({ kind: 'edit_component', input: { componentId: c.id, prompt: RESTYLE_PROMPT, runner: input.runner } }) as CreateJobInput),
  ];
  for (const job of restyle) {
    try { jobs.push((await createJob({ user, projectId: target.id, input: job, idempotencyKey: null, requestId, runner })).job); }
    catch (e) { restyleError = e instanceof Problem ? textIn(e.titleText, requestLocale()) : (e as Error).message; break; }
  }
  console.log(`[evt] drafts_moved ${JSON.stringify({ project_id: target.id, surface_id: surface.id, screens: made.screens.length, components: made.components.length, restyle_jobs: jobs.length, restyle_error: !!restyleError })}`);
  const screenRows = made.screens.length ? await db.select().from(schema.screens).where(inArray(schema.screens.id, made.screens.map((s) => s.id))) : [];
  const compRows = made.components.length ? await db.select().from(schema.components).where(inArray(schema.components.id, made.components.map((c) => c.id))) : [];
  const order = new Map(made.screens.map((s, i) => [s.id, i]));
  return {
    screens: await screenDtos(target, screenRows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)),
    components: await componentDtos(target, compRows),
    jobs: jobs.map(jobDto),
    ...(restyleError ? { restyleError } : {}),
  };
}
