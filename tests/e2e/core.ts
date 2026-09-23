import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, previewHost, EVIDENCE, ROOT, WEB, API, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';
import { pickOption } from './lib.ts';

// docs/TEST.md CORE 域用例（TC-CORE-003~031）的 AI 执行脚本。每条用例独立前置（种子构造），
// 输出「TC 结果 备注」，证据截图落 docs/test-runs/run-<RUN>-tc-core-NNN.png。执行者=人工 的用例登记「待人工」。
// v0.32 本地版无账号：TC-CORE-001 / 002 / 021（登录、过期链接、未登录守卫）随 REQ-CORE-001 推迟。
const RUN = process.env.RUN ?? '001';
const LIVE_LLM = process.env.LIVE_LLM !== '0'; // 真实生成用例（005/012/020）需要 LLM；设 LIVE_LLM=0 跳过
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: '通过' | '失败' | '待人工' | '跳过'; note: string }[] = [];
const record = (tc: string, ok: boolean | 'manual' | 'skip', note = '') => {
  const result = ok === 'manual' ? '待人工' : ok === 'skip' ? '跳过' : ok ? '通过' : '失败';
  results.push({ tc, result, note });
  console.log(`${result === '通过' ? '✅' : result === '失败' ? '❌' : '⏭'} ${tc} ${result} ${note}`);
};
const shot = (page: import('playwright').Page, tc: string) => page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-${tc.toLowerCase()}.png`) });
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
let currentPage: import('playwright').Page | null = null;
const step = async (tc: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  try { const note = await fn(); record(tc, true, note ?? ''); }
  catch (e) {
    record(tc, false, (e as Error).message.split('\n')[0].slice(0, 300));
    await currentPage?.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch((err) => console.log('   (截图失败:', (err as Error).message.split('\n')[0], ')'));
  }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const waitJob = async (jobId: string, maxSec = 180) => {
  for (let i = 0; i < maxSec / 3; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { body } = await apiJson<{ job: { status: string; output: unknown } }>(`/v1/jobs/${jobId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(body.job.status)) return body.job;
  }
  throw new Error('job timeout');
};
// 真正的画布空白 = 命中点上最顶层元素就是画布本身（浮层：对话、工具栏、面板、输入框都不算）
const blankSpot = (pg: import('playwright').Page) => pg.evaluate(() => {
  const canvas = document.querySelector('[data-testid="canvas"]')!;
  const c = canvas.getBoundingClientRect();
  for (let y = c.top + 100; y < c.bottom - 100; y += 40) for (let x = c.left + 100; x < c.right - 100; x += 40) {
    const el = document.elementFromPoint(x, y);
    if (el === canvas || (el && el.classList.contains('world'))) return { x, y };
  }
  return null;
});
const verbLine = (pg: import('playwright').Page) => pg.getByTestId('verb-line').innerText();

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// 活跃 SSE 计数探针（TC-CORE-036 第 10 步）：一个标签页应恒定只开一条项目事件流
await ctx.addInitScript(`(() => { window.__sseOpen = 0; const O = window.EventSource; function W(u, i) { const es = new O(u, i); window.__sseOpen += 1; const c = es.close.bind(es); let done = false; es.close = () => { if (!done) { done = true; window.__sseOpen -= 1; } c(); }; return es; } W.prototype = O.prototype; window.EventSource = W; })()`);
const page = await ctx.newPage();
currentPage = page;
const consoleErrors: string[] = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));

// 首次运行的第一屏（PAGE-FIRST）只在一个项目都没有时出现：在建示例项目之前先量它的品牌符号与字标（TC-CORE-026 第 1、2 步），
// 结论存起来，到 TC-CORE-026 再一起登记
seed('seed', '--empty');
const brandFirstRun = await (async (): Promise<string> => {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.getByText('还没有项目').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const sym = await page.locator('img[src="/brand/symbol-reverse.svg"]').evaluate((el) => {
    const i = el as HTMLImageElement; const r = i.getBoundingClientRect();
    return { w: r.width, h: r.height, natural: i.naturalWidth, pad: parseFloat(getComputedStyle(i.parentElement!).paddingTop) };
  });
  expect(sym.natural > 0, '品牌符号未加载（naturalWidth=0）');
  expect(sym.w >= 64 && sym.h >= 64, `符号 ${sym.w}×${sym.h} 低于品牌下限 64 px`);
  expect(Math.abs(sym.pad - sym.w / 8) < 1, `安全区不是坐标框的 1/8：padding ${sym.pad} vs ${sym.w / 8}`);
  expect(await page.evaluate(() => document.fonts.check('500 16px "Space Grotesk"')), 'Space Grotesk 未加载');
  const wm = await page.locator('.wordmark').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { family: cs.fontFamily.split(',')[0].replace(/"/g, ''), weight: cs.fontWeight, tracking: parseFloat(cs.letterSpacing), size: parseFloat(cs.fontSize) };
  });
  expect(wm.family === 'Space Grotesk' && wm.weight === '500', `字标字体/字重不符：${JSON.stringify(wm)}`);
  expect(Math.abs(wm.tracking / wm.size + 0.03) < 0.005, `字标字距不是 -0.03 em：${wm.tracking}px / ${wm.size}px`);
  await shot(page, 'CORE-026-first-run');
  return `首屏符号 ${Math.round(sym.w)} px、字标 Space Grotesk 500`;
})().catch((e: Error) => e.message);
seed('seed');
await openApp(page);

// ---------- 项目 ----------
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
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
  await page.goto(`${WEB}/p/${petProjectId}`);
  await page.fill('#chat-input', '做一个宠物社交 APP');
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 40000 });
  await page.locator('.bg-panel-2', { hasText: '已生成' }).waitFor({ timeout: 150000 });
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

await step('TC-CORE-020', async () => 'manual' as never).catch(() => {});
results.pop(); record('TC-CORE-020', 'manual', '对标 Stitch 盲评，AI 按纪律跳过');

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
  // no-shot 的屏无截图（骨架），帧率测试关注卡片渲染与懒加载；再用有截图的 Layout 项目验证 img 懒加载
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.getByRole('button', { name: '适配视图' }).click();
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-testid="canvas"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(`(() => { window.__f = 0; window.__long = 0; window.__t0 = performance.now(); const tick = () => { window.__f++; window.__raf = requestAnimationFrame(tick); }; window.__raf = requestAnimationFrame(tick); new PerformanceObserver((l) => { window.__long += l.getEntries().filter(e => e.duration > 100).length; }).observe({ type: 'longtask' }); })()`);
  await page.keyboard.down('Control'); for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(80); } await page.keyboard.up('Control');
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(i % 2 ? 60 : -60, i % 3 ? 50 : -50); await page.waitForTimeout(80); }
  await page.keyboard.down('Control'); for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, i % 2 ? 90 : -90); await page.waitForTimeout(80); } await page.keyboard.up('Control');
  const r = await page.evaluate(`(() => { cancelAnimationFrame(window.__raf); const dt = (performance.now() - window.__t0) / 1000; return { fps: Math.round(window.__f / dt), long: window.__long, dt: +dt.toFixed(1) }; })()`) as { fps: number; long: number; dt: number };
  expect(r.fps >= 55, `fps=${r.fps}`);
  expect(r.long === 0, `长任务 ${r.long}`);
  const cards = await page.locator('[data-testid="screen-card"]').count();
  await shot(page, 'CORE-008');
  return `${cards} 屏 ${r.fps} fps / ${r.dt}s，长任务 ${r.long}`;
});

