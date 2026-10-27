import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Frame, Page } from 'playwright';
import { launch, seed, apiJson, assertTestApi, pickOption, eventually, EVIDENCE, WEB, API } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { suite, expect, softly, sleep, waitJob, type JobView } from './harness.ts';

// docs/TEST.md「CORE · 端、全屏视图与状态」TC-CORE-168～186（REQ-CORE-049～052，v1.52～v1.53）AI 执行脚本。
// 全程 stub 驱动（runner 显式写 STUB）：出屏规划固定回 Home / List / Detail / Settings / Profile，「补上 N 屏」按系统提示里那个维度逐个写 data-when，
// 「让模型建议」固定回 Network / Account 两个维度与 Saved toast 一个事件。走查用的屏由 MCP create_screen 写固定 HTML（不带外部图片），截图可复现。
// 每条用例自建项目、结束删掉；走查 TC-CORE-168 / 172 / 177 / 182 各自复位。
await assertTestApi();
const health = (await (await fetch(`${API}/v1/health`)).json()) as { llm?: string; database?: string };
if (health.llm !== 'stub') { console.log(`❌ TC-CORE-168～186 阻塞：API 不是 stub 驱动（当前 ${health.llm}）`); process.exit(2); }
await mkdir(EVIDENCE, { recursive: true });

let page: Page;
let ctx: BrowserContext;
let walkPage: Page | null = null; // 走查各开一个上下文：失败截图拍它
const { RUN, cleanups, step, summary } = suite('SURFACES', {
  page: () => walkPage ?? page,
  onTimeout: async () => { await page.close().catch(() => {}); page = await ctx.newPage(); },
});

const STUB = { kind: 'model', driver: 'stub', model: 'stub' } as const;
const FAKE = '00000000-0000-4000-8000-000000000000';
type Problem = { type?: string; title?: string; errors?: { path?: string; message: string }[] };
type Surface = { id: string; name: string; deviceType: 'mobile' | 'desktop'; position: number; version: number; states: { dims: { key: string; name: string; values: { key: string; name: string }[]; default: string; retired?: boolean }[]; events: { key: string; name: string; ms?: number }[] } };
type Screen = { id: string; name: string; route: string; surfaceId: string | null; group: string | null; width: number; height: number; currentRevisionId: string | null; variantOf: string | null; previewUrl: string | null; states?: { dims: { key: string }[]; uses: Record<string, string[]> } | null };
type Detail = { project: { id: string; name: string; deviceType: string; exemplarScreenId?: string | null }; surfaces: Surface[]; screens: Screen[]; components: { id: string; name: string }[] };

