import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { BrowserContext, Frame, Page } from 'playwright';
import sharp from 'sharp';
import { RESTYLE_PROMPT, DRAFT_PAD, SKETCH_GENERATOR_MARK, SKETCH_REFERENCE_IMAGE_NOTE, SUBTREE_BLOCKS_HEADER, draftNameFromPrompt, forkDraftName, forkBody, extractBody, buildPrelude, quiltBlock, quiltBlocks, type Tokens } from '@quilt/core';
import { launch, seed, seedJson, apiJson, assertTestApi, localFetch, pickOption, selectedValue, eventually, EVIDENCE, WEB, API } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { startOpenAiStub, type StubHit } from './openai-stub.ts';
import { suite, expect, softly, sleep, waitJob, Skip, type JobView } from './harness.ts';

// docs/TEST.md「CORE · 草稿本」TC-CORE-098～118（REQ-CORE-040～045，v1.13 / v1.14）AI 执行脚本；TC-CORE-112～118（写回与参照）只走接口、MCP 与假会话。
// 接口级的用例走 stub 驱动（runner 显式写 STUB）：这句话第二行的 [stub-frame:…] 定画框、[stub-script] 让草稿带 <script> 与 <style>、
// [stub-hold:<毫秒>] 拖住作业、[stub-patch-miss] 让改稿的补丁对不上——标记放第二行，草稿名只取第一行。
// 浏览器用例从输入框发，输入框用 OpenAI 兼容桩通道「草稿桩」（3961）：它按这句话回固定的草稿 HTML（播放器控制条、记账首页、官网首页），
// 画框与尺寸都由脚本定，走查截图可复现。TC-CORE-099 要「从没打开过草稿本、只有 2 个示例项目」，排在最前；走查 TC-CORE-111 自带复位，排在最后。
await assertTestApi();
const health = (await (await fetch(`${API}/v1/health`)).json()) as { llm?: string; database?: string };
if (health.llm !== 'stub') { console.log(`❌ TC-CORE-098～111 阻塞：API 不是 stub 驱动（当前 ${health.llm}），草稿的内容与画框靠 stub 标记定`); process.exit(2); }
await mkdir(EVIDENCE, { recursive: true });

let page: Page;
let ctx: BrowserContext;
const { RUN, cleanups, step, summary } = suite('SKETCH', {
  page: () => page,
  onTimeout: async () => { await page.close().catch(() => {}); page = await ctx.newPage(); },
});

const STUB = { kind: 'model', driver: 'stub', model: 'stub' } as const;
const FAKE = '00000000-0000-4000-8000-000000000000';
const STUB_PORT = 3961;
const STUB_LABEL = '草稿桩';

// ---------- 草稿桩：按这句话回固定的草稿 ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
// 播放器控制条：组件画框，根宽 360 px；第二版按钮变圆、多一条音量滑块
const PLAYER = (v2: boolean) => `<div data-frame="component" style="width:360px" class="rounded-2xl bg-zinc-900/90 text-white p-4 flex flex-col gap-3 shadow-2xl ring-1 ring-white/10">
<div class="flex items-center gap-3"><div class="w-12 h-12 rounded-lg bg-gradient-to-br from-fuchsia-500 to-indigo-500"></div><div class="flex-1 min-w-0"><p class="text-sm font-semibold truncate">夜航星</p><p class="text-xs text-zinc-400">不才 · 2:41 / 4:05</p></div>
${['skip-back', 'pause', 'skip-forward'].map((i) => `<button type="button" class="w-9 h-9 ${v2 ? 'rounded-full' : 'rounded-md'} ${i === 'pause' ? 'bg-white text-zinc-900' : 'bg-white/10'} flex items-center justify-center"><i data-lucide="${i}" class="w-4 h-4"></i></button>`).join('')}</div>
${v2 ? '<label class="flex items-center gap-2 text-xs text-zinc-400"><i data-lucide="volume-2" class="w-4 h-4"></i><input type="range" aria-label="音量" min="0" max="100" value="64" class="flex-1 accent-fuchsia-500"></label>' : ''}
</div>`;
// 记账 App 首页：手机页
const LEDGER = `<div data-frame="mobile" class="min-h-dvh bg-slate-50 text-slate-900">
<header class="px-5 pt-8 pb-5 bg-emerald-600 text-white"><p class="text-sm opacity-80">十月账本</p><h1 class="text-3xl font-semibold tabular-nums">¥3,486.50</h1><p class="text-sm opacity-80">本月支出 · 预算 ¥5,000</p></header>
<section class="px-5 py-4 space-y-3"><h2 class="text-sm font-semibold text-slate-500">今天</h2>
${[['午饭 · 兰州拉面', '¥32.00'], ['地铁', '¥4.00'], ['咖啡', '¥28.00']].map(([n, v]) => `<div class="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm"><span class="text-sm">${n}</span><span class="text-sm font-semibold tabular-nums">${v}</span></div>`).join('')}
</section><a href="#" class="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-lg"><i data-lucide="plus" class="w-6 h-6"></i></a>
</div>`;
// 产品官网首页：桌面页
const LANDING = `<div data-frame="desktop" class="min-h-dvh bg-white text-zinc-900">
<header class="h-16 px-10 flex items-center justify-between border-b border-zinc-200"><span class="font-semibold">Northwind</span><nav class="flex gap-8 text-sm text-zinc-600"><a href="#">产品</a><a href="#">价格</a><a href="#">博客</a></nav></header>
<section class="px-10 py-24 max-w-3xl"><h1 class="text-5xl font-semibold tracking-tight">让每一次发货都准时</h1><p class="mt-4 text-lg text-zinc-600">从下单到签收，一张面板看全。</p><a href="#" class="mt-8 inline-flex h-11 px-6 items-center rounded-md bg-zinc-900 text-white">免费试用 14 天</a></section>
</div>`;
// 带一个收起的底部抽屉的账单页（TC-CORE-158）：抽屉的遮罩是全屏、全透明，父层 pointer-events:none 放行点击
const DRAWER = `<div data-frame="mobile" class="min-h-dvh bg-stone-100 text-stone-900 p-6 space-y-4">
<h1 class="text-2xl font-semibold">本月账单</h1><p class="text-sm text-stone-500">点「筛选」打开底部抽屉</p>
<button type="button" class="h-10 px-4 rounded-full bg-stone-900 text-white">筛选</button>
<div class="fixed inset-0 z-50 pointer-events-none"><div class="absolute inset-0 bg-black/40 opacity-0"></div><div class="absolute inset-x-0 bottom-0 translate-y-full rounded-t-3xl bg-white p-6"><p>筛选条件</p></div></div>
</div>`;
// 一屏放不下的长列表（TC-CORE-160）：30 行，选元素时滚动草稿
const LONGLIST = `<div data-frame="mobile" class="min-h-dvh bg-white text-zinc-900 p-6"><h1 class="text-2xl font-semibold">全部账单</h1>
${Array.from({ length: 30 }, (_, i) => `<p class="py-3 border-b border-zinc-100 text-sm">第 ${i + 1} 笔 · ¥${(i + 1) * 12}.00</p>`).join('\n')}
</div>`;
// 交给本机会话时，脚本扮演会话写的草稿：写死的色值、没有设计系统
const WEATHER = '<div data-frame="mobile" class="min-h-dvh bg-[#0b1020] text-white p-6 space-y-2"><h1 class="text-2xl font-semibold">东京</h1><p class="text-6xl font-light">18°</p><p class="text-sm text-[#9fb3ff]">多云 · 体感 16°</p></div>';
const LOGIN = '<form data-frame="component" style="width:320px" class="rounded-xl bg-white p-6 space-y-3 shadow-lg"><h1 class="text-lg font-semibold">登录</h1><input class="w-full h-10 px-3 rounded-md border border-[#d4d4d8]" placeholder="邮箱"><button type="button" class="w-full h-10 rounded-md bg-[#18181b] text-white">继续</button></form>';

