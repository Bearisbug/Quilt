import { eq, sql } from 'drizzle-orm';
import { RADIUS_SCALES, tokensFromSeed, type ColorMode, type Palette, type Tokens } from '@quilt/core';
import { db, schema } from './client.ts';

// 语义色回填（§25 / REQ-EDIT-005）：迁移 0010 只加了列，没重算物化的 tokens，而生成 prompt、lint 与 prelude
// 都按代码里的 26 键静态清单走——0010 之前建的项目在「升级后到下一次写设计系统之间」被要求写 bg-success，
// 却拿不到 --color-success 与 tailwind 映射，那块在浏览器里完全透明（风格指南与色板的四格同样空着）。
// 只补 colors 缺 success 的行，重复启动是空转。
export async function backfillSemanticColors(): Promise<number> {
  const rows = await db.select().from(schema.designSystems)
    .where(sql`${schema.designSystems.tokens} -> 'colors' ->> 'success' is null`);
  for (const ds of rows) {
    const tokens = ds.tokens as Tokens;
    const colorMode = ds.colorMode as ColorMode;
    // 用行里存着的那套输入重算，与 API-EDIT-002 走同一条路径：圆角档位按 radius.md 反查
    const radiusScale = (Object.entries(RADIUS_SCALES).find(([, v]) => v.md === tokens.radius.md)?.[0] as keyof typeof RADIUS_SCALES | undefined) ?? 'default';
    const next = tokensFromSeed(ds.seedColor, { fontFamily: tokens.typography.fontFamily, fontSource: tokens.typography.fontSource, fontUrl: tokens.typography.fontUrl, radiusScale, palette: (ds.palette as Palette | null)?.[colorMode], colorMode });
    // version 不动：它是 API-EDIT-002 的乐观锁基线，抬一格会让正开着设计面板的客户端下一次保存撞 409
    await db.update(schema.designSystems).set({ tokens: next }).where(eq(schema.designSystems.id, ds.id));
  }
  return rows.length;
}
