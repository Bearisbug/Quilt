import { and, eq, desc, sql, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { db, schema, type Db } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { notifyCanvas } from '../lib/events.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { thumbnailOf, losslessWebp } from '../lib/screenshot.ts';
import { imageHead, canReuseShot } from '../lib/shots.ts';
import { config } from '../config.ts';
import { signPreview, stableExpiry } from '../lib/signing.ts';
import { extractLinks, extractBody, outlineBody, componentNamesIn, screenInstructionHistory, shotSpecFor, parseStates, shadowedStateKeys, type SurfaceStates, type LintReport, type RevisionDto, type SourceKind, type CandidatesDto, DEVICE_SIZE, type DeviceType, type Presentation, type DraftFrame } from '@quilt/core';
import { ownedProject, type ScreenRow, type RevisionRow, type ProjectRow } from './projects.ts';
import { archiveScreen, saveArchive } from './record.ts';
import { diffRows } from '../lib/rowDiff.ts';

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function ownedScreen(ownerId: string, screenId: string): Promise<{ screen: ScreenRow; project: Awaited<ReturnType<typeof ownedProject>> }> {
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
  if (!screen) throw problems.notFound();
  const project = await ownedProject(ownerId, screen.projectId);
  return { screen, project };
}

export async function hasActiveJob(tx: Tx, projectId: string, screenId: string): Promise<boolean> {
  const rows = await tx.select({ id: schema.generationJobs.id }).from(schema.generationJobs)
    .where(and(eq(schema.generationJobs.projectId, projectId), eq(schema.generationJobs.targetScreenId, screenId), inArray(schema.generationJobs.status, ['queued', 'running'])));
  return rows.length > 0;
}

// 新修订（ADR-014 修订树）：先锁屏行再取号——并行落候选时两笔事务会算出同一 seq 撞唯一键（RUN-059）。
// parentRevisionId 默认取此刻的 current；候选批要显式传同一个父版（第 1 版落库后 current 已变）。
// advanceCurrent=false 只落修订不推进 current（候选批由调用方在全部落完后统一指向第 1 版）。
// 返回 null 表示 expectedRevisionId 已过期。
export async function createRevision(tx: Tx, args: {
  projectId: string; screenId: string; html: string; sourceKind: SourceKind; jobId?: string | null; lintReport: unknown;
  expectedRevisionId?: string | null; parentRevisionId?: string | null; candidateIndex?: number | null; advanceCurrent?: boolean;
}): Promise<RevisionRow | null> {
  const [screen] = await tx.select().from(schema.screens).where(eq(schema.screens.id, args.screenId)).for('update');
  if (!screen) return null;
  if (args.expectedRevisionId !== undefined && (screen.currentRevisionId ?? null) !== args.expectedRevisionId) return null;
  const [{ seq }] = await tx.select({ seq: sql<number>`coalesce(max(${schema.screenRevisions.seq}), 0) + 1` }).from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, args.screenId));
  const id = crypto.randomUUID();
  const htmlKey = objectKeys.revisionHtml(args.projectId, args.screenId, id);
  await storage.put(htmlKey, args.html, 'text/html; charset=utf-8');
  // 页内状态（ADR-041）：落修订时解析声明块与 data-when / data-s-* 写法；键与端上维度重名的页内那个不生效，偏离报告记一条
  const states = parseStates(extractBody(args.html));
  let lintReport = args.lintReport as LintReport;
  if (screen.surfaceId && (states.dims.length || states.events.length) && Array.isArray(lintReport?.violations)) {
    const [surface] = await tx.select({ states: schema.surfaces.states }).from(schema.surfaces).where(eq(schema.surfaces.id, screen.surfaceId));
    const shadowed = surface ? shadowedStateKeys(states, surface.states as SurfaceStates) : [];
    if (shadowed.length) lintReport = { ...lintReport, passed: false, violations: [...lintReport.violations, { rule: 'state-shadowed', message: `页内状态 ${shadowed.join('、')} 与端上的维度重名，页内这个不生效`, sample: shadowed.join(' ') }] };
  }
  const [rev] = await tx.insert(schema.screenRevisions).values({
    id, screenId: args.screenId, seq, htmlKey, sourceKind: args.sourceKind, jobId: args.jobId ?? null, lintReport: lintReport as object, states,
    parentRevisionId: args.parentRevisionId === undefined ? screen.currentRevisionId : args.parentRevisionId,
    candidateIndex: args.candidateIndex ?? null,
  }).returning();
  rememberRevisionLinks(id, args.html);
  if (args.advanceCurrent !== false) await tx.update(schema.screens).set({ currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(schema.screens.id, args.screenId));
  return rev;
}