await step('TC-CORE-023', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'ShellCheck', '--device', 'mobile', '--screens', '4');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.waitForTimeout(800);

  // 1 四处 chrome 两两不重叠
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [name, sel] of [['顶栏', 'header'], ['对话记录', 'aside[aria-label="对话记录"]'], ['输入框', 'form.composer'], ['工具栏', '[role="toolbar"]']] as const) {
    const b = await page.locator(sel).first().boundingBox();
    expect(b, `${name}未渲染`); boxes[name] = b!;
  }
  for (const [an, a] of Object.entries(boxes)) for (const [bn, b] of Object.entries(boxes)) {
    if (an >= bn) continue;
    expect(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), `${an} 与 ${bn} 重叠`);
  }

  // 2 顶栏是渐暗遮罩而非玻璃面板，且遮罩下半段不拦指针
  const hd = await page.locator('header').first().evaluate((el) => {
    const cs = getComputedStyle(el); const bf = getComputedStyle(el, '::before');
    return { bg: cs.backgroundColor, filter: cs.backdropFilter, border: cs.borderBottomWidth, scrim: bf.backgroundImage, scrimH: parseFloat(bf.height), rowH: el.getBoundingClientRect().height };
  });
  expect(hd.filter === 'none' && hd.border === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(hd.bg), `顶栏不是无底板遮罩：${JSON.stringify(hd)}`);
  expect(hd.scrim.includes('linear-gradient') && hd.scrimH > hd.rowH, `遮罩渐变缺失或不高于内容行：${hd.scrimH}/${hd.rowH}`);
  expect(await page.evaluate((y) => document.elementFromPoint(window.innerWidth / 2, y)?.closest('header') === null, hd.scrimH - 20), '遮罩下半段拦住了指针');

  // 3 工具栏命中区与 roving tabindex
  const hits = await page.locator('[role="toolbar"] button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { n: e.getAttribute('aria-label'), w: r.width, h: r.height, t: e.getAttribute('tabindex') }; }));
  expect(hits.length > 0 && hits.every((x) => x.w >= 44 && x.h >= 44), `命中区不足 44：${JSON.stringify(hits.filter((x) => x.w < 44 || x.h < 44))}`);
  expect(hits.filter((x) => x.t === '0').length === 1, `工具栏 Tab 停靠点不是 1 个`);
  await page.locator('[role="toolbar"] button[tabindex="0"]').focus();
  const f0 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('ArrowDown');
  const f1 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  expect(f0 !== f1 && !!f1, `方向键未在组内移动焦点（${f0} → ${f1}）`);

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

  // 6b ⌘/ 收起 / 叫回输入框（v0.33）：焦点在输入框里也生效；草稿留着、光标落回输入区、安全区底部随之放开；收起后底部中央留一个回来的入口
  const safeBottom = () => page.getByTestId('safe-area').evaluate((el) => el.getBoundingClientRect().bottom);
  const composerShown = () => page.locator('form.composer').isVisible();
  const sb0 = await safeBottom();
  await page.fill('#chat-input', '草稿');
  await page.keyboard.press('ControlOrMeta+Slash');

  await eventually(async () => expect(!(await composerShown()), '⌘/ 未收起输入框（焦点在输入框内）'));
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 20)?.closest('[data-testid="canvas"]') !== null), '收起后底部还留着浮层');
  expect((await safeBottom()) - sb0 > 100, `收起后安全区底部未放开：${sb0} → ${await safeBottom()}`);
  await page.keyboard.press('ControlOrMeta+Slash');

  await eventually(async () => expect(await composerShown(), '⌘/ 未叫回输入框'));
  expect((await page.locator('#chat-input').inputValue()) === '草稿', '叫回后草稿丢了');
  expect(await page.evaluate(() => document.activeElement?.id === 'chat-input'), '叫回后光标没落回输入区');
  expect(Math.abs((await safeBottom()) - sb0) < 1, '叫回后安全区底部没复原');
  // 6c 工具栏「输入框」与 ⌘/ 是同一开关，aria-pressed 跟着显隐翻转
  await page.getByTestId('toggle-composer').click();
  await eventually(async () => expect(!(await composerShown()) && (await page.getByTestId('toggle-composer').getAttribute('aria-pressed')) === 'false', '工具栏「收起输入框」未收起或 aria-pressed 未翻转'));
  await page.getByTestId('toggle-composer').click();
  await eventually(async () => expect((await composerShown()) && (await page.locator('#chat-input').inputValue()) === '草稿', '工具栏「显示输入框」未叫回或草稿丢了'));
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

  // 7 折叠对话记录并刷新保持；输入框的横向落点不得被侧边浮层的开合搬走
  const composerBox = async () => (await page.locator('form.composer').boundingBox())!;
  const cx = (await composerBox()).x;
  await page.getByRole('button', { name: '折叠对话记录' }).click();

  await eventually(async () => expect((await page.locator('[data-testid="chat-dock"][data-state="collapsed"]').count()) === 1 && (await page.locator('aside[aria-label="对话记录"] [role="log"]').count()) === 0, '对话记录未折叠（应只剩左下角横条）'));
  expect(Math.abs((await composerBox()).x - cx) < 1, `折叠对话记录把输入框搬走了 ${((await composerBox()).x - cx).toFixed(1)}px`);
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  // 与开头同样等 800 ms：输入框宽度按工具条量（v0.50），通道名要等通道目录取回才定，刚加载完那几百毫秒里它还在变宽、x 还没落定

  await eventually(async () => expect(await page.evaluate(() => document.querySelector('[data-testid="chat-dock"]')?.getAttribute('data-state') === 'collapsed'), '刷新后折叠态丢失'));
  await page.getByRole('button', { name: '展开对话记录' }).click();

  await eventually(async () => expect(await page.locator('aside[aria-label="对话记录"] [role="log"]').isVisible(), '无法重新展开'));
  // 左下角、底部对齐：横条与展开面板的底边都贴在输入框同一水平线附近，不再从顶栏下方垂下来
  const dockBox = (await page.getByTestId('chat-dock').boundingBox())!;
  expect(dockBox.y > 300 && dockBox.x < 40, `对话记录不在左下角：${JSON.stringify(dockBox)}`);
  expect(Math.abs((await composerBox()).x - cx) < 1, '重新展开后输入框没回到原位');
  // 右侧面板滑出时允许让位，但只让到刚好不被压住为止，不多挪一像素
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
  await page.locator(`[data-testid="running-job"][data-job-id="${seedJob.jobId}"]`).getByTestId('cancel-job').waitFor({ timeout: 10000 });
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
  // 窄视口下输入框工具条折行、变高：对话记录必须停在它上方（安全区底部占位跟着实际高度走）
  const dockM = (await page.getByTestId('chat-dock').boundingBox())!; const compM = (await page.locator('form.composer').boundingBox())!;
  expect(dockM.y + dockM.height <= compM.y + 1, `390px 下对话记录压住了输入框：dock 底 ${dockM.y + dockM.height} > 输入框顶 ${compM.y}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  return `四处浮层不重叠；工具栏 ${hits.length} 键命中区 ≥44、Tab 停靠 1 个；单键 F/L 生效、d/t/r 不误触、Alt 组合开面板`;
});

await step('TC-CORE-024', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string; name: string }[] }>('seed:project', '--name', 'MultiSel', '--device', 'mobile', '--screens', '4');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.getByRole('button', { name: '适配视图' }).click();
  await page.waitForTimeout(700);
  const card = (r: string) => page.locator(`[data-testid="screen-card"][data-route="${r}"]`);

  // 1 Shift 加选
  await card('/s1').locator('.gesture').click();
  await card('/s3').locator('.gesture').click({ modifiers: ['Shift'] });

  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 2, ' Shift 加选后不是 2 屏'));
  const chips = page.getByTestId('target-chip');
  expect((await chips.count()) === 2, '输入框未列出 2 个目标标签');
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
  const sent = JSON.parse((await req).postData() ?? '{}') as { targetScreenIds?: string[] };
  expect(sent.targetScreenIds?.length === 4, `targetScreenIds 不是 4 屏：${JSON.stringify(sent.targetScreenIds)}`);
  expect(screens.every((s) => sent.targetScreenIds!.includes(s.id)), 'targetScreenIds 与选中集合不一致');
  const sentJob = (await (await res).json()) as { job: { id: string } };
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

  // 清单：只给标识与显示名；缺凭据的驱动照样列出但标为不可用
  const list = (await apiJson<{ items: { id: string; label: string; hint?: string; available: boolean; unavailableReason?: string; runner: Record<string, string> }[]; default: string }>('/v1/runners')).body;
  expect(list.items.length >= 2 && list.items.some((i) => i.runner.kind === 'agent') && list.items.some((i) => i.runner.kind === 'channel'), '通道清单缺云端通道（seed 会按 .env 的 GEMINI_API_KEY 建一条）或本机 agent');
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
  // 「管理通道…」是 listbox 里的哨兵项（键盘可达），计数时剔除；lobehub 图标的 <title> 会混进 innerText，只做包含判断
  const opts = await listbox.getByRole('option').evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="manage-channels"]')).map((e) => (e as HTMLElement).innerText));
  const avail = list.items.filter((i) => i.available);
  expect(opts.length === avail.length, `下拉项 ${opts.length} ≠ 可用通道 ${avail.length}`);
  for (const u of unavailable) expect(!opts.some((t) => t.includes(u.label)), `不可用通道「${u.label}」不该出现在下拉里`);
  expect((await listbox.innerText()).includes('云端模型'), '列表未按「云端模型 / 本机 agent」分组');
  expect(await page.getByTestId('manage-channels').isVisible(), '下拉末尾没有「管理通道…」入口');
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
  const nav = page.locator('header.scrim-top');
  expect((await nav.locator('.wordmark').count()) === 0, '画布顶栏仍挂着品牌字标');
  const navFirst = await nav.evaluate((el) => el.firstElementChild?.getAttribute('data-testid') ?? el.firstElementChild?.tagName ?? '');
  expect(navFirst === 'project-switcher', `画布顶栏左上第一个元素不是项目切换器：${navFirst}`);

  // 3 外壳配色取自品牌包，且深底正文对比度达标
  // token 值在页面里读、比值在 Node 里算——tsx 会往 evaluate 的闭包里注入 __name 导致页面侧报错
  const sw = await page.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const probe = (n) => { const d = document.createElement('div'); d.style.color = cs.getPropertyValue(n).trim(); document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return { canvas: probe('--color-canvas'), panel: probe('--color-panel'), fg: probe('--color-fg'), muted: probe('--color-muted'),
             accent: probe('--color-accent'), accentStrong: probe('--color-accent-strong'), onAccent: probe('--color-on-accent') };
  })()`) as Record<string, string>;
  const lum = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
    const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
  // 面板底 = 品牌 Ink #142033；动作色 = 界面蓝 #356FD6
  expect(sw.panel === 'rgb(20, 32, 51)', `面板底不是品牌 Ink：${sw.panel}`);
  expect(sw.accent === 'rgb(53, 111, 214)', `动作色不是品牌界面蓝：${sw.accent}`);
  const pairs = {
    'fg/panel': ratio(sw.fg, sw.panel), 'muted/panel': ratio(sw.muted, sw.panel),
    'fg/canvas': ratio(sw.fg, sw.canvas), 'muted/canvas': ratio(sw.muted, sw.canvas),
    'accentStrong/panel': ratio(sw.accentStrong, sw.panel), 'onAccent/accent': ratio(sw.onAccent, sw.accent),
  };
  for (const [k, v] of Object.entries(pairs)) expect(v >= 4.5, `${k} 对比度 ${v} 低于正文线 4.5`);

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
  return `${brandFirstRun} / -0.03em · 对比度 ${JSON.stringify(pairs)}`;
});

