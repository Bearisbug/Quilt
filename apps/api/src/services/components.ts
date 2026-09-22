import { and, eq, inArray, sql } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { problems, isUniqueViolation } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { signPreview, stableExpiry } from '../lib/signing.ts';
import { emitProjectEvent } from '../lib/events.ts';
import {
  assembleDocument, buildPrelude, extractBody, lintScreenBody, expandComponents, extractComponent, findComponentMatch, replaceWithPlaceholder,
  componentSummary, componentSlots, componentPlacement, componentOf, validateComponentHtml, classifyComponentHtml, applyElementOps, injectQids, MAX_COMPONENTS_PER_PROJECT,
  type ComponentDto, type SharedComponent, type SharedComponentCard, type Tokens, type ElementOp,
} from '@quilt/core';
import { ownedProject, type ProjectRow, type ScreenRow } from './projects.ts';
import { createRevision, deriveLinks, hasActiveJob } from './screens.ts';
import { enqueueScreenshot } from './jobs.ts';

// 共享组件（REQ-EDIT-006 / ADR-019）：项目级一段 HTML，屏里放占位、每次写入时展开；改组件 → 用它的屏确定性回刷。
type Row = typeof schema.components.$inferSelect;
export type Skipped = { screenId: string; name: string; reason: string };
export type Applied = { screenId: string; revisionId: string; html: string };
export type ComponentResult = { component: ComponentDto; applied: string[]; skipped: Skipped[] };

// 新组件落在风格指南卡那一列的下方，逐个往下排；用户随时能拖走
const COLUMN_X = -500;
const COLUMN_Y0 = 760;
const COLUMN_GAP = 400;
// 完整 HTML 进上下文的总预算（ADR-012 的 10K 里给组件的份额）
const FULL_HTML_BUDGET = 24 * 1024;

export const toShared = (r: Row): SharedComponent => ({ name: r.name, html: r.html, activeClass: r.activeClass, inactiveClass: r.inactiveClass });
export async function componentRows(projectId: string): Promise<Row[]> {
  return db.select().from(schema.components).where(eq(schema.components.projectId, projectId)).orderBy(schema.components.createdAt);
}
export async function sharedComponentsOf(projectId: string): Promise<SharedComponent[]> {
  return (await componentRows(projectId)).map(toShared);
}

const tagOf = (html: string) => { const v = validateComponentHtml(html); return v.ok ? v.tag : 'div'; };
async function usesOf(projectId: string): Promise<Map<string, string[]>> {
  const rows = await db.select({ name: schema.componentUses.name, screenId: schema.componentUses.screenId }).from(schema.componentUses).where(eq(schema.componentUses.projectId, projectId));
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.name, [...(m.get(r.name) ?? []), r.screenId]);
  return m;
}

export async function componentDtos(project: ProjectRow, rows: Row[]): Promise<ComponentDto[]> {
  if (!rows.length) return [];
  const uses = await usesOf(project.id);
  const token = signPreview(project.id, stableExpiry(config.previewTokenMinutes));
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, name: r.name, summary: r.summary, html: r.html, slots: componentSlots(r.html),
    nav: r.activeClass !== null || r.inactiveClass !== null,
    x: r.x, y: r.y, version: r.version,
    previewUrl: `${config.previewOrigin}/c/${project.id}/${r.id}?v=${r.version}&t=${token}`,
    usedBy: uses.get(r.name) ?? [],
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }));
}

// 提示词里的卡（ADR-012 分级）：每个组件永远一张卡；完整 HTML 只给「框选的」与「目标屏本来就用的」，总量封顶后先丢最大的
export async function componentCards(projectId: string, full: { ids?: string[]; screenIds?: string[] } = {}): Promise<SharedComponentCard[]> {
  const rows = await componentRows(projectId);
  if (!rows.length) return [];
  const want = new Set<string>();
  for (const r of rows) if (full.ids?.includes(r.id)) want.add(r.name);
  if (full.screenIds?.length) {
    const uses = await db.select({ name: schema.componentUses.name }).from(schema.componentUses)
      .where(and(eq(schema.componentUses.projectId, projectId), inArray(schema.componentUses.screenId, full.screenIds)));
    for (const u of uses) want.add(u.name);
  }
  const cards: SharedComponentCard[] = rows.map((r) => ({ name: r.name, summary: r.summary, tag: tagOf(r.html), slots: componentSlots(r.html), ...(want.has(r.name) ? { html: r.html } : {}) }));
  let total = cards.reduce((n, c) => n + (c.html?.length ?? 0), 0);
  while (total > FULL_HTML_BUDGET) {
    const biggest = cards.filter((c) => c.html).sort((a, b) => b.html!.length - a.html!.length)[0];
    if (!biggest) break;
    total -= biggest.html!.length; delete biggest.html;
  }
  return cards;
}

