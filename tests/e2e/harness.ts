import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Page } from 'playwright';
import type { JobDto } from '@quilt/core';
import { apiJson, EVIDENCE } from './lib.ts';

// e2e 公用脚手架（TEST.md §3，v1.06）：每个套件用 suite() 拿一套 step / record / cleanups / summary，结果口径一致。
// - 缺前提（LIVE_LLM=0、没有可用的云端通道）抛 Skip → 记「跳过」，不算失败
// - §7 登记过、还没修好的用例在 EXPECTED_FAIL 里 → 失败时记「预期失败」并带遗留项，单独计数；它通过了照记通过、提示可以撤标
// - 单步有时限（缺省 10 min）：Playwright 的 page.evaluate 没有超时，页面或无头浏览器卡死时整套会一直挂着（RUN-247 卡过 67 分钟）。
//   到点记失败、调套件给的 onTimeout（关掉卡住的页面、换一个新的），后面的用例照常跑
export type Result = '通过' | '失败' | '跳过' | '待人工' | '预期失败';
export class Skip extends Error {}
export class Manual extends Error {}
class StepTimeout extends Error {}

export const LIVE_LLM = process.env.LIVE_LLM !== '0';
/** 需要真实模型的用例开头调一次：LIVE_LLM=0 时记「跳过」 */
export const needLiveLlm = () => { if (!LIVE_LLM) throw new Skip('LIVE_LLM=0，需要真实模型'); };

export const EXPECTED_FAIL: Record<string, string> = {
  'TC-CORE-023': '§7「TC-CORE-023 在打包形态的隔离栈上失败」',
  'TC-CORE-047': '§7「⌘K 找屏连按 ↓ 到底后选中行跳回」（时过时不过）',
};

export const expect = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 收集式断言：一条用例里多处检查各自记下，最后一并报出 */
export const softly = () => {
  const errs: string[] = [];
  const line = (e: unknown) => (e as Error).message.split('\n')[0].slice(0, 160);
  return {
    check: async (f: () => unknown) => { try { await f(); } catch (e) { errs.push(line(e)); } },
    fail: (e: unknown) => { errs.push(`中断：${line(e)}`); },
    done: () => { if (!errs.length) return; console.log(`   明细：\n   - ${errs.join('\n   - ')}`); throw new Error(`${errs.length} 处不符：${errs.join(' ｜ ')}`); },
  };
};

// 用例里直接取作业输入输出的字段（各种作业形状不一），这里放宽成任意字段
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobView = Omit<JobDto, 'input' | 'output'> & { input: Record<string, any>; output: Record<string, any> };
/** 等作业到终态（每秒问一次），超时抛错 */
export async function waitJob(jobId: string, maxSec = 180): Promise<JobView> {
  for (let i = 0; i < maxSec; i++) {
    const { body } = await apiJson<{ job: JobView }>(`/v1/jobs/${jobId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(body.job.status)) return body.job;
    await sleep(1000);
  }
  throw new Error(`作业 ${jobId} ${maxSec} s 内没有结束`);
}

// 重启被测 API（TEST.md §3 的 QUILT_E2E_RESTART）：extra 里的环境变量带给新进程；下面这些 stub 旋钮没在 extra 里的一律去掉，
// 回到测试栈的缺省（e2e-stack.sh 起栈时给的值）——上一条用例临时改的值不会漏给后面
const KNOBS = ['QUILT_JOB_TIMEOUT_BASE_MS', 'QUILT_JOB_TIMEOUT_TOTAL_MS', 'SCREEN_CONCURRENCY', 'QUILT_RATE_LIMIT_PER_MIN'];
export function restartApi(extra: Record<string, string> = {}): Promise<void> {
  const cmd = process.env.QUILT_E2E_RESTART;
  if (!cmd) throw new Skip('未设 QUILT_E2E_RESTART（重启被测 API 的命令，§3）');
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of KNOBS) if (!(k in extra)) delete env[k];
  return new Promise<void>((resolve, reject) => {
    const p = spawn('sh', ['-c', cmd], { stdio: 'ignore', env });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`重启命令退出码 ${code}`))));
  });
}

const ICON: Record<Result, string> = { 通过: '✅', 失败: '❌', 跳过: '⏭', 待人工: '⏭', 预期失败: '🟡' };
export const STEP_TIMEOUT_MS = 10 * 60_000;

export function suite(name: string, opts: { page?: () => Page | undefined; onTimeout?: () => Promise<void> } = {}) {
  const RUN = process.env.RUN ?? '000';
  const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const results: { tc: string; result: Result; note: string; ms: number }[] = [];
  const cleanups: (() => Promise<unknown>)[] = [];
  const record = (tc: string, result: Result, note = '', ms = 0) => {
    results.push({ tc, result, note, ms });
    console.log(`${ICON[result]} ${tc} ${result} ${note}`);
  };
  const shot = (key: string, fail: boolean) => opts.page?.()?.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${key.toLowerCase().replace(/\s+/g, '-')}${fail ? '-fail' : ''}.png`) }).catch(() => {});
  /** key：记录与证据文件用的名字，缺省 = tc（分步的用例写「TC-CORE-057 第 1 步」） */
  const step = async (tc: string, fn: () => Promise<string | void>, o: { key?: string; timeoutMs?: number } = {}) => {
    if (ONLY && !ONLY.includes(tc)) return;
    const key = o.key ?? tc;
    const limit = o.timeoutMs ?? STEP_TIMEOUT_MS;
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout(`单步超过 ${Math.round(limit / 60_000)} min 没有结束（页面或浏览器卡住）`)), limit); });
    try {
      const note = await Promise.race([fn(), late]);
      const legacy = EXPECTED_FAIL[tc];
      record(key, '通过', `${note ?? ''}${legacy ? `（预期失败项已通过，可从 harness.ts 撤标：${legacy}）` : ''}`, Date.now() - t0);
      await shot(key, false);
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0].slice(0, 400);
      if (e instanceof Skip) record(key, '跳过', msg, Date.now() - t0);
      else if (e instanceof Manual) record(key, '待人工', msg, Date.now() - t0);
      else if (EXPECTED_FAIL[tc]) record(key, '预期失败', `${EXPECTED_FAIL[tc]}：${msg}`, Date.now() - t0);
      else record(key, '失败', msg, Date.now() - t0);
      await shot(key, true);
      // 换页本身也可能卡在同一个坏掉的浏览器上：给它 60 s
      if (e instanceof StepTimeout && opts.onTimeout) await Promise.race([opts.onTimeout(), sleep(60_000).then(() => { throw new Error('换页超过 60 s'); })]).catch((err) => console.log(`   换页失败：${(err as Error).message.slice(0, 160)}`));
    } finally {
      clearTimeout(timer);
      for (const c of cleanups.splice(0)) await c().catch(() => {});
    }
  };
  /** 套件结尾：按结果计数、列出最慢的 10 条 */
  const summary = () => {
    const counts = results.reduce<Partial<Record<Result, number>>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {});
    console.log(`\n=== RUN-${RUN} ${name} === ${JSON.stringify(counts)}`);
    console.log('\n| 用例 | 结果 | 用时 | 备注 |\n| --- | --- | --- | --- |');
    for (const r of results) console.log(`| ${r.tc} | ${r.result} | ${Math.round(r.ms / 1000)} s | ${r.note.replace(/\|/g, '｜')} |`);
    const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
    console.log(`\n最慢的 ${slow.length} 条：${slow.map((r) => `${r.tc} ${Math.round(r.ms / 1000)} s`).join('，')}`);
    return counts;
  };
  return { RUN, ONLY, results, cleanups, record, step, summary };
}
