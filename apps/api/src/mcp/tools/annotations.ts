import { z } from 'zod';
import { ANNOTATION_STATUSES } from '@quilt/core';
import { problems } from '../../lib/errors.ts';
import { ownedProject, jobDto } from '../../services/projects.ts';
import * as annotations from '../../services/annotations.ts';
import type { ToolCtx } from '../ctx.ts';

// 批注（API-EDIT-003）：列 / 改 / 删 / 发送；不提供建——气泡 rect 要在画布里量，agent 给不出
export function registerAnnotationTools(c: ToolCtx) {
  const { server, user, wrap, read, write, requestId } = c;

  server.registerTool('quilt.list_annotations', {
    description: 'Element annotations the user left on screens. With screenId: every annotation of that screen (any status); with projectId only: the unresolved ones (open | sent) across the project.',
    inputSchema: { projectId: z.string().uuid(), screenId: z.string().uuid().optional() },
  }, wrap(async (a) => {
    read();
    const project = await ownedProject(user.id, a.projectId as string);
    return { items: a.screenId ? await annotations.listForScreen(user.id, a.screenId as string) : await annotations.listOpenForProject(project.id) };
  }));

  server.registerTool('quilt.update_annotation', {
    description: 'Edit an annotation\'s note or status (open | sent | resolved) — e.g. mark it resolved after you applied it yourself.',
    inputSchema: { annotationId: z.string().uuid(), note: z.string().trim().min(1).max(2000).optional(), status: z.enum(ANNOTATION_STATUSES).optional() },
  }, wrap(async (a) => {
    write();
    if (a.note === undefined && a.status === undefined) throw problems.validation([{ path: 'note', message: 'note or status required' }]);
    return { annotation: await annotations.update(user.id, a.annotationId as string, { note: a.note as string | undefined, status: a.status as string | undefined }) };
  }));

  server.registerTool('quilt.delete_annotation', {
    description: 'Delete an annotation.',
    inputSchema: { annotationId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    await annotations.remove(user.id, a.annotationId as string);
    return { annotationId: a.annotationId, deleted: true };
  }));

  server.registerTool('quilt.send_annotations', {
    description: 'Send annotations to the server-side model: one edit_screens job per screen; they become sent, then resolved when the job succeeds.',
    inputSchema: { projectId: z.string().uuid(), annotationIds: z.array(z.string().uuid()).min(1).max(50) },
  }, wrap(async (a) => {
    write();
    const { jobs } = await annotations.send(user, a.projectId as string, a.annotationIds as string[], requestId);
    return { jobs: jobs.map(jobDto) };
  }));
}