const post = <T = Record<string, unknown>>(p: string, body: unknown, headers: Record<string, string> = {}) => apiJson<T>(p, { method: 'POST', body: JSON.stringify(body), headers });
const patch = <T = Record<string, unknown>>(p: string, body: unknown) => apiJson<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
const del = (p: string) => apiJson(p, { method: 'DELETE' });
const detail = async (pid: string) => (await apiJson<Detail>(`/v1/projects/${pid}`)).body;
const revisions = async (sid: string) => (await apiJson<{ items: { id: string; seq: number; htmlUrl: string }[] }>(`/v1/screens/${sid}/revisions`)).body.items;
const projects: string[] = [];
/** 建一个普通项目（带第一端），记下来，套件末尾删 */
async function newProject(name: string, deviceType: 'mobile' | 'desktop' = 'mobile') {
  const r = await post<{ project: { id: string }; surfaces: Surface[] }>('/v1/projects', { name, deviceType });
  expect(r.status === 201 && r.body.surfaces?.length === 1, `建项目 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  projects.push(r.body.project.id);
  return { pid: r.body.project.id, first: r.body.surfaces[0] };
}
async function addSurface(pid: string, name: string, deviceType: 'mobile' | 'desktop') {
  const r = await post<{ surface: Surface }>(`/v1/projects/${pid}/surfaces`, { name, deviceType });
  expect(r.status === 201, `加一端 ${name} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.surface;
}
/** 发一句话造屏或改屏，等作业结束 */
async function say(pid: string, content: string, extra: Record<string, unknown> = {}): Promise<JobView> {
  const r = await post<{ job: JobView }>(`/v1/projects/${pid}/messages`, { content, runner: STUB, ...extra });
  expect(r.status === 202, `发消息 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await waitJob(r.body.job.id, 120);
  expect(job.status === 'succeeded', `作业 ${job.kind} ${job.status}：${JSON.stringify(job.output).slice(0, 200)}`);
  return job;
}
const mcp = await connectMcp();
const names = new Map<string, string>(); // 本套件写的屏 id → 屏名：设备台落定时按它认屏（收在那一条里的屏左栏不单列）
/** MCP 写一屏固定 HTML（REQ-AGENT-002）：走查与状态用例要可复现的内容 */
async function writeScreen(pid: string, args: { name: string; route: string; html: string; surfaceId?: string; group?: string; presentation?: string }): Promise<string> {
  const r = await callTool(mcp, 'quilt.create_screen', { projectId: pid, ...args });
  expect(!r.isError, `create_screen ${args.route}：${r.text.slice(0, 200)}`);
  const id = (r.json as { screenId: string }).screenId;
  names.set(id, args.name);
  return id;
}
/** MCP 按 find/replace 改一屏的当前版本：在 HTML 里埋状态写法或模拟别人刚改过 */
async function patchScreen(pid: string, screenId: string, find: string, replace: string): Promise<string> {
  const cur = (await detail(pid)).screens.find((x) => x.id === screenId)!;
  const r = await callTool(mcp, 'quilt.patch_screen', { screenId, expectedRevisionId: cur.currentRevisionId, edits: [{ find, replace }] });
  expect(!r.isError, `patch_screen ${screenId}：${r.text.slice(0, 200)}`);
  return r.text;
}
const busyJob = (pid: string, screenId: string) => post<{ job: JobView }>(`/v1/projects/${pid}/messages`, { content: `占住这一屏\n[stub-hold:20000]`, targetScreenIds: [screenId], runner: STUB });
const cancel = (jobId: string) => post(`/v1/jobs/${jobId}/cancel`, {});

// ---------- 固定 HTML：随手记 App（手机）与后台（桌面） ----------
const NAV = (here: string) => `<nav class="sticky bottom-0 mt-auto grid grid-cols-3 bg-surface border-t border-outline-variant">${[['/home', '首页', 'home'], ['/search', '搜索', 'search'], ['/settings', '设置', 'settings']].map(([r, n, i]) => `<a href="${r}" class="flex flex-col items-center gap-1 py-2 text-xs ${r === here ? 'text-primary font-semibold' : 'text-on-surface-variant'}"><i data-lucide="${i}" class="w-5 h-5"></i>${n}</a>`).join('')}</nav>`;
const HOME = (extra = '') => `<div class="min-h-dvh flex flex-col bg-background text-on-background">
<header class="px-5 pt-8 pb-4"><p class="text-sm text-on-surface-variant">十月 · 12 条</p><h1 class="text-2xl font-semibold">随手记</h1></header>
<main class="flex-1 px-5 space-y-3">${[['周会要点', '下周一前把排期发出来'], ['读书', '《设计心理学》第三章'], ['买菜', '鸡蛋、番茄、青菜']].map(([t, s]) => `<a href="/note" class="block rounded-lg bg-surface border border-outline-variant p-4"><p class="font-medium">${t}</p><p class="text-sm text-on-surface-variant">${s}</p></a>`).join('')}${extra}
<a href="/about" class="block text-center text-sm text-on-surface-variant py-2">关于随手记</a></main>
${NAV('/home')}</div>`;
const NOTE = `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="h-14 flex items-center gap-2 px-3 border-b border-outline-variant"><a href="/home" class="w-10 h-10 flex items-center justify-center" aria-label="返回"><i data-lucide="chevron-left" class="w-5 h-5"></i></a><h1 class="text-lg font-semibold">周会要点</h1></header>
<main class="flex-1 px-5 py-4 space-y-3 text-sm leading-6"><p>1. 下周一前把排期发出来。</p><p>2. 设计稿周三评审，评审前一天发出。</p><p>3. 上线窗口定在月底。</p>${Array.from({ length: 14 }, (_, i) => `<p class="text-on-surface-variant">补充 ${i + 1}：这一段用来把页面撑长，滚动后再改，位置应该不变。</p>`).join('')}</main></div>`;
const SEARCH = `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="px-5 pt-8 pb-4"><h1 class="text-2xl font-semibold">搜索</h1></header><main class="flex-1 px-5"><label for="q" class="text-sm font-medium">关键词</label><input id="q" class="mt-1 w-full h-12 px-4 rounded-md bg-surface border border-outline-variant" placeholder="搜笔记"></main>${NAV('/search')}</div>`;
const SETTINGS = `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="px-5 pt-8 pb-4"><h1 class="text-2xl font-semibold">设置</h1></header><main class="flex-1 px-5 space-y-2">${['深色模式', '每日提醒', '同步到云端'].map((t) => `<div class="flex items-center justify-between rounded-lg bg-surface border border-outline-variant px-4 py-3"><span>${t}</span><span class="w-10 h-6 rounded-full bg-surface-variant"></span></div>`).join('')}</main>${NAV('/settings')}</div>`;
const DASH = `<div class="min-h-dvh flex bg-background text-on-background"><aside class="w-56 border-r border-outline-variant p-4 space-y-2"><p class="font-semibold">随手记后台</p><a href="/dashboard" class="block text-sm text-primary">概览</a><a href="/users" class="block text-sm text-on-surface-variant">用户</a></aside>
<main class="flex-1 p-8 space-y-6"><h1 class="text-3xl font-semibold">概览</h1><div class="grid grid-cols-3 gap-4">${[['日活', '1,284'], ['新增笔记', '3,902'], ['同步失败', '12']].map(([k, v]) => `<div class="rounded-lg bg-surface border border-outline-variant p-5"><p class="text-sm text-on-surface-variant">${k}</p><p class="text-3xl font-semibold tabular-nums">${v}</p></div>`).join('')}</div></main></div>`;
/** 没有链接、也没有屏链到它的一屏：屏目录里不收进那一条，按分组单列 */
const LONE = (title: string) => `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="px-5 pt-8 pb-4"><h1 class="text-2xl font-semibold">${title}</h1></header><main class="flex-1 px-5 text-sm text-on-surface-variant">这一屏还没接进导航。</main></div>`;
const SHEET = `<div class="min-h-dvh bg-transparent flex items-end"><div class="w-full rounded-t-3xl bg-surface p-6 space-y-3"><h2 class="text-lg font-semibold">新建笔记</h2><input class="w-full h-12 px-4 rounded-md bg-surface-variant" placeholder="标题"><a href="/home" class="block text-center text-sm text-on-surface-variant">取消</a></div></div>`;
/** 随手记：手机端 App 4 屏（首页、详情、搜索在「主页」，设置在「我的」）+ 可选桌面端「后台」1 屏 */
async function notesApp(name: string, opts: { admin?: boolean } = {}) {
  const { pid, first } = await newProject(name);
  const ids = {
    home: await writeScreen(pid, { name: '首页', route: '/home', html: HOME(), group: '主页' }),
    note: await writeScreen(pid, { name: '笔记详情', route: '/note', html: NOTE, group: '主页' }),
    search: await writeScreen(pid, { name: '搜索', route: '/search', html: SEARCH, group: '主页' }),
    settings: await writeScreen(pid, { name: '设置', route: '/settings', html: SETTINGS, group: '我的' }),
  };
  let admin: Surface | null = null; let dash = '';
  if (opts.admin) { admin = await addSurface(pid, '后台', 'desktop'); dash = await writeScreen(pid, { name: '概览', route: '/dashboard', html: DASH, surfaceId: admin.id }); }
  return { pid, app: first, admin, ids, dash };
}

// ---------- 浏览器助手 ----------
const browser = await launch();
// 测试栈不配模型通道，通道列表里只有本机会话：给浏览器的通道列表补一项 stub 模型并设为缺省，输入框照常经 API 发出（runner 即 STUB）
const withStubRunner = async (c: BrowserContext) => {
  await c.addInitScript(() => { try { localStorage.setItem('quilt:theme', 'light'); } catch { /* about:blank */ } });
  // 设备台落定的信号：运行时整份载入发 quilt:ready、换屏的过渡放完发 quilt:swapped，都带「项目 · 屏名」的标题
  await c.addInitScript(() => window.addEventListener('message', (e) => { const d = e.data as { type?: string; title?: string }; if (d?.type === 'quilt:ready' || d?.type === 'quilt:swapped') (window as unknown as { __landed?: string }).__landed = d.title; }));
  await c.route('**/v1/runners', async (route) => {
    // 走查的上下文关掉时可能还有一个通道列表请求在途：那时 route 已作废，丢掉即可
    try {
      const res = await route.fetch();
      const body = (await res.json()) as { items: unknown[]; default: string };
      await route.fulfill({ response: res, json: { ...body, default: 'model:stub', items: [{ id: 'model:stub', label: 'Stub 模型', hint: 'stub', runner: STUB, available: true, vision: true, source: 'builtin', vendor: 'stub' }, ...body.items] } });
    } catch { /* 上下文已关 */ }
  });
  return c;
};
ctx = await withStubRunner(await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' }));
page = await ctx.newPage();
const openCanvas = async (pid: string, surfaceId?: string, pg: Page = page) => {
  await pg.goto(`${WEB}/p/${pid}${surfaceId ? `?surface=${surfaceId}` : ''}`);
  await pg.getByTestId('surface-switcher').waitFor({ timeout: 15000 });
};
const openFull = async (pid: string, q: Record<string, string> = {}, pg: Page = page) => {
  await pg.goto(`${WEB}/p/${pid}/view${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`);
  await pg.getByTestId('fv-toolbar').waitFor({ timeout: 15000 });
};
const param = (k: string, pg: Page = page) => new URL(pg.url()).searchParams.get(k);
/** 设备台里的页面就绪（收到 quilt:ready、iframe 不再 inert），返回它的 frame；叠层屏落定的是垫在底下的那一屏，用 base 给它的名字 */
async function deviceFrame(pg: Page = page, base?: string): Promise<Frame> {
  await pg.locator('[data-testid="device-iframe"]:not([inert])').waitFor({ timeout: 20000 });
  const f = await (await pg.getByTestId('device-iframe').elementHandle())!.contentFrame();
  expect(f, '设备台 iframe 没有文档');
  // 等设备台落定在地址里的那一屏：换屏的 view transition 放完才发 quilt:swapped，过渡期间的点击落在过渡层上、到不了页面元素。
  // 地址先变、页面随后才渲染到新的一屏（路由切换走 transition），所以按地址里的屏去目录取名字，不读工具栏上此刻写的
  const id = param('screen', pg);
  const listed = id ? (await pg.locator(`[data-dir-item="${id}"]`).first().innerText({ timeout: 1000 }).catch(() => '')).split('\n')[0].trim() : '';
  const name = base ?? (listed || (id && names.get(id)) || await pg.getByTestId('fv-screen-name').locator('span').first().innerText().catch(() => ''));
  if (name) await pg.waitForFunction((n) => !!(window as unknown as { __landed?: string }).__landed?.endsWith(` · ${n}`), name, { timeout: 15000 });
  await f!.waitForFunction(() => document.fonts.status === 'loaded' && !!document.body?.textContent?.trim(), null, { timeout: 15000 });
  return f!;
}
// 点设备台里的元素：设备台按 CSS zoom 缩小，Playwright 在 iframe 里算点击点时不乘这个缩放（同 sketch.ts 的 clickInScaled）
// 换屏时运行时整份换 DOM（quilt:swap），刚取到的元素可能随即脱离文档：取坐标失败就重取
async function clickInDevice(target: import('playwright').Locator, pg: Page = page): Promise<void> {
  let c = { x: 0, y: 0 };
  await eventually(async () => {
    await target.scrollIntoViewIfNeeded({ timeout: 2000 });
    c = await target.evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, null, { timeout: 2000 });
  }, 10000, 200);
  const frame = pg.getByTestId('device-iframe');
  const shown = (await frame.boundingBox())!;
  const laid = await frame.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
  // 预览是跨源 iframe（独立进程），指针事件先要一次异步命中测试才送得进去：先移过去停一下再点，同真人
  const at = { x: shown.x + c.x * (shown.width / laid.w), y: shown.y + c.y * (shown.height / laid.h) };
  await pg.mouse.move(at.x, at.y);
  await sleep(150);
  await pg.mouse.click(at.x, at.y);
}
const currentDir = (pg: Page = page) => pg.locator('[data-testid="dir-item"][aria-current="page"]').getAttribute('data-dir-item');
/** 左栏点一屏：它收在那一条里时先点展开键 */
async function pickDir(id: string, pg: Page = page) {
  const item = pg.locator(`[data-testid="dir-item"][data-dir-item="${id}"]`);
  if (!(await item.count()) && (await pg.getByTestId('dir-chain-toggle').getAttribute('aria-expanded')) === 'false') await pg.getByTestId('dir-chain-toggle').click();
  await item.click();
}
const chainRow = (pg: Page = page) => ({
  count: async () => Number(await pg.getByTestId('dir-chain').getAttribute('data-count', { timeout: 3000 })),
  expanded: async () => (await pg.getByTestId('dir-chain-toggle').getAttribute('aria-expanded')) === 'true',
  lit: async () => (await pg.getByTestId('dir-chain-open').getAttribute('aria-current')) === 'true',
});
const dirGroups = (pg: Page = page) => pg.getByTestId('dir-section').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
const toastHas = (text: string, pg: Page = page, ms = 6000) => eventually(async () => expect((await pg.getByText(text).count()) >= 1, `应提示「${text}」`), ms, 100);
async function sendFromComposer(text: string, pg: Page = page): Promise<string> {
  await pg.getByTestId('composer-input').fill(text);
  const resp = pg.waitForResponse((r) => /\/v1\/projects\/[^/]+\/(messages|jobs)$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 10000 });
  await pg.getByTestId('composer-send').click();
  const r = await resp;
  expect([201, 202].includes(r.status()), `发送返回 ${r.status()}：${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { job: { id: string } }).job.id;
}
/** 走查拍照：截视口，热点按选择器取视口坐标（同 sketch.ts 的 TC-CORE-111） */
function shooter(flow: string, pg: () => Page) {
  const out = path.join(EVIDENCE, `run-${RUN}-${flow.toLowerCase()}`);
  const hotspots: Record<string, { kind: 'tap' | 'look'; target: string; x: number; y: number; w: number; h: number }> = {};
  return {
    out,
    async snap(key: string, kind: 'tap' | 'look', target: string) {
      await mkdir(out, { recursive: true });
      const p = pg();
      await p.waitForFunction(() => [...document.querySelectorAll('img')].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(600);
      const b = await p.locator(target).first().boundingBox();
      expect(b, `${key} 的热点 ${target} 不在视口里`);
      hotspots[key] = { kind, target, x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
      await p.screenshot({ path: path.join(out, `${key.replace(`${flow}/`, '')}.png`) });
    },
    save: () => writeFile(path.join(out, 'hotspots.json'), JSON.stringify(hotspots, null, 2)),
  };
}
const walkContext = async () => {
  const wctx = await withStubRunner(await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' }));
  cleanups.push(async () => { walkPage = null; await wctx.close(); });
  walkPage = await wctx.newPage();
  return walkPage;
};

seed('seed'); // 测试库复位（lib.ts 只放行 *_test）

// ---------- TC-CORE-168 FLOW-SURFACE 走查 ----------
await step('TC-CORE-168', async () => {
  const { pid, app } = await notesApp('随手记 · 端');
  const wp = await walkContext();
  const cam = shooter('FLOW-SURFACE', () => wp);
  await openCanvas(pid, undefined, wp);
  await wp.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  // S1 端切换器里点「加一端…」
  await wp.getByTestId('surface-switcher').click();
  await wp.getByTestId('surface-switcher-list').waitFor();
  expect((await wp.getByTestId('surface-option').count()) === 1 && (await wp.getByTestId('surface-option').innerText()).includes('App'), 'S1 切换器应只有 App 一端');
  await cam.snap('FLOW-SURFACE/S1', 'tap', '[data-testid="surface-add"]');
  await wp.getByTestId('surface-add').click();
  // S2 弹层填端名、选桌面
  await wp.getByTestId('surface-dialog').waitFor();
  await wp.locator('#ns-name').fill('后台');
  await wp.locator('label').filter({ hasText: '桌面' }).click();
  await cam.snap('FLOW-SURFACE/S2', 'tap', '[data-testid="surface-dialog-submit"]');
  await wp.getByTestId('surface-dialog-submit').click();
  // S3 建出空的一端，切换器切到它
  await eventually(async () => expect((await wp.getByTestId('surface-switcher').innerText()).includes('后台'), '切换器应切到「后台」'), 8000, 100);
  const admin = (await detail(pid)).surfaces.find((s) => s.name === '后台')!;
  expect(admin?.deviceType === 'desktop' && param('surface', wp) === admin.id, `S3 新端应为桌面、地址带它：${JSON.stringify(admin)} ${wp.url()}`);
  expect((await wp.locator('[data-testid="screen-card"]').count()) === 0, 'S3 新端的画布上应没有屏');
  await cam.snap('FLOW-SURFACE/S3', 'look', '[data-testid="surface-switcher"]');
  // S4 在这一端写一句话造屏
  await wp.getByTestId('composer-input').fill('一个后台概览页');
  await cam.snap('FLOW-SURFACE/S4', 'tap', '[data-testid="composer-send"]');
  const jid = await sendFromComposer('一个后台概览页', wp);
  const job = await waitJob(jid, 120);
  expect(job.status === 'succeeded' && job.input.surfaceId === admin.id, `S4 造屏作业应落在后台：${job.status} ${JSON.stringify(job.input).slice(0, 200)}`);
  const d = await detail(pid);
  const made = d.screens.filter((s) => s.surfaceId === admin.id);
  expect(made.length >= 1 && made.every((s) => s.width === 1280) && d.screens.filter((s) => s.surfaceId === app.id).length === 4, `S5 屏应全落在后台、按桌面尺寸，App 仍 4 屏：${made.map((s) => `${s.route}/${s.width}`).join(',')}`);
  // S6「…」里改名
  await wp.getByTestId('surface-switcher').click();
  await wp.locator(`[data-testid="surface-option"][data-surface-id="${admin.id}"]`).waitFor();
  await wp.locator('li', { has: wp.locator(`[data-surface-id="${admin.id}"]`) }).getByTestId('surface-more').click();
  await wp.getByTestId('surface-rename').click();
  await wp.getByTestId('surface-rename-input').fill('管理后台');
  await cam.snap('FLOW-SURFACE/S6', 'tap', '[data-testid="surface-rename-save"]');
  await wp.getByTestId('surface-rename-input').press('Enter');
  await eventually(async () => expect((await detail(pid)).surfaces.find((s) => s.id === admin.id)?.name === '管理后台', '改名没存上'), 5000, 100);
  // S7「…」里删掉它：就地确认写屏数，确认后连屏一起删、切到剩下的第一端
  await wp.locator('li', { has: wp.locator(`[data-surface-id="${admin.id}"]`) }).getByTestId('surface-more').click();
  await wp.getByTestId('surface-delete').click();
  const confirm = wp.getByTestId('surface-delete-confirm');
  await confirm.waitFor();
  expect((await confirm.innerText()).includes('管理后台') && (await confirm.innerText()).includes(`${made.length} 屏`), `S7 确认里应写端名与屏数：${await confirm.innerText()}`);
  await cam.snap('FLOW-SURFACE/S7', 'tap', '[data-testid="surface-delete-yes"]');
  await wp.getByTestId('surface-delete-yes').click();
  await eventually(async () => expect(param('surface', wp) === app.id && (await wp.getByTestId('surface-switcher').innerText()).includes('App'), '删了正在看的那一端应切回 App'), 8000, 100);
  const after = await detail(pid);
  expect(after.surfaces.length === 1 && after.screens.every((s) => s.surfaceId === app.id), 'S7 后台连屏一起删掉');
  await cam.save();
  return `6 张截图与热点在 ${path.relative(path.resolve(EVIDENCE, '../..'), cam.out)}/`;
});

// ---------- TC-CORE-169 建端的校验 ----------
await step('TC-CORE-169', async () => {
  const s = softly();
  const { pid } = await newProject('建端校验');
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/surfaces`, { name: 'app', deviceType: 'desktop' }); expect(r.status === 409 && r.body.type === '/errors/surface-name-taken', `不分大小写重名应 409：${r.status} ${r.body.type}`); });
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/surfaces`, { name: '  ', deviceType: 'mobile' }); expect(r.status === 400 && r.body.type === '/errors/validation', `空名应 400：${r.status}`); });
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/surfaces`, { name: '一二三四五六七八九十一二三四五六七八九十一', deviceType: 'mobile' }); expect(r.status === 400, `21 字应 400：${r.status}`); });
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/surfaces`, { name: 'Watch', deviceType: 'watch' }); expect(r.status === 400, `不认识的设备应 400：${r.status}`); });
  await s.check(async () => { const sb = (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId; const r = await post<Problem>(`/v1/projects/${sb}/surfaces`, { name: 'X', deviceType: 'mobile' }); expect(r.status === 404, `对草稿本建端应 404：${r.status}`); });
  for (const n of ['B', 'C', 'D', 'E', 'F']) await addSurface(pid, n, 'mobile');
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/surfaces`, { name: 'G', deviceType: 'mobile' }); expect(r.status === 400 && JSON.stringify(r.body).includes('6'), `第 7 端应 400 并写上限：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); });
  // 界面：6 端时「加一端…」不可用、写明上限
  await s.check(async () => {
    await openCanvas(pid);
    await page.getByTestId('surface-switcher').click();
    const add = page.getByTestId('surface-add');
    await add.waitFor();
    expect((await page.getByTestId('surface-option').count()) === 6, '切换器应列 6 端');
    expect((await add.getAttribute('aria-disabled')) === 'true', '「加一端…」应不可用');
    expect((await page.locator('#surface-full').innerText()).includes('最多 6 端'), '应写「一个项目最多 6 端」');
    await add.click({ force: true });
    await sleep(300);
    expect((await page.getByTestId('surface-dialog').count()) === 0, '点了也不该开弹层');
    await page.keyboard.press('Escape');
  });
  s.done();
  return '重名 409、空名与 21 字 400、未知设备 400、草稿本 404、第 7 端 400；界面 6 端时「加一端…」不可用并写上限';
});