// 新草稿的用户提示就是这句话；改稿的用户提示以「Revise the screen」开头、第二行是指令、最后是 CURRENT HTML（contract.ts editPatchUserPrompt）
const instrOf = (hit: StubHit) => (hit.user.startsWith('Revise the screen') ? hit.user.split('\n')[1] ?? '' : hit.user);
function draftReply(hit: StubHit): string {
  if (hit.user === 'ping') return 'OK';
  // 一次改几块（v1.26，subtreeBlocksUserPrompt）：每块原样回，根元素加 data-stub="multi"、开标签后接「已改 · 」；
  // [stub-blocks-miss] 每次都少回最后一块（补问那一轮同样少）。调用次数与提示词照常记在 draftStub.hits，按 user 里有没有 SUBTREE_BLOCKS_HEADER 认
  const asked = hit.user.split(`\n${SUBTREE_BLOCKS_HEADER}\n`)[1];
  if (asked !== undefined) {
    const blocks = quiltBlocks(asked).map((b) => quiltBlock(b.qid, b.html.replace(/^(<[a-zA-Z][\w-]*)([^>]*>)/, '$1 data-stub="multi"$2已改 · ')));
    return (hit.user.includes('[stub-blocks-miss]') ? blocks.slice(0, -1) : blocks).join('\n');
  }
  const instr = instrOf(hit);
  if (instr.includes('迷你控制条')) return PLAYER(false);
  if (instr.includes('圆形')) return PLAYER(true);
  if (instr.includes('记账')) return LEDGER;
  if (instr.includes('官网')) return LANDING;
  if (instr.includes('抽屉')) return DRAWER;
  if (instr.includes('长列表')) return LONGLIST;
  const size = /\[size:(\d+)x(\d+)\]/.exec(instr);
  if (size) return `<div style="width:${size[1]}px;height:${size[2]}px;background:#0b1020"></div>`;
  const current = hit.user.split('\nCURRENT HTML:\n')[1];
  if (current) { const i = current.lastIndexOf('</'); return `${current.slice(0, i)}<p class="text-xs opacity-60">改过：${esc(instr.slice(0, 16))}</p>${current.slice(i)}`; }
  return `<div data-frame="component" style="width:280px" class="rounded-xl bg-white p-4 shadow ring-1 ring-black/5"><p class="text-sm font-semibold">${esc(instr.split('\n')[0].slice(0, 20))}</p></div>`;
}
// 这句话带「慢」就拖 6 s（造「还在生成」的那一阵），带 [fail] 就回 400（不重试的供应商错误）；其余 1.5 s，骨架看得见
const draftStub = startOpenAiStub({
  port: STUB_PORT, apiKey: `good-key-${STUB_PORT}`, reply: draftReply,
  holdMs: (hit) => (hit.user === 'ping' ? 0 : instrOf(hit).includes('慢') ? 6000 : 1500),
  fail: (hit) => (instrOf(hit).includes('[fail]') ? 400 : null),
});
let channelId = '';
const CHANNEL = () => ({ kind: 'channel', channelId });
// 桩通道（§3 种子会删通道）：没有就建并验证，有就沿用
async function ensureChannel(): Promise<void> {
  const found = (await apiJson<{ items: { id: string; label: string }[] }>('/v1/channels')).body.items.find((c) => c.label === STUB_LABEL);
  if (found) { channelId = found.id; return; }
  const c = await apiJson<{ channel?: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: STUB_LABEL, endpoint: draftStub.url, model: 'stub-sketch', apiKey: `good-key-${STUB_PORT}` }) });
  expect(c.body.channel?.id, `建桩通道失败：${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  channelId = c.body.channel!.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${channelId}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
}

// ---------- 接口助手 ----------
type Screen = { id: string; projectId: string; name: string; route: string; x: number; currentRevisionId: string | null; currentRevisionSeq: number | null; screenshotUrl: string | null; frame: string | null; refProjectId: string | null; targetScreenId: string | null; targetQid: string | null; target: { projectId: string; projectName: string; screenName: string } | null };
type Component = { id: string; name: string; html: string; version: number };
type Detail = { project: { id: string; name: string; kind: string; deviceType: string }; designSystem: { version: number; tokens: Tokens; designMd: string }; screens: Screen[]; components: Component[]; activeJobs: { id: string }[] };
type Rev = { id: string; seq: number; sourceKind: string; jobId: string | null; parentRevisionId: string | null; htmlUrl: string; lintReport: { violations?: unknown[] } | null };
type Problem = { type?: string; title?: string; errors?: { path?: unknown; message?: string }[] };
type CopyResult = { screen?: Screen; component?: Component; job?: JobView; revisionId?: string; previousRevisionId?: string } & Problem;

const post = async <T = Record<string, unknown>>(p: string, body: unknown) => {
  for (let i = 0; ; i++) {
    const r = await apiJson<T>(p, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
    if (r.status !== 429 || i >= 15) return r;
    await sleep(5000);
  }
};
const detail = async (pid: string) => (await apiJson<Detail>(`/v1/projects/${pid}`)).body;
const sketchbook = async () => { const r = await apiJson<{ projectId: string }>('/v1/sketchbook'); expect(r.status === 200 && !!r.body.projectId, `GET /v1/sketchbook ${r.status}`); return r.body.projectId; };
const revisions = async (sid: string) => (await apiJson<{ items: Rev[] }>(`/v1/screens/${sid}/revisions`)).body.items;
// 只比语义：去掉 qid、合并空白
const bodyOf = (html: string) => (html.split('<body')[1] ?? '').replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '').replace(/\s+/g, ' ').trim();
const revBody = async (rev: Rev) => bodyOf(await (await fetch(rev.htmlUrl)).text());
const revHtml = async (rev: Rev) => (await fetch(rev.htmlUrl)).text();
const jobsOf = async (pid: string) => (await apiJson<{ items: JobView[] }>(`/v1/projects/${pid}/jobs?limit=100`)).body.items;
const messagesOf = async (pid: string) => (await apiJson<{ items: { role: string; jobId: string | null }[] }>(`/v1/projects/${pid}/messages?limit=100`)).body.items;
const seedProject = (name: string, device: 'mobile' | 'desktop', screens: number) => seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', name, '--device', device, '--screens', String(screens), '--no-shot');
const paths = (b: Problem) => JSON.stringify(b.errors ?? []);
const shotPixels = async (url: string) => { const m = await sharp(Buffer.from(await (await localFetch(url)).arrayBuffer())).metadata(); return { w: m.width, h: m.height }; };
/** 当前修订的截图尺寸（等截图拍好）；want 给了就等到尺寸对上为止（改画框后的重拍） */
async function shotSize(sb: string, id: string, want?: { w: number; h: number }, ms = 30000): Promise<{ w: number; h: number }> {
  let got = { w: 0, h: 0 };
  await eventually(async () => {
    const s = (await detail(sb)).screens.find((x) => x.id === id);
    expect(s?.screenshotUrl, `草稿 ${id.slice(0, 8)} 的截图还没拍好`);
    got = await shotPixels(s!.screenshotUrl!);
    if (want) expect(got.w === want.w && got.h === want.h, `截图 ${got.w}×${got.h}，应为 ${want.w}×${want.h}`);
  }, ms, 500);
  return got;
}
/** 出一张新草稿并等作业结束；runner 缺省 stub 驱动 */
async function newDraft(sb: string, content: string, opts: { frame?: string; runner?: unknown; refProjectId?: string } = {}): Promise<{ id: string; job: JobView }> {
  const r = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content, frame: opts.frame, runner: opts.runner ?? STUB, refProjectId: opts.refProjectId });
  expect(r.status === 202, `出新草稿 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await waitJob(r.body.job.id, 120);
  const id = (job.output?.screenIds as string[] | undefined)?.[0];
  expect(job.status === 'succeeded' && id, `新草稿作业 ${job.status}：${JSON.stringify(job.output).slice(0, 200)}`);
  return { id: id!, job };
}
async function editDraft(sb: string, id: string, content: string, runner: unknown = STUB): Promise<JobView> {
  const r = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content, targetScreenIds: [id], runner });
  expect(r.status === 202, `改草稿 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await waitJob(r.body.job.id, 120);
  expect(job.status === 'succeeded', `改草稿作业 ${job.status}：${JSON.stringify(job.output).slice(0, 200)}`);
  return job;
}
/** 等新草稿建出屏行（screen_planned 之后、第一版落库之前），返回它的 id */
async function plannedDraft(sb: string, before: string[]): Promise<string> {
  let id = '';
  await eventually(async () => { const s = (await detail(sb)).screens.find((x) => !before.includes(x.id)); expect(s, '新草稿的屏行还没建出来'); id = s!.id; }, 10000, 200);
  return id;
}
// 库里的行数（TC-CORE-098 的「只有一行」）：docker 里的 quilt-pg，按被测 API 的库名
const psql = (q: string) => execFileSync('docker', ['exec', 'quilt-pg', 'psql', '-U', 'quilt', '-d', health.database ?? '', '-Atc', q], { encoding: 'utf8' }).trim();

// ---------- 浏览器助手 ----------
const openSketch = async (d?: string, pg: Page = page) => { await pg.goto(`${WEB}/sketch${d ? `?d=${d}` : ''}`); await pg.getByTestId('sketch-page').waitFor({ timeout: 15000 }); };
const stageState = (pg: Page = page) => pg.getByTestId('sketch-stage').getAttribute('data-state');
const waitStage = (state: string, ms = 15000, pg: Page = page) => eventually(async () => expect((await stageState(pg)) === state, `看板应为 ${state}，实际 ${await stageState(pg)}`), ms, 100);
const openDraftId = (pg: Page = page) => pg.getByTestId('draft-view').getAttribute('data-draft-id');
const urlDraft = (pg: Page = page) => new URL(pg.url()).searchParams.get('d');
const railIds = (pg: Page = page) => pg.getByTestId('rail-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-draft-id')));
const railItem = (id: string, pg: Page = page) => pg.locator(`[data-testid="rail-item"][data-draft-id="${id}"]`);
async function draftFrame(pg: Page = page): Promise<Frame> {
  const h = await pg.getByTestId('draft-iframe').elementHandle({ timeout: 15000 });
  const f = await h?.contentFrame();
  expect(f, '草稿 iframe 没有文档');
  await f!.waitForSelector('body *', { timeout: 15000 });
  return f!;
}
// 草稿根（body 下第一个会渲染的元素）的框，iframe 内坐标
const rootBox = (f: Frame) => f.evaluate(() => { let r = document.body.firstElementChild; while (r && /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(r.tagName)) r = r.nextElementSibling; const b = r!.getBoundingClientRect(); return { w: b.width, h: b.height, vw: innerWidth, vh: innerHeight }; });
/** 输入框发一句，返回作业 id */
async function sendFromComposer(text: string, pg: Page = page): Promise<string> {
  await pg.getByTestId('composer-input').fill(text);
  const resp = pg.waitForResponse((r) => /\/v1\/projects\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 10000 });
  await pg.getByTestId('composer-send').click();
  const r = await resp;
  expect(r.status() === 202, `发送返回 ${r.status()}：${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { job: { id: string } }).job.id;
}
// 发送被挡：发送键禁用、点了与按 Enter 都不发请求、字留在输入框、上方写原因
async function expectSendBlocked(text: string, reason: RegExp, pg: Page = page): Promise<string> {
  await pg.getByTestId('composer-input').fill(text);
  const send = pg.getByTestId('composer-send');
  const disabled = (await send.getAttribute('aria-disabled')) === 'true' || (await send.isDisabled());
  expect(disabled, '发送键应禁用');
  let posted = false;
  const onReq = (r: import('playwright').Request) => { if (r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname)) posted = true; };
  pg.on('request', onReq);
  await send.click({ force: true }).catch(() => {});
  await pg.getByTestId('composer-input').press('Enter');
  await sleep(800);
  pg.off('request', onReq);
  expect(!posted, '发送被挡时不该发出 POST messages');
  expect((await pg.getByTestId('composer-input').inputValue()) === text, '被挡时输入框里的字应保留');
  const why = await pg.getByTestId('send-blocked-reason').innerText();
  expect(reason.test(why), `挡住的原因不对：「${why}」`);
  return why;
}
// 选项组（画框、落成方式）：分段按钮里直接点 data-value；做成下拉的就先展开再点选项
const chosen = (testid: string, pg: Page = page) => pg.getByTestId(testid).evaluate((el) => el.getAttribute('data-value') ?? el.querySelector('[data-value][aria-checked="true"], [data-value][aria-pressed="true"], [data-value][data-state="on"], [data-value][data-state="checked"], [data-value][aria-selected="true"]')?.getAttribute('data-value') ?? null);
async function choose(testid: string, value: string, pg: Page = page): Promise<void> {
  const root = pg.getByTestId(testid);
  const inner = root.locator(`[data-value="${value}"]`);
  if (await inner.count()) await inner.first().click();
  else { await root.click(); await pg.locator(`[role="option"][data-value="${value}"], [role="menuitemradio"][data-value="${value}"]`).first().click(); }
  await eventually(async () => expect((await chosen(testid, pg)) === value, `${testid} 没选上 ${value}：${await chosen(testid, pg)}`), 3000);
}
// 输入框的通道：要从输入框发一轮的用例都用桩通道
async function useStubRunner(pg: Page = page): Promise<void> {
  const sel = '[data-testid="runner-select"]';
  await pg.locator(sel).waitFor({ timeout: 10000 });
  if ((await selectedValue(pg, sel)) !== `channel:${channelId}`) await pickOption(pg, sel, STUB_LABEL);
  await eventually(async () => expect((await selectedValue(pg, sel)) === `channel:${channelId}`, `输入框没选上「${STUB_LABEL}」`));
}
// 组件草稿每落一版都会重载、再报一次尺寸，框随之变大变小、重新居中：等布局尺寸等于「根元素的框 + 四周透明边」、且隔 150 ms 量两次显示框不变再点，
// 否则按过渡中的框算出的点击点，点下去时已落在别处
async function settledComponent(pg: Page = page): Promise<void> {
  await eventually(async () => {
    const root = await rootBox(await draftFrame(pg));
    const fr = pg.getByTestId('draft-iframe');
    const laid = await fr.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
    const a = (await fr.boundingBox())!;
    await sleep(150);
    const b = (await fr.boundingBox())!;
    const still = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
    expect(Math.abs(laid.w - root.w - 2 * DRAFT_PAD) <= 2 && Math.abs(laid.h - root.h - 2 * DRAFT_PAD) <= 2 && still, `组件草稿的框还没稳：布局 ${laid.w}×${laid.h}，根 ${root.w}×${root.h}，显示框 ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }, 15000, 100);
}
// 点缩放过的 iframe 里的元素：看板与写回弹层的活预览都按 transform 等比缩小，Playwright 在 iframe 里算点击点时不乘这个缩放，会点到别的元素上。
// 这里按 iframe 的实际显示框与布局尺寸换算，再用鼠标在页面上点
async function clickInScaled(iframeSel: string, target: import('playwright').Locator, pg: Page = page): Promise<void> {
  const c = await target.evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const frame = pg.locator(iframeSel).first();
  const shown = (await frame.boundingBox())!;
  const laid = await frame.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
  await pg.mouse.click(shown.x + c.x * (shown.width / laid.w), shown.y + c.y * (shown.height / laid.h));
}
const box = async (testid: string, pg: Page = page) => { const b = await pg.getByTestId(testid).first().boundingBox(); expect(b, `${testid} 不在页面上`); return b!; };

seed('seed');
await ensureChannel();
const browser = await launch();
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
page = await ctx.newPage();

// ---------- TC-CORE-099 第一次打开草稿本；草稿本不进项目列表与入口落点（INV-CORE-002） ----------
await step('TC-CORE-099', async () => {
  type P = { id: string; name: string; kind?: string };
  const list = async () => (await apiJson<{ items: P[] }>('/v1/projects')).body.items;
  const before = await list();
  expect(before.length === 2 && before.every((p) => p.kind === 'app'), `种子之后应只有 2 个普通项目：${JSON.stringify(before.map((p) => [p.name, p.kind]))}`);
  const demo = before.find((p) => p.name === 'Demo Mobile')!;
  const desk = before.find((p) => p.name === 'Demo Desktop')!;
  // 1 画布的项目切换器菜单顶部固定一条「草稿本」
  await page.goto(`${WEB}/p/${demo.id}`);
  await page.getByTestId('project-switcher').click();
  const menu = page.getByTestId('project-switcher-list');
  const entry = menu.getByTestId('sketchbook-entry');
  await entry.waitFor({ timeout: 5000 });
  const firstOption = await menu.getByTestId('project-option').first().boundingBox();
  expect(firstOption && (await entry.boundingBox())!.y < firstOption.y, '「草稿本」应在项目列表之上');
  await entry.click();
  await page.waitForURL(/\/sketch(\?|$)/, { timeout: 10000 });
  await page.getByTestId('sketch-page').waitFor({ timeout: 10000 });
  expect((await page.title()) === '草稿本 · Quilt', `标签页标题「${await page.title()}」`);
  await waitStage('empty');
  expect(await page.getByTestId('sketch-empty').isVisible(), '空看板应有提示');
  expect((await page.getByTestId('rail-item').count()) === 0, '记录栏应为空');
  expect(urlDraft() === null, '地址里不该有 d');
  // 2 列表仍只有那 2 个
  const after = await list();
  expect(after.length === 2 && after.every((p) => before.some((b) => b.id === p.id)), `打开草稿本后项目列表变了：${JSON.stringify(after.map((p) => p.name))}`);
  // 3 草稿本成了最近更新的，列表、MCP 仍不列它
  const sb = await sketchbook();
  await newDraft(sb, '一张天气卡片\n[stub-frame:component]');
  const listed = await list();
  expect(listed.length === 2 && !listed.some((p) => p.id === sb || p.kind === 'sketchbook'), `出过草稿后项目列表里出现了草稿本：${JSON.stringify(listed.map((p) => p.name))}`);
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const mcpList = await callTool(mcp, 'quilt.list_projects', {});
  expect(!mcpList.isError && !mcpList.text.includes(sb) && (mcpList.json as P[]).length === 2, `quilt.list_projects 不该列草稿本：${mcpList.text.slice(0, 200)}`);
  // 4 入口 / 落到普通项目
  await page.goto(`${WEB}/`);
  await page.waitForURL(/\/p\/[0-9a-f-]{36}/, { timeout: 15000 });
  const landed = page.url().match(/\/p\/([0-9a-f-]{36})/)![1];
  expect(landed !== sb && before.some((p) => p.id === landed), `入口落到了 ${landed}（草稿本 ${sb}）`);
  // 5 /p/<草稿本 id> 重定向到 /sketch
  await page.goto(`${WEB}/p/${sb}`);
  await page.waitForURL(/\/sketch(\?|$)/, { timeout: 10000 });
  // 6 草稿本页的切换器：列项目与「新建项目…」，选一个回到它的画布
  await page.getByTestId('sketch-page').waitFor({ timeout: 10000 });
  expect((await page.getByTestId('project-switcher').innerText()).includes('草稿本'), '草稿本页的切换器 chip 应写「草稿本」');
  await page.getByTestId('project-switcher').click();
  // 列表在菜单打开后才取（API-CORE-005）
  await eventually(async () => expect((await page.getByTestId('project-switcher-list').getByTestId('project-option').count()) > 0, '切换器列表没出来'), 5000, 100);
  const names = await page.getByTestId('project-switcher-list').getByTestId('project-option').allInnerTexts();
  expect(names.length === 2 && names.some((n) => n.includes('Demo Mobile')) && names.some((n) => n.includes('Demo Desktop')), `切换器里的项目不对：${JSON.stringify(names)}`);
  expect(await page.getByTestId('project-switcher-list').getByText('新建项目').first().isVisible(), '切换器里应有「新建项目…」');
  await page.getByTestId('project-switcher-list').getByTestId('project-option').filter({ hasText: 'Demo Desktop' }).click();
  await page.waitForURL(new RegExp(`/p/${desk.id}`), { timeout: 10000 });
  return `入口、空看板、列表 2 个、MCP 2 个、/ 落到 ${landed === demo.id ? 'Demo Mobile' : 'Demo Desktop'}、/p/<草稿本> 重定向`;
});

// ---------- TC-CORE-098 取回草稿本：第一次建、同时取只建一个、删了再建（INV-CORE-001） ----------
await step('TC-CORE-098', async () => {
  try { psql('select 1'); } catch (e) { throw new Error(`环境：连不上 docker 里的 quilt-pg，核不了库内行数（${(e as Error).message.split('\n')[0]}）`); }
  const rows = () => Number(psql(`select count(*) from projects where kind = 'sketchbook'`));
  // 前置：库里没有草稿本
  const old = await sketchbook();
  expect((await apiJson(`/v1/projects/${old}`, { method: 'DELETE' })).status === 204, '前置删草稿本失败');
  expect(rows() === 0, `删掉后库里还有 ${rows()} 行草稿本`);
  // 1 五个请求同时第一次到达
  const all = await Promise.all(Array.from({ length: 5 }, () => apiJson<{ projectId: string }>('/v1/sketchbook')));
  expect(all.every((r) => r.status === 200), `同时取：状态 ${all.map((r) => r.status).join(',')}`);
  const ids = new Set(all.map((r) => r.body.projectId));
  expect(ids.size === 1, `同时取拿到了 ${ids.size} 个不同的 projectId`);
  const sb = [...ids][0];
  expect(rows() === 1, `库里有 ${rows()} 行草稿本，应为 1`);
  expect(all[0].headers.get('cache-control')?.includes('no-store'), `GET /v1/sketchbook 应 no-store：${all[0].headers.get('cache-control')}`);
  // 2 建出来的是空草稿本
  const d = await detail(sb);
  expect(d.project.kind === 'sketchbook' && d.project.name === '草稿本' && d.project.deviceType === 'mobile' && d.screens.length === 0, `新草稿本不对：${JSON.stringify(d.project)} 屏 ${d.screens.length}`);
  // 3 再取、经 MCP 取，都是同一个
  expect((await sketchbook()) === sb, '再取换了 projectId');
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const viaMcp = await callTool(mcp, 'quilt.get_sketchbook', {});
  expect(!viaMcp.isError && (viaMcp.json as { projectId: string }).projectId === sb, `quilt.get_sketchbook：${viaMcp.text.slice(0, 200)}`);
  // 4 删了再取，建一个新的空草稿本
  expect((await apiJson(`/v1/projects/${sb}`, { method: 'DELETE' })).status === 204, '删草稿本应 204');
  const again = await sketchbook();
  expect(again !== sb && (await detail(again)).screens.length === 0 && rows() === 1, `删了再取：${again}（旧 ${sb}），行数 ${rows()}`);
  return '同时 5 个请求同一个 id、库里 1 行、MCP 同 id、删了再建';
});

// ---------- TC-CORE-102 草稿本只受理单屏单版的造与改（INV-CORE-003） ----------
await step('TC-CORE-102', async () => {
  const sb = await sketchbook();
  const a = await newDraft(sb, '草稿甲\n[stub-frame:component]');
  const b = await newDraft(sb, '草稿乙\n[stub-frame:component]');
  const jobs0 = (await jobsOf(sb)).length;
  const msgs0 = (await messagesOf(sb)).length;
  // 1 逐个非法参数：400 并点名字段，不建作业、不写消息
  const bad: [string, Record<string, unknown>][] = [
    ['count', { count: 3 }], ['versions', { versions: 2 }], ['mode', { mode: 'chat' }], ['targetComponentIds', { targetComponentIds: [FAKE] }],
    ['anchor', { anchor: { x: 0, y: 0 } }], ['variantOf', { variantOf: a.id, variantName: 'Empty' }], ['route', { route: '/x' }],
    ['preset', { preset: 'link_repair', targetScreenIds: [a.id] }], ['targetScreenIds', { targetScreenIds: [a.id, b.id] }],
  ];
  const wrong: string[] = [];
  for (const [field, extra] of bad) {
    const r = await post<Problem>(`/v1/projects/${sb}/messages`, { content: '随便', runner: STUB, ...extra });
    if (r.status !== 400 || r.body.type !== '/errors/validation' || !paths(r.body).includes(field)) wrong.push(`${field}→${r.status} ${r.body.type} ${paths(r.body).slice(0, 80)}`);
  }
  expect(!wrong.length, `非法参数没有逐个 400 点名：${wrong.join('；')}`);
  expect((await jobsOf(sb)).length === jobs0 && (await messagesOf(sb)).length === msgs0, '被拒的请求建了作业或写了消息');
  // 2 普通项目带 frame
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
  const nf = await post<Problem>(`/v1/projects/${demo.id}/messages`, { content: '一张卡片', frame: 'component', runner: STUB });
  expect(nf.status === 400 && nf.body.type === '/errors/validation' && paths(nf.body).includes('frame'), `普通项目带 frame 应 400：${nf.status} ${paths(nf.body)}`);
  // 3 建作业接口与 MCP 走同一份校验
  const viaJobs = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'generate', input: { prompt: '随便', count: 2, runner: STUB } });
  expect(viaJobs.status === 400 && viaJobs.body.type === '/errors/validation', `POST jobs count=2 应 400：${viaJobs.status}`);
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const viaMcp = await callTool(mcp, 'quilt.generate_screens', { projectId: sb, prompt: '随便', versions: 2, runner: STUB });
  expect(viaMcp.isError && (viaMcp.json as Problem).type === '/errors/validation', `MCP generate_screens versions=2 应拒：${viaMcp.text.slice(0, 200)}`);
  expect((await jobsOf(sb)).length === jobs0, '被拒的建作业留下了作业');
  // 4 合法的新草稿：一屏一版，名字取第一行前 20 个字，路由 /draft-<n>，不做设计契约 lint
  const before = (await detail(sb)).screens.map((s) => s.id);
  const long = '一二三四五六七八九十一二三四五六七八九十多出来的字';
  const c = await newDraft(sb, `${long}\n[stub-frame:component]`);
  expect(c.job.kind === 'generate' && (c.job.input.count ?? 1) === 1 && (c.job.input.versions ?? 1) === 1, `新草稿作业输入：${JSON.stringify(c.job.input).slice(0, 200)}`);
  const d = await detail(sb);
  const added = d.screens.filter((s) => !before.includes(s.id));
  const cs = d.screens.find((s) => s.id === c.id)!;
  expect(added.length === 1 && (c.job.output.screenIds as string[]).length === 1, `新草稿应恰好 1 屏，实际 ${added.length}`);
  expect(cs.name === draftNameFromPrompt(long) && cs.name.length === 20 && /^\/draft-\d+$/.test(cs.route), `名字 / 路由：${cs.name} ${cs.route}`);
  const r1 = await revisions(c.id);
  expect(r1.length === 1 && r1[0].sourceKind === 'generate' && (r1[0].lintReport?.violations ?? []).length === 0, `新草稿修订：${r1.length} 条 ${r1[0]?.sourceKind} 违规 ${(r1[0]?.lintReport?.violations ?? []).length}`);
  // 5 改一轮（补丁对不上，退回整张重写）：仍只多一版
  const e = await editDraft(sb, c.id, '标题加粗\n[stub-patch-miss]');
  const r2 = await revisions(c.id);
  expect(e.kind === 'edit_screens' && (e.input.versions ?? 1) === 1 && r2.length === 2 && r2[0].jobId === e.id, `改一轮后修订 ${r2.length} 条（应 2），作业 ${e.kind}`);
  return `9 个非法参数逐个 400；普通项目 frame 400；jobs / MCP 同校验；新草稿 1 屏 1 版「${cs.name}」${cs.route}；补丁对不上仍只多 1 版`;
});

// ---------- TC-CORE-103 画框：自动由模型声明、选定直接写、改画框只对草稿有效并重拍截图 ----------
await step('TC-CORE-103', async () => {
  const sb = await sketchbook();
  // 1 自动：模型在根元素上写 data-frame="mobile"
  const m = await newDraft(sb, '一个天气 App 的首页\n[stub-frame:mobile]', { frame: 'auto' });
  expect((await detail(sb)).screens.find((s) => s.id === m.id)!.frame === 'mobile', '自动 + data-frame=mobile 应落成 mobile');
  const mShot = await shotSize(sb, m.id);
  expect(mShot.w === 780 && mShot.h === 1688, `手机页截图 ${mShot.w}×${mShot.h}，应 780×1688`);
  // 2 自动、根元素没写 data-frame：按组件，截图拍根元素的框连同四周 DRAFT_PAD 的透明边（(320+128)×(96+128) → DPR 2 下 896×448）
  const c = await newDraft(sb, '一个色块\n[size:320x96]', { runner: CHANNEL() });
  expect((await detail(sb)).screens.find((s) => s.id === c.id)!.frame === 'component', '没写 data-frame 应按 component');
  const cShot = await shotSize(sb, c.id);
  const cw = (320 + 2 * DRAFT_PAD) * 2; const ch = (96 + 2 * DRAFT_PAD) * 2;
  expect(Math.abs(cShot.w - cw) <= 2 && Math.abs(cShot.h - ch) <= 2, `组件截图 ${cShot.w}×${cShot.h}，应 ${cw}×${ch}`);
  // 3 选定桌面页（经 MCP，可带 frame）：建屏时就写好，第一版落库前已是 desktop
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const before = (await detail(sb)).screens.map((s) => s.id);
  const gen = await callTool(mcp, 'quilt.generate_screens', { projectId: sb, prompt: '一个产品官网首页\n[stub-hold:4000]', frame: 'desktop', runner: STUB });
  expect(!gen.isError, `MCP generate_screens 带 frame：${gen.text.slice(0, 200)}`);
  const dId = await plannedDraft(sb, before);
  const early = (await detail(sb)).screens.find((s) => s.id === dId)!;
  expect(early.frame === 'desktop' && early.currentRevisionId === null, `选定画框应建屏时就写好：frame=${early.frame} rev=${early.currentRevisionId}`);
  const dJob = await waitJob((gen.json as { id?: string; jobId?: string }).id ?? (gen.json as { jobId: string }).jobId, 60);
  expect(dJob.status === 'succeeded', `桌面草稿作业 ${dJob.status}`);
  const dShot = await shotSize(sb, dId);
  expect(dShot.w === 2560 && dShot.h === 1600, `桌面页截图 ${dShot.w}×${dShot.h}，应 2560×1600`);
  // 4 改画框：只改元数据、不建修订，截图按新画框重拍；截图键带画框，地址随之换掉（浏览器不会拿旧图顶替）
  const shotKey = async () => decodeURIComponent(new URL((await detail(sb)).screens.find((s) => s.id === m.id)!.screenshotUrl!).pathname);
  const k0 = await shotKey();
  const revs0 = await revisions(m.id);
  const p = await apiJson<{ screen: Screen }>(`/v1/screens/${m.id}`, { method: 'PATCH', body: JSON.stringify({ frame: 'desktop' }) });
  expect(p.status === 200 && p.body.screen.frame === 'desktop', `PATCH frame：${p.status} ${JSON.stringify(p.body).slice(0, 160)}`);
  const revs1 = await revisions(m.id);
  expect(revs1.length === revs0.length && revs1[0].id === revs0[0].id, '改画框不该建修订');
  await shotSize(sb, m.id, { w: 2560, h: 1600 });
  const k1 = await shotKey();
  expect(k0.endsWith('.mobile.webp') && k1.endsWith('.desktop.webp'), `截图地址应随画框换：${k0} → ${k1}`);
  // 5 普通项目的屏改画框：422，屏不变
  const app = seedProject('FrameApp', 'mobile', 1);
  const s1 = app.screens[0].id;
  const bad = await apiJson<Problem>(`/v1/screens/${s1}`, { method: 'PATCH', body: JSON.stringify({ frame: 'mobile' }) });
  expect(bad.status === 422 && bad.body.type === '/errors/validation', `普通屏改画框应 422：${bad.status} ${bad.body.type}`);
  expect((await detail(app.projectId)).screens.find((s) => s.id === s1)!.frame === null, '普通屏的 frame 应仍为 null');
  // 6 组件与页面之间不能互换（v1.17）：两个方向都 422 path=frame、草稿不变；手机页 ↔ 桌面页照旧 200
  const patchFrame = (id: string, frame: string) => apiJson<{ screen: Screen } & Problem>(`/v1/screens/${id}`, { method: 'PATCH', body: JSON.stringify({ frame }) });
  const toComp = await patchFrame(m.id, 'component');
  expect(toComp.status === 422 && toComp.body.type === '/errors/validation' && paths(toComp.body).includes('frame'), `页面草稿改成组件应 422 path=frame：${toComp.status} ${paths(toComp.body)}`);
  const toPage = await patchFrame(c.id, 'mobile');
  expect(toPage.status === 422 && toPage.body.type === '/errors/validation' && paths(toPage.body).includes('frame'), `组件草稿改成页面应 422 path=frame：${toPage.status} ${paths(toPage.body)}`);
  const kept = (await detail(sb)).screens;
  expect(kept.find((s) => s.id === m.id)!.frame === 'desktop' && kept.find((s) => s.id === c.id)!.frame === 'component', '被拒的改画框动了草稿');
  const back = await patchFrame(m.id, 'mobile');
  expect(back.status === 200 && back.body.screen.frame === 'mobile', `手机页与桌面页之间应仍能改：${back.status} ${JSON.stringify(back.body).slice(0, 160)}`);
  // 7 工具条上的画框（PAGE-SKETCH「草稿工具条」v1.17）：页面草稿在手机页 / 桌面页之间二选一，组件草稿不显示这个控件
  await openSketch(m.id);
  await waitStage('draft', 15000);
  const opts = await page.getByTestId('draft-frame').locator('[data-value]').evaluateAll((els) => els.map((e) => e.getAttribute('data-value')));
  expect(opts.join(',') === 'mobile,desktop', `页面草稿的画框应只有手机页 / 桌面页两项：${JSON.stringify(opts)}`);
  expect((await chosen('draft-frame')) === 'mobile', `画框控件应停在当前画框：${await chosen('draft-frame')}`);
  await openSketch(c.id);
  await waitStage('draft', 15000);
  expect((await page.getByTestId('draft-frame').count()) === 0, '组件草稿不该有画框控件');
  return `auto→mobile ${mShot.w}×${mShot.h}；缺省→component ${cShot.w}×${cShot.h}；选定 desktop 建屏即写 ${dShot.w}×${dShot.h}；PATCH 重拍；普通屏 422；组件 ↔ 页面 422、手机页 ↔ 桌面页 200；工具条两项 / 组件无控件`;
});

// ---------- TC-CORE-104 草稿的作业：在跑时的冲突、取消、失败、已删 ----------
await step('TC-CORE-104', async () => {
  const sb = await sketchbook();
  // 1 新草稿在生成时：再开一张 409、删它 409
  const before = (await detail(sb)).screens.map((s) => s.id);
  const held = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '一张慢慢出来的卡片\n[stub-hold:6000]', runner: STUB });
  expect(held.status === 202, `出新草稿 ${held.status}`);
  const second = await post<Problem>(`/v1/projects/${sb}/messages`, { content: '另一张', runner: STUB });
  expect(second.status === 409 && second.body.type === '/errors/screen-busy', `同时开第二张应 409 screen-busy：${second.status} ${second.body.type}`);
  const planned = await plannedDraft(sb, before);
  const del = await apiJson<Problem>(`/v1/screens/${planned}`, { method: 'DELETE' });
  expect(del.status === 409 && del.body.type === '/errors/screen-busy', `删正在生成的草稿应 409：${del.status} ${del.body.type}`);
  // 2 取消：作业 cancelled，没出内容的草稿删掉
  const cancel = await apiJson(`/v1/jobs/${held.body.job.id}/cancel`, { method: 'POST' });
  expect(cancel.status === 200, `取消 ${cancel.status}`);
  expect((await waitJob(held.body.job.id, 30)).status === 'cancelled', '作业应 cancelled');
  await eventually(async () => expect(!(await detail(sb)).screens.some((s) => s.id === planned), '取消后没出内容的草稿还在'), 15000, 300);
  // 3 模型通道报错：作业 failed，没出内容的草稿删掉
  const before3 = (await detail(sb)).screens.map((s) => s.id);
  const failing = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '一张会失败的卡片 [fail]', runner: CHANNEL() });
  expect(failing.status === 202, `出新草稿 ${failing.status}`);
  const fj = await waitJob(failing.body.job.id, 60);
  expect(fj.status === 'failed' && fj.output?.errorClass === 'provider', `应 failed / provider：${fj.status} ${JSON.stringify(fj.output).slice(0, 160)}`);
  const after3 = (await detail(sb)).screens;
  expect(after3.length === before3.length && after3.every((s) => s.currentRevisionId), '失败后留下了没内容的草稿');
  // 4 改草稿在跑时：另一处再改 409、回到旧版 409；改完后拿过期的版本回到旧版 409 revision-conflict
  const a = await newDraft(sb, '一张会被改的卡片\n[stub-frame:component]');
  const v1 = (await revisions(a.id))[0].id;
  const edit = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '标题改大\n[stub-hold:5000]', targetScreenIds: [a.id], runner: STUB });
  expect(edit.status === 202, `改草稿 ${edit.status}`);
  const edit2 = await post<Problem>(`/v1/projects/${sb}/messages`, { content: '背景换深色', targetScreenIds: [a.id], runner: STUB });
  expect(edit2.status === 409 && edit2.body.type === '/errors/screen-busy', `同时改同一张应 409 screen-busy：${edit2.status} ${edit2.body.type}`);
  const restoreBusy = await post<Problem>(`/v1/screens/${a.id}/revisions/${v1}/restore`, { expectedRevisionId: v1 });
  expect(restoreBusy.status === 409 && restoreBusy.body.type === '/errors/screen-busy', `改的时候回到旧版应 409 screen-busy：${restoreBusy.status} ${restoreBusy.body.type}`);
  expect((await waitJob(edit.body.job.id, 60)).status === 'succeeded', '改草稿作业没成功');
  const stale = await post<Problem>(`/v1/screens/${a.id}/revisions/${v1}/restore`, { expectedRevisionId: v1 });
  expect(stale.status === 409 && stale.body.type === '/errors/revision-conflict', `版本过期时回到旧版应 409 revision-conflict：${stale.status} ${stale.body.type}`);
  // 5 草稿已被删：改它 404
  expect((await apiJson(`/v1/screens/${a.id}`, { method: 'DELETE' })).status === 204, '删草稿应 204');
  const gone = await post<Problem>(`/v1/projects/${sb}/messages`, { content: '再改一句', targetScreenIds: [a.id], runner: STUB });
  expect(gone.status === 404 && gone.body.type === '/errors/not-found', `改已删的草稿应 404：${gone.status} ${gone.body.type}`);
  return '新草稿在跑：再开 409、删 409；取消与失败都删空草稿；改的时候再改 / 回到旧版 409；过期 409 revision-conflict；已删 404';
});

// ---------- TC-CORE-107 把草稿放进项目：落成屏并按设计系统改写；一次性快照（INV-CORE-004） ----------
await step('TC-CORE-107', async () => {
  const sb = await sketchbook();
  const a = await newDraft(sb, '一个音乐播放器的迷你控制条\n[stub-frame:component]');
  const aBody = bodyOf(await revHtml((await revisions(a.id))[0]));
  const aRevs = (await revisions(a.id)).length;
  const P = seedProject('CopyTarget', 'mobile', 3);
  const p0 = await detail(P.projectId);
  const maxX = Math.max(...p0.screens.map((s) => s.x));
  const msgs0 = (await messagesOf(P.projectId)).length;
  // 1 落成屏 + 改写
  const r = await post<CopyResult>(`/v1/sketchbook/drafts/${a.id}/copy`, { projectId: P.projectId, as: 'screen', name: 'Player Bar', restyle: true, runner: STUB });
  expect(r.status === 201 && r.body.screen && r.body.job, `放进项目应 201 带 screen 与 job：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const ns = r.body.screen!;
  const job = r.body.job!;
  const p1 = await detail(P.projectId);
  expect(p1.screens.length === 4 && ns.route === '/player-bar' && ns.x > maxX && ns.frame === null, `新屏：屏数 ${p1.screens.length} 路由 ${ns.route} x ${ns.x}（原最右 ${maxX}）frame ${ns.frame}`);
  // 改写作业在桩通道上几毫秒就落第 2 版，读到时可能已经有两版：按 seq 取第 1 版（列表新的在前）
  const nr1 = await revisions(ns.id);
  const first = nr1[nr1.length - 1];
  expect(first?.seq === 1 && first.sourceKind === 'sketch' && nr1.every((x) => x === first || x.sourceKind === 'edit'), `新屏第 1 版：${nr1.map((x) => `${x.seq}:${x.sourceKind}`).join(' ')}`);
  const nBody = bodyOf(await revHtml(first));
  expect(nBody === aBody, `新屏第 1 版的 body 应与草稿当前版相同\n草稿：${aBody.slice(0, 160)}\n新屏：${nBody.slice(0, 160)}`);
  expect(job.kind === 'edit_screens' && JSON.stringify(job.input.screenIds) === JSON.stringify([ns.id]) && job.input.prompt === RESTYLE_PROMPT, `改写作业不对：${job.kind} ${JSON.stringify(job.input).slice(0, 200)}`);
  // 2 改写完成：新屏第 2 版；作业不写进目标项目的对话
  expect((await waitJob(job.id, 120)).status === 'succeeded', '改写作业没成功');
  const nr2 = await revisions(ns.id);
  expect(nr2.length === 2 && nr2[0].jobId === job.id, `改写后新屏应有 2 版：${nr2.length}`);
  const msgs1 = await messagesOf(P.projectId);
  expect(msgs1.length === msgs0 && !msgs1.some((m) => m.jobId === job.id), '改写作业写进了目标项目的对话');
  // 3 快照不引用草稿；草稿的修订不变
  for (const rev of nr2) { const h = await revHtml(rev); expect(!h.includes(sb) && !h.includes(a.id), `新屏第 ${rev.seq} 版引用了草稿本或草稿的 id`); }
  expect((await revisions(a.id)).length === aRevs, '放进项目改动了草稿的修订');
  // 4 之后改草稿，项目里那屏不变
  const keep = (await detail(P.projectId)).screens.find((s) => s.id === ns.id)!.currentRevisionId;
  await editDraft(sb, a.id, '按钮换成圆形');
  expect((await detail(P.projectId)).screens.find((s) => s.id === ns.id)!.currentRevisionId === keep, '改草稿后项目里那屏跟着变了');
  // 5 不改写、同名再放一次：路由去重，不建作业
  const jobs5 = (await jobsOf(P.projectId)).length;
  const r5 = await post<CopyResult>(`/v1/sketchbook/drafts/${a.id}/copy`, { projectId: P.projectId, as: 'screen', name: 'Player Bar', restyle: false });
  expect(r5.status === 201 && r5.body.screen && !r5.body.job, `restyle=false 应 201 只带 screen：${r5.status} ${JSON.stringify(r5.body).slice(0, 160)}`);
  expect(r5.body.screen!.route.startsWith('/player-bar') && r5.body.screen!.route !== '/player-bar', `同名再放的路由应去重：${r5.body.screen!.route}`);
  expect((await jobsOf(P.projectId)).length === jobs5, 'restyle=false 不该建作业');
  // 6 MCP 放进项目，名字缺省取草稿名
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const viaMcp = await callTool(mcp, 'quilt.copy_draft', { screenId: a.id, projectId: P.projectId, as: 'screen', restyle: false });
  const mScreen = (viaMcp.json as CopyResult).screen;
  const aName = (await detail(sb)).screens.find((s) => s.id === a.id)!.name;
  expect(!viaMcp.isError && mScreen?.name === aName, `quilt.copy_draft 名字应缺省取草稿名「${aName}」：${viaMcp.text.slice(0, 200)}`);
  return `屏 ${ns.route}（sketch 版 body 相同）+ 改写第 2 版；草稿后改不影响；去重 ${r5.body.screen!.route}；MCP 名字「${mScreen?.name}」`;
});

// ---------- TC-CORE-108 把草稿放进项目：落成组件、带脚本拒绝、名字冲突、目标不对 ----------
await step('TC-CORE-108', async () => {
  const sb = await sketchbook();
  const P = seedProject('CopyComponents', 'mobile', 1);
  const strip = (h: string) => h.replace(/\s(data-qid|data-frame|data-component)="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
  const comps = async () => (await detail(P.projectId)).components;
  // 1 落成组件，不改写
  const c = await newDraft(sb, '一个迷你播放器组件\n[stub-frame:component]');
  const cBody = strip(bodyOf(await revHtml((await revisions(c.id))[0])));
  const r1 = await post<CopyResult>(`/v1/sketchbook/drafts/${c.id}/copy`, { projectId: P.projectId, as: 'component', name: 'MiniPlayer', restyle: false });
  expect(r1.status === 201 && r1.body.component && !r1.body.job && !r1.body.screen, `落成组件应 201 只带 component：${r1.status} ${JSON.stringify(r1.body).slice(0, 200)}`);
  expect(strip(r1.body.component!.html) === cBody, `组件 HTML 应与草稿 body 相同\n草稿：${cBody.slice(0, 160)}\n组件：${strip(r1.body.component!.html).slice(0, 160)}`);
  expect(!r1.body.component!.html.includes(sb) && !r1.body.component!.html.includes(c.id), '组件 HTML 引用了草稿本或草稿的 id');
  // 2 落成组件并改写：建 edit_component 作业，完成后组件升版
  const r2 = await post<CopyResult>(`/v1/sketchbook/drafts/${c.id}/copy`, { projectId: P.projectId, as: 'component', name: 'MiniPlayerStyled', restyle: true, runner: STUB });
  expect(r2.status === 201 && r2.body.component && r2.body.job?.kind === 'edit_component' && r2.body.job.input.prompt === RESTYLE_PROMPT, `落成组件 + 改写：${r2.status} ${JSON.stringify(r2.body.job ?? r2.body).slice(0, 200)}`);
  expect((await waitJob(r2.body.job!.id, 120)).status === 'succeeded', '组件改写作业没成功');
  expect((await comps()).find((x) => x.id === r2.body.component!.id)!.version === r2.body.component!.version + 1, '改写后组件应升一版');
  // 3 名字冲突
  const n3 = (await comps()).length;
  const r3 = await post<Problem>(`/v1/sketchbook/drafts/${c.id}/copy`, { projectId: P.projectId, as: 'component', name: 'MiniPlayer', restyle: false });
  expect(r3.status === 409 && r3.body.type === '/errors/component-name-taken' && (await comps()).length === n3, `同名组件应 409 component-name-taken：${r3.status} ${r3.body.type}`);
  // 4 带脚本的草稿：落成组件 400 并说明，落成屏可以
  const s = await newDraft(sb, '一个会动的计数器\n[stub-script]');
  expect(/<script[\s>]/.test(await revHtml((await revisions(s.id))[0]).then(bodyOf)), '[stub-script] 的草稿里没有 <script>（stub 驱动没认这个标记）');
  const r4 = await post<Problem>(`/v1/sketchbook/drafts/${s.id}/copy`, { projectId: P.projectId, as: 'component', name: 'Counter', restyle: false });
  expect(r4.status === 400 && r4.body.type === '/errors/validation' && JSON.stringify(r4.body).includes('草稿里有脚本或样式表，组件放不下，放成屏'), `带脚本落成组件应 400 并说明：${r4.status} ${JSON.stringify(r4.body).slice(0, 200)}`);
  expect((await comps()).length === n3, '被拒后组件数变了');
  const r4b = await post<CopyResult>(`/v1/sketchbook/drafts/${s.id}/copy`, { projectId: P.projectId, as: 'screen', name: 'Counter', restyle: false });
  expect(r4b.status === 201 && r4b.body.screen, `带脚本的草稿落成屏应 201：${r4b.status}`);
  // 5 目标不对：草稿本自己、不存在的项目、不是草稿的屏 404
  const toSelf = await post<Problem>(`/v1/sketchbook/drafts/${c.id}/copy`, { projectId: sb, as: 'screen', restyle: false });
  const toNone = await post<Problem>(`/v1/sketchbook/drafts/${c.id}/copy`, { projectId: FAKE, as: 'screen', restyle: false });
  const notDraft = await post<Problem>(`/v1/sketchbook/drafts/${P.screens[0].id}/copy`, { projectId: P.projectId, as: 'screen', restyle: false });
  expect([toSelf, toNone, notDraft].every((x) => x.status === 404 && x.body.type === '/errors/not-found'), `目标不对应 404：${[toSelf, toNone, notDraft].map((x) => x.status).join(',')}`);
  // 6 还没有内容的草稿 400
  const before6 = (await detail(sb)).screens.map((x) => x.id);
  const held = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '一张还没出来的卡片\n[stub-hold:5000]', runner: STUB });
  const empty = await plannedDraft(sb, before6);
  const r6 = await post<Problem>(`/v1/sketchbook/drafts/${empty}/copy`, { projectId: P.projectId, as: 'screen', restyle: false });
  expect(r6.status === 400 && r6.body.type === '/errors/validation', `还没有内容的草稿应 400：${r6.status} ${r6.body.type}`);
  await apiJson(`/v1/jobs/${held.body.job.id}/cancel`, { method: 'POST' });
  await waitJob(held.body.job.id, 30);
  return '组件 body 相同、改写升版；同名 409；带脚本组件 400、屏 201；三种目标 404；空草稿 400';
});

// ---------- TC-CORE-100 出组件草稿、改一轮、回到旧版（浏览器） ----------
await step('TC-CORE-100', async () => {
  const sb = await sketchbook();
  await openSketch();
  await useStubRunner();
  await waitStage('empty');
  expect((await page.getByTestId('verb-line').innerText()).includes('新草稿'), `空看板时动词行应写「新草稿」：${await page.getByTestId('verb-line').innerText()}`);
  expect((await chosen('frame-choice')) === 'auto', `画框选择缺省应为自动：${await chosen('frame-choice')}`);
  const rail0 = await railIds();
  // 1 发一句：先骨架，作业完成换成活 iframe
  const jobId = await sendFromComposer('一个音乐播放器的迷你控制条，深色毛玻璃');
  await waitStage('generating', 5000);
  expect((await waitJob(jobId, 60)).status === 'succeeded', '出稿作业没成功');
  await waitStage('draft', 15000);
  const id = (await openDraftId())!;
  expect(urlDraft() === id, `地址的 d 应是新草稿：${urlDraft()} vs ${id}`);
  // 2 组件画框：按根元素大小居中；记录栏多一项；动词行改成「改「…」」、画框选择收起
  expect((await page.getByTestId('draft-view').getAttribute('data-frame')) === 'component', '画框应为 component');
  const f = await draftFrame();
  await f.waitForFunction(() => document.body.textContent?.includes('夜航星'));
  const root = await rootBox(f);
  // 视口要等预览文档 load（图片到齐）后的第一次 quilt:draft-size 才改成「根元素的框 + 四周 DRAFT_PAD」，这之前 iframe 透明、看板上是骨架
  await page.waitForFunction((w) => { const r = document.querySelector('[data-testid="draft-iframe"]')?.getBoundingClientRect(); return !!r && Math.abs(r.width - w) <= 2; }, root.w + 2 * DRAFT_PAD, { timeout: 15000 }).catch(() => {});
  const ifr = await box('draft-iframe');
  const stage = await box('sketch-stage');
  expect(Math.abs(ifr.width - root.w - 2 * DRAFT_PAD) <= 2 && Math.abs(ifr.height - root.h - 2 * DRAFT_PAD) <= 2 && Math.abs(root.w - 360) <= 1, `iframe ${ifr.width}×${ifr.height} 应等于根元素 ${root.w}×${root.h}（宽 360）四周各加 ${DRAFT_PAD}`);
  const dx = Math.abs(ifr.x + ifr.width / 2 - (stage.x + stage.width / 2));
  const dy = Math.abs(ifr.y + ifr.height / 2 - (stage.y + stage.height / 2));
  expect(dx <= 2 && dy <= 2, `草稿没在看板正中：中心偏 ${dx.toFixed(1)} / ${dy.toFixed(1)} px`);
  await eventually(async () => expect((await railIds()).length === rail0.length + 1 && (await railIds()).includes(id), '记录栏应多出这一张'));
  const name = (await detail(sb)).screens.find((s) => s.id === id)!.name;
  expect((await page.getByTestId('verb-line').innerText()).includes(`改「${name}」`), `动词行应写「改「${name}」」：${await page.getByTestId('verb-line').innerText()}`);
  expect(!(await page.getByTestId('frame-choice').isVisible().catch(() => false)), '看板上有草稿时画框选择应收起');
  // 3 再发一句：同一张多一版，看板显示新版
  const j2 = await sendFromComposer('按钮换成圆形，加一个音量滑块');
  expect((await waitJob(j2, 60)).status === 'succeeded', '改稿作业没成功');
  const revs2 = await revisions(id);
  expect(revs2.length === 2 && (await detail(sb)).screens.filter((s) => s.id === id).length === 1, `改一轮后应 2 版：${revs2.length}`);
  await eventually(async () => expect(await (await draftFrame()).locator('input[aria-label="音量"]').count() === 1, '看板没换成新版（没有音量滑块）'), 15000, 300);
  // 4 「版本」里回到第 1 版：当前版指回第 1 版，不多出新版本
  await page.getByTestId('draft-versions').click();
  await page.getByTestId('versions-popover').waitFor({ timeout: 5000 });
  // 弹层先出、版本列表随后取到（API-CORE-013）
  await eventually(async () => expect((await page.getByTestId('version-item').count()) === 2, `版本列表应列 2 版：${await page.getByTestId('version-item').count()}`), 5000, 100);
  const v1 = revs2[revs2.length - 1];
  const item = page.locator(`[data-testid="version-item"][data-revision-id="${v1.id}"]`);
  if (await item.getByTestId('version-restore').count()) await item.getByTestId('version-restore').click();
  else { await item.click(); await page.getByTestId('version-restore').click(); }
  await eventually(async () => expect((await detail(sb)).screens.find((s) => s.id === id)!.currentRevisionId === v1.id, '回到旧版后当前版应是第 1 版'), 10000, 300);
  expect((await revisions(id)).length === 2, `回到旧版不该多出新版本：${(await revisions(id)).length}`);
  await eventually(async () => { const fr = await draftFrame(); expect((await fr.locator('input[aria-label="音量"]').count()) === 0 && (await fr.locator('body').innerText()).includes('夜航星'), '看板应显示第 1 版的内容'); }, 15000, 300);
  return `组件草稿「${name}」居中 ${ifr.width}×${ifr.height}；改一轮 2 版；回到第 1 版仍是 2 版、当前是第 1 版`;
});

// ---------- TC-CORE-101 收起后接着出下一张手机页，再重开（浏览器） ----------
await step('TC-CORE-101', async () => {
  const sb = await sketchbook();
  const a = await newDraft(sb, '一个音乐播放器的迷你控制条', { runner: CHANNEL() });
  await openSketch(a.id);
  await useStubRunner();
  await waitStage('draft');
  expect((await openDraftId()) === a.id, '前置：看板上应是 A');
  // 1 输入框有字时 Esc 先清字；再按一次才收起
  const input = page.getByTestId('composer-input');
  await input.fill('随手写的字');
  await input.press('Escape');
  expect((await input.inputValue()) === '' && (await stageState()) === 'draft', '第一下 Esc 应只清字、不收起');
  await input.press('Escape');
  await waitStage('empty', 5000);
  expect(urlDraft() === null && (await railIds()).includes(a.id), '收起后地址应没有 d，A 留在记录栏');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'composer-input'), '收起后焦点应回输入框');
  // 2 选「手机页」出下一张：390×844 视口，记录栏里 B 在 A 之前
  await choose('frame-choice', 'mobile');
  const jb = await sendFromComposer('一个记账 App 的首页');
  expect((await waitJob(jb, 60)).status === 'succeeded', '出稿作业没成功');
  await waitStage('draft', 15000);
  const b = (await openDraftId())!;
  expect(b !== a.id && (await page.getByTestId('draft-view').getAttribute('data-frame')) === 'mobile', `B 的画框应为 mobile：${await page.getByTestId('draft-view').getAttribute('data-frame')}`);
  const vb = await rootBox(await draftFrame());
  expect(vb.vw === 390 && vb.vh === 844, `手机页视口 ${vb.vw}×${vb.vh}，应 390×844`);
  const order = await railIds();
  expect(order.indexOf(b) >= 0 && order.indexOf(b) < order.indexOf(a.id), `记录栏顺序应 B 在 A 之前：${JSON.stringify(order)}`);
  // 3 改 B 时收起：照常改完，记录栏里 B 标「生成中」
  const jEdit = await sendFromComposer('把预算卡片挪到最上面，慢慢来');
  await input.press('Escape');
  await waitStage('empty', 5000);
  await eventually(async () => expect((await railItem(b).getAttribute('data-generating')) === 'true', '收起后记录栏里 B 应标生成中'), 3000);
  expect((await waitJob(jEdit, 60)).status === 'succeeded', '改 B 的作业没成功');
  await eventually(async () => expect((await railItem(b).getAttribute('data-generating')) !== 'true', '改完后 B 仍标生成中'), 10000);
  expect((await revisions(b)).length === 2, 'B 应有 2 版');
  // 4 点记录栏里的 A：回到看板
  await railItem(a.id).click();
  await waitStage('draft', 10000);
  expect((await openDraftId()) === a.id && urlDraft() === a.id, `A 没回到看板：${await openDraftId()} d=${urlDraft()}`);
  return 'Esc 先清字再收起；手机页 390×844、B 在 A 前；改着收起照常完成；重开 A';
});

