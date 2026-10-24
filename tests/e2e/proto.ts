import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB, API, eventually } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { suite, expect, waitJob, needLiveLlm } from './harness.ts';

// docs/TEST.md PROTO 域（TC-PROTO-001~006）AI 执行脚本。用法同 core.ts（RUN= / ONLY= / LIVE_LLM=0）。
await mkdir(EVIDENCE, { recursive: true });
let page: import('playwright').Page;
const { RUN, step, summary } = suite('PROTO', {
  page: () => page,
  onTimeout: async () => { await page.close().catch(() => {}); page = await ctx.newPage(); await openApp(page); },
});

seed('seed');
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page = await ctx.newPage();
await openApp(page);

const focus = async (route: string) => {
  await page.locator(`[data-testid="screen-card"][data-route="${route}"] .gesture`).dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  return page.frameLocator('.card.focused iframe');
};

await step('TC-PROTO-001', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Play', '--device', 'mobile', '--screens', '3');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const histBefore = await page.evaluate('history.length') as number;
  const fl = await focus('/s1');
  await fl.locator('input[name="address"]').fill('上海市');
  // 屏比安全区高时顶到上沿、屏底压在输入框底下（§13 v0.19）；1000px 高的视口里「Go to /s2」正落在那一段——
  // 像用户一样在画布空白处（浮层与卡片之外）滚一下把它露出来（指针在 iframe 外，滚轮平移的是画布）
  const blank = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas"]')!;
    const c = canvas.getBoundingClientRect();
    for (let y = c.top + 120; y < c.bottom - 200; y += 30) for (let x = c.left + 60; x < c.right - 100; x += 30) {
      const el = document.elementFromPoint(x, y);
      if (el === canvas || (el && el.classList.contains('world'))) return { x, y };
    }
    return null;
  });
  expect(!!blank, '找不到画布空白点');
  await page.mouse.move(blank!.x, blank!.y);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(400);
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('h1').innerText()).startsWith('Screen 2'), 'iframe 内容未切到 Screen 2'));
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 被重建');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('h1').innerText()).startsWith('Screen 1'), '后退未回到 Screen 1'));
  expect((await fl.locator('input[name="address"]').inputValue()) === '上海市', '输入未保留');
  expect((await page.evaluate('history.length') as number) === histBefore, '主站历史被污染');
  await page.keyboard.press('Escape');

  await eventually(async () => expect((await page.locator('.card.focused iframe').count()) === 0, 'Esc 未退出'));
});