// ---------- TC-CORE-170 改名与删端 ----------
await step('TC-CORE-170', async () => {
  const s = softly();
  const { pid, app, admin, ids } = await notesApp('改名删端', { admin: true });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${admin!.id}`, { name: 'APP', expectedVersion: admin!.version }); expect(r.status === 409 && r.body.type === '/errors/surface-name-taken', `改成重名应 409：${r.status} ${r.body.type}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${admin!.id}`, { name: '管理', expectedVersion: admin!.version + 5 }); expect(r.status === 409 && r.body.type === '/errors/version-conflict', `旧版本号应 409：${r.status} ${r.body.type}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${admin!.id}`, { deviceType: 'mobile', expectedVersion: admin!.version }); expect(r.status === 400, `改设备应 400：${r.status}`); });
  // 界面：改名重名时名字框里提示，名字不变
  await s.check(async () => {
    await openCanvas(pid, admin!.id);
    await page.getByTestId('surface-switcher').click();
    await page.locator('li', { has: page.locator(`[data-surface-id="${admin!.id}"]`) }).getByTestId('surface-more').click();
    await page.getByTestId('surface-rename').click();
    await page.getByTestId('surface-rename-input').fill('app');
    await page.getByTestId('surface-rename-input').press('Enter');
    await eventually(async () => expect((await page.locator('[role="alert"]').filter({ hasText: '已经有叫这个名字的一端' }).count()) === 1, '名字框下应提示重名'), 5000, 100);
    expect((await detail(pid)).surfaces.find((x) => x.id === admin!.id)?.name === '后台', '重名时名字不该变');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });
  // 有屏在改：删端 409 screen-busy，什么都不删
  await s.check(async () => {
    const hold = await busyJob(pid, ids.home);
    expect(hold.status === 202, `占住首页 ${hold.status}`);
    await eventually(async () => expect((await apiJson<{ job: JobView }>(`/v1/jobs/${hold.body.job.id}`)).body.job.status === 'running', '占位作业没跑起来'), 10000, 200);
    const r = await del(`/v1/surfaces/${app.id}`);
    expect(r.status === 409 && (r.body as Problem).type === '/errors/screen-busy', `有屏在改时删端应 409 screen-busy：${r.status} ${(r.body as Problem)?.type}`);
    expect((await detail(pid)).surfaces.length === 2, '409 后两端都在');
    await cancel(hold.body.job.id);
    await waitJob(hold.body.job.id, 60);
  });
  // 样板屏在要删的这一端：清空，回落到最早的一屏
  await s.check(async () => {
    const ex = await patch<Problem>(`/v1/projects/${pid}`, { exemplarScreenId: (await detail(pid)).screens.find((x) => x.surfaceId === admin!.id)!.id });
    expect(ex.status === 200, `把后台的概览设为样板屏 ${ex.status} ${JSON.stringify(ex.body).slice(0, 160)}`);
    const r = await del(`/v1/surfaces/${admin!.id}`);
    expect(r.status === 204, `删后台 ${r.status}`);
    const d = await detail(pid);
    expect(d.surfaces.length === 1 && d.screens.every((x) => x.surfaceId === app.id) && (d.project.exemplarScreenId ?? null) === null, `后台的屏随端删掉、样板屏清空：${d.project.exemplarScreenId} ${d.screens.length}`);
  });
  // 只剩一端：不能删（INV-CORE-008）
  await s.check(async () => {
    const r = await del(`/v1/surfaces/${app.id}`);
    expect(r.status === 400 && JSON.stringify(r.body).includes('至少'), `删最后一端应 400：${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    await openCanvas(pid);
    await page.getByTestId('surface-switcher').click();
    await page.getByTestId('surface-more').click();
    await page.getByTestId('surface-delete').click();
    await page.getByTestId('surface-delete-yes').click();
    await eventually(async () => expect((await page.getByTestId('surface-delete-confirm').innerText()).includes('至少要有一端'), '确认里应写「项目至少要有一端」'), 5000, 100);
    expect((await detail(pid)).surfaces.length === 1, '最后一端还在');
    await page.keyboard.press('Escape');
  });
  s.done();
  return '改名重名 409（名字框提示）、旧版本 409、改设备 400；有屏在改删端 409 不删；删后台连屏删、样板屏清空；最后一端删不掉（界面写原因）';
});

// ---------- TC-CORE-171 按端造屏 ----------
await step('TC-CORE-171', async () => {
  const s = softly();
  const { pid, first } = await newProject('按端造屏');
  const admin = await addSurface(pid, 'Admin', 'desktop');
  const j1 = await say(pid, 'home screen', { count: 2 });
  await s.check(() => expect(j1.input.surfaceId === first.id, `不带 surfaceId 应落第一端：${j1.input.surfaceId}`));
  const j2 = await say(pid, 'home screen', { count: 2, surfaceId: admin.id });
  const d = await detail(pid);
  const inApp = d.screens.filter((x) => x.surfaceId === first.id);
  const inAdmin = d.screens.filter((x) => x.surfaceId === admin.id);
  await s.check(() => expect(j2.input.surfaceId === admin.id && inAdmin.length >= 1 && inAdmin.every((x) => x.width === 1280), `Admin 的屏按桌面尺寸：${inAdmin.map((x) => x.width)}`));
  await s.check(() => expect(inApp.some((a) => inAdmin.some((b) => b.route === a.route)), `两端可以有同名路由：${inApp.map((x) => x.route)} / ${inAdmin.map((x) => x.route)}`));
  await s.check(() => { for (const list of [inApp, inAdmin]) { const r = list.filter((x) => !x.variantOf).map((x) => x.route); expect(new Set(r).size === r.length, `同一端里路由不重：${r}`); } });
  await s.check(() => expect(d.screens.every((x) => d.surfaces.some((y) => y.id === x.surfaceId)), '每一屏恰好属于本项目的一端'));
  await s.check(async () => { const r = await post<Problem>(`/v1/projects/${pid}/messages`, { content: 'x', surfaceId: FAKE, runner: STUB }); expect(r.status === 404, `不是本项目的端应 404：${r.status}`); });
  await s.check(async () => {
    const other = await newProject('别的项目');
    const r = await post<Problem>(`/v1/projects/${pid}/messages`, { content: 'x', surfaceId: other.first.id, runner: STUB });
    expect(r.status === 404, `别的项目的端应 404：${r.status}`);
  });
  await s.check(async () => { const m = (await apiJson<{ nodes: { surfaceId: string }[] }>(`/v1/projects/${pid}/app-map?surfaceId=${admin.id}`)).body; expect(m.nodes.length === inAdmin.length && m.nodes.every((n) => n.surfaceId === admin.id), `应用地图 ?surfaceId 只取这一端：${m.nodes.length}`); });
  await s.check(async () => { const r = await callTool(mcp, 'quilt.create_screen', { projectId: pid, surfaceId: admin.id, name: '重名', route: inAdmin[0].route, html: DASH }); expect(r.isError && r.text.includes('route'), `同一端里重名路由应被拒：${r.text.slice(0, 160)}`); });
  s.done();
  return `缺省第一端、指定 Admin 落桌面尺寸；两端路由可重、端内不重；别的端 404；应用地图按端；MCP 端内重名路由被拒`;
});