// 设计契约里的投影（quilt.get_design_contract）：本机 agent 读它就知道该用占位而不是手写副本
export async function contractComponents(projectId: string) {
  const rows = await componentRows(projectId);
  const uses = await usesOf(projectId);
  return rows.map((r) => { const tag = tagOf(r.html); const slots = componentSlots(r.html); return { id: r.id, name: r.name, summary: r.summary, tag, slots, placement: componentPlacement(r.name, tag, slots), html: r.html, version: r.version, usedBy: uses.get(r.name) ?? [] }; });
}

export async function ownedComponent(ownerId: string, componentId: string): Promise<{ component: Row; project: ProjectRow }> {
  const [component] = await db.select().from(schema.components).where(eq(schema.components.id, componentId));
  if (!component) throw problems.notFound();
  const project = await ownedProject(ownerId, component.projectId);
  return { component, project };
}

// 直改 / 批注的锁（API-EDIT-001）：元素在某个还存在的组件实例里就拒，唯一放行的是「脱离共享」
export async function assertNotLocked(projectId: string, body: string, qid: string, ops?: ElementOp[]): Promise<void> {
  const inside = componentOf(body, qid);
  if (!inside) return;
  const [row] = await db.select({ id: schema.components.id }).from(schema.components).where(and(eq(schema.components.projectId, projectId), eq(schema.components.name, inside.name))).limit(1);
  if (!row) return;
  if (ops && ops.length === 1 && ops[0].type === 'detach') return;
  throw problems.componentLocked(inside.name);
}

async function screenBodies(projectId: string): Promise<{ screen: ScreenRow; body: string; prelude: string; project: ProjectRow }[]> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, projectId));
  const prelude = buildPrelude(ds.tokens as Tokens);
  const screens = await db.select().from(schema.screens).where(eq(schema.screens.projectId, projectId)).orderBy(schema.screens.createdAt);
  const out = [];
  for (const screen of screens) {
    if (!screen.currentRevisionId) continue;
    const [rev] = await db.select({ htmlKey: schema.screenRevisions.htmlKey }).from(schema.screenRevisions).where(eq(schema.screenRevisions.id, screen.currentRevisionId));
    if (!rev) continue;
    out.push({ screen, body: extractBody((await storage.get(rev.htmlKey)).toString('utf8')), prelude, project });
  }
  return out;
}

// 给一屏落一版 component 修订：有在跑作业 / 修订已变就返回 null（调用方记 skipped）
async function writeScreen(item: { screen: ScreenRow; prelude: string; project: ProjectRow }, body: string, routes: string[], jobId: string | null): Promise<Applied | null> {
  const report = lintScreenBody(body, routes, true);
  const html = assembleDocument(body, item.prelude, `${item.project.name} · ${item.screen.name}`);
  const rev = await db.transaction(async (tx) => {
    if (await hasActiveJob(tx, item.project.id, item.screen.id)) return null;
    return createRevision(tx, { projectId: item.project.id, screenId: item.screen.id, html, sourceKind: 'component', jobId, lintReport: report, expectedRevisionId: item.screen.currentRevisionId });
  });
  return rev ? { screenId: item.screen.id, revisionId: rev.id, html } : null;
}

/**
 * 回刷：所有当前修订里放着这个组件的屏，按最新组件重新展开、各落一版 component 修订。
 * 跳过有在跑作业的屏（那屏的作业落地时写入路径照样展开，用的就是最新组件）。截图由调用方决定（REST 入队，worker 同步拍）。
 */
