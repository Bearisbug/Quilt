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
  /** LISTEN 连接断过、又重连上时回调：断开期间的通知已经丢了，订阅方据此各自整体重取一次 */
  onReconnect(fn: () => void): void;
  close(): Promise<void>;
  kind: 'pg' | 'pglite';
};

async function pgDriver(url: string): Promise<Driver> {
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.Pool({ connectionString: url, max: 20, statement_timeout: 5000 });
  const handlers = new Map<string, Set<(p: string) => void>>();
  const reconnectHooks: (() => void)[] = [];
  // LISTEN 用一条专用连接。它会断（Postgres / docker 重启、休眠断网）：断了就按 1 s 起、翻倍、封顶 30 s 退避重连，
  // 把 handlers 里的频道全部重新 LISTEN——只把连接置空的话，频道表还留着，之后的订阅不会再 LISTEN，事件就永久收不到了（§16）
  let listener: Promise<import('pg').Client> | null = null;
  let retryMs = 1000;
  let closed = false;
  let recovering = false;
  const connect = (): Promise<import('pg').Client> => {
    const client = new pg.Client({ connectionString: url });
    const ready = (async () => {
      await client.connect();
      client.on('notification', (n) => { if (n.channel) handlers.get(n.channel)?.forEach((h) => h(n.payload ?? '')); });
      for (const channel of handlers.keys()) await client.query(`listen ${channel}`);
      retryMs = 1000;
      // 不论是退避重连还是新订阅顺手建的连接，只要之前断过，都通知订阅方补一次
      if (recovering) { recovering = false; reconnectHooks.forEach((f) => f()); }
      return client;
    })();
    const lost = () => {
      if (listener !== ready) return;
      listener = null;
      recovering = true;
      client.end().catch(() => {});
      if (closed) return;
      setTimeout(reconnect, retryMs).unref();
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    client.on('error', lost);
    client.on('end', lost);
    ready.catch(lost);
    return ready;
  };
  const reconnect = () => {
    if (closed || listener) return;
    listener = connect();
    listener.catch(() => {});
  };
  return {
    kind: 'pg',
    db: drizzle(pool, { schema }) as unknown as Db,
    query: (text, params) => pool.query(text, params as never[]) as Promise<Rows<never>>,
    async subscribe(channel, fn) {
      const fresh = !handlers.has(channel);
      if (fresh) handlers.set(channel, new Set());
      handlers.get(channel)!.add(fn);
      try {
        // 新建的连接会 LISTEN handlers 里的全部频道（含这一条）；已有连接只补这一条（重复 LISTEN 无害）
        if (!listener) await (listener = connect());
        else if (fresh) await (await listener).query(`listen ${channel}`);
      } catch (e) { handlers.get(channel)?.delete(fn); throw e; }
      return () => { handlers.get(channel)?.delete(fn); };
    },
    onReconnect: (fn) => { reconnectHooks.push(fn); },
    close: async () => { closed = true; const l = await listener?.catch(() => null); await l?.end().catch(() => {}); await pool.end(); },
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
    // 进程内 listen，不会断
    onReconnect: () => {},
    close: () => pglite.close(),
  };
}

const driverPromise: Promise<Driver> = config.databaseUrl ? pgDriver(config.databaseUrl) : pgliteDriver(path.join(config.dataDir, 'db'));
export const driver: Driver = await driverPromise;
export const db: Db = driver.db;
export const query = driver.query;
export const subscribe = driver.subscribe;
export const onListenReconnect = driver.onReconnect;
export const closeDb = driver.close;
export { schema };
