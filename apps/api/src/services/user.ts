import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

export type UserRow = typeof schema.users.$inferSelect;

// 本地单用户壳（ADR-016）：所有请求都解析为这一行默认用户。保留 users 表与 owner_id / created_by 外键，
// SaaS 阶段加回登录即回到多账号，不必动数据模型。每请求查一次（trivial），不缓存——`pnpm seed` 会删项目、不会删它。
export const LOCAL_EMAIL = 'local@quilt.local';

export async function localUser(): Promise<UserRow> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, LOCAL_EMAIL));
  if (u) return u;
  const [created] = await db.insert(schema.users).values({ email: LOCAL_EMAIL }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(schema.users).where(eq(schema.users.email, LOCAL_EMAIL));
  return again;
}