// 回到旧版（API-CORE-015 / quilt.restore_revision 共用，v1.43 ADR-039）：只把 current 指回那一版，不建新修订，同采用候选。
// 那一版的整屏截图三条都成立才直接用（shots.ts canReuseShot）；已被 screenshot.prune 清掉的由调用方入队重拍，
// 按别的呈现方式或画框拍的先作废截图与缩略图（同 setDraftFrame），也由调用方重拍。读对象头在事务外，锁住屏行后再核一遍截图键：
// screenshot.prune 在同一把锁下清键
export async function restoreRevision(project: ProjectRow, screen: ScreenRow, target: RevisionRow, expectedRevisionId: string): Promise<RevisionRow> {
  const spec = shotSpecFor(project, screen);
  const head = target.screenshotKey ? await storage.get(target.screenshotKey).then(imageHead, () => null) : null;
  const usable = !!target.screenshotKey && canReuseShot({ key: target.screenshotKey, head }, screen.presentation, { ...spec.size, rootOnly: spec.rootOnly });
  return db.transaction(async (tx) => {
    if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
    const [locked] = await tx.select({ currentRevisionId: schema.screens.currentRevisionId, presentation: schema.screens.presentation, frame: schema.screens.frame })
      .from(schema.screens).where(eq(schema.screens.id, screen.id)).for('update');
    if (!locked || (locked.currentRevisionId ?? null) !== expectedRevisionId) throw problems.revisionConflict();
    let [rev] = await tx.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, target.id));
    const keep = usable && locked.presentation === screen.presentation && locked.frame === screen.frame && rev.screenshotKey === target.screenshotKey;
    if (!keep && rev.screenshotKey) [rev] = await tx.update(schema.screenRevisions).set({ screenshotKey: null, thumbKey: null }).where(eq(schema.screenRevisions.id, rev.id)).returning();
    await tx.update(schema.screens).set({ currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
    await deriveLinks(tx, project.id);
    return rev;
  });
}

// 候选批落完后把 current 指向序号最小的那一版（REQ-CORE-015：current 默认第 1 版，不选也不阻塞连线 / 导出）
// onlyIfCurrent：改屏候选只在 current 仍是这批的基线时才接管，用户在这之后自己写过就不顶掉
export async function pointCurrentToFirstCandidate(tx: Tx, screenId: string, jobId: string, onlyIfCurrent?: string): Promise<void> {
  const [first] = await tx.select({ id: schema.screenRevisions.id }).from(schema.screenRevisions)
    .where(and(eq(schema.screenRevisions.screenId, screenId), eq(schema.screenRevisions.jobId, jobId), isNotNull(schema.screenRevisions.candidateIndex)))
    .orderBy(schema.screenRevisions.candidateIndex).limit(1);
  if (first) await tx.update(schema.screens).set({ currentRevisionId: first.id, updatedAt: new Date() }).where(onlyIfCurrent ? and(eq(schema.screens.id, screenId), eq(schema.screens.currentRevisionId, onlyIfCurrent)) : eq(schema.screens.id, screenId));
}