// ---------- TC-CORE-105 发送被挡：上一张还在生成、这一张还在改 ----------
await step('TC-CORE-105', async () => {
  const sb = await sketchbook();
  const a = await newDraft(sb, '一个音乐播放器的迷你控制条', { runner: CHANNEL() });
  await openSketch();
  await useStubRunner();
  // 1 新草稿在生成：收起后再写一句，发送被挡、字留着
  const j1 = await sendFromComposer('一张慢慢出来的卡片');
  await waitStage('generating', 5000);
  await page.getByTestId('composer-input').press('Escape');
  await waitStage('empty', 5000);
  expect((await page.getByTestId('verb-line').innerText()).includes('新草稿'), '收起后动词行应写「新草稿」');
  const why1 = await expectSendBlocked('再来一张', /上一张草稿还在生成/);
  expect((await waitJob(j1, 60)).status === 'succeeded', '慢的那张没出来');
  await page.getByTestId('composer-input').fill('');
  // 2 这张草稿上一轮没改完：再写一句被挡
  await railItem(a.id).click();
  await waitStage('draft', 10000);
  const name = (await detail(sb)).screens.find((s) => s.id === a.id)!.name;
  const j2 = await sendFromComposer('标题改小一点，慢慢改');
  const why2 = await expectSendBlocked('再改一句', new RegExp(`「${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」正在改`));
  expect((await waitJob(j2, 60)).status === 'succeeded', '慢的那轮没改完');
  await page.getByTestId('composer-input').fill('');
  return `「${why1}」；「${why2}」`;
});

