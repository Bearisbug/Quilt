// docs/TEST.md CORE 域 · 后端、截图与测试基础设施（TC-CORE-070 起，v0.82）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import { stat, readdir, utimes } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { seedJson, apiJson, ROOT, WEB, API, eventually, localFetch } from '../lib.ts';
import { connectMcp, callTool } from '../mcp-client.ts';
import { expect, softly, waitJob } from '../harness.ts';
import { page, step, shot, blankSpot, STUB_RUNNER, uploadPng, idemKey, sleep079 } from './shared.ts';

// ---------- v0.82 后端、截图与测试基础设施 ----------
type Scr082 = { id: string; name: string; route: string; x: number; y: number; variantOf: string | null; variantName: string | null; currentRevisionId: string | null; previewUrl: string | null };
const detail082 = async (pid: string) => (await apiJson<{ screens: Scr082[] }>(`/v1/projects/${pid}`)).body;

// TC-CORE-070 从 127.0.0.1 打开画布（§15 预览域）：frame-ancestors 列出来源名单展开出的全部 origin，/p/ 的 ACAO 回显名单内的请求 Origin
await step('TC-CORE-070', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Loopback', '--device', 'mobile', '--screens', '3');
  const port = new URL(WEB).port;
  const alt = `http://127.0.0.1:${port}`;
  // 1 预览响应头：带 127.0.0.1 画布的 Origin 取 /s1（Node 解析不了 *.localhost，直连 127.0.0.1，预览域不看 Host）
  const u = new URL((await detail082(pid)).screens.find((s) => s.id === screens[0].id)!.previewUrl!);
  u.hostname = '127.0.0.1';
  const head = async (origin: string) => { const r = await fetch(u, { headers: { Origin: origin } }); await r.arrayBuffer(); return { status: r.status, csp: r.headers.get('content-security-policy') ?? '', acao: r.headers.get('access-control-allow-origin') }; };
  const h = await head(alt);
  const ancestors = /frame-ancestors ([^;]+)/.exec(h.csp)?.[1].trim().split(/\s+/) ?? [];
  for (const o of [`http://localhost:${port}`, alt, `http://[::1]:${port}`]) expect(ancestors.includes(o), `frame-ancestors 缺 ${o}：${ancestors.join(' ')}`);
  expect(h.status === 200 && h.acao === alt, `带 ${alt} 的 Origin 取屏，ACAO 应回显它：${h.status} ${h.acao}`);
  const evil = await head('http://evil.example');
  expect(evil.acao !== 'http://evil.example', `名单外的 Origin 不该被回显：${evil.acao}`);
  // 2 从 127.0.0.1 打开画布，双击 /s1 进交互：iframe 里加载出这一屏（修复前 frame-ancestors 拦下，iframe 是禁止图标）
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${alt}/p/${pid}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await eventually(async () => expect((await fl.locator('h1').innerText({ timeout: 1000 })).startsWith('Screen 1'), 'iframe 里不是 Screen 1'), 10000)
    .catch(() => { throw new Error('从 127.0.0.1 打开画布，交互态 iframe 10 s 内没加载出 Screen 1（被 frame-ancestors 拦下？）'); });
  // 3 屏内跳到 /s2：父页跨源取目标屏 HTML 换进同一个 iframe（要 ACAO 放行 127.0.0.1 画布）
  const spot = await blankSpot(page);
  expect(!!spot, '找不到画布空白点');
  await page.mouse.move(spot!.x, spot!.y);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(400);
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  await eventually(async () => expect((await fl.locator('h1').innerText()).startsWith('Screen 2'), 'iframe 内容未切到 Screen 2'), 10000);
  await page.keyboard.press('Escape');
  await shot(page, 'CORE-070');
  return `frame-ancestors ${ancestors.length} 个 origin，ACAO 回显 ${alt}；从 ${alt} 打开画布交互态加载出 Screen 1，屏内跳转换到 Screen 2`;
});