// 采用候选（API-CORE-025）：只改 current 指针、结清同批；current 已不属同批（用户在某版上继续改了）则拒绝，不顶掉他的改动。
// 「同批」按事务里锁住的屏行判（v0.77）：调用方手里的屏行是事务外读的，回溯 / 直改 / 回写在那之后提交的话，拿它判会把用户刚落的修订顶掉
export async function adoptCandidate(tx: Tx, screen: ScreenRow, revisionId: string): Promise<void> {
  const [rev] = await tx.select().from(schema.screenRevisions).where(and(eq(schema.screenRevisions.id, revisionId), eq(schema.screenRevisions.screenId, screen.id)));
  if (!rev || rev.candidateIndex === null || !rev.jobId) throw problems.notFound();
  const [locked] = await tx.select({ currentRevisionId: schema.screens.currentRevisionId }).from(schema.screens).where(eq(schema.screens.id, screen.id)).for('update');
  if (!locked) throw problems.notFound();
  const [cur] = locked.currentRevisionId ? await tx.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, locked.currentRevisionId)) : [];
  if (!cur || cur.jobId !== rev.jobId || cur.candidateIndex === null) throw problems.revisionConflict();
  if (await hasActiveJob(tx, screen.projectId, screen.id)) throw problems.screenBusy();
  await tx.update(schema.screens).set({ currentRevisionId: rev.id, updatedAt: new Date() }).where(eq(schema.screens.id, screen.id));
  await tx.update(schema.screenRevisions).set({ candidateSettledAt: new Date() }).where(and(eq(schema.screenRevisions.screenId, screen.id), eq(schema.screenRevisions.jobId, rev.jobId)));
}

// 候选就地展开的数据（API-CORE-026）：按屏分组、按 candidateIndex 排版；每版带预览 URL，展开层里每格是活 iframe
export async function listCandidates(project: ProjectRow, jobId: string): Promise<CandidatesDto> {
  const rows = await db.select({ r: schema.screenRevisions, s: schema.screens, device: schema.surfaces.deviceType }).from(schema.screenRevisions)
    .innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .leftJoin(schema.surfaces, eq(schema.surfaces.id, schema.screens.surfaceId))
    .where(and(eq(schema.screenRevisions.jobId, jobId), isNotNull(schema.screenRevisions.candidateIndex), eq(schema.screens.projectId, project.id)))
    .orderBy(schema.screens.createdAt, schema.screenRevisions.candidateIndex);
  // 视口按屏所在端的设备（REQ-CORE-049）
  const size = DEVICE_SIZE[(rows[0]?.device ?? project.deviceType) as DeviceType];
  const byScreen = new Map<string, CandidatesDto['screens'][number]>();
  const previewToken = signPreview(project.id, stableExpiry(config.previewTokenMinutes));
  let versions = 0;
  for (const { r, s } of rows) {
    if (!byScreen.has(s.id)) byScreen.set(s.id, { screenId: s.id, name: s.name, route: s.route, width: size.w, height: size.h, currentRevisionId: s.currentRevisionId, settled: false, revisions: [] });
    const e = byScreen.get(s.id)!;
    e.revisions.push({ id: r.id, index: r.candidateIndex!, seq: r.seq, screenshotUrl: r.screenshotKey ? await storage.signedUrl(r.screenshotKey) : null, thumbUrl: r.thumbKey ? await storage.signedUrl(r.thumbKey) : null, htmlUrl: await storage.signedUrl(r.htmlKey), previewUrl: `${config.previewOrigin}/p/${project.id}/${s.id}?rev=${r.id}&t=${previewToken}` });
    if (r.candidateSettledAt) e.settled = true;
    versions = Math.max(versions, r.candidateIndex! + 1);
  }
  return { jobId, versions, screens: [...byScreen.values()] };
}

// 修订的链接与组件名（§28 v1.05）：修订不可变，解析一次按 id 记在进程内，不用失效。落修订时当场记下（手里正好有 HTML），
// deriveLinks 在事务里只为没记过的修订（进程刚起时）读对象、解析，其余只剩 SQL。上限 20000 张，满了整体清空重来
type RevisionLinks = { links: { qid: string; href: string }[]; names: string[] };
const linksByRevision = new Map<string, RevisionLinks>();
function rememberRevisionLinks(revisionId: string, html: string): RevisionLinks {
  const body = extractBody(html);
  const parsed = { links: extractLinks(body).map((l) => ({ qid: l.qid, href: l.href })), names: [...componentNamesIn(body)] };
  if (linksByRevision.size >= 20_000) linksByRevision.clear();
  linksByRevision.set(revisionId, parsed);
  return parsed;
}