// ---------- TC-CORE-106 看板摆放：放不下等比缩小、不抢看板、删掉与已删的草稿 ----------
await step('TC-CORE-106', async () => {
  const sb = await sketchbook();
  await openSketch();
  await useStubRunner();
  await waitStage('empty');
  // 1 桌面页比看板大：等比缩小、整张放得下。记录栏浮在看板上（v1.17），1440×900 的看板放得下整张 1280×800，这一步在 1280×800 下做
  await page.setViewportSize({ width: 1280, height: 800 });
  cleanups.push(() => page.setViewportSize({ width: 1440, height: 900 }));
  await choose('frame-choice', 'desktop');
  const jd = await sendFromComposer('一个产品官网首页');
  expect((await waitJob(jd, 60)).status === 'succeeded', '桌面页没出来');
  await waitStage('draft', 15000);
  const d = (await openDraftId())!;
  const ifr = await box('draft-iframe');
  const stage = await box('sketch-stage');
  const vp = await rootBox(await draftFrame());
  expect(vp.vw === 1280 && vp.vh === 800, `桌面页视口 ${vp.vw}×${vp.vh}，应 1280×800`);
  expect(ifr.width < 1280 && Math.abs(ifr.width / ifr.height - 1.6) < 0.02, `应等比缩小：${ifr.width.toFixed(0)}×${ifr.height.toFixed(0)}`);
  expect(ifr.x >= stage.x - 1 && ifr.y >= stage.y - 1 && ifr.x + ifr.width <= stage.x + stage.width + 1 && ifr.y + ifr.height <= stage.y + stage.height + 1, '缩小后的草稿超出了看板（被裁切）');
  await page.setViewportSize({ width: 1440, height: 900 });
  // 2 新草稿生成中打开别的草稿：新草稿不抢看板，只进记录栏
  await page.getByTestId('draft-collapse').click();
  await waitStage('empty', 5000);
  const rail0 = await railIds();
  const jn = await sendFromComposer('又一张慢慢出来的卡片');
  await waitStage('generating', 5000);
  let n = '';
  await eventually(async () => { n = (await railIds()).find((x) => x && !rail0.includes(x)) ?? ''; expect(n && (await railItem(n).getAttribute('data-generating')) === 'true', '记录栏里还没有生成中的新草稿'); }, 5000);
  await railItem(d).click();
  await waitStage('draft', 10000);
  expect((await waitJob(jn, 60)).status === 'succeeded', '新草稿没出来');
  await sleep(1500);
  expect((await openDraftId()) === d && (await railIds()).includes(n), `新草稿抢了看板：看板 ${await openDraftId()}，桌面页 ${d}`);
  // 3 在看板上删掉：确认后删除，看板清空
  await page.getByTestId('draft-delete').click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await dialog.getByRole('button', { name: /删除/ }).click();
  await waitStage('empty', 10000);
  await eventually(async () => expect(!(await railIds()).includes(d) && !(await detail(sb)).screens.some((s) => s.id === d), '删掉的草稿还在'), 10000);
  // 4 别处已删：页面没收到事件时发一句改它 → 404，看板清空并提示
  await page.route(/\/v1\/projects\/[^/]+\/events/, (r) => r.abort());
  cleanups.push(() => page.unroute(/\/v1\/projects\/[^/]+\/events/));
  await openSketch(n);
  await waitStage('draft', 10000);
  expect((await apiJson(`/v1/screens/${n}`, { method: 'DELETE' })).status === 204, '别处删草稿应 204');
  await page.getByTestId('composer-input').fill('标题换个颜色');
  const resp = page.waitForResponse((r) => /\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await page.getByTestId('composer-send').click();
  expect((await resp).status() === 404, '改已删的草稿应 404');
  await waitStage('empty', 5000);
  await page.getByText('这张草稿已被删除').first().waitFor({ timeout: 5000 });
  await page.unroute(/\/v1\/projects\/[^/]+\/events/);
  // 5 地址里的草稿已被删：看板为空并提示
  await openSketch(n);
  await waitStage('empty', 10000);
  await page.getByText('这张草稿已被删除').first().waitFor({ timeout: 5000 });
  return `桌面页缩到 ${ifr.width.toFixed(0)}×${ifr.height.toFixed(0)}；不抢看板；删除确认；别处已删 404 清空；地址里已删`;
});

// ---------- TC-CORE-109 「写回项目…」弹层：放成新屏（浏览器） ----------
await step('TC-CORE-109', async () => {
  const sb = await sketchbook();
  const P = seedProject('CopyDesk', 'desktop', 1);
  const m = await newDraft(sb, '一个记账 App 的首页', { frame: 'mobile', runner: CHANNEL() });
  const mName = (await detail(sb)).screens.find((s) => s.id === m.id)!.name;
  // 前置：上次打开的项目是 CopyDesk
  await page.goto(`${WEB}/p/${P.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await openSketch(m.id);
  await useStubRunner();
  await waitStage('draft', 10000);
  // 1 打开弹层：缺省目标、落成方式、名字、改写勾选与说明、画框对不上的提示
  await page.getByTestId('draft-copy').click();
  const dlg = page.getByTestId('copy-dialog');
  await dlg.waitFor({ timeout: 5000 });
  const proj = await chosen('copy-project');
  expect(proj === P.projectId || (await page.getByTestId('copy-project').innerText()).includes('CopyDesk'), `目标项目缺省应是上次打开的 CopyDesk：${proj}`);
  expect((await chosen('copy-as')) === 'screen', `落成方式缺省应为屏：${await chosen('copy-as')}`);
  expect((await page.getByTestId('copy-name').inputValue()) === mName, `名字缺省应为草稿名「${mName}」`);
  const restyle = page.getByTestId('copy-restyle');
  const checked = (await restyle.getAttribute('aria-checked')) === 'true' || (await restyle.getAttribute('data-state')) === 'checked' || (await restyle.isChecked().catch(() => false));
  expect(checked && (await dlg.innerText()).includes('1 次模型调用'), '「按该项目的设计系统改写」应缺省勾选并写明 1 次模型调用');
  const hint = await page.getByTestId('copy-hint').innerText();
  expect(hint.includes('手机页') && hint.includes('桌面'), `画框与设备形态不符的提示：「${hint}」`);
  // 2 提交：带输入框当前的通道；提示条「已写回「CopyDesk」」
  const req = page.waitForRequest((r) => r.url().includes(`/v1/sketchbook/drafts/${m.id}/copy`) && r.method() === 'POST');
  await page.getByTestId('copy-submit').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { projectId?: string; as?: string; restyle?: boolean; runner?: { channelId?: string } };
  expect(body.projectId === P.projectId && body.as === 'screen' && body.restyle === true && body.runner?.channelId === channelId, `请求体不对：${JSON.stringify(body)}`);
  await page.getByText('已写回「CopyDesk」').first().waitFor({ timeout: 10000 });
  // 3 「去看看」打开项目画布，新屏在上面
  await page.getByText('去看看').first().click();
  await page.waitForURL(new RegExp(`/p/${P.projectId}`), { timeout: 10000 });
  await eventually(async () => expect((await page.locator('[data-testid="screen-card"]').count()) === 2, '项目画布上应有 2 张屏'), 15000, 300);
  const jobs = (await jobsOf(P.projectId)).filter((j) => j.kind === 'edit_screens');
  if (jobs[0]) await waitJob(jobs[0].id, 60);
  return `缺省目标 CopyDesk、屏、名字「${mName}」、改写勾选；提示「${hint}」；去看看 2 屏`;
});

// ---------- TC-CORE-110 交给本机会话出草稿、改草稿（假会话） ----------
await step('TC-CORE-110', async () => {
  const DIR = process.env.QUILT_CLAUDE_SESSIONS_DIR ?? '';
  if (!DIR) throw new Skip('未设 QUILT_CLAUDE_SESSIONS_DIR（API 与本脚本都要以同一目录启动，§3）');
  const runners = (await apiJson<{ items: { id: string; available: boolean; unavailableReason?: string }[] }>('/v1/runners')).body.items;
  const claude = runners.find((r) => r.id === 'agent:claude-code');
  if (!claude?.available) throw new Skip(`本机 claude 不可用（${claude?.unavailableReason ?? ''}）`);
  const { startFakeSession } = await import('./agent-stub.ts');
  const fake = await startFakeSession({ dir: DIR, name: 'Stub 草稿', nameSource: 'user' });
  const mcp = await connectMcp();
  cleanups.push(async () => { await mcp.close(); await fake.close(); });
  await sleep(2100); // 服务端会话列表缓存 2 s
  const sb = await sketchbook();
  const agent = { kind: 'agent', tool: 'claude-code', sessionId: fake.sessionId };
  // 指令里都带 HANG：假会话收到后什么都不做，由脚本以会话身份经 MCP 回写
  const delivered = async (n0: number) => { for (let i = 0; i < 40 && fake.received.length === n0; i++) await sleep(250); expect(fake.received.length > n0, '假会话没收到投递'); return fake.received[n0]; };
  // 1 新草稿交给会话：提示词是草稿规则
  let n0 = fake.received.length;
  const r1 = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: 'HANG 一张天气卡片', runner: agent });
  expect(r1.status === 202 && r1.body.job.kind === 'generate' && r1.body.job.runner === 'agent', `交给会话应建 runner=agent 的 generate：${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`);
  const j1 = r1.body.job.id;
  const p1 = await delivered(n0);
  expect(p1.includes(`(job ${j1})`) && p1.includes('quilt.create_screen') && p1.includes(`projectId: "${sb}"`) && /route[^.\n]*omit/i.test(p1) && p1.includes('data-frame') && /do not call quilt\.get_design_contract/i.test(p1) && !p1.includes('Target screens'), `新草稿的投递提示词不对：${p1.slice(0, 600)}`);
  // 2 以会话身份写出新草稿（不带 route、写死的色值）并收口
  const made = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '天气卡片', html: WEATHER, jobId: j1 });
  expect(!made.isError, `create_screen 不带 route：${made.text.slice(0, 200)}`);
  const id = (made.json as { screenId: string }).screenId;
  const s = (await detail(sb)).screens.find((x) => x.id === id)!;
  const rev = (await revisions(id))[0];
  expect(/^\/draft-\d+$/.test(s.route) && s.frame === 'mobile' && rev.jobId === j1 && (rev.lintReport?.violations ?? []).length === 0, `会话写的草稿：路由 ${s.route} 画框 ${s.frame} jobId ${rev.jobId} 违规 ${(rev.lintReport?.violations ?? []).length}`);
  // 同一作业再建一张：400 validation，草稿数不变（INV-CORE-003）
  const count2 = (await detail(sb)).screens.length;
  const second = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '第二张', html: WEATHER, jobId: j1 });
  expect(second.isError && (second.json as Problem).type === '/errors/validation' && (await detail(sb)).screens.length === count2, `同一作业第二次 create_screen 应 400 validation、不多出草稿：${second.text.slice(0, 200)}`);
  expect(!(await callTool(mcp, 'quilt.finish_job', { jobId: j1, summary: '写了一张天气卡片' })).isError, 'finish_job 出错');
  const done1 = await waitJob(j1, 30);
  expect(done1.status === 'succeeded' && JSON.stringify(done1.output.screenIds) === JSON.stringify([id]), `收口后作业：${done1.status} ${JSON.stringify(done1.output).slice(0, 160)}`);
  // 3 改这张草稿交给会话：提示词带 screenId 与 expectedRevisionId，会话用补丁改
  n0 = fake.received.length;
  const r2 = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: 'HANG 加一行湿度', targetScreenIds: [id], runner: agent });
  expect(r2.status === 202 && r2.body.job.kind === 'edit_screens', `改草稿交给会话：${r2.status}`);
  const j2 = r2.body.job.id;
  const p2 = await delivered(n0);
  expect(p2.includes(`screenId=${id} expectedRevisionId=${rev.id}`) && p2.includes('quilt.patch_screen') && p2.includes('quilt.update_screen') && p2.includes(j2), `改草稿的投递提示词不对：${p2.slice(0, 600)}`);
  const patched = await callTool(mcp, 'quilt.patch_screen', { screenId: id, expectedRevisionId: rev.id, edits: [{ find: '多云 · 体感 16°', replace: '多云 · 体感 16° · 湿度 62%' }], jobId: j2 });
  expect(!patched.isError, `patch_screen：${patched.text.slice(0, 200)}`);
  await callTool(mcp, 'quilt.finish_job', { jobId: j2, summary: '加了湿度' });
  expect((await waitJob(j2, 30)).status === 'succeeded' && (await revisions(id)).length === 2, '改草稿收口后应 2 版');
  // 4 草稿本页：选了本机会话通道、没选会话时发送被挡
  await openSketch();
  await waitStage('empty');
  await pickOption(page, '[data-testid="runner-select"]', '交给本机 Claude Code');
  cleanups.push(() => useStubRunner());
  await page.getByTestId('session-select').waitFor({ timeout: 10000 });
  if ((await selectedValue(page, '[data-testid="session-select"]'))) throw new Error('前置：会话下拉不该有记住的会话');
  await expectSendBlocked('HANG 一个登录表单', /会话/);
  // 5 选了会话发出的新草稿，会话写出来后由页面认领摆上看板
  await pickOption(page, '[data-testid="session-select"]', 'Stub 草稿');
  const j3 = await sendFromComposer('HANG 一个登录表单');
  const made3 = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '登录表单', html: LOGIN, jobId: j3 });
  expect(!made3.isError, `create_screen：${made3.text.slice(0, 200)}`);
  const id3 = (made3.json as { screenId: string }).screenId;
  await eventually(async () => expect((await openDraftId()) === id3, `会话写出的草稿没被认领到看板：${await openDraftId()}`), 15000, 300);
  await callTool(mcp, 'quilt.finish_job', { jobId: j3, summary: '写了登录表单' });
  return `新草稿 ${s.route}（mobile、lint 空）；改稿补丁 2 版；没选会话被挡；认领 ${id3.slice(0, 8)}`;
});

// ---------- 写回与参照（v1.14）的接口助手 ----------
const strip = (html: string) => html.replace(/\sdata-qid="q\d+"/g, '').replace(/\s+/g, ' ').trim();
const qidOf = (html: string, re: RegExp) => { const m = re.exec(html); expect(m, `找不到元素 ${re}`); return m![1]; };
const draftOf = async (sb: string, id: string) => (await detail(sb)).screens.find((s) => s.id === id)!;
const patchScreen = (id: string, body: unknown) => apiJson<{ screen: Screen } & Problem>(`/v1/screens/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
const copy = (draft: string, body: unknown) => post<CopyResult>(`/v1/sketchbook/drafts/${draft}/copy`, body);
const fork = (body: unknown) => post<{ screen: Screen } & Problem>('/v1/sketchbook/drafts', body);
/** 当前修订的完整 HTML */
const currentHtml = async (sid: string) => revHtml((await revisions(sid))[0]);
/** 把项目的圆角档换成 round，让它的 prelude 与草稿本的（新建项目是 sharp）分得开；返回换后的 tokens */
async function roundProject(pid: string): Promise<Tokens> {
  const ds = (await detail(pid)).designSystem;
  const r = await apiJson<{ designSystem: { tokens: Tokens } }>(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ radiusScale: 'round', expectedVersion: ds.version }) });
  expect(r.status === 200, `改圆角档 ${r.status}`);
  return r.body.designSystem.tokens;
}
/** 把种子屏的 <nav> 提成共享组件 TabBar（API-EDIT-004）：这一屏多一版，nav 成了实例 */
async function tabBarOn(pid: string, sid: string): Promise<void> {
  const nav = qidOf(await currentHtml(sid), /<nav[^>]*data-qid="(q\d+)"/);
  const r = await post<Problem>(`/v1/projects/${pid}/components`, { name: 'TabBar', fromScreenId: sid, qid: nav });
  expect(r.status === 201, `提取 TabBar ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  expect(/<nav[^>]*data-component="TabBar"/.test(await currentHtml(sid)), '提取后 nav 应成了组件实例');
}
const navOf = (html: string) => strip(/<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '');
const headerOf = (html: string) => strip(/<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '');

// ---------- TC-CORE-112 从屏建草稿：整屏与一块（REQ-CORE-043，API-CORE-048） ----------
await step('TC-CORE-112', async () => {
  const sb = await sketchbook();
  const P = seedProject('ForkApp', 'mobile', 2);
  const tokens = await roundProject(P.projectId);
  const S = P.screens[0].id;
  const sHtml = await currentHtml(S);
  // 1 整屏：名字是屏名、画框随项目设备、参照来源项目、写回目标是这一屏；第一版 fork、body 相同、按来源项目的 prelude、不 lint
  const r1 = await fork({ fromScreenId: S });
  expect(r1.status === 201 && r1.body.screen, `整屏建草稿 ${r1.status} ${JSON.stringify(r1.body).slice(0, 200)}`);
  const w = r1.body.screen;
  expect(w.projectId === sb && w.name === 'Screen 1' && w.frame === 'mobile' && /^\/draft-\d+$/.test(w.route), `整屏草稿：${JSON.stringify(w).slice(0, 240)}`);
  expect(w.refProjectId === P.projectId && w.targetScreenId === S && w.targetQid === null, `参照 / 写回目标：${w.refProjectId} ${w.targetScreenId} ${w.targetQid}`);
  expect(w.target?.projectId === P.projectId && w.target.projectName === 'ForkApp' && w.target.screenName === 'Screen 1', `写回目标的项目与屏名（派生）：${JSON.stringify(w.target)}`);
  const wr = await revisions(w.id);
  const wHtml = await revHtml(wr[0]);
  expect(wr.length === 1 && wr[0].sourceKind === 'fork' && (wr[0].lintReport?.violations ?? []).length === 0, `整屏草稿修订：${wr.length} ${wr[0]?.sourceKind}`);
  expect(bodyOf(wHtml) === bodyOf(sHtml), '整屏草稿的 body 应与来源屏当前版相同');
  expect(wHtml.includes(buildPrelude(tokens)), '整屏草稿应按来源项目的 prelude 拼装');
  expect(/data-qid="q1"/.test(wHtml), '草稿的 qid 应从 q1 重编');
  // 2 一块：主区 → 组件画框，名字接那一块可见文字的前 10 个字，写回目标带 qid
  const mainQid = qidOf(sHtml, /<main[^>]*data-qid="(q\d+)"/);
  const r2 = await fork({ fromScreenId: S, qid: mainQid });
  const b = r2.body.screen;
  const want = forkDraftName('Screen 1', forkBody(extractBody(sHtml), mainQid)!.text);
  expect(r2.status === 201 && b.frame === 'component' && b.name === want && b.name.startsWith('Screen 1 · ') && b.targetScreenId === S && b.targetQid === mainQid && b.refProjectId === P.projectId, `一块草稿：${r2.status} ${JSON.stringify(b).slice(0, 240)}（名字应「${want}」）`);
  const bHtml = await currentHtml(b.id);
  expect(bodyOf(bHtml) === strip(/<main[\s\S]*?<\/main>/.exec(sHtml)![0]), '一块草稿的内容应是那个元素连同子树');
  // 3 MCP 同一个入口
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const h1 = qidOf(sHtml, /<h1[^>]*data-qid="(q\d+)"/);
  const viaMcp = await callTool(mcp, 'quilt.create_draft', { fromScreenId: S, qid: h1 });
  const m = (viaMcp.json as { screen?: Screen }).screen;
  expect(!viaMcp.isError && m?.name === 'Screen 1 · Screen 1 v' && m.targetQid === h1, `quilt.create_draft：${viaMcp.text.slice(0, 200)}`);
  // 4 错误：元素不在、来源是草稿、来源不存在、缺参数
  const noEl = await fork({ fromScreenId: S, qid: 'q9999' });
  const fromDraft = await fork({ fromScreenId: w.id });
  const none = await fork({ fromScreenId: FAKE });
  const bad = await fork({});
  expect(noEl.status === 404 && noEl.body.type === '/errors/element-not-found', `qid 不在应 404 element-not-found：${noEl.status} ${noEl.body.type}`);
  expect(fromDraft.status === 404 && none.status === 404 && fromDraft.body.type === '/errors/not-found', `来源是草稿 / 不存在应 404：${fromDraft.status} ${none.status}`);
  expect(bad.status === 400 && paths(bad.body).includes('fromScreenId'), `缺 fromScreenId 应 400：${bad.status}`);
  // 5 来源屏还没有内容：钉死路由的懒生成拖住，第一版落库前建草稿 400
  const before = (await detail(P.projectId)).screens.map((x) => x.id);
  const held = await post<{ job: JobView }>(`/v1/projects/${P.projectId}/messages`, { content: '[stub-hold:6000]', route: '/later', runner: STUB });
  expect(held.status === 202, `懒生成 ${held.status}`);
  const blank = await plannedDraft(P.projectId, before);
  const r5 = await fork({ fromScreenId: blank });
  expect(r5.status === 400 && r5.body.type === '/errors/validation' && paths(r5.body).includes('fromScreenId'), `来源屏没有内容应 400：${r5.status} ${paths(r5.body)}`);
  await apiJson(`/v1/jobs/${held.body.job.id}/cancel`, { method: 'POST' });
  await waitJob(held.body.job.id, 30);
  // 6 幂等：同一个键再发一次返回首次那张、200，不多建
  const n6 = (await detail(sb)).screens.length;
  const key = crypto.randomUUID();
  const k1 = await apiJson<{ screen: Screen }>('/v1/sketchbook/drafts', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ fromScreenId: S }) });
  const k2 = await apiJson<{ screen: Screen }>('/v1/sketchbook/drafts', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ fromScreenId: S }) });
  expect(k1.status === 201 && k2.status === 200 && k1.body.screen.id === k2.body.screen.id && (await detail(sb)).screens.length === n6 + 1, `同键两次：${k1.status} ${k2.status}，草稿 ${n6} → ${(await detail(sb)).screens.length}`);
  return `整屏「${w.name}」mobile；一块「${b.name}」component；MCP「${m!.name}」；404 ×3、400 ×2；同键 201 → 200`;
});

// ---------- TC-CORE-113 参照项目：设置、改稿按它写、删了退回自由风格（REQ-CORE-042，ADR-033） ----------
await step('TC-CORE-113', async () => {
  const sb = await sketchbook();
  const P = seedProject('RefApp', 'mobile', 2);
  const pTokens = await roundProject(P.projectId);
  const pDs = (await detail(P.projectId)).designSystem;
  const sbPrelude = buildPrelude((await detail(sb)).designSystem.tokens);
  expect(buildPrelude(pTokens) !== sbPrelude, '前置：RefApp 的 prelude 应与草稿本的不同');
  const d = await newDraft(sb, '一张余额卡片\n[stub-frame:component]');
  // 1 设参照：200、不建修订
  const p1 = await patchScreen(d.id, { refProjectId: P.projectId });
  expect(p1.status === 200 && p1.body.screen.refProjectId === P.projectId && (await revisions(d.id)).length === 1, `PATCH refProjectId：${p1.status} ${JSON.stringify(p1.body).slice(0, 160)}`);
  // 2 只对草稿有效、目标得是本人的普通项目
  const onApp = await patchScreen(P.screens[0].id, { refProjectId: P.projectId });
  const toBook = await patchScreen(d.id, { refProjectId: sb });
  const toNone = await patchScreen(d.id, { refProjectId: FAKE });
  expect(onApp.status === 422 && paths(onApp.body).includes('refProjectId'), `普通屏设参照应 422：${onApp.status} ${paths(onApp.body)}`);
  expect(toBook.status === 404 && toNone.status === 404 && toBook.body.type === '/errors/not-found', `参照草稿本 / 不存在的项目应 404：${toBook.status} ${toNone.status}`);
  expect((await draftOf(sb, d.id)).refProjectId === P.projectId, '被拒的 PATCH 改动了参照项目');
  // 3 改一轮（桩通道，看得到系统提示）：带 RefApp 的 DESIGN.md、token 类与路由表；新版按 RefApp 的 prelude 拼装
  const h0 = draftStub.hits.length;
  await editDraft(sb, d.id, '标题加粗', CHANNEL());
  const hit = draftStub.hits.slice(h0).find((h) => h.system.startsWith(SKETCH_GENERATOR_MARK));
  expect(hit, '桩通道没收到改稿调用');
  const sys = hit!.system;
  expect(sys.includes('REFERENCE PROJECT: RefApp') && sys.includes(pDs.designMd.trim().slice(0, 60)) && sys.includes('bg-X / text-X') && sys.includes('/s1 (Screen 1)') && sys.includes('COMPONENT RECIPES'), `改稿系统提示没带参照项目：${sys.slice(0, 300)}`);
  expect((await currentHtml(d.id)).includes(buildPrelude(pTokens)), '改稿后的新版应按 RefApp 的 prelude 拼装');
  // 4 经 MCP 写这张草稿：同样按 RefApp 的 prelude
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const cur = (await draftOf(sb, d.id)).currentRevisionId!;
  const up = await callTool(mcp, 'quilt.update_screen', { projectId: sb, screenId: d.id, html: '<div data-frame="component" class="w-[320px] p-4 rounded-lg bg-surface text-on-surface">余额 ¥1,280.00</div>', expectedRevisionId: cur });
  expect(!up.isError && (await currentHtml(d.id)).includes(buildPrelude(pTokens)), `MCP 写草稿应按 RefApp 的 prelude：${up.text.slice(0, 160)}`);
  // 5 删掉 RefApp：参照置空，下一轮按自由风格（系统提示不带参照、prelude 回到草稿本的）
  expect((await apiJson(`/v1/projects/${P.projectId}`, { method: 'DELETE' })).status === 204, '删 RefApp 应 204');
  expect((await draftOf(sb, d.id)).refProjectId === null, '删项目后草稿的参照应置空');
  const h1 = draftStub.hits.length;
  await editDraft(sb, d.id, '再加一行说明', CHANNEL());
  const hit2 = draftStub.hits.slice(h1).find((h) => h.system.startsWith(SKETCH_GENERATOR_MARK))!;
  expect(!hit2.system.includes('REFERENCE PROJECT') && hit2.system.includes('There is no design system'), '删项目后改稿应回到自由风格');
  expect((await currentHtml(d.id)).includes(sbPrelude), '删项目后的新版应按草稿本的 prelude');
  // 6 设回 null：自由风格
  const Q = seedProject('RefApp2', 'mobile', 1);
  expect((await patchScreen(d.id, { refProjectId: Q.projectId })).body.screen.refProjectId === Q.projectId, '设参照 RefApp2');
  const p6 = await patchScreen(d.id, { refProjectId: null });
  expect(p6.status === 200 && p6.body.screen.refProjectId === null, `PATCH null：${p6.status}`);
  // 7 新草稿带参照（API-CORE-010）：第一版就按它写、按它的 prelude 拼装，草稿记下参照
  const qTokens = await roundProject(Q.projectId);
  const h2 = draftStub.hits.length;
  const d7 = await newDraft(sb, '一张会员卡', { runner: CHANNEL(), refProjectId: Q.projectId });
  const hit7 = draftStub.hits.slice(h2).find((h) => h.system.startsWith(SKETCH_GENERATOR_MARK));
  expect(hit7?.system.includes('REFERENCE PROJECT: RefApp2'), `带参照的新草稿，出稿系统提示应带 RefApp2：${hit7?.system.slice(0, 200)}`);
  expect((await draftOf(sb, d7.id)).refProjectId === Q.projectId && (await currentHtml(d7.id)).includes(buildPrelude(qTokens)), '新草稿应记下参照、第一版按 RefApp2 的 prelude 拼装');
  // 8 普通项目的消息带参照 400、参照草稿本 404、改稿带参照 400（改稿的参照在草稿上设）
  const onAppMsg = await post(`/v1/projects/${Q.projectId}/messages`, { content: 'x', refProjectId: Q.projectId });
  const refBook = await post(`/v1/projects/${sb}/messages`, { content: 'x', refProjectId: sb });
  const editRef = await post(`/v1/projects/${sb}/messages`, { content: 'x', targetScreenIds: [d7.id], refProjectId: Q.projectId });
  expect(onAppMsg.status === 400 && paths(onAppMsg.body).includes('refProjectId'), `普通项目的消息带参照应 400：${onAppMsg.status} ${paths(onAppMsg.body)}`);
  expect(refBook.status === 404 && editRef.status === 400 && paths(editRef.body).includes('refProjectId'), `参照草稿本应 404、改稿带参照应 400：${refBook.status} ${editRef.status} ${paths(editRef.body)}`);
  return 'PATCH 200 不建修订；普通屏 422、草稿本 / 不存在 404；改稿带 DESIGN.md、token 类、路由、按参照 prelude；MCP 写入同；删项目置空回自由风格；null 200；新草稿带参照第一版就按它写；带错地方 400 / 404';
});

// ---------- TC-CORE-114 覆盖整屏可回溯；restyle 缺省按参照项目；写回目标（REQ-CORE-044 / REQ-CORE-041，INV-CORE-005） ----------
await step('TC-CORE-114', async () => {
  const sb = await sketchbook();
  const P = seedProject('OverApp', 'mobile', 2);
  const S = P.screens[1].id;
  const before = await revisions(S);
  const n = before[0];
  const nBody = await revBody(n);
  const d = await newDraft(sb, '一张新的首页\n[stub-frame:mobile]');
  const dRevs = await revisions(d.id);
  const dBody = await revBody(dRevs[0]);
  // 1 覆盖要给目标屏与确认时的修订，且不改写
  const v1 = await copy(d.id, { projectId: P.projectId, as: 'overwrite' });
  const v2 = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, expectedRevisionId: n.id, restyle: true });
  expect(v1.status === 400 && paths(v1.body).includes('screenId') && paths(v1.body).includes('expectedRevisionId'), `覆盖缺目标应 400 点名：${v1.status} ${paths(v1.body)}`);
  expect(v2.status === 400 && paths(v2.body).includes('restyle'), `覆盖带 restyle:true 应 400：${v2.status} ${paths(v2.body)}`);
  // 2 覆盖整屏：201，S 多一版 sketch、父修订是原来的当前版、body 与草稿相同、已有修订不动；不建作业
  const r = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, expectedRevisionId: n.id });
  expect(r.status === 201 && r.body.screen?.id === S && r.body.revisionId && r.body.previousRevisionId === n.id && !r.body.job, `覆盖整屏：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const after = await revisions(S);
  expect(after.length === before.length + 1 && after[0].id === r.body.revisionId && after[0].sourceKind === 'sketch' && after[0].seq === n.seq + 1 && after[0].parentRevisionId === n.id, `覆盖后修订：${after.length} 条，首条 ${after[0].sourceKind} seq ${after[0].seq} 父 ${after[0].parentRevisionId}`);
  expect(JSON.stringify(after.slice(1).map((x) => x.id)) === JSON.stringify(before.map((x) => x.id)) && (await revBody(after[1])) === nBody, '覆盖改动了已有修订');
  expect((await revBody(after[0])) === dBody, '覆盖后的 body 应与草稿当前版相同');
  expect((await revHtml(after[0])).includes(buildPrelude((await detail(P.projectId)).designSystem.tokens)), '覆盖后应按目标项目的 prelude 拼装');
  const t1 = await draftOf(sb, d.id);
  expect(t1.targetScreenId === S && t1.targetQid === null, `整屏覆盖后写回目标：${t1.targetScreenId} ${t1.targetQid}`);
  expect((await revisions(d.id)).length === dRevs.length, '覆盖不该给草稿加修订');
  // 3 回到覆盖前那一版
  const back = await post<{ revision: Rev }>(`/v1/screens/${S}/revisions/${n.id}/restore`, { expectedRevisionId: r.body.revisionId });
  expect(back.status === 200 && back.body.revision.id === n.id && (await detail(P.projectId)).screens.find((x) => x.id === S)!.currentRevisionId === n.id, `回溯到第 ${n.seq} 版：${back.status}`);
  // 4 restyle 缺省：草稿没参照目标项目 → 新屏建改写作业；参照的就是目标项目 → 不建；落成组件不改写回目标
  const s1 = await copy(d.id, { projectId: P.projectId, as: 'screen', name: 'Fresh Home', runner: STUB });
  expect(s1.status === 201 && s1.body.job?.kind === 'edit_screens', `没参照时新屏应缺省改写：${s1.status} ${JSON.stringify(s1.body.job ?? null).slice(0, 120)}`);
  await waitJob(s1.body.job!.id, 60);
  const t2 = await draftOf(sb, d.id);
  expect(t2.targetScreenId === s1.body.screen!.id && t2.targetQid === null, '落成新屏后写回目标应是新屏');
  expect((await patchScreen(d.id, { refProjectId: P.projectId })).status === 200, '设参照 OverApp');
  const s2 = await copy(d.id, { projectId: P.projectId, as: 'screen', name: 'Same Look', runner: STUB });
  expect(s2.status === 201 && !s2.body.job, `参照就是目标项目时新屏不该改写：${JSON.stringify(s2.body.job ?? null).slice(0, 120)}`);
  const Q = seedProject('OtherApp', 'desktop', 1);
  const s3 = await copy(d.id, { projectId: Q.projectId, as: 'screen', runner: STUB });
  expect(s3.status === 201 && s3.body.job?.kind === 'edit_screens', '参照别的项目时新屏应缺省改写');
  await waitJob(s3.body.job!.id, 60);
  const t3 = await draftOf(sb, d.id);
  const c4 = await copy(d.id, { projectId: P.projectId, as: 'component', name: 'HomeBlock' });
  const t4 = await draftOf(sb, d.id);
  expect(c4.status === 201 && c4.body.component && !c4.body.job && t4.targetScreenId === t3.targetScreenId && t4.targetQid === t3.targetQid, `落成组件：${c4.status} job=${!!c4.body.job}，写回目标 ${t3.targetScreenId} → ${t4.targetScreenId}`);
  // 5 MCP：screenId 是草稿、targetScreenId 是目标屏
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const cur = (await detail(P.projectId)).screens.find((x) => x.id === S)!.currentRevisionId!;
  const viaMcp = await callTool(mcp, 'quilt.copy_draft', { screenId: d.id, projectId: P.projectId, as: 'overwrite', targetScreenId: S, expectedRevisionId: cur });
  const mj = viaMcp.json as CopyResult;
  expect(!viaMcp.isError && mj.screen?.id === S && mj.previousRevisionId === cur, `quilt.copy_draft 覆盖：${viaMcp.text.slice(0, 200)}`);
  const noTarget = await callTool(mcp, 'quilt.copy_draft', { screenId: d.id, projectId: P.projectId, as: 'overwrite', expectedRevisionId: cur });
  expect(noTarget.isError && JSON.stringify(noTarget.json).includes('targetScreenId'), `MCP 覆盖缺 targetScreenId 应点名：${noTarget.text.slice(0, 200)}`);
  return `覆盖整屏 seq ${n.seq}→${n.seq + 1}（sketch）、回溯回原样；restyle 缺省：没参照建作业、参照目标不建、参照别处建；组件不改写回目标；MCP 覆盖`;
});

// ---------- TC-CORE-115 换一块：只换那个元素，组件实例与其余原样（REQ-CORE-043 / REQ-CORE-044，ADR-032） ----------
await step('TC-CORE-115', async () => {
  const sb = await sketchbook();
  const P = seedProject('BlockApp', 'mobile', 2);
  const S = P.screens[0].id;
  await tabBarOn(P.projectId, S);
  const html0 = await currentHtml(S);
  const mainQid = qidOf(html0, /<main[^>]*data-qid="(q\d+)"/);
  // 1 从主区建草稿，改一轮
  const f = (await fork({ fromScreenId: S, qid: mainQid })).body.screen;
  await editDraft(sb, f.id, '换成一张播放卡片\n[stub-frame:component]');
  const fBody = await revBody((await revisions(f.id))[0]);
  expect(fBody.includes('Now playing'), '前置：改过一轮的草稿应是播放卡片');
  // 2 换一块：S 多一版，主区换成草稿根（沿用主区的 qid），顶栏与 TabBar 实例原样
  const cur = (await revisions(S))[0];
  const r = await copy(f.id, { projectId: P.projectId, as: 'overwrite', screenId: S, qid: mainQid, expectedRevisionId: cur.id });
  expect(r.status === 201 && r.body.previousRevisionId === cur.id, `换一块：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const html1 = await currentHtml(S);
  expect(!/<main[\s>]/.test(html1) && html1.includes('Now playing') && new RegExp(`data-qid="${mainQid}"`).test(html1), '主区应整块换成草稿、根沿用原 qid');
  expect(headerOf(html1) === headerOf(html0) && navOf(html1) === navOf(html0) && /<nav[^>]*data-component="TabBar"/.test(html1), '顶栏或 TabBar 实例被动了');
  const t = await draftOf(sb, f.id);
  expect(t.targetScreenId === S && t.targetQid === mainQid, `写回目标应记成换进去那块的编号：${t.targetQid}`);
  // 3 再改一轮、按写回目标再写一次（缺省覆盖原处）：只多一版，仍是那一块
  await editDraft(sb, f.id, '再改一点\n[stub-patch]');
  const revs2 = await revisions(S);
  const r2 = await copy(f.id, { projectId: P.projectId, as: 'overwrite', screenId: t.targetScreenId, qid: t.targetQid, expectedRevisionId: revs2[0].id });
  const html2 = await currentHtml(S);
  expect(r2.status === 201 && (await revisions(S)).length === revs2.length + 1 && html2.includes('Patched title') && navOf(html2) === navOf(html0), `第二次换一块：${r2.status} ${JSON.stringify(r2.body).slice(0, 160)}`);
  return `主区 ${mainQid} 换成播放卡片、顶栏与 TabBar 原样；写回目标 ${t.targetQid}；按写回目标再写一次`;
});

// ---------- TC-CORE-116 写回的冲突与失败：别处改过、正在改、组件实例、元素不在、超限（§16 两条竞态，API-CORE-047） ----------
await step('TC-CORE-116', async () => {
  const sb = await sketchbook();
  const P = seedProject('ClashApp', 'mobile', 2);
  const S = P.screens[0].id;
  await tabBarOn(P.projectId, S);
  const d = await newDraft(sb, '一块面板\n[stub-frame:component]');
  const html0 = await currentHtml(S);
  const h1 = qidOf(html0, /<h1[^>]*data-qid="(q\d+)"/);
  const count = async () => (await revisions(S)).length;
  // 1 确认之后 S 被别处改过（直改标题）：用旧修订覆盖 409 revision-conflict，S 停在别处那一版
  const n = (await revisions(S))[0];
  const edited = await post<{ revision: Rev }>(`/v1/screens/${S}/elements/${h1}`, { ops: [{ type: 'text', value: '别处改过' }], expectedRevisionId: n.id });
  expect(edited.status === 201, `前置直改 ${edited.status}`);
  const k1 = await count();
  const stale = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, expectedRevisionId: n.id });
  expect(stale.status === 409 && stale.body.type === '/errors/revision-conflict' && (await count()) === k1 && (await revisions(S))[0].id === edited.body.revision.id, `旧修订覆盖应 409 revision-conflict：${stale.status} ${stale.body.type}`);
  // 2 S 正被作业改：409 screen-busy，不写入
  const held = await post<{ job: JobView }>(`/v1/projects/${P.projectId}/messages`, { content: '慢慢改\n[stub-hold:6000]', targetScreenIds: [S], runner: STUB });
  expect(held.status === 202, `前置改屏作业 ${held.status}`);
  const busy = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, expectedRevisionId: edited.body.revision.id });
  expect(busy.status === 409 && busy.body.type === '/errors/screen-busy' && (await count()) === k1, `目标屏正在改应 409 screen-busy：${busy.status} ${busy.body.type}`);
  await apiJson(`/v1/jobs/${held.body.job.id}/cancel`, { method: 'POST' });
  await waitJob(held.body.job.id, 30);
  const cur = (await revisions(S))[0].id;
  // 3 要换的元素在 TabBar 实例里（实例根与里面的链接）：409 component-locked
  const html1 = await currentHtml(S);
  const navRoot = qidOf(html1, /<nav[^>]*data-qid="(q\d+)"/);
  const navLink = qidOf(/<nav[\s\S]*?<\/nav>/.exec(html1)![0], /<a[^>]*data-qid="(q\d+)"/);
  for (const q of [navRoot, navLink]) {
    const locked = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, qid: q, expectedRevisionId: cur });
    expect(locked.status === 409 && locked.body.type === '/errors/component-locked', `${q} 在组件实例里应 409 component-locked：${locked.status} ${locked.body.type}`);
  }
  // 4 元素不在 / 目标屏不在目标项目里 / 目标是草稿本
  const noEl = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: S, qid: 'q9999', expectedRevisionId: cur });
  const otherScreen = await copy(d.id, { projectId: P.projectId, as: 'overwrite', screenId: d.id, expectedRevisionId: cur });
  const toBook = await copy(d.id, { projectId: sb, as: 'overwrite', screenId: S, expectedRevisionId: cur });
  expect(noEl.status === 404 && noEl.body.type === '/errors/element-not-found', `qid 不在应 404 element-not-found：${noEl.status} ${noEl.body.type}`);
  expect(otherScreen.status === 404 && toBook.status === 404 && otherScreen.body.type === '/errors/not-found', `目标屏不在项目里 / 目标是草稿本应 404：${otherScreen.status} ${toBook.status}`);
  // 5 写入后整页超过 256 KB：400，path html
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const bigHtml = `<div data-frame="component" class="w-[360px]"><p>${'x'.repeat(258_000)}</p></div>`;
  const big = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '很长的草稿', html: bigHtml });
  expect(!big.isError, `前置大草稿：${big.text.slice(0, 160)}`);
  const bigId = (big.json as { screenId: string }).screenId;
  const huge = await copy(bigId, { projectId: P.projectId, as: 'overwrite', screenId: S, qid: h1, expectedRevisionId: cur });
  expect(huge.status === 400 && huge.body.type === '/errors/validation' && paths(huge.body).includes('html') && JSON.stringify(huge.body).includes('256 KB'), `超限应 400 path html：${huge.status} ${paths(huge.body)}`);
  expect((await count()) === k1 && (await revisions(S))[0].id === cur, '失败的写回改动了目标屏');
  return '别处改过 409、正在改 409、组件实例 409 ×2、元素不在 404、目标不对 404 ×2、超限 400；目标屏始终不变';
});

// ---------- TC-CORE-117 草稿里只改一块（REQ-CORE-045，API-CORE-006） ----------
await step('TC-CORE-117', async () => {
  const sb = await sketchbook();
  const d = await newDraft(sb, '一张播放卡片\n[stub-frame:component]');
  const r0 = (await revisions(d.id))[0];
  const html0 = await revHtml(r0);
  const pQid = qidOf(html0, /<p[^>]*data-qid="(q\d+)"[^>]*>Midnight City/);
  const h1 = qidOf(html0, /<h1[^>]*data-qid="(q\d+)"/);
  // 1 只改一块：草稿本受理 regenerate_subtree，落成 subtree 一版、不 lint；只有那个元素变了
  const j = await post<{ job: JobView } & Problem>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid: pQid, prompt: '换成一行青色的小字', expectedRevisionId: r0.id, runner: STUB } });
  expect(j.status === 202, `草稿上的 regenerate_subtree：${j.status} ${JSON.stringify(j.body).slice(0, 200)}`);
  expect((await waitJob(j.body.job.id, 60)).status === 'succeeded', '只改一块的作业没成功');
  const revs1 = await revisions(d.id);
  const html1 = await revHtml(revs1[0]);
  expect(revs1.length === 2 && revs1[0].sourceKind === 'subtree' && (revs1[0].lintReport?.violations ?? []).length === 0, `只改一块后修订：${revs1.length} ${revs1[0].sourceKind}`);
  expect(html1.includes('Regenerated block') && !html1.includes('Midnight City') && new RegExp(`<p[^>]*data-qid="${pQid}"[^>]*>Regenerated block`).test(html1), '那一块应换成新的、沿用原 qid');
  expect(strip(/<h1[\s\S]*?<\/h1>/.exec(html1)![0]) === strip(/<h1[\s\S]*?<\/h1>/.exec(html0)![0]), '别的元素不该变');
  // 2 旧修订 409、草稿本里目标不是草稿 404
  const stale = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid: h1, prompt: 'x', expectedRevisionId: r0.id, runner: STUB } });
  const P = seedProject('SubApp', 'mobile', 1);
  const pRev = (await revisions(P.screens[0].id))[0];
  const pH1 = qidOf(await revHtml(pRev), /<h1[^>]*data-qid="(q\d+)"/);
  const notDraft = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: P.screens[0].id, qid: pH1, prompt: 'x', expectedRevisionId: pRev.id, runner: STUB } });
  expect(stale.status === 409 && stale.body.type === '/errors/revision-conflict', `旧修订应 409 revision-conflict：${stale.status} ${stale.body.type}`);
  expect(notDraft.status === 404 && notDraft.body.type === '/errors/not-found', `草稿本里改普通屏的一块应 404：${notDraft.status} ${notDraft.body.type}`);
  // 3 有参照项目时（桩通道看系统提示）：草稿规则 + 参照项目，按它的 prelude 落库；经 MCP 同一条路
  const pTokens = await roundProject(P.projectId);
  expect((await patchScreen(d.id, { refProjectId: P.projectId })).status === 200, '设参照 SubApp');
  const h0 = draftStub.hits.length;
  const j2 = await post<{ job: JobView }>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid: h1, prompt: '标题换成本项目的主色', expectedRevisionId: revs1[0].id, runner: CHANNEL() } });
  expect(j2.status === 202 && (await waitJob(j2.body.job.id, 60)).status === 'succeeded', `带参照只改一块：${j2.status}`);
  const sys = draftStub.hits.slice(h0).find((h) => h.system.startsWith(SKETCH_GENERATOR_MARK))?.system ?? '';
  expect(sys.includes('REFERENCE PROJECT: SubApp') && sys.includes('DRAFT RULES'), `只改一块的系统提示应是草稿规则 + 参照项目：${sys.slice(0, 200)}`);
  expect((await currentHtml(d.id)).includes(buildPrelude(pTokens)), '带参照只改一块应按 SubApp 的 prelude 落库');
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const r2 = (await revisions(d.id))[0];
  const viaMcp = await callTool(mcp, 'quilt.regenerate_subtree', { screenId: d.id, qid: h1, prompt: '再小一号', expectedRevisionId: r2.id, runner: STUB });
  expect(!viaMcp.isError && (await waitJob((viaMcp.json as { id: string }).id, 60)).status === 'succeeded', `MCP 草稿上的 regenerate_subtree：${viaMcp.text.slice(0, 200)}`);
  return '草稿上 regenerate_subtree 只换那一块（subtree、不 lint）；旧修订 409、非草稿 404；带参照用草稿规则 + 参照、按参照 prelude；MCP 同';
});

// ---------- TC-CORE-118 交给本机会话：有参照项目的草稿读那个项目的契约、只改一块用草稿规则（假会话，REQ-CORE-042 / REQ-CORE-045） ----------
await step('TC-CORE-118', async () => {
  const DIR = process.env.QUILT_CLAUDE_SESSIONS_DIR ?? '';
  if (!DIR) throw new Skip('未设 QUILT_CLAUDE_SESSIONS_DIR（API 与本脚本都要以同一目录启动，§3）');
  const claude = (await apiJson<{ items: { id: string; available: boolean; unavailableReason?: string }[] }>('/v1/runners')).body.items.find((r) => r.id === 'agent:claude-code');
  if (!claude?.available) throw new Skip(`本机 claude 不可用（${claude?.unavailableReason ?? ''}）`);
  const { startFakeSession } = await import('./agent-stub.ts');
  const fake = await startFakeSession({ dir: DIR, name: 'Stub 参照', nameSource: 'user' });
  cleanups.push(() => fake.close());
  await sleep(2100); // 服务端会话列表缓存 2 s
  const sb = await sketchbook();
  const P = seedProject('AgentRef', 'mobile', 1);
  const d = await newDraft(sb, '一张播放卡片\n[stub-frame:component]');
  expect((await patchScreen(d.id, { refProjectId: P.projectId })).status === 200, '设参照 AgentRef');
  const agent = { kind: 'agent', tool: 'claude-code', sessionId: fake.sessionId };
  const delivered = async (n0: number) => { for (let i = 0; i < 40 && fake.received.length === n0; i++) await sleep(250); expect(fake.received.length > n0, '假会话没收到投递'); return fake.received[n0]; };
  // 1 改草稿：让会话读参照项目的设计契约，写回仍进草稿本；规则是带参照的那一份
  let n0 = fake.received.length;
  const e = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: 'HANG 标题换成本项目的主色', targetScreenIds: [d.id], runner: agent });
  expect(e.status === 202, `改草稿交给会话：${e.status}`);
  const p1 = await delivered(n0);
  expect(p1.includes(`quilt.get_design_contract { projectId: "${P.projectId}" }`) && p1.includes('REFERENCE PROJECT') && p1.includes(`projectId: "${sb}"`) && p1.includes(`screenId=${d.id}`) && !p1.includes('There is no design system'), `有参照的改稿投递提示词不对：${p1.slice(0, 600)}`);
  await apiJson(`/v1/jobs/${e.body.job.id}/cancel`, { method: 'POST' });
  await waitJob(e.body.job.id, 30);
  // 2 只改一块：草稿本里同样投递，提示词是草稿规则 + 只动那一块
  const rev = (await revisions(d.id))[0];
  const h1 = qidOf(await revHtml(rev), /<h1[^>]*data-qid="(q\d+)"/);
  n0 = fake.received.length;
  const j = await post<{ job: JobView }>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid: h1, prompt: 'HANG 标题加粗', expectedRevisionId: rev.id, runner: agent } });
  expect(j.status === 202 && j.body.job.runner === 'agent', `只改一块交给会话：${j.status} ${JSON.stringify(j.body).slice(0, 160)}`);
  const p2 = await delivered(n0);
  expect(p2.includes(`data-qid="${h1}"`) && p2.includes('on the target draft') && p2.includes('DRAFT RULES') && p2.includes(`expectedRevisionId=${rev.id}`) && !p2.includes('Target screens'), `只改一块的投递提示词不对：${p2.slice(0, 600)}`);
  await apiJson(`/v1/jobs/${j.body.job.id}/cancel`, { method: 'POST' });
  await waitJob(j.body.job.id, 30);
  return '改稿投递带参照项目的契约入口、写回草稿本；只改一块投递草稿规则 + 那一块';
});

// ---------- TC-CORE-119 画布上「到草稿本里改」：整屏与一块（浏览器，REQ-CORE-043） ----------
await step('TC-CORE-119', async () => {
  const sb = await sketchbook();
  const P = seedProject('ForkUi', 'mobile', 2);
  const S = P.screens[0].id;
  const h1 = qidOf(await currentHtml(S), /<h1[^>]*data-qid="(q\d+)"/);
  const newDraftId = async (before: string[]) => { let id = ''; await eventually(async () => { const s = (await detail(sb)).screens.find((x) => !before.includes(x.id)); expect(s, '没建出新草稿'); id = s!.id; }, 10000, 200); return id; };
  // 1 选中一屏：工具栏多一项，点了建整屏草稿并打开它
  await page.goto(`${WEB}/p/${P.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  const tool = page.getByTestId('fork-to-sketch');
  await tool.waitFor({ timeout: 5000 });
  let before = (await detail(sb)).screens.map((s) => s.id);
  await tool.click();
  await page.waitForURL(/\/sketch\?d=/, { timeout: 10000 });
  const w = await newDraftId(before);
  expect(urlDraft() === w, `打开的不是新草稿：${urlDraft()} vs ${w}`);
  await waitStage('draft');
  const wd = await draftOf(sb, w);
  expect(wd.targetScreenId === S && wd.targetQid === null && wd.frame === 'mobile' && wd.refProjectId === P.projectId, `整屏草稿：${JSON.stringify(wd).slice(0, 200)}`);
  // 2 多选两屏：这一项不出现
  await page.goto(`${WEB}/p/${P.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('[data-testid="screen-card"][data-route="/s2"] .gesture').click({ modifiers: ['Shift'] });
  await sleep(400);
  expect((await page.getByTestId('fork-to-sketch').count()) === 0, '多选时不该有「到草稿本里改」');
  // 3 检查器里选中一块：带那一块建草稿
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const el = page.frameLocator('.card.focused iframe').locator(`[data-qid="${h1}"]`);
  await el.waitFor({ timeout: 15000 });
  await sleep(400);
  await el.evaluate((n) => (n as HTMLElement).click());
  const elTool = page.getByTestId('el-fork-to-sketch');
  await elTool.waitFor({ timeout: 5000 });
  before = (await detail(sb)).screens.map((s) => s.id);
  await elTool.click();
  await page.waitForURL(/\/sketch\?d=/, { timeout: 10000 });
  const b = await newDraftId(before);
  await waitStage('draft');
  const bd = await draftOf(sb, b);
  expect(bd.targetScreenId === S && bd.targetQid === h1 && bd.frame === 'component', `一块草稿：${JSON.stringify(bd).slice(0, 200)}`);
  return '工具栏整屏建草稿并打开、多选不出现、检查器带那一块建组件草稿';
});

// ---------- TC-CORE-120 「写回项目…」弹层：覆盖整屏、版本过期、写回目标被删（浏览器，REQ-CORE-044） ----------
await step('TC-CORE-120', async () => {
  const sb = await sketchbook();
  const P = seedProject('BackApp', 'mobile', 2);
  const S = P.screens[0].id;
  const f = (await fork({ fromScreenId: S })).body.screen;
  await editDraft(sb, f.id, '标题改成「新的首页」');
  // 弹层拿的是打开那一刻的草稿：等它这一版的截图拍好再开，缩略图才有图（种子项目不拍截图，目标屏那格是「还没有截图」）
  await eventually(async () => expect((await draftOf(sb, f.id)).screenshotUrl, '草稿这一版的截图还没拍好'), 20000, 300);
  const sNow = async () => (await detail(P.projectId)).screens.find((s) => s.id === S)!;
  await openSketch(f.id);
  await waitStage('draft', 10000);
  // 1 打开弹层：缺省写回目标那个项目、覆盖整屏；两张缩略图；回到第 n 版的说明
  await page.getByTestId('draft-copy').click();
  const dlg = page.getByTestId('copy-dialog');
  await dlg.waitFor({ timeout: 5000 });
  expect((await chosen('copy-project')) === P.projectId || (await page.getByTestId('copy-project').innerText()).includes('BackApp'), '目标项目缺省应是写回目标所在的 BackApp');
  expect((await chosen('copy-as')) === 'overwrite', `方式缺省应为覆盖整屏：${await chosen('copy-as')}`);
  await page.getByTestId('copy-compare').waitFor({ timeout: 10000 });
  const s0 = await sNow();
  await eventually(async () => { const cmp = page.getByTestId('copy-compare'); expect((await cmp.locator('figure').count()) === 2 && (await cmp.locator('figure').nth(1).locator('img').count()) === 1, '覆盖整屏应并排两格：左目标屏（没截图时写「还没有截图」）、右草稿缩略图'); }, 15000, 300);
  await eventually(async () => { const t = await page.getByTestId('copy-restore-hint').innerText(); expect(t.includes('Screen 1') && t.includes(`第 ${s0.currentRevisionSeq} 版`), `回到第 n 版的说明：「${t}」`); }, 5000);
  expect((await page.getByTestId('copy-restyle').count()) === 0, '覆盖整屏不该有改写勾选');
  // 2 确认前目标屏被别处改过：409，弹层不关、写原因并刷新目标，再确认就成
  const h1 = qidOf(await currentHtml(S), /<h1[^>]*data-qid="(q\d+)"/);
  const edited = await post<{ revision: Rev }>(`/v1/screens/${S}/elements/${h1}`, { ops: [{ type: 'text', value: '别处改过' }], expectedRevisionId: s0.currentRevisionId });
  expect(edited.status === 201, `前置直改 ${edited.status}`);
  await page.getByTestId('copy-submit').click();
  await eventually(async () => expect((await page.getByTestId('copy-error').innerText()).includes('刚被改过'), '版本过期应就地写原因'), 8000);
  expect(await dlg.isVisible(), '版本过期时弹层不该关');
  await eventually(async () => expect((await page.getByTestId('copy-restore-hint').innerText()).includes(`第 ${s0.currentRevisionSeq! + 1} 版`), '刷新后应按别处改过的那一版写说明'), 8000);
  const req = page.waitForRequest((r) => r.url().includes(`/v1/sketchbook/drafts/${f.id}/copy`) && r.method() === 'POST');
  await page.getByTestId('copy-submit').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { as?: string; screenId?: string; expectedRevisionId?: string; restyle?: boolean; qid?: string };
  expect(body.as === 'overwrite' && body.screenId === S && body.expectedRevisionId === edited.body.revision.id && body.restyle === undefined && body.qid === undefined, `请求体不对：${JSON.stringify(body)}`);
  await page.getByText('已写回「BackApp」').first().waitFor({ timeout: 10000 });
  const revs = await revisions(S);
  expect(revs[0].sourceKind === 'sketch' && revs[0].parentRevisionId === edited.body.revision.id, `S 应多一版 sketch、父修订是别处改过那版：${revs[0].sourceKind}`);
  // 3 写回目标那一屏被删：退回参照项目、方式新屏，并写明原来那一屏不在了
  expect((await apiJson(`/v1/screens/${S}`, { method: 'DELETE' })).status === 204, '删 S');
  await openSketch(f.id);
  await waitStage('draft', 10000);
  await page.getByTestId('draft-copy').click();
  await dlg.waitFor({ timeout: 5000 });
  await page.getByTestId('copy-target-gone').waitFor({ timeout: 5000 });
  expect((await chosen('copy-as')) === 'screen', `写回目标被删后方式应退回新屏：${await chosen('copy-as')}`);
  expect((await chosen('copy-project')) === P.projectId || (await page.getByTestId('copy-project').innerText()).includes('BackApp'), '写回目标被删后应退回参照项目 BackApp');
  await page.keyboard.press('Escape');
  return '缺省覆盖写回目标、两张缩略图、回到第 n 版；版本过期就地说明并刷新后写回成功；目标被删退回参照项目与新屏';
});

// ---------- TC-CORE-121 「写回项目…」弹层：换一块，在活预览里点选（浏览器，REQ-CORE-044） ----------
await step('TC-CORE-121', async () => {
  const sb = await sketchbook();
  const P = seedProject('PickApp', 'mobile', 2);
  const S = P.screens[0].id;
  await tabBarOn(P.projectId, S);
  const html0 = await currentHtml(S);
  const mainQid = qidOf(html0, /<main[^>]*data-qid="(q\d+)"/);
  const f = (await fork({ fromScreenId: S, qid: mainQid })).body.screen;
  await editDraft(sb, f.id, '换成一张播放卡片\n[stub-frame:component]');
  await openSketch(f.id);
  await waitStage('draft', 10000);
  // 1 缺省换一块，活预览里预选那一块
  await page.getByTestId('draft-copy').click();
  await page.getByTestId('copy-dialog').waitFor({ timeout: 5000 });
  expect((await chosen('copy-as')) === 'replace', `写回目标带元素时方式应为换一块：${await chosen('copy-as')}`);
  await eventually(async () => expect((await page.getByTestId('target-picker').getAttribute('data-ready')) === 'true', '活预览没就绪'), 15000, 200);
  await eventually(async () => expect((await page.getByTestId('copy-picked').innerText()).includes('换掉'), '预选那一块应写「换掉 …」'), 5000);
  const picked0 = await page.getByTestId('copy-picked').innerText();
  // 2 点到共享组件实例里：不选中，就地说明
  const pf = page.frameLocator('[data-testid="target-picker"] iframe');
  await clickInScaled('[data-testid="target-picker"] iframe', pf.locator('nav[data-component] a').first());
  await page.getByTestId('copy-locked').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('copy-locked').innerText()).includes('共享组件'), '点在组件实例里应说明「这是共享组件」');
  expect((await page.getByTestId('copy-picked').innerText()) === picked0, '点在组件实例里不该换掉已选的那一块');
  // 3 确认：带那一块的 qid；S 多一版，TabBar 实例原样
  const cur = (await revisions(S))[0].id;
  const req = page.waitForRequest((r) => r.url().includes(`/v1/sketchbook/drafts/${f.id}/copy`) && r.method() === 'POST');
  await page.getByTestId('copy-submit').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { as?: string; screenId?: string; qid?: string; expectedRevisionId?: string };
  expect(body.as === 'overwrite' && body.screenId === S && body.qid === mainQid && body.expectedRevisionId === cur, `请求体不对：${JSON.stringify(body)}`);
  await page.getByText('已写回「PickApp」').first().waitFor({ timeout: 10000 });
  const html1 = await currentHtml(S);
  expect(html1.includes('Now playing') && navOf(html1) === navOf(html0), '换一块后应只换主区、TabBar 实例原样');
  return `缺省换一块并预选「${picked0}」；组件实例里点不中；写回只换那一块`;
});

// ---------- TC-CORE-122 草稿里点选一块改它（浏览器，REQ-CORE-045） ----------
await step('TC-CORE-122', async () => {
  const sb = await sketchbook();
  const d = await newDraft(sb, '一张播放卡片\n[stub-frame:component]');
  const name = (await draftOf(sb, d.id)).name;
  const html0 = await currentHtml(d.id);
  const pQid = qidOf(html0, /<p[^>]*data-qid="(q\d+)"/);
  await openSketch(d.id);
  await useStubRunner();
  await waitStage('draft', 10000);
  const pressed = async (id: string) => (await page.getByTestId(id).getAttribute('aria-pressed')) === 'true';
  // 1 开「选元素」，点草稿里的一段字：输入框多一枚胶囊，动词行写「改这一块」
  await page.getByTestId('draft-pick').click();
  expect((await pressed('draft-pick')) && (await page.getByTestId('draft-annotate').count()) === 0, '「选元素」应开着、工具条上没有「批注」');
  const fl = page.frameLocator('[data-testid="draft-iframe"]');
  await settledComponent();
  await clickInScaled('[data-testid="draft-iframe"]', fl.locator(`[data-qid="${pQid}"]`));
  const chip = page.getByTestId('draft-pick-chip');
  await chip.waitFor({ timeout: 5000 });
  expect((await chip.innerText()).includes(`「${name}」里的`), `胶囊应写「「${name}」里的 …」：${await chip.innerText()}`);
  expect((await page.getByTestId('verb-line').innerText()).includes('改这一块'), `动词行应写「改这一块」：${await page.getByTestId('verb-line').innerText()}`);
  // 2 发送：建 regenerate_subtree，目标是这张草稿与那一块；新版落库后胶囊清掉
  const r0 = (await revisions(d.id))[0].id;
  await page.getByTestId('composer-input').fill('换成一行青色的小字');
  const req = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/v1/projects/${sb}/jobs`);
  await page.getByTestId('composer-send').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { kind?: string; input?: { screenId?: string; qid?: string; expectedRevisionId?: string } };
  expect(body.kind === 'regenerate_subtree' && body.input?.screenId === d.id && body.input.qid === pQid && body.input.expectedRevisionId === r0, `请求体不对：${JSON.stringify(body)}`);
  await eventually(async () => expect((await revisions(d.id))[0].sourceKind === 'subtree', '草稿还没多出改一块的那一版'), 30000, 500);
  await eventually(async () => expect((await chip.count()) === 0, '新版落库后胶囊应清掉'), 10000);
  // 3 再点一块后按 Esc：只去掉胶囊，看板不收起
  await settledComponent();
  await clickInScaled('[data-testid="draft-iframe"]', fl.locator('h1, h2, h3').first());
  await chip.waitFor({ timeout: 5000 });
  await page.getByTestId('composer-input').focus();
  await page.keyboard.press('Escape');
  await eventually(async () => expect((await chip.count()) === 0, 'Esc 应去掉胶囊'), 3000);
  expect((await stageState()) === 'draft', 'Esc 去胶囊时不该收起看板');
  // 一块也没选时再按 Esc：关掉选元素，同 ⌘E，看板还在（v1.38）
  await page.keyboard.press('Escape');
  await eventually(async () => expect(!(await pressed('draft-pick')), '没选中任何块时 Esc 应关掉选元素'), 3000);
  expect((await stageState()) === 'draft', 'Esc 关掉选元素时不该收起看板');
  // 4 快捷键同画布：页面上 ⌘E 开关选元素，⌥N 什么也不开；焦点在草稿里按 ⌘E 由运行时转发上来
  if (await pressed('draft-pick')) await page.getByTestId('draft-pick').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+KeyE');
  await eventually(async () => expect(await pressed('draft-pick'), '⌘E 没打开「选元素」'), 2000);
  await page.keyboard.press('ControlOrMeta+KeyE');
  await eventually(async () => expect(!(await pressed('draft-pick')), '再按 ⌘E 没关掉「选元素」'), 2000);
  const url4 = page.url();
  await page.keyboard.press('Alt+KeyN');
  await sleep(500);
  expect(!(await pressed('draft-pick')) && (await page.getByTestId('draft-annotate').count()) === 0 && page.url() === url4 && (await stageState()) === 'draft', `⌥N 不该打开任何东西：选元素 ${await pressed('draft-pick')}，地址 ${page.url()}，看板 ${await stageState()}`);
  await settledComponent();
  await clickInScaled('[data-testid="draft-iframe"]', fl.locator('p').first());
  await sleep(300);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'draft-iframe'), '点进草稿后焦点应在草稿 iframe 里');
  await page.keyboard.press('ControlOrMeta+KeyE');
  await eventually(async () => expect(await pressed('draft-pick'), '焦点在草稿里按 ⌘E 没打开「选元素」（运行时转发）'), 3000);
  await page.getByTestId('draft-pick').click();
  return '选元素出胶囊、改这一块建 regenerate_subtree、新版后胶囊清掉、Esc 只去胶囊；⌘E 开关、⌥N 什么也不开，焦点在草稿里 ⌘E 照样生效';
});

// ---------- TC-CORE-123 参照项目与「来自」（浏览器，REQ-CORE-042、REQ-CORE-043） ----------
await step('TC-CORE-123', async () => {
  const sb = await sketchbook();
  const P = seedProject('RefUi', 'mobile', 1);
  const d = await newDraft(sb, '一张余额卡片\n[stub-frame:component]');
  await openSketch(d.id);
  await useStubRunner();
  await waitStage('draft', 10000);
  // 1 工具条的「参照」缺省自由风格；选 RefUi 后草稿记下它
  const ref = page.getByTestId('draft-ref');
  expect((await ref.getAttribute('data-value')) === '', `参照缺省应为自由风格：${await ref.getAttribute('data-value')}`);
  expect((await page.getByTestId('draft-origin').count()) === 0, '没有写回目标时不该写「来自」');
  await ref.click();
  await page.getByTestId('draft-ref-option').filter({ hasText: 'RefUi' }).first().click();
  await eventually(async () => expect((await draftOf(sb, d.id)).refProjectId === P.projectId, '草稿没记下参照 RefUi'), 5000);
  expect((await ref.getAttribute('data-value')) === P.projectId, '工具条的参照应显示 RefUi');
  // 2 从 RefUi 的一屏建的草稿：名字旁写「来自「RefUi · Screen 1」」
  const w = (await fork({ fromScreenId: P.screens[0].id })).body.screen;
  await openSketch(w.id);
  await waitStage('draft', 10000);
  await eventually(async () => expect((await page.getByTestId('draft-origin').innerText()).includes('RefUi · Screen 1'), '「来自」没写出写回目标'), 5000);
  // 3 收起后出新草稿：输入框里的「参照」选 RefUi，请求带 refProjectId，新草稿记下它
  await openSketch();
  await waitStage('empty', 10000);
  const sref = page.getByTestId('sketch-ref');
  expect((await sref.getAttribute('data-value')) === '', '新草稿的参照缺省应为自由风格');
  await sref.click();
  await page.getByTestId('sketch-ref-option').filter({ hasText: 'RefUi' }).first().click();
  await page.getByTestId('composer-input').fill('一张会员卡');
  const req = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/v1/projects/${sb}/messages`);
  await page.getByTestId('composer-send').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { refProjectId?: string; targetScreenIds?: string[] };
  expect(body.refProjectId === P.projectId && !body.targetScreenIds, `新草稿请求应带 refProjectId：${JSON.stringify(body)}`);
  let n = '';
  await eventually(async () => { n = urlDraft() ?? ''; expect(n && n !== w.id && n !== d.id, '新草稿没摆上看板'); }, 15000, 200);
  await eventually(async () => expect((await draftOf(sb, n)).refProjectId === P.projectId, '新草稿没记下参照'), 15000, 300);
  return '工具条设参照并记下；「来自」写出写回目标；新草稿带参照发出并记下';
});

// ---------- TC-CORE-125 看板放大：工具条在顶行，草稿在看板里居中、放到能放下的最大（v1.16，PAGE-SKETCH「看板」） ----------
await step('TC-CORE-125', async () => {
  const sb = await sketchbook();
  // 前置：草稿本里没有在跑的作业——同一时间只许一张新草稿在生成，前面的用例可能留下一张挂着的
  for (const j of (await detail(sb)).activeJobs) await apiJson(`/v1/jobs/${j.id}/cancel`, { method: 'POST' });
  await eventually(async () => expect((await detail(sb)).activeJobs.length === 0, '草稿本里还有作业在跑'), 10000, 300);
  const d = await newDraft(sb, '一个记账 App 的首页\n[stub-frame:mobile]', { frame: 'mobile' });
  await openSketch(d.id);
  await page.evaluate(() => localStorage.removeItem('quilt:composer:sketch'));
  await openSketch(d.id);
  await waitStage('draft', 15000);
  await sleep(1200);
  const geo = async () => {
    const [stage, bar, chip, frame] = await page.evaluate((sels) => sels.map((sel) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }),
      ['[data-testid="sketch-stage"]', '[data-testid="draft-toolbar"]', '[data-testid="project-switcher"]', '[data-testid="draft-iframe"]']);
    return { stage, bar, chip, frame };
  };
  const check = async (label: string) => {
    const g = await geo();
    const want = Math.min(1, g.stage.w / 390, g.stage.h / 844);
    const scale = g.frame.h / 844;
    const dx = (g.frame.x + g.frame.w / 2) - (g.stage.x + g.stage.w / 2), dy = (g.frame.y + g.frame.h / 2) - (g.stage.y + g.stage.h / 2);
    expect(Math.abs(scale - want) <= 0.01 && Math.abs(dx) <= 2 && Math.abs(dy) <= 2, `${label}：草稿应在看板里居中、缩放 ${want.toFixed(3)}，实际 ${scale.toFixed(3)}、偏 ${dx.toFixed(1)},${dy.toFixed(1)}`);
    return { g, scale };
  };
  // 1 工具条与项目切换器同一行，不占看板的高度；草稿居中、放到最大
  const a = await check('输入框停在底边');
  expect(Math.abs(a.g.bar.y - a.g.chip.y) <= 8 && a.g.stage.y >= a.g.bar.y + a.g.bar.h, `工具条应在顶部那一行、看板从它下面开始：${JSON.stringify([a.g.bar, a.g.chip, a.g.stage])}`);
  // 2 收起输入框：看板与草稿都不变（输入框浮在看板上面，不让位）
  await page.getByTestId('composer-collapse').click();
  await page.getByTestId('composer-pill').waitFor({ timeout: 3000 });
  await sleep(800);
  const b = await check('收起之后');
  expect(Math.abs(b.g.stage.h - a.g.stage.h) <= 1 && Math.abs(b.g.stage.w - a.g.stage.w) <= 1 && Math.abs(b.scale - a.scale) <= 0.005, `收起输入框不该改看板：${JSON.stringify([a.g.stage, b.g.stage])}`);
  // 3 展开并停到左边：看板不变，输入框浮在看板上
  await page.getByTestId('composer-pill').click();
  await page.getByTestId('composer-grip').click();
  await page.getByTestId('composer-dock-left').click();
  await sleep(900);
  const c = await check('停到左边之后');
  const comp = (await page.locator('form.composer').boundingBox())!;
  expect(Math.abs(c.g.stage.x - a.g.stage.x) <= 1 && Math.abs(c.g.stage.w - a.g.stage.w) <= 1 && comp.x < c.g.stage.x + c.g.stage.w && comp.x + comp.width > c.g.stage.x, `左停的输入框应浮在看板上、看板不变：${JSON.stringify([a.g.stage, c.g.stage, comp])}`);
  // 4 开合记录栏：它也浮在看板上，看板框不变（v1.17）
  const railState = () => page.getByTestId('sketch-page').getAttribute('data-rail');
  const rail0 = await railState();
  await page.getByTestId('rail-toggle').click();
  await eventually(async () => expect((await railState()) !== rail0, `点开合记录栏没生效：仍是 ${await railState()}`), 3000);
  await sleep(700);
  const e = await check('开合记录栏之后');
  expect(Math.abs(e.g.stage.x - a.g.stage.x) <= 1 && Math.abs(e.g.stage.w - a.g.stage.w) <= 1 && Math.abs(e.g.stage.h - a.g.stage.h) <= 1, `开合记录栏不该改看板：${JSON.stringify([a.g.stage, e.g.stage])}`);
  // 收尾：输入框与记录栏回到缺省（后面的用例共用这个页面上下文）
  await page.evaluate(() => { localStorage.removeItem('quilt:composer:sketch'); localStorage.removeItem('quilt:sketch-rail'); });
  return `缩放 ${a.scale.toFixed(2)}，收起输入框、左停、开合记录栏都不改看板`;
});

// ---------- TC-CORE-128 打开着的草稿出新版、换画框都原地换：不重载、不出加载中（v1.18，PAGE-SKETCH「看板」） ----------
// 父页逐帧记看板：出没出骨架与「加载中…」、iframe 是不是同一个元素、最宽到多少；草稿 window 上的标记重载过就没了。
// 写成字符串求值：tsx 给具名函数加的 __name 辅助调用序列化进页面就是未定义
const watchBoard = (pg: Page = page) => pg.evaluate(`(() => {
  const w = window; const gen = (w.__boardGen || 0) + 1; w.__boardGen = gen;
  w.__board = { skeleton: 0, loading: 0, otherFrame: 0, maxW: 0 };
  const first = document.querySelector('[data-testid="draft-iframe"]');
  const t0 = performance.now();
  const tick = () => {
    const f = document.querySelector('[data-testid="draft-iframe"]');
    if (document.querySelector('.draft-frame .draft-skeleton')) w.__board.skeleton++;
    if ([...document.querySelectorAll('.draft-frame [role="status"]')].some((e) => (e.textContent || '').includes('加载中'))) w.__board.loading++;
    if (f !== first) w.__board.otherFrame++;
    if (f) w.__board.maxW = Math.max(w.__board.maxW, f.offsetWidth);
    if (w.__boardGen === gen && performance.now() - t0 < 60000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`);
type Board = { skeleton: number; loading: number; otherFrame: number; maxW: number };
const boardSeen = (pg: Page = page) => pg.evaluate('(() => { window.__boardGen++; return window.__board; })()') as Promise<Board>;
const markOf = (f: Frame) => f.evaluate(() => (window as unknown as { __tc128?: number }).__tc128);
const h1Is = (f: Frame, text: string, label: string) => f.waitForFunction((t) => document.querySelector('h1')?.textContent === t, text, { timeout: 15000 })
  .catch((e) => { throw new Error(f.isDetached() ? `${label}：草稿的 iframe 被换掉了（重载过）` : `${label}：标题没变成「${text}」：${(e as Error).message.split('\n')[0]}`); });
await step('TC-CORE-128', async () => {
  const sb = await sketchbook();
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const rows = Array.from({ length: 24 }, (_, i) => `<li class="flex justify-between border-b border-gray-100 py-3"><span>第 ${i + 1} 笔</span><span>¥${(i + 1) * 37}</span></li>`).join('');
  const made = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '十月账单', html: `<div data-frame="mobile" class="min-h-dvh bg-white p-5"><h1 class="text-2xl font-semibold">十月账单</h1><ul class="mt-4">${rows}</ul></div>` });
  const d = (made.json as { screenId: string }).screenId;
  expect(d, `建草稿失败：${made.text.slice(0, 160)}`);
  await openSketch(d);
  await waitStage('draft', 15000);
  const f = await draftFrame();
  await h1Is(f, '十月账单', '打开');
  await f.evaluate(() => { (window as unknown as { __tc128: number }).__tc128 = 1; window.scrollTo(0, 400); });
  await sleep(300);
  const y0 = await f.evaluate(() => window.scrollY);
  expect(y0 > 300, `草稿应能往下滚：scrollY ${y0}`);
  const inPlace = (label: string, seen: Board, mark: number | undefined, want: number) => {
    expect(mark === want && seen.otherFrame === 0, `${label}：iframe 重载了（标记 ${mark}，换成别的 iframe ${seen.otherFrame} 帧）`);
    expect(seen.skeleton === 0 && seen.loading === 0, `${label}：出了骨架 / 加载中：${JSON.stringify(seen)}`);
  };
  // 1 改一轮：草稿换成新版，iframe 没重载，滚动位置留着
  await watchBoard();
  await editDraft(sb, d, '标题改一下\n[stub-patch]');
  await h1Is(f, 'Patched title', '出新版');
  const s1 = await boardSeen();
  inPlace('出新版', s1, await markOf(f), 1);
  const y1 = await f.evaluate(() => window.scrollY);
  expect(Math.abs(y1 - y0) <= 2, `出新版后滚动位置没留住：${y0} → ${y1}`);
  // 2 回到旧版：同样原地换回去
  const revs = await revisions(d);
  await watchBoard();
  const back = await post(`/v1/screens/${d}/revisions/${revs[1].id}/restore`, { expectedRevisionId: revs[0].id });
  expect(back.status === 200, `回到旧版 ${back.status}`);
  await h1Is(f, '十月账单', '回到旧版');
  inPlace('回到旧版', await boardSeen(), await markOf(f), 1);
  // 3 换画框（手机页 → 桌面页）：只改视口
  await watchBoard();
  expect((await apiJson(`/v1/screens/${d}`, { method: 'PATCH', body: JSON.stringify({ frame: 'desktop' }) })).status === 200, '换画框应 200');
  await eventually(async () => expect((await page.getByTestId('draft-iframe').evaluate((el) => (el as HTMLElement).offsetWidth)) === 1280, '视口没换成桌面页的 1280 宽'), 10000);
  inPlace('换画框', await boardSeen(), await markOf(f), 1);
  // 4 组件草稿出新版：不退回 1280×800 的占位框
  const c = await newDraft(sb, '一张播放卡片\n[stub-frame:component]');
  await openSketch(c.id);
  await waitStage('draft', 15000);
  await settledComponent();
  const fc = await draftFrame();
  await fc.evaluate(() => { (window as unknown as { __tc128: number }).__tc128 = 2; });
  await watchBoard();
  await editDraft(sb, c.id, '标题改一下\n[stub-patch]');
  await h1Is(fc, 'Patched title', '组件出新版');
  await sleep(500);
  const s4 = await boardSeen();
  inPlace('组件出新版', s4, await markOf(fc), 2);
  expect(s4.maxW < 1000, `组件出新版时退回了占位框：最宽 ${s4.maxW}`);
  return `改一轮、回到旧版、换画框、组件出新版都在同一个 iframe 里换，没出骨架；滚动 ${y0} → ${y1}`;
});

// ---------- TC-CORE-129 缩小显示的屏不走缩放变换：草稿看板与画布聚焦屏的 iframe 上总变换 1:1（源自缺陷 2026-10-20） ----------
// 缺陷只在可见窗口的 GPU 合成里出现（带缩放变换的跨域 iframe 里，同时有 backdrop-filter 与 box-shadow 的元素旁出一片灰色渐变、盖掉邻近内容），
// 那一步（第 3 步）人工或征得同意后开可见窗口看；无头这里验规避手段本身：iframe 到根的累计 transform 缩放是 1，显示出来的倍率仍对
const GLASS_LEDGER = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/glass-ledger.html'), 'utf8');
// iframe 自己与每一层祖先的 transform 缩放连乘（matrix 的 a），以及显示宽 / 布局宽
const frameScales = (pg: Page, sel: string) => pg.evaluate((q) => {
  const el = document.querySelector(q) as HTMLElement;
  let t = 1;
  for (let n: Element | null = el; n; n = n.parentElement) { const m = getComputedStyle(n).transform; if (m && m !== 'none') t *= new DOMMatrix(m).a; }
  return { transform: t, shown: el.getBoundingClientRect().width / el.offsetWidth };
}, sel);
await step('TC-CORE-129', async () => {
  const sb = await sketchbook();
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  // 1 草稿看板（1440×900 下手机页按看板高缩小）
  const made = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '记账App', html: GLASS_LEDGER });
  const d = (made.json as { screenId: string }).screenId;
  expect(d, `建草稿失败：${made.text.slice(0, 160)}`);
  await openSketch(d);
  await waitStage('draft', 15000);
  const fd = await draftFrame();
  await fd.waitForSelector('.aspect-square');
  const k1 = await frameScales(page, '[data-testid="draft-iframe"]');
  const vw1 = await fd.evaluate(() => document.documentElement.getBoundingClientRect().width);
  expect(k1.shown < 0.99 && Math.abs(k1.transform - 1) <= 0.01 && vw1 >= 390 && vw1 < 390 + 1 / k1.shown, `看板上的草稿应缩小显示、但 iframe 上没有缩放变换、里面按不窄于 390 排版：${JSON.stringify({ ...k1, vw1 })}`);
  // 2 画布聚焦（选择元素态，镜头推到这一屏）
  const app = seedJson<{ projectId: string }>('seed:project', '--name', 'Glass', '--device', 'mobile', '--screens', '1', '--no-shot');
  await callTool(mcp, 'quilt.create_screen', { projectId: app.projectId, name: '记账首页', route: '/ledger', html: GLASS_LEDGER });
  await page.goto(`${WEB}/p/${app.projectId}`);
  const card = page.locator('[data-testid="screen-card"][data-route="/ledger"]');
  await card.waitFor({ timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+e');
  await card.locator('.gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  await sleep(1200);
  const zoom = await page.locator('.world').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  const k2 = await frameScales(page, '.card.focused iframe');
  const vw2 = await page.frameLocator('.card.focused iframe').locator('body').evaluate(() => document.documentElement.getBoundingClientRect().width);
  expect(Math.abs(k2.transform - 1) <= 0.01 && Math.abs(k2.shown - zoom) <= 0.01 && vw2 >= 390 && vw2 < 390 + 1 / zoom, `聚焦屏的 iframe 应按镜头倍率显示、总变换 1:1、里面按不窄于 390 排版：${JSON.stringify({ ...k2, zoom, vw2 })}`);
  await page.keyboard.press('Escape');
  return `看板倍率 ${k1.shown.toFixed(3)}、镜头倍率 ${zoom.toFixed(3)}，iframe 上的总变换都是 1:1；第 3 步（可见窗口里无灰条）不在无头脚本里`;
});

// ---------- TC-CORE-138 草稿里只改一块时带参考图（浏览器 + 接口 + MCP，REQ-CORE-045 / API-CORE-006） ----------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function uploadPng(pid: string): Promise<string> {
  const { body } = await apiJson<{ attachmentId: string; putUrl: string }>(`/v1/projects/${pid}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: PNG.length }) });
  const put = await fetch(API + body.putUrl, { method: 'PUT', body: PNG, headers: { 'content-type': 'image/png' } });
  expect(put.status === 204, `参考图上传 ${put.status}`);
  return body.attachmentId;
}
await step('TC-CORE-138', async () => {
  const sb = await sketchbook();
  const d = await newDraft(sb, '一张播放卡片\n[stub-frame:component]');
  const pQid = qidOf(await currentHtml(d.id), /<p[^>]*data-qid="(q\d+)"/);
  const ref = path.join(EVIDENCE, `run-${RUN}-ref.png`);
  await writeFile(ref, PNG);
  await openSketch(d.id);
  await useStubRunner();
  await waitStage('draft', 10000);
  // 1 点选一块，再贴一张参考图等它传完
  await page.getByTestId('draft-pick').click();
  await settledComponent();
  await clickInScaled('[data-testid="draft-iframe"]', page.frameLocator('[data-testid="draft-iframe"]').locator(`[data-qid="${pQid}"]`));
  const chip = page.getByTestId('draft-pick-chip');
  await chip.waitFor({ timeout: 5000 });
  expect((await page.getByTestId('verb-line').innerText()).includes('改这一块'), '动词行应写「改这一块」');
  const thumbs = page.locator('ul[aria-label="本次参考图"] li');
  await page.setInputFiles('input[type=file]', ref);
  await page.locator('ul[aria-label="本次参考图"] img').first().waitFor({ timeout: 10000 });
  await page.waitForFunction(`!document.querySelector('ul[aria-label="本次参考图"] span')`, null, { timeout: 15000 });
  expect((await thumbs.count()) === 1, `应有 1 张缩略图，实际 ${await thumbs.count()}`);
  // 2 发送：建 regenerate_subtree，请求带 attachmentIds，作业输入带 imageKeys，用户消息挂着这张图；不出错误提示条
  const h0 = draftStub.hits.length;
  await page.getByTestId('composer-input').fill('照这张图的感觉改');
  const req = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/v1/projects/${sb}/jobs`);
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/v1/projects/${sb}/jobs`);
  await page.getByTestId('composer-send').click();
  const body = JSON.parse((await req).postData() ?? '{}') as { kind?: string; input?: { qid?: string }; attachmentIds?: string[] };
  expect(body.kind === 'regenerate_subtree' && body.input?.qid === pQid && body.attachmentIds?.length === 1, `请求体不对：${JSON.stringify(body)}`);
  const r = await res;
  expect(r.status() === 202, `建作业应 202，实际 ${r.status()}：${(await r.text()).slice(0, 200)}`);
  const job = ((await r.json()) as { job: JobView }).job;
  expect((job.input.imageKeys ?? []).length === 1, `作业输入应带 1 个 imageKeys：${JSON.stringify(job.input)}`);
  expect((await page.locator('[data-testid=toast][data-kind=error]').count()) === 0, `不该出错误提示条：${await page.locator('[data-testid=toast]').allInnerTexts()}`);
  const msgs = (await apiJson<{ items: { role: string; jobId: string | null; attachments: unknown[] }[] }>(`/v1/projects/${sb}/messages?limit=100`)).body.items;
  expect(msgs.find((m) => m.role === 'user' && m.jobId === job.id)?.attachments.length === 1, '这一轮的用户消息应挂 1 张附件');
  // 3 作业成功、落 subtree 一版；桩收到的那次调用带图、用草稿本的参考图说明；缩略图与胶囊清掉
  expect((await waitJob(job.id, 60)).status === 'succeeded', '带图只改一块的作业没成功');
  expect((await revisions(d.id))[0].sourceKind === 'subtree', '草稿应多出改一块的那一版');
  const hit = draftStub.hits.slice(h0).find((h) => h.system.startsWith(SKETCH_GENERATOR_MARK));
  expect(hit?.hasImage && hit.user.startsWith(SKETCH_REFERENCE_IMAGE_NOTE), `这次调用应带图、以草稿本的参考图说明开头：${JSON.stringify({ hasImage: hit?.hasImage, user: hit?.user.slice(0, 120) })}`);
  await eventually(async () => expect((await thumbs.count()) === 0 && (await chip.count()) === 0, '发出去之后缩略图与胶囊应清掉'), 10000);
  // 4 接口：不收图的作业种类带图 400；取不到的附件 400；都不建作业
  const before = (await jobsOf(sb)).length;
  const att = await uploadPng(sb);
  const exp = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'export_prototype', input: {}, attachmentIds: [att] });
  const cur = (await revisions(d.id))[0].id;
  const ghost = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid: pQid, prompt: 'x', expectedRevisionId: cur, runner: STUB }, attachmentIds: [FAKE] });
  for (const [what, x] of [['导出带图', exp], ['不存在的附件', ghost]] as const) expect(x.status === 400 && x.body.type === '/errors/validation' && paths(x.body).includes('attachmentIds'), `${what}应 400 attachmentIds：${x.status} ${JSON.stringify(x.body).slice(0, 200)}`);
  expect((await jobsOf(sb)).length === before, '被拒的请求不该建出作业');
  // 5 MCP：quilt.regenerate_subtree 收 attachmentIds
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const viaMcp = await callTool(mcp, 'quilt.regenerate_subtree', { screenId: d.id, qid: pQid, prompt: '再照图收紧一点', expectedRevisionId: cur, runner: STUB, attachmentIds: [att] });
  expect(!viaMcp.isError, `MCP 带图只改一块：${viaMcp.text.slice(0, 200)}`);
  const mj = await waitJob((viaMcp.json as { id: string }).id, 60);
  expect(mj.status === 'succeeded' && (mj.input.imageKeys ?? []).length === 1, `MCP 作业：${mj.status} ${JSON.stringify(mj.input)}`);
  return '点选一块带 1 张图发出：regenerate_subtree 带 attachmentIds → imageKeys、用户消息挂附件、桩收到带图的调用（草稿本参考图说明）；不收图的种类与取不到的附件 400；MCP 同';
});