// TC-CORE-071 截图浏览器（§16 进程启动、§17 Chromium）：浏览器还没起来时并发的截图共用一次启动；SIGKILL 重启后上次的截图浏览器被结束、临时目录删掉，
// 别的 Edge 不受影响。要 QUILT_E2E_RESTART（§3）
await step('TC-CORE-071', async () => {
  const RESTART = process.env.QUILT_E2E_RESTART;
  expect(RESTART, '环境：未设 QUILT_E2E_RESTART（重启被测 API 的命令，§3）');
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid } = seedJson<{ projectId: string }>('seed:project', '--name', 'Browsers', '--device', 'mobile', '--screens', '4', '--no-shot');
  const ps = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n').flatMap((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []; });
  const dirOf = (command: string) => /--user-data-dir=(\S+)/.exec(command)?.[1];
  const apiPid = () => Number(execFileSync('lsof', ['-nP', `-tiTCP:${new URL(API).port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const shotBrowsers = (owner: number) => ps().filter((p) => p.ppid === owner && p.command.includes('--remote-debugging-pipe'));
  const restart = () => new Promise<void>((resolve, reject) => { const p = spawn('sh', ['-c', RESTART!], { stdio: 'ignore' }); p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`重启命令退出码 ${code}`)))); });
  // 1 重启（新进程里还没有截图浏览器）后立刻回刷 4 屏：4 张截图同时要浏览器
  await restart();
  const owner = apiPid();
  const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: 'all' } }) });
  expect(r.status === 202, `回刷 ${r.status}`);
  const job = await waitJob(r.body.job.id, 120);
  check(job.status === 'succeeded', `回刷作业 ${job.status}`);
  await sleep079(1000);
  const live = shotBrowsers(owner);
  check(live.length === 1, `回刷 4 屏后 API 名下应只有 1 个截图浏览器，实际 ${live.length} 个（pid ${live.map((p) => p.pid).join(' ')}）`);
  const old = live.flatMap((p) => { const dir = dirOf(p.command); return dir ? [{ pid: p.pid, dir }] : []; });
  expect(old.length > 0, '前置不成立：API 名下没有截图浏览器');
  // 2 种子脚本自己拍截图（同一数据目录里它也记一份，不能把 API 的记录冲掉）；测试进程自己开一个无头 Edge（代表用户自己的浏览器），下面的重启不该动它
  seedJson('seed:project', '--name', 'ShotSeed', '--device', 'mobile', '--screens', '1');
  const mine = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    // 3 SIGKILL 重启：旧进程的截图浏览器成了孤儿；新进程启动时按记录结束它们、删掉临时目录
    await restart();
    await eventually(() => expect(ps().filter((p) => old.some((o) => dirOf(p.command) === o.dir)).length === 0, 'orphan'), 15_000)
      .catch(() => check(false, `重启后 15 s 仍有上次的截图浏览器进程：${ps().filter((p) => old.some((o) => dirOf(p.command) === o.dir)).map((p) => `${p.pid}(ppid ${p.ppid})`).join(' ')}`));
    check(old.every((o) => !existsSync(o.dir)), `上次的临时目录还在：${old.filter((o) => existsSync(o.dir)).map((o) => o.dir).join(' ')}`);
    const pg = await mine.newPage();
    check(mine.isConnected() && (await pg.evaluate(() => 1 + 1)) === 2, '测试自己开的 Edge 被结束了');
  } finally { await mine.close(); }
  if (bad.length) { console.log(`   TC-CORE-071 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return `回刷 4 屏只起 1 个截图浏览器（pid ${old.map((o) => o.pid).join(' ')}）；SIGKILL 重启后它与子进程被结束、临时目录删掉；测试自己的 Edge 照常`;
});

// TC-CORE-072 出变体落位（REQ-CORE-025）：落在默认屏那一行（与它纵向相交的屏）最右、与默认屏同 y，不压住已有的屏；别的行不影响
await step('TC-CORE-072', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'VariantRow', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, , s3] = screens.map((s) => s.id);
  // /s3 挪到下一行、很远的右边：它不在 /s1 那一行，不该把变体推过去。种子 /s1 (0,0)、/s2 (470,0)
  expect((await apiJson(`/v1/screens/${s3}`, { method: 'PATCH', body: JSON.stringify({ x: 3000, y: 1200 }) })).status === 200, '挪 /s3 失败');
  const variant = async (name: string) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'generate', input: { prompt: `the ${name} state`, count: 1, versions: 1, variantOf: s1, variantName: name, runner: STUB_RUNNER } }) });
    expect(r.status === 202, `出变体 ${r.status}`);
    const j = await waitJob(r.body.job.id, 60);
    expect(j.status === 'succeeded', `出变体作业 ${j.status}`);
    return (await detail082(pid)).screens.find((s) => s.variantOf === s1 && s.variantName === name)!;
  };
  const a = await variant('Empty');
  expect(a.x === 940 && a.y === 0, `第一个变体应落在 /s2 右侧 (940, 0)，实际 (${a.x}, ${a.y})`);
  const b = await variant('Error');
  expect(b.x === 1410 && b.y === 0, `第二个变体应落在第一个右侧 (1410, 0)，实际 (${b.x}, ${b.y})`);
  const all = (await detail082(pid)).screens;
  const overlaps = all.flatMap((p, i) => all.slice(i + 1).filter((q) => p.x < q.x + 390 && q.x < p.x + 390 && p.y < q.y + 844 && q.y < p.y + 844).map((q) => `${p.name} × ${q.name}`));
  expect(overlaps.length === 0, `有屏相互重叠：${overlaps.join('；')}`);
  return `变体落在 (${a.x}, ${a.y}) 与 (${b.x}, ${b.y})；另一行的 /s3 (3000, 1200) 不影响；${all.length} 屏两两不相交`;
});