// 应用地图派生（ADR-008 / REQ-PROTO-002）：扫全部屏当前修订的链接，按 route 匹配。
// 顺手重算哪些屏放着哪个共享组件（REQ-EDIT-006 component_uses）：同一趟读 HTML，不另跑一遍
export async function deriveLinks(tx: Tx, projectId: string): Promise<void> {
  const screens = await tx.select().from(schema.screens).where(eq(schema.screens.projectId, projectId));
  // 路由只解析到默认屏（v0.62 REQ-CORE-025）：变体与默认屏同路由，播放与地图都指向默认屏；变体自己发出的链接照常入图。
  // 链接只连同一端里的屏（REQ-CORE-049）：路由只在一端里不重复，另一端的同名路由不是去处
  const at = (surfaceId: string | null, route: string) => `${surfaceId ?? ''}|${route}`;
  const byRoute = new Map(screens.filter((s) => !s.variantOf).map((s) => [at(s.surfaceId, s.route), s.id]));
  const surfaceOf = new Map(screens.map((s) => [s.id, s.surfaceId]));
  const revIds = screens.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length ? await tx.select().from(schema.screenRevisions).where(inArray(schema.screenRevisions.id, revIds)) : [];
  const rows: (typeof schema.links.$inferInsert)[] = [];
  const uses: (typeof schema.componentUses.$inferInsert)[] = [];
  for (const rev of revs) {
    const { links, names } = linksByRevision.get(rev.id) ?? rememberRevisionLinks(rev.id, (await storage.get(rev.htmlKey)).toString('utf8'));
    for (const l of links) rows.push({ projectId, fromScreenId: rev.screenId, elementQid: l.qid, href: l.href, toScreenId: byRoute.get(at(surfaceOf.get(rev.screenId) ?? null, l.href)) ?? null });
    for (const name of names) uses.push({ projectId, screenId: rev.screenId, name });
  }
  // 按内容差量写（v1.29）：没变的行原样留着。此前每次整项目删光重插，表一直膨胀（外部 Postgres 的自动清理只复用空间、不缩表）
  const L = schema.links;
  const links = diffRows(await tx.select({ id: L.id, projectId: L.projectId, fromScreenId: L.fromScreenId, elementQid: L.elementQid, href: L.href, toScreenId: L.toScreenId }).from(L).where(eq(L.projectId, projectId)),
    rows, (r) => [r.fromScreenId, r.elementQid, r.href, r.toScreenId ?? ''].join('\n'));
  if (links.drop.length) await tx.delete(L).where(inArray(L.id, links.drop));
  if (links.add.length) await tx.insert(L).values(links.add);
  const U = schema.componentUses;
  const used = diffRows(await tx.select({ id: U.id, projectId: U.projectId, screenId: U.screenId, name: U.name }).from(U).where(eq(U.projectId, projectId)),
    uses, (r) => `${r.screenId}\n${r.name}`);
  if (used.drop.length) await tx.delete(U).where(inArray(U.id, used.drop));
  if (used.add.length) await tx.insert(U).values(used.add);
}

export async function listRevisions(screenId: string): Promise<RevisionDto[]> {
  const rows = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, screenId)).orderBy(desc(schema.screenRevisions.seq));
  return Promise.all(rows.map(revisionDto));
}

export async function revisionDto(r: RevisionRow): Promise<RevisionDto> {
  return {
    id: r.id, screenId: r.screenId, seq: r.seq, sourceKind: r.sourceKind as SourceKind, jobId: r.jobId,
    parentRevisionId: r.parentRevisionId, candidateIndex: r.candidateIndex, candidateSettledAt: r.candidateSettledAt?.toISOString() ?? null,
    htmlUrl: await storage.signedUrl(r.htmlKey), screenshotUrl: r.screenshotKey ? await storage.signedUrl(r.screenshotKey) : null, thumbUrl: r.thumbKey ? await storage.signedUrl(r.thumbKey) : null, lintReport: r.lintReport, createdAt: r.createdAt.toISOString(),
  };
}

