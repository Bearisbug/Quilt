import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { BrowserContextOptions, Page } from 'playwright';
import type { UsageStatsDto } from '@quilt/core';
import { launch, seed, seedJson, apiJson, assertTestApi, EVIDENCE, WEB, API, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { suite, expect, softly, waitJob, sleep, Skip } from './harness.ts';

// docs/TEST.md CORE 域 · 设置、用量（REQ-CORE-008、REQ-CORE-039、REQ-CORE-046、REQ-CORE-047、REQ-AGENT-002；设计文档 v1.24，TC-CORE-140～143）AI 执行脚本。
// 台账直接经 docker 里的 quilt-pg 写进被测库（按 /v1/health 的库名）；每条用例自己开浏览器上下文、用完关掉，本机记录（localStorage）不带到下一条。
// 桩通道用 3951～3953，别的套件没用它们
await assertTestApi();
await mkdir(EVIDENCE, { recursive: true });
let page: Page | undefined;
const { step, summary, cleanups } = suite('SETTINGS', { page: () => page });

type Seeded = { projectId: string; screens: { id: string; route: string }[] };
type Problem = { type: string; title: string; status: number; detail?: string };
type Stats = UsageStatsDto;
const VIEWPORT = { width: 1440, height: 900 };
const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

seed('seed');
const browser = await launch();
const health = (await apiJson<{ database?: string }>('/v1/health')).body;
const psql = (q: string) => execFileSync('docker', ['exec', 'quilt-pg', 'psql', '-U', 'quilt', '-d', health.database ?? '', '-Atc', q], { encoding: 'utf8' }).trim();
try { psql('select 1'); } catch (e) { throw new Error(`环境：连不上 docker 里的 quilt-pg，造不了台账（${(e as Error).message.split('\n')[0]}）`); }
const demoId = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!.id;

// 看板的数字格式（apps/web/src/settings/usageModel.ts）：Token 用 K / M，次数按界面语言分组
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
const fmtTokens = (n: number) => COMPACT.format(n);
const fmtInt = (n: number) => n.toLocaleString('zh-CN');
const fmtPct = (part: number, total: number) => { if (!total || !part) return '0%'; const p = (part / total) * 100; return p < 1 ? '<1%' : `${Math.round(p)}%`; };
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
// 文字节点之间没有空白（提示与看板的数字、单位各是一个元素），比对时去掉全部空白
const bare = (s: string | null) => (s ?? '').replace(/\s+/g, '');
const stats = (range: string, utcOffset = 480) => apiJson<Stats>(`/v1/me/usage/stats?range=${range}&utcOffset=${utcOffset}`);
// 台账按 utcOffset 那个时区切的自然日（与服务端 dayOf 同一口径）
const localDay = (offset: number) => `((created_at at time zone 'UTC') + interval '${offset} minutes')::date`;
const todayAt = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString().slice(0, 10);

// OpenAI 兼容桩通道：单屏规划回一屏（每次一个新路由），其余回一屏 HTML；验证通过才回
async function stubChannel(port: number, label: string) {
  const key = `good-key-${port}`;
  let n = 0;
  const stub = startOpenAiStub({
    port, apiKey: key,
    reply: (hit) => (hit.user.includes('Requested screen:')
      ? JSON.stringify({ name: `Login ${++n}`, route: `/login-${port}-${n}`, purpose: 'sign in', links: [], sections: ['form'], entryFrom: null })
      : '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl font-semibold">Login</h1><button type="button" class="mt-4 h-12 px-6 rounded-full bg-primary text-on-primary">Sign in</button></div>'),
  });
  let id = '';
  cleanups.push(async () => { if (id) await apiJson(`/v1/channels/${id}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  id = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label, endpoint: stub.url, model: `stub-${port}`, apiKey: key }) })).body.channel.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${id}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
  return { stub, channelId: id, runner: { kind: 'channel', channelId: id } };
}

// TC-CORE-140 / 141 的前置台账：清空台账 → UsageA 用「Stub A」出一屏 → 直接写两条（100 天前没有快照的一条、今天项目与通道都已不在的一条）
async function buildLedger(port: number) {
  psql('delete from usage_entries');
  const { projectId } = seedJson<Seeded>('seed:project', '--name', 'UsageA', '--device', 'mobile', '--screens', '1', '--no-shot');
  const { channelId, runner } = await stubChannel(port, 'Stub A');
  const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: '做一个登录页', runner }) });
  expect(r.status === 202, `前置：用 Stub A 出一屏 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await waitJob(r.body.job.id, 120);
  expect(job.status === 'succeeded', `前置：Stub A 出屏 ${job.status}：${JSON.stringify(job.output).slice(0, 200)}`);
  const snap = psql(`select concat_ws('|', project_id, project_name, kind, channel_id, channel_label) from usage_entries where job_id = '${job.id}'`);
  expect(snap === [projectId, 'UsageA', 'generate', channelId, 'Stub A'].join('|'), `前置：这一屏的台账应带项目、任务类型与通道快照：${snap}`);
  const uid = psql(`select id from users where email = 'local@quilt.local'`);
  psql(`insert into usage_entries (user_id, tokens_in, tokens_out, screens, driver, model, created_at) values ('${uid}', 1200, 300, 1, 'stub', 'old-model', now() - interval '100 days')`);
  psql(`insert into usage_entries (user_id, tokens_in, tokens_out, screens, driver, model, project_id, project_name, kind, channel_id, channel_label, created_at)
    values ('${uid}', 300, 100, 1, 'openai', 'gone-model', gen_random_uuid(), 'Gone', 'edit_screens', gen_random_uuid(), 'Old Model', now())`);
  return { projectId, channelId };
}

// 新开一个浏览器上下文（本机记录是空的）
async function openContext(opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, ...opts });
  cleanups.push(() => ctx.close());
  const pg = await ctx.newPage();
  page = pg;
  return { ctx, pg };
}
const openSettings = async (pg: Page, projectId: string, section: string) => {
  await pg.goto(`${WEB}/p/${projectId}?settings=${section}`);
  await pg.getByTestId('settings-modal').waitFor({ timeout: 15000 });
};
const tabTexts = async (pg: Page) => (await pg.locator('[data-testid^="settings-tab-"]').allInnerTexts()).map((s) => s.trim());
const selectedTab = (pg: Page) => pg.locator('[data-testid^="settings-tab-"][aria-selected="true"]').getAttribute('data-testid');
const htmlTheme = (pg: Page) => pg.evaluate(() => document.documentElement.dataset.theme ?? null);
// 页面文字（不含 iframe）：文字节点（含读屏专用）与 aria-label / title / placeholder / alt 里命中 re 的片段。页面里执行的函数不能再声明具名函数
const textHits = (pg: Page, re: RegExp) => pg.evaluate(([src, flags]) => {
  const rx = new RegExp(src, flags);
  const out = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').trim();
    if (text && rx.test(text) && !n.parentElement?.closest('script, style, noscript, template')) out.add(text.slice(0, 80));
  }
  for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
    const v = el.getAttribute(a);
    if (v && rx.test(v)) out.add(`${a}=${v.slice(0, 80)}`);
  }
  return [...out];
}, [re.source, re.flags] as const);
const styleOf = (pg: Page, sel: string) => pg.locator(sel).first().evaluate((el) => {
  const cs = getComputedStyle(el);
  return { animationName: cs.animationName, animationDuration: cs.animationDuration, transitionDuration: cs.transitionDuration, transitionProperty: cs.transitionProperty, opacity: cs.opacity, visibility: cs.visibility, transform: cs.transform, color: cs.color };
});