let mapProject = '';
let mapScreens: { id: string; route: string }[] = [];
await step('TC-PROTO-002', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Map', '--device', 'mobile', '--screens', '2', '--dangling');
  mapProject = r.projectId; mapScreens = r.screens;
  const map = await apiJson<{ edges: { fromScreenId: string; href: string; toScreenId: string | null }[] }>(`/v1/projects/${mapProject}/app-map`);
  expect(map.body.edges.some((e) => e.fromScreenId === mapScreens[0].id && e.href === '/settings' && e.toScreenId === null), '缺 /settings 断链边');
  expect(map.body.edges.some((e) => e.fromScreenId === mapScreens[0].id && e.href === '/s2' && e.toScreenId === mapScreens[1].id), '/s1→/s2 未解析');
  await page.goto(`${WEB}/p/${mapProject}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const warn = page.locator('[data-testid="screen-card"][data-route="/s1"] .warn');
  await warn.waitFor();
  expect((await warn.innerText()).includes('/settings'), '断链标记未显示 /settings');
  expect((await page.locator('[data-testid="screen-card"][data-route="/s2"] .warn').count()) === 0, '/s2 误标断链');
});

await step('TC-PROTO-003', async () => {
  const r = await apiJson<{ screen: { route: string } }>(`/v1/screens/${mapScreens[1].id}`, { method: 'PATCH', body: JSON.stringify({ route: '/settings' }) });
  expect(r.status === 200 && r.body.screen.route === '/settings', `改路由返回 ${r.status}`);
  const map = await apiJson<{ edges: { href: string; toScreenId: string | null }[] }>(`/v1/projects/${mapProject}/app-map`);
  expect(map.body.edges.find((e) => e.href === '/settings')?.toScreenId === mapScreens[1].id, '断链未解析到 /s2');
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.waitForTimeout(300);
  // /settings 已解析；原指向 /s2 的链接此时反而成为断链（正确行为），标记里不应再出现 /settings
  const warnText = await page.locator('[data-testid="screen-card"][data-route="/s1"] .warn').allInnerTexts();
  expect(!warnText.join(' ').includes('/settings'), `刷新后仍标 /settings 断链：${warnText.join(' ')}`);
  const taken = await apiJson<{ type: string }>(`/v1/screens/${mapScreens[0].id}`, { method: 'PATCH', body: JSON.stringify({ route: '/settings' }) });
  expect(taken.status === 409 && taken.body.type === '/errors/route-taken', `占用路由返回 ${taken.status}`);
  // 复原供后续用例
  const restored = await apiJson(`/v1/screens/${mapScreens[1].id}`, { method: 'PATCH', body: JSON.stringify({ route: '/s2' }) });
  expect(restored.status === 200, `复原路由返回 ${restored.status}`);
});

await step('TC-PROTO-004', async () => {
  needLiveLlm();
  await page.goto(`${WEB}/p/${mapProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const fl = await focus('/s1');
  await fl.locator('a[href="/settings"]').click();
  await page.locator('[data-testid="missing-dialog"]').waitFor({ timeout: 5000 });
  const res = page.waitForResponse((r) => r.url().includes('/jobs') && r.request().method() === 'POST');
  await page.locator('[data-testid="missing-dialog"]').getByRole('button', { name: '生成' }).click();
  const job = (await (await res).json()) as { job: { id: string; kind: string; input: { route?: string } } };
  expect(job.job.kind === 'generate' && job.job.input.route === '/settings', `懒生成应是钉死路由的 generate 作业：${JSON.stringify(job.job)}`);
  await page.locator('[data-testid="screen-card"][data-route="/settings"]').waitFor({ timeout: 120000 });
  await page.locator('[data-testid="screen-card"][data-route="/settings"] img').waitFor({ timeout: 60000 });
  // 新屏落地即派生地图（不必等作业里随后的反向连线跑完）
  const map = await apiJson<{ edges: { href: string; toScreenId: string | null }[] }>(`/v1/projects/${mapProject}/app-map`);
  expect(map.body.edges.find((e) => e.href === '/settings')?.toScreenId, '生成后断链未解析');
  await waitJob(job.job.id, 240);
  await page.waitForTimeout(500);
  await fl.locator('a[href="/settings"]').click();
  await page.locator('.card.focused .badge', { hasText: '/settings' }).waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
});

await step('TC-PROTO-005', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Export', '--device', 'mobile', '--screens', '6', '--no-shot');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: '导出原型' }).click();
  const download = await dl;
  expect(download.suggestedFilename() === 'Export - Prototype.html', `下载文件名应是「Export - Prototype.html」：${download.suggestedFilename()}`);
  const exportUrl = download.url();
  const file = path.join(EVIDENCE, `run-${RUN}-export.html`);
  await download.saveAs(file);
  const html = await readFile(file, 'utf8');
  expect(html.includes('data-quilt="tailwind"') && !html.includes('cdn.tailwindcss.com'), '导出未内联 Tailwind CSS');
  expect((html.match(/<template data-route=/g) ?? []).length === 6, '导出屏数不是 6');
  const offline = await browser.newContext();
  await offline.setOffline(true);
  const p2 = await offline.newPage();
  await p2.goto(`file://${file}`);
  await p2.locator('#quilt-root h1').waitFor();
  expect((await p2.locator('#quilt-root h1').innerText()).startsWith('Screen 1'), '离线打开首屏不是 Screen 1');
  const visited = new Set<string>(['/s1']);
  for (let i = 0; i < 6; i++) {
    const href = await p2.locator('#quilt-root a[href^="/"]').first().getAttribute('href');
    await p2.locator('#quilt-root a[href^="/"]').first().click();
    // 固定等待而非轮询：下一轮要读新页面上的链接，得等 view transition 把 DOM 换完，不只是 hash 变了
    await p2.waitForTimeout(400);
    expect(p2.url().endsWith(`#${href}`), `hash 未变为 #${href}`);
    visited.add(href!);
  }
  expect(visited.size >= 3, `仅到达 ${visited.size} 屏`);
  await offline.close();
  // 5 改名后再下载同一份导出：文件名取下载那一刻的项目名，/ 换成 _，中文走 filename*
  const renamed = await apiJson(`/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: '健身/打卡' }) });
  expect(renamed.status === 200, `项目改名失败：${renamed.status}`);
  const cd = (await fetch(exportUrl)).headers.get('content-disposition') ?? '';
  expect(cd.includes("filename*=UTF-8''"), `响应头应带 filename*：${cd}`);
  const dl2 = page.waitForEvent('download', { timeout: 10000 });
  await page.evaluate((u) => { location.assign(u); }, exportUrl);
  const name2 = (await dl2).suggestedFilename();
  expect(name2 === '健身_打卡 - Prototype.html', `改名后的下载文件名应是「健身_打卡 - Prototype.html」：${name2}`);
  return `导出 ${Math.round(html.length / 1024)} KB，离线可跳转 ${visited.size} 屏；下载名「${download.suggestedFilename()}」，改名后「${name2}」`;
});

await step('TC-PROTO-006', async () => {
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
  const { jobId } = seedJson<{ jobId: string }>('seed:job', '--project', demo.id, '--status', 'running', '--kind', 'export_prototype');
  const r = await apiJson<{ type: string }>(`/v1/jobs/${jobId}/export`);
  expect(r.status === 409 && r.body.type === '/errors/job-not-finished', `返回 ${r.status}`);
});

// v0.6：三种导航源（表单提交 / data-href）、画布连线、补链修复轮
let formProject = ''; let formScreens: { id: string; route: string }[] = [];
await step('TC-PROTO-007', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Form', '--device', 'mobile', '--screens', '3', '--form', '--dangling');
  formProject = r.projectId; formScreens = r.screens;
  const map = await apiJson<{ edges: { fromScreenId: string; href: string; toScreenId: string | null }[] }>(`/v1/projects/${formProject}/app-map`);
  expect(map.body.edges.some((e) => e.fromScreenId === formScreens[0].id && e.href === '/s3' && e.toScreenId === formScreens[2].id), 'data-href 边未派生');
  expect(map.body.edges.filter((e) => e.fromScreenId === formScreens[0].id && e.href === '/s2').length >= 2, 'form action 边未派生');
  await page.goto(`${WEB}/p/${formProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const fl = await focus('/s1');
  await fl.locator('input[name="email"]').fill('a@b.co');
  await fl.locator('button[type="submit"]', { hasText: 'Sign in' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('h1').innerText()).startsWith('Screen 2'), '表单提交未换到 Screen 2'));
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 被重建');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('input[name="email"]').inputValue()) === 'a@b.co', '表单输入未保留'));
  await fl.locator('button[data-href="/s3"]').click();
  await page.locator('.card.focused .badge', { hasText: '/s3' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('h1').innerText()).startsWith('Screen 3'), 'data-href 按钮未换到 Screen 3'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
});

// TC-PROTO-014 连线只在交互时显示（v1.29 PAGE-CANVAS「连线」）：平时不画；进交互画正显示的那一屏进出的、线先长出来；屏内跳转跟着换；Esc 撤掉；开关管交互时画不画
await step('TC-PROTO-014', async () => {
  await page.goto(`${WEB}/p/${formProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const { body: map } = await apiJson<{ edges: { fromScreenId: string; toScreenId: string | null }[] }>(`/v1/projects/${formProject}/app-map`);
  const pairs = [...new Set(map.edges.filter((e) => e.toScreenId && e.toScreenId !== e.fromScreenId).map((e) => `${e.fromScreenId}>${e.toScreenId}`))];
  // 正显示 shown、聚焦卡 focused 时要画的条数：shown 进出的屏对，另一端是聚焦卡的不算
  const expected = (shown: string, focused: string) => pairs.filter((k) => { const [a, b] = k.split('>'); return (a === shown || b === shown) && (a === shown ? b : a) !== focused; }).length;
  const [s1, s2] = formScreens;
  const edgesEl = page.locator('[data-testid="link-edges"]');
  // 逐帧记 data-state 的变化（只记变了的），看线是不是先长出来
  const recordStates = () => page.evaluate(`window.__states = []; (function tick() { const c = document.querySelector('[data-testid="link-edges"]'); const v = c && c.dataset.state; if (v && window.__states[window.__states.length - 1] !== v) window.__states.push(v); window.__statesRaf = requestAnimationFrame(tick); })()`);
  const states = async () => { const v = await page.evaluate('(cancelAnimationFrame(window.__statesRaf), window.__states)') as string[]; return v; };
  // canvas 上链去的线（标记色）与链进来的线（三级文字色）各有多少像素（容差 30；抗锯齿边上混出来的色不算）
  const inks = () => edgesEl.evaluate((c) => {
    const el = c as HTMLCanvasElement; const cs = getComputedStyle(el);
    // 页面里执行的函数不能再声明具名函数（tsx 会给它包 __name，页面里没有）
    const want = Object.fromEntries((['out', 'in'] as const).map((k) => [k, ((h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))(cs.getPropertyValue(k === 'out' ? '--semantic-color-mark-line' : '--semantic-color-text-tertiary').trim())])) as Record<'out' | 'in', number[]>;
    const d = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data; const n = { out: 0, in: 0 };
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 230) for (const k of ['out', 'in'] as const) { const w = want[k]; if (Math.abs(d[i] - w[0]) + Math.abs(d[i + 1] - w[1]) + Math.abs(d[i + 2] - w[2]) < 30) n[k]++; }
    return n;
  });
  // 1 平时不画连线；断链标记照常
  await page.waitForTimeout(500);
  expect((await edgesEl.count()) === 0, '① 平时不该画连线');
  expect((await page.locator('[data-testid="screen-card"][data-route="/s1"] .warn').count()) === 1, '① /s1 的断链标记不见了');
  // 2 进交互：画 /s1 进出的；先 growing、1 s 内 done；链去的是标记色、链进来的是三级文字色
  await recordStates();
  const fl = await focus('/s1');
  await eventually(async () => expect((await edgesEl.getAttribute('data-state')) === 'done', '② 连线 1 s 内没长完'), 1000);
  const st = await states();
  const want1 = expected(s1.id, s1.id);
  expect(st[0] === 'growing' && st[st.length - 1] === 'done', `② data-state 应先 growing 再 done：${JSON.stringify(st)}`);
  expect((await edgesEl.getAttribute('data-screen')) === s1.id && Number(await edgesEl.getAttribute('data-drawn')) === want1, `② 应画 /s1 进出的 ${want1} 条：${await edgesEl.getAttribute('data-drawn')}`);
  const ink = await inks();
  expect(ink.out > 20 && ink.in > 20, `② 应既有标记色（链去）也有三级文字色（链进来）的像素：${JSON.stringify(ink)}`);
  // 3 屏内跳到 /s2：换成 /s2 进出、另一端不是 /s1 的
  await fl.locator('input[name="email"]').fill('a@b.co');
  await fl.locator('button[type="submit"]', { hasText: 'Sign in' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  const want2 = expected(s2.id, s1.id);
  await eventually(async () => {
    if (want2 === 0) expect((await edgesEl.count()) === 0, '③ /s2 没有要画的线，canvas 应撤掉');
    else expect((await edgesEl.getAttribute('data-screen')) === s2.id && Number(await edgesEl.getAttribute('data-drawn')) === want2, `③ 应换成 /s2 进出的 ${want2} 条：${await edgesEl.getAttribute('data-screen')} ${await edgesEl.getAttribute('data-drawn')}`);
  });
  // 4 Esc 退出：连线撤掉
  await page.keyboard.press('Escape');
  await eventually(async () => expect((await edgesEl.count()) === 0, '④ 退出交互后连线仍在'));
  // 5 关掉开关：进交互也不画；断链标记仍在；刷新后仍是关
  await page.getByTestId('toggle-links').click();
  await focus('/s1');
  await page.waitForTimeout(1000);
  expect((await edgesEl.count()) === 0, '⑤ 关掉「连线」后进交互仍画了');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await page.locator('[data-testid="screen-card"][data-route="/s1"] .warn').count()) === 1, '⑤ 关掉连线后断链标记消失');
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  expect((await page.getByTestId('toggle-links').getAttribute('aria-pressed')) === 'false', '⑤ 刷新后「连线」开关没保持关');
  // 6 打开；减弱动态下第一次出现就是 done
  await page.getByTestId('toggle-links').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recordStates();
  await focus('/s1');
  await eventually(async () => expect((await edgesEl.count()) === 1, '⑥ 连线没出现'));
  await page.waitForTimeout(300);
  const rm = await states();
  expect(rm.length >= 1 && !rm.includes('growing'), `⑥ 减弱动态下不该有 growing：${JSON.stringify(rm)}`);
  await page.emulateMedia({ reducedMotion: null });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return `/s1 ${want1} 条（${st.join('→')}）（链去 ${ink.out}、链进来 ${ink.in} 像素）；跳到 /s2 ${want2} 条；Esc 撤掉；开关关时不画、刷新保持；减弱动态直接 done`;
});

await step('TC-PROTO-009', async () => {
  needLiveLlm();
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Repair', '--device', 'mobile', '--screens', '2', '--unlinked');
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const before = await apiJson<{ edges: { fromScreenId: string }[] }>(`/v1/projects/${r.projectId}/app-map`);
  await page.getByTestId('repair-links').click();
  await page.getByText('正在为 2 屏接上跳转').waitFor({ timeout: 5000 });
  await page.getByText('接上跳转：把 2 屏的按钮 / 表单连上路由').waitFor({ timeout: 5000 });
  await page.getByText('已更新 2 屏', { exact: false }).first().waitFor({ timeout: 240000 });
  const rev = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${r.projectId}`)).body.screens.find((s) => s.id === r.screens[0].id)!.currentRevisionId;
  const html = await apiJson<{ revision: { htmlUrl: string } }>(`/v1/screens/${r.screens[0].id}/revisions/${rev}`).then((x) => fetch(x.body.revision.htmlUrl).then((y) => y.text()));
  expect(/<(a|button)[^>]*(href|data-href)="\/s\d"[^>]*>\s*Continue/.test(html), '「Continue」按钮补链后仍无跳转目标');
  const after = await apiJson<{ edges: { fromScreenId: string }[] }>(`/v1/projects/${r.projectId}/app-map`);
  expect(after.body.edges.length > before.body.edges.length, `补链后边数未增加（${before.body.edges.length} → ${after.body.edges.length}）`);
  return `边数 ${before.body.edges.length} → ${after.body.edges.length}`;
});

// v0.7：未设计交互只提示、聚焦屏内捏合缩放画布
await step('TC-PROTO-010', async () => {
  await page.goto(`${WEB}/p/${formProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const fl = await focus('/s1');
  await fl.locator('a[href="#"]', { hasText: 'Coming soon' }).click();
  await page.getByText('这个交互还没有设计', { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  expect((await fl.locator('h1').innerText()).startsWith('Screen 1'), '点 # 链接后 iframe 内容变了');
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 被重建');
  const map = await apiJson<{ edges: { href: string }[] }>(`/v1/projects/${formProject}/app-map`);
  expect(!map.body.edges.some((e) => e.href === '#'), 'app-map 出现了 # 边');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
});

await step('TC-PROTO-011', async () => {
  await page.goto(`${WEB}/p/${formProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const fl = await focus('/s1');
  const pct = async () => Math.round(Number((await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform)).match(/scale\(([\d.]+)\)/)?.[1] ?? 0) * 100);
  const z0 = await pct();
  const env = async () => page.evaluate('[window.scrollY, window.visualViewport ? window.visualViewport.scale : 1]') as Promise<[number, number]>;
  await fl.locator('h1').dispatchEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
  await page.waitForTimeout(400);
  const z1 = await pct();
  expect(z1 > z0, `捏合放大后缩放未上升（${z0}% → ${z1}%）`);
  const [sy, vs] = await env();
  expect(sy === 0 && vs === 1, `浏览器被整页缩放/滚动（scrollY=${sy}, scale=${vs}）`);
  expect(await page.getByRole('button', { name: '适配视图' }).isVisible(), '顶栏不可见');
  await fl.locator('h1').dispatchEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
  await page.waitForTimeout(400);
  const z2 = await pct();
  expect(z2 < z1, `捏合缩小后缩放未回落（${z1}% → ${z2}%）`);
  await page.keyboard.press('Escape');
  return `${z0}% → ${z1}% → ${z2}%`;
});

// TC-PROTO-012 叠层屏（REQ-PROTO-005 v0.63）：设为叠层 → 播放时压层 → 后退只关层 → 从叠层跳 push 屏清层；预览域注入透明背景；导出带 data-presentation
await step('TC-PROTO-012', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Overlay', '--device', 'mobile', '--screens', '3');
  const s2 = screens[1];
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  // 1 选中 /s2 → 工具栏「设为叠层」→ 卡片带 overlay 类与「叠层」片；PATCH 落库；预览域下发注入透明背景
  await page.locator('[data-testid="screen-card"][data-route="/s2"] .gesture').click();
  const tp = page.getByTestId('toggle-presentation');
  expect((await tp.getAttribute('aria-label') ?? await tp.innerText()).includes('设为叠层') || (await tp.getAttribute('aria-pressed')) === 'false', '默认应是「设为叠层」');
  await tp.click();
  await page.getByText('已设为叠层屏').waitFor({ timeout: 5000 });
  await page.locator('.card.overlay[data-route="/s2"] .label .chip', { hasText: '叠层' }).waitFor({ timeout: 5000 });
  const d = (await apiJson<{ screens: { id: string; presentation: string; previewUrl: string }[] }>(`/v1/projects/${projectId}`)).body;
  const s2d = d.screens.find((s) => s.id === s2.id)!;
  expect(s2d.presentation === 'overlay', 'presentation 未落库');
  const doc = await (await fetch(s2d.previewUrl.replace('preview.localhost', '127.0.0.1'))).text();
  expect(doc.includes('<style data-quilt-overlay>'), '预览域下发的叠层屏应注入透明背景');
  await page.keyboard.press('Escape');
  // 1b 给叠层 /s2 出一个变体（继承 overlay），5f 用它验叠层上切变体
  const { body: vj } = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': `e2e-ovv-${Date.now()}` }, body: JSON.stringify({ kind: 'generate', input: { prompt: 'error state', count: 1, versions: 1, variantOf: s2.id, variantName: 'err' } }) });
  expect((await waitJob(vj.job.id, 90)).status === 'succeeded', '给 /s2 出变体的作业没成功');
  // 2 聚焦 /s1 → 点「Go to /s2」→ 叠层压在 /s1 上：/s1 的 h1 还在、层里有 /s2 的 h1；角标 /s2
  const fl = await focus('/s1');
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const layer = fl.locator('[data-quilt-overlay-layer="/s2"]');
  expect((await layer.count()) === 1, '应压出一层 /s2');
  expect((await fl.locator('body > h1, body > div > h1').first().innerText().catch(() => '')).startsWith('Screen 1') || (await fl.locator('h1').first().innerText()).startsWith('Screen 1'), '底下的 /s1 应原样留着');
  expect((await layer.locator('h1').first().innerText()).startsWith('Screen 2'), '层里应是 /s2 的内容');
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 不该重建');
  // 3 Alt+← 只关这一层；角标回 /s1
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await layer.count()) === 0, '后退后叠层应消失'));
  // 4 再打开叠层，在层里点「Go to /s3」（push）→ 层清空、DOM 换成 /s3
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await layer.locator('a[href="/s3"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s3' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await fl.locator('[data-quilt-overlay-layer]').count()) === 0 && (await fl.locator('h1').first().innerText()).startsWith('Screen 3'), '跳到 push 屏应清掉叠层并换 DOM'));
  // 5 点遮罩关层：先回到 /s1 开一层，再点层的空白处
  // 5 从 /s3 后退回到叠层：底下必须是来处 /s1，层里是 /s2（v0.65 按栈重摆；此前会把 /s2 当整页换进来）
  await page.keyboard.press('Alt+ArrowLeft'); await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await layer.count()) === 1 && (await fl.locator('#quilt-root, body').first().locator('h1').first().innerText()).startsWith('Screen 1'), '后退到叠层时底下应是 /s1、上面压一层 /s2'));
  // 5b 叠层里指回底下那一屏的链接是关闭：层消失、角标回 /s1、再后退没有东西可退
  await layer.locator('a[href="/s1"]').first().click();
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });

  await eventually(async () => expect((await layer.count()) === 0 && (await fl.locator('h1').first().innerText()).startsWith('Screen 1'), '叠层的关闭链接应关层而不是再跳一次'));
  // 5c 屏里自带的 <script> 在热更新换 DOM 之后也要跑（v0.65；此前换进来的脚本是惰性的）
  const mcp = await connectMcp();
  try {
  const cur = (await apiJson<{ screens: { id: string; route: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((s) => s.route === '/s1')!;
  const patched = await callTool(mcp, 'quilt.patch_screen', { screenId: cur.id, expectedRevisionId: cur.currentRevisionId, edits: [{ find: '</header>', replace: '</header><p id="ran">no</p><script>document.getElementById("ran").textContent = "yes"</script>' }] });
  expect(!patched.isError, `patch_screen 出错：${patched.text.slice(0, 160)}`);
  await fl.locator('#ran', { hasText: 'yes' }).waitFor({ timeout: 15000 });
  // 5d 同一屏再热更新一次：脚本在同一个 window 里第二次执行，顶层 const 不能报「已声明」（v0.66 包块作用域）
  const cur2 = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((s) => s.id === cur.id)!;
  expect(!(await callTool(mcp, 'quilt.patch_screen', { screenId: cur.id, expectedRevisionId: cur2.currentRevisionId, edits: [{ find: 'document.getElementById("ran").textContent = "yes"', replace: 'const ranText = "yes"; document.getElementById("ran").textContent = ranText' }] })).isError, 'patch_screen 第二次出错');
  await fl.locator('#ran', { hasText: 'yes' }).waitFor({ timeout: 15000 });
  const cur3 = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((s) => s.id === cur.id)!;
  expect(!(await callTool(mcp, 'quilt.patch_screen', { screenId: cur.id, expectedRevisionId: cur3.currentRevisionId, edits: [{ find: '>no</p>', replace: '>no</p><i id="v3"></i>' }] })).isError, 'patch_screen 第三次出错');
  await fl.locator('#v3').waitFor({ state: 'attached', timeout: 15000 });
  await eventually(async () => expect((await fl.locator('#ran').innerText()) === 'yes', '同一个 const 第二次执行后 #ran 应仍是 yes'));
  // 5e 叠层开着时底下那一屏更新，关叠层后露出新版本（v0.66）；叠层打开时按 qid 打标记只落在叠层里
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  await eventually(async () => expect((await layer.count()) === 1, '应压出 /s2'));
  const frame = (await (await page.locator('.card.focused iframe').elementHandle())!.contentFrame())!;
  await frame.evaluate(() => window.postMessage({ type: 'quilt:mark', working: ['q1'], done: [] }, '*'));
  await eventually(async () => expect(await frame.evaluate(() => { const el = Array.from(document.querySelectorAll<HTMLElement>('[data-qid="q1"]')).find((e) => e.style.outline.includes('dashed')); return !!el?.closest('[data-quilt-overlay-layer]'); }), '修改中标记应画在叠层里的 q1 上'));
  await frame.evaluate(() => window.postMessage({ type: 'quilt:mark', working: [], done: [] }, '*'));
  const cur4 = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((s) => s.id === cur.id)!;
  expect(!(await callTool(mcp, 'quilt.patch_screen', { screenId: cur.id, expectedRevisionId: cur4.currentRevisionId, edits: [{ find: 'id="v3"', replace: 'id="v4"' }] })).isError, 'patch_screen 第四次出错');
  await page.waitForTimeout(3000);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });
  await eventually(async () => expect((await layer.count()) === 0 && (await fl.locator('#v4').count()) === 1, '关叠层后底下的 /s1 应是新版本'), 10000);
  } finally { await mcp.close(); }
  // 5f 叠层上切变体只换那一层：底下 /s1 还在、仍只有一层（v0.66；此前整屏 swap 把底屏换掉）
  await fl.locator('a[href="/s2"]', { hasText: 'Go to' }).click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  const vchip = page.getByTestId('variant-chip').filter({ hasText: 'err' });
  await vchip.waitFor({ timeout: 5000 });
  const layerBefore = await layer.innerHTML();
  await vchip.click();
  await eventually(async () => expect((await vchip.getAttribute('aria-pressed')) === 'true' && (await fl.locator('[data-quilt-overlay-layer]').count()) === 1 && (await layer.innerHTML()) !== layerBefore && (await fl.locator('#v4').count()) === 1, '切变体后应仍只有一层叠层、层内容换掉、底下 /s1 还在'));
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });
  await eventually(async () => expect((await fl.locator('[data-quilt-overlay-layer]').count()) === 0, '后退应关掉变体那一层'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // 6 导出：/s2 的模板带 data-presentation="overlay"
  const { body: job } = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': `e2e-ov-${Date.now()}` }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
  await waitJob(job.job.id, 90);
  const html = await (await fetch(`${API}/v1/jobs/${job.job.id}/export`)).text();
  expect(html.includes('data-route="/s2" data-name="Screen 2" data-presentation="overlay"') && html.includes('data-quilt-overlay-layer'), '导出应标出 /s2 是叠层且运行时带压层逻辑');
  // 6b 导出原型里的叠层栈（v0.65）：/s1 → /s2(叠层) → /s3 → 后退 → 后退，层数 0 / 1 / 0 / 1 / 0，底下始终是来处
  const file = path.join(EVIDENCE, `run-${RUN}-tc-proto-012-export.html`);
  await writeFile(file, html);
  const ex = await ctx.newPage();
  await ex.goto(`file://${file}`);
  const state = () => ex.evaluate(() => ({ layers: document.querySelectorAll('[data-quilt-overlay-layer]').length, root: document.querySelector('#quilt-root h1')?.textContent ?? '' }));
  const seq: string[] = [];
  const at = async (hash: string | null) => { if (hash === null) await ex.evaluate(() => history.back()); else await ex.evaluate((h) => { location.hash = h; }, hash); await ex.waitForTimeout(400); const s = await state(); seq.push(`${s.layers}:${s.root.trim().split(' ').slice(0, 2).join(' ')}`); };
  await at('#/s1'); await at('#/s2'); await at('#/s3'); await at(null); await at(null);
  expect(seq.join(' | ') === '0:Screen 1 | 1:Screen 1 | 0:Screen 3 | 1:Screen 1 | 0:Screen 1', `导出叠层栈不对：${seq.join(' | ')}`);
  // 6c 直接打开叠层的 hash（分享链接）：起始屏垫在底下、压一层；history.back() 回到起始屏而不是离开文件（v0.66）
  const deep = await ctx.newPage();
  await deep.goto(`file://${file}#/s2`);
  await deep.waitForTimeout(400);
  const d1 = await deep.evaluate(() => ({ layers: document.querySelectorAll('[data-quilt-overlay-layer]').length, root: document.querySelector('#quilt-root h1')?.textContent ?? '' }));
  await deep.evaluate(() => history.back());
  await deep.waitForTimeout(400);
  const d2 = await deep.evaluate(() => ({ layers: document.querySelectorAll('[data-quilt-overlay-layer]').length, root: document.querySelector('#quilt-root h1')?.textContent ?? '', href: location.href }));
  expect(d1.layers === 1 && d1.root.startsWith('Screen 1') && d2.layers === 0 && d2.root.startsWith('Screen 1') && d2.href.startsWith('file:'), `直接打开 #/s2 不对：${JSON.stringify({ d1, d2 })}`);
  await deep.close();
  await ex.close();
  await rm(file, { force: true });
  return '设为叠层落库 + 预览注入透明底；播放压层、后退只关层、从层跳 push 屏清层、后退回叠层按栈重摆、关闭链接关层、热更新后脚本执行且重跑不报已声明；叠层下底屏更新关层即见、标记落在叠层；导出模板带 presentation、导出叠层栈 0/1/0/1/0、直开叠层 hash 垫起始屏、叠层上切变体只换那一层';
});

