// docs/TEST.md CORE 域 · 项目与生成（TC-CORE-003～009）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedJson, apiJson, EVIDENCE, WEB, API, eventually, pickOption } from '../lib.ts';
import { startOpenAiStub } from '../openai-stub.ts';
import { connectMcp, callTool } from '../mcp-client.ts';
import { expect, waitJob, needLiveLlm, Manual } from '../harness.ts';
import { page, browser, RUN, step, shot, blankSpot, verbLine, useStubChannel, brandFirstRun } from './shared.ts';

let petProjectId = '';
await step('TC-CORE-003', async () => {
  await page.goto(`${WEB}/`);
  await page.waitForURL(/\/p\//);
  await page.getByTestId('project-switcher').click();
  await page.getByTestId('new-project').click();
  // 弹窗只问名称与设备形态；种子色不在建项目这一步（REQ-CORE-002）
  const dialog = page.getByRole('dialog');
  expect((await dialog.locator('input[type="color"]').count()) === 0, '新建项目弹窗又出现了取色器');
  expect(!(await dialog.innerText()).includes('种子色'), '新建项目弹窗又出现了种子色字段');
  const fields = await dialog.locator('input:not([type="radio"]), select, textarea').count();
  expect(fields === 1, `弹窗里可填字段不是 1 个（项目名），实际 ${fields} 个`);
  await page.fill('#np-name', 'Pet');
  await page.getByText('手机 390×844').click();
  // 弹窗开在某个项目的画布上，所以要等的是「换到另一个 /p/<id>」，不是「URL 含 /p/」
  const fromPath = new URL(page.url()).pathname;
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/p/') && u.pathname !== fromPath);
  petProjectId = page.url().split('/p/')[1].split('?')[0];
  const { body } = await apiJson<{ project: { deviceType: string }; designSystem: { seedColor: string; tokens: { colors: Record<string, string> }; designMd: string; components: unknown[] } }>(`/v1/projects/${petProjectId}`);
  expect(body.project.deviceType === 'mobile', 'deviceType');
  // 没传种子色也要拿到一套完整可用的设计系统（服务端默认值）
  expect(/^#[0-9A-Fa-f]{6}$/.test(body.designSystem.seedColor), `服务端未回落到默认种子色：${body.designSystem.seedColor}`);
  for (const k of ['primary', 'onPrimary', 'surface', 'onSurface']) expect(body.designSystem.tokens.colors[k], `缺 token ${k}`);
  for (const h of ['## Overview', '## Colors', '## Typography', '## Layout', '## Elevation', '## Shapes', '## Components', "## Do's and Don'ts"]) expect(body.designSystem.designMd.includes(h), `DESIGN.md 缺 ${h}`);
  expect(Array.isArray(body.designSystem.components) && body.designSystem.components.length > 0, 'components 空');
  await shot(page, 'CORE-003');
  return `弹窗只有 1 个可填字段；默认种子色 ${body.designSystem.seedColor} → primary=${body.designSystem.tokens.colors.primary}`;
});

await step('TC-CORE-004', async () => {
  const { status, body } = await apiJson<{ type: string; errors: { path: string }[] }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'X', deviceType: 'tablet' }) });
  expect(status === 400 && body.type === '/errors/validation', `状态 ${status}`);
  expect(body.errors.some((e) => e.path === 'deviceType'), 'errors 未指向 deviceType');
  const list = await apiJson<{ items: { name: string }[] }>('/v1/projects');
  expect(!list.body.items.some((p) => p.name === 'X'), '非法项目被创建');
});

// ---------- 生成与画布 ----------
let petScreens: { id: string; route: string; name: string }[] = [];
await step('TC-CORE-005', async () => {
  needLiveLlm();
  await page.goto(`${WEB}/p/${petProjectId}`);
  await page.fill('#chat-input', '做一个宠物社交 APP');
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 40000 });
  // 这一批造完 = 它的作业 chip 撤掉（成功的写「完成」停 1 s 再淡出）
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="job-chip"]').length === 0, null, { timeout: 150000 });
  await page.waitForFunction(() => { const cards = document.querySelectorAll('[data-testid="screen-card"]'); return cards.length >= 5 && document.querySelectorAll('[data-testid="screen-card"] img').length === cards.length; }, null, { timeout: 60000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  const { body } = await apiJson<{ screens: { id: string; route: string; name: string; lintPassed: boolean; screenshotUrl: string | null; currentRevisionId: string }[] }>(`/v1/projects/${petProjectId}`);
  petScreens = body.screens;
  expect(body.screens.length >= 5, `只有 ${body.screens.length} 屏`);
  for (const s of body.screens) {
    expect(s.lintPassed === true, `${s.route} lint 未过`);
    const rev = await apiJson<{ revision: { htmlUrl: string } }>(`/v1/screens/${s.id}/revisions/${s.currentRevisionId}`);
    const html = await (await fetch(rev.body.revision.htmlUrl)).text();
    const body_ = html.slice(html.indexOf('<body>'));
    expect(!/#[0-9a-fA-F]{6}\b/.test(body_), `${s.route} 含裸色值`);
    expect(html.includes('data-qid="q1"'), `${s.route} 无 data-qid`);
  }
  const usage = await apiJson<{ screens: number; tokensIn: number; tokensOut: number }>('/v1/me/usage');
  expect(usage.body.screens >= body.screens.length && usage.body.tokensIn > 0 && usage.body.tokensOut > 0, '用量未记账');
  await shot(page, 'CORE-005');
  return `${body.screens.length} 屏，截图就绪 ${secs}s，用量 ${usage.body.screens} 屏`;
});

await step('TC-CORE-020', async () => { throw new Manual('对标 Stitch 盲评，AI 按纪律跳过'); });

await step('TC-CORE-007', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Layout', '--device', 'mobile', '--screens', '3');
  // 第 4～6 步（v0.47 多选批量移动）要一张组件卡：放在第 3 屏右侧同一行——放在屏上方会在适配视图后落进排列条那条横带里，点不到
  const comp = (await apiJson<{ component: { id: string } }>(`/v1/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ name: 'Footer', html: '<footer class="p-4 text-sm">Footer</footer>' }) })).body.component;
  await apiJson(`/v1/components/${comp.id}`, { method: 'PATCH', body: JSON.stringify({ x: 1410, y: 0 }) });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.getByRole('button', { name: '适配视图' }).click();
  await page.waitForTimeout(500);
  // 指针：平时是箭头，按住空格才是抓手、平移中是握拳；卡片只在拖动中是握拳
  const cursorOf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).cursor);
  expect((await cursorOf('[data-testid="canvas"]')) === 'default' && (await cursorOf('[data-testid="screen-card"] .gesture')) === 'default', '空闲时指针不是箭头');
  const card = page.locator('[data-testid="screen-card"]').first();
  const before = await card.evaluate((el) => (el as HTMLElement).style.transform);
  const g = (await card.locator('.gesture').boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 300, g.y + g.height / 2 + 120, { steps: 10 });
  expect((await cursorOf('[data-testid="screen-card"] .gesture')) === 'grabbing', '拖动卡片时指针不是握拳');
  await page.mouse.up();

  await eventually(async () => expect((await cursorOf('[data-testid="screen-card"] .gesture')) === 'default', '松开后卡片指针未回到箭头'));
  const after = await card.evaluate((el) => (el as HTMLElement).style.transform);
  expect(before !== after, '卡片未移动');
  const box = (await page.locator('[data-testid="canvas"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 300); await page.keyboard.up('Control');
  await page.keyboard.down('Space');
  expect((await cursorOf('[data-testid="canvas"]')) === 'grab', '按住空格时指针不是抓手');
  await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 200, { steps: 5 });
  expect((await cursorOf('[data-testid="canvas"]')) === 'grabbing', '平移中指针不是握拳');
  await page.mouse.up(); await page.keyboard.up('Space');
  expect((await cursorOf('[data-testid="canvas"]')) === 'default', '松开空格后指针未回到箭头');
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const { body } = await apiJson<{ screens: { id: string; x: number; y: number }[] }>(`/v1/projects/${projectId}`);
  const moved = body.screens.find((s) => s.id === screens[0].id)!;
  expect(moved.x !== 0 || moved.y !== 0, `位置未持久化 (${moved.x},${moved.y})`);
  const persisted = await page.locator('[data-testid="screen-card"]').first().evaluate((el) => (el as HTMLElement).style.transform);
  expect(persisted.includes(`${moved.x}px`), '刷新后位置与 API 不一致');
  // 4 多选批量移动（v0.47）：点第 1 屏，Shift 加选第 2 屏与组件卡，按住第 2 屏拖 → 三者同位移、第 3 屏不动、逐张落库。
  // 第 1 步把第 1 屏拖到了第 2、3 屏身上（后者在 DOM 里更靠后、盖住它的中心点不可点），先经 API 把它摆到一行之下再重载
  await apiJson(`/v1/screens/${screens[0].id}`, { method: 'PATCH', body: JSON.stringify({ x: 0, y: 1400 }) });
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.getByRole('button', { name: '适配视图' }).click();
  await page.waitForTimeout(500);
  const cards = page.locator('[data-testid="screen-card"]');
  const compCard = page.locator('[data-testid="component-card"][data-name="Footer"]');
  const selectedOf = (el: Element) => el.classList.contains('selected');
  const posOf = async () => {
    const b = (await apiJson<{ screens: { id: string; x: number; y: number }[]; components: { id: string; x: number; y: number }[] }>(`/v1/projects/${projectId}`)).body;
    return Object.fromEntries([...b.screens, ...b.components].map((o) => [o.id, { x: o.x, y: o.y }]));
  };
  const pos0 = await posOf();
  await cards.nth(0).locator('.gesture').click();
  await cards.nth(1).locator('.gesture').click({ modifiers: ['Shift'] });
  await compCard.locator('.gesture').click({ modifiers: ['Shift'] });

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 2 && (await compCard.evaluate(selectedOf)), '加选后应选中 2 屏 + 组件'));
  const g2 = (await cards.nth(1).locator('.gesture').boundingBox())!;
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(g2.x + g2.width / 2 + 240, g2.y + g2.height / 2 + 90, { steps: 10 });
  expect((await page.locator('[data-testid="screen-card"].dragging').count()) === 2 && (await compCard.evaluate((el) => el.classList.contains('dragging'))), '拖动中整组卡片都该标 dragging');
  await page.mouse.up();
  await page.waitForTimeout(800);
  const pos1 = await posOf();
  const delta = (id: string) => ({ x: pos1[id].x - pos0[id].x, y: pos1[id].y - pos0[id].y });
  const d = delta(screens[1].id);
  expect(d.x > 0 && d.y > 0, `第 2 屏没动 (${d.x},${d.y})`);
  expect([screens[0].id, comp.id].every((id) => delta(id).x === d.x && delta(id).y === d.y), `第 1 屏 / 组件的位移与第 2 屏不等：${JSON.stringify([delta(screens[0].id), delta(comp.id)])} vs ${JSON.stringify(d)}`);
  expect(delta(screens[2].id).x === 0 && delta(screens[2].id).y === 0, '未选中的第 3 屏不该动');
  // 5 按在已选中的卡片上、没拖过：收成只选它
  await cards.nth(1).locator('.gesture').click();

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1 && (await cards.nth(1).evaluate(selectedOf)) && !(await compCard.evaluate(selectedOf)), '按在已选卡片上没拖过应收成只选它'));
  // 6 ⌘Z 整组还原
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByText('已撤销移动').waitFor({ timeout: 3000 });
  await page.waitForTimeout(800);
  const undone = await posOf();
  expect([screens[0].id, screens[1].id, comp.id].every((id) => undone[id].x === pos0[id].x && undone[id].y === pos0[id].y), `⌘Z 后位置没有整组还原：${JSON.stringify(undone)}`);
  await shot(page, 'CORE-007');
  return `x=${moved.x} y=${moved.y}；整组位移 (${d.x},${d.y})，第 3 屏不动，⌘Z 整组还原`;
});

await step('TC-CORE-008', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Big', '--device', 'mobile', '--screens', '100', '--no-shot');
  // no-shot 的屏无截图（骨架）：100 张骨架卡带循环动画，也是生成进行中的大项目的真实样子。
  // 单开一个 2 倍屏上下文（Mac 的设备像素比）：1 倍屏的光栅量只有四分之一，量不出真机的 GPU 压力
  const hiCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const hi = await hiCtx.newPage();
  try {
    await hi.goto(`${WEB}/p/${projectId}`);
    await hi.locator('[data-testid="screen-card"]').first().waitFor();
    await hi.getByRole('button', { name: '适配视图' }).click();
    await hi.waitForTimeout(800);
    const box = (await hi.locator('[data-testid="canvas"]').boundingBox())!;
    await hi.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 性能追踪（v0.67）：无头下 rAF 帧率恒为 58～60，看不出 GPU 超预算——100 屏卡顿的根因（世界层每帧整层重新光栅化、SVG 连线文字随缩放重排、
    // 小地图每帧重画触发整页重新分层、骨架动画逐帧重绘）都在 GPU 主线程与布局上，按每帧平均耗时断言。滚轮按 16 ms 连发，贴近触控板
    const cdp = await hiCtx.newCDPSession(hi);
    const trace: { name: string; ph: string; dur?: number; tid: number; args?: { name?: string } }[] = [];
    cdp.on('Tracing.dataCollected', (e) => { trace.push(...(e.value as unknown as typeof trace)); });
    const traced = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,toplevel,cc,gpu,blink', transferMode: 'ReportEvents' });
    await hi.evaluate(`(() => { window.__f = 0; window.__long = 0; window.__t0 = performance.now(); const tick = () => { window.__f++; window.__raf = requestAnimationFrame(tick); }; window.__raf = requestAnimationFrame(tick); new PerformanceObserver((l) => { window.__long += l.getEntries().filter(e => e.duration > 100).length; }).observe({ type: 'longtask' }); })()`);
    for (let i = 0; i < 60; i++) { await hi.mouse.wheel(i < 30 ? 30 : -30, 10); await hi.waitForTimeout(16); }
    await hi.keyboard.down('Control'); for (let i = 0; i < 60; i++) { await hi.mouse.wheel(0, i < 30 ? -8 : 8); await hi.waitForTimeout(16); } await hi.keyboard.up('Control');
    const r = await hi.evaluate(`(() => { cancelAnimationFrame(window.__raf); const dt = (performance.now() - window.__t0) / 1000; return { fps: Math.round(window.__f / dt), frames: window.__f, long: window.__long, dt: +dt.toFixed(1) }; })()`) as { fps: number; frames: number; long: number; dt: number };
    await cdp.send('Tracing.end'); await traced; await cdp.detach();
    const threads: Record<number, string> = {}; for (const e of trace) if (e.ph === 'M' && e.name === 'thread_name') threads[e.tid] = e.args?.name ?? '';
    const ms = (pick: (e: (typeof trace)[number]) => boolean) => trace.filter((e) => e.ph === 'X' && pick(e)).reduce((n, e) => n + (e.dur ?? 0), 0) / 1000;
    const gpuPerFrame = ms((e) => e.name === 'RunTask' && threads[e.tid] === 'CrGpuMain') / r.frames;
    const layoutPerFrame = ms((e) => e.name === 'Layout') / r.frames;
    // 结构：连线计数不是 SVG 文字、小地图是 canvas、世界层停下后不留 will-change
    await hi.waitForTimeout(400);
    const shape = await hi.evaluate(`({ svgText: document.querySelectorAll('.world svg text').length, minimap: document.querySelector('[data-testid="minimap"]')?.tagName, moving: document.querySelector('.world').classList.contains('moving') })`) as { svgText: number; minimap?: string; moving: boolean };
    const cards = await hi.locator('[data-testid="screen-card"]').count();
    await hi.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-core-008.png`) });
    expect(r.fps >= 55, `fps=${r.fps}`);
    expect(r.long === 0, `长任务 ${r.long}`);
    expect(gpuPerFrame <= 4, `GPU 主线程每帧 ${gpuPerFrame.toFixed(1)} ms（> 4 ms：120 Hz 下每帧只有 8.3 ms，还要留给合成与页面主线程）`);
    expect(layoutPerFrame <= 0.5, `布局每帧 ${layoutPerFrame.toFixed(2)} ms（> 0.5 ms：有东西随缩放重排）`);
    expect(shape.svgText === 0 && shape.minimap === 'CANVAS' && !shape.moving, `渲染结构不对：${JSON.stringify(shape)}`);
    return `${cards} 屏（2 倍屏）${r.fps} fps / ${r.dt}s，长任务 ${r.long}；每帧 GPU 主线程 ${gpuPerFrame.toFixed(1)} ms、布局 ${layoutPerFrame.toFixed(2)} ms`;
  } finally { await hiCtx.close(); }
});