export async function getRevision(screenId: string, revisionId: string): Promise<RevisionRow> {
  const [r] = await db.select().from(schema.screenRevisions).where(and(eq(schema.screenRevisions.id, revisionId), eq(schema.screenRevisions.screenId, screenId)));
  if (!r) throw problems.notFound();
  return r;
}

// 屏级历史指令（ADR-012 v0.87）：取这屏的修订树与树上出现过的作业，由 screenInstructionHistory 沿 current 的父链选、截、排。
// 按祖先链而不是时间序——回溯掉的分支上的指令不该再带进来
export async function priorInstructions(screenId: string, currentRevisionId: string | null): Promise<string[]> {
  if (!currentRevisionId) return [];
  const revs = await db.select({ id: schema.screenRevisions.id, parentRevisionId: schema.screenRevisions.parentRevisionId, jobId: schema.screenRevisions.jobId }).from(schema.screenRevisions).where(eq(schema.screenRevisions.screenId, screenId));
  const jobIds = Array.from(new Set(revs.map((r) => r.jobId).filter((j): j is string => !!j)));
  const jobs = jobIds.length ? await db.select({ id: schema.generationJobs.id, kind: schema.generationJobs.kind, input: schema.generationJobs.input }).from(schema.generationJobs).where(inArray(schema.generationJobs.id, jobIds)) : [];
  return screenInstructionHistory(currentRevisionId, revs, jobs);
}

// 样板屏（REQ-CORE-016）：projects.exemplarScreenId 的 current；没钦定或已删则回落到最早一张 lint 通过的屏
export async function exemplarBody(project: ProjectRow): Promise<{ screenId: string; body: string } | null> {
  if (project.exemplarScreenId) {
    const [s] = await db.select().from(schema.screens).where(and(eq(schema.screens.id, project.exemplarScreenId), eq(schema.screens.projectId, project.id)));
    if (s?.currentRevisionId) {
      const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
      if (rev) return { screenId: s.id, body: extractBody((await storage.get(rev.htmlKey)).toString('utf8')) };
    }
  }
  // 没钦定时取最早建的那张整屏（默认屏、非叠层）的当前版：偏离只是透镜（v0.43），用了图表库或越出 token 的屏同样可以当风格参照
  const [row] = await db.select({ htmlKey: schema.screenRevisions.htmlKey, screenId: schema.screenRevisions.screenId })
    .from(schema.screens).innerJoin(schema.screenRevisions, eq(schema.screenRevisions.id, schema.screens.currentRevisionId))
    .where(and(eq(schema.screens.projectId, project.id), isNull(schema.screens.variantOf), eq(schema.screens.presentation, 'push')))
    .orderBy(schema.screens.createdAt).limit(1);
  if (!row) return null;
  return { screenId: row.screenId, body: extractBody((await storage.get(row.htmlKey)).toString('utf8')) };
}

export async function currentBody(screenId: string): Promise<string | null> {
  const [s] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
  if (!s?.currentRevisionId) return null;
  const [rev] = await db.select().from(schema.screenRevisions).where(eq(schema.screenRevisions.id, s.currentRevisionId));
  return rev ? extractBody((await storage.get(rev.htmlKey)).toString('utf8')) : null;
}

// 项目大纲（REQ-CORE-023 / quilt.get_outline）：每屏当前修订 body 的结构摘要，确定性、零 LLM
export async function projectOutline(ownerId: string, projectId: string, screenIds?: string[]) {
  const project = await ownedProject(ownerId, projectId);
  const rows = (await db.select().from(schema.screens).where(eq(schema.screens.projectId, project.id)).orderBy(schema.screens.createdAt)).filter((s) => !screenIds || screenIds.includes(s.id));
  // 一次取齐全部 current 修订、并行读 HTML：聊天助手每轮都先看大纲，100 屏的项目逐屏串行查两次库再读一次文件要好几秒
  const revIds = rows.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length ? await db.select({ id: schema.screenRevisions.id, htmlKey: schema.screenRevisions.htmlKey }).from(schema.screenRevisions).where(inArray(schema.screenRevisions.id, revIds)) : [];
  const keyOf = new Map(revs.map((r) => [r.id, r.htmlKey]));
  const screens = await Promise.all(rows.map(async (s) => {
    const key = s.currentRevisionId ? keyOf.get(s.currentRevisionId) : undefined;
    const body = key ? extractBody((await storage.get(key)).toString('utf8')) : null;
    return { screenId: s.id, name: s.name, route: s.route, purpose: s.purpose, variantOf: s.variantOf, variantName: s.variantName, presentation: s.presentation, currentRevisionId: s.currentRevisionId, outline: body ? outlineBody(body) : '(no revision yet)' };
  }));
  return { projectId: project.id, screens };
}

