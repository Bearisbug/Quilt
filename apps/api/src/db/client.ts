import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { config } from '../config.ts';
import * as schema from './schema.ts';

// 数据层（ADR-010 v0.32）：两个驱动、一个接口。
//   DATABASE_URL 留空 → PGlite（Postgres 编译成 WASM、进程内运行、文件在 $dataDir/db）——本地版默认；
//   设了 → node-postgres 连外部 Postgres——开发 docker、将来 SaaS。
// 业务代码只认 db / query / subscribe 三样，不碰驱动对象。
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
type Rows<T> = { rows: T[] };
export type Driver = {
  db: Db;
  /** 原生参数化 SQL（事件表的 insert…returning 与 pg_notify 用） */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Rows<T>>;
  /** LISTEN 一个频道；返回取消订阅 */
  subscribe(channel: string, fn: (payload: string) => void): Promise<() => void>;
  close(): Promise<void>;
  kind: 'pg' | 'pglite';
};

async function pgDriver(url: string): Promise<Driver> {
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.Pool({ connectionString: url, max: 20, statement_timeout: 5000 });
  let listener: import('pg').Client | null = null;
  const handlers = new Map<string, Set<(p: string) => void>>();
  return {
    kind: 'pg',
    db: drizzle(pool, { schema }) as unknown as Db,
    query: (text, params) => pool.query(text, params as never[]) as Promise<Rows<never>>,
    async subscribe(channel, fn) {
      if (!listener) {
        listener = new pg.Client({ connectionString: url });
        await listener.connect();
        listener.on('notification', (n) => { if (n.channel) handlers.get(n.channel)?.forEach((h) => h(n.payload ?? '')); });
        listener.on('error', () => { listener = null; });
      }
      if (!handlers.has(channel)) { handlers.set(channel, new Set()); await listener.query(`listen ${channel}`); }
      handlers.get(channel)!.add(fn);
      return () => { handlers.get(channel)?.delete(fn); };
    },
    close: async () => { await listener?.end().catch(() => {}); await pool.end(); },
  };
}

async function pgliteDriver(dir: string): Promise<Driver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const pglite = await PGlite.create(dir);
  return {
    kind: 'pglite',
    db: drizzle(pglite, { schema }) as unknown as Db,
    query: (text, params) => pglite.query(text, params as never[]) as Promise<Rows<never>>,
    subscribe: (channel, fn) => pglite.listen(channel, (payload) => fn(payload)),
    close: () => pglite.close(),
  };
}

const driverPromise: Promise<Driver> = config.databaseUrl ? pgDriver(config.databaseUrl) : pgliteDriver(path.join(config.dataDir, 'db'));
export const driver: Driver = await driverPromise;
export const db: Db = driver.db;
export const query = driver.query;
export const subscribe = driver.subscribe;
export const closeDb = driver.close;
export { schema };