// TC-CORE-073 路径参数不是 UUID（§14 /errors/not-found）：预览域 /p/ /c/ /a/ 与 /v1 下带路径参数的端点一律 404，不 500
await step('TC-CORE-073', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'BadIds', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  const pv = new URL((await detail082(pid)).screens[0].previewUrl!);
  pv.hostname = '127.0.0.1';
  const t = pv.searchParams.get('t')!; const rev = pv.searchParams.get('rev')!;
  const X = 'not-a-uuid';
  const bad: string[] = [];
  expect((await fetch(pv)).status === 200, '对照：签名有效的预览地址应 200');
  for (const p of [`/a/${X}/${X}`, `/a/${pid}/${X}`, `/p/${pid}/${X}?rev=${rev}&t=${t}`, `/p/${pid}/${s1}?rev=${X}&t=${t}`, `/c/${pid}/${X}?t=${t}`]) {
    const r = await fetch(`${pv.origin}${p}`);
    const body = await r.text();
    if (r.status !== 404 || !body.includes('/errors/not-found')) bad.push(`预览域 ${p.split('?')[0]} → ${r.status}`);
  }
  const rest: [string, string][] = [
    ['GET', `/v1/projects/${X}`], ['PATCH', `/v1/projects/${X}`], ['DELETE', `/v1/projects/${X}`],
    ...['app-map', 'assets', 'events', 'jobs', 'messages'].map((s): [string, string] => ['GET', `/v1/projects/${X}/${s}`]),
    ...['annotations/send', 'assets', 'attachments', 'components', 'design-preset', 'jobs', 'messages', 'uploads', `messages/${X}/retry`].map((s): [string, string] => ['POST', `/v1/projects/${X}/${s}`]),
    ['PUT', `/v1/projects/${X}/design-system`],
    ...['', '/candidates', '/events', '/export'].map((s): [string, string] => ['GET', `/v1/jobs/${X}${s}`]),
    ['POST', `/v1/jobs/${X}/cancel`], ['POST', `/v1/jobs/${X}/candidates/adopt`],
    ...['screens', 'components', 'annotations', 'channels'].flatMap((k): [string, string][] => [['PATCH', `/v1/${k}/${X}`], ['DELETE', `/v1/${k}/${X}`]]),
    ['DELETE', `/v1/assets/${X}`], ['DELETE', `/v1/design-presets/${X}`],
    ...['annotations', 'revisions', `revisions/${X}`].map((s): [string, string] => ['GET', `/v1/screens/${X}/${s}`]),
    ['POST', `/v1/screens/${X}/annotations`], ['POST', `/v1/screens/${X}/elements/q1`], ['POST', `/v1/components/${X}/elements/q1`],
    ['POST', `/v1/screens/${X}/revisions/${X}/adopt`], ['POST', `/v1/screens/${X}/revisions/${X}/restore`],
  ];
  for (const [method, p] of rest) {
    const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    await r.arrayBuffer();
    if (r.status !== 404) bad.push(`${method} ${p} → ${r.status}`);
  }
  expect(bad.length === 0, bad.join('；'));
  return `预览域 5 处、/v1 ${rest.length} 个端点的非 UUID 路径参数全部 404`;
});