// 删屏（API-CORE-018 / quilt.delete_screen 共用）：默认屏连同它的变体一起删（外键级联），所以在跑作业要按整个家族查，
// 样板屏指针对每一张都清；库里删完再删对象存储里这些屏的修订 HTML 与截图——不删的话它们一直留到整个项目被删。
// 使用记录开着时（ADR-035）删之前取下这些屏与修订的行，删掉之后、清对象之前写进归档；被 409 挡下的不留归档
export async function deleteScreen(projectId: string, screenId: string): Promise<void> {
  const family = (await db.select({ id: schema.screens.id }).from(schema.screens).where(or(eq(schema.screens.id, screenId), eq(schema.screens.variantOf, screenId)))).map((r) => r.id);
  const archive = await archiveScreen(projectId, screenId, family);
  await db.transaction(async (tx) => {
    for (const id of family) if (await hasActiveJob(tx, projectId, id)) throw problems.screenBusy();
    await tx.delete(schema.screens).where(eq(schema.screens.id, screenId));
    for (const id of family) await clearExemplarIfDeleted(tx, projectId, id);
    await deriveLinks(tx, projectId);
  });
  await saveArchive(archive);
  for (const id of family) await storage.deletePrefix(`projects/${projectId}/screens/${id}/`).catch((e) => console.warn(`[delete screen] ${id}: ${(e as Error).message}`));
  await notifyCanvas(projectId, { reason: 'deleted', screenId });
}

// 截图写回（§16 v0.77）：渲染要几秒，期间屏或整个项目可能已被删、对象前缀已清过。先写对象再按修订行条件回填，
// 行已不在就清掉这一屏（项目也不在了就清整个项目）的前缀——否则刚写的 PNG 没有任何行指向它，再也没人清。返回 null = 屏已删。
// 缩略图（v1.02 ADR-029）随截图一起写、同一条 UPDATE 回填；做不出来只回填截图，留给 screenshot.retry 补。
// 回填是条件更新（§16 v1.03）：截图还空着、且屏的呈现方式仍是拍摄时那一个；拍的途中切了呈现方式，这两张图就作废。
// 草稿的画框（REQ-CORE-040）同理：拍的途中改了画框（PATCH frame 已作废截图），按旧画框拍的这张不能落库，否则随后的重拍见已有截图就退出。
// 浏览器拍的是 PNG，存成无损 WebP（v1.27 ADR-037）；缩略图照旧从 PNG 缩
export async function storeRevisionShot(projectId: string, screenId: string, revisionId: string, png: Buffer, presentation: Presentation = 'push', frame: string | null = null): Promise<string | null> {
  const key = objectKeys.revisionShot(projectId, screenId, revisionId, presentation, frame);
  await storage.put(key, await losslessWebp(png), 'image/webp');
  const thumbKey = await storeThumb(projectId, screenId, revisionId, png, presentation, frame).catch((e: Error) => { console.warn(`[thumbnail] ${revisionId}: ${e.message}`); return null; });
  const sameFrame = frame ? sql`${schema.screens.frame} = ${frame}` : sql`${schema.screens.frame} is null`;
  const rows = await db.update(schema.screenRevisions).set({ screenshotKey: key, thumbKey })
    .where(and(eq(schema.screenRevisions.id, revisionId), isNull(schema.screenRevisions.screenshotKey),
      sql`exists (select 1 from ${schema.screens} where ${schema.screens.id} = ${schema.screenRevisions.screenId} and ${schema.screens.presentation} = ${presentation} and ${sameFrame})`))
    .returning({ id: schema.screenRevisions.id });
  if (rows.length) return key;
  const [rev] = await db.select({ screenshotKey: schema.screenRevisions.screenshotKey }).from(schema.screenRevisions).where(eq(schema.screenRevisions.id, revisionId));
  if (rev) {
    // 行还在：别处已按同一呈现方式（与画框）写过同一个键就算成了；否则刚写的是按过期的呈现方式或画框拍的。
    // 同名的对象可能正被 v1.43 之前回到旧版建的修订共用（重拍被清掉截图的旧版时键不变），还有修订引用就不删
    if (rev.screenshotKey === key) return key;
    await deleteUnreferenced([key, thumbKey]);
    return null;
  }
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  await storage.deletePrefix(project ? `projects/${projectId}/screens/${screenId}/` : `projects/${projectId}/`).catch(() => {});
  return null;
}

