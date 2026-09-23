import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { MAX_VERSIONS, extractBody } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { Problem, problems } from '../../lib/errors.ts';
import { storage } from '../../lib/storage.ts';
import { ownedJob, enqueueScreenshot } from '../../services/jobs.ts';
import { ownedProject } from '../../services/projects.ts';
import { ownedScreen, getRevision, listRevisions, hasActiveJob, createRevision, deriveLinks, revisionDto, adoptCandidate, listCandidates } from '../../services/screens.ts';
import type { ToolCtx } from '../ctx.ts';

// 修订：列 / 取旧版 HTML（直接给文本，agent 拿到就能重推）/ 回溯 / 列候选 / 采用候选——API-CORE-014 / 015 / 025 / 026
export function registerRevisionTools(c: ToolCtx) {
  const { server, user, wrap, read, write } = c;

  server.registerTool('quilt.list_revisions', {
    description: 'Revisions of a screen (newest first) with parentRevisionId and candidateIndex — candidates of one job are siblings; the screen\'s current revision is in quilt.get_project.',
    inputSchema: { screenId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    return listRevisions(screen.id);
  }));

  server.registerTool('quilt.get_revision', {
    description: 'One revision of a screen: metadata (seq, parentRevisionId, candidateIndex, lintReport) plus its body HTML — enough to push it back with quilt.update_screen.',
    inputSchema: { screenId: z.string().uuid(), revisionId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const { screen } = await ownedScreen(user.id, a.screenId as string);
    const rev = await getRevision(screen.id, a.revisionId as string);
    return { revision: await revisionDto(rev), html: extractBody((await storage.get(rev.htmlKey)).toString('utf8')) };
  }));

  server.registerTool('quilt.restore_revision', {
    description: 'Roll a screen back to an earlier revision: creates a new revision (source_kind=restore) with that content and makes it current. expectedRevisionId must be the screen\'s current revision (409 revision-conflict otherwise); 409 screen-busy while a job runs on it.',
    inputSchema: { screenId: z.string().uuid(), revisionId: z.string().uuid(), expectedRevisionId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    const { screen, project } = await ownedScreen(user.id, a.screenId as string);
    const source = await getRevision(screen.id, a.revisionId as string);
    const html = (await storage.get(source.htmlKey)).toString('utf8');
    const rev = await db.transaction(async (tx) => {
      if (await hasActiveJob(tx, project.id, screen.id)) throw problems.screenBusy();
      const r = await createRevision(tx, { projectId: project.id, screenId: screen.id, html, sourceKind: 'restore', lintReport: source.lintReport, expectedRevisionId: a.expectedRevisionId as string });
      if (!r) throw problems.revisionConflict();
      if (source.screenshotKey) await tx.update(schema.screenRevisions).set({ screenshotKey: source.screenshotKey }).where(eq(schema.screenRevisions.id, r.id));
      await deriveLinks(tx, project.id);
      return { ...r, screenshotKey: source.screenshotKey };
    });
    if (!rev.screenshotKey) await enqueueScreenshot(rev.id);
    return { revision: await revisionDto(rev) };
  }));

  server.registerTool('quilt.list_candidates', {
    description: 'Candidate revisions a job produced, grouped by screen (index = version number, settled = a version was adopted).',
    inputSchema: { jobId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    const job = await ownedJob(user.id, a.jobId as string);
    return listCandidates(await ownedProject(user.id, job.projectId), job.id);
  }));

  // 采用候选（v0.60 合并了单屏 adopt_candidate 与整批 adopt_candidates）：按作业 + 版号寻址，screenId 缺省 = 该作业出过候选的每一屏。
  // 逐屏成败：没有那一版、被改过（revision-conflict）、正忙（screen-busy）的进 skipped 并带错误码，其余照常采用——不是全有或全无
  server.registerTool('quilt.adopt_candidate', {
    description: 'Adopt candidate version `index` (0-based, from quilt.list_candidates) as the current version and settle its batch (no new revision, no model call). Without screenId: on every screen the job produced candidates for. Per-screen success — skipped[] lists screens that had no such version, were edited since (revision-conflict) or are busy (screen-busy); read adopted/skipped, do not treat the call as all-or-nothing.',
    inputSchema: { jobId: z.string().uuid(), index: z.number().int().min(0).max(MAX_VERSIONS - 1), screenId: z.string().uuid().optional() },
  }, wrap(async (a) => {
    write();
    const job = await ownedJob(user.id, a.jobId as string);
    const project = await ownedProject(user.id, job.projectId);
    const cands = await listCandidates(project, job.id);
    const only = a.screenId as string | undefined;
    if (only && !cands.screens.some((s) => s.screenId === only)) throw new Problem(404, '/errors/not-found', 'this job produced no candidates for that screen');
    const adopted: string[] = [];
    const skipped: { screenId: string; error: string }[] = [];
    for (const s of cands.screens) {
      if (only && s.screenId !== only) continue;
      const rev = s.revisions.find((r) => r.index === a.index);
      const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, s.screenId));
      if (!rev || !screen) { skipped.push({ screenId: s.screenId, error: '/errors/not-found' }); continue; }
      try { await db.transaction((tx) => adoptCandidate(tx, screen, rev.id)); adopted.push(s.screenId); }
      catch (e) { if (e instanceof Problem) skipped.push({ screenId: s.screenId, error: e.type }); else throw e; }
    }
    if (adopted.length) await db.transaction((tx) => deriveLinks(tx, project.id));
    return { adopted, skipped };
  }));
}
