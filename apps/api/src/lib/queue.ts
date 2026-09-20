// 进程内队列（ADR-010 v0.32）：单进程本地版不需要 pg-boss。作业表是事实源——这里只负责「有活就调度」，
// 进程重启时由 worker 的 recover 把 queued 作业补回来；截图按 key 去重、失败按次重试。
type Task<T> = { payload: T; key?: string; retries: number; delayMs: number };

export class InProcessQueue<T> {
  private pending: Task<T>[] = [];
  private keys = new Set<string>();
  private running = 0;
  private handler: ((payload: T) => Promise<void>) | null = null;
  constructor(readonly name: string, private concurrency: number) {}

  push(payload: T, opts: { key?: string; retries?: number; retryDelayMs?: number } = {}) {
    if (opts.key) { if (this.keys.has(opts.key)) return; this.keys.add(opts.key); }
    this.pending.push({ payload, key: opts.key, retries: opts.retries ?? 0, delayMs: opts.retryDelayMs ?? 5000 });
    this.pump();
  }
  work(handler: (payload: T) => Promise<void>) { this.handler = handler; this.pump(); }
  get size() { return this.pending.length + this.running; }

  private pump() {
    if (!this.handler) return;
    while (this.running < this.concurrency && this.pending.length) {
      const t = this.pending.shift()!;
      this.running += 1;
      this.handler(t.payload).then(
        () => { if (t.key) this.keys.delete(t.key); },
        (e) => {
          console.warn(`[queue ${this.name}] ${(e as Error).message}${t.retries > 0 ? `, retry in ${t.delayMs} ms` : ''}`);
          if (t.retries > 0) setTimeout(() => { this.pending.push({ ...t, retries: t.retries - 1 }); this.pump(); }, t.delayMs).unref();
          else if (t.key) this.keys.delete(t.key);
        },
      ).finally(() => { this.running -= 1; this.pump(); });
    }
  }
}