// TC-PROTO-013 「接上跳转」超过 20 屏分批全发（REQ-PROTO-002 v1.03 UX-2）：25 屏、什么都没选时发两个作业（20 + 5 屏），toast 写明分批
await step('TC-PROTO-013', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'RepairMany', '--device', 'mobile', '--screens', '25', '--no-shot');
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.getByTestId('repair-links').click();
  await page.getByText('正在为 25 屏接上跳转（分 2 批）').waitFor({ timeout: 10000 });
  const jobs = (await apiJson<{ items: { id: string; kind: string; input: { screenIds?: string[] } }[] }>(`/v1/projects/${r.projectId}/jobs`)).body.items.filter((j) => j.kind === 'edit_screens');
  const sizes = jobs.map((j) => j.input.screenIds?.length ?? 0).sort((a, b) => b - a);
  const covered = new Set(jobs.flatMap((j) => j.input.screenIds ?? []));
  expect(sizes.join('+') === '20+5' && covered.size === 25, `应发两个作业（20 + 5 屏）覆盖全部 25 屏：${sizes.join('+')}，覆盖 ${covered.size}`);
  for (const j of jobs) await waitJob(j.id, 240);
  return `两个作业 ${sizes.join(' + ')} 屏，覆盖全部 25 屏`;
});