await step('TC-CORE-027', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'ImgRef', '--device', 'mobile', '--screens', '2', '--no-shot');
  // 造一张纯色 PNG 当参考图（内容不重要，这条用例验的是通道不是模型）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const ref = path.join(EVIDENCE, `run-${RUN}-ref.png`);
  await writeFile(ref, png);

  // 1 契约：类型与大小在签发时就挡住
  const bad = await apiJson(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/svg+xml', bytes: 100 }) });
  expect(bad.status === 400, `SVG 未被拒：${bad.status}`);
  const big = await apiJson(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: 50 * 1024 * 1024 }) });
  expect(big.status === 400, `超大附件未被拒：${big.status}`);

  // 2 通道清单标注视觉能力；挑一个支持的
  const runners = (await apiJson<{ items: { id: string; label: string; available: boolean; vision: boolean; runner: Record<string, string> }[] }>('/v1/runners')).body.items;
  expect(runners.every((r) => typeof r.vision === 'boolean'), '通道清单没有 vision 标记');
  const seeing = runners.find((r) => r.vision && r.available && r.runner.kind === 'model');
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

  // 5 发送：请求带 attachmentIds，作业输入带 imageKeys，对话里能看到发过的图
  const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  const res = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await page.fill('#chat-input', '参考这张图的排版');
  await page.keyboard.press('Enter');
  const sent = JSON.parse((await req).postData() ?? '{}') as { attachmentIds?: string[] };
  expect(sent.attachmentIds?.length === 3, `请求未带 3 个 attachmentIds：${JSON.stringify(sent.attachmentIds)}`);
  const created = await (await res).json() as { job: { id: string } | null };

  await eventually(async () => expect((await page.getByTestId('message-attachment').count()) === 3, '对话记录里看不到发过的参考图'));
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

    // 7 设置弹层里的管理器：三组行、状态药丸、验证按钮、本机通道的配置步骤
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/p/${projectId}?settings=runners`);
    const modal = page.getByTestId('settings-modal');
    await modal.waitFor({ timeout: 10000 });
    // 分栏：左栏两节 tab（本月用量 / 生成通道，v0.32 本地版），方向键换节、URL 跟着变
    expect((await modal.getByRole('tab').count()) === 2, '设置弹层左栏应有 2 节');
    expect((await modal.getByRole('tab', { name: '生成通道' }).getAttribute('aria-selected')) === 'true', '?settings=runners 未选中「生成通道」');
    await modal.getByRole('tab', { name: '生成通道' }).focus();
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
    expect((await mgr.getByTestId('setup-hint').count()) >= 1, '本机 agent 行缺「如何配置」');
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
    // 弹层叠弹层：内层关掉后外层设置弹层还在、背景仍隔离，焦点回到外层的「添加通道」（inert 引用计数）
    expect(await modal.isVisible(), '关掉「添加通道」后设置弹层跟着没了');
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert')), '内层关闭后背景 inert 被一起摘掉了');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'add-channel'), '关闭后焦点未回到「添加通道」');
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
    expect(await page.getByTestId('manage-channels').isVisible(), '下拉末尾没有「管理通道…」');
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
    expect((await verbLine(page)).includes('造 1 屏 × 3 版 · 此处 = 7 次调用'), `动词行应写全屏数 × 版数与调用数：${await verbLine(page)}`);
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
    // 页面要真认领这个作业，「收口不顶目标」才是被验到的（认领来的作业没有进度事件，行上兜底写「排队中…」）
    const bgRow = page.locator(`[data-testid="running-job"][data-job-id="${grp.body.job.id}"]`);
    await bgRow.waitFor({ timeout: 15000 });
    expect((await bgRow.innerText()).includes('排队中…') || /正在/.test(await bgRow.innerText()), `在跑作业行没有进度文案：${(await bgRow.innerText()).replace(/\s+/g, ' ')}`);
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
    // 1 ⌘A + 版数 2：动词行「改全部 3 屏 × 2 版 = 12 次调用」；屏数控件在改时不出现
    await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(200);
    await page.getByTestId('versions-2').click();
    expect((await verbLine(page)).includes('改全部 3 屏 × 2 版 = 12 次调用'), `动词行：${await verbLine(page)}`);
    expect((await page.getByTestId('count-group').count()) === 0, '改的时候不该出现屏数控件');
    const req = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
    await page.fill('#chat-input', '顶部导航改成标签栏');
    await page.keyboard.press('Enter');
    const sent = JSON.parse((await req).postData() ?? '{}') as { targetScreenIds?: string[]; versions?: number };
    expect(sent.targetScreenIds?.length === 3 && sent.versions === 2, `请求体不对：${JSON.stringify(sent)}`);
    await page.locator('.bg-panel-2', { hasText: '已更新 3 屏' }).waitFor({ timeout: 120000 });
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
  return '⌘A × 2 版动词行写全 12 次调用；每屏 2 条候选同一作业；就地展开 2 格且排列条让位；全部被跳过时说明跳过、不收起；整组采用第 2 版并结清';
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

// ---------- 聚焦交互 ----------
let focusProject = '';
let focusScreens: { id: string; route: string }[] = [];
await step('TC-CORE-010', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Focus', '--device', 'mobile', '--screens', '2');
  focusProject = r.projectId; focusScreens = r.screens;
  await page.goto(`${WEB}/p/${focusProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  const iframe = page.locator('.card.focused iframe');
  await iframe.waitFor();
  const src = new URL((await iframe.getAttribute('src'))!);
  expect(src.host === (await previewHost()) && src.searchParams.get('t'), `iframe src ${src.href}`);
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await fl.locator('#toggle').click();
  expect((await fl.locator('#toggle').innerText()) === 'Following', '按钮未响应');
  await fl.locator('button', { hasText: 'Read parent cookie' }).click();
  const cookieText = await fl.locator('button', { hasText: 'cookie=' }).innerText();
  expect(!cookieText.includes('qsid'), `iframe 读到了主站 cookie: ${cookieText}`);
  const list = fl.locator('ul.max-h-48');
  await list.evaluate((el) => { el.scrollTop = 9999; });
  expect((await list.evaluate((el) => el.scrollTop)) > 0, '列表不可滚动');
  expect((await page.locator('[data-testid="screen-card"][data-route="/s2"] img').count()) === 1, '第 2 屏未保持截图态');
  await shot(page, 'CORE-010');
  await page.keyboard.press('Escape');

  await eventually(async () => expect((await page.locator('.card.focused iframe').count()) === 0, 'Esc 后 iframe 未卸载'));
  // 5b v0.34：焦点在 iframe 里时 ⌘E 由运行时转发——点过屏内元素后按 ⌘E 仍能切到选择元素态，再按退出
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await fl.locator('h1').click();
  await page.keyboard.press('ControlOrMeta+e');
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+e');

  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, '在 iframe 里再按 ⌘E 未退出选择元素态'));
});

await step('TC-CORE-011', async () => {
  const expired = seed('seed:preview-token', '--screen', focusScreens[0].id, '--expired');
  const r = await fetch(expired.replace('preview.localhost', '127.0.0.1'), { headers: { Host: await previewHost() } });
  expect(r.status === 403, `过期签名返回 ${r.status}`);
  expect((await r.json()).type === '/errors/preview-token-invalid', 'type');
  await page.goto(`${WEB}/p/${focusProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor();
  // 前端每次进入项目都重取签名（API-CORE-004），聚焦即用新签名
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  await page.frameLocator('.card.focused iframe').locator('#toggle').waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');
  return '过期签名 403；重取后加载成功';
});

// v0.33 聚焦态热更新：正显示的屏出了新修订，不退出交互就换进 iframe（不重挂、滚动位置保持）；<head> 变了（回刷）整份重写
await step('TC-CORE-032', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Hot', '--device', 'mobile', '--screens', '2', '--form');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${r.screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3997, apiKey: 'good-key-0032', reply: () => body0.replace('>Follow<', '>热更新<') });
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 热更新', endpoint: stub.url, model: 'stub-4', apiKey: 'good-key-0032' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    const revs = async () => (await apiJson<{ screens: { route: string; currentRevisionId: string }[] }>(`/v1/projects/${r.projectId}`)).body.screens.map((s) => s.currentRevisionId).join(',');
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
    // 1 进交互、屏内滚下去一段
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
    const iframe = page.locator('.card.focused iframe');
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('#toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    const src0 = await iframe.getAttribute('src');
    expect(!(await page.locator('form.composer').isVisible()), '进入交互后输入框未自动收起');
    await fl.locator('body').evaluate(() => window.scrollTo(0, 100));
    const y0 = await fl.locator('body').evaluate(() => Math.round(window.scrollY));
    expect(y0 === 100, `屏内未能滚到 100px（实际 ${y0}）`);
    // 2 ⌘/ 叫出输入框，走桩通道改这一屏：不退出交互，文案原地换新，iframe 不重挂，滚动位置不动
    await page.keyboard.press('ControlOrMeta+Slash');
    await page.locator('form.composer').waitFor({ timeout: 3000 });
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 热更新');
    expect((await page.getByTestId('target-chip').count()) === 1, '聚焦屏未成为目标');
    await page.fill('#chat-input', '改文案');
    await page.keyboard.press('Enter');
    const t0 = Date.now();
    await fl.locator('#toggle', { hasText: '热更新' }).waitFor({ timeout: 30000 });
    const ms = Date.now() - t0;
    expect((await iframe.getAttribute('src')) === src0, 'iframe 被重挂（src 变了）');
    expect((await page.locator('.card.focused .badge').innerText()).includes('交互中'), '热更新后角标不是「交互中」');
    const y1 = await fl.locator('body').evaluate(() => Math.round(window.scrollY));
    expect(Math.abs(y1 - y0) <= 2, `滚动位置未保持：${y0} → ${y1}`);
    // 等改屏作业收口：v0.36 起输入框不再随作业禁用，改问后端还有没有在跑的作业
    for (let i = 0; i < 30; i++) { if (!(await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${r.projectId}`)).body.activeJobs.length) break; await page.waitForTimeout(1000); }
    // 3 跳到 /s2 后回刷（<head> 变了）：正显示的 /s2 原地换色、src 不变
    await fl.locator('a[href="/s2"]').first().click();
    await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const revsBefore = await revs();
    // 刚点过 iframe 里的链接，键盘焦点还在预览文档内（运行时只转发 Esc / Alt+←），所以走工具栏按钮开设计系统面板
    await page.getByRole('button', { name: '设计系统' }).click();
    await page.locator('#ds-seed').waitFor({ timeout: 5000 });
    await page.fill('input[aria-label="种子色十六进制"]', '#C2410C');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('设计系统已保存').waitFor({ timeout: 10000 });
    // 保存成功后会问一次「回刷所有屏？」（ds-apply-ask 把背景置 inert），确认键在这一问里
    await page.getByTestId('ds-apply-confirm').click();
    for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); if ((await revs()) !== revsBefore) break; }
    const primary = (await apiJson<{ designSystem: { tokens: { colors: Record<string, string> } } }>(`/v1/projects/${r.projectId}`)).body.designSystem.tokens.colors.primary;
    const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16)).join(', ')})`;
    let bg2 = '';
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); bg2 = await fl.locator('#toggle').evaluate((el) => getComputedStyle(el).backgroundColor); if (bg2 === rgb) break; }
    expect(bg2 === rgb, `/s2 回刷后主按钮色 ${bg2} ≠ ${primary}`);
    expect((await iframe.getAttribute('src')) === src0, '回刷热更新重挂了 iframe');
    await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 2000 });
    // 4 后退到 /s1：也是新色，且步骤 2 的文案还在
    await page.keyboard.press('Alt+ArrowLeft');
    await fl.locator('#toggle', { hasText: '热更新' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const bg1 = await fl.locator('#toggle').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg1 === rgb, `/s1 后退后主按钮色 ${bg1} ≠ ${primary}`);
    await shot(page, 'CORE-032');
    await page.keyboard.press('Escape');

    await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, 'Esc 未退出交互'));
    return `改屏后 ${ms} ms 内热更新（src 不变、scrollY ${y0} 保持）；回刷后 /s2 原地换色、/s1 后退也是新色`;
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
});

// ---------- 对话迭代与修订 ----------
await step('TC-CORE-012', async () => {
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Iter', '--device', 'mobile', '--screens', '5');
  const before = await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`);
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor();
  await page.locator('[data-testid="screen-card"][data-route="/s3"] .gesture').click();
  await page.getByTestId('target-chip').filter({ hasText: 'Screen 3' }).waitFor();
  expect((await verbLine(page)).includes('改 1 屏'), `动词行应为「改 1 屏」：${await verbLine(page)}`);
  await page.fill('#chat-input', 'Turn this page into a grouped list with section headers');
  await page.keyboard.press('Enter');
  await page.locator('.bg-panel-2', { hasText: '已更新 1 屏' }).waitFor({ timeout: 120000 });
  const after = await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`);
  const s3 = screens[2].id;
  expect(after.body.screens.find((s) => s.id === s3)!.currentRevisionId !== before.body.screens.find((s) => s.id === s3)!.currentRevisionId, '/s3 未产生新修订');
  for (const s of before.body.screens) if (s.id !== s3) expect(after.body.screens.find((x) => x.id === s.id)!.currentRevisionId === s.currentRevisionId, `${s.id} 被误改`);
  const msgs = await apiJson<{ items: { role: string; affectedScreenIds: string[] }[] }>(`/v1/projects/${projectId}/messages`);
  const last = msgs.body.items[msgs.body.items.length - 1];
  expect(last.role === 'assistant' && last.affectedScreenIds.length === 1 && last.affectedScreenIds[0] === s3, 'affectedScreenIds 不为 [/s3]');
  await shot(page, 'CORE-012');
});

await step('TC-CORE-013', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Busy', '--device', 'mobile', '--screens', '2', '--no-shot');
  seedJson('seed:job', '--project', projectId, '--screen', screens[0].id, '--status', 'running');
  const r1 = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages`, { method: 'POST', body: JSON.stringify({ content: '改一下', targetScreenIds: [screens[0].id] }) });
  expect(r1.status === 409 && r1.body.type === '/errors/screen-busy', `占用屏返回 ${r1.status}`);
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  // v0.36：输入框照旧可输入，只有「这一轮的目标屏正被占着」才挡住发送并就地写出理由（REQ-CORE-020）
  expect(!(await page.locator('#chat-input').isDisabled()), '有作业在跑时输入框又被禁用了');
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.fill('#chat-input', '改一下');
  const blocked = page.getByTestId('send-blocked-reason');
  await blocked.waitFor({ timeout: 5000 });
  expect((await blocked.innerText()).includes('Screen 1'), `拦截理由没点名是哪一屏忙：${await blocked.innerText()}`);
  expect((await page.locator('form.composer button[type="submit"]').getAttribute('aria-disabled')) === 'true', '目标屏被占着，发送键仍可点');
  const r2 = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages`, { method: 'POST', body: JSON.stringify({ content: '改一下', targetScreenIds: [screens[1].id] }), headers: { 'Idempotency-Key': crypto.randomUUID() } });
  expect(r2.status === 202, `未占用屏返回 ${r2.status} ${JSON.stringify(r2.body)}`);
  await shot(page, 'CORE-013');
});

await step('TC-CORE-014', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Hist', '--device', 'mobile', '--screens', '1', '--revisions', '6');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  await page.locator('[data-testid="screen-card"] .gesture').click();
  await page.getByRole('button', { name: '修订' }).click();
  await page.locator('[data-testid="revision"]').first().waitFor();
  expect((await page.locator('[data-testid="revision"]').count()) === 6, '修订数不是 6');
  expect((await page.locator('[data-testid="revision"]').first().getAttribute('data-seq')) === '6', '倒序首项不是 seq 6');
  await page.locator('[data-testid="revision"][data-seq="2"]').getByRole('button', { name: '回溯到此版' }).click();
  await page.locator('[data-testid="revision"][data-seq="7"]', { hasText: '当前' }).waitFor({ timeout: 10000 });
  const revs = await apiJson<{ items: { seq: number; sourceKind: string; htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`);
  expect(revs.body.items.length === 7, `修订链长度 ${revs.body.items.length}`);
  const r7 = revs.body.items.find((r) => r.seq === 7)!; const r2 = revs.body.items.find((r) => r.seq === 2)!;
  expect(r7.sourceKind === 'restore', 'sourceKind');
  const [h7, h2] = await Promise.all([fetch(r7.htmlUrl).then((r) => r.text()), fetch(r2.htmlUrl).then((r) => r.text())]);
  expect(h7 === h2, 'seq 7 内容不等于 seq 2');
  await shot(page, 'CORE-014');
});