// ---------- TC-CORE-172 FLOW-FULLVIEW 走查 ----------
await step('TC-CORE-172', async () => {
  const { pid, ids } = await notesApp('随手记 · 全屏');
  await writeScreen(pid, { name: '回收站', route: '/trash', html: LONE('回收站'), group: '我的' });
  const wp = await walkContext();
  const cam = shooter('FLOW-FULLVIEW', () => wp);
  await openCanvas(pid, undefined, wp);
  await wp.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  // S1 顶栏把视图切到「全屏」（画布上没选中屏）
  await cam.snap('FLOW-FULLVIEW/S1', 'tap', '[data-testid="view-full"]');
  await wp.getByTestId('view-full').click();
  await wp.waitForURL(/\/p\/[^/]+\/view/, { timeout: 8000 });
  // S2 左栏：从首页点得到的 4 屏收成一条，没串上的回收站在「我的」下面单列；S3 中栏放出第一屏
  await deviceFrame(wp);
  const row = chainRow(wp);
  const groups = await dirGroups(wp);
  const dirText = await wp.getByTestId('screen-directory').innerText();
  expect((await row.count()) === 4 && (await wp.getByTestId('dir-chain-open').innerText()).trim() === '首页' && !(await row.expanded()), `S2 应收成一条、只写「首页」：${await row.count()}`);
  expect(!dirText.includes('/'), `S2 左栏不该写路由：${dirText}`);
  expect(JSON.stringify(groups) === JSON.stringify(['我的']) && (await wp.getByTestId('dir-item').count()) === 1, `S2 分组只剩「我的」一节、单列回收站：${JSON.stringify(groups)}`);
  expect((await row.lit()) && param('screen', wp) === ids.home, `S3 应打开第一屏首页、那一条高亮：${param('screen', wp)}`);
  await cam.snap('FLOW-FULLVIEW/S2', 'look', '[data-testid="screen-directory"]');
  await cam.snap('FLOW-FULLVIEW/S3', 'look', '[data-testid="device-stage"] .draft-frame');
  // S4 展开那一条点「设置」，再按 ↑ 回到上一屏「搜索」
  await wp.getByTestId('dir-chain-toggle').click();
  const listed = await wp.locator('[data-testid="dir-chain"] [data-testid="dir-item"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir-item')));
  expect(JSON.stringify(listed) === JSON.stringify([ids.home, ids.note, ids.search, ids.settings]), `S4 展开后应依次列首页、详情、搜索、设置：${JSON.stringify(listed)}`);
  await wp.locator(`[data-dir-item="${ids.settings}"]`).click();
  await eventually(async () => expect(param('screen', wp) === ids.settings, 'S4 点设置后地址应换'), 5000, 100);
  await deviceFrame(wp);
  await cam.snap('FLOW-FULLVIEW/S4', 'tap', `[data-dir-item="${ids.settings}"]`);
  await wp.keyboard.press('ArrowUp');
  await eventually(async () => expect(param('screen', wp) === ids.search, 'S4 按 ↑ 应到搜索'), 5000, 100);
  // S5 页面里点底栏「首页」，跳到首页；再点第一条笔记到详情
  let f = await deviceFrame(wp);
  await clickInDevice(f.locator('nav a[href="/home"]'), wp);
  await eventually(async () => expect(param('screen', wp) === ids.home && (await currentDir(wp)) === ids.home, 'S5 点首页后地址与左栏高亮应换'), 8000, 100);
  f = await deviceFrame(wp);
  await f.locator('h1', { hasText: '随手记' }).waitFor({ timeout: 8000 });
  await cam.snap('FLOW-FULLVIEW/S5', 'look', `[data-dir-item="${ids.home}"]`);
  await clickInDevice(f.locator('a[href="/note"]').first(), wp);
  await eventually(async () => expect(param('screen', wp) === ids.note, 'S5 点笔记应到详情'), 8000, 100);
  // S6 在详情页滚到中间，输入框写一句改这一屏
  f = await deviceFrame(wp);
  await f.locator('h1', { hasText: '周会要点' }).waitFor({ timeout: 8000 });
  const y0 = await f.evaluate(() => { window.scrollTo(0, 400); return window.scrollY; });
  expect(y0 > 100, `S6 详情页应能滚下去：${y0}`);
  await wp.getByTestId('composer-input').fill('标题改成周会纪要\n[stub-patch]');
  expect((await wp.getByTestId('target-chip').innerText()).includes('笔记详情') && (await wp.getByTestId('verb-line').innerText()).includes('改 1 屏'), `S6 目标应是「笔记详情」、动词行写改 1 屏：${await wp.getByTestId('verb-line').innerText()}`);
  await cam.snap('FLOW-FULLVIEW/S6', 'tap', '[data-testid="composer-send"]');
  const revBefore = (await revisions(ids.note)).length;
  const j1 = await sendFromComposer('标题改成周会纪要\n[stub-patch]', wp);
  expect((await waitJob(j1, 60)).status === 'succeeded', 'S6 改屏作业没成功');
  // S7 新一版原地换、滚动位置不变
  await eventually(async () => { const g = await deviceFrame(wp); expect((await g.locator('h1').innerText()).includes('Patched title'), '设备台没换成新一版'); }, 15000, 300);
  f = await deviceFrame(wp);
  const y = await f.evaluate(() => window.scrollY);
  expect(Math.abs(y - y0) < 2 && (await revisions(ids.note)).length === revBefore + 1, `S7 滚动应停在 ${y0}：${y}`);
  await cam.snap('FLOW-FULLVIEW/S7', 'look', '[data-testid="device-stage"] .draft-frame');
  // S8 打开「选元素」点中一段，只改这一块
  await wp.getByTestId('fv-pick').click();
  f = await deviceFrame(wp);
  await clickInDevice(f.locator('main p').first(), wp);
  await wp.getByTestId('draft-pick-chip').first().waitFor({ timeout: 5000 });
  await wp.getByTestId('composer-input').fill('这一条加粗');
  await cam.snap('FLOW-FULLVIEW/S8', 'tap', '[data-testid="composer-send"]');
  const j2 = await sendFromComposer('这一条加粗', wp);
  const job2 = await waitJob(j2, 60);
  expect(job2.kind === 'regenerate_subtree' && job2.status === 'succeeded', `S8 应是只改一块的作业：${job2.kind} ${job2.status}`);
  // S9 切回画布：镜头摆到详情并选中它
  await wp.getByTestId('view-canvas').click();
  await wp.waitForURL((u) => !u.pathname.endsWith('/view'), { timeout: 8000 });
  await eventually(async () => expect((await wp.locator('[data-testid="screen-card"][data-route="/note"].selected').count()) === 1, '回画布后详情应被选中'), 8000, 200);
  await cam.snap('FLOW-FULLVIEW/S9', 'look', '[data-testid="screen-card"][data-route="/note"]');
  await cam.save();
  return `9 张截图与热点在 ${path.relative(path.resolve(EVIDENCE, '../..'), cam.out)}/`;
});

// ---------- TC-CORE-173 进入全屏视图与屏目录 ----------
await step('TC-CORE-173', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('全屏进入', { admin: true });
  const tags = await writeScreen(pid, { name: '标签', route: '/tags', html: LONE('标签'), group: '主页' });
  const trash = await writeScreen(pid, { name: '回收站', route: '/trash', html: LONE('回收站'), group: '我的' });
  const empty = await addSurface(pid, '手表', 'mobile');
  // 空端：中栏写这一端还没有屏
  await s.check(async () => { await openFull(pid, { surface: empty.id }); await page.getByTestId('fv-empty').waitFor({ timeout: 8000 }); expect((await page.getByTestId('fv-empty').innerText()).includes('还没有屏'), '空端应写还没有屏'); });
  // 画布上选中着「设置」：切过去打开它
  await s.check(async () => {
    await openCanvas(pid, app.id);
    await page.locator('[data-testid="screen-card"][data-route="/settings"]').click();
    await page.getByTestId('view-full').click();
    await eventually(async () => expect(param('screen') === ids.settings, `应打开选中的设置：${page.url()}`), 8000, 100);
  });
  // 地址里的屏已被删：打开第一屏并提示
  await s.check(async () => { await openFull(pid, { surface: app.id, screen: FAKE }); await eventually(async () => expect(param('screen') === ids.home, `应落到第一屏：${param('screen')}`), 8000, 100); await toastHas('那一屏已被删除'); });
  // 移分组：只改分组、不建修订；分组名超 20 字 400；没分组的归最后「未分组」
  await s.check(async () => {
    const before = (await revisions(trash)).length;
    await openFull(pid, { surface: app.id, screen: trash });
    await page.locator('li', { has: page.locator(`[data-dir-item="${trash}"]`) }).getByTestId('dir-more').click();
    await page.getByTestId('dir-move').click();
    await page.getByTestId('dir-group-option').filter({ hasText: '主页' }).click();
    await eventually(async () => expect((await detail(pid)).screens.find((x) => x.id === trash)?.group === '主页', '回收站应移到主页'), 5000, 100);
    expect((await revisions(trash)).length === before, '移分组不该建修订');
    const long = await patch<Problem>(`/v1/screens/${trash}`, { group: '一二三四五六七八九十一二三四五六七八九十一' });
    expect(long.status === 400, `分组名 21 字应 400：${long.status}`);
    await patch(`/v1/screens/${tags}`, { group: null });
    await eventually(async () => { const g = await dirGroups(); expect(JSON.stringify(g) === JSON.stringify(['主页', '']), `没分组的应归最后：${JSON.stringify(g)}`); }, 8000, 200);
  });
  // 别处删了正在看的屏：跳到同一节（收成一条的那些屏）的下一屏并提示
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: ids.home });
    await deviceFrame();
    await del(`/v1/screens/${ids.home}`);
    await eventually(async () => expect(param('screen') === ids.note, `应跳到同一节的下一屏详情：${param('screen')}`), 10000, 200);
    await toastHas('这一屏已被删除');
  });
  // 桌面端：按比例缩小到放得下、不裁切
  await s.check(async () => {
    const admin = (await detail(pid)).surfaces.find((x) => x.name === '后台')!;
    await openFull(pid, { surface: admin.id });
    await deviceFrame();
    const box = (await page.locator('[data-testid="device-stage"] .draft-frame').boundingBox())!;
    const room = (await page.getByTestId('device-stage').boundingBox())!;
    const scale = Number(await page.locator('[data-testid="device-stage"] .draft-frame').getAttribute('data-scale'));
    expect(scale < 1 && box.width <= room.width && box.height <= room.height && Math.abs(box.width / box.height - 1280 / 800) < 0.02, `桌面应缩小放下：scale ${scale} ${box.width}×${box.height} 在 ${room.width}×${room.height}`);
  });
  // 窄窗：右栏收成抽屉，点「状态」才出来
  await s.check(async () => {
    await page.setViewportSize({ width: 960, height: 800 });
    await openFull(pid, { surface: app.id });
    expect((await page.getByTestId('fv-states').count()) === 0 && (await page.getByTestId('fv-show-states').count()) === 1, '窄窗下右栏应收起、工具栏有「状态」');
    await page.getByTestId('fv-show-states').click();
    await page.getByTestId('fv-states').waitFor({ timeout: 3000 });
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  s.done();
  return '空端提示；画布选中的屏带过去；地址里的屏已删落第一屏并提示；移分组不建修订、21 字 400、未分组在最后；正看的屏被删跳同一节下一屏；桌面端缩放不裁切；窄窗右栏收成抽屉';
});

// ---------- TC-CORE-174 点着走与叠层 ----------
await step('TC-CORE-174', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('点着走');
  const sheet = await writeScreen(pid, { name: '新建笔记', route: '/new', html: SHEET, presentation: 'overlay', group: '主页' });
  await patch(`/v1/screens/${ids.home}`, {});
  // 死链：不跳，问要不要生成
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: ids.home });
    const f = await deviceFrame();
    await clickInDevice(f.locator('a[href="/about"]'));
    await sleep(600);
    expect(param('screen') === ids.home, '死链不该跳');
    await eventually(async () => expect((await page.getByText('/about').count()) >= 1, '应提示可以生成 /about'), 5000, 100);
    await page.keyboard.press('Escape');
  });
  // 叠层屏：底下先垫这一端第一张整屏
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: sheet });
    const f = await deviceFrame(page, '首页');
    await eventually(async () => expect((await f.locator('h1').filter({ hasText: '随手记' }).count()) === 1 && (await f.getByText('新建笔记').count()) >= 1, '叠层应垫着首页'), 8000, 200);
  });
  s.done();
  return '死链不跳并提示可生成；叠层屏垫这一端第一张整屏';
});