// TC-CORE-083 屏里的 dark: 变体按屏自己的配色判（v0.89）：Play CDN 默认按看的人的系统偏好判，亮色项目在暗色系统里开交互态，
// 白色 logo（hidden dark:block）落在白底上；截图浏览器是亮色偏好，截出来又是黑色那版
await step('TC-CORE-083', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'DarkVariant', '--device', 'mobile', '--screens', '0', '--no-shot');
  const html = '<div class="min-h-dvh bg-background p-6"><div data-v="light" class="w-24 h-24 bg-primary dark:hidden"></div><div data-v="dark" class="hidden w-24 h-24 bg-error dark:block"></div></div>';
  const bad: string[] = [];
  const screenOf = async (sid: string) => (await apiJson<{ screens: { id: string; previewUrl: string; screenshotUrl: string | null; currentRevisionId: string }[]; designSystem: { tokens: { colors: Record<string, string> } } }>(`/v1/projects/${projectId}`)).body;
  // 预览文档在给定系统偏好下哪一版显示（等 Tailwind 生效：w-24 = 96px）
  const shownIn = async (url: string, scheme: 'light' | 'dark') => {
    const c = await browser.newContext({ colorScheme: scheme });
    try {
      const p = await c.newPage(); await p.goto(url);
      await p.waitForFunction(`getComputedStyle(document.querySelector('[data-v=light]')).width === '96px'`, null, { timeout: 20_000 });
      return (await p.evaluate(`['light', 'dark'].filter((v) => getComputedStyle(document.querySelector('[data-v=' + v + ']')).display !== 'none').join(',')`)) as string;
    } finally { await c.close(); }
  };
  // 截图里方块中心（p-6 + w-24 的中心 = 72 CSS px，截图 2 倍）的颜色更接近哪个 token
  const shotVariant = async (shotUrl: string, colors: Record<string, string>) => {
    const b64 = Buffer.from(await (await fetch(shotUrl)).arrayBuffer()).toString('base64');
    const rgb = (await page.evaluate(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); r(Array.from(g.getImageData(144, 144, 1, 1).data.slice(0, 3))); }; i.src = 'data:image/png;base64,${b64}'; })`)) as number[];
    const dist = (hex: string) => { const n = parseInt(hex.slice(1), 16); return Math.abs((n >> 16) - rgb[0]) + Math.abs(((n >> 8) & 255) - rgb[1]) + Math.abs((n & 255) - rgb[2]); };
    return dist(colors.primary) <= dist(colors.error) ? 'light' : 'dark';
  };
  const waitShot = async (sid: string, rev: string) => {
    for (let i = 0; i < 60; i++) { const d = await screenOf(sid); const s = d.screens.find((x) => x.id === sid)!; if (s.currentRevisionId === rev && s.screenshotUrl) return { s, d }; await new Promise((r) => setTimeout(r, 1000)); }
    throw new Error('截图 60 s 内未就绪');
  };
  const mcp = await connectMcp();
  try {
    const created = await callTool(mcp, 'quilt.create_screen', { projectId, name: 'Variant', route: '/variant', html });
    expect(!created.isError, `推屏失败：${created.text.slice(0, 200)}`);
    const { screenId: sid, revisionId } = created.json as { screenId: string; revisionId: string };
    // 1 亮色配色：系统暗色、亮色偏好下都只显示亮色那版；截图同样
    let { s, d } = await waitShot(sid, revisionId);
    for (const scheme of ['dark', 'light'] as const) { const v = await shownIn(s.previewUrl, scheme); if (v !== 'light') bad.push(`亮色配色、系统${scheme === 'dark' ? '暗色' : '亮色'}偏好下显示的是「${v}」`); }
    const v1 = await shotVariant(s.screenshotUrl!, d.designSystem.tokens.colors);
    if (v1 !== 'light') bad.push(`亮色配色的截图里是「${v1}」那版`);
    // 2 切到暗色色板并回刷：两种系统偏好下都只显示暗色那版；截图同样
    const ds = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${projectId}`)).body.designSystem;
    const put = await apiJson(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify({ palette: { light: {}, dark: { background: '#111820', onBackground: '#E1E2E8' } }, colorMode: 'dark', expectedVersion: ds.version }) });
    expect(put.status === 200, `切暗色色板 ${put.status}`);
    const job = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: 'all' } }) });
    expect((await waitJob(job.body.job.id, 90)).status === 'succeeded', '回刷作业没成功');
    const rev2 = (await screenOf(sid)).screens.find((x) => x.id === sid)!.currentRevisionId;
    ({ s, d } = await waitShot(sid, rev2));
    for (const scheme of ['light', 'dark'] as const) { const v = await shownIn(s.previewUrl, scheme); if (v !== 'dark') bad.push(`暗色配色、系统${scheme === 'dark' ? '暗色' : '亮色'}偏好下显示的是「${v}」`); }
    const v2 = await shotVariant(s.screenshotUrl!, d.designSystem.tokens.colors);
    if (v2 !== 'dark') bad.push(`暗色配色的截图里是「${v2}」那版`);
    expect(!bad.length, `${bad.length} 处不符：${bad.join('；')}`);
    return '亮色配色两种系统偏好下与截图都是亮色那版；切暗色色板回刷后都是暗色那版';
  } finally { await mcp.close(); }
});

