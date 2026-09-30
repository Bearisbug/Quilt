import { parseConventions, withConventions, type DesignSystemDto, type FontSource, type ProjectDto, type Tokens } from '@quilt/core';
import { RADIUS } from './designOptions';

// 面板里能改的各格与它们的已保存值（REQ-EDIT-003 / REQ-EDIT-005 / REQ-CORE-016）
export type Fields = { seed: string; font: string; fontSource: FontSource; fontUrl: string; radius: 'sharp' | 'default' | 'round'; md: string; palette: DesignSystemDto['palette']; colorMode: DesignSystemDto['colorMode']; brief: string };
// 「保存」管的这几格：保存成功后以服务端回来的值为准（种子色会被转成大写等），不再当草稿留着
export const SAVE_KEYS: (keyof Fields)[] = ['seed', 'font', 'fontSource', 'fontUrl', 'radius', 'md', 'palette', 'colorMode'];
export const savedFields = (ds: DesignSystemDto, project: ProjectDto): Fields => {
  const t = ds.tokens as Tokens;
  return { seed: ds.seedColor, font: t.typography.fontFamily, fontSource: t.typography.fontSource ?? 'google', fontUrl: t.typography.fontUrl ?? '', radius: RADIUS.find((r) => r.md === t.radius.md)?.key ?? 'default', md: ds.designMd, palette: ds.palette, colorMode: ds.colorMode, brief: project.brief };
};
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// 已保存的那份从 prev 变成 next（删约定、确认提案、别处保存）：没动过的格子跟上 next，动过的留着草稿；
// DESIGN.md 草稿里的约定节只由系统维护，换成 next 的——不换的话保存草稿会把刚删掉的约定写回去
export function rebase(form: Fields, prev: Fields, next: Fields, force: (keyof Fields)[]): Fields {
  const out: Record<string, unknown> = { ...form };
  for (const k of Object.keys(next) as (keyof Fields)[]) if (force.includes(k) || same(form[k], prev[k])) out[k] = next[k];
  if (!force.includes('md') && form.md !== prev.md && !same(parseConventions(prev.md), parseConventions(next.md))) out.md = withConventions(form.md, parseConventions(next.md));
  return out as Fields;
}
// 未保存的改动按项目留在本页（v0.78）：关面板、切到别的面板、切项目再回来都还在，刷新页面才丢
export const drafts = new Map<string, { form: Fields; base: Fields; instruction: string }>();