await step('TC-CORE-015', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Hist2', '--device', 'mobile', '--screens', '1', '--revisions', '6', '--no-shot');
  void projectId;
  const revs = await apiJson<{ items: { id: string; seq: number }[] }>(`/v1/screens/${screens[0].id}/revisions`);
  const seq = (n: number) => revs.body.items.find((r) => r.seq === n)!.id;
  const bad = await apiJson<{ type: string }>(`/v1/screens/${screens[0].id}/revisions/${seq(2)}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: seq(5) }) });
  expect(bad.status === 409 && bad.body.type === '/errors/revision-conflict', `冲突返回 ${bad.status}`);
  const after = await apiJson<{ items: unknown[] }>(`/v1/screens/${screens[0].id}/revisions`);
  expect(after.body.items.length === 6, '冲突时创建了修订');
  const ok = await apiJson(`/v1/screens/${screens[0].id}/revisions/${seq(2)}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: seq(6) }) });
  expect(ok.status === 201, `正确 expected 返回 ${ok.status}`);
});

// ---------- 用量与恢复 ----------
// v0.32：台账只记不拦（REQ-CORE-008）——超过旧上限照样放行；在途预估仍从 queued 作业的 payload 派生、作业结束即释放
await step('TC-CORE-016', async () => {
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
  // 预写一笔 400 屏的台账（超过旧硬上限 300），再造屏必须放行。放行那一下用独立项目：进程内队列会立刻开跑，取消前可能已落一屏，别污染 Demo Mobile
  const { jobId: bigJob } = seedJson<{ jobId: string }>('seed:job', '--project', demo.id, '--status', 'running', '--tokens', '3000', '--screens', '400');
  await apiJson(`/v1/jobs/${bigJob}/cancel`, { method: 'POST' });
  const u = (await apiJson<{ screens: number; byDriver: { driver: string; screens: number }[] }>('/v1/me/usage')).body;
  expect(u.screens >= 400, `台账应含预写的 400 屏，实际 ${u.screens}`);
  const { projectId: spare } = seedJson<{ projectId: string }>('seed:project', '--name', 'Usage', '--device', 'mobile', '--screens', '1', '--no-shot');
  const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${spare}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'generate', input: { prompt: 'x', count: 1, versions: 1 } }), headers: { 'Idempotency-Key': crypto.randomUUID() } });
  expect(r.status === 202, `无硬上限：用量 ${u.screens} 屏仍应放行，实际 ${r.status}`);
  await apiJson(`/v1/jobs/${r.body.job.id}/cancel`, { method: 'POST' }).catch(() => {});
  // 在途预估：挂一个 queued 的 generate（4 屏 × 2 版 = 8）→ inflight 多 8 屏；取消后释放。同一用户可能还挂着别的用例留下的作业，按增量断言
  const u0 = (await apiJson<{ inflight: { screens: number } }>('/v1/me/usage')).body;
  const { jobId: inflightJob } = seedJson<{ jobId: string }>('seed:job', '--project', demo.id, '--status', 'queued', '--input', JSON.stringify({ prompt: 'seeded', count: 4, versions: 2 }));
  const u1 = (await apiJson<{ inflight: { screens: number } }>('/v1/me/usage')).body;
  expect(u1.inflight.screens === u0.inflight.screens + 8, `在途预估应比之前多 8 屏，实际 ${u0.inflight.screens} → ${u1.inflight.screens}`);
  await apiJson(`/v1/jobs/${inflightJob}/cancel`, { method: 'POST' });
  const u2 = (await apiJson<{ inflight: { screens: number } }>('/v1/me/usage')).body;
  expect(u2.inflight.screens === u0.inflight.screens, `作业结束后在途预估应释放，实际 ${u2.inflight.screens}（之前 ${u0.inflight.screens}）`);
  return `${u.screens} 屏仍放行（无硬上限）；在途 8 屏计入、释放后归零`;
});

await step('TC-CORE-022', async () => {
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
  const usage = (await apiJson<{ month: string; screens: number; tokensIn: number; tokensOut: number; byDriver: { driver: string; model: string; screens: number }[] }>('/v1/me/usage')).body;
  expect(usage.byDriver.length >= 1 && usage.byDriver.every((d) => d.driver), `台账应按驱动分列：${JSON.stringify(usage.byDriver)}`);
  await page.goto(`${WEB}/p/${demo.id}?settings=usage`);
  // 设置弹层落在「本月用量」一节：汇总三格、按驱动分列的表、MCP 接入命令；没有任何上限或进度条
  const modal = page.getByTestId('settings-modal');
  await modal.waitFor({ timeout: 10000 });
  const totals = modal.getByTestId('usage-totals');
  await totals.waitFor({ timeout: 10000 });
  const text = await totals.innerText();
  expect(text.includes(usage.screens.toLocaleString()) && text.includes(usage.tokensIn.toLocaleString()), `汇总与 API 不一致：${text.replace(/\s+/g, ' ')} vs ${usage.screens}/${usage.tokensIn}`);
  expect((await modal.locator('[role="meter"]').count()) === 0 && !(await modal.innerText()).includes('/300'), '本地版不该再显示上限进度条');
  const rows = modal.getByTestId('usage-by-driver').locator('tbody tr');
  expect((await rows.count()) === usage.byDriver.length, `按驱动分列的行数 ${await rows.count()} ≠ ${usage.byDriver.length}`);
  await shot(page, 'CORE-022');
  // MCP 接入命令在「生成通道」一节底部
  await modal.getByRole('tab', { name: '生成通道' }).click();
  const cmd = await modal.getByTestId('mcp-add').innerText();
  expect(/^claude mcp add --transport http quilt http:\/\/.+\/mcp$/.test(cmd.trim()), `MCP 接入命令不对：${cmd}`);
  return `${usage.month}：${usage.screens} 屏 / ${usage.tokensIn + usage.tokensOut} token，按驱动 ${usage.byDriver.length} 行；MCP 命令可复制`;
});