// ---------- TC-CORE-175 在全屏视图里改 ----------
await step('TC-CORE-175', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('全屏里改');
  // 这一屏正在改：发送被挡，写原因
  await s.check(async () => {
    const hold = await busyJob(pid, ids.home);
    await openFull(pid, { surface: app.id, screen: ids.home });
    await deviceFrame();
    await eventually(async () => expect((await page.getByTestId('send-blocked-reason').innerText().catch(() => '')).includes('首页'), '应写「首页」正在改'), 8000, 200);
    await cancel(hold.body.job.id);
    await waitJob(hold.body.job.id, 60);
  });
  // 去掉目标标签再发：在这一端造新屏
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: ids.settings });
    await deviceFrame();
    await page.getByTestId('clear-targets').click();
    const j = await sendFromComposer('再做一个个人主页');
    const job = await waitJob(j, 120);
    const made = (job.output?.screenIds as string[] | undefined) ?? [];
    expect(job.kind === 'generate' && job.input.surfaceId === app.id && job.status === 'succeeded' && made.length === 1 && (await detail(pid)).screens.find((x) => x.id === made[0])?.surfaceId === app.id, `去掉目标应在这一端造新屏：${job.kind} ${job.input.surfaceId} ${job.status}`);
  });
  // 点选之后这一屏出了新一版：提示重新点选
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: ids.search });
    let f = await deviceFrame();
    await page.getByTestId('fv-pick').click();
    await clickInDevice(f.locator('h1'));
    await page.getByTestId('draft-pick-chip').first().waitFor({ timeout: 5000 });
    await patchScreen(pid, ids.search, '搜索</h1>', '找笔记</h1>');
    await sleep(800);
    await page.getByTestId('composer-input').fill('标题换个颜色');
    await page.getByTestId('composer-send').click();
    await toastHas('重新点一下');
    expect((await page.getByTestId('draft-pick-chip').count()) === 0, '点选应被清掉');
    f = await deviceFrame();
    expect((await f.locator('h1').innerText()).includes('找笔记'), '设备台应是新一版');
  });
  s.done();
  return '正在改的屏发送被挡并点名；去掉目标在这一端造新屏；点选后出了新一版提示重新点选';
});

// ---------- TC-CORE-176 回画布与 ⌥F ----------
await step('TC-CORE-176', async () => {
  const { pid, app, ids } = await notesApp('回画布');
  // 画布镜头放在远处：详情在视野外
  await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify({ x: -20000, y: -20000, zoom: 1 })), [`quilt:view:${pid}`]).catch(() => {});
  await openCanvas(pid, app.id);
  await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify({ x: -20000, y: -20000, zoom: 1 })), [`quilt:view:${pid}`]);
  await openCanvas(pid, app.id);
  await page.keyboard.press('Alt+KeyF');
  await page.waitForURL(/\/view/, { timeout: 8000 });
  await pickDir(ids.settings);
  await deviceFrame();
  await page.keyboard.press('Alt+KeyF');
  await page.waitForURL((u) => !u.pathname.endsWith('/view'), { timeout: 8000 });
  const cardSel = '[data-testid="screen-card"][data-route="/settings"]';
  await eventually(async () => {
    const b = await page.locator(cardSel).boundingBox();
    expect(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1440 && b.y + b.height <= 900, `设置应在视野里：${JSON.stringify(b)}`);
  }, 8000, 200);
  expect((await page.locator(`${cardSel}.selected`).count()) === 1, '设置应被选中');
  return '⌥F 进出全屏；回画布镜头摆到视野外的设置并选中';
});

// ---------- TC-CORE-177 FLOW-STATES 走查 ----------
await step('TC-CORE-177', async () => {
  const { pid, app, ids } = await notesApp('随手记 · 状态');
  const wp = await walkContext();
  const cam = shooter('FLOW-STATES', () => wp);
  await openFull(pid, { surface: app.id, screen: ids.home }, wp);
  await deviceFrame(wp);
  // S1 右栏点「让模型建议」
  await cam.snap('FLOW-STATES/S1', 'tap', '[data-testid="states-propose"]');
  await wp.getByTestId('states-propose').click();
  // S3 勾选建议（去掉 Account），改名后保存
  await wp.getByTestId('states-proposal').waitFor({ timeout: 30000 });
  await wp.getByTestId('states-proposal').locator('label').filter({ hasText: 'Account' }).locator('input').uncheck();
  await wp.getByTestId('states-proposal-take').click();
  await wp.getByTestId('states-editor').waitFor();
  await wp.getByTestId('editor-dim').first().getByRole('textbox', { name: '取值 3' }).fill('弱网');
  await cam.snap('FLOW-STATES/S3', 'tap', '[data-testid="states-save"]');
  await wp.getByTestId('states-save').click();
  await eventually(async () => expect((await detail(pid)).surfaces[0].states.dims.length === 1, '维度没存上'), 8000, 200);
  const surf = (await detail(pid)).surfaces[0];
  expect(surf.states.dims[0].key === 'network' && surf.states.dims[0].values.map((v) => v.name).join() === 'Online,Offline,弱网' && surf.states.events[0]?.key === 'saved-toast', `键从建议名转出、取值改了名：${JSON.stringify(surf.states)}`);
  // S4 右栏写 4 屏还没写，给「补上 4 屏」
  await eventually(async () => expect((await wp.getByTestId('state-unwritten').innerText()).includes('4'), 'S4 应写 4 屏还没写'), 8000, 200);
  await cam.snap('FLOW-STATES/S4', 'tap', '[data-testid="state-fill"]');
  // S5 确认调用次数，后台按维度改这几屏
  await wp.getByTestId('state-fill').click();
  await cam.snap('FLOW-STATES/S5', 'tap', '[data-testid="state-fill-yes"]');
  const resp = wp.waitForResponse((r) => /\/v1\/projects\/[^/]+\/jobs$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 10000 });
  await wp.getByTestId('state-fill-yes').click();
  const fillJob = ((await (await resp).json()) as { job: { id: string } }).job.id;
  const fj = await waitJob(fillJob, 120);
  expect(fj.status === 'succeeded' && (fj.input.screenIds as string[]).length === 4, `S5 补写作业：${fj.status} ${(fj.input.screenIds as string[])?.length}`);
  await eventually(async () => expect((await wp.getByTestId('state-unwritten').count()) === 0, 'S5 补完后「没写」应消失'), 15000, 300);
  // S6 切到 Offline；S7 页面按新取值显示、不建修订
  const rev = (await revisions(ids.home)).length;
  await cam.snap('FLOW-STATES/S6', 'tap', '[data-testid="state-value"][data-key="offline"]');
  await wp.locator('[data-testid="state-value"][data-key="offline"]').click();
  let f = await deviceFrame(wp);
  await eventually(async () => expect(await f.locator('[data-when="network:offline"]').isVisible(), 'S7 Offline 那段应显示'), 5000, 100);
  expect(param('state', wp) === 'network:offline' && (await revisions(ids.home)).length === rev, `S7 取值记在地址、不建修订：${param('state', wp)}`);
  await cam.snap('FLOW-STATES/S7', 'look', '[data-testid="device-stage"] .draft-frame');
  // S8 点事件，页面播一次就回原样（补写那一轮整屏重写过，事件的那段这时再埋进去）
  await patchScreen(pid, ids.home, 'Primary action</button>', 'Primary action</button><p data-when="@saved-toast" class="rounded-md bg-inverse-surface text-inverse-on-surface px-4 py-2 text-sm">已保存</p>');
  await eventually(async () => expect((await f.locator('[data-when="@saved-toast"]').count()) === 1, 'S8 设备台应换上埋了事件的新版'), 8000, 200);
  await wp.getByTestId('state-event').first().click();
  f = await deviceFrame(wp);
  await eventually(async () => expect(await f.getByText('已保存').isVisible(), 'S8 事件播放时应出现「已保存」'), 3000, 50);
  await cam.snap('FLOW-STATES/S8', 'look', '[data-testid="state-event"]');
  await eventually(async () => expect(!(await f.getByText('已保存').isVisible()), 'S8 播完应收起'), 4000, 100);
  // S9 点「给这一页加状态」，输入框里写上开头
  await wp.getByTestId('states-add-page').click();
  await eventually(async () => expect((await wp.getByTestId('composer-input').inputValue()).startsWith('给这一页加一个状态'), 'S9 输入框应写上开头'), 3000, 100);
  await cam.snap('FLOW-STATES/S9', 'look', '[data-testid="composer-input"]');
  await cam.save();
  return `8 张截图与热点在 ${path.relative(path.resolve(EVIDENCE, '../..'), cam.out)}/`;
});