// TC-PROTO-015～017 导出原型嵌进别的页面（v1.41）：文档工具用 iframe srcdoc（sandbox="allow-scripts allow-forms"）嵌导出件。
// 三条共用一份导出：Embed 项目 3 屏（/s1 → /s2 → /s3 → /s1），/s3 设为叠层
let embedHtml: string | null = null;
const embedExport = async () => {
  if (embedHtml) return embedHtml;
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Embed', '--device', 'mobile', '--screens', '3', '--no-shot');
  const s3 = r.screens.find((s) => s.route === '/s3')!;
  expect((await apiJson(`/v1/screens/${s3.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'overlay' }) })).status === 200, '把 /s3 设为叠层失败');
  const { body } = await apiJson<{ job: { id: string } }>(`/v1/projects/${r.projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': `e2e-embed-${Date.now()}` }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
  await waitJob(body.job.id, 90);
  embedHtml = await (await fetch(`${API}/v1/jobs/${body.job.id}/export`)).text();
  return embedHtml;
};
// 宿主页：iframe 在最上面（390×700），下面垫 3000 px 空白好把它滚出视口；init 脚本也进 srcdoc 文档，先挂好未处理拒绝的计数
type Rej = { __rej: string[] };
const embedHost = async () => {
  const html = await embedExport();
  const file = path.join(EVIDENCE, `run-${RUN}-embed-host.html`);
  await writeFile(file, `<!doctype html><title>host</title><iframe sandbox="allow-scripts allow-forms" style="width:390px;height:700px;border:0" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><div style="height:3000px"></div>`);
  const c = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await c.addInitScript(() => { (window as unknown as Rej).__rej = []; addEventListener('unhandledrejection', (e) => (window as unknown as Rej).__rej.push(String(e.reason))); });
  const p = await c.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`file://${file}`);
  const f = p.frames().find((x) => x !== p.mainFrame())!;
  await f.locator('#quilt-root h1', { hasText: 'Screen 1' }).waitFor({ timeout: 10000 });
  return { p, f, errors, close: async () => { await c.close(); await rm(file, { force: true }); } };
};

// TC-PROTO-015 原型不在视口里时换屏：浏览器不给它出帧，转场排着等，下一次换屏把它挤掉；被跳过的转场不能变成页面报错。
// 两下要去不同的屏（同一个 hash 不触发第二次换屏）：先「Go to /s2」，再点底栏的 /s3（叠层，压在 /s2 上）
await step('TC-PROTO-015', async () => {
  const { p, f, errors, close } = await embedHost();
  try {
    await p.evaluate(() => window.scrollTo(0, 2500));
    await p.waitForTimeout(300);
    for (const sel of ['#quilt-root main a[href="/s2"]', '#quilt-root nav a[href="/s3"]']) { await f.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), sel); await p.waitForTimeout(300); }
    await p.waitForTimeout(500);
    const rej = await f.evaluate(() => (window as unknown as Rej).__rej);
    expect(rej.length === 0 && errors.length === 0, `视口外连着换两屏不应有未处理的拒绝：${JSON.stringify({ rej, errors })}`);
    await p.evaluate(() => window.scrollTo(0, 0));
    await eventually(async () => {
      const s = await f.evaluate(() => ({ h1: document.querySelector('#quilt-root h1')?.textContent ?? '', layers: [...document.querySelectorAll('[data-quilt-overlay-layer]')].map((l) => l.getAttribute('data-quilt-overlay-layer')) }));
      expect(s.h1.startsWith('Screen 2') && s.layers.join() === '/s3', `滚回视口应是 Screen 2 上压一层 /s3：${JSON.stringify(s)}`);
    });
    return '视口外连着换两屏：未处理的拒绝 0、页面错误 0；滚回视口是 Screen 2 上压一层 /s3';
  } finally { await close(); }
});

// TC-PROTO-016 嵌着时换屏不写宿主页的历史：跳转、开叠层、点遮罩关叠层，宿主页 history.length 与地址都不变
await step('TC-PROTO-016', async () => {
  const { p, f, close } = await embedHost();
  try {
    const h0 = await p.evaluate(() => history.length);
    const url0 = p.url();
    const host = async (what: string) => { const h = await p.evaluate(() => history.length); expect(h === h0 && p.url() === url0, `${what}后宿主页历史应仍是 ${h0} 条、地址不变：${h} 条，${p.url()}`); };
    const layers = () => f.evaluate(() => document.querySelectorAll('[data-quilt-overlay-layer]').length);
    await f.locator('#quilt-root a', { hasText: 'Go to /s2' }).click();
    await f.locator('#quilt-root h1', { hasText: 'Screen 2' }).waitFor({ timeout: 5000 });
    await host('跳到 /s2 ');
    await f.locator('#quilt-root a', { hasText: 'Go to /s3' }).click();
    await eventually(async () => expect((await layers()) === 1, '/s3 应压成一层叠层'));
    await host('开 /s3 叠层');
    await f.evaluate(() => (document.querySelector('[data-quilt-overlay-layer]') as HTMLElement).click());
    await eventually(async () => expect((await layers()) === 0, '点遮罩应关掉叠层'));
    expect((await f.locator('#quilt-root h1').innerText()).startsWith('Screen 2'), '关叠层后底下应仍是 Screen 2');
    await host('点遮罩');
    return `跳转、开叠层、点遮罩关叠层后宿主页历史仍是 ${h0} 条，地址不变`;
  } finally { await close(); }
});

// TC-PROTO-017 字体服务连不上时原型照常显示：字体样式表的请求挂着不返回，原型先用回退字体；样式表到了再用上
await step('TC-PROTO-017', async () => {
  const html = await embedExport();
  expect(html.includes('fonts.googleapis.com/css2'), '导出件应引 Google Fonts 样式表');
  const file = path.join(EVIDENCE, `run-${RUN}-tc-proto-017.html`);
  await writeFile(file, html);
  const c = await browser.newContext();
  let hang = true;
  await c.route(/fonts\.googleapis\.com/, (r) => { if (!hang) void r.fulfill({ contentType: 'text/css', body: ':root{--quilt-font-probe:1}' }); });
  try {
    const p1 = await c.newPage();
    await p1.goto(`file://${file}`, { waitUntil: 'commit' });
    await p1.waitForTimeout(3000);
    const s = await p1.evaluate(() => ({ readyState: document.readyState, h1: document.querySelector('#quilt-root h1')?.textContent ?? null }));
    expect(!!s.h1?.startsWith('Screen 1'), `字体样式表挂着时应照常显示 Screen 1：${JSON.stringify(s)}`);
    hang = false;
    const p2 = await c.newPage();
    await p2.goto(`file://${file}`);
    await eventually(async () => expect((await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--quilt-font-probe').trim())) === '1', '字体样式表到了应生效'));
    return `样式表挂着 3 s：显示 Screen 1（readyState ${s.readyState}）；样式表到了即生效`;
  } finally { await c.close(); await rm(file, { force: true }); }
});

await browser.close();
summary();