// TC-CORE-080 缩放不建拆合成层、内容不拆碎、视口外骨架不占层（v0.84）。整屏闪白本身无头下只能抽帧碰运气，
// 这里断言它的成因：手势一开始世界层若是新建的，第一帧图块没栅格化，整块画布被画成白色
await step('TC-CORE-080', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Layers', '--device', 'desktop', '--screens', '25');
  // 摊开成稀疏的大画布（行列间隔 2800，同 Omnivia 那种分组摆法）：内容越分散，浏览器越倾向于把独立合成的世界层拆碎；
  // 也让大部分卡落在懒加载的距离之外、显示骨架
  const { body: { screens } } = await apiJson<{ screens: { id: string }[] }>(`/v1/projects/${projectId}`);
  for (const [i, s] of screens.entries()) await apiJson(`/v1/screens/${s.id}`, { method: 'PATCH', body: JSON.stringify({ x: (i % 5) * 2800, y: Math.floor(i / 5) * 2800 }) });
  const hiCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const hi = await hiCtx.newPage();
  try {
    await hi.goto(`${WEB}/p/${projectId}`);
    await hi.locator('[data-testid="screen-card"]').first().waitFor();
    await eventually(async () => expect((await hi.locator('[data-testid="screen-card"] img.shot:not(.pending)').count()) > 0, '截图还没出来'), 120_000);
    const layers = async () => {
      const c = await hiCtx.newCDPSession(hi);
      await c.send('LayerTree.enable');
      const ev = await new Promise<{ layers?: unknown[] }>((res) => { c.once('LayerTree.layerTreeDidChange', (e: { layers?: unknown[] }) => res(e)); setTimeout(() => res({}), 3000); });
      await c.detach();
      return ev.layers?.length ?? -1;
    };
    // 1 放大到 100%、只看得见一两张卡：其余卡的截图懒加载没取、显示骨架，它们不该各占合成层
    await hi.evaluate(`localStorage.setItem('quilt:view:${projectId}', JSON.stringify({ x: 40, y: 60, zoom: 1 }))`);
    await hi.reload(); await hi.locator('[data-testid="screen-card"]').first().waitFor(); await hi.waitForTimeout(1500);
    const zoomedIn = await layers();
    // 2 适配视图后静止 vs 手势中（世界层挂上 moving 类 = 平移缩放进行中的状态）
    await hi.keyboard.press('f'); await hi.waitForTimeout(1200);
    const rest = await layers();
    await hi.evaluate(`document.querySelector('.world').classList.add('moving')`); await hi.waitForTimeout(300);
    const moving = await layers();
    await hi.evaluate(`document.querySelector('.world').classList.remove('moving')`);
    await hi.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-core-080.png`) });
    expect(zoomedIn > 0 && zoomedIn <= 40, `放大到 100% 时合成层 ${zoomedIn} 个（> 40：视口外的骨架卡各占了层）`);
    expect(rest > 0 && Math.abs(moving - rest) <= 2, `合成层静止 ${rest}、手势中 ${moving}（放大到 100% 时 ${zoomedIn}）：手势一开始就新建、拆碎合成层，第一帧画布整块闪白`);
    return `25 屏（2 倍屏）放大到 100% 时 ${zoomedIn} 层；适配视图静止 ${rest} 层、手势中 ${moving} 层`;
  } finally { await hiCtx.close(); }
});

// TC-CORE-081 高速缩小不缺图块（v0.86）：手势中栅格比例冻在开始时的缩放上，从放大态快速缩小，新露出来的区域按高比例现画，
// 显存放不下也来不及画，卡片整块空着。无头下抽帧看得见但不好断言，改数性能追踪里每帧的 missing tiles
await step('TC-CORE-081', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'FastZoom', '--device', 'desktop', '--screens', '25');
  const { body: { screens } } = await apiJson<{ screens: { id: string }[] }>(`/v1/projects/${projectId}`);
  for (const [i, s] of screens.entries()) await apiJson(`/v1/screens/${s.id}`, { method: 'PATCH', body: JSON.stringify({ x: (i % 5) * 1700, y: Math.floor(i / 5) * 1400 }) });
  const hiCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const hi = await hiCtx.newPage();
  try {
    await hi.goto(`${WEB}/p/${projectId}`);
    await hi.locator('[data-testid="screen-card"]').first().waitFor();
    await hi.keyboard.press('f');
    await eventually(async () => expect((await hi.locator('[data-testid="screen-card"] img.shot:not(.pending)').count()) === 25, '25 张截图还没都解码'), 120_000);
    await hi.waitForTimeout(1500);
    const cdp = await hiCtx.newCDPSession(hi);
    const wheel = (dy: number, x: number, y: number) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2 });
    await browser.startTracing(hi, { categories: ['benchmark'] });
    for (const [x, y] of [[500, 380], [900, 500], [700, 300]]) {
      for (let i = 0; i < 30; i++) { await wheel(-12, x, y); await hi.waitForTimeout(8); }
      await hi.waitForTimeout(400);
      for (let i = 0; i < 30; i++) { await wheel(12, x, y); await hi.waitForTimeout(8); }
      await hi.waitForTimeout(400);
    }
    const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; args?: Record<string, number> }[] };
    await cdp.detach();
    const frames = trace.traceEvents.filter((e) => e.name === 'LayerTreeHostImpl::CalculateRenderPasses' && e.args && 'missing tiles' in e.args);
    const bad = frames.map((e) => e.args!['missing tiles']).filter((n) => n > 0);
    expect(frames.length > 0, '追踪里没有 CalculateRenderPasses（类别没开对）');
    expect(bad.length <= 2 && Math.max(0, ...bad) <= 16, `${frames.length} 帧里 ${bad.length} 帧缺图块，单帧最多 ${Math.max(0, ...bad)} 块（卡片整块空着）`);
    return `三轮快速放大—缩小共 ${frames.length} 帧，缺图块 ${bad.length} 帧${bad.length ? `、单帧最多 ${Math.max(...bad)} 块` : ''}`;
  } finally { await hiCtx.close(); }
});

// TC-CORE-086 大项目缩放与拖卡不掉帧（v1.02 ADR-029）：68 屏桌面真截图（2 倍屏原图 2560×1600）、每屏侧栏链到其后 10 屏（连同底栏与「下一屏」，合并后约 900 条连线）。
// 改前（RUN-243 拷进测试库的 Shopilot 68 屏 / 706 条）：缩放一个来回解码 3.3 s、超过 50 ms 的长任务 7 次（最长 209 ms）；拖卡 48 / 82 帧超过 33 ms；点选 21 / 63
await step('TC-CORE-086', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Dense', '--device', 'desktop', '--screens', '68', '--grid', '9', '--nav', '10');
  const hiCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const hi = await hiCtx.newPage();
  const bad: string[] = [];
  const check = (ok: unknown, msg: string) => { if (!ok) bad.push(msg); };
  const shown = () => hi.evaluate(`[...document.querySelectorAll('[data-testid="screen-card"] img.shot:not(.pending)')].map((i) => ({ thumb: i.src.includes('.thumb.webp'), on: i.closest('[data-testid="screen-card"]').hasAttribute('data-onscreen') }))`) as Promise<{ thumb: boolean; on: boolean }[]>;
  const edges = () => hi.evaluate(`(() => { const c = document.querySelector('[data-testid="link-edges"]'); return c && { total: +c.dataset.total, drawn: +c.dataset.drawn }; })()`) as Promise<{ total: number; drawn: number } | null>;
  // rAF 帧间隔：手势前开、手势后收，数超过 33 ms 的
  const rafStart = () => hi.evaluate(`window.__gaps = []; window.__last = 0; (function loop(t) { if (window.__last) window.__gaps.push(t - window.__last); window.__last = t; window.__raf = requestAnimationFrame(loop); })(0)`);
  const rafStop = () => hi.evaluate(`(cancelAnimationFrame(window.__raf), { frames: window.__gaps.length, slow: window.__gaps.filter((g) => g > 33).length })`) as Promise<{ frames: number; slow: number }>;
  const cardCenters = () => hi.locator('[data-testid="screen-card"][data-onscreen] .gesture').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  // 期望值按项目的连线算（同一对屏合并、断链与自环不算），不手写：种子的底栏与「下一屏」也连线
  const { body: detail } = await apiJson<{ screens: { id: string; route: string; screenshotUrl: string | null }[]; links: { fromScreenId: string; toScreenId: string | null }[] }>(`/v1/projects/${projectId}`);
  const pairs = new Set(detail.links.filter((l) => l.toScreenId && l.toScreenId !== l.fromScreenId).map((l) => `${l.fromScreenId}>${l.toScreenId}`));
  const touching = (id: string) => [...pairs].filter((k) => k.startsWith(`${id}>`) || k.endsWith(`>${id}`)).length;
  // 冷启动时截图浏览器取 Tailwind CDN 慢，种子偶尔丢头一两张截图（RUN-244）：按有截图的屏数等，至少 60 张才算大项目
  const withShot = detail.screens.filter((s) => s.screenshotUrl).length;
  expect(withShot >= 60 && pairs.size > 200, `前置不成立：有截图的屏 ${withShot}、连线 ${pairs.size}`);
  try {
    await hi.goto(`${WEB}/p/${projectId}`);
    await hi.locator('[data-testid="screen-card"]').first().waitFor();
    // 1 全景：有截图的卡都出图且都是缩略图；连线一条不画，顶部提示
    await eventually(async () => expect((await shown()).length === withShot, `全景下 ${withShot} 张截图还没都显示（${(await shown()).length}）`), 60_000);
    const s1 = await shown();
    check(s1.every((x) => x.thumb), `全景下应全部用缩略图：原图 ${s1.filter((x) => !x.thumb).length} 张`);
    const e1 = await edges();
    check(e1 && e1.total === pairs.size && e1.drawn === 0, `${pairs.size} 条连线、没选屏时一条不画：${JSON.stringify(e1)}`);
    check(((await hi.getByTestId('links-hint').textContent().catch(() => '')) ?? '').includes(`共 ${pairs.size} 条连线`), `没选屏时顶部应提示「共 ${pairs.size} 条连线，选中屏后只显示它进出的」`);
    await hi.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-core-086-fit.png`) });
    const box = (await hi.locator('[data-testid="canvas"]').boundingBox())!;
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    await hi.mouse.move(cx, cy);
    // 2 Ctrl+滚轮缩放一个来回（全景 → 约 160% → 全景，80 步）：图片解码合计 ≤ 500 ms，没有超过 100 ms 的长任务
    const cdp = await hiCtx.newCDPSession(hi);
    const trace: { name: string; ph: string; dur?: number }[] = [];
    cdp.on('Tracing.dataCollected', (e) => { trace.push(...(e.value as unknown as typeof trace)); });
    const traced = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,toplevel,cc,blink', transferMode: 'ReportEvents' });
    await hi.evaluate(`window.__long = 0; new PerformanceObserver((l) => { window.__long += l.getEntries().filter((e) => e.duration > 100).length; }).observe({ type: 'longtask' })`);
    await hi.keyboard.down('Control');
    for (let i = 0; i < 80; i++) { await hi.mouse.wheel(0, i < 40 ? -12 : 12); await hi.waitForTimeout(8); }
    await hi.keyboard.up('Control');
    await hi.waitForTimeout(1500);
    await cdp.send('Tracing.end'); await traced; await cdp.detach();
    const decodeMs = trace.filter((e) => e.ph === 'X' && (e.name === 'ImageDecodeTask' || e.name === 'Decode Image')).reduce((n, e) => n + (e.dur ?? 0), 0) / 1000;
    const long = await hi.evaluate('window.__long') as number;
    check(decodeMs <= 500, `缩放一个来回图片解码合计 ${Math.round(decodeMs)} ms（> 500）`);
    check(long === 0, `缩放一个来回出现 ${long} 次超过 100 ms 的长任务`);
    // 3 全景下拖视口中央那张卡 60 步：超过 33 ms 的帧 ≤ 5
    const centers = await cardCenters();
    centers.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    const c0 = centers[0];
    await rafStart();
    await hi.mouse.move(c0.x, c0.y); await hi.mouse.down();
    for (let i = 1; i <= 60; i++) { await hi.mouse.move(c0.x + i * 3, c0.y + i * 2); await hi.waitForTimeout(8); }
    await hi.mouse.up();
    const drag = await rafStop();
    check(drag.slow <= 5, `拖卡 ${drag.frames} 帧里 ${drag.slow} 帧超过 33 ms（> 5）`);
    // 4 依次点选 12 张卡：超过 33 ms 的帧 ≤ 3；只画最后选中的那屏进出的连线，提示消失
    await hi.waitForTimeout(500);
    const picks = (await cardCenters()).slice(0, 12);
    await rafStart();
    for (const p of picks) { await hi.mouse.click(p.x, p.y); await hi.waitForTimeout(120); }
    const sel = await rafStop();
    check(sel.slow <= 3, `点选 ${sel.frames} 帧里 ${sel.slow} 帧超过 33 ms（> 3）`);
    const e4 = await edges();
    const pickedRoute = await hi.locator('.card.selected').getAttribute('data-route');
    const picked = detail.screens.find((s) => s.route === pickedRoute)!;
    check(e4 && e4.drawn === touching(picked.id), `选中 ${picked.route} 后只画它进出的 ${touching(picked.id)} 条：${JSON.stringify(e4)}`);
    check((await hi.getByTestId('links-hint').count()) === 0, '选中屏后提示应消失');
    await hi.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-core-086-selected.png`) });
    // 5 放大到 100% 左右停住：视口里的卡换原图、视口外的仍是缩略图；缩回全景当帧降回缩略图
    await hi.keyboard.press('Escape');
    await hi.mouse.move(cx, cy);
    await hi.keyboard.down('Control');
    for (let i = 0; i < 30; i++) { await hi.mouse.wheel(0, -12); await hi.waitForTimeout(8); }
    await hi.keyboard.up('Control');
    await eventually(async () => { const s = await shown(); expect(s.some((x) => x.on && !x.thumb), '放大停住后视口里的卡还没换上原图'); }, 10_000).catch(() => {});
    const s5 = await shown();
    const wrong = s5.filter((x) => x.on === x.thumb);
    check(s5.some((x) => x.on) && !wrong.length, `放大后应只有视口里的卡用原图：视口里 ${s5.filter((x) => x.on).length} 张，档位不对 ${wrong.length} 张`);
    await hi.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-core-086-zoomed.png`) });
    await hi.keyboard.down('Control');
    for (let i = 0; i < 30; i++) { await hi.mouse.wheel(0, 12); await hi.waitForTimeout(8); }
    await hi.keyboard.up('Control');
    await eventually(async () => expect((await shown()).every((x) => x.thumb), '缩回全景后应全部降回缩略图'), 5_000).catch(() => check(false, '缩回全景后应全部降回缩略图'));
    if (bad.length) throw new Error(bad.join('；'));
    return `${pairs.size} 条连线、${withShot} 张截图；缩放一个来回解码 ${Math.round(decodeMs)} ms、长任务 ${long}；拖卡 ${drag.slow}/${drag.frames}、点选 ${sel.slow}/${sel.frames} 帧超过 33 ms；放大后视口里 ${s5.filter((x) => x.on).length} 张换原图`;
  } finally { await hiCtx.close(); }
});

// TC-CORE-082 事件流假死时作业照样收尾（v0.88）：经 Vite 代理时 API 重启，代理不关浏览器这一侧，EventSource 停在 open、
// 再也收不到任何事件（连 ping 都没有）；作业在服务端早结束了，chip 还挂着「排队中…」。无头下用包一层 EventSource 的探针
// 把当前这条流冻住（只丢事件、不断开），模拟代理那一侧的假死
await step('TC-CORE-082', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Frozen', '--device', 'mobile', '--screens', '1', '--no-shot');
  const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fctx.addInitScript(`(() => { const O = window.EventSource; window.__sseCount = 0; function W(u, i) { const es = new O(u, i); window.__sseCount += 1; window.__sseLast = es; const add = es.addEventListener.bind(es); es.addEventListener = (t, fn, o) => add(t, (ev) => { if (!es.__frozen) fn(ev); }, o); return es; } W.prototype = O.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSED = 2; window.EventSource = W; window.__freezeSse = () => { window.__sseLast.__frozen = true; }; })()`);
  const fp = await fctx.newPage();
  try {
    await fp.goto(`${WEB}/p/${projectId}`);
    await fp.locator('[data-testid="screen-card"]').first().waitFor();
    await useStubChannel(fp, { port: 3981, label: 'Stub 假死 82', holdMs: 1500 });
    await fp.waitForFunction('window.__sseLast && window.__sseLast.readyState === 1');
    const before = (await fp.evaluate('window.__sseCount')) as number;
    await fp.evaluate('window.__freezeSse()');
    await fp.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
    await fp.fill('#chat-input', '标题改成「假死测试」');
    const created = fp.waitForResponse((r) => r.request().method() === 'POST' && /\/v1\/projects\/[^/]+\/messages$/.test(r.url()));
    await fp.keyboard.press('Enter');
    const jobId = ((await (await created).json()) as { job: { id: string } }).job.id;
    const chip = fp.locator(`[data-testid="job-chip"][data-job-id="${jobId}"]`);
    await chip.waitFor({ timeout: 5000 });
    const t0 = Date.now();
    await eventually(async () => expect((await apiJson<{ job: { status: string } }>(`/v1/jobs/${jobId}`)).body.job.status === 'succeeded', '作业没在服务端跑完'), 30_000);
    // 流冻住时画布收不到终态：要靠自己发现这条流死了、重连后对账把行撤掉
    await chip.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    const secs = Math.round((Date.now() - t0) / 1000);
    const after = (await fp.evaluate('window.__sseCount')) as number;
    const stuck = (await chip.count()) ? (await chip.innerText()).replace(/\s+/g, ' ') : '';
    expect(!stuck, `作业在服务端早已 succeeded，${secs} s 后 chip 还挂着「${stuck}」（流冻住后开流 ${before} → ${after} 次）`);
    expect(after > before, 'chip 撤掉了，但冻住的事件流没有重建');
    return `流冻住后 ${secs} s 撤掉作业 chip（开流 ${before} → ${after} 次）`;
  } finally { await fctx.close(); }
});