export async function reflowComponent(projectId: string, comp: Row, opts: { jobId?: string | null; rename?: { from: string; to: string }; oldName?: string } = {}): Promise<{ applied: Applied[]; skipped: Skipped[] }> {
  const shared = await sharedComponentsOf(projectId);
  const lookFor = opts.oldName ?? comp.name;
  const uses = await db.select({ screenId: schema.componentUses.screenId }).from(schema.componentUses).where(and(eq(schema.componentUses.projectId, projectId), eq(schema.componentUses.name, lookFor)));
  const ids = new Set(uses.map((u) => u.screenId));
  const items = (await screenBodies(projectId)).filter((x) => ids.has(x.screen.id));
  const routes = (await db.select({ route: schema.screens.route }).from(schema.screens).where(eq(schema.screens.projectId, projectId))).map((r) => r.route);
  const applied: Applied[] = []; const skipped: Skipped[] = [];
  for (const item of items) {
    const { html: body } = expandComponents(item.body, shared, item.screen.route, { rename: opts.rename });
    if (body === item.body) continue;
    const r = await writeScreen(item, body, routes, opts.jobId ?? null);
    if (r) applied.push(r); else skipped.push({ screenId: item.screen.id, name: item.screen.name, reason: 'busy' });
  }
  if (applied.length) await db.transaction((tx) => deriveLinks(tx, projectId));
  return { applied, skipped };
}

async function notifyApplied(projectId: string, applied: Applied[]): Promise<void> {
  for (const a of applied) {
    await enqueueScreenshot(a.revisionId);
    await emitProjectEvent(projectId, 'screen_changed', { screenId: a.screenId, revisionId: a.revisionId }).catch(() => {});
  }
}

async function dtoOf(project: ProjectRow, id: string): Promise<ComponentDto> {
  const [row] = await db.select().from(schema.components).where(eq(schema.components.id, id));
  return (await componentDtos(project, [row]))[0];
}

// API-EDIT-004：建组件——直接给 HTML，或从屏里提取（同时把其他屏里对应的元素换成它）
export async function createComponent(ownerId: string, projectId: string, input: { name: string; html: string } | { name: string; fromScreenId: string; qid: string; applyToScreens?: boolean }): Promise<ComponentResult> {
  const project = await ownedProject(ownerId, projectId);
  const existing = await componentRows(project.id);
  if (existing.length >= MAX_COMPONENTS_PER_PROJECT) throw problems.validation([{ path: 'name', message: `每个项目最多 ${MAX_COMPONENTS_PER_PROJECT} 个共享组件` }]);
  const pos = { x: COLUMN_X, y: COLUMN_Y0 + existing.length * COLUMN_GAP };
  const insert = async (values: { name: string; html: string; activeClass: string | null; inactiveClass: string | null }): Promise<Row> => {
    try {
      const [row] = await db.insert(schema.components).values({ projectId: project.id, ...values, summary: componentSummary(values.html), ...pos }).returning();
      return row;
    } catch (e) { if (isUniqueViolation(e)) throw problems.componentNameTaken(); throw e; }
  };
  if ('html' in input) {
    const v = validateComponentHtml(input.html);
    if (!v.ok) throw problems.validation([{ path: 'html', message: v.error }]);
    const c = classifyComponentHtml(input.html);
    const row = await insert({ name: input.name, html: c.html, activeClass: c.activeClass, inactiveClass: c.inactiveClass });
    return { component: await dtoOf(project, row.id), applied: [], skipped: [] };
  }
  // 提取：先看来源屏能不能动，再落组件行，再换屏
  const items = await screenBodies(project.id);
  const source = items.find((x) => x.screen.id === input.fromScreenId);
  if (!source) throw problems.elementNotFound();
  if (await hasActiveJob(db, project.id, source.screen.id)) throw problems.screenBusy();
  const live = existing.map((r) => r.name);
  const ext = extractComponent(source.body, input.qid, source.screen.route, live);
  if ('error' in ext) throw ext.error.includes('不存在') ? problems.elementNotFound() : problems.validation([{ path: 'qid', message: ext.error }]);
  // 提取时把屏里那套 qid 整套剥掉了（extractComponent），这里要给组件补上自己的一套——
  // 组件里的元素直改（API-EDIT-005）按 qid 定位，不补的话这条路径建出来的组件永远选不中元素，
  // 而且要等下次重启被 backfillComponentQids 补上才突然能用，同一个组件重启前后行为不同。
  // 不走 classifyComponentHtml：它重算 navClasses 时没有 route 上下文，会把提取时按屏算出的激活态丢掉。
  const html = injectQids(ext.html);
  const v = validateComponentHtml(html);
  if (!v.ok) throw problems.validation([{ path: 'qid', message: v.error }]);
  const row = await insert({ name: input.name, html, activeClass: ext.activeClass, inactiveClass: ext.inactiveClass });
  const shared = [...existing.map(toShared), toShared(row)];
  const routes = items.map((x) => x.screen.route);
  const applied: Applied[] = []; const skipped: Skipped[] = [];
  const swap = async (item: typeof source, qid: string) => {
    const ph = replaceWithPlaceholder(item.body, qid, row.name, ext.tag);
    if (!ph) return skipped.push({ screenId: item.screen.id, name: item.screen.name, reason: 'no-match' });
    const r = await writeScreen(item, expandComponents(ph, shared, item.screen.route).html, routes, null);
    if (r) applied.push(r); else skipped.push({ screenId: item.screen.id, name: item.screen.name, reason: 'busy' });
  };
  await swap(source, input.qid);
  if (input.applyToScreens !== false) {
    for (const item of items) {
      if (item.screen.id === source.screen.id) continue;
      const qid = findComponentMatch(item.body, ext.tag, ext.depth, ext.classes, live);
      if (!qid) { skipped.push({ screenId: item.screen.id, name: item.screen.name, reason: 'no-match' }); continue; }
      await swap(item, qid);
    }
  }
  if (applied.length) await db.transaction((tx) => deriveLinks(tx, project.id));
  await notifyApplied(project.id, applied);
  return { component: await dtoOf(project, row.id), applied: applied.map((a) => a.screenId), skipped };
}

