import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { COLOR_MODES, FONT_SOURCES, MAX_CONVENTIONS, fontFamilySchema, fontUrlSchema, paletteSchema, type ColorMode, type FontSource, type Palette } from '@quilt/core';
import { db, schema } from '../../db/client.ts';
import { createJob } from '../../services/jobs.ts';
import { ownedProject, jobDto, designSystemDto } from '../../services/projects.ts';
import { designContract } from '../../services/ingest.ts';
import { updateDesignSystem } from '../../services/edit.ts';
import { listPresets, createPreset, deletePreset, applyPreset } from '../../services/presets.ts';
import type { ToolCtx } from '../ctx.ts';

// 设计系统：契约（读）、改设计系统、设计预设（账号级，跨项目复用一套视觉，API-CORE-033）
export function registerDesignTools(c: ToolCtx) {
  const { server, user, wrap, read, write, idem, requestId, runJob } = c;

  server.registerTool('quilt.get_design_contract', {
    description: 'Machine-checkable design contract: tokens, allowed color classes, component recipes, shared components (place them by reference — see sharedComponents[].placement), rules, routes, DESIGN.md.',
    inputSchema: { projectId: z.string().uuid() },
  }, wrap(async (a) => {
    read();
    return designContract(user.id, a.projectId as string);
  }));

  // 改设计系统（v0.42）：此前 MCP 只能读契约——本机 agent 按截图手写了 42 屏却没法让画布的色板对齐真机，
  // 严格契约换来的「改一次 token、全部屏跟着变」在 MCP 侧根本兑现不了。applyToScreens 顺带发一次确定性回刷（零模型调用）
  server.registerTool('quilt.update_design_system', {
    description: 'Change this project\'s design system: seed color, font (fontFamily + fontSource google|system|url; fontUrl = an https stylesheet with @font-face when fontSource is url), radius scale, brand palette (exact hex per token key), color mode, DESIGN.md. Pass expectedVersion from quilt.get_design_contract. applyToScreens=true also re-bakes every existing screen with the new tokens (deterministic, no model calls) and returns the job.',
    inputSchema: {
      projectId: z.string().uuid(),
      expectedVersion: z.number().int().min(1),
      seedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      fontFamily: fontFamilySchema.optional(),
      fontSource: z.enum(FONT_SOURCES).optional(),
      fontUrl: fontUrlSchema.nullable().optional(),
      radiusScale: z.enum(['sharp', 'default', 'round']).optional(),
      palette: paletteSchema.nullable().optional(),
      colorMode: z.enum(COLOR_MODES).optional(),
      designMd: z.string().max(20000).optional(),
      // 约定节整体替换（v0.51）：quilt.propose_design_system 的产出经 agent 确认后从这里写回
      conventions: z.array(z.string().trim().min(1).max(300)).max(MAX_CONVENTIONS).optional(),
      applyToScreens: z.boolean().optional(),
    },
  }, wrap(async (a) => {
    write();
    const designSystem = await updateDesignSystem(user.id, a.projectId as string, {
      expectedVersion: a.expectedVersion as number,
      seedColor: a.seedColor as string | undefined,
      fontFamily: a.fontFamily as string | undefined,
      fontSource: a.fontSource as FontSource | undefined,
      fontUrl: a.fontUrl as string | null | undefined,
      radiusScale: a.radiusScale as 'sharp' | 'default' | 'round' | undefined,
      palette: a.palette as Palette | null | undefined,
      colorMode: a.colorMode as ColorMode | undefined,
      designMd: a.designMd as string | undefined,
      conventions: a.conventions as string[] | undefined,
    });
    if (!a.applyToScreens) return { designSystem, job: null };
    const r = await createJob({ user, projectId: a.projectId as string, input: { kind: 'apply_design_system', input: { screenIds: 'all' } }, idempotencyKey: idem(), requestId });
    return { designSystem, job: jobDto(r.job) };
  }));

  server.registerTool('quilt.list_design_presets', {
    description: 'Account-level design presets (seed color, font, radius, palette, DESIGN.md, asset copies) reusable across projects.',
  }, wrap(async () => {
    read();
    return { items: await listPresets(user.id) };
  }));

  server.registerTool('quilt.create_design_preset', {
    description: 'Snapshot a project\'s design system (its inputs, not computed tokens) as a preset; includeAssets (default true) copies its assets too.',
    inputSchema: { projectId: z.string().uuid(), name: z.string().trim().min(1).max(80), includeAssets: z.boolean().optional() },
  }, wrap(async (a) => {
    write();
    return { preset: await createPreset(user.id, { projectId: a.projectId as string, name: a.name as string, includeAssets: a.includeAssets as boolean | undefined }) };
  }));

  server.registerTool('quilt.apply_design_preset', {
    description: 'Write a preset into a project\'s design system (tokens recomputed, preset assets copied in as new assets). expectedVersion from quilt.get_design_contract (409 version-conflict when stale); applyToScreens=true also re-bakes every screen and returns that job.',
    inputSchema: { projectId: z.string().uuid(), presetId: z.string().uuid(), expectedVersion: z.number().int().min(1), applyToScreens: z.boolean().optional() },
  }, wrap(async (a) => {
    write();
    const project = await ownedProject(user.id, a.projectId as string);
    const { assetsCopied, skipped } = await applyPreset(user.id, project.id, { presetId: a.presetId as string, expectedVersion: a.expectedVersion as number });
    const [ds] = await db.select().from(schema.designSystems).where(eq(schema.designSystems.projectId, project.id));
    const job = a.applyToScreens ? await runJob(project.id, { kind: 'apply_design_system', input: { screenIds: 'all' } }) : null;
    return { designSystem: designSystemDto(ds), assetsCopied, skipped, job };
  }));

  server.registerTool('quilt.delete_design_preset', {
    description: 'Delete a preset (projects that already applied it are unaffected).',
    inputSchema: { presetId: z.string().uuid() },
  }, wrap(async (a) => {
    write();
    await deletePreset(user.id, a.presetId as string);
    return { presetId: a.presetId, deleted: true };
  }));
}
