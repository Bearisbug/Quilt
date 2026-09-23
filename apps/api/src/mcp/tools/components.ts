import { z } from 'zod';
import { MAX_COMPONENT_HTML_BYTES, componentNameSchema } from '@quilt/core';
import { createComponent, updateComponent, deleteComponent } from '../../services/components.ts';
import type { ToolCtx } from '../ctx.ts';

// 共享组件（v0.46 REQ-EDIT-006）：本机 agent 也能建 / 改 / 删项目级组件；改完所有用它的屏确定性回刷（零模型调用）
export function registerComponentTools(c: ToolCtx) {
  const { server, user, wrap, write } = c;

  server.registerTool('quilt.create_component', {
    description: 'Create a shared component: a project-level HTML fragment (tab bar, app bar, sidebar, footer…) that screens place by reference with <tag data-component="Name"></tag> and Quilt fills in on every write. html = one root element, no <script>/<style>; per-screen content goes in data-slot="…" elements; for navigation, write every item as <a href="/route">, mark the current one with aria-current="page" and give it at least one class the others do not have (e.g. text-primary vs text-on-surface-variant) — Quilt then treats it as navigation (nav: true in the result) and moves that highlight to the right item on every screen; with no class difference nav is false and every screen shows the same item highlighted. Returns the component (see quilt.get_design_contract → sharedComponents for placement).',
    inputSchema: { projectId: z.string().uuid(), name: componentNameSchema, html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES) },
  }, wrap(async (a) => {
    write();
    return createComponent(user.id, a.projectId as string, { name: a.name as string, html: a.html as string });
  }));

  server.registerTool('quilt.update_component', {
    description: 'Replace a shared component\'s HTML (and/or rename it). Every screen that places it is re-baked deterministically — returns applied (screen ids) and skipped (screens with a running job; they pick up the new version when that job lands). expectedVersion comes from sharedComponents[] in quilt.get_design_contract; 409 version-conflict when stale.',
    inputSchema: { componentId: z.string().uuid(), html: z.string().min(1).max(MAX_COMPONENT_HTML_BYTES).optional(), name: componentNameSchema.optional(), expectedVersion: z.number().int().min(1) },
  }, wrap(async (a) => {
    write();
    return updateComponent(user.id, a.componentId as string, { html: a.html as string | undefined, name: a.name as string | undefined, expectedVersion: a.expectedVersion as number });
  }));

  server.registerTool('quilt.delete_component', {
    description: 'Delete a shared component. Screens keep the HTML already expanded in them; it just stops following the component.',
    inputSchema: { componentId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    await deleteComponent(user.id, a.componentId as string);
    return { componentId: a.componentId, deleted: true };
  }));
}