// API-EDIT-004：改组件——html / name 带乐观锁并回刷；只挪 x / y 不升版不回刷
/**
 * 组件里的元素直改（v0.57 `REQ-EDIT-006` / `API-EDIT-005`）：与屏的 `API-EDIT-001` 同一套 op，
 * 只是落在组件自己的 HTML 上。改完走 updateComponent 那条路——升版 + 确定性回刷所有用它的屏，
 * 所以这里不需要自己碰任何屏。乐观并发用组件版本号（组件没有修订这个概念）。
 */
export async function applyComponentElementEdit(ownerId: string, componentId: string, qid: string, ops: ElementOp[], expectedVersion: number): Promise<ComponentResult> {
  const { component, project } = await ownedComponent(ownerId, componentId);
  // 这个组件正被 edit_component 作业改着时不收直改：作业收尾时按 `where version = N` 条件更新，
  // 中途被顶掉一版它就匹配不到行、整个作业失败，花掉的 token 全白费（屏那条路由 hasActiveJob 守着同一件事）
  const running = await db.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.projectId, project.id), eq(schema.generationJobs.kind, 'edit_component'),
      inArray(schema.generationJobs.status, ['queued', 'running']),
      sql`${schema.generationJobs.input} ->> 'componentId' = ${componentId}`));
  if (running.length) throw problems.componentBusy(component.name);
  if (component.version !== expectedVersion) throw problems.versionConflict();
  const next = applyElementOps(component.html, qid, ops);
  if (next === null) throw problems.elementNotFound();
  const v = validateComponentHtml(next);
  // 删掉根元素就没有组件了；其余结构性错误同样退回去，不落库
  if (!v.ok) throw problems.validation([{ path: 'ops', message: v.error }]);
  return updateComponent(ownerId, componentId, { html: next, expectedVersion });
}