// 没有任何修订再引用（截图或缩略图）的对象才删：v1.43 之前回到旧版建的修订与源修订共用对象（v1.27 ADR-037）
export async function deleteUnreferenced(keys: (string | null)[]): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    const [used] = await db.select({ id: schema.screenRevisions.id }).from(schema.screenRevisions).where(or(eq(schema.screenRevisions.screenshotKey, key), eq(schema.screenRevisions.thumbKey, key))).limit(1);
    if (!used) await storage.delete(key).catch(() => {});
  }
}

export async function storeThumb(projectId: string, screenId: string, revisionId: string, png: Buffer, presentation: Presentation = 'push', frame: string | null = null): Promise<string> {
  const key = objectKeys.revisionThumb(projectId, screenId, revisionId, presentation, frame);
  await storage.put(key, await thumbnailOf(png), 'image/webp');
  return key;
}

// 呈现方式（v0.63）是整个家族的：变体是同一屏的另一个状态，播放按默认屏的路由找屏，所以默认屏改了变体跟着改。
// 截图按呈现方式拍（整屏不透明、叠层透明底），家族里每屏当前修订的截图作废，返回要重拍的修订由调用方在事务外入队
export async function setFamilyPresentation(tx: Tx, screenId: string, presentation: Presentation): Promise<string[]> {
  const rows = await tx.update(schema.screens).set({ presentation, updatedAt: new Date() }).where(or(eq(schema.screens.id, screenId), eq(schema.screens.variantOf, screenId))).returning({ rev: schema.screens.currentRevisionId });
  const revs = rows.map((r) => r.rev).filter((r): r is string => !!r);
  if (revs.length) await tx.update(schema.screenRevisions).set({ screenshotKey: null, thumbKey: null }).where(inArray(schema.screenRevisions.id, revs));
  return revs;
}

// 画框（REQ-CORE-040）只在草稿上有、是元数据：改它不建修订；当前修订的截图是按旧画框拍的，作废后由调用方在事务外重拍
export async function setDraftFrame(tx: Tx, screenId: string, frame: DraftFrame): Promise<string[]> {
  const rows = await tx.update(schema.screens).set({ frame, updatedAt: new Date() }).where(eq(schema.screens.id, screenId)).returning({ rev: schema.screens.currentRevisionId });
  const revs = rows.map((r) => r.rev).filter((r): r is string => !!r);
  if (revs.length) await tx.update(schema.screenRevisions).set({ screenshotKey: null, thumbKey: null }).where(inArray(schema.screenRevisions.id, revs));
  return revs;
}

// 删屏时样板屏指针要跟着清（不建外键）
export async function clearExemplarIfDeleted(tx: Tx, projectId: string, screenId: string): Promise<void> {
  await tx.update(schema.projects).set({ exemplarScreenId: null }).where(and(eq(schema.projects.id, projectId), eq(schema.projects.exemplarScreenId, screenId)));
}

export const noSettledCandidates = isNull(schema.screenRevisions.candidateSettledAt);
