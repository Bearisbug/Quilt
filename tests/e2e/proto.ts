import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB } from './lib.ts';

// docs/TEST.md PROTO 域（TC-PROTO-001~006）AI 执行脚本。用法同 core.ts（RUN= / ONLY= / LIVE_LLM=0）。
const RUN = process.env.RUN ?? '005';
const LIVE_LLM = process.env.LIVE_LLM !== '0';
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
let page: import('playwright').Page;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : result === '失败' ? '❌' : '⏭'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  try { const note = await fn(); record(tc, '通过', note ?? ''); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}.png`) }).catch(() => {}); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 300)); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const waitJob = async (jobId: string, maxSec = 180) => {
  for (let i = 0; i < maxSec / 3; i++) { await new Promise((r) => setTimeout(r, 3000)); const { body } = await apiJson<{ job: { status: string; output: Record<string, unknown> } }>(`/v1/jobs/${jobId}`); if (['succeeded', 'failed', 'cancelled'].includes(body.job.status)) return body.job; }
  throw new Error('job timeout');
};

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
  await page.waitForTimeout(500);
  expect((await fl.locator('h1').innerText()).startsWith('Screen 2'), 'iframe 内容未切到 Screen 2');
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 被重建');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  expect((await fl.locator('h1').innerText()).startsWith('Screen 1'), '后退未回到 Screen 1');
  expect((await fl.locator('input[name="address"]').inputValue()) === '上海市', '输入未保留');
  expect((await page.evaluate('history.length') as number) === histBefore, '主站历史被污染');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await page.locator('.card.focused iframe').count()) === 0, 'Esc 未退出');
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
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
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
    await p2.waitForTimeout(400);
    expect(p2.url().endsWith(`#${href}`), `hash 未变为 #${href}`);
    visited.add(href!);
  }
  expect(visited.size >= 3, `仅到达 ${visited.size} 屏`);
  await offline.close();
  return `导出 ${Math.round(html.length / 1024)} KB，离线可跳转 ${visited.size} 屏`;
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
  await page.waitForTimeout(400);
  expect((await fl.locator('h1').innerText()).startsWith('Screen 2'), '表单提交未换到 Screen 2');
  expect((await page.locator('.card.focused iframe').count()) === 1, 'iframe 被重建');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.card.focused .badge', { hasText: '/s1' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  expect((await fl.locator('input[name="email"]').inputValue()) === 'a@b.co', '表单输入未保留');
  await fl.locator('button[data-href="/s3"]').click();
  await page.locator('.card.focused .badge', { hasText: '/s3' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  expect((await fl.locator('h1').innerText()).startsWith('Screen 3'), 'data-href 按钮未换到 Screen 3');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
});

await step('TC-PROTO-008', async () => {
  await page.goto(`${WEB}/p/${formProject}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.locator('[data-testid="link-edges"]').waitFor({ timeout: 5000 });
  const counts = await page.locator('[data-testid="link-edge"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-count'))));
  expect(counts.length >= 4, `连线条数 ${counts.length}，应 ≥ 4（s1→s2、s1→s3、s2→s3、s3→s1）`);
  expect(Math.max(...counts) >= 3, `合并计数最大 ${Math.max(...counts)}，应 ≥ 3`);
  await page.getByTestId('toggle-links').click();
  await page.waitForTimeout(200);
  expect((await page.locator('[data-testid="link-edges"]').count()) === 0, '关闭后连线仍显示');
  expect((await page.locator('[data-testid="screen-card"][data-route="/s1"] .warn').count()) === 1, '关闭连线后断链标记消失');
  await page.getByTestId('toggle-links').click();
  await page.locator('[data-testid="link-edges"]').waitFor({ timeout: 5000 });
  return `${counts.length} 条连线，最大计数 ${Math.max(...counts)}`;
});

await step('TC-PROTO-009', async () => {
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Repair', '--device', 'mobile', '--screens', '2', '--unlinked');
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  const before = await apiJson<{ edges: { fromScreenId: string }[] }>(`/v1/projects/${r.projectId}/app-map`);
  await page.getByTestId('repair-links').click();
  await page.getByText('正在为 2 屏补链').waitFor({ timeout: 5000 });
  await page.getByText('补链：把 2 屏的按钮 / 表单连上路由').waitFor({ timeout: 5000 });
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
  const pct = async () => Number((await page.getByTestId('stat').innerText()).match(/(\d+)%/)?.[1] ?? 0);
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

await browser.close();
console.log(`\n=== RUN-${RUN} PROTO ===`, JSON.stringify(results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {})));
console.log(results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
