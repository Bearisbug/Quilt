import { eq } from 'drizzle-orm';
import { db, closeDb, schema } from '../db/client.ts';
import { LOCAL_EMAIL } from '../services/user.ts';

// 本地单用户壳（ADR-016）：种子脚本与 API 进程共用同一行默认用户；OWNER 保留为别名，测试脚本里的名字不用改
export const OWNER = LOCAL_EMAIL;

export function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  if (def !== undefined) return def;
  console.error(`missing --${name}`); process.exit(2);
}
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

export async function userByEmail(email: string) {
  let [u] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
  if (!u) [u] = await db.insert(schema.users).values({ email: email.toLowerCase() }).returning();
  return u;
}

export async function done(out?: unknown) {
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  await closeDb();
}