// ---------- TC-CORE-178 保存维度 ----------
await step('TC-CORE-178', async () => {
  const s = softly();
  const { pid, first } = await newProject('维度保存');
  const dims = (n: number, values = 2) => Array.from({ length: n }, (_, i) => ({ name: `维度 ${i + 1}`, values: Array.from({ length: values }, (_, k) => ({ name: `取值 ${k + 1}` })) }));
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { states: { dims: dims(1, 9), events: [] }, expectedVersion: first.version }); expect(r.status === 400, `9 个取值应 400：${r.status}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { states: { dims: dims(1, 1), events: [] }, expectedVersion: first.version }); expect(r.status === 400, `1 个取值应 400：${r.status}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { states: { dims: dims(9), events: [] }, expectedVersion: first.version }); expect(r.status === 400, `维度超上限应 400：${r.status}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { states: { dims: [], events: Array.from({ length: 9 }, (_, i) => ({ name: `事件 ${i}` })) }, expectedVersion: first.version }); expect(r.status === 400, `事件超上限应 400：${r.status}`); });
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { states: { dims: [], events: [{ name: '提示', ms: 99999 }] }, expectedVersion: first.version }); expect(r.status === 400, `事件时长越界应 400：${r.status}`); });
  const ok = await patch<{ surface: Surface }>(`/v1/surfaces/${first.id}`, { states: { dims: [{ name: 'Network', values: [{ name: 'Online' }, { name: 'Offline' }] }, { name: 'Plan', values: [{ name: 'Free' }, { name: 'Pro' }], default: 1 }], events: [{ name: 'Saved', ms: 1500 }] }, expectedVersion: first.version });
  await s.check(() => expect(ok.status === 200 && ok.body.surface.states.dims[0].key === 'network' && ok.body.surface.states.dims[1].default === 'pro' && ok.body.surface.version === first.version + 1, `存维度：${ok.status} ${JSON.stringify(ok.body).slice(0, 200)}`));
  const v = ok.body.surface;
  await s.check(async () => { const r = await patch<Problem>(`/v1/surfaces/${first.id}`, { name: 'X', expectedVersion: first.version }); expect(r.status === 409 && r.body.type === '/errors/version-conflict', `旧版本号应 409：${r.status}`); });
  // 改名只改显示名：键不变；删掉 Plan → 留着标 retired
  const renamed = await patch<{ surface: Surface }>(`/v1/surfaces/${first.id}`, { states: { dims: [{ key: 'network', name: '网络', values: [{ key: 'online', name: '在线' }, { key: 'offline', name: '离线' }] }], events: v.states.events }, expectedVersion: v.version });
  await s.check(() => {
    const d = renamed.body.surface.states.dims;
    expect(renamed.status === 200 && d.find((x) => x.key === 'network')?.name === '网络' && d.find((x) => x.key === 'network')?.values[1].key === 'offline', `改名后键不变：${JSON.stringify(d)}`);
    expect(d.find((x) => x.key === 'plan')?.retired === true, `删掉的维度应标 retired 留着：${JSON.stringify(d)}`);
  });
  // 界面：删掉的维度不在右栏
  await s.check(async () => {
    await writeScreen(pid, { name: '首页', route: '/home', html: HOME() });
    await openFull(pid, { surface: first.id });
    await page.locator('[data-testid="state-dim"][data-key="network"]').waitFor({ timeout: 8000 });
    expect((await page.locator('[data-testid="state-dim"][data-key="plan"]').count()) === 0, '删掉的 Plan 不该在右栏');
  });
  // 这一端在别处被删：保存 404
  await s.check(async () => {
    const other = await addSurface(pid, 'Tmp', 'mobile');
    await del(`/v1/surfaces/${other.id}`);
    const r = await patch<Problem>(`/v1/surfaces/${other.id}`, { states: { dims: [], events: [] }, expectedVersion: other.version });
    expect(r.status === 404, `已删的端保存应 404：${r.status}`);
  });
  s.done();
  return '取值、维度、事件、时长越界 400；存维度键从名字转出、缺省按序号、版本 +1；旧版本 409；改名键不变；删掉的维度标 retired 不在右栏；已删的端 404';
});

// ---------- TC-CORE-179 按取值显示 ----------
await step('TC-CORE-179', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('按取值显示');
  await patch(`/v1/surfaces/${app.id}`, { states: { dims: [{ name: 'Network', values: [{ name: 'Online' }, { name: 'Offline' }] }], events: [{ name: 'Synced', ms: 1000 }] }, expectedVersion: app.version });
  // 首页写了 Offline，设置没写
  await patchScreen(pid, ids.home, '关于随手记</a>', '关于随手记</a><p data-when="network:offline" class="text-sm text-error">离线中，改动会在联网后同步</p>');
  const html = async (id: string) => { const cur = (await detail(pid)).screens.find((x) => x.id === id)!.currentRevisionId; return (await fetch((await revisions(id)).find((r) => r.id === cur)!.htmlUrl)).text(); };
  const homeHtml = await html(ids.home);
  const revs = (await revisions(ids.home)).length;
  await openFull(pid, { surface: app.id, screen: ids.home });
  let f = await deviceFrame();
  await s.check(async () => expect(!(await f.getByText('离线中').isVisible()), '缺省 Online 时不显示离线提示'));
  await page.locator('[data-testid="state-value"][data-key="offline"]').click();
  await s.check(async () => { await eventually(async () => expect(await f.getByText('离线中').isVisible(), '切到 Offline 应显示'), 5000, 100); });
  await s.check(async () => expect((await revisions(ids.home)).length === revs && (await html(ids.home)) === homeHtml, '切取值不改内容、不建修订'));
  // 换到设置：端上取值保留，设置没写 Offline → 右栏标没写
  await pickDir(ids.settings);
  await s.check(async () => {
    await eventually(async () => expect(param('screen') === ids.settings && param('state') === 'network:offline' && (await page.getByTestId('fv-screen-name').innerText()).startsWith('设置'), `换屏端上取值保留：${page.url()}`), 5000, 100);
    f = await deviceFrame();
    await eventually(async () => expect((await page.locator('[data-testid="state-value"][data-key="offline"]').getAttribute('data-missing')) === '', '设置没写 Offline，右栏应标没写'), 5000, 100);
    expect((await f.evaluate(() => document.documentElement.getAttribute('data-s-network'))) === 'offline', '页面上取值仍是 offline');
  });
  // 刷新：地址还原取值；重置回缺省
  await s.check(async () => {
    await page.goto(`${WEB}/p/${pid}/view?surface=${app.id}&screen=${ids.home}&state=network:offline`);
    f = await deviceFrame();
    await eventually(async () => expect(await f.getByText('离线中').isVisible(), '刷新后应还原 Offline'), 5000, 100);
    await page.getByTestId('states-reset').click();
    await eventually(async () => expect(!(await f.getByText('离线中').isVisible()) && param('state') === null, '重置回缺省'), 5000, 100);
  });
  // 事件：这一屏没写也照常可点，页面不变；播放中再点从头再播
  await s.check(async () => {
    const before = await f.evaluate(() => document.body.innerHTML.length);
    await page.getByTestId('state-event').click();
    await sleep(200);
    await page.getByTestId('state-event').click();
    await sleep(300);
    expect((await f.evaluate(() => document.body.innerHTML.length)) === before, '没写的事件页面不变');
  });
  // 画布卡片按缺省显示
  await s.check(async () => {
    await page.getByTestId('view-canvas').click();
    await page.waitForURL((u) => !u.pathname.endsWith('/view'), { timeout: 8000 });
    // 卡片平时是截图；双击进交互态才是活 iframe，它收不到父页的取值，按缺省显示
    await page.locator('[data-testid="screen-card"][data-route="/home"] .gesture').dblclick();
    await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 30000 });
    const cf = page.frameLocator('[data-testid="screen-card"][data-route="/home"] iframe').first();
    await cf.locator('h1').waitFor({ timeout: 15000 });
    expect(!(await cf.getByText('离线中').isVisible()) && (await cf.locator('html').getAttribute('data-s-network')) === 'online', '画布卡片按缺省显示');
    await page.keyboard.press('Escape');
  });
  s.done();
  return '缺省不显示、切 Offline 显示，不改内容不建修订；换屏端上取值保留、没写的取值标出；地址还原、重置；没写的事件页面不变；画布卡片按缺省';
});

// ---------- TC-CORE-180 补上 N 屏 ----------
await step('TC-CORE-180', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('补上几屏');
  await patch(`/v1/surfaces/${app.id}`, { states: { dims: [{ name: 'Network', values: [{ name: 'Online' }, { name: 'Offline' }, { name: 'Weak' }] }], events: [] }, expectedVersion: app.version });
  const hold = await busyJob(pid, ids.settings);
  await eventually(async () => expect((await apiJson<{ job: JobView }>(`/v1/jobs/${hold.body.job.id}`)).body.job.status === 'running', '占位作业没跑起来'), 10000, 200);
  await openFull(pid, { surface: app.id, screen: ids.home });
  await deviceFrame();
  await s.check(async () => {
    await eventually(async () => expect((await page.getByTestId('state-unwritten').innerText()).includes('4 屏'), '应写 4 屏还没写'), 8000, 200);
    expect((await page.getByTestId('state-fill').innerText()).includes('3'), `正在改的设置不放进这一轮：${await page.getByTestId('state-fill').innerText()}`);
    expect((await page.getByTestId('state-unwritten').innerText()).includes('设置'), '按钮旁点名设置');
  });
  await page.getByTestId('state-fill').click();
  const resp = page.waitForResponse((r) => /\/v1\/projects\/[^/]+\/jobs$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 10000 });
  await page.getByTestId('state-fill-yes').click();
  const jid = ((await (await resp).json()) as { job: { id: string } }).job.id;
  const job = await waitJob(jid, 120);
  await s.check(() => expect(job.status === 'succeeded' && (job.input.screenIds as string[]).length === 3 && !(job.input.screenIds as string[]).includes(ids.settings), `补写 3 屏：${job.status} ${JSON.stringify(job.input.screenIds)}`));
  await s.check(async () => { const d = await detail(pid); const home = d.screens.find((x) => x.id === ids.home)!; expect(JSON.stringify(home.states?.uses?.network?.sort()) === JSON.stringify(['offline', 'weak']), `首页写上 offline 与 weak：${JSON.stringify(home.states)}`); });
  await cancel(hold.body.job.id);
  await waitJob(hold.body.job.id, 60);
  await s.check(async () => { await eventually(async () => expect((await page.getByTestId('state-unwritten').innerText()).includes('1 屏'), '只剩设置没写'), 10000, 300); });
  s.done();
  return '正在改的屏不放进这一轮并点名；补写 3 屏后各屏写上非缺省取值、只剩 1 屏没写';
});

// ---------- TC-CORE-181 页内状态 ----------
await step('TC-CORE-181', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('页内状态');
  await patch(`/v1/surfaces/${app.id}`, { states: { dims: [{ name: 'Network', values: [{ name: 'Online' }, { name: 'Offline' }] }], events: [] }, expectedVersion: app.version });
  const decl = (dims: unknown[]) => `<script type="application/json" data-quilt-states>${JSON.stringify({ dims, events: [] })}</script>`;
  const listDim = { key: 'list', name: '列表', values: [{ key: 'full', name: '有内容' }, { key: 'empty', name: '空' }], default: 'full' };
  const netDim = { key: 'network', name: '网络', values: [{ key: 'online', name: '在线' }, { key: 'offline', name: '离线' }], default: 'online' };
  await patchScreen(pid, ids.home, '<header', `${decl([listDim])}<p data-when="list:empty" class="p-5 text-on-surface-variant">还没有笔记</p><header`);
  await openFull(pid, { surface: app.id, screen: ids.home });
  let f = await deviceFrame();
  await s.check(async () => {
    await page.locator('[data-testid="state-dim"][data-key="list"]').waitFor({ timeout: 8000 });
    await page.locator('[data-testid="state-dim"][data-key="list"] [data-key="empty"]').click();
    await eventually(async () => expect(await f.getByText('还没有笔记').isVisible(), '切到「空」应显示'), 5000, 100);
  });
  // 换屏：页内状态回缺省，地址里不留 list
  await s.check(async () => {
    await pickDir(ids.note);
    await eventually(async () => expect(param('screen') === ids.note && !(param('state') ?? '').includes('list'), `换屏页内状态回缺省：${page.url()}`), 5000, 100);
  });
  // 与端上维度同名：页内那个不生效，偏离报告记一条
  const v2 = await patchScreen(pid, ids.home, JSON.stringify({ dims: [listDim], events: [] }), JSON.stringify({ dims: [listDim, netDim], events: [] }));
  await s.check(() => expect(/network/.test(v2), `同名页内状态应在偏离报告里点名：${v2.slice(0, 300)}`));
  await s.check(async () => {
    await pickDir(ids.home);
    f = await deviceFrame();
    await eventually(async () => expect((await page.getByText('「network」').count()) >= 1 || (await page.getByText('network').count()) >= 1, '右栏应写同名的那个不生效'), 8000, 200);
    expect((await page.locator('[data-testid="state-dim"][data-key="network"]').count()) === 1, '网络只出现一次（端上的）');
  });
  // 回到旧版：页内状态跟着回
  await s.check(async () => {
    const revs = await revisions(ids.home);
    const old = revs.find((r) => r.seq === 1)!;
    const r = await post(`/v1/screens/${ids.home}/revisions/${old.id}/restore`, { expectedRevisionId: (await detail(pid)).screens.find((x) => x.id === ids.home)!.currentRevisionId });
    expect(r.status === 200 || r.status === 201, `回到第 1 版 ${r.status}`);
    await eventually(async () => expect(((await detail(pid)).screens.find((x) => x.id === ids.home)!.states?.dims ?? []).length === 0, '第 1 版没有页内状态'), 8000, 200);
    await eventually(async () => expect((await page.locator('[data-testid="state-dim"][data-key="list"]').count()) === 0, '右栏「这一页」应空'), 8000, 200);
  });
  s.done();
  return '页内状态列在右栏、切换生效；换屏回缺省；与端上同名的不生效、偏离报告点名；回到旧版页内状态跟着回';
});

// ---------- 草稿本助手 ----------
const sketchbook = async () => (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId;
async function newDraft(sb: string, content: string, frame?: string): Promise<string> {
  const r = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content, frame, runner: STUB });
  expect(r.status === 202, `出草稿 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await waitJob(r.body.job.id, 120);
  const id = (job.output?.screenIds as string[] | undefined)?.[0];
  expect(job.status === 'succeeded' && id, `草稿作业 ${job.status}`);
  return id!;
}
const openSketch = async (d?: string, pg: Page = page) => { await pg.goto(`${WEB}/sketch${d ? `?d=${d}` : ''}`); await pg.getByTestId('sketch-page').waitFor({ timeout: 15000 }); };
const railItem = (id: string, pg: Page = page) => pg.locator(`[data-testid="rail-item"][data-draft-id="${id}"]`);
/** 清空草稿本：搬进项目的用例各自从空草稿本起 */
async function clearSketchbook() { const sb = await sketchbook(); for (const s of (await detail(sb)).screens) await del(`/v1/screens/${s.id}`); return sb; }

// ---------- TC-CORE-182 FLOW-SKETCH-MOVE 走查 ----------
await step('TC-CORE-182', async () => {
  const { pid, admin } = await notesApp('随手记 · 搬进', { admin: true });
  const sb = await clearSketchbook();
  const dPage = await newDraft(sb, '一个登录页\n[stub-frame:desktop]', 'desktop');
  const dComp = await newDraft(sb, '一个统计卡片', 'component');
  await newDraft(sb, '一个设置页', 'mobile');
  const wp = await walkContext();
  const cam = shooter('FLOW-SKETCH-MOVE', () => wp);
  await openSketch(undefined, wp);
  await railItem(dPage, wp).waitFor({ timeout: 10000 });
  // S1 记录栏点「选择」，勾两张
  await wp.getByTestId('rail-select').click();
  await railItem(dPage, wp).click();
  await railItem(dComp, wp).click();
  expect((await railItem(dPage, wp).getAttribute('aria-checked')) === 'true' && (await railItem(dComp, wp).getAttribute('aria-checked')) === 'true', 'S1 两张应勾上');
  await cam.snap('FLOW-SKETCH-MOVE/S1', 'look', `[data-testid="rail-item"][data-draft-id="${dComp}"]`);
  // S2 点「搬进项目…（2）」
  expect((await wp.getByTestId('rail-move').innerText()).includes('2'), 'S2 按钮应写 2');
  await cam.snap('FLOW-SKETCH-MOVE/S2', 'tap', '[data-testid="rail-move"]');
  await wp.getByTestId('rail-move').click();
  // S3 选项目、端与分组
  await wp.getByTestId('move-dialog').waitFor();
  await pickOption(wp, '[data-testid="move-project"]', '随手记 · 搬进');
  await pickOption(wp, '[data-testid="move-surface"]', '后台');
  await pickOption(wp, '[data-testid="move-group"]', '新建分组');
  await wp.getByTestId('move-new-group').fill('账户');
  await cam.snap('FLOW-SKETCH-MOVE/S3', 'look', '[data-testid="move-group"]');
  // S4 逐张列出屏还是组件
  const kinds = await wp.getByTestId('move-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  expect(kinds.includes('screen') && kinds.includes('component'), `S4 应一张屏一张组件：${kinds}`);
  await cam.snap('FLOW-SKETCH-MOVE/S4', 'look', '[data-testid="move-list"]');
  // S5 确认
  await cam.snap('FLOW-SKETCH-MOVE/S5', 'tap', '[data-testid="move-submit"]');
  await wp.getByTestId('move-submit').click();
  // S7 这两张从记录栏消失、勾选清掉
  await eventually(async () => expect((await railItem(dPage, wp).count()) === 0 && (await railItem(dComp, wp).count()) === 0 && (await wp.getByTestId('rail-move').count()) === 0, 'S7 两张应从记录栏消失、勾选清掉'), 10000, 200);
  await cam.snap('FLOW-SKETCH-MOVE/S7', 'look', '[data-testid="sketch-rail"]');
  const d = await detail(pid);
  const moved = d.screens.find((x) => x.surfaceId === admin!.id && x.group === '账户');
  expect(moved && d.components.length === 1, `S6 屏落在后台的「账户」、组件 1 个：${JSON.stringify(d.screens.map((x) => [x.name, x.group]))}`);
  // S8 提示条带「去看看」，点开全屏视图
  const go = wp.getByRole('button', { name: '去看看' });
  await go.waitFor({ timeout: 5000 });
  await cam.snap('FLOW-SKETCH-MOVE/S8', 'tap', 'role=button[name="去看看"]');
  await go.click();
  await wp.waitForURL(/\/p\/[^/]+\/view/, { timeout: 8000 });
  expect(param('screen', wp) === moved!.id && param('surface', wp) === admin!.id, `去看看应打开搬来的屏：${wp.url()}`);
  await cam.save();
  return `7 张截图与热点在 ${path.relative(path.resolve(EVIDENCE, '../..'), cam.out)}/`;
});

// ---------- TC-CORE-183 搬进项目的接口 ----------
await step('TC-CORE-183', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('搬进接口');
  const sb = await clearSketchbook();
  const p1 = await newDraft(sb, 'Home\n[stub-frame:mobile]', 'mobile');
  await say(sb, '改一下', { targetScreenIds: [p1] });
  const c1 = await newDraft(sb, 'Bar', 'component');
  const cScript = await newDraft(sb, '带脚本\n[stub-script]', 'component');
  const body = (draftIds: string[], extra: Record<string, unknown> = {}) => ({ draftIds, projectId: pid, surfaceId: app.id, restyle: false, ...extra });
  await s.check(async () => { const r = await post<Problem>('/v1/sketchbook/drafts/move', body([p1, p1])); expect(r.status === 400, `重复的草稿应 400：${r.status}`); });
  await s.check(async () => { const r = await post<Problem>('/v1/sketchbook/drafts/move', body(Array.from({ length: 21 }, () => FAKE))); expect(r.status === 400, `超过 20 张应 400：${r.status}`); });
  await s.check(async () => { const r = await post<Problem>('/v1/sketchbook/drafts/move', body([p1, cScript])); expect(r.status === 400 && JSON.stringify(r.body).includes('draftIds.1'), `带脚本的组件草稿应 400 并点名：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); expect((await detail(sb)).screens.some((x) => x.id === p1), '400 时一张都不搬'); });
  // 有一张正在改：409，一张都不搬（INV-CORE-012）
  await s.check(async () => {
    const hold = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '占住\n[stub-hold:20000]', targetScreenIds: [c1], runner: STUB });
    await eventually(async () => expect((await apiJson<{ job: JobView }>(`/v1/jobs/${hold.body.job.id}`)).body.job.status === 'running', '占位作业没跑起来'), 10000, 200);
    const r = await post<Problem>('/v1/sketchbook/drafts/move', body([p1, c1]));
    expect(r.status === 409 && r.body.type === '/errors/screen-busy', `有一张在改应 409：${r.status} ${r.body.type}`);
    const left = (await detail(sb)).screens.map((x) => x.id);
    expect(left.includes(p1) && left.includes(c1) && (await detail(pid)).screens.length === 4, '409 时一张都不动');
    await cancel(hold.body.job.id);
    await waitJob(hold.body.job.id, 60);
  });
  // 路由与组件名去重；只带当前这一版
  await writeScreen(pid, { name: 'Home', route: '/home-2', html: HOME() });
  await post(`/v1/projects/${pid}/components`, { name: 'Bar', html: '<nav class="h-12 bg-surface"></nav>' });
  const mv = await post<{ screens: Screen[]; components: { id: string; name: string }[] }>('/v1/sketchbook/drafts/move', body([p1, c1]), { 'Idempotency-Key': `mv-${Date.now()}` });
  await s.check(() => expect(mv.status === 201, `搬进项目 ${mv.status} ${JSON.stringify(mv.body).slice(0, 200)}`));
  await s.check(() => { const r = mv.body.screens?.[0]?.route; expect(r && r !== '/home' && r !== '/home-2' && /^\/home-\d+$/.test(r), `路由应加序号去重：${r}`); });
  await s.check(() => expect(mv.body.components?.[0]?.name === 'Bar 2', `组件名应加序号去重：${mv.body.components?.[0]?.name}`));
  await s.check(async () => expect((await revisions(mv.body.screens[0].id)).length === 1, '只带当前这一版'));
  await s.check(async () => { const d = await detail(pid); expect(d.screens.find((x) => x.id === mv.body.screens[0].id)?.surfaceId === app.id && (d.screens.find((x) => x.id === mv.body.screens[0].id)?.group ?? null) === null, '分组留空归未分组、落在 App'); });
  await s.check(async () => { const left = (await detail(sb)).screens.map((x) => x.id); expect(!left.includes(p1) && !left.includes(c1), '草稿本里不再有'); });
  await s.check(async () => { const r = await post<Problem>('/v1/sketchbook/drafts/move', body([p1])); expect(r.status === 404, `再搬应 404：${r.status}`); });
  // 改写：没参照目标项目时按目标项目改写，建一个改写作业
  await s.check(async () => {
    const p2 = await newDraft(sb, 'Another\n[stub-frame:mobile]', 'mobile');
    const r = await post<{ screens: Screen[]; jobs: { id: string }[] }>('/v1/sketchbook/drafts/move', body([p2], { restyle: true, runner: STUB }));
    expect(r.status === 201 && r.body.jobs?.length === 1, `改写应建作业：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const j = await waitJob(r.body.jobs[0].id, 120);
    expect(j.status === 'succeeded' && (j.input.screenIds as string[]).includes(r.body.screens[0].id), `改写作业：${j.status}`);
  });
  s.done();
  return '重复 400、超 20 张 400、带脚本的组件 400 一张不搬；有一张在改 409 一张不动；路由与组件名加序号；只带当前这一版；未分组；草稿本不再有；再搬 404；改写建作业';
});

// ---------- TC-CORE-184 搬进项目弹层 ----------
await step('TC-CORE-184', async () => {
  const s = softly();
  const { pid } = await notesApp('弹层缺省');
  await newProject('后建的项目');
  const sb = await clearSketchbook();
  // 从项目拿来的一张（refProjectId = 随手记，有目标屏）、一张桌面草稿（与手机端不符）、一张带脚本的组件
  const home = (await detail(pid)).screens.find((x) => x.route === '/home')!;
  const fork = await post<{ screen: { id: string } }>('/v1/sketchbook/drafts', { fromScreenId: home.id });
  expect(fork.status === 201, `从屏建草稿 ${fork.status}`);
  const forkId = fork.body.screen.id;
  await say(sb, '再改一版', { targetScreenIds: [forkId] });
  const desk = await newDraft(sb, '桌面页\n[stub-frame:desktop]', 'desktop');
  const script = await newDraft(sb, '带脚本\n[stub-script]', 'component');
  await openSketch();
  await page.getByTestId('rail-select').click();
  // 只勾参照随手记的那张：项目缺省选它；三张参照不一（另两张没参照）时改回上次打开的项目
  await railItem(forkId).click();
  await page.getByTestId('rail-move').click();
  await page.getByTestId('move-dialog').waitFor();
  await s.check(async () => { await eventually(async () => expect((await page.getByTestId('move-project').innerText()).includes('弹层缺省'), `勾的都参照同一个项目时缺省选它：${await page.getByTestId('move-project').innerText()}`), 5000, 100); });
  await page.keyboard.press('Escape');
  await page.getByTestId('move-dialog').waitFor({ state: 'detached' });
  for (const id of [desk, script]) await railItem(id).click();
  await page.getByTestId('rail-move').click();
  await page.getByTestId('move-dialog').waitFor();
  const order = [forkId, desk, script];
  const item = (id: string) => page.getByTestId('move-item').nth(order.indexOf(id));
  await s.check(async () => { const t = await item(forkId).innerText(); expect(t.includes('弹层缺省') && t.includes('写回项目'), `从项目拿来的应写明覆盖回原屏用写回：${t}`); });
  await s.check(async () => expect((await page.getByTestId('move-dialog').innerText()).includes('每张只带当前这一版'), '列表上方应写只带当前这一版'));
  await s.check(async () => { const t = await item(desk).innerText(); expect(t.includes('桌面') || t.includes('手机'), `画框与端不符应提示：${t}`); });
  await s.check(async () => { const c = page.getByTestId('move-restyle'); expect(await c.evaluate((el) => (el as HTMLInputElement).indeterminate || (el as HTMLInputElement).checked), '没参照目标项目的应缺省勾选改写'); });
  // 带脚本的组件：提交时被点名，删掉才能确认
  await s.check(async () => {
    await page.getByTestId('move-submit').click();
    await eventually(async () => expect((await item(script).getAttribute('data-flagged')) === 'true', '带脚本的那张应被标出'), 5000, 100);
    expect(await page.getByTestId('move-submit').isDisabled(), '有标出的一行时确认不可用');
    expect((await detail(sb)).screens.length === 3, '被挡时一张都不搬');
    await page.getByTestId('move-item-remove').click();
    expect(!(await page.getByTestId('move-submit').isDisabled()) && (await page.getByTestId('move-item').count()) === 2, '删掉后剩两张、可以确认');
  });
  await page.keyboard.press('Escape');
  s.done();
  return '勾的都参照同一个项目时缺省选它；从项目拿来的写明用写回、列表上方写只带当前这一版；画框不符提示；改写缺省勾选；带脚本的组件提交时标出、删掉才能确认';
});

// ---------- TC-CORE-185 勾选与另一个标签页 ----------
await step('TC-CORE-185', async () => {
  const s = softly();
  const { pid, app } = await notesApp('勾选上限');
  const sb = await clearSketchbook();
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push(await newDraft(sb, `卡片 ${i + 1}`, 'component'));
  await openSketch();
  await page.getByTestId('rail-select').click();
  for (const id of ids.slice(0, 20)) await railItem(id).click();
  await s.check(async () => {
    await railItem(ids[20]).click();
    expect((await railItem(ids[20]).getAttribute('aria-checked')) === 'false', '第 21 张勾不上');
    await toastHas('一次最多搬 20 张');
  });
  await page.getByTestId('rail-select-cancel').click();
  // 生成中的不能勾
  await s.check(async () => {
    const hold = await post<{ job: JobView }>(`/v1/projects/${sb}/messages`, { content: '占住\n[stub-hold:20000]', targetScreenIds: [ids[0]], runner: STUB });
    await eventually(async () => expect((await apiJson<{ job: JobView }>(`/v1/jobs/${hold.body.job.id}`)).body.job.status === 'running', '占位作业没跑起来'), 10000, 200);
    await openSketch();
    await page.getByTestId('rail-select').click();
    await eventually(async () => expect((await railItem(ids[0]).getAttribute('aria-disabled')) === 'true', '生成中的应不能勾'), 8000, 200);
    await railItem(ids[0]).click({ force: true });
    expect((await railItem(ids[0]).getAttribute('aria-checked')) === 'false', '点了也勾不上');
    await cancel(hold.body.job.id);
    await waitJob(hold.body.job.id, 60);
    await page.getByTestId('rail-select-cancel').click();
  });
  // 另一个标签页正打开着其中一张：看板清空并提示
  await s.check(async () => {
    const other = await ctx.newPage();
    cleanups.push(() => other.close());
    await openSketch(ids[1], other);
    await other.getByTestId('draft-view').waitFor({ timeout: 10000 });
    const r = await post('/v1/sketchbook/drafts/move', { draftIds: [ids[1]], projectId: pid, surfaceId: app.id, restyle: false });
    expect(r.status === 201, `搬 ${r.status}`);
    await toastHas('这张草稿已搬进项目', other, 10000);
    await eventually(async () => expect((await other.getByTestId('sketch-stage').getAttribute('data-state')) === 'empty', '另一个标签页的看板应清空'), 8000, 200);
  });
  s.done();
  return '勾到 20 张后再勾提示上限；生成中的不能勾；另一个标签页正打开着的那张被搬走后看板清空并提示';
});

// ---------- TC-CORE-186 屏目录把点得到的屏收成一条 ----------
await step('TC-CORE-186', async () => {
  const s = softly();
  const { pid, app, ids } = await notesApp('收成一条');
  const tags = await writeScreen(pid, { name: '标签', route: '/tags', html: LONE('标签'), group: '主页' });
  const trash = await writeScreen(pid, { name: '回收站', route: '/trash', html: LONE('回收站'), group: '我的' });
  const row = chainRow();
  // 收着：一条「首页 · 含 4 屏」，没串上的标签、回收站按分组单列；正看首页时那一条高亮
  await openFull(pid, { surface: app.id });
  await deviceFrame();
  await s.check(async () => {
    const text = await page.getByTestId('dir-chain-open').innerText();
    const single = await page.getByTestId('dir-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir-item')));
    expect(text.trim() === '首页' && (await row.count()) === 4 && !(await row.expanded()), `应收成一条、只写「首页」：${text}`);
    expect(JSON.stringify(await dirGroups()) === JSON.stringify(['主页', '我的']) && JSON.stringify(single) === JSON.stringify([tags, trash]), `分组里只单列标签、回收站：${JSON.stringify(single)}`);
    expect(param('screen') === ids.home && (await row.lit()), '打开首页时那一条应高亮');
  });
  // 正看的屏收在那一条里：那一条高亮；收着时 ↑ ↓ 把它算一项、对应首页
  await s.check(async () => {
    await openFull(pid, { surface: app.id, screen: ids.search });
    await deviceFrame();
    expect((await row.lit()) && (await page.locator('[data-testid="dir-item"][aria-current="page"]').count()) === 0, '正看搜索时应高亮那一条');
    await page.getByTestId('dir-chain-open').focus();
    await page.keyboard.press('ArrowDown');
    await eventually(async () => expect(param('screen') === tags, `收着时按 ↓ 应到标签：${param('screen')}`), 5000, 100);
    await deviceFrame();
    await page.keyboard.press('ArrowUp');
    await eventually(async () => expect(param('screen') === ids.home && (await row.lit()), `再按 ↑ 应回到那一条、打开首页：${param('screen')}`), 5000, 100);
  });
  // 点收着的那一条：打开入口屏
  await s.check(async () => {
    await pickDir(trash);
    await eventually(async () => expect(param('screen') === trash, '点回收站应打开它'), 5000, 100);
    await deviceFrame();
    await page.getByTestId('dir-chain-open').click();
    await eventually(async () => expect(param('screen') === ids.home, `点那一条应打开首页：${param('screen')}`), 5000, 100);
  });
  // 改了链接：回收站串上、再断开，目录跟着重排，那一条不自动展开
  await s.check(async () => {
    await deviceFrame();
    await patchScreen(pid, ids.home, '关于随手记</a>', '关于随手记</a><a href="/trash" class="block text-center text-sm py-2">回收站</a>');
    await eventually(async () => expect((await row.count()) === 5 && JSON.stringify(await dirGroups()) === JSON.stringify(['主页']), `串上回收站后应含 5 屏、「我的」一节消失：${await row.count()}`), 10000, 200);
    expect(!(await row.expanded()), '串上后不该自动展开');
    await patchScreen(pid, ids.home, 'href="/trash"', 'href="/about"');
    await eventually(async () => expect((await row.count()) === 4 && JSON.stringify(await dirGroups()) === JSON.stringify(['主页', '我的']), `断开后应回到 4 屏、「我的」一节回来：${await row.count()}`), 10000, 200);
  });
  // 展开：依次列首页与一步点到的详情、搜索、设置；收在里面的屏菜单里没有「移到分组」；刷新后又收着
  await s.check(async () => {
    await page.getByTestId('dir-chain-toggle').click();
    expect(await row.expanded(), '点展开键后 aria-expanded 应为 true');
    const listed = await page.locator('[data-testid="dir-chain"] [data-testid="dir-item"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir-item')));
    expect(JSON.stringify(listed) === JSON.stringify([ids.home, ids.note, ids.search, ids.settings]), `展开后应依次列首页、详情、搜索、设置：${JSON.stringify(listed)}`);
    // 展开着正看首页：那一条仍整行高亮，里面的首页名字换强调色、不铺底色
    const home = page.locator(`[data-testid="dir-chain"] [data-dir-item="${ids.home}"]`);
    const look = await home.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--semantic-color-action-link)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el.querySelector('span')!).color, accent };
    });
    expect((await row.lit()) && look.color === look.accent && /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg), `展开时那一条应高亮、首页名字用强调色且无底色：${JSON.stringify(look)}`);
    await page.locator('li', { has: page.locator(`[data-dir-item="${ids.settings}"]`) }).getByTestId('dir-more').click();
    await page.getByTestId('dir-rename').waitFor({ timeout: 3000 });
    expect((await page.getByTestId('dir-move').count()) === 0, '收在那一条里的屏菜单里不该有「移到分组」');
    await page.keyboard.press('Escape');
    await page.getByTestId('dir-rename').waitFor({ state: 'detached', timeout: 3000 }); // 菜单收起有退场动画，等它卸掉再开下一个
    await page.locator('li', { has: page.locator(`[data-dir-item="${tags}"]`) }).getByTestId('dir-more').click();
    await page.getByTestId('dir-rename').waitFor({ timeout: 3000 });
    expect((await page.getByTestId('dir-move').count()) === 1, '分组里的屏菜单里应有「移到分组」');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByTestId('fv-toolbar').waitFor({ timeout: 15000 });
    await eventually(async () => expect(!(await row.expanded()), '刷新后那一条应收着'), 5000, 100);
  });
  // 入口屏链不到别的屏：不收成一条，照常按分组列
  await s.check(async () => {
    const lone = await newProject('散屏');
    await writeScreen(lone.pid, { name: '甲', route: '/a', html: LONE('甲'), group: '一' });
    await writeScreen(lone.pid, { name: '乙', route: '/b', html: LONE('乙'), group: '二' });
    await openFull(lone.pid, { surface: lone.first.id });
    await deviceFrame();
    expect((await page.getByTestId('dir-chain').count()) === 0 && JSON.stringify(await dirGroups()) === JSON.stringify(['一', '二']), `入口屏链不到别的屏时不该收成一条：${JSON.stringify(await dirGroups())}`);
  });
  s.done();
  return '点得到的 4 屏收成一条、没串上的按分组单列；正看的屏在里面时那一条高亮；收着时 ↑ ↓ 算一项；点那一条开首页；串上、断开跟着重排不自动展开；展开按步数列、里面的屏菜单没有移到分组；刷新后收着；入口屏链不到别的屏时不收';
});

// ---------- 收尾 ----------
for (const id of projects) await del(`/v1/projects/${id}`).catch(() => {});
await clearSketchbook().catch(() => {});
await mcp.close();
await browser.close();
const counts = summary();
process.exit(counts['失败'] ? 1 : 0);