await step('TC-CORE-023', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'ShellCheck', '--device', 'mobile', '--screens', '4');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  // 第 7 步量的是带屏数 / 版数档位的输入框（模型通道），stub 轮次没有云端通道时自己建一条
  await useStubChannel(page, { port: 3986, label: 'Stub 输入框 23' });
  await page.waitForTimeout(800);

  // 1 三处 chrome 两两不重叠（v1.17 去掉对话记录）
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [name, sel] of [['顶栏', 'header'], ['输入框', 'form.composer'], ['工具栏', '[role="toolbar"]']] as const) {
    const b = await page.locator(sel).first().boundingBox();
    expect(b, `${name}未渲染`); boxes[name] = b!;
  }
  for (const [an, a] of Object.entries(boxes)) for (const [bn, b] of Object.entries(boxes)) {
    if (an >= bn) continue;
    expect(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), `${an} 与 ${bn} 重叠`);
  }

  // 2 顶栏不铺底（v1.10，§13.1）：没有底色、边线与模糊，盒子只包住左上角的项目切换器 chip；chip 是毛玻璃（v1.15），左缘与小地图对齐；
  //   chip 右边同一高度的位置指针落到画布上，不被顶栏拦住
  const hd = await page.locator('header').first().evaluate((el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const chip = document.querySelector('[data-testid="project-switcher"]')!; const c = chip.getBoundingClientRect();
    const probe = document.createElement('div'); probe.style.color = 'var(--semantic-material-chrome-tint)'; document.body.appendChild(probe);
    const panel = getComputedStyle(probe).color; probe.remove();
    const mini = document.querySelector('[data-testid="minimap"]')?.getBoundingClientRect();
    const right = document.elementFromPoint(c.right + 120, c.top + c.height / 2);
    return { bg: cs.backgroundColor, filter: cs.backdropFilter, border: cs.borderBottomWidth, width: r.width, chipBg: getComputedStyle(chip).backgroundColor, chipFilter: getComputedStyle(chip).backdropFilter, panel, chipLeft: c.left, miniLeft: mini?.left ?? null, rightIsHeader: !!right?.closest('header') };
  });
  expect(/rgba\(0, 0, 0, 0\)|transparent/.test(hd.bg) && hd.filter === 'none' && hd.border === '0px', `顶栏应不铺底、无边线、不模糊：${JSON.stringify(hd)}`);
  expect(hd.chipBg === hd.panel && hd.chipFilter.includes('blur') && !hd.rightIsHeader && hd.width < 400, `项目切换器应是毛玻璃 chip、顶栏只包住它：${JSON.stringify(hd)}`);
  expect(hd.miniLeft === null || Math.abs(hd.miniLeft - hd.chipLeft) <= 0.5, `项目切换器 chip 与小地图左缘没对齐：${hd.chipLeft} vs ${hd.miniLeft}`);

  // 3 工具栏命中区与 roving tabindex
  const hits = await page.locator('[role="toolbar"] button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { n: e.getAttribute('aria-label'), w: r.width, h: r.height, t: e.getAttribute('tabindex') }; }));
  expect(hits.length > 0 && hits.every((x) => x.w >= 44 && x.h >= 44), `命中区不足 44：${JSON.stringify(hits.filter((x) => x.w < 44 || x.h < 44))}`);
  expect(hits.filter((x) => x.t === '0').length === 1, `工具栏 Tab 停靠点不是 1 个`);
  await page.locator('[role="toolbar"] button[tabindex="0"]').focus();
  const f0 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('ArrowDown');
  const f1 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  expect(f0 !== f1 && !!f1, `方向键未在组内移动焦点（${f0} → ${f1}）`);

  // 3b 窗口矮到放不下全部工具（v0.70）：工具栏封顶在可用区内、列内滚动、滚动条不可见；底边露出向下的小箭头提示还有（v1.11）；End 跳到最后一个工具，
  //    它滚进可见区且四周留出焦点环的 4 px，箭头换到顶边
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.waitForTimeout(400);
  const rail = () => page.evaluate(() => {
    const r = document.querySelector('[role="toolbar"]') as HTMLElement; const pill = r.parentElement!.getBoundingClientRect(); const rr = r.getBoundingClientRect();
    const f = (document.activeElement as HTMLElement | null)?.closest('[role="toolbar"]') ? document.activeElement!.getBoundingClientRect() : null;
    return { pillBottom: pill.bottom, vh: innerHeight, scrollable: r.scrollHeight > r.clientHeight, bar: r.offsetWidth - r.clientWidth, fade: r.dataset.fade ?? '', more: [...document.querySelectorAll<HTMLElement>('[data-testid="rail-more"]')].map((e) => e.dataset.side).join(' '),
      room: f ? Math.min(f.top - rr.top, rr.bottom - f.bottom, f.left - rr.left, rr.right - f.right) : null, last: document.activeElement === [...r.querySelectorAll('button')].pop() };
  });
  await page.locator('[role="toolbar"] button[tabindex="0"]').focus();
  await page.keyboard.press('Home');
  const top = await rail();
  expect(top.pillBottom < top.vh && top.scrollable && top.bar === 0 && top.fade === 'bottom' && top.more === 'bottom', `矮窗口下工具栏没在列内滚动或提示不对：${JSON.stringify(top)}`);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const end = await rail();
  expect(end.last && end.fade === 'top' && end.more === 'top' && (end.room ?? -1) >= 3.5, `End 后最后一个工具应可见、焦点环不被裁、箭头在顶边：${JSON.stringify(end)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // 4 悬停提示要给出作用说明与快捷键，且不能被工具栏的滚动容器裁掉
  await page.locator('[data-testid="repair-links"]').hover();
  await page.locator('[data-testid="tool-tip"]').waitFor({ timeout: 3000 });
  const tip = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="tool-tip"]')!.getBoundingClientRect();
    const r = document.querySelector('.rail')!.getBoundingClientRect();
    return { text: (document.querySelector('[data-testid="tool-tip"]') as HTMLElement).innerText, left: t.left, railLeft: r.left, w: t.width };
  });
  expect(tip.left >= 0 && tip.w > 100 && tip.left < tip.railLeft, `提示被裁或位置异常：${JSON.stringify(tip)}`);
  expect(tip.text.includes('接上跳转') && tip.text.length > 20, `提示缺作用说明：${tip.text}`);
  await page.locator('[data-testid="toggle-links"]').hover();
  expect((await page.locator('[data-testid="tool-tip"]').innerText()).includes('L'), '提示未给出快捷键');
  await page.locator('[data-testid="canvas"]').hover();

  // 5 快捷键分档：单键只给可撤销的视图操作，开面板的必须带 Alt（防误触）
  const lp0 = await page.locator('[data-testid="toggle-links"]').getAttribute('aria-pressed');
  await page.keyboard.press('l');
  await eventually(async () => expect((await page.locator('[data-testid="toggle-links"]').getAttribute('aria-pressed')) !== lp0, 'L 未切换连线'));
  await page.keyboard.press('l'); await page.waitForTimeout(200);
  await page.keyboard.press('f'); await page.waitForTimeout(500);
  await page.keyboard.press('d'); await page.keyboard.press('t'); await page.keyboard.press('r'); await page.waitForTimeout(400);
  expect(!page.url().includes('panel='), '单键 d/t/r 不该开面板（防误触）');
  await page.keyboard.press('Alt+d');
  await eventually(async () => expect(page.url().includes('panel=design'), '⌥D 未打开设计系统面板'));
  await page.keyboard.press('Alt+d'); await page.waitForTimeout(300);
  await page.keyboard.press('Alt+t');
  await eventually(async () => expect(page.url().includes('panel=agent'), '⌥T 未打开本机 agent 面板'));
  await page.keyboard.press('Alt+t'); await page.waitForTimeout(300);
  // ⌘E 开启选择元素模式：不必先选中任何屏
  await page.keyboard.press('ControlOrMeta+e');
  await eventually(async () => expect(page.url().includes('panel=inspect'), '⌘E 未开启选择元素模式'));
  expect(await page.getByTestId('armed-hint').isVisible(), '模式已开但画布上没有「点任意一屏开始」的提示');
  await page.keyboard.press('ControlOrMeta+e');
  await eventually(async () => expect(!page.url().includes('panel='), '⌘E 再按一次未退出选择元素模式'));

  // 5 输入框内单键只输入字符
  await page.locator('#chat-input').click();
  await page.keyboard.type('dltf');
  expect((await page.locator('#chat-input').inputValue()) === 'dltf', '输入框内按键被工具快捷键吃掉');
  expect(!page.url().includes('panel='), '输入框内按键打开了面板');

  // 6 输入框随内容增高，到上限内部滚动
  const h0 = await page.locator('#chat-input').evaluate((el) => el.getBoundingClientRect().height);
  await page.fill('#chat-input', Array.from({ length: 12 }, (_, i) => `第 ${i} 行`).join('\n'));
  await page.waitForTimeout(200);
  const g = await page.locator('#chat-input').evaluate((el) => ({ h: el.getBoundingClientRect().height, max: parseFloat(getComputedStyle(el).maxHeight), s: el.scrollHeight }));
  expect(g.h > h0 && g.h <= g.max + 1 && g.s > g.h, `增高/封顶不符：${JSON.stringify(g)} 起始 ${h0}`);
  await page.fill('#chat-input', '');

  // 6b ⌘/ 收起 / 叫回输入框（v0.33）：焦点在输入框里也生效；草稿留着、光标落回输入区、安全区底部随之放开；收起后底边正中留一枚贴边胶囊（v1.16）
  const safeBottom = () => page.getByTestId('safe-area').evaluate((el) => el.getBoundingClientRect().bottom);
  const composerShown = () => page.locator('form.composer').isVisible();
  const sb0 = await safeBottom();
  await page.fill('#chat-input', '草稿');
  await page.keyboard.press('ControlOrMeta+Slash');

  await eventually(async () => expect(!(await composerShown()), '⌘/ 未收起输入框（焦点在输入框内）'));
  const pill = page.getByTestId('composer-pill');
  expect((await pill.isVisible()) && (await pill.getAttribute('data-dock')) === 'bottom' && (await pill.innerText()).includes('继续写'), `收起后底边应留一枚「继续写」胶囊：${await pill.count()}`);
  expect((await safeBottom()) - sb0 > 60, `收起后安全区底部未放开：${sb0} → ${await safeBottom()}`);
  await page.keyboard.press('ControlOrMeta+Slash');

  await eventually(async () => expect(await composerShown(), '⌘/ 未叫回输入框'));
  expect((await page.locator('#chat-input').inputValue()) === '草稿', '叫回后草稿丢了');
  // 聚焦在 showComposer 的 setTimeout(0) 里，输入框显形与光标落下之间隔一拍（实测 ≤ 56 ms）：轮询，不一次性读
  await eventually(async () => expect(await page.evaluate(() => document.activeElement?.id === 'chat-input'), '叫回后光标没落回输入区'), 2000);
  expect(Math.abs((await safeBottom()) - sb0) < 1, '叫回后安全区底部没复原');
  // 6c 工具栏「输入框」与 ⌘/ 是同一开关，aria-pressed 跟着显隐翻转
  await page.getByTestId('toggle-composer').click();
  await eventually(async () => expect(!(await composerShown()) && (await page.getByTestId('toggle-composer').getAttribute('aria-pressed')) === 'false', '工具栏「收起输入框」未收起或 aria-pressed 未翻转'));
  await page.getByTestId('toggle-composer').click();
  await eventually(async () => expect((await composerShown()) && (await page.locator('#chat-input').inputValue()) === '草稿', '工具栏「显示输入框」未叫回或草稿丢了'));
  // 输入框右上角自己的「收起」也是同一开关，点胶囊展开（v1.16）
  await page.getByTestId('composer-collapse').click();
  await eventually(async () => expect(!(await composerShown()) && (await pill.isVisible()), '输入框的「收起」没收成胶囊'));
  await pill.click();
  await eventually(async () => expect((await composerShown()) && (await page.locator('#chat-input').inputValue()) === '草稿', '点胶囊没展开或草稿丢了'));
  await page.fill('#chat-input', '');
  // 6d 聚焦某屏自动收起；聚焦期间 ⌘/ 可临时叫出、再按收回；退出后回到进入前的状态
  await page.locator('[data-testid="screen-card"]').first().locator('.gesture').dblclick();
  await page.locator('.card.focused').waitFor({ timeout: 10000 });

  await eventually(async () => expect(!(await composerShown()), '进入交互后输入框未自动收起'));
  await page.keyboard.press('ControlOrMeta+Slash');
  await eventually(async () => expect(await composerShown(), '聚焦期间 ⌘/ 未能临时叫出输入框'));
  await page.keyboard.press('ControlOrMeta+Slash');
  await eventually(async () => expect(!(await composerShown()), '聚焦期间 ⌘/ 未能收回输入框'));
  await page.keyboard.press('Escape');

  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, 'Esc 未退出聚焦'));
  expect(await composerShown(), '退出聚焦后输入框没回来');
  // 第 7 步量的是造态（带屏数 / 版数档位、最宽）的输入框：6d 退出聚焦后那一屏仍是选中的，输入框处在改态、窄到碰不着面板，
  // 再按一次 Esc 清掉选中，等宽度过渡走完
  await page.keyboard.press('Escape');
  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 0, 'Esc 未清掉选中'));
  await page.waitForTimeout(600);

  // 7 输入框的横向落点不得被侧边浮层的开合搬走：右侧面板滑出时允许让位，但只让到刚好不被压住为止，不多挪一像素
  const composerBox = async () => (await page.locator('form.composer').boundingBox())!;
  const cx = (await composerBox()).x;
  const before = await composerBox();
  await page.keyboard.press('Alt+d');

  await eventually(async () => expect(page.url().includes('panel=design'), '⌥D 未打开设计系统面板'));
  const panelBox = (await page.locator('.slide-in-right').boundingBox())!;
  const after = await composerBox();
  expect(after.x + after.width <= panelBox.x + 1, `输入框被右侧面板压住：右缘 ${after.x + after.width} > 面板左缘 ${panelBox.x}`);
  // 退让到位即可，不许多退：让位后与面板之间只应剩下外壳本来的 1rem 间距
  const gap = panelBox.x - (after.x + after.width);
  expect(gap >= 0 && gap <= 24, `让位过度：输入框右缘与面板之间空出 ${gap.toFixed(1)}px`);
  await page.keyboard.press('Alt+d');

  await eventually(async () => expect(Math.abs((await composerBox()).x - cx) < 1, '关掉右侧面板后输入框没回到原位'));
  // 视口居中：左右两侧留白应当相等
  const vw = page.viewportSize()!.width;
  const b = await composerBox();
  expect(Math.abs(b.x - (vw - b.x - b.width)) < 2, `输入框未压在视口正中：左 ${b.x} 右 ${vw - b.x - b.width}`);
  await shot(page, 'CORE-023');

  // 8 生成中按 Esc 取消（非聚焦态、无弹窗时 Esc 的最后一档）
  const seedJob = seedJson<{ jobId: string }>('seed:job', '--project', projectId, '--status', 'running', '--tokens', '100');
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.waitForTimeout(600);
  expect(!(await page.locator('#chat-input').isDisabled()), '有进行中作业时输入框被禁用了（v0.36 起不锁）');
  await page.locator(`[data-testid="job-chip"][data-job-id="${seedJob.jobId}"]`).getByTestId('cancel-job').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  const jb = await apiJson<{ job: { status: string } }>(`/v1/jobs/${seedJob.jobId}`);
  expect(jb.body.job.status === 'cancelled', `Esc 未取消作业，状态=${jb.body.job.status}`);

  // 9 窄视口无横向溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const mob = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    railIn: document.querySelector('[role="toolbar"]')!.getBoundingClientRect().bottom <= window.innerHeight,
  }));
  expect(mob.over <= 0, `390px 下横向溢出 ${mob.over}px`);
  expect(mob.railIn, '390px 下工具栏底部超出视口');
  await page.setViewportSize({ width: 1440, height: 900 });
  return `三处浮层不重叠；工具栏 ${hits.length} 键命中区 ≥44、Tab 停靠 1 个；单键 F/L 生效、d/t/r 不误触、Alt 组合开面板`;
});

await step('TC-CORE-024', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string; name: string }[] }>('seed:project', '--name', 'MultiSel', '--device', 'mobile', '--screens', '4');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  // 第 5 步从输入框发一轮要模型通道：stub 轮次自己建一条，桩拖住不回、这一轮随后取消
  await useStubChannel(page, { port: 3985, label: 'Stub 多选 24', holdMs: 60_000 });
  await page.getByRole('button', { name: '适配视图' }).click();
  await page.waitForTimeout(700);
  const card = (r: string) => page.locator(`[data-testid="screen-card"][data-route="${r}"]`);

  // 1 Shift 加选
  await card('/s1').locator('.gesture').click();
  await card('/s3').locator('.gesture').click({ modifiers: ['Shift'] });

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 2, ' Shift 加选后不是 2 屏'));
  const chips = page.getByTestId('target-chip');
  // 目标标签由「选中变化」的 effect 写入，比卡片高亮晚一次提交（实测相隔约 12 ms）：等它，不在高亮那一刻立刻读
  await eventually(async () => expect((await chips.count()) === 2, '输入框未列出 2 个目标标签'), 2000);
  expect((await verbLine(page)).includes('改 2 屏'), `动词行不是「改 2 屏」：${await verbLine(page)}`);

  // 2 移除其中一个目标
  await chips.first().getByRole('button').click();

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1, '移除目标后不是 1 屏'));
  expect((await chips.count()) === 1 && (await verbLine(page)).includes('改 1 屏'), `单选后动词行不是「改 1 屏」：${await verbLine(page)}`);

  // 3 空白处拖拽框选全部 4 屏
  const cb = (await page.locator('[data-testid="canvas"]').boundingBox())!;
  const rects = await page.locator('[data-testid="screen-card"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })));
  const pad = 30;
  const x0 = Math.min(...rects.map((r) => r.l)) - pad, y0 = Math.min(...rects.map((r) => r.t)) - pad;
  const x1 = Math.max(...rects.map((r) => r.r)) + pad, y1 = Math.max(...rects.map((r) => r.b)) + pad;
  await page.mouse.move(Math.max(cb.x + 4, x0), Math.max(cb.y + 4, y0));
  await page.mouse.down();
  await page.mouse.move(Math.min(cb.x + cb.width - 4, x1), Math.min(cb.y + cb.height - 4, y1), { steps: 12 });
  expect(await page.locator('[data-testid="marquee"]').isVisible(), '拖拽时未出现选框');
  // 还没松手就应当已经高亮命中的屏
  expect((await page.locator('[data-testid="screen-card"].selected').count()) === 4, '框选过程中未实时高亮命中的屏');
  await page.mouse.up();

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 4, '框选后不是 4 屏'));

  // 4 ⌘A 全选
  await card('/s1').locator('.gesture').click();
  await page.waitForTimeout(150);
  await page.keyboard.press('ControlOrMeta+a');

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 4, '⌘A 未全选'));

  // 5 发送时把 4 屏一起作为 targetScreenIds；动词行写「改全部 4 屏」
  await eventually(async () => expect((await verbLine(page)).includes('改全部 4 屏'), `动词行不是「改全部 4 屏」：${await verbLine(page)}`));
  const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  const res = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await page.fill('#chat-input', '统一把顶部导航改成标签栏');
  await page.keyboard.press('Enter');
  // 两个等待一起收：只等 req 时它一超时，并行的 res 拒绝没人接，整套进程退出
  const [sentReq, sentRes] = await Promise.all([req, res]);
  const sent = JSON.parse(sentReq.postData() ?? '{}') as { targetScreenIds?: string[] };
  expect(sent.targetScreenIds?.length === 4, `targetScreenIds 不是 4 屏：${JSON.stringify(sent.targetScreenIds)}`);
  expect(screens.every((s) => sent.targetScreenIds!.includes(s.id)), 'targetScreenIds 与选中集合不一致');
  const sentJob = (await sentRes.json()) as { job: { id: string } };
  // 5b 目标标签粘性（REQ-CORE-006）：点空白只清画布高亮，目标标签与「改」的动词行都还在；「清空」才回到「造」
  const spot = await blankSpot(page);
  expect(!!spot, '找不到画布空白点');
  await page.mouse.click(spot!.x, spot!.y);

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 0, '点空白没有清掉画布高亮'));
  expect((await page.getByTestId('target-chip').count()) === 4, `点空白后目标标签少了：${await page.getByTestId('target-chip').count()}`);
  expect((await verbLine(page)).includes('改全部 4 屏'), `点空白后动词行变了：${await verbLine(page)}`);
  await page.getByTestId('clear-targets').click();

  await eventually(async () => expect((await page.getByTestId('target-chip').count()) === 0 && (await verbLine(page)).startsWith('造'), `清空后动词行不是「造」：${await verbLine(page)}`));
  await apiJson(`/v1/jobs/${sentJob.job.id}/cancel`, { method: 'POST' }).catch(() => {});

  // 6 多选时只出删除、不出修订
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await card('/s1').locator('.gesture').click();
  await card('/s2').locator('.gesture').click({ modifiers: ['Shift'] });
  await page.waitForTimeout(200);
  expect((await page.getByRole('button', { name: '修订' }).count()) === 0, '多选时仍出现「修订」');
  await page.getByRole('button', { name: '删除 2 屏' }).click();

  await eventually(async () => expect((await page.locator('[role="alertdialog"]').innerText()).includes('删除选中的 2 屏'), '确认框未点明屏数'));
  await page.keyboard.press('Escape');
  await shot(page, 'CORE-024');
  return 'Shift 加选 / 框选 / ⌘A 全选 / targetScreenIds 传 4 屏 / 点空白不清目标标签、清空回到造 / 多选只出删除';
});

await step('TC-CORE-025', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Runner', '--device', 'mobile', '--screens', '2');
  // stub 轮次种子不建云端通道（§3）：自建一条 OpenAI 兼容桩通道当清单里的云端通道，发出的作业拖住不回、随后取消
  await useStubChannel(null, { port: 3984, label: 'Stub 云端 25', holdMs: 60_000 });

  // 清单：只给标识与显示名；缺凭据的驱动照样列出但标为不可用
  const list = (await apiJson<{ items: { id: string; label: string; hint?: string; available: boolean; unavailableReason?: string; setupHint?: string; runner: Record<string, string> }[]; default: string }>('/v1/runners')).body;
  expect(list.items.length >= 2 && list.items.some((i) => i.runner.kind === 'agent') && list.items.some((i) => i.runner.kind === 'channel'), '通道清单缺云端通道或本机 agent');
  // 只查真实密钥形态；unavailableReason 里出现的是配置项名（ANTHROPIC_API_KEY），不是凭据
  expect(!/sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,}|-----BEGIN/.test(JSON.stringify(list.items)), '通道清单泄漏了凭据');
  const unavailable = list.items.filter((i) => !i.available);
  expect(unavailable.every((i) => !!i.unavailableReason), '不可用的通道没说明原因');

  // 输入框工具条左端的通道选择器，默认选中服务端给的默认项
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const sel = page.getByTestId('runner-select');
  await sel.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !!document.querySelector('[data-testid="runner-select"]')?.getAttribute('data-value'), null, { timeout: 10000 });
  expect((await sel.getAttribute('data-value')) === list.default, `默认值不是服务端默认项：${await sel.getAttribute('data-value')} ≠ ${list.default}`);
  const defaultLabel = list.items.find((i) => i.id === list.default)!.label;
  expect((await sel.innerText()).includes(defaultLabel), `触发器未显示默认项名称：${await sel.innerText()}`);

  // 点开：只列可用通道——不可用项去设置页看原因（REQ-CORE-013）；分组仍在；末尾有管理入口
  await sel.click();
  const listbox = page.getByRole('listbox');
  await listbox.waitFor({ timeout: 3000 });
  // 「管理模型…」是 listbox 里的哨兵项（键盘可达），计数时剔除；lobehub 图标的 <title> 会混进 innerText，只做包含判断
  const opts = await listbox.getByRole('option').evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="manage-channels"]')).map((e) => (e as HTMLElement).innerText));
  const avail = list.items.filter((i) => i.available);
  expect(opts.length === avail.length, `下拉项 ${opts.length} ≠ 可用通道 ${avail.length}`);
  for (const u of unavailable) expect(!opts.some((t) => t.includes(u.label)), `不可用通道「${u.label}」不该出现在下拉里`);
  expect((await listbox.innerText()).includes('云端模型'), '列表未按「云端模型 / 本机 agent」分组');
  expect(await page.getByTestId('manage-channels').isVisible() && (await page.getByTestId('manage-channels').innerText()).includes('管理模型…'), '下拉末尾没有「管理模型…」入口');
  // 每项只给厂商图标 + 显示名：模型 id 是配置细节，收在设置弹层的通道管理器里（TC-CORE-028 第 7 步验它还在）
  const withModel = avail.find((i) => i.hint && !i.label.includes(i.hint));
  expect(!!withModel, '清单里没有「显示名不含模型 id」的可用通道，这条断言失去区分力');
  expect(!opts.some((t) => t.includes(withModel!.hint!)), `下拉项仍显示模型 id「${withModel!.hint}」：${JSON.stringify(opts)}`);

  // Esc 只关下拉：焦点回到触发器，画布选中不受影响，也不触发别的快捷键
  await page.keyboard.press('Escape');

  await eventually(async () => expect((await listbox.count()) === 0, 'Esc 未关闭下拉'));
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'runner-select'), '关闭后焦点未回到触发器');
  await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
  await sel.click();
  await listbox.waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1, '下拉内按 Esc 连带清掉了画布选中');

  // 选另一个可用通道：触发器随之变化，并跨刷新记住
  const other = list.items.find((i) => i.available && i.id !== list.default);
  if (other) {
    await sel.click();
    await listbox.waitFor({ timeout: 3000 });
    await listbox.getByRole('option').filter({ hasText: other.label }).first().click();

    await eventually(async () => expect((await sel.getAttribute('data-value')) === other.id, `选择后触发器值未更新：${await sel.getAttribute('data-value')}`));
    await page.reload();
    await sel.waitFor({ timeout: 10000 });
    await page.waitForFunction((id) => document.querySelector('[data-testid="runner-select"]')?.getAttribute('data-value') === id, other.id, { timeout: 10000 });
  }

  // 选云端模型发送：作业输入带上驱动与模型，随即取消以免耗额度
  const cloud = list.items.find((i) => i.runner.kind === 'channel' && i.available)!;
  const r1 = await apiJson<{ job: { id: string; input: { runner?: { channelId?: string } } } }>(`/v1/projects/${projectId}/messages`, {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ content: '把标题改短一点', targetScreenIds: [screens[0].id], runner: cloud.runner }),
  });
  expect(r1.status === 202 && r1.body.job.input.runner?.channelId === cloud.runner.channelId, `作业未带上通道：${JSON.stringify(r1.body.job.input.runner)}`);
  await apiJson(`/v1/jobs/${r1.body.job.id}/cancel`, { method: 'POST' });

  // 选「交给本机 Claude Code」（ADR-015 v0.34）：作业投递到本机会话，runner 里必须带一个活着的 sessionId——
  // 没带 / 会话不在活列表 → 建作业前 400；claude 不在 PATH → 通道不可用、400 并给安装步骤。投递链路本身在 TC-AGENT-009 验
  const agentOpt = list.items.find((i) => i.runner.kind === 'agent' && i.runner.tool === 'claude-code')!;
  const sessionsRes = await apiJson<{ items: unknown[] }>('/v1/agent/sessions');
  expect(sessionsRes.status === 200 && Array.isArray(sessionsRes.body.items), '会话列表接口（API-AGENT-010）不可用');
  const jobsBefore = (await apiJson<{ items: unknown[] }>(`/v1/projects/${projectId}/jobs?runner=agent`)).body.items.length;
  const post = (runner: unknown) => apiJson<{ type?: string; errors?: { path?: string; message: string }[] }>(`/v1/projects/${projectId}/messages`, {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ content: '把这一屏实现成 React 组件', targetScreenIds: [screens[1].id], runner }),
  });
  let agentNote: string;
  if (agentOpt.available) {
    const noSession = await post({ kind: 'agent', tool: 'claude-code' });
    expect(noSession.status === 400 && noSession.body.type === '/errors/validation', `不带 sessionId 应 400 validation：${noSession.status} ${JSON.stringify(noSession.body).slice(0, 200)}`);
    const gone = await post({ kind: 'agent', tool: 'claude-code', sessionId: '00000000-0000-4000-8000-000000000000' });
    expect(gone.status === 400 && gone.body.type === '/errors/validation' && /会话已关闭/.test(gone.body.errors?.[0]?.message ?? ''), `不存在的会话应 400 并说明：${gone.status} ${JSON.stringify(gone.body).slice(0, 200)}`);
    expect((await apiJson<{ items: unknown[] }>(`/v1/projects/${projectId}/jobs?runner=agent`)).body.items.length === jobsBefore, '被拒的发送不该留下作业');
    agentNote = `本机 Claude Code 通道可用（${agentOpt.hint}）；活会话 ${sessionsRes.body.items.length} 个；缺 / 死 sessionId 都在建作业前 400`;
  } else {
    const r2 = await post({ kind: 'agent', tool: 'claude-code', sessionId: '00000000-0000-4000-8000-000000000000' });
    expect(r2.status === 400 && r2.body.type === '/errors/validation' && /claude/.test(r2.body.errors?.[0]?.message ?? ''), `CLI 不在 PATH 时应 400 并给安装步骤：${r2.status} ${JSON.stringify(r2.body)}`);
    expect(!!agentOpt.setupHint && !!agentOpt.unavailableReason, '不可用的本机 agent 通道没给安装步骤');
    agentNote = 'claude 不在 PATH：通道不可用、发送 400 并给安装步骤';
  }
  await shot(page, 'CORE-025');
  return `清单 ${list.items.length} 项（${unavailable.length} 项不可用、不进下拉）；下拉分组 + 管理入口 / Esc 不漏给画布；云端带驱动/模型；${agentNote}`;
});

await step('TC-CORE-026', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Brand', '--device', 'mobile', '--screens', '2', '--no-shot');
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1、2 首次运行的第一屏（PAGE-FIRST）：完整符号 ≥ 64 px、字标 Space Grotesk 500 / -0.03 em——在套件开头、建示例项目之前量过
  if (!brandFirstRun.startsWith('首屏')) throw new Error(brandFirstRun);

  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.waitForTimeout(600);
  const nav = page.locator('header').first();
  expect((await nav.locator('.wordmark').count()) === 0, '画布顶栏仍挂着品牌字标');
  const navFirst = await nav.evaluate((el) => el.firstElementChild?.getAttribute('data-testid') ?? el.firstElementChild?.tagName ?? '');
  expect(navFirst === 'project-switcher', `画布顶栏左上第一个元素不是项目切换器：${navFirst}`);

  // 3 外壳配色取自 brand/（v1.08，§13.1）：浅色、深色各读一遍根元素上的语义变量，等于产品带的 brand 副本 tokens.css 里 [data-theme] 那两块的值；
  // 正文、次级、弱文字对面板与画布，主按钮上的字对动作色都 ≥ 4.5:1，画布标记对画布 ≥ 3:1
  // token 值在页面里读、比值在 Node 里算——tsx 会往 evaluate 的闭包里注入 __name 导致页面侧报错
  const ROLES = { canvas: 'surface.canvas', panel: 'surface.background', fg: 'text.primary', muted: 'text.secondary', subtle: 'text.tertiary', accent: 'action.primary', onAccent: 'text.onAction', mark: 'mark.line' } as const;
  const varOf = (role: string) => `--semantic-color-${role.replace('.', '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
  const rgbOf = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  const lum = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
    const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
  const tokensCss = readFileSync(path.resolve(import.meta.dirname, '../../../apps/web/src/brand/tokens.css'), 'utf8');
  const contrast: Record<string, Record<string, number>> = {};
  for (const mode of ['light', 'dark'] as const) {
    const block = tokensCss.match(new RegExp(`\\[data-theme="${mode}"\\] \\{([^}]*)\\}`))?.[1] ?? '';
    const want = (role: string) => block.match(new RegExp(`${varOf(role)}: (#[0-9A-Fa-f]{6})`))?.[1] ?? '';
    await page.evaluate(`document.documentElement.setAttribute('data-theme', '${mode}')`);
    const sw = await page.evaluate(`(() => {
      const probe = (n) => { const d = document.createElement('div'); d.style.color = 'var(' + n + ')'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
      return Object.fromEntries(${JSON.stringify(Object.entries(ROLES).map(([k, r]) => [k, varOf(r)]))}.map(([k, n]) => [k, probe(n)]));
    })()`) as Record<keyof typeof ROLES, string>;
    for (const [k, role] of Object.entries(ROLES) as [keyof typeof ROLES, string][]) {
      const hex = want(role);
      expect(!!hex && sw[k] === rgbOf(hex), `${mode} ${role} 是 ${sw[k]}，tokens.css 的 [data-theme="${mode}"] 里是 ${hex || '（没找到）'}`);
    }
    const pairs = {
      'fg/panel': ratio(sw.fg, sw.panel), 'muted/panel': ratio(sw.muted, sw.panel), 'subtle/panel': ratio(sw.subtle, sw.panel),
      'fg/canvas': ratio(sw.fg, sw.canvas), 'muted/canvas': ratio(sw.muted, sw.canvas), 'subtle/canvas': ratio(sw.subtle, sw.canvas),
      'onAccent/accent': ratio(sw.onAccent, sw.accent),
    };
    for (const [k, v] of Object.entries(pairs)) expect(v >= 4.5, `${mode} ${k} 对比度 ${v} 低于正文线 4.5`);
    expect(ratio(sw.mark, sw.canvas) >= 3, `${mode} 画布标记对画布 ${ratio(sw.mark, sw.canvas)} 低于 3`);
    contrast[mode] = { ...pairs, 'mark/canvas': ratio(sw.mark, sw.canvas) };
  }
  await page.evaluate(`document.documentElement.removeAttribute('data-theme')`);

  // 4 favicon 指向品牌资产且真的取得到
  const icon = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(icon?.startsWith('/brand/'), `favicon 未指向品牌资产：${icon}`);
  expect((await page.request.get(`${WEB}${icon}`)).status() === 200, 'favicon 资产 404');

  // 5 用户项目的设计系统不被工具品牌污染：风格指南卡报的是项目自己的字体，不是工具外壳的
  const guide = await page.locator('[data-testid="style-guide"]').innerText();
  const projFont = (await apiJson<{ designSystem: { tokens: { typography: { fontFamily: string } } } }>(`/v1/projects/${projectId}`)).body.designSystem.tokens.typography.fontFamily;
  expect(guide.includes(projFont), `风格指南卡未报出项目字体 ${projFont}`);
  const shellFont = 'Space Grotesk';
  expect(projFont !== shellFont, `项目字体与工具外壳字体同为 ${shellFont}，这条断言失去区分力，请换一个字体建种子项目`);
  expect(!guide.includes(shellFont), `工具外壳字体 ${shellFont} 串进了用户项目的风格指南`);
  await shot(page, 'CORE-026');
  return `${brandFirstRun} / -0.03em · 浅深两套 token 与 brand/ 一致 · 对比度 ${JSON.stringify(contrast)}`;
});

await step('TC-CORE-027', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'ImgRef', '--device', 'mobile', '--screens', '2', '--no-shot');
  // 造一张纯色 PNG 当参考图（内容不重要，这条用例验的是通道不是模型）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const ref = path.join(EVIDENCE, `run-${RUN}-ref.png`);
  await writeFile(ref, png);

  // 1 契约：类型与大小在签发时就挡住
  const bad = await apiJson(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/svg+xml', bytes: 100 }) });
  expect(bad.status === 422, `SVG 未被拒：${bad.status}`);
  const big = await apiJson(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: 50 * 1024 * 1024 }) });
  expect(big.status === 422, `超大附件未被拒：${big.status}`);

  // 2 通道清单标注视觉能力；挑一个支持的。stub 轮次没有云端通道（§3），先建一条 OpenAI 兼容桩通道（账号自建通道都支持视觉）
  await useStubChannel(null, { port: 3974, label: 'Stub 视觉 27' });
  const runners = (await apiJson<{ items: { id: string; label: string; available: boolean; vision: boolean; runner: Record<string, string> }[] }>('/v1/runners')).body.items;
  expect(runners.every((r) => typeof r.vision === 'boolean'), '通道清单没有 vision 标记');
  const seeing = runners.find((r) => r.vision && r.available && r.runner.kind !== 'agent');
  const blind = runners.find((r) => !r.vision);
  expect(seeing, '没有任何支持视觉的云端通道可用');

  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.waitForTimeout(600);
  const pickRunner = async (label: string) => {
    await page.getByTestId('runner-select').click();
    await page.getByRole('listbox').waitFor({ timeout: 3000 });
    await page.getByRole('option').filter({ hasText: label }).first().click();
    await page.waitForTimeout(300);
  };
  const thumbs = page.locator('ul[aria-label="本次参考图"] li');

  // 3 不支持视觉的通道：贴图这一刻就被拦，按钮也标为不可用
  if (blind) {
    await pickRunner(blind.label);
    expect((await page.getByTestId('add-image').getAttribute('aria-disabled')) === 'true', '无视觉通道下「加参考图」仍可用');
    await page.setInputFiles('input[type=file]', ref);
    await page.waitForTimeout(800);
    expect((await thumbs.count()) === 0, '无视觉通道下仍然贴上了参考图');
  }

  // 4 换成支持视觉的通道：贴图 → 缩略图；超过上限被截断；可逐张移除
  await pickRunner(seeing!.label);
  await page.setInputFiles('input[type=file]', ref);
  await page.locator('ul[aria-label="本次参考图"] img').first().waitFor({ timeout: 10000 });
  await page.waitForFunction(`!document.querySelector('ul[aria-label="本次参考图"] span')`, null, { timeout: 15000 });
  expect((await thumbs.count()) === 1, '贴图后没有缩略图');
  await page.setInputFiles('input[type=file]', [ref, ref, ref, ref]);

  await eventually(async () => expect((await thumbs.count()) === 4, `超过上限未截断，实际 ${await thumbs.count()} 张`));
  await page.locator('ul[aria-label="本次参考图"] button').first().click();

  await eventually(async () => expect((await thumbs.count()) === 3, '移除参考图无效'));

  // 5 发送：请求带 attachmentIds，作业输入带 imageKeys
  const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  const res = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await page.fill('#chat-input', '参考这张图的排版');
  await page.keyboard.press('Enter');
  const sent = JSON.parse((await req).postData() ?? '{}') as { attachmentIds?: string[] };
  expect(sent.attachmentIds?.length === 3, `请求未带 3 个 attachmentIds：${JSON.stringify(sent.attachmentIds)}`);
  const created = await (await res).json() as { job: { id: string } | null };

  const job = (await apiJson<{ job: { input: { imageKeys?: string[] } } }>(`/v1/jobs/${created.job!.id}`)).body.job;
  expect(job.input.imageKeys?.length === 3, `作业输入未带 imageKeys：${JSON.stringify(job.input)}`);
  // 图已经进作业了，别真跑生成——这条用例验通道，不验模型
  await apiJson(`/v1/jobs/${created.job!.id}/cancel`, { method: 'POST' }).catch(() => {});

  // 6 服务端兜底：带图却选无视觉通道，直接拒（前端护栏被绕过时的第二道）
  if (blind) {
    const r = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ content: 'x', attachmentIds: sent.attachmentIds, runner: blind.runner }),
    });
    expect(r.status === 400 && r.body.type === '/errors/validation', `无视觉通道带图未被服务端拒：${r.status} ${r.body?.type}`);
  }
  await shot(page, 'CORE-027');
  return `类型/大小在签发时挡住；${blind ? '无视觉通道贴图即拦 + 服务端兜底；' : ''}贴图上限 4、可移除；attachmentIds 与 imageKeys 贯通`;
});

