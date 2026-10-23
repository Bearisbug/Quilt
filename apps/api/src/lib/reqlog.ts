import { appendFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { config } from '../config.ts';

// 请求日志（§21 v1.29）：每个请求计耗时与状态，耗时 ≥ 200 ms 的慢请求与 5xx 逐条写，每 5 分钟一行汇总（5xx 率、预览 P95 按它算；
// v1.35 起带请求最多的 5 个路由与 4xx 最多的 3 组路由加状态，看得出流量与 4xx 从哪来）。
// 只写路由模板，不写实际地址与查询串：预览地址带签名与 token。写到标准输出，同时追加进数据目录的 quilt.log，超过 10 MB 换一份
const SLOW_MS = 200;
const WINDOW_MS = 5 * 60_000;
const ROTATE_BYTES = 10 * 1024 * 1024;
export const requestLogFile = () => path.join(config.dataDir, 'quilt.log');

type Window = { ms: number[]; c4: number; c5: number; routes: Map<string, number>; e4: Map<string, number> };
const emptyWindow = (): Window => ({ ms: [], c4: 0, c5: 0, routes: new Map(), e4: new Map() });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const topOf = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} ${c}`).join('; ');
const windows = new Map<string, Window>();

let pending: Promise<void> = Promise.resolve();
function write(line: string) {
  console.log(line);
  const file = requestLogFile();
  pending = pending.then(async () => {
    if ((await stat(file).then((s) => s.size, () => 0)) > ROTATE_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${new Date().toISOString()} ${line}\n`);
  }).catch(() => {});
}
/** 等已排队的写入落盘（测试用） */
export const requestLogFlushed = () => pending;

export function requestLog(service: 'api' | 'preview'): MiddlewareHandler {
  return async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = Math.round(performance.now() - t0);
    const status = c.res.status;
    let w = windows.get(service);
    if (!w) windows.set(service, (w = emptyWindow()));
    const route = `${c.req.method} ${routePath(c, -1)}`;
    w.ms.push(ms);
    bump(w.routes, route);
    if (status >= 500) w.c5++; else if (status >= 400) { w.c4++; bump(w.e4, `${route} ${status}`); }
    if (ms >= SLOW_MS || status >= 500) write(`[req] ${service} ${route} ${status} ${ms} ${(c.var as { requestId?: string }).requestId ?? '-'}`);
  };
}

/** 写出这一窗的汇总并清零；这一窗没有请求的服务不写 */
export function flushRequestStats() {
  for (const [service, w] of windows) {
    if (!w.ms.length) continue;
    const s = w.ms.sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    write(`[req] 5m ${service} n=${s.length} 4xx=${w.c4} 5xx=${w.c5} p50=${at(0.5)} p95=${at(0.95)} top=${topOf(w.routes, 5)}${w.e4.size ? ` 4xx-by=${topOf(w.e4, 3)}` : ''}`);
    windows.set(service, emptyWindow());
  }
}
setInterval(flushRequestStats, WINDOW_MS).unref();