// ---------- TC-CORE-111 FLOW-SKETCH 走查（截图） ----------
// 截图与热点落在证据目录 run-<RUN>-flow-sketch/（gitignore），发布到 docs/tour 由执行者按 test-doc flow-walkthrough 做
await step('TC-CORE-111', async () => {
  seed('seed'); // 复位
  channelId = '';
  await ensureChannel();
  const wctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await wctx.addInitScript(() => localStorage.setItem('quilt:theme', 'light'));
  cleanups.push(() => wctx.close());
  const wp = await wctx.newPage();
  const out = path.join(EVIDENCE, `run-${RUN}-flow-sketch`);
  await mkdir(out, { recursive: true });
  const hotspots: Record<string, { kind: 'tap' | 'look'; target: string; x: number; y: number; w: number; h: number }> = {};
  const settle = async () => {
    await wp.waitForFunction(() => [...document.querySelectorAll('img')].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
    await wp.waitForTimeout(600);
  };
  const snap = async (key: string, kind: 'tap' | 'look', target: string) => {
    await settle();
    const b = await wp.locator(target).first().boundingBox();
    expect(b, `${key} 的热点 ${target} 不在视口里`);
    hotspots[key] = { kind, target, x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
    await wp.screenshot({ path: path.join(out, `${key.replace('FLOW-SKETCH/', '')}.png`) });
  };
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
  // S1 项目切换器菜单里点「草稿本」
  await wp.goto(`${WEB}/p/${demo.id}`);
  await wp.getByTestId('project-switcher').click();
  await wp.getByTestId('sketchbook-entry').waitFor({ timeout: 5000 });
  await snap('FLOW-SKETCH/S1', 'tap', '[data-testid="sketchbook-entry"]');
  await wp.getByTestId('sketchbook-entry').click();
  // S2 空草稿本
  await wp.waitForURL(/\/sketch(\?|$)/, { timeout: 10000 });
  await waitStage('empty', 15000, wp);
  expect(await wp.getByTestId('sketch-empty').isVisible() && (await wp.getByTestId('rail-item').count()) === 0, 'S2 应是空看板提示、记录栏为空');
  await useStubRunner(wp);
  await snap('FLOW-SKETCH/S2', 'look', '[data-testid="sketch-empty"]');
  // S3 写一句话、画框自动，发送
  await wp.getByTestId('composer-input').fill('一个音乐播放器的迷你控制条，深色毛玻璃');
  expect((await wp.getByTestId('verb-line').innerText()).includes('新草稿') && (await chosen('frame-choice', wp)) === 'auto', 'S3 动词行应写「新草稿」、画框是自动');
  await snap('FLOW-SKETCH/S3', 'tap', '[data-testid="composer-send"]');
  const j1 = await sendFromComposer('一个音乐播放器的迷你控制条，深色毛玻璃', wp);
  await waitStage('generating', 5000, wp);
  // S5 草稿按画框摆在看板正中
  expect((await waitJob(j1, 60)).status === 'succeeded', '出稿作业没成功');
  await waitStage('draft', 15000, wp);
  const id = (await openDraftId(wp))!;
  await (await draftFrame(wp)).waitForFunction(() => document.fonts.status === 'loaded' && !!document.body.textContent?.includes('夜航星'));
  expect((await wp.getByTestId('draft-view').getAttribute('data-frame')) === 'component', 'S5 画框应为 component');
  await snap('FLOW-SKETCH/S5', 'look', '[data-testid="draft-view"]');
  // S6 再发一句改这张
  await wp.getByTestId('composer-input').fill('按钮换成圆形，加一个音量滑块');
  expect((await wp.getByTestId('verb-line').innerText()).includes('改「'), 'S6 动词行应写「改「…」」');
  await snap('FLOW-SKETCH/S6', 'tap', '[data-testid="composer-send"]');
  const j2 = await sendFromComposer('按钮换成圆形，加一个音量滑块', wp);
  expect((await waitJob(j2, 60)).status === 'succeeded', '改稿作业没成功');
  await eventually(async () => expect(await (await draftFrame(wp)).locator('input[aria-label="音量"]').count() === 1, '看板没换成新版'), 15000, 300);
  // S8 收起：动作所在画面与收起后的空看板
  await snap('FLOW-SKETCH/S8-a', 'tap', '[data-testid="draft-collapse"]');
  await wp.getByTestId('draft-collapse').click();
  await waitStage('empty', 5000, wp);
  expect((await railIds(wp)).includes(id), 'S8 收起后这张草稿应留在记录栏');
  await snap('FLOW-SKETCH/S8-b', 'tap', `[data-testid="rail-item"][data-draft-id="${id}"]`);
  // S9 点记录栏里的缩略图，草稿回到看板
  await railItem(id, wp).click();
  await waitStage('draft', 10000, wp);
  await (await draftFrame(wp)).waitForFunction(() => document.fonts.status === 'loaded' && !!document.querySelector('input[aria-label="音量"]'));
  await snap('FLOW-SKETCH/S9', 'look', '[data-testid="draft-view"]');
  await writeFile(path.join(out, 'hotspots.json'), JSON.stringify(hotspots, null, 2));
  seed('seed'); // 复位
  return `7 张截图与热点在 ${path.relative(path.resolve(EVIDENCE, '../..'), out)}/`;
});

// ---------- TC-CORE-150 草稿本按 ⌘Z 回到上一版（v1.25） ----------
await step('TC-CORE-150', async () => {
  const sb = await sketchbook();
  const a = await newDraft(sb, '一个音乐播放器的迷你控制条');
  await editDraft(sb, a.id, '按钮换成圆形，加一个音量滑块');
  await editDraft(sb, a.id, '标题改成夜航星 · 现场版');
  const r3 = await revisions(a.id);
  expect(r3.length === 3, `前置应有 3 版：${r3.length}`);
  const bySeq = (rs: Rev[], seq: number) => rs.find((r) => r.seq === seq)!;
  const toastHas = (text: string) => eventually(async () => expect((await page.getByText(text).count()) >= 1, `应提示「${text}」`), 5000, 100);
  await openSketch(a.id);
  await waitStage('draft');
  await settledComponent();
  // 1 焦点不在文本框里：⌘Z 回到第 2 版
  const stage = await box('sketch-stage');
  await page.mouse.click(stage.x + 8, stage.y + stage.height - 8);
  await page.keyboard.press('ControlOrMeta+z');
  await toastHas('已回到第 2 版');
  const currentIs = (seq: number, what: string) => eventually(async () => expect((await detail(sb)).screens.find((s) => s.id === a.id)?.currentRevisionId === bySeq(r3, seq).id, what), 10000, 200);
  await currentIs(2, '① ⌘Z 后当前版应是第 2 版');
  expect((await revisions(a.id)).length === 3, '① ⌘Z 不该多出版本');
  // 2 焦点在草稿 iframe 里：运行时转发 ⌘Z
  await page.waitForTimeout(800);
  const f = await draftFrame();
  await f.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('ControlOrMeta+z');
  await currentIs(1, '② iframe 里按 ⌘Z 后当前版应是第 1 版');
  expect((await revisions(a.id)).length === 3, '② ⌘Z 不该多出版本');
  // 3 已是第一版
  await page.waitForTimeout(800);
  await page.mouse.click(stage.x + 8, stage.y + stage.height - 8);
  await page.keyboard.press('ControlOrMeta+z');
  await toastHas('已经是第一版');
  await page.waitForTimeout(800);
  expect((await revisions(a.id)).length === 3, '③ 第一版上按 ⌘Z 不该建版本');
  // 4 输入框里的 ⌘Z 留给输入框
  const input = page.getByTestId('composer-input');
  await input.click(); await input.fill(''); await page.keyboard.type('abc');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(600);
  expect((await input.inputValue()) !== 'abc', `④ 输入框里的字应被撤销：${await input.inputValue()}`);
  expect((await revisions(a.id)).length === 3, '④ 输入框里按 ⌘Z 不该建版本');
  await input.fill('');
  // 5 生成中按 ⌘Z：提示正在改，不建版本
  const held = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '标题改大\n[stub-hold:5000]', targetScreenIds: [a.id], runner: STUB });
  expect(held.status === 202, `⑤ 拖住的改稿 ${held.status}`);
  await eventually(async () => expect((await page.getByText('这张草稿正在改').count()) >= 1 || (await page.getByTestId('job-chip').count()) >= 1, '⑤ 界面还没看到这一轮在跑'), 5000, 100).catch(() => {});
  await page.mouse.click(stage.x + 8, stage.y + stage.height - 8);
  await page.keyboard.press('ControlOrMeta+z');
  await toastHas('这张草稿正在改');
  await waitJob(held.body.job.id, 60);
  await page.waitForTimeout(500);
  expect((await revisions(a.id)).length === 4, `⑤ 只应多出这一轮的 1 版：${(await revisions(a.id)).length}`);
  return '⌘Z 当前版指回第 2 版、不多出版本；iframe 里转发同样生效；第一版上提示；输入框里留给输入框；生成中提示正在改';
});