await step('TC-CORE-028', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Chan', '--device', 'mobile', '--screens', '1', '--no-shot');
  type Cat = { items: { id: string; label: string; hint?: string; source: string; available: boolean; status?: string; unavailableReason?: string; channelId?: string; vendor: string }[]; default: string };
  const catalog = async () => (await apiJson<Cat>('/v1/runners')).body;
  // 桩回放该屏当前 body（保证过 lint），带一个标记；验证的是「通道 → 驱动 → 端点」这条管道，不是模型
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3999, apiKey: 'good-key-0001', reply: body0.replace('Screen 1', 'Screen 1 (via channel)') });
  try {
    // 1 契约：OpenAI 兼容通道必须有端点
    const noEp = await apiJson('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', label: 'x', model: 'm', apiKey: 'kkkkkkkkkk' }) });
    expect(noEp.status === 400, `缺端点未被拒：${noEp.status}`);
    // 2 创建：未验证、不可用；响应只给末 4 位
    const created = await apiJson<{ channel: { id: string; status: string; apiKeyHint: string | null } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 通道', endpoint: stub.url, model: 'stub-1', apiKey: 'good-key-0001' }) });
    expect(created.status === 201 && created.body.channel.status === 'unverified', `创建返回 ${created.status} ${created.body.channel?.status}`);
    expect(!JSON.stringify(created.body).includes('good-key') && created.body.channel.apiKeyHint === '0001', '创建响应泄漏了密钥或提示位不对');
    const cid = created.body.channel.id;
    let mine = (await catalog()).items.find((i) => i.channelId === cid);
    expect(mine && mine.source === 'channel' && !mine.available && mine.status === 'unverified', `未验证的通道不该可用：${JSON.stringify(mine)}`);
    // 3 验证通过 → 可用
    const p1 = await apiJson<{ ok: boolean; latencyMs?: number }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' });
    expect(p1.body.ok === true, `探测未通过：${JSON.stringify(p1.body)}`);
    mine = (await catalog()).items.find((i) => i.channelId === cid);
    expect(mine?.available === true && mine.status === 'verified', `验证后仍不可用：${JSON.stringify(mine)}`);
    // 4 用它改屏：作业 runner 是 channel 形态、桩被调、台账按通道驱动记账、新修订带桩标记
    const usage0 = (await apiJson<{ tokensIn: number }>('/v1/me/usage')).body.tokensIn;
    const hits0 = stub.hits.length;
    const sent = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '用自建通道改一下', targetScreenIds: [screens[0].id], runner: { kind: 'channel', channelId: cid } }) });
    expect(sent.status === 202, `发送返回 ${sent.status}`);
    const job = await waitJob(sent.body.job.id, 90) as { status: string; input: { runner?: { kind: string } }; output?: { errorClass?: string; message?: string } };
    expect(job.status === 'succeeded', `作业未成功：${job.status} ${job.output?.errorClass ?? ''} ${job.output?.message ?? ''}`);
    expect(job.input.runner?.kind === 'channel', `作业输入的 runner 不是 channel：${JSON.stringify(job.input.runner)}`);
    expect(stub.hits.length > hits0 && stub.hits.slice(hits0).every((h) => h.model === 'stub-1'), '桩未收到该通道的请求');
    const usage1 = (await apiJson<{ tokensIn: number }>('/v1/me/usage')).body.tokensIn;
    expect(usage1 - usage0 >= 42, `台账未按通道记账：Δ=${usage1 - usage0}`);
    const rev1 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
    expect((await (await fetch(rev1.htmlUrl)).text()).includes('(via channel)'), '新修订不是桩产出的');
    // 5 改成错的 Key：状态回未验证；探测失败带供应商原因；目录里不可用；列表与响应仍无明文
    const patched = await apiJson<{ channel: { status: string } }>(`/v1/channels/${cid}`, { method: 'PATCH', body: JSON.stringify({ apiKey: 'bad-key-9999' }) });
    expect(patched.body.channel.status === 'unverified', '改 Key 后状态未重置');
    const p2 = await apiJson<{ ok: boolean; error?: string }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' });
    expect(p2.body.ok === false && /401/.test(p2.body.error ?? ''), `错 Key 探测结果不对：${JSON.stringify(p2.body)}`);
    mine = (await catalog()).items.find((i) => i.channelId === cid);
    expect(mine?.available === false && (mine.unavailableReason ?? '').includes('验证失败'), `验证失败后仍可用：${JSON.stringify(mine)}`);
    const list = await apiJson('/v1/channels');
    expect(!/good-key|bad-key/.test(JSON.stringify(list.body)) && !/good-key|bad-key/.test(JSON.stringify(patched.body)), '列表或更新响应泄漏了密钥');
    // 6 删除 → 再用它发消息被拒
    expect((await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' })).status === 204, '删除未返回 204');
    const gone = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'x', targetScreenIds: [screens[0].id], runner: { kind: 'channel', channelId: cid } }) });
    expect(gone.status === 404, `已删通道仍能发消息：${gone.status}`);

    // 7 设置弹层里的管理器：三组行、状态药丸、验证按钮、本机通道的配置步骤。第 6 步已删了 Stub 通道，stub 轮次又没有种子的云端通道（§3），
    //   先建一条已验证的自建通道当「自建通道」那一组的行
    await useStubChannel(null, { port: 3983, label: 'Stub 管理 28' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/p/${projectId}?settings=models`);
    const modal = page.getByTestId('settings-modal');
    await modal.waitFor({ timeout: 10000 });
    // 分栏：左栏三节 tab（用量 / 模型 / 系统，v1.24），方向键换节、URL 跟着变
    const tabs = await modal.getByRole('tab').allInnerTexts();
    expect(tabs.join('/') === '用量/模型/系统', `设置弹层左栏应是 用量 / 模型 / 系统 三节：${tabs.join(' / ')}`);
    expect((await modal.getByRole('tab', { name: '模型' }).getAttribute('aria-selected')) === 'true', '?settings=models 未选中「模型」');
    await modal.getByRole('tab', { name: '模型' }).focus();
    await page.keyboard.press('ArrowUp');
    await modal.getByTestId('usage').waitFor({ timeout: 3000 });
    expect(page.url().includes('settings=usage'), `方向键换节后 URL 未更新：${page.url()}`);
    await page.keyboard.press('ArrowDown');
    const mgr = modal.getByTestId('channel-manager');
    await mgr.waitFor({ timeout: 10000 });
    await mgr.getByTestId('runner-row').first().waitFor({ timeout: 10000 });
    const rows = await mgr.getByTestId('runner-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-runner-id') ?? ''));
    expect(rows.some((r) => r.startsWith('channel:')) && rows.some((r) => r.startsWith('agent:')), `管理器缺自建通道或本机 agent 行：${JSON.stringify(rows)}`);
    expect((await mgr.getByTestId('runner-status').count()) === rows.length, '每行都应有状态药丸');
    // 模型 id 的家在这里：画布下拉只给图标 + 显示名（TC-CORE-025），管理器行里必须看得到具体是哪个模型
    const preset = (await catalog()).items.find((i) => i.source === 'channel' && i.hint && !i.label.includes(i.hint));
    expect(!!preset, '没有「显示名不含模型 id」的通道，这条断言失去区分力');
    expect((await mgr.locator(`[data-runner-id="${preset!.id}"]`).innerText()).includes(preset!.hint!), `管理器的「${preset!.label}」行没写出模型 id ${preset!.hint}`);
    expect((await mgr.getByTestId('probe-runner').count()) >= rows.length, '每行都应有「验证」');
    // 本机 agent 行（v1.24）：可用时次行写「找到 claude 命令」，不可用时给「如何配置」
    for (const a of (await catalog()).items.filter((i) => i.source === 'builtin')) {
      const row = mgr.locator(`[data-runner-id="${a.id}"]`);
      const bin = a.id.includes('codex') ? 'codex' : 'claude';
      if (a.available) expect((await row.innerText()).includes(`找到 ${bin} 命令`), `可用的「${a.label}」行次行应写「找到 ${bin} 命令」：${(await row.innerText()).replace(/\s+/g, ' ')}`);
      else expect((await row.getByTestId('setup-hint').count()) === 1, `不可用的「${a.label}」行缺「如何配置」`);
    }
    // 8 添加面板：焦点陷阱 + Esc 归还；保存并验证 → 已验证
    await page.getByTestId('add-channel').click();
    const dlg = page.getByTestId('channel-dialog');
    await dlg.waitFor({ timeout: 3000 });
    expect(await page.evaluate(() => document.activeElement?.id === 'ch-kind'), '打开面板后初始焦点不在第一个字段');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="channel-dialog"]')), `Tab ${i + 1} 次后焦点逃出了面板`);
    }
    await page.keyboard.press('Escape');

    await eventually(async () => expect((await dlg.count()) === 0, 'Esc 未关闭面板'));
    // 弹层叠弹层：内层关掉后外层设置弹层还在、背景仍隔离，焦点回到外层的「添加模型」（inert 引用计数）
    expect(await modal.isVisible(), '关掉「添加模型」后设置弹层跟着没了');
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert')), '内层关闭后背景 inert 被一起摘掉了');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'add-channel'), '关闭后焦点未回到「添加模型」');
    await page.getByTestId('add-channel').click();
    await dlg.waitFor({ timeout: 3000 });
    // 表单下拉一律用 Radix（原生 <select> 的列表由系统渲染，暗色下会画成亮色面板）
    expect((await page.locator('#ch-kind').evaluate((el) => el.tagName)) !== 'SELECT', '通道类型仍是原生 select');
    await pickOption(page, '#ch-kind', 'OpenAI 兼容');
    await pickOption(page, '#ch-vendor', '自定义 OpenAI 兼容端点');
    await page.fill('#ch-label', 'Stub UI');
    await page.fill('#ch-endpoint', stub.url);
    await page.fill('#ch-model', 'stub-1');
    await page.fill('#ch-key', 'good-key-0001');
    await page.getByTestId('ch-save').click();
    const uiRow = mgr.getByTestId('runner-row').filter({ hasText: 'Stub UI' });
    await uiRow.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="runner-row"]')].some((r) => r.textContent?.includes('Stub UI') && r.querySelector('[data-testid="runner-status"]')?.textContent?.includes('已验证')), null, { timeout: 15000 });
    expect(!(await page.content()).includes('good-key'), '设置页 HTML 里出现了密钥明文');
    const uiChannelId = (await uiRow.getAttribute('data-runner-id'))!.replace('channel:', '');
    // 8b 本机订阅通道：不填 Key 也能建，模型名可改（REQ-CORE-013）
    const sub = await apiJson<{ channel: { id: string; status: string; apiKeyHint: string | null } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'agent-sdk', label: '本机订阅 用例', model: 'claude-sonnet-5' }) });
    expect(sub.status === 201 && sub.body.channel.apiKeyHint === null, `本机订阅通道不该要 Key：${sub.status}`);
    const subId = sub.body.channel.id;
    const changed = await apiJson<{ channel: { model: string; status: string } }>(`/v1/channels/${subId}`, { method: 'PATCH', body: JSON.stringify({ model: 'claude-opus-4-5' }) });
    expect(changed.body.channel.model === 'claude-opus-4-5' && changed.body.channel.status === 'unverified', `改模型名未生效或未重置状态：${JSON.stringify(changed.body.channel)}`);
    // 其它类型仍必须给 Key
    const noKey = await apiJson('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'anthropic', label: 'x', model: 'claude-sonnet-5' }) });
    expect(noKey.status === 400, `非本机订阅缺 Key 未被拒：${noKey.status}`);
    await apiJson(`/v1/channels/${subId}`, { method: 'DELETE' });

    // 9 画布下拉：只列可用项、带厂商图标、有管理入口
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor();
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !!document.querySelector('[data-testid="runner-select"]')?.getAttribute('data-value'), null, { timeout: 10000 });
    await page.getByTestId('runner-select').click();
    const lb = page.getByRole('listbox');
    await lb.waitFor({ timeout: 3000 });
    const stubOpt = lb.getByRole('option').filter({ hasText: 'Stub UI' });
    expect((await stubOpt.count()) === 1, '验证通过的自建通道没出现在下拉里');
    expect((await stubOpt.locator('svg').count()) > 0, '下拉项没有厂商图标');
    expect(await page.getByTestId('manage-channels').isVisible() && (await page.getByTestId('manage-channels').innerText()).includes('管理模型…'), '下拉末尾没有「管理模型…」');
    await page.keyboard.press('Escape');
    await apiJson(`/v1/channels/${uiChannelId}`, { method: 'DELETE' });
    await shot(page, 'CORE-028');
  } finally { await stub.close(); }
  return '缺端点被拒；创建=未验证不可用；验证后可用；作业按 channel 形态跑通、台账按通道记账；错 Key 回未验证→探测失败→不可用；全程无明文；删后 404；本机订阅免 Key 且模型可改；预置项可用性与探测结果不互相覆盖；设置页三组+焦点陷阱；下拉只列可用项带图标且为 Radix';
});

// v0.31：双击空白 = 放锚点 + 聚焦输入框；屏数 / 版数在输入框里选；版数 > 1 落为同一屏的候选修订（不再是独立屏）
await step('TC-CORE-029', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Blank', '--device', 'mobile', '--screens', '1', '--no-shot');
  type Screen = { id: string; name: string; route: string; purpose: string; x: number; y: number; width: number; height: number; currentRevisionId: string | null; screenshotUrl: string | null; pendingCandidates: { jobId: string; count: number } | null };
  type Detail = { project: { exemplarScreenId: string | null; brief: string }; screens: Screen[]; activeJobs: { id: string; kind: string }[] };
  const detail = async () => (await apiJson<Detail>(`/v1/projects/${projectId}`)).body;
  // 桩：单屏规划回固定 JSON（links 为空、entryFrom 为空——交互还没想好，先把屏设计出来）；整组规划回 2 屏并声明入口屏 /s1；出屏 / 改屏回放种子屏 body 并编号
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const PLAN_ONE = JSON.stringify({ name: 'Order Detail', route: '/order-detail', purpose: 'show one order', links: [], sections: ['status timeline', 'items', 'fees'], entryFrom: null });
  const PLAN_GROUP = JSON.stringify({ entryFrom: '/s1', screens: [
    { name: 'Cart', route: '/cart', purpose: 'items to buy', links: ['/checkout'], sections: ['items', 'total', 'checkout button'] },
    { name: 'Checkout', route: '/checkout', purpose: 'pay for the cart', links: ['/cart'], sections: ['address', 'payment', 'confirm'] },
  ] });
  let n = 0;
  const stub = startOpenAiStub({ port: 3998, apiKey: 'good-key-0002', reply: (hit) => (hit.user.includes('Requested screen:') ? PLAN_ONE : hit.user.includes('\nRequest:') ? PLAN_GROUP : body0.replace('Screen 1', `Variant ${++n}`)) });
  let cid = '';
  try {
    const created = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 新屏', endpoint: stub.url, model: 'stub-2', apiKey: 'good-key-0002' }) });
    cid = created.body.channel.id;
    const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' });
    expect(probe.body.ok === true, `桩通道探测未通过：${JSON.stringify(probe.body)}`);

    // 1 双击空白处 → 锚点出现、输入框获得焦点、目标区显示「新屏 · 此处」、动词行「造 1 屏 · 此处」；锚点药丸 × 撤掉
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor();
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    // 同一浏览器上下文里更早的用例（TC-CORE-025 选过「另一个可用通道」）可能让它记住了本机 agent 通道：开头就显式选上桩通道
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 新屏');
    expect((await verbLine(page)).includes('造 1 屏 · 自动摆放'), `无目标时动词行应为「造 1 屏 · 自动摆放」：${await verbLine(page)}`);
    const spot = await blankSpot(page);
    expect(!!spot, '找不到画布空白点');
    await page.mouse.dblclick(spot!.x, spot!.y);
    await page.getByTestId('anchor').waitFor({ timeout: 3000 });
    await eventually(async () => expect(await page.evaluate(() => document.activeElement?.id === 'chat-input'), `放锚点后焦点不在输入框：${await page.evaluate(() => document.activeElement?.tagName + '#' + (document.activeElement?.id ?? ''))}`));
    await page.getByTestId('anchor-chip').waitFor({ timeout: 3000 });
    expect((await verbLine(page)).includes('造 1 屏 · 此处'), `动词行应为「造 1 屏 · 此处」：${await verbLine(page)}`);
    await page.getByTestId('anchor-chip').getByRole('button').click();

    await eventually(async () => expect((await page.getByTestId('anchor').count()) === 0, '× 未撤掉锚点'));
    // 2 ⌥G / 工具栏「新建屏幕」也放锚点（可见区中心）；先点空白让焦点离开输入框（输入框内的按键不触发画布快捷键）
    await page.mouse.click(spot!.x, spot!.y);
    await page.waitForTimeout(150);
    await page.keyboard.press('Alt+KeyG');
    await page.getByTestId('anchor').waitFor({ timeout: 3000 });
    await page.getByTestId('clear-targets').click();
    await page.waitForTimeout(200);
    await page.getByTestId('new-screen').click();
    await page.getByTestId('anchor').waitFor({ timeout: 3000 });
    await page.getByTestId('clear-targets').click();
    await page.waitForTimeout(200);
    // 3 在双击点造 1 屏 × 3 版：桩通道、版数 3、动词行写全预计调用数（3 × 2 + 规划 1 = 7）
    await page.mouse.dblclick(spot!.x, spot!.y);
    await page.getByTestId('anchor').waitFor({ timeout: 3000 });
    const world = await page.evaluate((s) => {
      const c = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.world')!).transform);
      return { x: Math.round((s.x - c.left - m.e) / m.a), y: Math.round((s.y - c.top - m.f) / m.a) };
    }, spot!);
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 新屏');
    await page.getByTestId('versions-3').click();
    expect((await page.getByTestId('versions-3').getAttribute('aria-checked')) === 'true', '版数 3 未选中');
    expect((await verbLine(page)).includes('造 1 屏 × 3 版 · 此处 = 5 次调用'), `动词行应写全屏数 × 版数与调用数：${await verbLine(page)}`);
    await page.fill('#chat-input', '订单详情页：状态时间线、商品清单、费用明细');
    const hits0 = stub.hits.length;
    const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
    const res = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
    await page.keyboard.press('Enter');
    const sent = JSON.parse((await req).postData() ?? '{}') as { targetScreenIds?: string[]; count?: unknown; versions?: number; anchor?: { x: number; y: number } };
    expect(!sent.targetScreenIds && sent.count === 1 && sent.versions === 3 && sent.anchor?.x === world.x && sent.anchor?.y === world.y, `请求体不对：${JSON.stringify(sent)}`);
    const created2 = (await (await res).json()) as { job: { id: string; kind: string } };
    expect(created2.job?.kind === 'generate', `作业类型不是 generate：${JSON.stringify(created2.job)}`);
    // 4 作业成功：只新增 1 张屏（无 -2 后缀）、purpose 落库、3 条候选修订（同 jobId、candidateIndex 0/1/2）、current = 第 0 版、以锚点为中心；
    //   桩收到 1 次规划 + 3 次出屏且出屏提示写明暂不跳转；新屏成为样板屏（首轮默认）；造完自动选中新屏，动词行变「改 1 屏」
    const jobId = created2.job.id;
    await waitJob(jobId, 120);
    let d = await detail();
    for (let i = 0; i < 40; i++) { d = await detail(); const f = d.screens.filter((s) => s.id !== screens[0].id); if (f.length === 1 && f[0].screenshotUrl && d.activeJobs.length === 0) break; await new Promise((r) => setTimeout(r, 1500)); }
    const fresh = d.screens.filter((s) => s.id !== screens[0].id);
    expect(fresh.length === 1, `应只新增 1 屏（候选不是独立屏），实得 ${fresh.length}`);
    const s1 = fresh[0];
    expect(s1.route === '/order-detail' && s1.name === 'Order Detail' && s1.purpose === 'show one order', `路由 / 名称 / purpose 不对：${s1.route} ${s1.name} ${s1.purpose}`);
    expect(Math.abs(s1.x + s1.width / 2 - world.x) <= 2 && Math.abs(s1.y + s1.height / 2 - world.y) <= 2, `应以锚点 (${world.x}, ${world.y}) 为中心：(${s1.x}, ${s1.y})`);
    const revs = (await apiJson<{ items: { id: string; jobId: string | null; candidateIndex: number | null; candidateSettledAt: string | null }[] }>(`/v1/screens/${s1.id}/revisions`)).body.items;
    expect(revs.length === 3 && revs.every((r) => r.jobId === jobId && r.candidateIndex !== null && !r.candidateSettledAt) && [0, 1, 2].every((i) => revs.some((r) => r.candidateIndex === i)), `应有 3 条同作业候选修订：${JSON.stringify(revs.map((r) => [r.candidateIndex, r.jobId === jobId]))}`);
    expect(revs.find((r) => r.candidateIndex === 0)!.id === s1.currentRevisionId, 'current 应默认指向第 0 版');
    expect(s1.pendingCandidates?.count === 3, `ScreenDto.pendingCandidates 应为 3：${JSON.stringify(s1.pendingCandidates)}`);
    expect(d.project.exemplarScreenId === s1.id, '首轮生成后新屏应成为默认样板屏');
    const mine = stub.hits.slice(hits0).filter((h) => h.model === 'stub-2');
    const plans = mine.filter((h) => h.user.includes('Requested screen:'));
    const gens = mine.filter((h) => h.user.startsWith('Generate the screen'));
    expect(plans.length === 1 && gens.length === 3, `桩应收到 1 次规划 + 3 次出屏，实收 规划 ${plans.length} / 出屏 ${gens.length}`);
    expect(gens.every((h) => h.user.includes('does not need to navigate')), '规划无链接时，出屏提示应写明这一屏暂不需要跳转');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="screen-card"]').length === 2, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="verb-line"]')?.textContent?.includes('改 1 屏'), null, { timeout: 10000 });
    expect((await page.getByTestId('target-chip').count()) === 1 && (await page.getByTestId('target-chip').innerText()).includes('Order Detail'), '造完没有自动把新屏设为目标');
    // 5 候选：卡片角标「还有 2 版候选」→ 覆盖层 3 列 × 1 行 → 采用第 2 版 → current 指向 index 1、同批结清、角标消失、修订面板折成一组
    //   先适配视图：锚点落在哪里由双击点决定，新卡片可能压在对话面板底下，角标点不到
    await page.getByRole('button', { name: '适配视图' }).click();
    await page.waitForTimeout(600);
    // 角标画在卡片外的同坐标槽位上（卡片自成层叠上下文，留在里面展开态就点不到），所以按角标自己的 data-route 找
    const badge = page.locator(`[data-testid="candidate-badge"][data-route="/order-detail"]`);
    await badge.waitFor({ timeout: 10000 });
    expect((await badge.innerText()).includes('3 版'), `角标文案：${await badge.innerText()}`);
    // 收起态：卡片后面叠着错位底板；点角标就地横向展开成 3 格（第 1 版留在原位，其余排到右边一行），动作在每格右上角的浮层胶囊里，第 1 格带「收起」
    expect((await page.locator('.cand-ghost').count()) >= 2, '有候选的卡片后面没有叠底板');
    await badge.click();
    const overlay = page.getByTestId('candidate-stack');
    await overlay.waitFor({ timeout: 5000 });
    await overlay.getByTestId('candidate-cell').first().waitFor({ timeout: 10000 });
    expect((await overlay.getByTestId('candidate-cell').count()) === 3 && (await overlay.getByTestId('candidate-cell').nth(0).getAttribute('data-current')) !== null, '展开层应为 3 格且第 1 格是当前');
    expect((await overlay.getByTestId('candidate-collapse').count()) === 1, '第 1 格没有「收起」');
    const cellBox = (await overlay.getByTestId('candidate-cell').nth(1).boundingBox())!; const cardBox = (await page.locator('[data-testid="screen-card"][data-route="/order-detail"]').boundingBox())!;
    const cell3 = (await overlay.getByTestId('candidate-cell').nth(2).boundingBox())!;
    expect(cellBox.x > cardBox.x + cardBox.width - 1 && Math.abs(cellBox.width - cardBox.width) < 2 && cell3.x > cellBox.x + cellBox.width - 1 && Math.abs(cell3.y - cellBox.y) < 1, '各版没有按卡片同尺寸横向排成一行');
    // 每格是该版的活 iframe：src 带各自的 rev、格内能滚动
    const frames = overlay.locator('[data-testid="candidate-cell"] iframe');
    expect((await frames.count()) === 3 && new Set(await frames.evaluateAll((els) => els.map((e) => (e as HTMLIFrameElement).src.match(/rev=([^&]+)/)?.[1]))).size === 3, '候选格没有各自的活 iframe');
    const f1 = page.frame({ url: (await frames.nth(1).getAttribute('src'))! })!;
    await f1.waitForLoadState();
    expect((await f1.evaluate(() => { window.scrollTo(0, 200); return window.scrollY; })) > 0 || (await f1.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)), '候选 iframe 内不能滚动');
    await overlay.getByTestId('adopt-one-1').click();
    await page.waitForTimeout(800);
    d = await detail();
    const after = d.screens.find((s) => s.id === s1.id)!;
    const revs2 = (await apiJson<{ items: { id: string; candidateIndex: number | null; candidateSettledAt: string | null }[] }>(`/v1/screens/${s1.id}/revisions`)).body.items;
    expect(after.currentRevisionId === revs2.find((r) => r.candidateIndex === 1)!.id, '采用后 current 未指向第 1 版');
    expect(revs2.every((r) => !!r.candidateSettledAt) && after.pendingCandidates === null, '采用后同批未结清 / 角标未消失');
    expect(revs2.length === 3, '采用不该新建修订');
    await overlay.waitFor({ state: 'detached', timeout: 3000 });   // 采用后自动收起
    expect((await badge.count()) === 0 && (await page.locator('.cand-ghost').count()) === 0, '采用后卡片角标 / 底板仍在');
    await page.locator(`[data-testid="screen-card"][data-route="/order-detail"] .gesture`).click();
    await page.getByRole('button', { name: '修订' }).click();
    await page.getByTestId('candidate-group').waitFor({ timeout: 5000 });
    expect((await page.getByTestId('candidate-group').count()) === 1 && (await page.locator('[data-testid="revision"]').count()) === 3 && (await page.getByTestId('adopt-revision').count()) === 0, '修订面板应把 3 版折成一组且没有可采用项');
    await page.keyboard.press('Alt+KeyR');
    // 6 造一组（屏数 2）：整组规划、按流程顺序排成一行摆在锚点、反向连线（对入口屏 /s1 跑一次补链，回执点名）
    //   同时验「目标不为空时后台造屏不接管」：先把目标与草稿摆好，再从 API 发这一轮（等价于 MCP / 另一个标签页建的作业）
    const before1 = (await apiJson<{ items: unknown[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items.length;
    await page.locator(`[data-testid="screen-card"][data-route="/order-detail"] .gesture`).click();
    await page.getByTestId('target-chip').filter({ hasText: 'Order Detail' }).waitFor({ timeout: 5000 });
    const keepDraft = '把费用明细挪到最上面';
    await page.fill('#chat-input', keepDraft);
    const grp = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '结账流程', count: 2, versions: 1, anchor: { x: 2600, y: 400 }, runner: { kind: 'channel', channelId: cid } }) });
    expect(grp.status === 202, `造一组返回 ${grp.status} ${JSON.stringify(grp.body)}`);
    // 页面要真认领这个作业，「收口不顶目标」才是被验到的（认领来的作业没有进度事件，chip 上兜底写「排队中…」）
    const bgChip = page.locator(`[data-testid="job-chip"][data-job-id="${grp.body.job.id}"]`);
    await bgChip.waitFor({ timeout: 15000 });
    expect((await bgChip.innerText()).includes('排队中…') || /正在/.test(await bgChip.innerText()), `在跑的作业 chip 没有进度文案：${(await bgChip.innerText()).replace(/\s+/g, ' ')}`);
    const jg = await waitJob(grp.body.job.id, 120) as { status: string; output?: { message?: string } };
    expect(jg.status === 'succeeded', `造一组未成功：${jg.status} ${jg.output?.message ?? ''}`);
    d = await detail();
    const group = d.screens.filter((s) => ['/cart', '/checkout'].includes(s.route)).sort((a, b) => a.x - b.x);
    expect(group.length === 2 && group[0].route === '/cart' && group[1].route === '/checkout' && group[0].y === group[1].y && group[1].x > group[0].x + group[0].width, `一组屏应按流程顺序排成一行：${JSON.stringify(group.map((s) => [s.route, s.x, s.y]))}`);
    expect(Math.abs(group[0].x + group[0].width / 2 - 2600) <= 2, '第一张应以锚点为中心');
    const after1 = (await apiJson<{ items: unknown[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items.length;
    expect(after1 === before1 + 1, `入口屏 /s1 应因反向连线多一条修订（${before1} → ${after1}）`);
    const msgs = (await apiJson<{ items: { role: string; content: string; jobId: string | null }[] }>(`/v1/projects/${projectId}/messages`)).body.items;
    const receipt = msgs.find((m) => m.role === 'assistant' && m.jobId === grp.body.job.id)!;
    expect(receipt.content.includes('已生成 2 屏') && receipt.content.includes('已把「Screen 1」接到新屏'), `回执未点名反向连线：${receipt.content}`);
    // 6b 后台造屏收口不顶掉正在写的目标与草稿（目标为空时才自动选中新屏）
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="screen-card"]').length === 4, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    const chips = await page.getByTestId('target-chip').allInnerTexts();
    expect(chips.length === 1 && chips[0].includes('Order Detail'), `后台造屏收口把目标顶掉了：${JSON.stringify(chips)}`);
    expect((await page.locator('#chat-input').inputValue()) === keepDraft, '后台造屏收口把草稿清了');
    await shot(page, 'CORE-029');
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
  return '双击 / ⌥G / 工具栏都放锚点并聚焦输入框；造 1 屏 × 3 版 = 1 屏 3 条候选修订、current 第 0 版、以锚点为中心、默认样板屏、造完自动成目标；就地展开采用第 2 版结清并收角标、修订面板折组；造一组按流程排一行并对入口屏反向连线';
});

// 改 3 屏 × 2 版并整组采用（REQ-CORE-006 / REQ-CORE-015）
await step('TC-CORE-030', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Versions', '--device', 'mobile', '--screens', '3', '--no-shot');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  let n = 0;
  const stub = startOpenAiStub({ port: 3997, apiKey: 'good-key-0003', reply: () => body0.replace('Screen 1', `Revised ${++n}`) });
  const seededBusy: string[] = [];   // 第 3b 步占屏用的种子作业，收尾一律取消
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 版数', endpoint: stub.url, model: 'stub-3', apiKey: 'good-key-0003' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor();
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 版数');
    // 1 ⌘A + 版数 2：动词行「改全部 3 屏 × 2 版 = 6 次调用」；屏数控件在改时不出现
    await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(200);
    await page.getByTestId('versions-2').click();
    expect((await verbLine(page)).includes('改全部 3 屏 × 2 版 = 6 次调用'), `动词行：${await verbLine(page)}`);
    expect((await page.getByTestId('count-group').count()) === 0, '改的时候不该出现屏数控件');
    const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
    const res = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
    await page.fill('#chat-input', '顶部导航改成标签栏');
    await page.keyboard.press('Enter');
    const sent = JSON.parse((await req).postData() ?? '{}') as { targetScreenIds?: string[]; versions?: number };
    expect(sent.targetScreenIds?.length === 3 && sent.versions === 2, `请求体不对：${JSON.stringify(sent)}`);
    const editJob = ((await (await res).json()) as { job: { id: string } }).job.id;
    expect((await waitJob(editJob, 120)).status === 'succeeded', '改 3 屏 × 2 版的作业没成功');
    // 2 每屏各得 2 条候选、current 为第 0 版；任一屏的角标打开的都是同一个覆盖层：2 列 × 3 行
    type Detail = { screens: { id: string; route: string; currentRevisionId: string | null; pendingCandidates: { jobId: string; count: number } | null }[] };
    let d = (await apiJson<Detail>(`/v1/projects/${projectId}`)).body;
    expect(d.screens.every((s) => s.pendingCandidates?.count === 2), `每屏应有 2 版待采用：${JSON.stringify(d.screens.map((s) => s.pendingCandidates))}`);
    const jobIds = new Set(d.screens.map((s) => s.pendingCandidates!.jobId));
    expect(jobIds.size === 1, '三屏的候选应属同一作业');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="candidate-badge"]').length === 3, null, { timeout: 15000 });
    await page.locator('[data-testid="candidate-badge"]').nth(1).click();
    const overlay = page.getByTestId('candidate-stack');
    await overlay.waitFor({ timeout: 5000 });
    await overlay.getByTestId('candidate-cell').first().waitFor({ timeout: 10000 });
    expect((await overlay.getByTestId('candidate-cell').count()) === 2, `展开层应为该屏的 2 格，实际 ${await overlay.getByTestId('candidate-cell').count()} 格`);
    // 3 展开期间排列条让位：胶囊与排列条争同一条横带（排列条 y 64~106、胶囊 y 74~106）且排列条压在上面，
    //   不让位就会把「收起」点成「右对齐」并把新位置落库
    await page.keyboard.press('ControlOrMeta+a');

    await eventually(async () => expect((await page.getByTestId('arrange-bar').count()) === 0, '候选就地展开时排列条没让位（它会挡住每格上方的动作胶囊）'));
    expect(((await overlay.getByTestId('adopt-group-1').getAttribute('aria-label')) ?? '').includes('3 屏'), '「采用这一组」没写明屏数');
    // 3b 服务端把每一屏都跳过时：说明跳过、不结清、展开层留着等重试（此前一律报成功并自动收起）
    for (const s of screens) seededBusy.push(seedJson<{ jobId: string }>('seed:job', '--project', projectId, '--screen', s.id).jobId);
    await overlay.getByTestId('adopt-group-1').click();
    await page.getByText('都跳过了').waitFor({ timeout: 10000 });
    d = (await apiJson<Detail>(`/v1/projects/${projectId}`)).body;
    expect(d.screens.every((s) => s.pendingCandidates?.count === 2), `一屏都没采用却动了候选：${JSON.stringify(d.screens.map((s) => s.pendingCandidates))}`);
    expect((await overlay.count()) === 1, '一屏都没采用，展开层却收起了（用户没法重试或逐屏采用）');
    for (const id of seededBusy) await apiJson(`/v1/jobs/${id}/cancel`, { method: 'POST' });
    await page.waitForTimeout(800);
    // 4 多屏作业每格带「采用这一组（3 屏）」→ 三屏 current 都指向 index 1、角标全消失
    await overlay.getByTestId('adopt-group-1').click();
    await page.waitForTimeout(1000);
    d = (await apiJson<Detail>(`/v1/projects/${projectId}`)).body;
    for (const s of d.screens) {
      const revs = (await apiJson<{ items: { id: string; candidateIndex: number | null; candidateSettledAt: string | null }[] }>(`/v1/screens/${s.id}/revisions`)).body.items;
      expect(revs.find((r) => r.candidateIndex === 1)?.id === s.currentRevisionId, `${s.route} 未整组采用第 2 版`);
      expect(revs.filter((r) => r.candidateIndex !== null).every((r) => !!r.candidateSettledAt), `${s.route} 候选未结清`);
    }
    expect(d.screens.every((s) => s.pendingCandidates === null), '整组采用后仍有待采用候选');
    await overlay.waitFor({ state: 'detached', timeout: 3000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="candidate-badge"]').length === 0, null, { timeout: 10000 });
    await page.getByTestId('arrange-bar').waitFor({ timeout: 3000 });   // 收起后让位结束（三屏仍在选中）
    await shot(page, 'CORE-030');
  } finally {
    for (const id of seededBusy) await apiJson(`/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
    await stub.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {});
  }
  return '⌘A × 2 版动词行写全 6 次调用；每屏 2 条候选同一作业；就地展开 2 格且排列条让位；全部被跳过时说明跳过、不收起；整组采用第 2 版并结清';
});

await step('TC-CORE-009', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Del', '--device', 'mobile', '--screens', '3', '--no-shot');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.locator('[data-testid="screen-card"][data-route="/s2"] .gesture').click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: '删除' }).last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="screen-card"]').length === 2);
  const map = await apiJson<{ edges: { fromScreenId: string; href: string; toScreenId: string | null }[] }>(`/v1/projects/${projectId}/app-map`);
  expect(map.body.edges.some((e) => e.fromScreenId === screens[0].id && e.href === '/s2' && e.toScreenId === null), 's1→/s2 未变为断链');
  seedJson('seed:job', '--project', projectId, '--screen', screens[2].id, '--status', 'running');
  const del = await apiJson<{ type: string }>(`/v1/screens/${screens[2].id}`, { method: 'DELETE' });
  expect(del.status === 409 && del.body.type === '/errors/screen-busy', `占用屏删除返回 ${del.status}`);
  await shot(page, 'CORE-009');
});