await step('TC-CORE-017', async () => {
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects').then((r) => r.body.items.find((p) => p.name === 'Demo Mobile')!));
  const { jobId } = seedJson<{ jobId: string }>('seed:job', '--project', demo.id, '--status', 'running', '--tokens', '3000');
  const before = (await apiJson<{ tokensIn: number; tokensOut: number; screens: number }>('/v1/me/usage')).body;
  const c = await apiJson<{ job: { status: string } }>(`/v1/jobs/${jobId}/cancel`, { method: 'POST' });
  expect(c.status === 200 && c.body.job.status === 'cancelled', `取消返回 ${c.status}`);
  const after = (await apiJson<{ tokensIn: number; tokensOut: number; screens: number }>('/v1/me/usage')).body;
  expect(after.tokensIn + after.tokensOut === before.tokensIn + before.tokensOut && after.tokensIn + after.tokensOut >= 3000, `台账 ${before.tokensIn + before.tokensOut} → ${after.tokensIn + after.tokensOut}`);
  expect(after.screens === before.screens, 'screens 变化');
  const again = await apiJson<{ type: string }>(`/v1/jobs/${jobId}/cancel`, { method: 'POST' });
  expect(again.status === 409 && again.body.type === '/errors/job-finished', `二次取消 ${again.status}`);
  return '种子作业的 3000 token 由种子预写台账，取消后保留';
});