// ---------- TC-EDIT-041 草稿本里按住 Shift 选几块、一次改完（v1.26） ----------
await step('TC-EDIT-041', async () => {
  const sb = await sketchbook();
  const S = softly();
  // 同一套里更早的用例（§3 种子）会删掉桩通道：用之前确认它在
  await ensureChannel();
  // 前置：草稿桩的播放器控制条（一行里：封面、标题与副标题那一块、三个按钮）
  const d = await newDraft(sb, '一个音乐播放器的迷你控制条', { runner: CHANNEL() });
  const html0 = await currentHtml(d.id);
  // 存下的 HTML 里某一块的整段（p、button 里没有同名元素嵌套）与它的开标签
  const outerOf = (html: string, tag: string, qid: string) => { const m = new RegExp(`<${tag}\\b[^>]*data-qid="${qid}"[^>]*>[\\s\\S]*?</${tag}>`).exec(html); expect(m, `找不到 ${tag} · ${qid}`); return m![0]; };
  const tagOf = (html: string, qid: string) => new RegExp(`<[a-z][a-z0-9]*\\b[^>]*data-qid="${qid}"[^>]*>`).exec(html)?.[0] ?? '';
  const set = (...xs: string[]) => [...xs].sort().join(',');
  const chips = page.getByTestId('draft-pick-chip');
  const chipQids = async () => set(...(await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-qid') ?? ''))));
  const verb = async () => (await page.getByTestId('verb-line').innerText()).trim();
  const boxes = async () => set(...(await (await draftFrame()).evaluate(() => Array.from(document.querySelectorAll('[data-quilt-selection]')).map((b) => (b as HTMLElement).innerText.trim()))));
  // 看板上的草稿可能缩小显示：按 iframe 的实际缩放换算指针位置；按钮正中是 lucide 的 svg（它自己带 qid），点按钮的左缘
  const pick = async (sel: string, i: number, o: { shift?: boolean; edge?: boolean } = {}) => {
    const shown = (await page.getByTestId('draft-iframe').boundingBox())!;
    const p = await (await draftFrame()).evaluate(({ s, k, edge }) => { const r = document.querySelectorAll(s)[k].getBoundingClientRect(); return { x: edge ? r.x + 3 : r.x + r.width / 2, y: r.y + r.height / 2, vw: innerWidth }; }, { s: sel, k: i, edge: !!o.edge });
    const z = shown.width / p.vw;
    if (o.shift) await page.keyboard.down('Shift');
    await page.mouse.click(shown.x + p.x * z, shown.y + p.y * z);
    if (o.shift) await page.keyboard.up('Shift');
  };
  /** 输入框发一句：返回界面发出的建作业请求体与建出的作业 */
  const send = async (text: string) => {
    await page.getByTestId('composer-input').fill(text);
    const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/v1/projects/${sb}/jobs`, { timeout: 10000 });
    await page.getByTestId('composer-send').click();
    const r = await res;
    expect(r.status() === 202, `建作业应 202，实际 ${r.status()}：${(await r.text()).slice(0, 200)}`);
    const body = JSON.parse(r.request().postData() ?? '{}') as { kind?: string; input?: { screenId?: string; qid?: string; qids?: string[] } };
    return { body, job: ((await r.json()) as { job: JobView }).job };
  };
  try {
    await openSketch(d.id);
    await useStubRunner();
    await waitStage('draft', 10000);
    await page.getByTestId('draft-pick').click();
    await settledComponent();
    // 页面里跑的函数不能再声明具名函数（tsx 会给它包一层 __name，页面里没有）
    const q = await (await draftFrame()).evaluate(() => {
      const ps = document.querySelectorAll('p'); const bs = document.querySelectorAll('button');
      const [title, sub, block, row, pause, next] = [ps[0], ps[1], ps[0]?.parentElement, bs[0]?.parentElement, bs[1], bs[2]].map((e) => e?.getAttribute('data-qid') ?? '');
      return { title, sub, block, row, pause, next };
    });
    expect(Object.values(q).every(Boolean) && outerOf(html0, 'button', q.pause).includes('data-lucide="pause"') && q.block !== q.row, `草稿结构不是播放器控制条：${JSON.stringify(q)}`);
    // 1 点标题文字：一枚胶囊，动词行「改这一块」
    await pick('p', 0);
    await S.check(() => eventually(async () => expect((await chipQids()) === q.title && (await verb()).includes('改这一块'), `① 应一枚标题的胶囊、动词行「改这一块」：胶囊 ${await chipQids()}，动词行「${await verb()}」`), 5000));
    // 2 按住 Shift 点暂停按钮：两枚胶囊、「改这 2 块」，草稿里两处选中框
    await pick('button', 1, { shift: true, edge: true });
    await S.check(() => eventually(async () => expect((await chips.count()) === 2 && (await verb()).includes('改这 2 块'), `② 应两枚胶囊、动词行「改这 2 块」：${await chips.count()} 枚，「${await verb()}」`), 5000));
    await S.check(() => eventually(async () => expect((await boxes()) === set(`p · ${q.title}`, `button · ${q.pause}`), `② 草稿里应框住标题与暂停按钮：${await boxes()}`), 3000));
    // 3 按住 Shift 再点标题：标题那枚去掉，剩暂停按钮一枚
    await pick('p', 0, { shift: true });
    await S.check(() => eventually(async () => expect((await chipQids()) === q.pause && (await boxes()) === `button · ${q.pause}`, `③ 应只剩暂停按钮：胶囊 ${await chipQids()}，框 ${await boxes()}`), 5000));
    // 4 按住 Shift 点副标题，再按两次 Shift+↑：副标题 → 标题与副标题那一块 → 连按钮在内的整行（合并到外层）
    await pick('p', 1, { shift: true });
    await S.check(() => eventually(async () => expect((await chipQids()) === set(q.pause, q.sub), `④ 应是暂停按钮与副标题两枚：${await chipQids()}`), 5000));
    // 按键前焦点在哪、按完输入框里多了什么：不换层时据此分辨按键落到了哪里
    const where = async () => `焦点 ${await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)}，输入框 ${JSON.stringify(await page.getByTestId('composer-input').inputValue())}`;
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => eventually(async () => expect((await chipQids()) === set(q.pause, q.block), `④ 第一次 Shift+↑ 后应是按钮与标题副标题那一块：${await chipQids()}（${await where()}）`), 5000));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => eventually(async () => expect((await page.getByText('已合并到外层').count()) >= 1, '④ 整行包住按钮时应提示「已合并到外层」'), 5000));
    await S.check(() => eventually(async () => expect((await chipQids()) === q.row && (await boxes()) === `div · ${q.row}`, `④ 应只剩整行一枚：胶囊 ${await chipQids()}，框 ${await boxes()}（${await where()}）`), 5000));
    // 5 Esc 清空；点标题、按住 Shift 点暂停按钮，写「都改成红色」发送
    await page.keyboard.press('Escape');
    await S.check(() => eventually(async () => expect((await chips.count()) === 0 && (await boxes()) === '', `⑤ Esc 应清掉全部胶囊与框：胶囊 ${await chipQids()}，框 ${await boxes()}`), 3000));
    await pick('p', 0);
    await pick('button', 1, { shift: true, edge: true });
    await eventually(async () => expect((await chipQids()) === set(q.title, q.pause), `⑤ 发送前应选中标题与暂停按钮：${await chipQids()}`), 5000);
    const revs5 = (await revisions(d.id)).length;
    const h5 = draftStub.hits.length;
    const s5 = await send('都改成红色');
    await S.check(() => expect(s5.body.kind === 'regenerate_subtree' && s5.body.input?.screenId === d.id && set(...(s5.body.input?.qids ?? [])) === set(q.title, q.pause) && s5.body.input.qids!.includes(s5.body.input.qid ?? ''), `⑤ 请求体不对：${JSON.stringify(s5.body)}`));
    const j5 = await waitJob(s5.job.id, 60);
    await S.check(() => expect(j5.status === 'succeeded' && set(...((j5.input.qids as string[] | undefined) ?? [])) === set(q.title, q.pause), `⑤ 作业应成功、input.qids 是这两块：${j5.status} ${JSON.stringify(j5.input.qids)}`));
    const calls5 = draftStub.hits.slice(h5);
    await S.check(() => expect(calls5.length === 1, `⑤ 桩应只收到一次调用：${calls5.length}`));
    const sent = quiltBlocks(calls5[0]?.user.split(`\n${SUBTREE_BLOCKS_HEADER}\n`)[1] ?? '');
    const sentOf = (qid: string) => strip(sent.find((b) => b.qid === qid)?.html ?? '');
    await S.check(() => expect(sent.length === 2 && sentOf(q.title) === strip(outerOf(html0, 'p', q.title)) && sentOf(q.pause) === strip(outerOf(html0, 'button', q.pause)), `⑤ 提示词里应是这两块的原 HTML：${JSON.stringify(sent).slice(0, 300)}`));
    const list5 = await revisions(d.id);
    const html5 = await revHtml(list5[0]);
    await S.check(() => expect(list5.length === revs5 + 1 && list5[0].sourceKind === 'subtree', `⑤ 草稿应多一版 subtree：${revs5} → ${list5.length}，${list5[0].sourceKind}`));
    await S.check(() => expect(tagOf(html5, q.title).includes('data-stub="multi"') && tagOf(html5, q.pause).includes('data-stub="multi"') && (html5.match(/data-stub="multi"/g) ?? []).length === 2 && outerOf(html5, 'p', q.title).includes('已改 · 夜航星'), `⑤ 这两块应换成桩回的内容：${tagOf(html5, q.title)} ｜ ${tagOf(html5, q.pause)}`));
    await S.check(() => expect(strip(outerOf(html5, 'p', q.sub)) === strip(outerOf(html0, 'p', q.sub)), `⑤ 副标题应原样：${outerOf(html5, 'p', q.sub)}`));
    await S.check(() => eventually(async () => expect((await chips.count()) === 0, `⑤ 新版落库后胶囊应清空：${await chipQids()}`), 10000));
    // 6 再选两块（副标题、下一首按钮），带 [stub-blocks-miss] 发送：桩每次少回一块，补问一轮后作业失败，版本数不变
    await settledComponent();
    await pick('p', 1);
    await pick('button', 2, { shift: true, edge: true });
    await eventually(async () => expect((await chipQids()) === set(q.sub, q.next), `⑥ 发送前应选中副标题与下一首按钮：${await chipQids()}`), 5000);
    const revs6 = (await revisions(d.id)).length;
    const h6 = draftStub.hits.length;
    const s6 = await send('都改成蓝色 [stub-blocks-miss]');
    await S.check(() => expect(set(...(s6.body.input?.qids ?? [])) === set(q.sub, q.next), `⑥ 请求体的 qids 不对：${JSON.stringify(s6.body.input)}`));
    const j6 = await waitJob(s6.job.id, 60);
    const calls6 = draftStub.hits.slice(h6);
    await S.check(() => expect(calls6.length === 2 && calls6.every((h) => h.user.includes(`\n${SUBTREE_BLOCKS_HEADER}\n`)), `⑥ 桩应收到两次多块调用（补问一轮）：${calls6.length}`));
    await S.check(() => expect(j6.status === 'failed', `⑥ 作业应失败：${j6.status}`));
    await S.check(async () => expect((await revisions(d.id)).length === revs6, `⑥ 草稿的版本数应不变：${revs6} → ${(await revisions(d.id)).length}`));
    // 7 接口：qids 9 个；一块包住另一块；qids 不含 qid——都 400 /errors/validation，不建作业
    const cur7 = (await revisions(d.id))[0];
    const all = [...new Set([...((await revHtml(cur7)).split('<body')[1] ?? '').matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]))];
    expect(all.length >= 9, `⑦ 草稿里的块不到 9 个：${all.length}`);
    const jobs7 = (await jobsOf(sb)).length;
    for (const [what, qid, qids] of [['qids 9 个', all[0], all.slice(0, 9)], ['一块包住另一块', q.row, [q.row, q.pause]], ['qids 不含 qid', q.pause, [q.title, q.sub]]] as const) {
      const r = await post<Problem>(`/v1/projects/${sb}/jobs`, { kind: 'regenerate_subtree', input: { screenId: d.id, qid, qids, prompt: '都改成红色', expectedRevisionId: cur7.id, runner: STUB } });
      await S.check(() => expect(r.status === 400 && r.body.type === '/errors/validation' && paths(r.body).includes('qids'), `⑦ ${what}应 400 /errors/validation（qids）：${r.status} ${r.body.type} ${paths(r.body).slice(0, 160)}`));
    }
    await S.check(async () => expect((await jobsOf(sb)).length === jobs7, '⑦ 被拒的请求不该建出作业'));
  } catch (e) { S.fail(e); }
  S.done();
  return 'Shift 加选减选、每块一枚胶囊、Shift+↑ 走到整行时合并到外层；两块一次发出（一次调用、原 HTML、一版、副标题原样）；少回一块补问后失败不落版；qids 超 8、互相包含、不含 qid 都 400';
});

// ---------- TC-CORE-158 选元素时跳过全透明的遮罩（源自缺陷 2026-10-22） ----------
await step('TC-CORE-158', async () => {
  await ensureChannel();
  const sb = await sketchbook();
  const d = await newDraft(sb, '一个带抽屉的账单页', { runner: CHANNEL() });
  const html = await currentHtml(d.id);
  const h1 = qidOf(html, /<h1[^>]*data-qid="(q\d+)"/);
  const btn = qidOf(html, /<button[^>]*data-qid="(q\d+)"/);
  await openSketch(d.id);
  await waitStage('draft', 10000);
  const fl = page.frameLocator('[data-testid="draft-iframe"]');
  await fl.locator(`[data-qid="${btn}"]`).waitFor({ timeout: 10000 });
  await sleep(800);
  // 选中框左上角的标签写「tag · qid」
  const selected = () => fl.locator('[data-quilt-ui]').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()).filter((t) => /^[a-z0-9]+ · q\d+$/.test(t)));
  await page.getByTestId('draft-pick').click();
  // 1 点标题：选中的是 h1，不是盖在最上面的遮罩
  await clickInScaled('[data-testid="draft-iframe"]', fl.locator(`[data-qid="${h1}"]`));
  await eventually(async () => expect((await selected()).includes(`h1 · ${h1}`), `① 应选中标题 h1 · ${h1}：${JSON.stringify(await selected())}`), 3000);
  // 2 点「筛选」按钮：选中按钮
  await clickInScaled('[data-testid="draft-iframe"]', fl.locator(`[data-qid="${btn}"]`));
  await eventually(async () => expect((await selected()).includes(`button · ${btn}`), `② 应选中按钮 button · ${btn}：${JSON.stringify(await selected())}`), 3000);
  // 3 关掉选元素：遮罩照旧放行点击（交互态按设计自己的命中规则），点按钮不选任何东西
  await page.getByTestId('draft-pick').click();
  await eventually(async () => expect((await selected()).length === 0, `③ 关掉选元素后不该留选中框：${JSON.stringify(await selected())}`), 3000);
  const hit = await fl.locator('body').evaluate((_b, q) => { const el = document.querySelector(`[data-qid="${q}"]`)!.getBoundingClientRect(); return document.elementFromPoint(el.x + el.width / 2, el.y + el.height / 2)?.closest('[data-qid]')?.getAttribute('data-qid'); }, btn);
  expect(hit === btn, `③ 交互态下按钮上方的命中应是按钮本身：${hit}`);
  return `标题与按钮都选得中（${h1}、${btn}），全透明的抽屉遮罩不挡；关掉选元素后命中照旧`;
});

// ---------- TC-CORE-160 选元素时悬停框跟着滚动（源自缺陷 2026-10-22） ----------
await step('TC-CORE-160', async () => {
  await ensureChannel();
  const sb = await sketchbook();
  const d = await newDraft(sb, '一个长列表的账单页', { runner: CHANNEL() });
  await openSketch(d.id);
  await waitStage('draft', 10000);
  const fl = page.frameLocator('[data-testid="draft-iframe"]');
  const row = fl.locator('p', { hasText: '第 3 笔' });
  await row.waitFor({ timeout: 10000 });
  await sleep(800);
  await page.getByTestId('draft-pick').click();
  // 指针停在第 3 行中间（画框缩放过，按显示框换算）
  const frame = page.getByTestId('draft-iframe');
  const shown = (await frame.boundingBox())!;
  const laid = await frame.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
  const c = await row.evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(shown.x + c.x * (shown.width / laid.w), shown.y + c.y * (shown.height / laid.h), { steps: 4 });
  // 悬停框（1px 虚线的固定层）与指针下那个元素的框：草稿坐标
  const boxes = () => fl.locator('body').evaluate((_b, at) => {
    const hover = [...document.querySelectorAll('[data-quilt-ui]')].find((e) => getComputedStyle(e).borderTopStyle === 'dashed' && (e as HTMLElement).style.display !== 'none') as HTMLElement | undefined;
    const under = document.elementFromPoint(at.x, at.y)?.closest('[data-qid]');
    const h = hover?.getBoundingClientRect(); const u = under?.getBoundingClientRect();
    return { hover: h ? Math.round(h.top) : null, under: u ? Math.round(u.top) : null, text: (under?.textContent ?? '').trim().slice(0, 12) };
  }, c);
  await eventually(async () => { const b = await boxes(); expect(b.hover !== null && b.under !== null && Math.abs(b.hover - (b.under - 2)) <= 1, `① 悬停框应框住第 3 行：${JSON.stringify(b)}`); }, 3000);
  // 草稿往下滚 160 px（约 3.5 行，不是行高的整数倍），指针不动：悬停框应落在此刻指针下的那一行上
  await fl.locator('html').evaluate(() => window.scrollBy(0, 160));
  await eventually(async () => { const b = await boxes(); expect(b.hover !== null && b.under !== null && Math.abs(b.hover - (b.under - 2)) <= 1 && b.text !== '第 3 笔', `② 滚动后悬停框应跟到指针下那一行：${JSON.stringify(b)}`); }, 3000);
  const after = await boxes();
  await page.getByTestId('draft-pick').click();
  return `滚动 160 px 后悬停框跟到「${after.text}」`;
});

await browser.close();
draftStub.server.closeAllConnections();
await draftStub.close();
summary();