export async function updateComponent(ownerId: string, componentId: string, patch: { name?: string; html?: string; x?: number; y?: number; expectedVersion?: number }): Promise<ComponentResult> {
  const { component, project } = await ownedComponent(ownerId, componentId);
  const contentChange = patch.html !== undefined || patch.name !== undefined;
  if (!contentChange) {
    await db.update(schema.components).set({ ...(patch.x !== undefined ? { x: patch.x } : {}), ...(patch.y !== undefined ? { y: patch.y } : {}) }).where(eq(schema.components.id, component.id));
    return { component: await dtoOf(project, component.id), applied: [], skipped: [] };
  }
  if (component.version !== patch.expectedVersion) throw problems.versionConflict();
  let values: Partial<Row> = { version: component.version + 1, updatedAt: new Date(), ...(patch.x !== undefined ? { x: patch.x } : {}), ...(patch.y !== undefined ? { y: patch.y } : {}) };
  if (patch.html !== undefined) {
    const v = validateComponentHtml(patch.html);
    if (!v.ok) throw problems.validation([{ path: 'html', message: v.error }]);
    const c = classifyComponentHtml(patch.html);
    // 激活态那对类描述的是「选中长什么样」，不是「哪一条选中」——哪条亮由屏的路由在展开时算（applyActiveState）。
    // navClasses 认的是 aria-current，改动一旦删掉或改掉当前标着 aria-current 的那条链接，它就返回一对 null，
    // 展开时整段激活态逻辑被跳过、所有屏的导航一起变成清一色未激活。这种情况下留着上一版的那对类。
    const nav = c.activeClass === null && c.inactiveClass === null && (component.activeClass !== null || component.inactiveClass !== null)
      ? { activeClass: component.activeClass, inactiveClass: component.inactiveClass }
      : { activeClass: c.activeClass, inactiveClass: c.inactiveClass };
    values = { ...values, html: c.html, summary: componentSummary(c.html), ...nav };
  }
  if (patch.name !== undefined) values.name = patch.name;
  let updated: Row;
  try {
    const rows = await db.update(schema.components).set(values).where(and(eq(schema.components.id, component.id), eq(schema.components.version, component.version))).returning();
    if (!rows.length) throw problems.versionConflict();
    updated = rows[0];
  } catch (e) { if (isUniqueViolation(e)) throw problems.componentNameTaken(); throw e; }
  const rename = patch.name !== undefined && patch.name !== component.name ? { from: component.name, to: patch.name } : undefined;
  const { applied, skipped } = await reflowComponent(project.id, updated, { rename, oldName: component.name });
  await notifyApplied(project.id, applied);
  return { component: await dtoOf(project, updated.id), applied: applied.map((a) => a.screenId), skipped };
}

// 删组件不动屏：已展开的 HTML 留在屏里，只是不再跟着变（展开时不认识的名字原样保留）
export async function deleteComponent(ownerId: string, componentId: string): Promise<void> {
  const { component } = await ownedComponent(ownerId, componentId);
  await db.delete(schema.components).where(eq(schema.components.id, component.id));
  await db.delete(schema.componentUses).where(and(eq(schema.componentUses.projectId, component.projectId), eq(schema.componentUses.name, component.name)));
}

// 预览域 /c/：只渲染这一个组件，加载后把根元素尺寸报给父页，画布卡片按它定大小
export function componentPreviewDocument(row: Row, prelude: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${row.html}</body></html>`);
  const root = document.body.firstElementChild;
  root?.setAttribute('data-component', row.name);
  const body = root?.outerHTML ?? row.html;
  const measure = `<script>window.addEventListener('load',function(){var r=document.querySelector('[data-component]');if(!r)return;var b=r.getBoundingClientRect();parent.postMessage({type:'quilt:component-size',componentId:${JSON.stringify(row.id)},w:Math.ceil(b.width),h:Math.ceil(b.height)},'*');});</script>`;
  // 告诉预览运行时「这是组件不是屏」：组件里的链接一律惰性，不劫持、不上报（v0.55）
  const isComponent = '<script>window.__quiltComponent = true;</script>';
  return `<!doctype html>\n<html lang="en">\n<head>\n${prelude}\n${isComponent}\n<title>${row.name}</title>\n</head>\n<body>\n<div class="flex flex-col">${body}</div>\n${measure}\n</body>\n</html>\n`;
}