await step('TC-CORE-018', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Persist', '--device', 'mobile', '--screens', '8', '--revisions', '4', '--messages', '12', '--no-shot');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const card2 = page.locator('[data-testid="screen-card"][data-route="/s2"]');
  await page.getByRole('button', { name: '适配视图' }).click(); await page.waitForTimeout(500);
  const g = (await card2.locator('.gesture').boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down(); await page.mouse.move(g.x + g.width / 2 + 100, g.y + g.height / 2 + 400, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(500);
  const moved = await card2.evaluate((el) => (el as HTMLElement).style.transform);
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  expect((await page.locator('[data-testid="screen-card"]').count()) === 8, '屏数不是 8');
  expect((await page.locator('[data-testid="screen-card"][data-route="/s2"]').evaluate((el) => (el as HTMLElement).style.transform)) === moved, '位置未恢复');
  expect((await page.locator('[role="log"] > div').count()) === 12, '消息数不是 12');
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.getByRole('button', { name: '修订' }).click();
  await page.locator('[data-testid="revision"]').first().waitFor();
  expect((await page.locator('[data-testid="revision"]').count()) === 4 && (await page.locator('[data-testid="revision"]').first().getAttribute('data-seq')) === '4', '修订面板不是 4 条/当前 seq 4');
  // 关掉标签页重新打开（v0.32 本地版无会话）：从 `/` 进来仍落到同一项目、内容不变
  const again = await ctx.newPage();
  await openApp(again);
  await again.goto(`${WEB}/p/${projectId}`);
  await again.locator('[data-testid="screen-card"]').first().waitFor();
  expect((await again.locator('[data-testid="screen-card"]').count()) === 8 && (await again.locator('[role="log"] > div').count()) === 12, '新标签页里不一致');
  await again.close();
  await shot(page, 'CORE-018');
});

await step('TC-CORE-019', async () => {
  const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects').then((r) => r.body.items.find((p) => p.name === 'Demo Mobile')!));
  await page.goto(`${WEB}/p/${demo.id}`);
  const sg = page.locator('[data-testid="style-guide"]');
  await sg.waitFor();
  const detail = await apiJson<{ designSystem: { tokens: { colors: { primary: string } }; designMd: string } }>(`/v1/projects/${demo.id}`);
  const swatch = sg.locator('[data-token="primary"]');
  expect((await swatch.getAttribute('data-color'))?.toLowerCase() === detail.body.designSystem.tokens.colors.primary.toLowerCase(), 'primary 色块与 token 不一致');
  const bg = await swatch.evaluate((el) => getComputedStyle(el).backgroundColor);
  const hex = detail.body.designSystem.tokens.colors.primary;
  const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  expect(bg === rgb, `计算色 ${bg} ≠ ${rgb}`);
  for (const t of ['Headline', 'Primary button', 'Chip', 'List item']) expect(await sg.getByText(t, { exact: false }).count(), `缺 ${t} 样例`);
  await sg.click();
  await page.getByText('设计系统', { exact: true }).waitFor();
  await page.getByText('## Overview').waitFor();
  expect(page.url().includes('panel=design'), '面板状态未进 URL');
  // M3（REQ-EDIT-003）起设计系统面板可编辑；编辑与回刷行为本身由 TC-EDIT-005 覆盖，这里只确认入口在
  expect((await page.locator('button', { hasText: '回刷所有屏' }).count()) === 1, '设计系统面板缺回刷入口');
  const map = await apiJson<{ nodes: unknown[] }>(`/v1/projects/${demo.id}/app-map`);
  expect(map.body.nodes.length === 0, '风格指南进了应用地图');
  await shot(page, 'CORE-019');
});

await step('TC-CORE-006', async () => 'skip' as never).catch(() => {});
results.pop(); record('TC-CORE-006', 'skip', '需 LLM_STUB=503 重启 worker；由 core-stub.ts 单独执行');

// v0.34：删项目（切换器行 hover 垃圾桶 / 高亮行 Delete 键 → 确认 → 级联 + 对象清理；有作业 409；删当前项目回首页）与标签页标题
await step('TC-CORE-033', async () => {
  const a = seedJson<{ projectId: string }>('seed:project', '--name', 'DelA', '--device', 'mobile', '--screens', '1', '--no-shot');
  const b = seedJson<{ projectId: string }>('seed:project', '--name', 'DelB', '--device', 'mobile', '--screens', '1', '--no-shot');
  await page.goto(`${WEB}/p/${a.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  expect((await page.title()) === 'DelA · Quilt', `标签页标题应为「DelA · Quilt」：${await page.title()}`);
  // 1 hover 行露出垃圾桶 → 确认弹窗 → 删 DelB：列表里消失、API 404、对象目录清掉
  await page.getByTestId('project-switcher').click();
  const rowB = page.locator(`[data-testid="project-option"][data-project-id="${b.projectId}"]`);
  await rowB.waitFor({ timeout: 5000 });
  await rowB.hover();
  await page.waitForTimeout(250);
  const trash = rowB.getByTestId('delete-project');
  expect((await trash.evaluate((el) => getComputedStyle(el).opacity)) === '1', 'hover 行未露出垃圾桶');
  await trash.click();
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor({ timeout: 5000 });
  expect((await dlg.innerText()).includes('DelB'), '确认弹窗没写明要删哪个项目');
  await dlg.getByRole('button', { name: '删除' }).click();
  await page.getByText('已删除「DelB」').waitFor({ timeout: 5000 });
  expect((await apiJson(`/v1/projects/${b.projectId}`)).status === 404, '删除后项目仍能读到');
  expect(!existsSync(path.join(ROOT, '.data', 'objects', 'projects', b.projectId)), '对象目录未清理');
  // 2 有进行中作业拒删；取消后可删
  const job = seedJson<{ jobId: string }>('seed:job', '--project', a.projectId, '--status', 'running');
  expect((await apiJson(`/v1/projects/${a.projectId}`, { method: 'DELETE' })).status === 409, '有进行中作业仍能删项目');
  await apiJson(`/v1/jobs/${job.jobId}/cancel`, { method: 'POST' });
  // 3 删当前项目：高亮行按 Delete（垃圾桶的键盘等价物）→ 确认 → 回到 /
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  await page.getByTestId('project-switcher').click();
  const rowA = page.locator(`[data-testid="project-option"][data-project-id="${a.projectId}"]`);
  await rowA.waitFor({ timeout: 5000 });
  await rowA.hover();
  await page.keyboard.press('Delete');
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await page.waitForURL((u) => !u.pathname.includes(a.projectId), { timeout: 10000 });
  expect((await apiJson(`/v1/projects/${a.projectId}`)).status === 404, '当前项目删除后仍在');

  await eventually(async () => expect(!(await page.title()).startsWith('DelA'), `离开项目后标题未复位：${await page.title()}`));
  return '标题带项目名；hover 垃圾桶 / Delete 键 → 确认 → 级联清干净；有作业 409；删当前项目回首页';
});

await step('TC-CORE-034', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Arrange', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, s2, s3] = screens;
  for (const [s, x, y] of [[s1, 0, 0], [s2, 700, 150], [s3, 1900, -80]] as const) await apiJson(`/v1/screens/${s.id}`, { method: 'PATCH', body: JSON.stringify({ x, y }) });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  const bar = page.getByTestId('arrange-bar');
  const pos = async () => Object.fromEntries((await apiJson<{ screens: { id: string; x: number; y: number }[] }>(`/v1/projects/${projectId}`)).body.screens.map((s) => [s.id, s]));
  // 1-2 单选没有排列条；⌘A 出现
  await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
  await page.waitForTimeout(200);
  expect((await bar.count()) === 0, '只选一屏不该出现排列条');
  await page.keyboard.press('ControlOrMeta+a');
  await bar.waitFor({ timeout: 3000 });
  expect((await bar.innerText()).includes('3 屏') && (await bar.getByRole('button').count()) === 10, `排列条应有「3 屏」与 10 个按钮：${await bar.innerText()}`);
  // 3 去选一屏剩 2 屏：等距不可用并说明原因（放在对齐之前——对齐后三张卡叠在同一位置，点不到底下那张）
  await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click({ modifiers: ['Shift'] });

  await eventually(async () => expect((await bar.innerText()).includes('2 屏') && (await bar.getByTestId('arrange-hspace').getAttribute('aria-disabled')) === 'true' && (await bar.innerText()).includes('至少选 3 屏'), '2 屏时等距应不可用并写明原因'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(300);
  // 4 横向等距：首尾不动，中间落到间隙均分处
  await bar.getByTestId('arrange-hspace').click(); await page.waitForTimeout(600);
  let p = await pos();
  expect(p[s1.id].x === 0 && p[s3.id].x === 1900 && p[s2.id].x === 950, `横向等距后 x：${[s1, s2, s3].map((s) => p[s.id].x)}`);
  // 5 纵向等距
  await bar.getByTestId('arrange-vspace').click(); await page.waitForTimeout(600);
  p = await pos();
  expect(p[s3.id].y === -80 && p[s2.id].y === 150 && p[s1.id].y === 35, `纵向等距后 y：${[s1, s2, s3].map((s) => p[s.id].y)}`);
  // 6-7 上对齐 / 右对齐
  await bar.getByTestId('arrange-top').click(); await page.waitForTimeout(600);
  p = await pos();
  expect(screens.every((s) => p[s.id].y === -80), `上对齐后 y：${screens.map((s) => p[s.id].y)}`);
  await bar.getByTestId('arrange-right').click(); await page.waitForTimeout(600);
  p = await pos();
  expect(screens.every((s) => p[s.id].x === 1900), `右对齐后 x：${screens.map((s) => p[s.id].x)}`);
  // 8b-8d 排成一列 / 排成一行（v0.52）：固定 80 px 间距，顺序取当前位置（三屏完全重合 → 按选中集合次序），起点取外接框左上角；⌘Z 回到上一步并 toast「已撤销排列」
  const at = (s: { id: string }) => `${p[s.id].x},${p[s.id].y}`;
  await bar.getByTestId('arrange-vcol').click(); await page.waitForTimeout(600);
  p = await pos();
  expect(screens.every((s) => p[s.id].x === 1900) && p[s1.id].y === -80 && p[s2.id].y === 844 && p[s3.id].y === 1768, `排成一列后：${screens.map(at).join(' ')}`);
  await bar.getByTestId('arrange-hrow').click(); await page.waitForTimeout(600);
  p = await pos();
  expect(screens.every((s) => p[s.id].y === -80) && p[s1.id].x === 1900 && p[s2.id].x === 2370 && p[s3.id].x === 2840, `排成一行后：${screens.map(at).join(' ')}`);
  await shot(page, 'CORE-034');
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByText('已撤销排列').first().waitFor({ timeout: 3000 });
  await page.waitForTimeout(600);
  p = await pos();
  expect(screens.every((s) => p[s.id].x === 1900) && p[s2.id].y === 844 && p[s3.id].y === 1768, `撤销排列后应回到一列：${screens.map(at).join(' ')}`);
  return '单选无排列条；⌘A 后 3 屏 + 10 键；2 屏时等距不可用；横向 / 纵向等距首尾不动中间均分；上 / 右对齐落库；排成一列 (844+80) / 排成一行 (390+80) / ⌘Z 回到一列';
});

await step('TC-CORE-035', async () => {
  // 项目素材库（REQ-CORE-019）：上传 → 稳定 URL → 进生成 prompt → 面板里删
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Assets', '--device', 'mobile', '--screens', '1', '--no-shot');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3995, apiKey: 'good-key-0005', reply: body0 });
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 素材', endpoint: stub.url, model: 'stub-5', apiKey: 'good-key-0005' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    // 1 上传 SVG：尺寸取自 viewBox，URL 落在预览域
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="#284CCA"/></svg>';
    const up = async (name: string, type: string, content: string) => {
      const form = new FormData();
      form.append('file', new File([content], name, { type }));
      const res = await fetch(`${API}/v1/projects/${projectId}/assets`, { method: 'POST', body: form });
      return { status: res.status, body: await res.json() as { asset: { id: string; url: string; width: number; height: number; name: string } } };
    };
    const a1 = await up('mark.svg', 'image/svg+xml', svg);
    expect(a1.status === 201 && a1.body.asset.width === 120 && a1.body.asset.height === 60, `上传返回 ${a1.status} ${JSON.stringify(a1.body).slice(0, 120)}`);
    expect(/\/a\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(a1.body.asset.url), `素材 URL 形态不对：${a1.body.asset.url}`);
    // 2 不带签名直接取得到，且是长缓存
    const got = await fetch(a1.body.asset.url);
    expect(got.status === 200 && got.headers.get('content-type') === 'image/svg+xml' && (got.headers.get('cache-control') ?? '').includes('immutable'), `取素材：${got.status} ${got.headers.get('content-type')} ${got.headers.get('cache-control')}`);
    // 3 类型不在白名单：422 并说明
    const bad = await up('notes.txt', 'text/plain', 'hello');
    expect(bad.status === 422, `非图片类型应 422，实际 ${bad.status}`);
    // 4 素材清单进生成的 system 前缀
    const hits0 = stub.hits.length;
    const gen = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '改一下首页', targetScreenIds: [screens[0].id], versions: 1, runner: { kind: 'channel', channelId: cid } }) });
    expect(gen.status === 202, `改屏返回 ${gen.status}`);
    const j = await waitJob(gen.body.job.id, 120) as { status: string };
    expect(j.status === 'succeeded', `改屏未成功：${j.status}`);
    const sys = stub.hits.slice(hits0).map((h) => h.system).join('\n');
    expect(sys.includes('PROJECT ASSETS') && sys.includes(a1.body.asset.url), '素材清单没进 system 前缀');
    // 5 项目详情带 assets[]：风格指南卡片与面板用的是同一份
    const detailAssets = (await apiJson<{ assets: { id: string; url: string }[] }>(`/v1/projects/${projectId}`)).body.assets;
    expect(detailAssets?.length === 1 && detailAssets[0].url === a1.body.asset.url, '项目详情没带 assets[]');
    // 6 风格指南卡片画出素材，瓦片底色按亮度选
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    const guide = page.getByTestId('guide-assets');
    await guide.waitFor({ timeout: 10000 });
    expect((await guide.locator('[data-asset]').count()) === 1, '风格指南卡片没画出素材');
    expect(await guide.locator('img').first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), '卡片上的素材没加载出来');
    expect(/asset-(on-light|on-dark|thumb)/.test(await guide.locator('[data-asset]').first().getAttribute('class') ?? ''), '素材瓦片没有按亮度选底');
    // 7 面板：列出、缩略图能加载、删除要确认
    await page.locator('.styleguide').click();
    await page.getByTestId('assets-panel').waitFor({ timeout: 5000 });
    await page.getByTestId('asset-list').waitFor({ timeout: 10000 });
    expect((await page.getByTestId('asset-item').count()) === 1, '面板没列出素材');
    expect(await page.locator('[data-testid="asset-item"] img').first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), '缩略图没加载出来');
    await page.locator('[data-testid="asset-item"]').first().getByTestId('asset-delete').click();
    const dlg = page.getByRole('alertdialog');
    await dlg.waitFor({ timeout: 5000 });
    expect((await dlg.innerText()).includes('裂图'), '删除确认没说清已引用它的屏会怎样');
    await dlg.getByRole('button', { name: '删除' }).click();
    await page.getByText('素材已删除').waitFor({ timeout: 10000 });
    expect((await fetch(a1.body.asset.url)).status === 404, '删除后 URL 仍可取');
    await shot(page, 'CORE-035');
    return 'SVG 上传取到 viewBox 尺寸；URL 不签名可取且长缓存；非图片 422；素材清单进 system 前缀；详情带 assets[] 且风格指南卡片画出来；面板列出并确认后删除，删完 URL 404';
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
});

// 并行作业（REQ-CORE-020）：多个作业同时在跑时输入框不上锁，只有这一轮真冲突才挡住发送；在跑作业逐行呈现、逐个取消
await step('TC-CORE-036', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Parallel', '--device', 'mobile', '--screens', '3', '--no-shot');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  let n = 0;
  const stub = startOpenAiStub({ port: 3994, apiKey: 'good-key-0036', reply: () => body0.replace('Screen 1', `并行 ${++n}`) });
  const seeded: string[] = [];
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 并行', endpoint: stub.url, model: 'stub-6', apiKey: 'good-key-0036' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    // 两个「一直在跑」的长作业：种子作业不入队，稳定停在 running——等价于一批屏正在造 + Screen 1 正在改
    const genJob = seedJson<{ jobId: string }>('seed:job', '--project', projectId).jobId;
    const editJob = seedJson<{ jobId: string }>('seed:job', '--project', projectId, '--screen', screens[0].id).jobId;
    seeded.push(genJob, editJob);
    const jobOf = async (id: string) => (await apiJson<{ job: { status: string; startedAt: string | null; finishedAt: string | null } }>(`/v1/jobs/${id}`)).body.job;
    const rowOf = (id: string) => page.locator(`[data-testid="running-job"][data-job-id="${id}"]`);
    const sendBtn = page.locator('form.composer button[type="submit"]');
    const reason = page.getByTestId('send-blocked-reason');
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    // 1 两个在跑作业各成一行：倒序（新的在上）、写清在做什么、各带取消键、整叠在输入框上方
    await page.getByTestId('running-jobs').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="running-job"]').length === 2, null, { timeout: 10000 });
    const ids = await page.getByTestId('running-job').evaluateAll((els) => els.map((e) => e.getAttribute('data-job-id')));
    expect(ids.includes(genJob) && ids.includes(editJob), `两行的 data-job-id 不是那两个作业：${ids.join(',')}`);
    expect(ids[0] === editJob, `在跑作业行未按创建时间倒序（最新的改屏作业应在最上），实际首行 ${ids[0]}`);
    const genText = await rowOf(genJob).innerText();
    expect(/造\s*1\s*屏/.test(genText), `造屏那行没写清在做什么：${genText.replace(/\s+/g, ' ')}`);
    const editText = await rowOf(editJob).innerText();
    expect(editText.includes('改') && editText.includes('Screen 1'), `改屏那行没点名是哪一屏：${editText.replace(/\s+/g, ' ')}`);
    for (const id of [genJob, editJob]) expect((await rowOf(id).getByTestId('cancel-job').count()) === 1, `${id} 那行没有单独的取消键`);
    const stackBox = (await page.getByTestId('running-jobs').boundingBox())!;
    const inputBox = (await page.locator('#chat-input').boundingBox())!;
    expect(stackBox.y + stackBox.height <= inputBox.y + 1, `在跑作业行没落在输入框上方（行底 ${stackBox.y + stackBox.height} vs 输入区顶 ${inputBox.y}）`);
    // 2 输入框不因「有作业在跑」被锁死：textarea、通道下拉、版数档位都能用
    const draft = '底部加一个筛选栏';
    expect(!(await page.locator('#chat-input').isDisabled()), '有作业在跑时输入框又被禁用了');
    await page.fill('#chat-input', draft);
    expect((await page.locator('#chat-input').inputValue()) === draft, '草稿打不进输入框');
    expect(!(await page.getByTestId('runner-select').isDisabled()), '有作业在跑时通道选择器被禁用');
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 并行');
    expect(!(await page.getByTestId('versions-1').isDisabled()), '有作业在跑时版数档位被禁用');
    // 3 无目标 = 造屏，撞上在跑的 generate：发送键 aria-disabled + 就地写理由，Enter 不发请求、草稿不丢
    let posts = 0;
    const countPost = (r: import('playwright').Request) => { if (r.method() === 'POST' && r.url().includes('/messages')) posts += 1; };
    page.on('request', countPost);
    await reason.waitFor({ timeout: 5000 });
    expect((await reason.innerText()).includes('上一批屏还在造'), `造屏撞造屏的理由没说清：${await reason.innerText()}`);
    expect((await sendBtn.getAttribute('aria-disabled')) === 'true', '造屏撞上在跑的造屏作业，发送键仍可点');
    await page.locator('#chat-input').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(posts === 0, '被拦下的这一轮仍发出了 POST /messages');
    expect((await page.locator('#chat-input').inputValue()) === draft, '拦截把草稿吞了');
    // 4 目标 = 正被改的 Screen 1：同样拦下并点名是哪一屏
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.getByTestId('target-chip').filter({ hasText: 'Screen 1' }).waitFor({ timeout: 5000 });
    expect((await reason.innerText()).includes('Screen 1'), `拦截理由没点名是哪一屏忙：${await reason.innerText()}`);
    expect((await sendBtn.getAttribute('aria-disabled')) === 'true', '改正在被改的屏，发送键仍可点');
    await page.locator('#chat-input').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(posts === 0, '目标屏被占着却仍发出了 POST /messages');
    expect((await page.locator('#chat-input').inputValue()) === draft, '拦截把草稿吞了');
    page.off('request', countPost);
    // 5 换成空闲的 Screen 2：放行（造屏 + 改另一屏、改 A + 改 B 都不冲突）
    await page.locator('[data-testid="screen-card"][data-route="/s2"] .gesture').click();
    await page.getByTestId('target-chip').filter({ hasText: 'Screen 2' }).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="send-blocked-reason"]').length === 0, null, { timeout: 5000 });
    expect((await sendBtn.getAttribute('aria-disabled')) === null, '改另一张空闲屏不该被拦');
    // 6 两条真作业并行：UI 发 Screen 2、紧接着 API 发 Screen 3，两个种子作业此刻仍在跑
    const respP = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
    await page.fill('#chat-input', '把标题改成并行 A');
    await page.keyboard.press('Enter');
    const sentB = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '把标题改成并行 B', targetScreenIds: [screens[2].id], versions: 1, runner: { kind: 'channel', channelId: cid } }) });
    expect(sentB.status === 202, `对 Screen 3 发第二条返回 ${sentB.status} ${JSON.stringify(sentB.body).slice(0, 120)}`);
    const resp = await respP;
    expect(resp.status() === 202, `UI 发的改屏返回 ${resp.status()}`);
    const jobA = ((await resp.json()) as { job: { id: string } }).job.id;
    const jobB = sentB.body.job.id;
    for (const id of seeded) expect((await jobOf(id)).status === 'running', '种子作业已不在跑，「四个作业同时在跑」的前提不成立');
    // 7 两个都成功落地，且运行窗口真重叠（不是排队跑）
    const jA = (await waitJob(jobA, 120)) as { status: string };
    const jB = (await waitJob(jobB, 120)) as { status: string };
    expect(jA.status === 'succeeded' && jB.status === 'succeeded', `并行的两个作业未都成功：A=${jA.status} B=${jB.status}`);
    for (const s of [screens[1], screens[2]]) {
      const revs = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${s.id}/revisions`)).body.items;
      expect(revs.length === 2, `${s.route} 修订数 ${revs.length}，并行的两个作业应各自落一条`);
      expect((await (await fetch(revs[0].htmlUrl)).text()).includes('并行'), `${s.route} 的新修订不是桩产出的`);
    }
    const [a, b] = [await jobOf(jobA), await jobOf(jobB)];
    const started = Math.max(Date.parse(a.startedAt ?? ''), Date.parse(b.startedAt ?? ''));
    const finished = Math.min(Date.parse(a.finishedAt ?? ''), Date.parse(b.finishedAt ?? ''));
    expect(started < finished, `两个作业没有真并行：A ${a.startedAt}→${a.finishedAt}，B ${b.startedAt}→${b.finishedAt}`);
    // 8 Esc 只取消最新那一个（改 Screen 1 那条建得晚），另一条照旧在跑
    const spot = await blankSpot(page);
    expect(!!spot, '找不到画布空白点');
    await page.mouse.click(spot!.x, spot!.y);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="running-job"]').length === 1, null, { timeout: 10000 });
    expect((await jobOf(editJob)).status === 'cancelled', 'Esc 没取消最新那个作业');
    expect((await jobOf(genJob)).status === 'running', 'Esc 把另一个作业也取消了（应按一次取消一个）');
    // 9 行上的取消键只取消那一个；造屏名额一松，无目标发送立刻恢复
    await rowOf(genJob).getByTestId('cancel-job').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="running-jobs"]').length === 0, null, { timeout: 10000 });
    expect((await jobOf(genJob)).status === 'cancelled', '点行上的取消键没取消那个作业');
    await page.getByTestId('clear-targets').click();
    await page.fill('#chat-input', '再造一屏设置页');

    await eventually(async () => expect((await reason.count()) === 0, '造屏作业已取消，拦截理由还在'));
    expect((await sendBtn.getAttribute('aria-disabled')) === null, '造屏作业已取消，发送键仍不可点');
    await shot(page, 'CORE-036');
    // 10 一个标签页只开一条 SSE（v0.37）：作业进度改走项目事件流的 job_changed 投影，不随在跑作业数增长
    const sseOpen = await page.evaluate('window.__sseOpen');
    expect(sseOpen === 1, `标签页活跃 SSE 应恒为 1，实际 ${sseOpen}`);
    return `一个标签页只一条 SSE；两个在跑作业各一行（倒序、各带取消键）、输入框照旧可输入；造屏撞造屏与改占用屏就地写理由且不发请求；改另一屏放行，两条真作业并行落地（A ${a.startedAt}→${a.finishedAt} / B ${b.startedAt}→${b.finishedAt}）；Esc 取消最新、行上取消键只取消那一个`;
  } finally {
    for (const id of seeded) await apiJson(`/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
    await stub.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {});
  }
});

await step('TC-CORE-037', async () => {
  // 项目重命名（REQ-CORE-002 v0.40）：切换器行内就地改名
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'RenameMe', '--device', 'mobile', '--screens', '1', '--no-shot');
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  const name = async () => (await apiJson<{ project: { name: string } }>(`/v1/projects/${projectId}`)).body.project.name;
  const openRow = async () => {
    await page.getByTestId('project-switcher').click();
    const row = page.locator(`[data-testid="project-option"][data-project-id="${projectId}"]`);
    await row.waitFor({ timeout: 8000 });
    await row.hover();
    await page.waitForTimeout(200);
    return row;
  };
  // 1-2 hover 露出重命名键，点开即就地编辑
  let row = await openRow();
  expect((await row.getByTestId('rename-project').evaluate((el) => getComputedStyle(el).opacity)) === '1', 'hover 行未露出重命名键');
  await row.getByTestId('rename-project').click();
  await page.getByTestId('rename-input').waitFor({ timeout: 5000 });
  expect(await page.getByTestId('rename-input').evaluate((el) => document.activeElement === el), '重命名输入框没有自动获得焦点');
  // 3-4 打字不被 Radix 的 typeahead 吃掉；回车即存
  await page.getByTestId('rename-input').fill('改好的名字');
  await page.keyboard.press('Enter');
  await page.getByText('已改名为').waitFor({ timeout: 10000 });
  expect((await name()) === '改好的名字', `回车后库里仍是 ${await name()}`);

  await eventually(async () => expect((await page.title()).startsWith('改好的名字'), `标签页标题未跟着改：${await page.title()}`));
  // 5 Esc 放弃
  row = await openRow();
  await row.getByTestId('rename-project').click();
  await page.getByTestId('rename-input').fill('不该保存');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  expect((await name()) === '改好的名字', 'Esc 之后名字仍被改掉了');
  // 6 空名当放弃
  row = await openRow();
  await row.getByTestId('rename-project').click();
  await page.getByTestId('rename-input').fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  expect((await name()) === '改好的名字', '空名把项目名清掉了');
  await shot(page, 'CORE-037');
  return 'hover 露出重命名键；就地编辑自动聚焦、打字不被下拉吃掉；回车存并同步标题；Esc 与空名都当放弃';
});


// TC-CORE-040 找屏与总览（REQ-CORE-024 v0.61）：⌘K 跳屏、屏列表筛选、小地图
await step('TC-CORE-040', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Finder', '--device', 'mobile', '--screens', '4', '--dangling', '--no-shot');
  const [s1, , s3] = screens;
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  // 1 ⌘K → 输入「s3」→ Enter：面板关、/s3 单选、镜头把它摆到可用区中央、缩放 ≤ 1
  await page.keyboard.press('ControlOrMeta+k');
  const finder = page.getByTestId('screen-finder');
  await finder.waitFor({ timeout: 3000 });
  expect(await page.getByTestId('finder-input').evaluate((el) => el === document.activeElement), '打开后焦点应落在搜索框');
  await page.getByTestId('finder-input').fill('s3');
  await page.waitForTimeout(150);
  const rows = page.getByTestId('finder-row');
  expect((await rows.count()) === 1 && (await rows.first().getAttribute('data-id')) === s3.id, `输入 s3 应只剩 /s3 一行，实际 ${await rows.count()}`);
  await page.keyboard.press('Enter');
  await finder.waitFor({ state: 'detached', timeout: 3000 });
  await page.locator('.card.selected[data-route="/s3"]').waitFor({ timeout: 3000 });
  await page.waitForTimeout(500);
  const centered = await page.evaluate(() => {
    const c = document.querySelector('.card.selected')!.getBoundingClientRect(); const a = document.querySelector('[data-testid="safe-area"]')!.getBoundingClientRect();
    return { dx: Math.abs(c.left + c.width / 2 - (a.left + a.width / 2)), dy: Math.abs(c.top + c.height / 2 - (a.top + a.height / 2)) };
  });
  expect(centered.dx <= 8 && centered.dy <= 8, `跳屏后卡片应在可用区中央（偏差 ${Math.round(centered.dx)}, ${Math.round(centered.dy)}）`);
  const zoomPct = Number(((await page.getByTestId('stat').innerText()).match(/(\d+)%/) ?? [])[1]);
  expect(zoomPct <= 100, `跳屏缩放不该超过 1:1，实际 ${zoomPct}%`);
  // 2 ⌥S 屏列表：4 行；筛「断链」剩 /s1 一行且片上计数 1；点行 → /s1 单选
  await page.keyboard.press('Alt+s');
  await page.getByTestId('screens-list').waitFor({ timeout: 3000 });
  expect((await page.getByTestId('screens-row').count()) === 4, '屏列表应列 4 屏');
  await page.getByTestId('screens-filter-dangling').click();

  await eventually(async () => expect((await page.getByTestId('screens-row').count()) === 1 && (await page.getByTestId('screens-filter-dangling').getAttribute('aria-pressed')) === 'true' && (await page.getByTestId('screens-filter-dangling').innerText()).includes('1'), '筛断链应只剩 /s1 且片上计数 1'));
  expect((await page.getByTestId('screens-row').first().getAttribute('data-id')) === s1.id, '断链行应是 /s1');
  await page.getByTestId('screens-row').first().click();
  await page.locator('.card.selected[data-route="/s1"]').waitFor({ timeout: 3000 });
  await page.keyboard.press('Alt+s');
  await page.waitForTimeout(300);
  // 3 小地图：4 个屏矩形 + 视口框；点最左侧空白 → 视口框左移、画布镜头随之平移；工具栏可关可开
  const mm = page.getByTestId('minimap');
  await mm.waitFor({ timeout: 3000 });
  expect((await page.getByTestId('minimap-screen').count()) === 4 && (await page.getByTestId('minimap-view').count()) === 1, '小地图应有 4 个屏矩形与 1 个视口框');
  // 小地图按「全部卡片 + 视口」的外接框缩放：视口往左出去后，屏矩形在小地图里整体右移、世界层 transform 的 x 变大
  const screensX = () => page.getByTestId('minimap-screen').evaluateAll((els) => Math.min(...els.map((e) => Number(e.getAttribute('x')))));
  const worldX = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.world')!).transform).e);
  const [vx0, wx0] = [await screensX(), await worldX()];
  const box = (await mm.boundingBox())!;
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  await page.waitForTimeout(500);
  const [vx1, wx1] = [await screensX(), await worldX()];
  expect(vx1 > vx0 && wx1 > wx0, `点小地图左侧后屏矩形应右移（${vx0.toFixed(1)} → ${vx1.toFixed(1)}）、世界层右移（${wx0.toFixed(0)} → ${wx1.toFixed(0)}）`);
  await page.getByTestId('toggle-minimap').click();
  await mm.waitFor({ state: 'detached', timeout: 2000 });
  // 空格在按钮上是激活（v0.65；此前全局空格被画布平移吃掉）
  await page.getByTestId('toggle-minimap').focus();
  await page.keyboard.press('Space');
  await mm.waitFor({ timeout: 2000 });
  await shot(page, 'CORE-040');
  return '⌘K 搜到 /s3、Enter 居中选中且 ≤ 1:1；⌥S 列表 4 行、断链筛剩 /s1 并可跳；小地图 4 矩形 + 视口框、点击平移、可开关';
});

// TC-CORE-041 状态变体（REQ-CORE-025 v0.62）：出变体 → 落位 / 地图 / 注册表 / 导出 → 播放切状态 → 路由不可改 → 删默认屏级联
await step('TC-CORE-041', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Variants', '--device', 'mobile', '--screens', '3');
  const [s1] = screens;
  type S = { id: string; name: string; route: string; x: number; y: number; variantOf: string | null; variantName: string | null; previewUrl: string | null; currentRevisionId: string | null };
  const detail = async () => (await apiJson<{ screens: S[]; links: { href: string; toScreenId: string | null }[] }>(`/v1/projects/${projectId}`)).body;
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  // 1 选中 /s1 → 工具栏「出变体」→ 起名「空态」→ 作业跑完
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.getByTestId('new-variant').click();
  await page.getByTestId('variant-dialog').waitFor({ timeout: 3000 });
  await page.getByTestId('variant-name').fill('空态');
  await page.getByTestId('variant-create').click();
  await page.getByText('正在出「Screen 1」的「空态」变体').waitFor({ timeout: 5000 });
  let v: S | undefined;
  for (let i = 0; i < 40 && !v?.previewUrl; i++) { await page.waitForTimeout(1500); v = (await detail()).screens.find((s) => s.variantOf === s1.id); }
  expect(!!v?.previewUrl, '变体 60 s 内没造出来');
  const d = await detail();
  const base = d.screens.find((s) => s.id === s1.id)!;
  expect(v!.route === '/s1' && v!.variantName === '空态' && v!.name === 'Screen 1 · 空态', `变体元数据不对：${JSON.stringify({ route: v!.route, variantName: v!.variantName, name: v!.name })}`);
  expect(v!.y === base.y && v!.x === base.x + 390 + 80, `变体应落在默认屏右侧同一行，实际 (${v!.x}, ${v!.y}) vs 默认 (${base.x}, ${base.y})`);
  // 2 应用地图只指默认屏；注册表（设计契约 routes）不列变体
  expect(d.links.filter((l) => l.href === '/s1').every((l) => l.toScreenId === s1.id), '指向 /s1 的链接目标应是默认屏');
  const map = (await apiJson<{ nodes: { id: string }[] }>(`/v1/projects/${projectId}/app-map`)).body;
  expect(map.nodes.length === 3 && !map.nodes.some((n) => n.id === v!.id), `应用地图节点应只有 3 个默认屏，实际 ${map.nodes.length}`);
  // 3 画布：变体卡标「变体」，默认屏卡标「1 个变体」
  await page.waitForTimeout(800);
  await page.locator('.card[data-variant="true"] .label .chip', { hasText: '变体' }).waitFor({ timeout: 5000 });
  expect((await page.locator('.card[data-route="/s1"]:not([data-variant]) .label').innerText()).includes('1 个变体'), '默认屏卡应标「1 个变体」');
  // 4 聚焦默认屏 → 状态胶囊两颗 → 点「空态」→ 同 iframe 换内容、镜头不动、导航栈为空
  await page.locator('.card[data-route="/s1"]:not([data-variant]) .gesture').dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
  const chips = page.getByTestId('variant-chip');
  await chips.first().waitFor({ timeout: 5000 });
  expect((await chips.count()) === 2 && (await chips.first().getAttribute('aria-pressed')) === 'true', '应有「默认 / 空态」两颗胶囊且默认被按下');
  const fl = page.frameLocator('.card.focused iframe');
  const before = await fl.locator('body').innerHTML();
  const worldBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.world')!).transform);
  await page.locator('[data-testid="variant-chip"][data-id="' + v!.id + '"]').click();

  await eventually(async () => expect((await page.locator('[data-testid="variant-chip"][data-id="' + v!.id + '"]').getAttribute('aria-pressed')) === 'true', '点过的胶囊应为按下态'));
  expect((await fl.locator('body').innerHTML()) !== before, 'iframe 内容应换成变体');
  expect((await page.evaluate(() => getComputedStyle(document.querySelector('.world')!).transform)) === worldBefore, '切状态不该动镜头');
  expect((await page.locator('.card.focused .badge').innerText()).includes('/s1') && (await page.locator('.card.focused iframe').count()) === 1, '角标仍是 /s1、iframe 未重建');
  // 4b 切到变体后选元素直改，改动落在变体上、默认屏不动（v0.65；此前写到默认屏，同号 qid 改错元素）
  const baseRev0 = (await detail()).screens.find((s) => s.id === s1.id)!;
  await page.keyboard.press('ControlOrMeta+e');
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 5000 });
  await fl.locator('h1').first().click();
  await page.locator('#el-text').waitFor({ timeout: 5000 });
  await page.locator('#el-text').fill('Variant edited');
  // Esc 在检查器输入框里只失焦，不退出聚焦、面板与草稿都在（v0.65）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await page.locator('.card.focused').count()) === 1 && (await page.locator('#el-text').inputValue()) === 'Variant edited', '输入框里按 Esc 不该退出聚焦或丢草稿');
  await page.getByRole('button', { name: '保存（零 token）' }).click();
  await page.getByText('已更新').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(800);
  const after4b = (await detail()).screens;
  const vAfter = (await apiJson<{ items: { sourceKind: string }[] }>(`/v1/screens/${v!.id}/revisions`)).body.items[0];
  expect(after4b.find((s) => s.id === s1.id)!.currentRevisionId === baseRev0.currentRevisionId && vAfter.sourceKind === 'manual', '直改应落在变体上、默认屏修订不变');
  await page.keyboard.press('ControlOrMeta+e');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // 5 变体改 route → 422；默认屏给 variantName → 422
  expect((await apiJson(`/v1/screens/${v!.id}`, { method: 'PATCH', body: JSON.stringify({ route: '/elsewhere' }) })).status === 422, '变体改路由应 422');
  expect((await apiJson(`/v1/screens/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ variantName: 'x' }) })).status === 422, '默认屏给变体名应 422');
  // 6 导出只带默认屏
  const { body: job } = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': `e2e-var-${Date.now()}` }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
  await waitJob(job.job.id, 90);
  const html = await (await fetch(`${API}/v1/jobs/${job.job.id}/export`)).text();
  expect((html.match(/<template data-route=/g) ?? []).length === 3, `导出应只有 3 个默认屏模板，实际 ${(html.match(/<template data-route=/g) ?? []).length}`);
  // 7 删默认屏：确认框写明变体一起删，确认后剩 2 屏
  await page.locator('.card[data-route="/s1"]:not([data-variant]) .gesture').click();
  await page.keyboard.press('Delete');
  const dlg = page.getByTestId('delete-dialog');
  await dlg.waitFor({ timeout: 3000 });
  expect((await dlg.innerText()).includes('1 个变体一起删除'), '删除确认应写明变体一起删除');
  await dlg.getByRole('button', { name: '删除' }).click();
  await page.getByText('已删除').first().waitFor({ timeout: 5000 });

  await eventually(async () => expect((await detail()).screens.length === 2, '删默认屏后变体应级联删除'));
  await shot(page, 'CORE-041');
  return '出变体落在默认屏右侧、地图 / 注册表 / 导出只认默认屏、卡片标签、聚焦切状态不动镜头、路由不可改 422、删默认屏级联';
});

await browser.close();
console.log('\n=== RUN-' + RUN + ' ===');
const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {});
console.log(JSON.stringify(counts), '\n', results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
if (consoleErrors.length) console.log('pageerrors:', consoleErrors.slice(0, 5));