// TC-CORE-140 用量统计接口：范围、按周汇总、删掉的项目与模型（REQ-CORE-008；API-CORE-052、ADR-036）
await step('TC-CORE-140', async () => {
  const { projectId, channelId } = await buildLedger(3951);
  const S = softly();
  const today = todayAt(480);
  const ledger = () => Number(psql('select count(*) from usage_entries'));
  const allTokens = (await stats('all')).body.models;
  // 1 range=7d：200、no-store、按天 7 格、最后一格含今天；作业数 = 近 7 天的台账条数；模型按全部时间的 Token 降序
  const w = await stats('7d');
  const last7 = Number(psql(`select count(*) from usage_entries where ${localDay(480)} > ${`((now() at time zone 'UTC') + interval '480 minutes')::date`} - 7`));
  await S.check(() => expect(w.status === 200 && /no-store/.test(w.headers.get('cache-control') ?? ''), `① 应 200 且 no-store：${w.status} ${w.headers.get('cache-control')}`));
  await S.check(() => expect(w.body.unit === 'day' && w.body.buckets.length === 7 && w.body.buckets.at(-1)!.from <= today && w.body.buckets.at(-1)!.to >= today, `① 应按天 7 格、最后一格含今天 ${today}：${w.body.unit} ${w.body.buckets.length} ${JSON.stringify(w.body.buckets.at(-1))}`));
  await S.check(() => expect(w.body.totals.jobs === last7 && last7 === 2, `① totals.jobs 应等于近 7 天的台账条数 ${last7}（Stub A 一条 + Gone 一条）：${w.body.totals.jobs}`));
  const order = allTokens.map((m) => m.key);
  const allSum = allTokens.map((m) => m.tokensIn + m.tokensOut);
  await S.check(() => expect(JSON.stringify(w.body.models.map((m) => m.key)) === JSON.stringify(order) && allSum.every((t, i) => i === 0 || allSum[i - 1] >= t), `① models 应按全部时间的 Token 降序：${JSON.stringify(w.body.models.map((m) => m.label))} 全部时间 ${JSON.stringify(allSum)}`));
  const stubA = w.body.models.find((m) => m.label === 'Stub A'); const oldModel = w.body.models.find((m) => m.label === 'Old Model');
  await S.check(() => expect(stubA?.deleted === false && stubA.key === channelId && oldModel?.deleted === true, `① 「Stub A」应 deleted=false、「Old Model」应 deleted=true：${JSON.stringify(w.body.models)}`));
  // 2 range=30d：30 格；每格各模型的 Token 之和 = 那天台账的 Token 合计
  const m = await stats('30d');
  const perDay = new Map(psql(`select to_char(${localDay(480)}, 'YYYY-MM-DD'), sum(tokens_in + tokens_out) from usage_entries group by 1`).split('\n').filter(Boolean).map((l) => { const [d, t] = l.split('|'); return [d, Number(t)] as const; }));
  await S.check(() => expect(m.body.buckets.length === 30, `② range=30d 应 30 格：${m.body.buckets.length}`));
  const bad = m.body.buckets.filter((b) => sum(b.tokens) !== (perDay.get(b.from) ?? 0));
  await S.check(() => expect(bad.length === 0, `② 每格的 Token 应等于那天台账的合计：${JSON.stringify(bad.map((b) => [b.from, sum(b.tokens), perDay.get(b.from) ?? 0]))}`));
  // 3 range=all：跨度超过 60 天按周、每格从周一起、最后一格含今天；activity 固定 90 天
  const a = await stats('all');
  const monday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1;
  await S.check(() => expect(a.body.unit === 'week' && a.body.buckets.every((b) => monday(b.from)) && a.body.buckets.at(-1)!.from <= today && a.body.buckets.at(-1)!.to >= today, `③ range=all 应按周、每格从周一起、最后一格含今天：${a.body.unit} ${JSON.stringify(a.body.buckets.filter((b) => !monday(b.from)).slice(0, 3))} 末格 ${JSON.stringify(a.body.buckets.at(-1))}`));
  await S.check(() => expect(a.body.activity.days.length === 90 && w.body.activity.days.length === 90 && a.body.activity.to === today, `③ activity.days 应 90 项、与 range 无关：all ${a.body.activity.days.length} / 7d ${w.body.activity.days.length}`));
  // 4 projects 与 kinds
  const pA = a.body.projects.find((p) => p.id === projectId);
  await S.check(() => expect(pA?.name === 'UsageA' && pA.deleted === false, `④ projects 应有 UsageA（deleted=false）：${JSON.stringify(pA)}`));
  await S.check(() => expect(a.body.projects.some((p) => p.name === 'Gone' && p.deleted) && a.body.projects.some((p) => p.id === null && p.deleted), `④ projects 应有 Gone（deleted=true）与一项 id=null：${JSON.stringify(a.body.projects)}`));
  const kinds = a.body.kinds.map((k) => k.kind);
  await S.check(() => expect(['generate', 'edit_screens', 'other'].every((k) => kinds.includes(k as never)), `④ kinds 应含 generate、edit_screens、other：${JSON.stringify(kinds)}`));
  // 5 改名：显示现在的名字，数不变
  const nums = (s: Stats) => JSON.stringify({ t: s.totals, p: s.projects.find((p) => p.id === projectId)?.tokens, m: s.models.find((x) => x.key === channelId)?.jobs, mt: s.models.find((x) => x.key === channelId)?.tokensIn });
  expect((await apiJson(`/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: 'UsageB' }) })).status === 200, '⑤ 项目改名失败');
  expect((await apiJson(`/v1/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify({ label: 'Stub B' }) })).status === 200, '⑤ 通道改名失败');
  const a5 = (await stats('all')).body;
  await S.check(() => expect(a5.projects.find((p) => p.id === projectId)?.name === 'UsageB' && a5.models.find((x) => x.key === channelId)?.label === 'Stub B', `⑤ 改名后应显示 UsageB 与 Stub B：${JSON.stringify(a5.projects.find((p) => p.id === projectId))} ${JSON.stringify(a5.models.find((x) => x.key === channelId))}`));
  await S.check(() => expect(nums(a5) === nums(a.body), `⑤ 改名不该改数：${nums(a5)} vs ${nums(a.body)}`));
  // 6 删掉项目与通道：两者都还在、deleted=true，名字是删除前的，Token 不变
  expect((await apiJson(`/v1/projects/${projectId}`, { method: 'DELETE' })).status === 204, '⑥ 删项目没回 204');
  expect((await apiJson(`/v1/channels/${channelId}`, { method: 'DELETE' })).status === 204, '⑥ 删通道没回 204');
  const a6 = (await stats('all')).body;
  const p6 = a6.projects.find((p) => p.id === projectId); const m6 = a6.models.find((x) => x.key === channelId);
  await S.check(() => expect(p6?.deleted === true && p6.name === 'UsageB' && m6?.deleted === true && m6.label === 'Stub B', `⑥ 删掉后应仍在、deleted=true、名字是 UsageB / Stub B：${JSON.stringify(p6)} ${JSON.stringify(m6)}`));
  await S.check(() => expect(nums(a6) === nums(a.body), `⑥ 删掉后 Token 不该变：${nums(a6)} vs ${nums(a.body)}`));
  // 7 交给本机会话的改屏（MCP 建、假会话以 quilt.finish_job 收尾）：不进台账
  await S.check(async () => {
    const DIR = process.env.QUILT_CLAUDE_SESSIONS_DIR ?? '';
    if (!DIR) throw new Skip('未设 QUILT_CLAUDE_SESSIONS_DIR（API 与本脚本都要以同一目录启动，§3）');
    const { startFakeSession } = await import('./agent-stub.ts');
    const fake = await startFakeSession({ dir: DIR, name: 'Stub 用量', nameSource: 'user' });
    cleanups.push(() => fake.close());
    await sleep(2100); // 服务端会话列表缓存 2 s
    const r = seedJson<Seeded>('seed:project', '--name', 'UsageAgent', '--device', 'mobile', '--screens', '1', '--no-shot');
    const before = ledger();
    const mcp = await connectMcp();
    cleanups.push(() => mcp.close());
    const g = await callTool(mcp, 'quilt.edit_screens', { projectId: r.projectId, screenIds: [r.screens[0].id], prompt: '改成深色', runner: { kind: 'agent', tool: 'claude-code', sessionId: fake.sessionId } });
    const jobId = (g.json as { id?: string }).id;
    expect(!g.isError && jobId, `⑦ MCP 建交给本机会话的改屏 ${g.text.slice(0, 200)}`);
    const job = await waitJob(jobId!, 60);
    expect(job.status === 'succeeded' && fake.received.length === 1, `⑦ 假会话应收到投递并以 finish_job 收尾：${job.status}，收到 ${fake.received.length} 条`);
    expect(ledger() === before, `⑦ 交给本机会话的作业不该进台账：${before} → ${ledger()}`);
  });
  // 8 不认识的范围与越界的时区
  for (const q of ['range=1y', 'range=7d&utcOffset=900']) {
    const r = await apiJson<Problem>(`/v1/me/usage/stats?${q}`);
    await S.check(() => expect(r.status === 400 && r.body.type === '/errors/validation', `⑧ ${q} 应 400 /errors/validation：${r.status} ${JSON.stringify(r.body).slice(0, 160)}`));
  }
  // 9 导出不调模型：台账多一条、不记驱动与模型；计入作业次数与任务类型，不归任何模型
  await S.check(async () => {
    const before = (await stats('7d')).body;
    const ex = seedJson<Seeded>('seed:project', '--name', 'UsageExport', '--device', 'mobile', '--screens', '1', '--no-shot');
    cleanups.push(async () => { await apiJson(`/v1/projects/${ex.projectId}`, { method: 'DELETE' }).catch(() => {}); });
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${ex.projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    expect(r.status === 202, `⑨ 建导出作业 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const job = await waitJob(r.body.job.id, 120);
    expect(job.status === 'succeeded', `⑨ 导出应成功：${job.status} ${JSON.stringify(job.output).slice(0, 200)}`);
    const row = psql(`select concat_ws('|', coalesce(driver, '-'), coalesce(model, '-'), kind) from usage_entries where job_id = '${job.id}'`);
    expect(row === '-|-|export_prototype', `⑨ 导出那条台账应不记驱动与模型：${row}`);
    const after = (await stats('7d')).body;
    const k = after.kinds.find((x) => x.kind === 'export_prototype');
    expect(after.totals.jobs === before.totals.jobs + 1, `⑨ totals.jobs 应多 1：${before.totals.jobs} → ${after.totals.jobs}`);
    expect(k?.jobs === 1 && JSON.stringify(k.byModel) === '{}', `⑨ 「导出」应 1 次、byModel 为空：${JSON.stringify(k)}`);
    const jobsOf = (x: Stats) => JSON.stringify(x.models.map((m) => [m.key, m.jobs]));
    expect(jobsOf(after) === jobsOf(before), `⑨ 各模型的作业次数不该变：${jobsOf(before)} → ${jobsOf(after)}`);
  });
  S.done();
  return `近 7 天 ${w.body.totals.jobs} 条；all 按周 ${a.body.buckets.length} 格；改名、删除后名字与数都对；交给会话的不记账`;
});

// TC-CORE-141 设置「用量」看板：日历、范围、悬停与空态（REQ-CORE-008；PAGE-CANVAS 设置「用量」）
await step('TC-CORE-141', async () => {
  const { projectId } = await buildLedger(3952);
  const S = softly();
  const { pg } = await openContext();
  await openSettings(pg, projectId, 'usage');
  await pg.getByTestId('usage-totals').waitFor({ timeout: 15000 });
  const offset = await pg.evaluate(() => -new Date().getTimezoneOffset());
  const today = todayAt(offset);
  const w = (await stats('7d', offset)).body;
  const act = w.activity;
  // 1 左栏三节、「用量」选中；日历 13 或 14 列 × 7 行、90 格，今天那格档位 ≥ 1；活跃天数、作业次数与 activity 一致
  await S.check(async () => expect(JSON.stringify(await tabTexts(pg)) === JSON.stringify(['用量', '模型', '系统']) && (await selectedTab(pg)) === 'settings-tab-usage', `① 左栏应是 用量 / 模型 / 系统、「用量」选中：${JSON.stringify(await tabTexts(pg))} ${await selectedTab(pg)}`));
  const cells = await pg.getByTestId('usage-day').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), date: e.getAttribute('data-date'), level: Number(e.getAttribute('data-level')) }; }));
  const cols = new Set(cells.map((c) => c.x)).size; const rows = new Set(cells.map((c) => c.y)).size;
  await S.check(() => expect(cells.length === 90 && (cols === 13 || cols === 14) && rows === 7, `① 日历应 13 或 14 列 × 7 行、90 格：${cols} 列 × ${rows} 行、${cells.length} 格`));
  await S.check(() => expect((cells.find((c) => c.date === today)?.level ?? 0) >= 1, `① 今天 ${today} 那格档位应 ≥ 1：${JSON.stringify(cells.find((c) => c.date === today))}`));
  const active = act.days.filter((d) => d.jobs > 0).length; const total = act.days.reduce((s, d) => s + d.jobs, 0);
  await S.check(async () => { const t = bare(await pg.getByTestId('usage-active-days').innerText()); expect(t.includes(`${fmtInt(active)}/90天`), `① 活跃天数应是 ${active}：${t}`); });
  await S.check(async () => { const t = flat(await pg.getByTestId('usage-activity-jobs').innerText()); expect(t.includes(fmtInt(total)), `① 作业次数应是 ${total}：${t}`); });
  // 2 缺省「近 7 天」；四张看板与 range=7d 的 totals 一致；7 根柱；「Old Model」那行灰字、带「已删除」
  await S.check(async () => expect((await pg.getByTestId('usage-range-7d').getAttribute('aria-checked')) === 'true', '② 缺省应选「近 7 天」'));
  const t = w.totals; const tokens = t.tokensIn + t.tokensOut;
  const kpi = async (id: string) => flat(await pg.getByTestId(id).innerText());
  await S.check(async () => expect((await kpi('usage-kpi-jobs')).includes(`作业 ${fmtInt(t.jobs)}`), `② 作业看板应写 ${t.jobs}：${await kpi('usage-kpi-jobs')}`));
  await S.check(async () => expect((await kpi('usage-kpi-tokens')).includes(`Token ${fmtTokens(tokens)} 输入 ${fmtTokens(t.tokensIn)} · 输出 ${fmtTokens(t.tokensOut)}`), `② Token 看板应写 ${fmtTokens(tokens)}：${await kpi('usage-kpi-tokens')}`));
  await S.check(async () => expect((await kpi('usage-kpi-screens')).includes(`生成屏数 ${fmtInt(t.screens)}`), `② 生成屏数看板应写 ${t.screens}：${await kpi('usage-kpi-screens')}`));
  await S.check(async () => expect((await kpi('usage-kpi-avg')).includes(`平均每次 Token ${fmtTokens(t.jobs ? Math.round(tokens / t.jobs) : 0)} 最多的一次 ${fmtTokens(t.maxJobTokens)}`), `② 平均每次看板不对：${await kpi('usage-kpi-avg')}`));
  await S.check(async () => expect((await pg.getByTestId('usage-bar').count()) === 7, `② 每日 Token 应 7 根柱：${await pg.getByTestId('usage-bar').count()}`));
  await S.check(async () => {
    const row = pg.getByTestId('usage-model-row').filter({ hasText: 'Old Model' });
    const live = pg.getByTestId('usage-model-row').filter({ hasText: 'Stub A' });
    const name = (r: typeof row) => r.locator('p').first().evaluate((el) => getComputedStyle(el).color);
    const secondary = await pg.evaluate(() => { const p = document.createElement('p'); p.className = 'text-text-secondary'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    expect((await row.count()) === 1 && (await row.getAttribute('data-deleted')) === 'true' && (await row.innerText()).includes('已删除'), `② 「Old Model」那行应带「已删除」：${await row.count()} 行`);
    const [gray, normal] = [await name(row), await name(live)];
    expect(gray === secondary && gray !== normal, `② 「Old Model」的名字应是灰的（次要文字色 ${secondary}）、与在用的「Stub A」不同：${gray} vs ${normal}`);
  });
  // 3 悬停今天那根柱：提示 120 ms 淡入，写各模型的 Token 与占比、合计等于当天的 Token
  const bucket = w.buckets.at(-1)!; const tot = sum(bucket.tokens);
  await S.check(async () => {
    const bar = pg.getByTestId('usage-bar').last();
    const tip = bar.locator(':scope > .usage-tip');
    expect((await tip.evaluate((el) => getComputedStyle(el).transitionDuration)).startsWith('0.12s'), `③ 提示的淡入应是 120 ms：${await tip.evaluate((el) => getComputedStyle(el).transitionDuration)}`);
    await bar.hover();
    await eventually(async () => expect((await tip.evaluate((el) => getComputedStyle(el).opacity)) === '1', '③ 悬停后提示没出来'), 1000, 20);
    const text = bare(await tip.textContent());
    const labelOf = (k: string) => w.models.find((m) => m.key === k)?.label ?? k;
    for (const [k, v] of Object.entries(bucket.tokens)) expect(text.includes(bare(labelOf(k))) && text.includes(`${fmtTokens(v)}·${fmtPct(v, tot)}`), `③ 提示里应有「${labelOf(k)}」${fmtTokens(v)} · ${fmtPct(v, tot)}：${text}`);
    expect(text.endsWith(`合计${fmtTokens(tot)}`), `③ 提示的合计应是 ${fmtTokens(tot)}：${text}`);
  });
  // 4 点「近 30 天」：滑块 200 ms 滑到它下面，30 根柱；刷新后仍是「近 30 天」
  await pg.mouse.move(0, 0);
  await pg.getByTestId('usage-range-30d').click();
  await S.check(async () => expect((await styleOf(pg, '[data-testid="usage-range-thumb"]')).transitionDuration === '0.2s', `④ 滑块的过渡应是 200 ms：${(await styleOf(pg, '[data-testid="usage-range-thumb"]')).transitionDuration}`));
  await sleep(400);
  await S.check(async () => {
    const th = (await pg.getByTestId('usage-range-thumb').boundingBox())!; const it = (await pg.getByTestId('usage-range-30d').boundingBox())!;
    const tf = (await styleOf(pg, '[data-testid="usage-range-thumb"]')).transform;
    expect(Math.abs((th.x + th.width / 2) - (it.x + it.width / 2)) < 2 && tf !== 'none', `④ 滑块应移到「近 30 天」下面：滑块中心 ${th.x + th.width / 2}、项中心 ${it.x + it.width / 2}、transform ${tf}`);
  });
  await S.check(() => eventually(async () => expect((await pg.getByTestId('usage-bar').count()) === 30, `④ 应 30 根柱：${await pg.getByTestId('usage-bar').count()}`), 8000));
  await pg.reload();
  await pg.getByTestId('usage-totals').waitFor({ timeout: 15000 });
  await S.check(async () => expect((await pg.getByTestId('usage-range-30d').getAttribute('aria-checked')) === 'true' && (await pg.evaluate(() => localStorage.getItem('quilt:usage-range'))) === '30d', `④ 刷新后应仍是「近 30 天」（本机 quilt:usage-range）：${await pg.evaluate(() => localStorage.getItem('quilt:usage-range'))}`));
  // 5 悬停日历里今天那格：「<月> 月 <日> 日 · N 次」
  await S.check(async () => {
    const cell = pg.locator(`[data-testid="usage-day"][data-date="${today}"]`);
    await cell.hover();
    const tip = cell.locator(':scope > .usage-tip');
    await eventually(async () => expect((await tip.evaluate((el) => getComputedStyle(el).opacity)) === '1', '⑤ 悬停后日历提示没出来'), 1000, 20);
    const n = act.days.find((d) => d.date === today)!.jobs;
    const [, mo, da] = today.split('-').map(Number);
    expect(flat(await tip.textContent()) === `${mo} 月 ${da} 日 · ${n} 次`, `⑤ 日历提示应写「${mo} 月 ${da} 日 · ${n} 次」：${await tip.textContent()}`);
  });
  // 6 减弱动态：柱子、胶囊与滑块的过渡与动画时长都是 0（量具自检：不减弱时柱子 300 ms、胶囊 400 ms）
  await S.check(async () => {
    const [rise, fill] = [await styleOf(pg, '.usage-rise'), await styleOf(pg, '.usage-fill')];
    expect(rise.animationDuration === '0.3s' && fill.animationDuration === '0.4s', `⑥ 不减弱时柱子应 300 ms、胶囊应 400 ms：${rise.animationDuration} / ${fill.animationDuration}`);
    const { pg: rm } = await openContext({ reducedMotion: 'reduce' });
    await openSettings(rm, projectId, 'usage');
    await rm.getByTestId('usage-totals').waitFor({ timeout: 15000 });
    const all = await Promise.all(['.usage-rise', '.usage-fill', '[data-testid="usage-range-thumb"]'].map(async (sel) => [sel, await styleOf(rm, sel)] as const));
    const moving = all.filter(([, s]) => !s.animationDuration.split(', ').every((d) => d === '0s') || !s.transitionDuration.split(', ').every((d) => d === '0s'));
    expect(moving.length === 0, `⑥ 减弱动态下这些还在动：${JSON.stringify(moving)}`);
    page = pg;
  });
  // 7 一份没有任何用量的结果：日历全是最浅一档，图表与三张排行写「还没有用量」，没有报错
  await S.check(async () => {
    const { pg: e } = await openContext();
    await e.route(/\/v1\/me\/usage\/stats/, async (route) => {
      const res = await route.fetch();
      const d = (await res.json()) as Stats;
      const empty: Stats = { ...d, totals: { jobs: 0, tokensIn: 0, tokensOut: 0, screens: 0, sketchScreens: 0, maxJobTokens: 0 }, models: [], projects: [], kinds: [],
        buckets: d.buckets.map((b) => ({ ...b, jobs: 0, tokens: {} })), activity: { ...d.activity, days: d.activity.days.map((x) => ({ ...x, jobs: 0 })), topModel: null, topShare: null }, inflight: { calls: 0, screens: 0 } };
      await route.fulfill({ response: res, json: empty });
    });
    await openSettings(e, projectId, 'usage');
    await e.getByTestId('usage-totals').waitFor({ timeout: 15000 });
    const levels = await e.getByTestId('usage-day').evaluateAll((els) => els.map((x) => x.getAttribute('data-level')));
    expect(levels.length === 90 && levels.every((l) => l === '0'), `⑦ 日历应全是 0 档：${JSON.stringify([...new Set(levels)])}`);
    for (const id of ['usage-daily', 'usage-models', 'usage-projects', 'usage-kinds']) expect((await e.getByTestId(id).innerText()).includes('还没有用量'), `⑦ 「${id}」应写「还没有用量」：${flat(await e.getByTestId(id).innerText())}`);
    expect((await e.getByTestId('usage-error').count()) === 0 && (await e.locator('[data-testid="toast"][data-kind="error"]').count()) === 0, '⑦ 没有用量不该报错');
    page = e;
  });
  // 8 读取失败：「用量」写失败与「重试」，「模型」照常；放开后重试出看板
  await S.check(async () => {
    const { pg: f } = await openContext();
    const fail = /\/v1\/me\/usage\/stats/;
    await f.route(fail, (route) => route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: '/errors/internal', title: '服务内部错误', status: 500 }) }));
    await openSettings(f, projectId, 'usage');
    const err = f.getByTestId('usage-error');
    await err.waitFor({ timeout: 15000 });
    expect((await err.innerText()).includes('用量没读出来') && (await err.getByRole('button', { name: '重试' }).count()) === 1, `⑧ 「用量」应写读取失败并给「重试」：${flat(await err.innerText())}`);
    await f.getByTestId('settings-tab-models').click();
    await f.getByTestId('channel-manager').waitFor({ timeout: 10000 });
    await f.getByTestId('add-channel').waitFor({ timeout: 10000 });
    await f.unroute(fail);
    await f.getByTestId('settings-tab-usage').click();
    await f.getByTestId('usage-error').getByRole('button', { name: '重试' }).click();
    await f.getByTestId('usage-totals').waitFor({ timeout: 10000 });
    expect((await f.getByTestId('usage-error').count()) === 0, '⑧ 重试后错误条应撤掉');
    page = f;
  });
  // 9 导出一次再重开：「任务类型」里「导出」那行是一整条中性灰，提示里不列模型
  await S.check(async () => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    expect(r.status === 202 && (await waitJob(r.body.job.id, 120)).status === 'succeeded', `⑨ 导出 UsageA 没成功：${r.status}`);
    const { pg: g } = await openContext();
    await openSettings(g, projectId, 'usage');
    const row = g.getByTestId('usage-kind-row').filter({ hasText: '导出' });
    await row.waitFor({ timeout: 15000 });
    const bar = await row.locator('.usage-fill i').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), bg: getComputedStyle(e).backgroundColor }; }));
    const axis = await g.evaluate(() => { const i = document.createElement('i'); i.style.background = 'var(--semantic-color-data-viz-axis)'; document.body.append(i); const c = getComputedStyle(i).backgroundColor; i.remove(); return c; });
    expect(bar.length === 1 && bar[0].w > 0 && bar[0].bg === axis, `⑨ 「导出」应是一整条中性灰（${axis}）：${JSON.stringify(bar)}`);
    await row.hover();
    const tip = row.locator('.usage-tip');
    await eventually(async () => expect((await tip.evaluate((el) => getComputedStyle(el).opacity)) === '1', '⑨ 悬停后提示没出来'), 1000, 20);
    const text = bare(await tip.textContent());
    expect(!/Stub A|Old Model/.test(text) && text.includes('合计'), `⑨ 提示里只该有合计、不列模型：${text}`);
    page = g;
  });
  S.done();
  return `日历 ${cols}×${rows}、今天 ${act.days.find((d) => d.date === today)?.jobs} 次；7 天 ${t.jobs} 次 ${fmtTokens(tokens)} Token；悬停、范围记忆、减弱动态、空态与失败重试都对`;
});

// TC-CORE-142 设置三节与旧地址（REQ-CORE-039、REQ-CORE-046、REQ-CORE-047、REQ-AGENT-002；PAGE-CANVAS 设置弹层）
await step('TC-CORE-142', async () => {
  const S = softly();
  const { pg } = await openContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  // 1 旧地址与不认识的值
  for (const [q, tab, url] of [['runners', 'models', 'models'], ['appearance', 'system', 'system'], ['language', 'system', 'system'], ['record', 'system', 'system'], ['xyz', 'usage', 'usage']] as const) {
    await openSettings(pg, demoId, q);
    await S.check(() => eventually(async () => expect((await selectedTab(pg)) === `settings-tab-${tab}` && new URL(pg.url()).searchParams.get('settings') === url, `① ?settings=${q} 应开「${tab}」、地址换成 settings=${url}：${await selectedTab(pg)} ${pg.url()}`), 5000));
  }
  // 2 「系统」三组：外观、语言、使用记录；选深色、选 English 当场生效、不刷新
  await openSettings(pg, demoId, 'system');
  await pg.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1; });
  const heads = (await pg.getByTestId('system').locator('section > h4').allInnerTexts()).map((s) => s.trim());
  await S.check(() => expect(JSON.stringify(heads) === JSON.stringify(['外观', '语言', '使用记录']), `② 三组小标题应依次是 外观 / 语言 / 使用记录：${JSON.stringify(heads)}`));
  await pg.getByTestId('theme-dark').click();
  await S.check(() => eventually(async () => expect((await htmlTheme(pg)) === 'dark', `② 选深色后 <html> 应带 data-theme=dark：${await htmlTheme(pg)}`), 3000));
  await pg.getByTestId('locale-en').click();
  await S.check(() => eventually(async () => expect(JSON.stringify(await tabTexts(pg)) === JSON.stringify(['Usage', 'Models', 'System']), `② 换 English 后左栏应是 Usage / Models / System：${JSON.stringify(await tabTexts(pg))}`), 3000));
  await S.check(async () => expect((await pg.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)) === 1, '② 换语言不该刷新页面'));
  // 3 焦点在左栏「用量」，连按两次 ↓：「系统」选中、地址 settings=system；右栏 150 ms 淡入
  await pg.getByTestId('settings-tab-usage').click();
  await pg.getByTestId('settings-tab-usage').focus();
  await pg.keyboard.press('ArrowDown');
  await sleep(150);
  await pg.keyboard.press('ArrowDown');
  await S.check(() => eventually(async () => expect((await selectedTab(pg)) === 'settings-tab-system' && pg.url().includes('settings=system'), `③ 两次 ↓ 后应选中「系统」、地址 settings=system：${await selectedTab(pg)} ${pg.url()}`), 3000));
  await S.check(async () => { const s = await styleOf(pg, '[data-testid="system"]'); expect(s.animationName === 'settings-in' && s.animationDuration === '0.15s', `③ 换节时右栏应有 150 ms 的淡入：${s.animationName} ${s.animationDuration}`); });
  // 4 「模型」最下面的 MCP 接入：两条命令，「复制」提示已复制
  await pg.getByTestId('settings-tab-models').click();
  const add = flat(await pg.getByTestId('mcp-add').innerText()); const codex = flat(await pg.getByTestId('codex-mcp-add').innerText());
  await S.check(() => expect(add === `claude mcp add --transport http quilt ${API}/mcp` && codex === `codex mcp add quilt --url ${API}/mcp`, `④ 两条 MCP 命令不对：${add} ｜ ${codex}`));
  await pg.getByTestId('mcp-add').locator('xpath=following-sibling::button').click();
  await S.check(() => pg.locator('[data-testid="toast"]', { hasText: 'Copied' }).waitFor({ timeout: 3000 }).catch(async () => { throw new Error(`④ 点「复制」应提示已复制：${(await pg.getByTestId('toast').allInnerTexts()).join(' | ') || '没有提示'}`); }));
  await S.check(async () => expect((await pg.evaluate(() => navigator.clipboard.readText())) === add, '④ 剪贴板里应是 claude mcp add 那条'));
  // 5 Esc 关闭 → 焦点在工具栏「设置」；从它打开落在「用量」，关闭后焦点回到它
  const onGear = () => eventually(async () => expect(await pg.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.tool) === 'settings', `焦点应在工具栏「设置」：${await pg.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`), 3000);
  await pg.keyboard.press('Escape');
  await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await S.check(() => onGear().catch((e) => { throw new Error(`⑤ 经地址打开、Esc 关闭后：${(e as Error).message}`); }));
  await pg.getByTestId('open-settings').click();
  await pg.getByTestId('settings-modal').waitFor({ timeout: 5000 });
  await S.check(async () => expect((await selectedTab(pg)) === 'settings-tab-usage' && pg.url().includes('settings=usage'), `⑤ 从工具栏打开应落在「用量」：${await selectedTab(pg)} ${pg.url()}`));
  await pg.keyboard.press('Escape');
  await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await S.check(() => onGear().catch((e) => { throw new Error(`⑤ 从工具栏打开、Esc 关闭后：${(e as Error).message}`); }));
  S.done();
  return '旧地址换新、三组与即时生效、方向键换节带淡入、MCP 命令可复制、焦点回到「设置」';
});

// TC-CORE-143 界面上「通道」都叫「模型」（REQ-CORE-011、REQ-CORE-013；§4 术语「通道」）
await step('TC-CORE-143', async () => {
  const S = softly();
  const look = async (locale: string, re: RegExp, sane: RegExp, want: { tab: string; add: string; manage: string }, no: string) => {
    const { pg } = await openContext({ locale });
    await openSettings(pg, demoId, 'models');
    await pg.getByTestId('channel-manager').waitFor({ timeout: 10000 });
    await pg.getByTestId('runner-row').first().waitFor({ timeout: 10000 });
    await sleep(300);
    const where: [string, string[]][] = [['「模型」节', await textHits(pg, re)]];
    await S.check(async () => expect(flat(await pg.getByTestId('settings-tab-models').innerText()) === want.tab && flat(await pg.getByTestId('add-channel').innerText()) === want.add, `${no} 左栏与按钮应写「${want.tab}」「${want.add}」：${await pg.getByTestId('settings-tab-models').innerText()} / ${await pg.getByTestId('add-channel').innerText()}`));
    await pg.getByTestId('add-channel').click();
    await pg.getByTestId('channel-dialog').waitFor({ timeout: 5000 });
    await sleep(300);
    where.push(['「添加模型」弹层', await textHits(pg, re)]);
    await pg.keyboard.press('Escape');
    await pg.getByTestId('channel-dialog').waitFor({ state: 'detached', timeout: 5000 });
    await pg.keyboard.press('Escape');
    await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await pg.getByTestId('runner-select').click();
    await pg.getByRole('listbox').waitFor({ timeout: 5000 });
    await sleep(300);
    where.push(['输入框的模型下拉', await textHits(pg, re)]);
    await S.check(async () => expect(flat(await pg.getByTestId('manage-channels').innerText()) === want.manage, `${no} 下拉底部应写「${want.manage}」：${await pg.getByTestId('manage-channels').innerText()}`));
    for (const [w, hits] of where) await S.check(() => expect(hits.length === 0, `${no} ${w}里还有 ${re}：${hits.slice(0, 8).join(' ｜ ')}`));
    // 量具自检：同一个扫描要扫得出「模型」/ model，上面的「没有」才算数
    await S.check(async () => expect((await textHits(pg, sane)).length > 0, `${no} 页面上扫不出 ${sane}：扫描本身失效`));
    await pg.keyboard.press('Escape');
  };
  // 1 中文：三处没有「通道」
  await look('zh-CN', /通道/, /模型/, { tab: '模型', add: '添加模型', manage: '管理模型…' }, '①');
  // 2 English：三处没有 channel
  await look('en-US', /channel/i, /model/i, { tab: 'Models', add: 'Add model', manage: 'Manage models…' }, '②');
  // 3 指定不存在的通道 id 建作业：404，标题里没有「通道」/ channel
  for (const [lang, re] of [['zh', /通道/], ['en', /channel/i]] as const) {
    const r = await apiJson<Problem>(`/v1/projects/${demoId}/jobs`, { method: 'POST', headers: { ...idem(), 'X-Quilt-Locale': lang }, body: JSON.stringify({ kind: 'generate', input: { prompt: '做一个登录页', count: 2, runner: { kind: 'channel', channelId: crypto.randomUUID() } } }) });
    await S.check(() => expect(r.status === 404 && !re.test(r.body.title) && !re.test(r.body.detail ?? ''), `③ ${lang}：应 404 且标题里没有 ${re}：${r.status} ${JSON.stringify(r.body)}`));
  }
  S.done();
  return '中英文三处都只写「模型」；404 的标题里没有通道';
});

const counts = summary();
await browser.close();
process.exit(counts['失败'] ? 1 : 0);
