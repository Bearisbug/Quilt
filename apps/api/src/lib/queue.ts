// 进程内队列（ADR-010 v0.32）：单进程本地版不需要 pg-boss。作业表是事实源——这里只负责「有活就调度」，
// 进程重启时由 worker 的 recover 把 queued 作业补回来；截图按 key 去重、失败按次重试。
// 同一个 key 正在跑时又来一次（例如截图途中切了呈现方式）：记下来，这一轮跑完再跑一次——还在排队的不用记，轮到它时看到的已是最新状态
type Task<T> = { payload: T; key?: string; retries: number; delayMs: number; initialRetries: number };

export class InProcessQueue<T> {
  private pending: Task<T>[] = [];
  private keys = new Set<string>();
  private runningKeys = new Set<string>();
  private dirty = new Set<string>();
  private running = 0;
  private handler: ((payload: T) => Promise<void>) | null = null;
  constructor(readonly name: string, private concurrency: number) {}

  push(payload: T, opts: { key?: string; retries?: number; retryDelayMs?: number } = {}) {
    if (opts.key) {
      if (this.keys.has(opts.key)) { if (this.runningKeys.has(opts.key)) this.dirty.add(opts.key); return; }
      this.keys.add(opts.key);
    }
    this.pending.push({ payload, key: opts.key, retries: opts.retries ?? 0, delayMs: opts.retryDelayMs ?? 5000, initialRetries: opts.retries ?? 0 });
    this.pump();
  }
  work(handler: (payload: T) => Promise<void>) { this.handler = handler; this.pump(); }
  get size() { return this.pending.length + this.running; }

  private pump() {
    if (!this.handler) return;
    while (this.running < this.concurrency && this.pending.length) {
      const t = this.pending.shift()!;
      this.running += 1;
      if (t.key) this.runningKeys.add(t.key);
      const settle = () => {
        if (!t.key) return;
        this.keys.delete(t.key);
        if (this.dirty.delete(t.key)) this.push(t.payload, { key: t.key, retries: t.initialRetries, retryDelayMs: t.delayMs });
      };
      this.handler(t.payload).then(
        settle,
        (e) => {
          console.warn(`[queue ${this.name}] ${(e as Error).message}${t.retries > 0 ? `, retry in ${t.delayMs} ms` : ''}`);
          // 失败重试本身就会再跑一次，在途时记下的那一笔不必另跑
          if (t.retries > 0) { if (t.key) this.dirty.delete(t.key); setTimeout(() => { this.pending.push({ ...t, retries: t.retries - 1 }); this.pump(); }, t.delayMs).unref(); }
          else settle();
        },
      ).finally(() => { if (t.key) this.runningKeys.delete(t.key); this.running -= 1; this.pump(); });
    }
  }
}