// TC-CORE-074 改屏目标还没有内容（API-CORE-006）：屏还在、只是它的造屏作业还没落第一版时，失败原因照实说，不说「都已被删除」
await step('TC-CORE-074', async () => {
  const { projectId: pid } = seedJson<{ projectId: string }>('seed:project', '--name', 'NotYet', '--device', 'mobile', '--screens', '1', '--no-shot');
  // 懒生成 /later，桩拖 15 s 才出屏：这段时间里 /later 已建好、还没有当前修订
  const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'generate', input: { prompt: '[stub-hold:15000] a later screen', route: '/later', count: 1, versions: 1, runner: STUB_RUNNER } }) });
  expect(g.status === 202, `懒生成 ${g.status}`);
  let later: Scr082 | undefined;
  await eventually(async () => { later = (await detail082(pid)).screens.find((s) => s.route === '/later'); expect(later && !later.currentRevisionId, 'later'); }, 10_000)
    .catch(() => { throw new Error(`前置不成立：/later 应已建好、还没有当前修订（${JSON.stringify(later ?? null)}）`); });
  const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ content: '把标题改短', targetScreenIds: [later!.id], runner: STUB_RUNNER }) });
  expect(r.status === 202, `对 /later 发改屏 ${r.status}`);
  const j = await waitJob(r.body.job.id, 30) as { status: string; output: { errorClass?: string; message?: string } };
  expect(j.status === 'failed' && j.output.errorClass === 'validation' && j.output.message === '目标屏还没有生成出内容', `改屏作业应 failed(validation)「目标屏还没有生成出内容」：${j.status} ${j.output.errorClass} ${j.output.message}`);
  const msg = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${pid}/messages`)).body.items.find((m) => m.role === 'assistant' && m.jobId === r.body.job.id);
  expect(msg?.content.startsWith('改屏失败：目标屏还没有生成出内容'), `回执应写「改屏失败：目标屏还没有生成出内容」：${msg?.content}`);
  await waitJob(g.body.job.id, 60);
  return `作业 failed(validation)「${j.output.message}」；回执「${msg!.content}」`;
});

// TC-CORE-087 修订面板与候选展开用缩略图；修订面板、预设列表、候选展开取数失败就地重试（v1.03 PERF-1 / UX-4）
await step('TC-CORE-087', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'PanelThumbs', '--device', 'mobile', '--screens', '1');
  const sid = screens[0].id;
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const banner = (text: string) => page.getByRole('alert').filter({ hasText: text });
  try {
    // 1 修订 API 带 thumbUrl
    const items = (await apiJson<{ items: { thumbUrl: string | null }[] }>(`/v1/screens/${sid}/revisions`)).body.items;
    check(items[0]?.thumbUrl?.includes('.thumb.webp'), `修订缺 thumbUrl：${JSON.stringify(items[0])}`);
    // 2 修订列表取失败：就地「没取到 · 重试」；重试后列出，缩略图取 .thumb.webp
    let fail = true;
    await page.route(`**/v1/screens/${sid}/revisions`, (r) => (fail && r.request().method() === 'GET' ? r.abort() : r.fallback()));
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"] .gesture').first().click();
    await page.keyboard.press('Alt+r');
    await banner('修订列表没取到').waitFor({ timeout: 8000 }).catch(() => check(false, '修订列表取失败时没有就地提示'));
    fail = false;
    await banner('修订列表没取到').getByRole('button', { name: '重试' }).click().catch(() => {});
    await page.locator('[data-testid="revision"]').first().waitFor({ timeout: 8000 }).catch(() => check(false, '重试后修订列表没出来'));
    const src = await page.locator('[data-testid="revision"] img').first().getAttribute('src').catch(() => null);
    check(src && decodeURIComponent(src).includes('.thumb.webp'), `修订面板缩略图应取 .thumb.webp：${src}`);
    await page.unroute(`**/v1/screens/${sid}/revisions`);
    // 3 预设列表取失败：不说成「还没有预设」，就地重试
    fail = true;
    await page.route('**/v1/design-presets', (r) => (fail && r.request().method() === 'GET' ? r.abort() : r.fallback()));
    await page.goto(`${WEB}/p/${pid}?panel=design`);
    await banner('预设列表没取到').waitFor({ timeout: 8000 }).catch(() => check(false, '预设列表取失败时没有就地提示'));
    check(!(await page.getByText('还没有预设').count()), '预设列表取失败时说成了「还没有预设」');
    fail = false;
    await banner('预设列表没取到').getByRole('button', { name: '重试' }).click().catch(() => {});
    await eventually(async () => expect((await page.getByTestId('preset-list').count()) + (await page.getByText('还没有预设').count()) > 0, 'presets'), 8000).catch(() => check(false, '重试后预设列表没出来'));
    await page.unroute('**/v1/design-presets');
    // 4 候选：钉死路由造 1 屏 × 2 版（不走规划，内置桩只会出多屏规划）；候选取失败时格子上写「候选没取到」并给重试；重试后两格，垫底图是缩略图
    const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'generate', input: { prompt: '一个设置页', route: '/settings', name: 'Settings', count: 1, versions: 2, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(g.status === 202, `造候选 ${g.status}`);
    await waitJob(g.body.job.id, 90);
    fail = true;
    await page.route('**/v1/jobs/*/candidates', (r) => (fail ? r.abort() : r.fallback()));
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="candidate-badge"]').first().click();
    await page.getByText('候选没取到').waitFor({ timeout: 8000 }).catch(() => check(false, '候选取失败时没有就地提示'));
    fail = false;
    await page.getByTestId('candidate-retry').click().catch(() => {});
    await eventually(async () => expect((await page.locator('[data-testid="candidate-cell"]').count()) === 2, 'cells'), 10000).catch(() => check(false, '重试后候选格没出来'));
    const under = await page.locator('[data-testid="candidate-cell"] img').first().getAttribute('src').catch(() => null);
    check(under && decodeURIComponent(under).includes('.thumb.webp'), `候选格垫底图应取缩略图：${under}`);
    await page.unroute('**/v1/jobs/*/candidates');
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  if (bad.length) throw new Error(bad.join('；'));
  return '修订带 thumbUrl、面板与候选格用缩略图；修订面板、预设列表、候选展开取失败就地「没取到 · 重试」，重试后照常';
});

// TC-CORE-088 取消与落库同时到达，事件流只有一个终态（§16 v1.03 REL-4）：桩的 [stub-finalize-hold] 让 worker 复核取消之后、落库之前停 30 s，取消落在这段里。
// 停顿从截图拍完（或拍失败）之后开始：截图走外网 CDN，拍成要几秒、拍失败要二十来秒——等到 screen_screenshot_ready 或修订落库后 25 s，再取消
await step('TC-CORE-088', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'CancelRace', '--device', 'mobile', '--screens', '1', '--no-shot');
  const mcp = await connectMcp();
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  try {
    const events = async (jobId: string) => ((await callTool(mcp, 'quilt.get_job_events', { jobId })).json as { items: { type: string }[] }).items.map((e) => e.type);
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'edit_screens', input: { prompt: '[stub-finalize-hold:30000] 改标题', screenIds: [screens[0].id], versions: 1, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    const jobId = r.body.job.id;
    await eventually(async () => expect((await events(jobId)).includes('screen_html_ready'), 'html'), 30_000, 200);
    await eventually(async () => expect((await events(jobId)).includes('screen_screenshot_ready'), 'shot'), 25_000, 500).catch(() => {});
    await sleep(1000);
    const c = await apiJson(`/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(c.status === 200, `取消 ${c.status}（落在停顿之外，前置不成立）`);
    // 等停顿结束、worker 走完落库那一步
    await sleep(32_000);
    const terminal = (await events(jobId)).filter((t) => ['succeeded', 'failed', 'cancelled'].includes(t));
    expect(terminal.length === 1 && terminal[0] === 'cancelled', `事件流应只有一个终态 cancelled：${terminal.join(', ')}`);
    const job = (await apiJson<{ job: { status: string } }>(`/v1/jobs/${jobId}`)).body.job;
    const msg = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${pid}/messages`)).body.items.find((m) => m.role === 'assistant' && m.jobId === jobId);
    expect(job.status === 'cancelled' && msg?.content === '已取消', `作业应 cancelled、回执「已取消」：${job.status} ${msg?.content}`);
    return `终态只有 cancelled；回执「${msg!.content}」`;
  } finally { await mcp.close(); await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-089 排队卡住的 model 作业被 job.timeout 重新入队（§17 v1.03 REL-3）：seed:job 建一个只落库、没进进程内队列的 queued 作业，
// job.timeout 每分钟扫、排队超过 60 s 的才补——最长约 2 分钟后它被领取跑完
// 同一轮再种一个输入不合法的（edit_screens 缺 prompt，CH-2 v1.06）：领取时按种类校验，以 validation 失败收尾、不进流水线
await step('TC-CORE-089', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Requeue', '--device', 'mobile', '--screens', '2', '--no-shot');
  const { jobId } = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--screen', screens[0].id, '--status', 'queued', '--kind', 'edit_screens');
  const { jobId: bad } = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--screen', screens[1].id, '--status', 'queued', '--kind', 'edit_screens', '--input', JSON.stringify({ screenIds: [screens[1].id], versions: 1 }));
  const t0 = Date.now();
  const j = await waitJob(jobId, 180);
  const took = Math.round((Date.now() - t0) / 1000);
  const jb = await waitJob(bad, 60);
  await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
  expect(j.status === 'succeeded', `卡在 queued 的作业应被重新入队并跑完：${j.status}（${took} s）`);
  expect(jb.status === 'failed' && jb.output.errorClass === 'validation' && String(jb.output.message).startsWith('作业输入不合法：prompt'), `输入不合法的作业应在领取时以 validation 失败：${jb.status} ${jb.output.errorClass} ${jb.output.message}`);
  return `${took} s 后被重新入队、succeeded；缺 prompt 的那个领取时 failed(validation)「${jb.output.message}」`;
});

// TC-CORE-096 建作业的入口校验四处一份（CH-2 v1.06）：POST /jobs 与发消息带不存在的通道都当场 404、不建作业（此前 POST /jobs 要到 worker 里才失败）
await step('TC-CORE-096', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Entry', '--device', 'mobile', '--screens', '1', '--no-shot');
  try {
    const jobsOf = async () => (await apiJson<{ items: unknown[] }>(`/v1/projects/${pid}/jobs`)).body.items.length;
    const before = await jobsOf();
    const r = await apiJson<{ type: string }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'edit_screens', input: { prompt: '改标题', screenIds: [screens[0].id], runner: { kind: 'channel', channelId: '00000000-0000-4000-8000-000000000000' } } }) });
    expect(r.status === 404 && (await jobsOf()) === before, `不存在的通道应 404 且不建作业：${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    const m = await apiJson<{ type: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ content: '改标题', targetScreenIds: [screens[0].id], runner: { kind: 'channel', channelId: '00000000-0000-4000-8000-000000000000' } }) });
    expect(m.status === 404 && (await jobsOf()) === before, `发消息带不存在的通道同样 404：${m.status}`);
    return '不存在的通道：POST /jobs 与发消息都当场 404、不建作业';
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-090 storage.gc 清超过 24 小时的导出与没被引用的参考图附件（§17 v1.03 REL-6）：把文件修改时间拨回 25 小时前，
// 重启 API（启动 1 分钟后先扫一轮）。要 QUILT_E2E_RESTART
await step('TC-CORE-090', async () => {
  const RESTART = process.env.QUILT_E2E_RESTART;
  expect(RESTART, '环境：未设 QUILT_E2E_RESTART（重启被测 API 的命令，§3）');
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'StorageGc', '--device', 'mobile', '--screens', '1', '--no-shot');
  const objects = path.join(ROOT, '.data/objects/projects', pid);
  try {
    const ex = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    expect((await waitJob(ex.body.job.id, 90) as { status: string }).status === 'succeeded', '导出没成功');
    const used = await uploadPng(pid); const orphan = await uploadPng(pid);
    const m = await apiJson(`/v1/projects/${pid}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ content: '参考这张', targetScreenIds: [screens[0].id], attachmentIds: [used], runner: { kind: 'model', driver: 'stub', model: 'stub' } }) });
    expect(m.status === 202, `带参考图发消息 ${m.status}`);
    const exportFile = path.join(objects, 'exports', `${ex.body.job.id}.html`);
    const att = async (id: string) => (await readdir(path.join(objects, 'attachments'))).find((f) => f.startsWith(id));
    const old = new Date(Date.now() - 25 * 3600_000);
    for (const f of [exportFile, path.join(objects, 'attachments', (await att(used))!), path.join(objects, 'attachments', (await att(orphan))!)]) await utimes(f, old, old);
    execFileSync('sh', ['-c', RESTART!], { stdio: 'ignore' });
    await eventually(async () => expect(!(await stat(exportFile).then(() => true, () => false)), 'export'), 120_000, 2000)
      .catch(() => { throw new Error('重启 2 分钟内 storage.gc 没清掉超过 24 小时的导出'); });
    const dl = await fetch(`${API}/v1/jobs/${ex.body.job.id}/export`);
    const body = await dl.json().catch(() => ({})) as { detail?: string };
    expect(dl.status === 404 && body.detail?.includes('导出文件已清理'), `清掉的导出应 404 并写明原因：${dl.status} ${JSON.stringify(body)}`);
    expect(!(await att(orphan)), '没被引用的旧附件应被清掉');
    expect(!!(await att(used)), '被消息引用的附件不该被清掉');
    return '重启后一轮扫掉过期导出（下载 404 写明原因）与孤儿附件，被引用的附件留着';
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-091 项目切换器里高亮行按 F2 改名（REQ-CORE-002 v1.04 UX-8）：只用键盘——点开下拉后当前项目即高亮，F2 进入改名、回车保存；列表顶部写快捷键
await step('TC-CORE-091', async () => {
  const { projectId: pid } = seedJson<{ projectId: string }>('seed:project', '--name', 'F2Rename', '--device', 'mobile', '--screens', '1', '--no-shot');
  try {
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.getByTestId('project-switcher').click();
    await page.locator(`[data-testid="project-option"][data-project-id="${pid}"][data-highlighted]`).waitFor({ timeout: 5000 });
    const hint = await page.getByTestId('project-keys-hint').innerText();
    expect(hint === 'F2 改名 · Delete 删除', `列表顶部的快捷键说明不对：${hint}`);
    await page.keyboard.press('F2');
    const input = page.getByTestId('rename-input');
    await input.waitFor({ timeout: 3000 });
    expect((await input.inputValue()) === 'F2Rename' && await input.evaluate((el) => document.activeElement === el), 'F2 后改名框没带原名或没拿到焦点');
    await input.fill('键盘改的名');
    await page.keyboard.press('Enter');
    await eventually(async () => expect((await apiJson<{ project: { name: string } }>(`/v1/projects/${pid}`)).body.project.name === '键盘改的名', 'renamed'), 8000);
    return `说明「${hint}」；F2 进入改名、回车保存`;
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-092 同一功能一个名字（PAGE-CANVAS「同一功能一个名字」v1.04 UX-6）：修订面板的候选组与行；重生成这块的按钮、在跑作业行、对话描述、回执、修订来源
await step('TC-CORE-092', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Names', '--device', 'mobile', '--screens', '1', '--no-shot');
  const S = softly();
  try {
    // 1 钉死路由造 1 屏 × 2 版：修订面板组头「候选 · 2 版 · 待采用」、各行「候选 1」「候选 2」，不露出 seq 与作业 id
    const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'generate', input: { prompt: '一个设置页', route: '/settings', name: 'Settings', count: 1, versions: 2, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(g.status === 202, `造候选 ${g.status}`);
    expect((await waitJob(g.body.job.id, 90) as { status: string }).status === 'succeeded', '造候选没成功');
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"][data-route="/settings"] .gesture').click();
    await page.keyboard.press('Alt+r');
    const group = page.getByTestId('candidate-group');
    await group.waitFor({ timeout: 8000 });
    const head = (await group.innerText()).split('\n')[0];
    await S.check(() => expect(head === '候选 · 2 版 · 待采用', `① 候选组头不对：${head}`));
    const rows = await group.locator('[data-testid="revision"] span.font-medium').allInnerTexts();
    await S.check(() => expect(rows.length === 2 && rows[0].startsWith('候选 1') && rows[1].startsWith('候选 2') && !rows.join('').includes('seq'), `① 候选行不对：${rows.join(' | ')}`));
    // 2 /s1 选标题：检查器按钮叫「重生成这块」；经接口对这块建 regenerate_subtree（stub 通道，桩停 10 s——单跑时测试库里只有本机 agent 通道，界面默认选不到桩），
    //   重开页面看在跑作业行「重生成「Screen 1」的一块」；跑完对话描述「重生成一块：…」、回执「已重生成「Screen 1」的一块」、修订来源「重生成一块」
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"][data-route="/s1"]').waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('h1').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await fl.locator('h1').click();
    await page.locator('#el-prompt').waitFor({ timeout: 5000 });
    await S.check(async () => expect((await page.getByRole('button', { name: '重生成这块' }).count()) === 1, '② 检查器按钮应叫「重生成这块」'));
    const qid = await fl.locator('[data-quilt-selection]').getAttribute('data-qid');
    const s1 = (await apiJson<{ screens: { id: string; route: string; currentRevisionId: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((x) => x.route === '/s1')!;
    const sub = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: s1.id, qid, prompt: '[stub-hold:10000] 换成一句标语', expectedRevisionId: s1.currentRevisionId, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(sub.status === 202, `重生成一块 ${sub.status} ${JSON.stringify(sub.body).slice(0, 160)}`);
    await page.reload();
    const row = page.getByTestId('running-job').filter({ hasText: '重生成「Screen 1」的一块' });
    await S.check(() => row.waitFor({ timeout: 6000 }).catch(async () => { throw new Error(`② 在跑作业行不对：${(await page.getByTestId('running-job').allInnerTexts()).join(' | ') || '没有作业行'}`); }));
    await waitJob(sub.body.job.id, 60);
    const msgs = async () => (await apiJson<{ items: { role: string; content: string }[] }>(`/v1/projects/${pid}/messages`)).body.items;
    await eventually(async () => expect((await msgs()).some((m) => m.role === 'assistant' && m.content.startsWith('已重生成')), 'receipt'), 60000);
    const all = await msgs();
    await S.check(() => expect(all.some((m) => m.role === 'user' && m.content === '重生成一块：[stub-hold:10000] 换成一句标语'), `② 对话描述不对：${all.filter((m) => m.role === 'user').map((m) => m.content).join(' | ')}`));
    await S.check(() => expect(all.some((m) => m.role === 'assistant' && m.content.startsWith('已重生成「Screen 1」的一块')), `② 回执不对：${all.filter((m) => m.role === 'assistant').map((m) => m.content).join(' | ')}`));
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.keyboard.press('Alt+r');
    await S.check(() => page.locator('[data-testid="revision"]').first().filter({ hasText: '重生成一块' }).waitFor({ timeout: 8000 }).catch(() => { throw new Error('② 修订来源没写「重生成一块」'); }));
  } catch (e) { S.fail(e); }
  finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '候选组「候选 · 2 版 · 待采用」、行「候选 n」；重生成这块的按钮、作业行、对话描述、回执、修订来源各用定名';
});

// TC-CORE-093 输入框打字不重量工具条（v1.04 PERF-2）：量宽要强制布局，只在工具条内容变了时量。第一个字会让发送键的不可用说明消失（内容变了、量一次），
// 之后再打 19 个字，工具条上的 getBoundingClientRect 调用为 0；切到「聊天」（档位收起，内容变了）照常量
await step('TC-CORE-093', async () => {
  const { projectId: pid } = seedJson<{ projectId: string }>('seed:project', '--name', 'TypeFast', '--device', 'mobile', '--screens', '1', '--no-shot');
  try {
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    // 数工具条（.composer-bar）上的 getBoundingClientRect；用字符串求值，避开 tsx 给箭头函数加的 __name
    await page.evaluate(`(() => {
      window.__barEl = document.querySelector('.composer-bar'); window.__barReads = 0;
      const orig = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { if (this === window.__barEl) window.__barReads++; return orig.call(this); };
    })()`);
    await page.locator('#chat-input').click();
    await page.keyboard.type('打');
    await page.waitForTimeout(200);
    await page.evaluate('window.__barReads = 0');
    await page.keyboard.type('字的时候工具条不该被反复量宽度呀呀呀呀', { delay: 30 });
    const typed = await page.evaluate('window.__barReads') as number;
    await page.getByTestId('mode-chat').click();
    await page.waitForTimeout(300);
    const switched = (await page.evaluate('window.__barReads') as number) - typed;
    await page.getByTestId('mode-design').click();
    expect(typed === 0, `再打 19 个字量了 ${typed} 次工具条`);
    expect(switched > 0, '切到聊天后工具条没重量');
    return `打字 0 次；切到聊天后量 ${switched} 次`;
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-094 一个作业内 6 个调用以内一波发完（ADR-012 v1.05）：内置桩的规划出 5 屏，每次调用拖 4 s——并行上限还是 4 时第 5 屏要等第一波，
// html 落地比前 4 屏晚 4 s 以上；一波发完时 5 屏的 screen_html_ready 相差不到 2.5 s
await step('TC-CORE-094', async () => {
  const { projectId: pid } = seedJson<{ projectId: string }>('seed:project', '--name', 'OneWave', '--device', 'mobile', '--screens', '1', '--no-shot');
  const mcp = await connectMcp();
  try {
    const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'generate', input: { prompt: '[stub-hold:4000] 一组屏', count: 'auto', versions: 1, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(g.status === 202, `造屏 ${g.status}`);
    const j = await waitJob(g.body.job.id, 120) as { status: string };
    expect(j.status === 'succeeded', `造屏应成功：${j.status}`);
    const ready = ((await callTool(mcp, 'quilt.get_job_events', { jobId: g.body.job.id })).json as { items: { type: string; at: string }[] }).items.filter((e) => e.type === 'screen_html_ready').map((e) => Date.parse(e.at));
    const spread = Math.max(...ready) - Math.min(...ready);
    expect(ready.length === 5 && spread < 2500, `5 屏应一波落地：${ready.length} 屏，最早与最晚相差 ${spread} ms`);
    return `5 屏的 html 落地最早与最晚相差 ${spread} ms`;
  } finally { await mcp.close(); await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-CORE-095 屏文档的外网脚本用仓库副本（§17 v1.06 TEST-4）：预览域下发的屏里 Tailwind Play 与 lucide 指向 /vendor/<带版本的文件名>，
// /vendor 长缓存下发 JavaScript；修订里存的仍是钉死版本的外网地址；不认识的文件名 404
await step('TC-CORE-095', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Vendor', '--device', 'mobile', '--screens', '1', '--no-shot');
  try {
    const s = (await apiJson<{ screens: { id: string; currentRevisionId: string; previewUrl: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((x) => x.id === screens[0].id)!;
    const doc = await (await localFetch(s.previewUrl)).text();
    const local = [...doc.matchAll(/<script src="(\/vendor\/[^"]+)"><\/script>/g)].map((m) => m[1]);
    expect(local.length === 2 && !doc.includes('cdn.tailwindcss.com') && !doc.includes('unpkg.com/lucide'), `预览域下发的屏应只引 /vendor 副本：${local.join(' ')}`);
    const origin = new URL(s.previewUrl).origin;
    for (const p of local) {
      const r = await localFetch(origin + p);
      expect(r.status === 200 && (r.headers.get('content-type') ?? '').includes('javascript') && (r.headers.get('cache-control') ?? '').includes('immutable') && (await r.arrayBuffer()).byteLength > 100_000, `${p} 应 200、JavaScript、immutable：${r.status} ${r.headers.get('content-type')}`);
    }
    expect((await localFetch(`${origin}/vendor/evil.js`)).status === 404, '不认识的文件名应 404');
    const stored = await (await fetch((await apiJson<{ revision: { htmlUrl: string } }>(`/v1/screens/${s.id}/revisions/${s.currentRevisionId}`)).body.revision.htmlUrl)).text();
    expect(stored.includes('https://cdn.tailwindcss.com/3.4.17') && stored.includes('https://unpkg.com/lucide@1.55.0/dist/umd/lucide.min.js'), '修订里应存钉死版本的外网地址');
    return `预览域引 ${local.join('、')}，长缓存下发；修订里存钉死版本的外网地址；未知文件 404`;
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});
