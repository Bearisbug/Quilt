import { mkdir, writeFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, previewHost, EVIDENCE, ROOT, WEB, API, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';
import { pickOption, selectedValue } from './lib.ts';
import { LINK_REPAIR_PROMPT, CONVENTIONS_REGENERATE_PROMPT } from '@quilt/core';
import { connectMcp, callTool } from './mcp-client.ts';
import { chromium } from 'playwright';

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
// 用例里登记的收尾（桩通道与它占的端口）：成败都在这条用例结束时做，不漏给后面的用例
const cleanups: (() => Promise<unknown>)[] = [];
const step = async (tc: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  try { const note = await fn(); record(tc, true, note ?? ''); }
  catch (e) {
    record(tc, false, (e as Error).message.split('\n')[0].slice(0, 300));
    await currentPage?.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch((err) => console.log('   (截图失败:', (err as Error).message.split('\n')[0], ')'));
  } finally { for (const c of cleanups.splice(0)) await c().catch(() => {}); }
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
// stub 轮次没有云端通道（§3：GEMINI_API_KEY 置空，种子不建 Gemini 通道），输入框的缺省通道落到「交给本机 Claude Code」：
// 没有屏数 / 版数档位、没选会话时 Enter 被挡。要从输入框发一轮、或要量带档位的输入框的用例，先建一条 OpenAI 兼容桩通道、验证，
// 给了页面就重载（画布在打开时取通道清单）并在输入框里选中它。验证请求（用户提示 ping）不拖，其余按 holdMs 拖
async function useStubChannel(pg: import('playwright').Page | null, opts: { port: number; label: string; holdMs?: number }) {
  const key = `good-key-${opts.port}`;
  const stub = startOpenAiStub({ port: opts.port, apiKey: key, reply: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Stub</h1></div>', holdMs: (hit) => (hit.user === 'ping' ? 0 : opts.holdMs ?? 0) });
  let id = '';
  cleanups.push(async () => { if (id) await apiJson(`/v1/channels/${id}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  id = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: opts.label, endpoint: stub.url, model: `stub-${opts.port}`, apiKey: key }) })).body.channel.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${id}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
  if (pg) {
    await pg.reload();
    await pg.locator('[data-testid="screen-card"]').first().waitFor();
    await pg.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await pickOption(pg, '[data-testid="runner-select"]', opts.label);
    await eventually(async () => expect((await selectedValue(pg, '[data-testid="runner-select"]')) === `channel:${id}`, `输入框没选上「${opts.label}」`));
  }
}

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
    cdp.on('Tracing.dataCollected', (e: { value: typeof trace }) => { trace.push(...e.value); });
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

await step('TC-CORE-023', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'ShellCheck', '--device', 'mobile', '--screens', '4');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  // 第 7 步量的是带屏数 / 版数档位的输入框（模型通道），stub 轮次没有云端通道时自己建一条
  await useStubChannel(page, { port: 3986, label: 'Stub 输入框 23' });
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

  // 3b 窗口矮到放不下全部工具（v0.70）：工具栏封顶在可用区内、列内滚动、滚动条不可见；底部渐隐提示还有；End 跳到最后一个工具，
  //    它滚进可见区且四周留出焦点环的 4 px，渐隐换到顶部
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.waitForTimeout(400);
  const rail = () => page.evaluate(() => {
    const r = document.querySelector('[role="toolbar"]') as HTMLElement; const pill = r.parentElement!.getBoundingClientRect(); const rr = r.getBoundingClientRect();
    const f = (document.activeElement as HTMLElement | null)?.closest('[role="toolbar"]') ? document.activeElement!.getBoundingClientRect() : null;
    return { pillBottom: pill.bottom, vh: innerHeight, scrollable: r.scrollHeight > r.clientHeight, bar: r.offsetWidth - r.clientWidth, fade: r.dataset.fade ?? '',
      room: f ? Math.min(f.top - rr.top, rr.bottom - f.bottom, f.left - rr.left, rr.right - f.right) : null, last: document.activeElement === [...r.querySelectorAll('button')].pop() };
  });
  await page.locator('[role="toolbar"] button[tabindex="0"]').focus();
  await page.keyboard.press('Home');
  const top = await rail();
  expect(top.pillBottom < top.vh && top.scrollable && top.bar === 0 && top.fade === 'bottom', `矮窗口下工具栏没在列内滚动或提示不对：${JSON.stringify(top)}`);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const end = await rail();
  expect(end.last && end.fade === 'top' && (end.room ?? -1) >= 3.5, `End 后最后一个工具应可见、焦点环不被裁、渐隐在顶部：${JSON.stringify(end)}`);
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
  // 聚焦在 showComposer 的 setTimeout(0) 里，输入框显形与光标落下之间隔一拍（实测 ≤ 56 ms）：轮询，不一次性读
  await eventually(async () => expect(await page.evaluate(() => document.activeElement?.id === 'chat-input'), '叫回后光标没落回输入区'), 2000);
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
  const list = (await apiJson<{ items: { id: string; label: string; hint?: string; available: boolean; unavailableReason?: string; runner: Record<string, string> }[]; default: string }>('/v1/runners')).body;
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
  expect(bad.status === 422, `SVG 未被拒：${bad.status}`);
  const big = await apiJson(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: 50 * 1024 * 1024 }) });
  expect(big.status === 422, `超大附件未被拒：${big.status}`);

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

    // 7 设置弹层里的管理器：三组行、状态药丸、验证按钮、本机通道的配置步骤。第 6 步已删了 Stub 通道，stub 轮次又没有种子的云端通道（§3），
    //   先建一条已验证的自建通道当「自建通道」那一组的行
    await useStubChannel(null, { port: 3983, label: 'Stub 管理 28' });
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
  // 页面手里的签名过期（v0.76）：详情第一次回包里 /s1 的截图与预览地址换成过期的，之后的回包照常
  const detailPath = `/v1/projects/${focusProject}`;
  let stale: 'shot' | 'preview' | null = null;
  let gets = 0;
  const onReq = (req: import('playwright').Request) => { if (req.method() === 'GET' && new URL(req.url()).pathname === detailPath) gets += 1; };
  page.on('request', onReq);
  await page.route(`**${detailPath}`, async (route) => {
    if (!stale || route.request().method() !== 'GET') return route.fallback();
    const kind = stale; stale = null;
    const res = await route.fetch();
    const d = (await res.json()) as { screens: { id: string; screenshotUrl: string | null; previewUrl: string | null }[] };
    for (const x of d.screens) if (x.id === focusScreens[0].id) {
      if (kind === 'shot' && x.screenshotUrl) x.screenshotUrl = x.screenshotUrl.replace(/exp=\d+/, 'exp=1000000000');
      if (kind === 'preview') x.previewUrl = expired;
    }
    await route.fulfill({ response: res, json: d });
  });
  try {
    // 2 卡片截图取不到（403）：静默重取详情，换上新签名的图
    await page.goto('about:blank');   // 上一页可能还有在途的详情请求，别让它吃掉这次改写
    stale = 'shot'; gets = 0;
    await page.goto(`${WEB}/p/${focusProject}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await eventually(async () => expect(await card.locator('img').evaluateAll((els) => els.some((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0 && !(i as HTMLImageElement).src.includes('exp=1000000000'))), `过期截图没换回来（详情 GET ${gets} 次）`), 8000);
    expect(gets >= 2, `截图失败后没有重取详情（GET ${gets} 次）`);
    // 3 聚焦时预览签名过期：iframe 读不到状态码，2 s 等不到就绪 → 重取签名重载，不露出 403 JSON
    await page.goto('about:blank');
    stale = 'preview'; gets = 0;
    await page.goto(`${WEB}/p/${focusProject}`);
    await card.locator('img').first().waitFor({ timeout: 15000 });
    await card.locator('.gesture').dblclick();
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('#toggle').waitFor({ timeout: 30000 });   // 2 s 看门 + 重取 + 重载，重载还要等预览文档里的 CDN
    const src = await page.locator('.card.focused iframe').getAttribute('src');
    expect(src !== expired && gets >= 2, `没有换签名重载：src 仍是过期的=${src === expired}，详情 GET ${gets} 次`);
    await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 5000 });
    // 4 屏内跳转取页失败：toast 说明、角标不动、不抛未捕获异常；只失败一次时先重取签名再试就能跳过去
    const errorsBefore = consoleErrors.length;
    const toS2 = new RegExp(`/p/${focusProject}/${focusScreens[1].id}\\?`);
    await page.route(toS2, (route) => route.abort());
    // 在 iframe 里派发点击而不是按坐标点：整套跑到这里时视口可能被前面的用例改成 900 高，聚焦缩放不是 1:1，坐标点击会偏（§3）
    const clickS2 = () => fl.locator('a[href="/s2"]').last().evaluate((a) => (a as HTMLElement).click());
    await clickS2();
    await page.getByText('这一屏没取到').first().waitFor({ timeout: 8000 });
    expect((await page.locator('.card.focused .badge').innerText()).includes('/s1'), `取页失败后角标变了：${await page.locator('.card.focused .badge').innerText()}`);
    await page.unroute(toS2);
    let failOnce = true;
    await page.route(toS2, (route) => { if (failOnce) { failOnce = false; return route.abort(); } return route.continue(); });
    await clickS2();
    await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 8000 });
    await page.unroute(toS2);
    expect(consoleErrors.length === errorsBefore, `取页失败抛了未捕获异常：${consoleErrors.slice(errorsBefore).join(' | ')}`);
    await page.keyboard.press('Escape');
  } finally { await page.unroute(`**${detailPath}`); page.off('request', onReq); }
  // 5 页面可见时每 4 分钟静默重取一次详情（假时钟快进）
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const p2 = await c2.newPage();
    await p2.clock.install();
    let n = 0;
    p2.on('request', (req) => { if (req.method() === 'GET' && new URL(req.url()).pathname === detailPath) n += 1; });
    await p2.goto(`${WEB}/p/${focusProject}`);
    await p2.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await p2.waitForTimeout(1000);
    const n0 = n;
    await p2.clock.fastForward('04:30');
    await eventually(() => expect(n > n0, `快进 4.5 分钟后没有重取详情（GET ${n0} → ${n}）`), 5000);
  } finally { await c2.close(); }
  return '截图 403 → 静默重取换图；预览 403 → 重取签名重载；取页失败 toast 且先重取再试；4 分钟续签';
});

// v0.33 聚焦态热更新：正显示的屏出了新修订，不退出交互就换进 iframe（不重挂、滚动位置保持）；<head> 变了（回刷）整份重写
await step('TC-CORE-032', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Hot', '--device', 'mobile', '--screens', '2', '--form');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${r.screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3997, apiKey: 'good-key-0032', reply: () => body0.replace('>Follow<', '>热更新<') });
  let cid = '';
  const vp0 = page.viewportSize();
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 热更新', endpoint: stub.url, model: 'stub-4', apiKey: 'good-key-0032' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    const revs = async () => (await apiJson<{ screens: { route: string; currentRevisionId: string }[] }>(`/v1/projects/${r.projectId}`)).body.screens.map((s) => s.currentRevisionId).join(',');
    // 屏内点击要在 1:1 聚焦下做（§3）：整套顺序下跑到这里时视口已被前面的用例改成 1440×900，聚焦缩放 0.896，
    // Playwright 对跨域 iframe 外层的 CSS 缩放不感知，点击点偏移后会落到压在屏底的输入框上（RUN-150 / v0.83 复现）
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
    // 1 进交互、屏内滚下去一段
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
    const iframe = page.locator('.card.focused iframe');
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('#toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    expect((await page.getByTestId('stat').innerText()).endsWith('100%'), `聚焦后不是 1:1：${await page.getByTestId('stat').innerText()}`);
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
    // 等改屏作业收口：v0.36 起输入框不再随作业禁用，改问后端还有没有在跑的作业；页面上的在跑作业行要等它自己收到终态事件才撤（输入框随之变矮）
    for (let i = 0; i < 30; i++) { if (!(await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${r.projectId}`)).body.activeJobs.length) break; await page.waitForTimeout(1000); }
    await page.locator('[data-testid="running-job"]').first().waitFor({ state: 'detached', timeout: 10000 });
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
  } finally { if (vp0) await page.setViewportSize(vp0); await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
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
  // 小地图画在 canvas 上：屏数读 data-screens，视口框（小地图坐标 x y w h）读 data-view
  const viewRect = async () => { const [x, y, w, h] = ((await mm.getAttribute('data-view')) ?? '').split(' ').map(Number); const b = (await mm.boundingBox())!; return { x, y, w, h, px: b.x + x, py: b.y + y }; };
  expect((await mm.getAttribute('data-screens')) === '4' && !!(await mm.getAttribute('data-view')), '小地图应有 4 屏与视口框');
  // 小地图按「全部卡片 + 视口」的外接框缩放：视口往左出去后，屏矩形在小地图里整体右移、世界层 transform 的 x 变大
  const worldX = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.world')!).transform).e);
  const wx0 = await worldX();
  // 点视口框外的空白（框左边有空就点左边，否则点右边）：镜头朝那边平移；点在框上是抓框，不跳（3b）
  const box = (await mm.boundingBox())!;
  const vf = await viewRect();
  const left = vf.x > 20;
  await page.mouse.click(left ? box.x + 8 : box.x + box.width - 8, box.y + box.height / 2);
  await page.waitForTimeout(500);
  const wx1 = await worldX();
  expect(left ? wx1 > wx0 : wx1 < wx0, `点小地图${left ? '左' : '右'}侧空白后镜头应朝那边平移（世界层 x ${wx0.toFixed(0)} → ${wx1.toFixed(0)}）`);
  // 3b 抓住视口框拖（v0.66）：按下不跳、向左拖镜头左移；原地抖动镜头不再自己跑（此前外接框随视口变大，抖几下就飞到几十万）
  const f0 = await viewRect();
  const fb = { x: f0.px, y: f0.py, width: f0.w, height: f0.h };
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  expect(Math.abs((await viewRect()).x - f0.x) < 0.5, '按下视口框时它不该跳到指针下');
  const wxDown = await worldX();
  await page.mouse.move(fb.x + fb.width / 2 - 20, fb.y + fb.height / 2, { steps: 8 });
  await page.waitForTimeout(150);
  const wxDragged = await worldX();
  for (let i = 0; i < 20; i++) await page.mouse.move(fb.x + fb.width / 2 - 20 + (i % 2 ? 1 : -1), fb.y + fb.height / 2);
  await page.mouse.move(fb.x + fb.width / 2 - 20, fb.y + fb.height / 2);
  await page.waitForTimeout(150);
  const wxJitter = await worldX();
  await page.mouse.up();
  expect(wxDragged > wxDown && Math.abs(wxJitter - wxDragged) <= 2, `拖视口框：世界层 x ${wxDown.toFixed(0)} → ${wxDragged.toFixed(0)}，原地抖动后 ${wxJitter.toFixed(0)}（应不变）`);
  // 3c 聚焦屏时不画小地图（它压在可用区左上角，会挡住聚焦屏那一块的点击），退出后回来
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
  expect((await mm.count()) === 0, '聚焦时小地图应隐藏');
  // 3d 焦点在预览 iframe 里按 ⌘K 也能开跳屏面板（v0.66 运行时转发）
  await page.frameLocator('.card.focused iframe').locator('input').first().focus();
  await page.keyboard.press('ControlOrMeta+k');
  await finder.waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await finder.waitFor({ state: 'detached', timeout: 3000 });
  await page.keyboard.press('Escape');
  await mm.waitFor({ timeout: 3000 });
  // 3e 从工具栏「找屏」打开、Esc 关：焦点回到这个键（v0.66 useModal 默认归还打开前的焦点）
  await page.getByTestId('find-screen').click();
  await finder.waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await finder.waitFor({ state: 'detached', timeout: 3000 });
  expect(await page.getByTestId('find-screen').evaluate((el) => el === document.activeElement), '关掉跳屏面板后焦点应回到「找屏」键');
  // 3f 窗口矮到列表放不下时，↓ 移到的行滚进列表可视区
  await page.setViewportSize({ width: 1440, height: 260 });
  await page.keyboard.press('ControlOrMeta+k');
  await finder.waitFor({ timeout: 3000 });
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await eventually(async () => {
    const vis = await page.evaluate(() => { const l = document.getElementById('finder-list')!.getBoundingClientRect(); const r = document.querySelector('[data-testid="finder-row"][aria-selected="true"]')!.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; });
    expect(vis, '↓ 选中的行应在列表可视区内');
  });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);
  await page.getByTestId('toggle-minimap').click();
  await mm.waitFor({ state: 'detached', timeout: 2000 });
  // 空格在按钮上是激活（v0.65；此前全局空格被画布平移吃掉）
  await page.getByTestId('toggle-minimap').focus();
  await page.keyboard.press('Space');
  await mm.waitFor({ timeout: 2000 });
  await shot(page, 'CORE-040');
  return '⌘K 搜到 /s3、Enter 居中选中且 ≤ 1:1；⌥S 列表 4 行、断链筛剩 /s1 并可跳；小地图 4 矩形 + 视口框、点击平移、拖框 1:1 不失控、聚焦时隐藏、可开关；iframe 内 ⌘K、关面板焦点归还、选中行滚入视野';
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
  // 落在默认屏那一行最右（REQ-CORE-025）：种子三屏在 (0,0) / (470,0) / (940,0)，变体排在 /s3 右侧
  const rowRight = Math.max(...d.screens.filter((s) => s.id !== v!.id && s.y < base.y + 844 && base.y < s.y + 844).map((s) => s.x + 390));
  expect(v!.y === base.y && v!.x === rowRight + 80, `变体应落在默认屏那一行最右（x = ${rowRight + 80}），实际 (${v!.x}, ${v!.y}) vs 默认 (${base.x}, ${base.y})`);
  // 1b 变体不会被自动钉成样板屏（v0.66）
  const proj = (await apiJson<{ project: { exemplarScreenId: string | null } }>(`/v1/projects/${projectId}`)).body.project;
  expect(proj.exemplarScreenId !== v!.id, '变体不该被钉成样板屏');
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
  // 胶囊在交互角标下一行，不与它重叠（v0.66；手机屏上此前叠了 31–86 px）
  const gap = await page.evaluate(() => { const c = document.querySelector('.variant-chips')!.getBoundingClientRect(); const b = document.querySelector('.card.focused .badge')!.getBoundingClientRect(); return c.top - b.bottom; });
  expect(gap >= 0, `状态胶囊与交互角标重叠 ${(-gap).toFixed(0)} px`);
  const fl = page.frameLocator('.card.focused iframe');
  const before = await fl.locator('body').innerHTML();
  // 聚焦的镜头动画（250 ms）走完再记基线
  const worldNow = () => page.evaluate(() => getComputedStyle(document.querySelector('.world')!).transform);
  let worldBefore = await worldNow();
  await eventually(async () => { await page.waitForTimeout(200); const w = await worldNow(); const same = w === worldBefore; worldBefore = w; expect(same, '镜头还在动'); });
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
  // 5b 呈现方式属于整个家族（v0.66）：变体上改 422；默认屏改了变体跟着改，两屏当前修订的截图重拍
  type Shot = { id: string; presentation: string; screenshotUrl: string | null };
  const shots = async () => (await apiJson<{ screens: Shot[] }>(`/v1/projects/${projectId}`)).body.screens;
  expect((await apiJson(`/v1/screens/${v!.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'overlay' }) })).status === 422, '变体改呈现方式应 422');
  // 截图重拍看对象存储里当前修订那张 PNG 的写入时间（仓库内开发用 fs 存储）；按内容比较不行——根元素自带底色的屏按透明底拍出来像素一样
  const shotAt = async (id: string) => {
    const s = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((x) => x.id === id)!;
    return stat(path.join(ROOT, '.data/objects/projects', projectId, 'screens', id, `${s.currentRevisionId}.png`)).then((f) => f.mtimeMs, () => 0);
  };
  const t0 = Date.now();
  expect((await apiJson(`/v1/screens/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'overlay' }) })).status === 200, '默认屏改呈现方式应 200');
  const fam = (await shots()).filter((s) => s.id === s1.id || s.id === v!.id);
  expect(fam.every((s) => s.presentation === 'overlay'), `默认屏改呈现方式后变体应跟着改：${fam.map((s) => s.presentation).join('/')}`);
  await eventually(async () => {
    for (const id of [s1.id, v!.id]) expect((await shotAt(id)) > t0, '家族两屏当前修订的截图都应重拍');
  }, 20000, 1000);
  await apiJson(`/v1/screens/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'push' }) });
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

// TC-CORE-042 对话记录的参考图预览与消息操作（REQ-CORE-026 v0.72 / API-CORE-034）
await step('TC-CORE-042', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Msgs', '--device', 'mobile', '--screens', '2');
  const [s1, s2] = screens;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = async () => {
    const { body } = await apiJson<{ attachmentId: string; putUrl: string }>(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: png.length }) });
    const put = await fetch(API + body.putUrl, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } });
    expect(put.status === 204, `参考图上传 ${put.status}`);
    return body.attachmentId;
  };
  type Msg = { id: string; role: string; content: string; jobId: string | null; attachments: { id: string }[] };
  type Job = { id: string; kind: string; status: string; input: { screenIds?: string[]; imageKeys?: string[]; runner?: { kind: string; channelId?: string } } };
  const messages = async () => (await apiJson<{ items: Msg[] }>(`/v1/projects/${projectId}/messages?limit=100`)).body.items;
  // 显式走 stub：种子会按 .env 建一条已验证的 Gemini 通道并成为缺省通道，不指定就会打到真实模型
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const send = async (content: string, target: string, attachmentIds: string[]) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, targetScreenIds: [target], attachmentIds, runner: STUB }) });
    expect(r.status === 202, `发消息 ${r.status}`);
    const j = await waitJob(r.body.job.id, 60);
    expect(j.status === 'succeeded', `「${content}」这一轮作业 ${j.status}`);
  };
  await send('第一轮：照这张图改', s1.id, [await upload()]);
  await send('第二轮：照这两张图改', s2.id, [await upload(), await upload()]);
  // 拖 6 s 才回的 OpenAI 兼容桩：重试这一轮要走它，好在它跑着的时候验「重试」置灰与 409
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${s2.id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3993, apiKey: 'good-key-0042', reply: body0, holdMs: 6000 });
  try {
    const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Slow 通道', endpoint: stub.url, model: 'stub-42', apiKey: 'good-key-0042' }) });
    const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' });
    expect(probe.body.ok, '慢桩通道验证未通过');
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
    if ((await page.getByTestId('chat-dock').getAttribute('data-state')) === 'collapsed') await page.getByRole('button', { name: '展开对话记录' }).click();
    const thumbs = page.getByTestId('message-attachment-open');
    await eventually(async () => expect((await thumbs.count()) === 3, `对话里应有 3 张参考图缩略图，实际 ${await thumbs.count()}`), 8000);

    // 1 点最后一张 → 大图第 3 / 3，下一张不可用；← 两次到第一张、标题带第一轮的话；再 ← 停在第一张；Esc 关闭、焦点回到缩略图
    await thumbs.nth(2).click();
    const viewer = page.getByTestId('image-viewer');
    await viewer.waitFor({ timeout: 3000 });
    expect((await viewer.innerText()).includes('参考图 3 / 3'), `标题应是 3 / 3：${await viewer.innerText()}`);
    expect(await page.getByTestId('viewer-image').evaluate((i) => (i as HTMLImageElement).naturalWidth > 0), '大图没加载出来');
    expect((await page.getByTestId('viewer-next').getAttribute('aria-disabled')) === 'true', '最后一张时「下一张」应不可用');
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert')), '预览打开时背景应 inert');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    expect((await viewer.getAttribute('data-index')) === '0' && (await viewer.innerText()).includes('第一轮'), `← 两次应到第一张且写出第一轮的话：${await viewer.getAttribute('data-index')} ${await viewer.innerText()}`);
    await page.keyboard.press('ArrowLeft');
    expect((await viewer.getAttribute('data-index')) === '0' && (await page.getByTestId('viewer-prev').getAttribute('aria-disabled')) === 'true', '第一张时再 ← 应停住、「上一张」不可用');
    await page.getByTestId('viewer-next').click();
    expect((await viewer.getAttribute('data-index')) === '1', '点「下一张」应到第二张');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="image-viewer"]')), '点翻页键后焦点应仍在预览里');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached', timeout: 3000 });
    expect(await thumbs.nth(2).evaluate((el) => el === document.activeElement), '关闭后焦点应回到点开它的缩略图');
    expect(!(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))), '关闭后背景的 inert 应摘掉');
    // 点图外空白处也关闭
    await thumbs.nth(0).click();
    await viewer.waitFor({ timeout: 3000 });
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height - 40);
    await viewer.waitFor({ state: 'detached', timeout: 3000 });

    // 2 悬停：每条都有「复制」；「修改」只在最后一轮的用户消息，「重试」只在最后一轮的助手消息；没悬停的那条操作条不显
    const users = page.locator('[data-testid="message"][data-role="user"]');
    const assts = page.locator('[data-testid="message"][data-role="assistant"]');
    const actionsShown = (loc: import('playwright').Locator) => loc.locator('.msg-actions').evaluate((el) => getComputedStyle(el).opacity === '1');
    await users.nth(0).hover();
    await eventually(async () => expect(await actionsShown(users.nth(0)), '悬停第一条用户消息时操作条应显示'));
    expect(!(await actionsShown(users.nth(1))), '没悬停的消息不该显示操作条');
    expect((await users.nth(0).getByTestId('msg-copy').count()) === 1 && (await users.nth(0).getByTestId('msg-edit').count()) === 0, '早先那一轮不该有「修改」');
    expect((await users.nth(1).getByTestId('msg-edit').count()) === 1 && (await assts.nth(1).getByTestId('msg-retry').count()) === 1 && (await assts.nth(0).getByTestId('msg-retry').count()) === 0, '「修改」「重试」应只在最后一轮');

    // 3 复制：剪贴板里是这条的正文
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
    await users.nth(1).hover();
    await users.nth(1).getByTestId('msg-copy').click();
    await eventually(async () => expect((await page.evaluate(() => navigator.clipboard.readText())) === '第二轮：照这两张图改', '剪贴板内容不是这条消息的正文'));

    // 4 重试：输入框换成慢桩通道 → 点重试 → 新一轮追加，原文、两张图、原目标照旧，只有通道换了；跑着时「重试」置灰、接口 409
    await pickOption(page, '[data-testid="runner-select"]', 'Slow 通道');
    const before = (await messages()).length;
    await assts.nth(1).hover();
    await assts.nth(1).getByTestId('msg-retry').click();
    await eventually(async () => expect((await messages()).length === before + 2, '重试后应追加一轮（两条消息）'), 5000);
    const all = await messages();
    const [oldUser, newUser] = [all.filter((m) => m.role === 'user').at(-2)!, all.filter((m) => m.role === 'user').at(-1)!];
    expect(newUser.content === oldUser.content && newUser.attachments.map((a) => a.id).join() === oldUser.attachments.map((a) => a.id).join(), '重试的这一轮正文与参考图应与原来一致');
    const oldJob = (await apiJson<{ job: Job }>(`/v1/jobs/${oldUser.jobId}`)).body.job;
    const newJob = (await apiJson<{ job: Job }>(`/v1/jobs/${newUser.jobId}`)).body.job;
    expect(newJob.kind === 'edit_screens' && newJob.input.screenIds?.join() === s2.id && newJob.input.imageKeys?.length === 2, `重试作业的种类 / 目标 / 参考图不对：${JSON.stringify(newJob.input).slice(0, 200)}`);
    expect(newJob.input.runner?.kind === 'channel' && newJob.input.runner.channelId === ch.body.channel.id && oldJob.input.runner?.kind !== 'channel', '重试应改用输入框当前选的通道');
    await assts.last().hover();
    await eventually(async () => expect((await assts.last().getByTestId('msg-retry').getAttribute('aria-disabled')) === 'true', '这一轮还在跑时「重试」应置灰'), 3000);
    const busy = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages/${newUser.id}/retry`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' });
    expect(busy.status === 409 && busy.body.type === '/errors/job-not-finished', `在跑时重试应 409 job-not-finished：${busy.status} ${busy.body.type}`);
    const done = await waitJob(newJob.id, 60);
    expect(done.status === 'succeeded' && stub.hits.some((h) => h.hasImage), `重试作业 ${done.status}，或桩没收到参考图`);
    await eventually(async () => expect((await assts.last().getByTestId('msg-retry').getAttribute('aria-disabled')) !== 'true', '跑完后「重试」应恢复可用'), 8000);

    // 5 修改：文字、两张参考图、目标屏原样填回输入框
    await users.last().hover();
    await users.last().getByTestId('msg-edit').click();
    await eventually(async () => expect((await page.locator('#chat-input').inputValue()) === '第二轮：照这两张图改', '修改后输入框应是这一轮的原文'));
    expect((await page.locator('button[aria-label^="移除参考图"]').count()) === 2, '修改后输入框应带回两张参考图');
    expect((await page.getByTestId('target-chip').count()) === 1 && (await verbLine(page)).includes('改'), `修改后目标应是原来那一屏：${await verbLine(page)}`);
    expect(await page.locator('#chat-input').evaluate((el) => el === document.activeElement), '修改后焦点应在输入框');
    await shot(page, 'CORE-042');

    // 6 接口边界：助手消息 id → 404；不能重试的种类（导出）→ 400，且它成了最后一轮后画布上不再给「重试」「修改」
    const asst = await apiJson(`/v1/projects/${projectId}/messages/${all.at(-1)!.id}/retry`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' });
    expect(asst.status === 404, `对助手消息重试应 404：${asst.status}`);
    const exp = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    await waitJob(exp.body.job.id, 90);
    const expUser = (await messages()).filter((m) => m.role === 'user').at(-1)!;
    const bad = await apiJson<{ errors?: { path: string }[] }>(`/v1/projects/${projectId}/messages/${expUser.id}/retry`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' });
    expect(bad.status === 400 && bad.body.errors?.[0]?.path === 'messageId', `导出这一轮重试应 400 path=messageId：${bad.status} ${JSON.stringify(bad.body).slice(0, 160)}`);
    await eventually(async () => expect((await page.getByTestId('msg-retry').count()) === 0 && (await page.getByTestId('msg-edit').count()) === 0, '最后一轮是导出时不该有「重试」「修改」'), 8000);
    return '3 张图一组左右切换、到头停住、Esc / 点空白关闭且焦点回缩略图；复制进剪贴板；重试原样再发、只换通道、跑着时置灰且 409；修改填回文字 / 图 / 目标；助手消息 404、导出轮 400';
  } finally { await stub.close(); }
});

// ---- v0.74 共用（TC-CORE-043~046）：输入框发出的写请求改走 stub ----
// 种子按 .env 建了一条已验证的 Gemini 通道并成为缺省：UI 发送与重试不能打到真实模型。拦下请求体、把 runner 换成 stub
// （或用例指定的通道）再放行，并记下原始请求体供断言；holdMs 让这一个请求在途一阵
const STUB_RUNNER = { kind: 'model', driver: 'stub', model: 'stub' };
const SEND_RE = /\/v1\/projects\/[^/]+\/messages(\/[^/]+\/retry)?$/;
type Sent = { url: string; body: Record<string, unknown> };
async function pinSends(pg: import('playwright').Page, opts: { runner?: () => unknown; holdMs?: () => number } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  await pg.route(SEND_RE, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = JSON.parse(req.postData() || '{}') as Record<string, unknown>;
    sent.push({ url: req.url(), body });
    const hold = opts.holdMs?.() ?? 0;
    if (hold) await new Promise((r) => setTimeout(r, hold));
    await route.continue({ postData: JSON.stringify({ ...body, runner: opts.runner?.() ?? STUB_RUNNER }) });
  });
  return sent;
}
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const uploadPng = async (projectId: string) => {
  const png = Buffer.from(PNG_B64, 'base64');
  const { body } = await apiJson<{ attachmentId: string; putUrl: string }>(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: png.length }) });
  const put = await fetch(API + body.putUrl, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } });
  expect(put.status === 204, `参考图上传 ${put.status}`);
  return body.attachmentId;
};
type RoundMsg = { id: string; role: string; content: string; jobId: string | null; attachments: { id: string }[] };
type RoundJob = { id: string; kind: string; status: string; input: Record<string, unknown> };
const idemKey = () => ({ 'Idempotency-Key': crypto.randomUUID() });
// 软断言：缺陷相关的检查不在第一处就停，整条用例跑完再一并报出（修复前一轮就能看到每一步的现象）；前置条件仍用 expect 硬停
// 硬停时（fail）连同已记下的软断言一起报；全部明细另打到控制台（登记的备注截在 300 字）
const softly = () => {
  const errs: string[] = [];
  const line = (e: unknown) => (e as Error).message.split('\n')[0].slice(0, 160);
  return {
    check: async (f: () => unknown) => { try { await f(); } catch (e) { errs.push(line(e)); } },
    fail: (e: unknown) => { errs.push(`中断：${line(e)}`); },
    done: () => { if (!errs.length) return; console.log(`   明细：\n   - ${errs.join('\n   - ')}`); throw new Error(`${errs.length} 处不符：${errs.join(' ｜ ')}`); },
  };
};
const roundsOf = (projectId: string) => {
  const messages = async () => (await apiJson<{ items: RoundMsg[] }>(`/v1/projects/${projectId}/messages?limit=100`)).body.items;
  // 只数带作业的轮次：种子的 --messages 是没有作业的纯文字消息
  const users = async () => (await messages()).filter((m) => m.role === 'user' && m.jobId);
  const jobOf = async (m: RoundMsg) => (await apiJson<{ job: RoundJob }>(`/v1/jobs/${m.jobId}`)).body.job;
  // 等到第 n 轮落库，返回它的用户消息与作业
  const round = async (n: number) => {
    let out: { user: RoundMsg; job: RoundJob } | null = null;
    await eventually(async () => { const us = await users(); expect(us.length === n, `应有 ${n} 轮，实际 ${us.length}`); out = { user: us.at(-1)!, job: await jobOf(us.at(-1)!) }; }, 10000);
    return out!;
  };
  // 经接口发一轮（显式走 stub）并等它跑完
  const send = async (body: Record<string, unknown>) => {
    const r = await apiJson<{ job: { id: string; kind: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ runner: STUB_RUNNER, ...body }) });
    expect(r.status === 202, `发消息 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const j = await waitJob(r.body.job.id, 90);
    expect(j.status === 'succeeded', `「${body.content}」这一轮作业 ${j.status}`);
    return r.body.job;
  };
  // 系统代发的作业（API-CORE-006）：与画布上的出变体 / 补缺失页 / 补链 / 按新约定重生成同一条路
  const sysJob = async (kind: string, input: Record<string, unknown>) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind, input: { ...input, runner: STUB_RUNNER } }) });
    expect(r.status === 202, `建 ${kind} 作业 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const j = await waitJob(r.body.job.id, 90);
    expect(j.status === 'succeeded', `${kind} 作业 ${j.status}`);
  };
  return { messages, users, jobOf, round, send, sysJob };
};
const openCanvas = async (projectId: string) => {
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  if ((await page.getByTestId('chat-dock').getAttribute('data-state')) === 'collapsed') await page.getByRole('button', { name: /^展开对话记录/ }).click();
  if ((await page.getByTestId('mode-chat').getAttribute('aria-checked')) === 'true') await page.getByTestId('mode-design').click();
};

// TC-CORE-043 「修改」还原完整参数（REQ-CORE-026 v0.74 / API-CORE-010）
await step('TC-CORE-043', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Rounds', '--device', 'mobile', '--screens', '2');
  const [s1, s2] = screens;
  const R = roundsOf(projectId);
  const S = softly();
  const comp = await apiJson<{ component: { id: string } }>(`/v1/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ name: 'AuditTab', html: `<nav class="flex gap-4 p-2"><a href="${s1.route}" aria-current="page" class="font-bold">One</a><a href="${s2.route}">Two</a></nav>` }) });
  expect(comp.status === 201, `建组件 ${comp.status}`);
  const compId = comp.body.component.id;
  // 0 接口边界：正文只在带隐藏参数时可空；隐藏参数与动词不配套 → 400
  const bad = async (body: Record<string, unknown>, path: string) => S.check(async () => {
    const r = await apiJson<{ errors?: { path: string }[] }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ runner: STUB_RUNNER, ...body }) });
    expect(r.status === 400 && !!r.body.errors?.some((e) => e.path === path), `${JSON.stringify(body)} 应 400 path=${path}：${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  });
  await bad({ content: '', targetScreenIds: [s1.id] }, 'content');
  await bad({ content: '', preset: 'link_repair' }, 'targetScreenIds');
  await bad({ content: 'x', variantOf: s1.id, variantName: 'Empty', targetScreenIds: [s2.id] }, 'targetScreenIds');

  const sent = await pinSends(page);
  try {
    // 1 「用组件在此处造屏」这一轮：锚点与组件都填回，动词仍是造；再发仍带锚点、建的仍是 generate（修复前锚点被清、变成改组件）
    // 屏数 2：stub 驱动的单屏规划回的是整组计划，count=1 的造屏在 stub 下必然失败
    await R.send({ content: '做一个设置页，用这条 tab', targetComponentIds: [compId], anchor: { x: 3000, y: 200 }, count: 2 });
    await openCanvas(projectId);
    const users = page.locator('[data-testid="message"][data-role="user"]');
    const input = page.locator('#chat-input');
    const form = page.locator('form.composer');
    const chip = page.getByTestId('preset-chip');
    const chipText = async () => ((await chip.count()) ? chip.innerText() : '没有胶囊');
    const editLast = async (text: string) => {
      await eventually(async () => expect((await users.last().innerText()).includes(text), `最后一轮应含「${text}」：${(await users.last().innerText()).slice(0, 80)}`), 10000);
      await users.last().hover();
      await users.last().getByTestId('msg-edit').click();
    };
    const sendNth = async (n: number) => eventually(async () => expect(sent.length === n, `应已发出 ${n} 轮，实际 ${sent.length}`));
    await editLast('做一个设置页');
    await eventually(async () => expect((await input.inputValue()) === '做一个设置页，用这条 tab', `修改后正文不对：${await input.inputValue()}`));
    await S.check(async () => expect((await page.getByTestId('anchor-chip').count()) === 1 && (await page.getByTestId('component-chip').count()) === 1, `① 锚点与组件都应填回：锚点 ${await page.getByTestId('anchor-chip').count()} 组件 ${await page.getByTestId('component-chip').count()}`));
    await S.check(async () => expect((await form.getAttribute('data-verb')) === 'create' && (await verbLine(page)).includes('此处'), `① 动词应是造 · 此处：${await form.getAttribute('data-verb')} ${await verbLine(page)}`));
    await input.press('Enter');
    await sendNth(1);
    await S.check(() => expect(!!sent[0].body.anchor && (sent[0].body.targetComponentIds as string[] | undefined)?.[0] === compId && !sent[0].body.targetScreenIds, `① 重发应带锚点与组件、不带屏：${JSON.stringify(sent[0].body)}`));
    let r = await R.round(2);
    await S.check(() => expect(r.job.kind === 'generate' && !!r.job.input.anchor && (r.job.input.componentIds as string[] | undefined)?.[0] === compId, `① 重发应仍是用组件在此处造屏：${r.job.kind} ${JSON.stringify(r.job.input).slice(0, 120)}`));
    await waitJob(r.job.id, 90);

    // 2 出变体：胶囊「「Screen 1」的 Loading 变体」，正文是原提示词、屏数档位不显示；改了字再发仍是 Screen 1 的 Loading 变体
    await R.sysJob('generate', { prompt: 'spinner while loading', count: 1, versions: 1, variantOf: s1.id, variantName: 'Loading' });
    await editLast('Loading');
    await S.check(() => eventually(async () => expect((await chip.count()) === 1 && /Screen 1.*Loading/.test(await chip.innerText()), `② 应出「Screen 1」的 Loading 变体胶囊：${await chipText()}`)));
    await S.check(async () => expect((await input.inputValue()) === 'spinner while loading', `② 变体的正文应是原提示词：${await input.inputValue()}`));
    await S.check(async () => expect((await verbLine(page)).includes('出变体') && (await page.getByTestId('count-group').count()) === 0 && (await page.getByTestId('target-chip').count()) === 0, `② 变体轮的动词行 / 档位不对：${await verbLine(page)}`));
    await input.fill('spinner and skeleton rows');
    await input.press('Enter');
    await sendNth(2);
    await S.check(() => expect(sent[1].body.variantOf === s1.id && sent[1].body.variantName === 'Loading' && sent[1].body.content === 'spinner and skeleton rows', `② 变体参数没随请求发出：${JSON.stringify(sent[1].body).slice(0, 160)}`));
    r = await R.round(4);
    await S.check(() => expect(r.job.kind === 'generate' && r.job.input.variantOf === s1.id && r.job.input.variantName === 'Loading' && r.job.input.prompt === 'spinner and skeleton rows', `② 应仍是 Screen 1 的 Loading 变体：${JSON.stringify(r.job.input).slice(0, 120)}`));
    await S.check(() => expect(r.user.content === '出「Loading」状态变体：spinner and skeleton rows', `② 变体轮的消息正文：${r.user.content}`));
    expect((await waitJob(r.job.id, 90)).status === 'succeeded', '变体作业没成功');
    await S.check(() => eventually(async () => expect((await chip.count()) === 0, '② 发出后胶囊应收起')));

    // 3 懒生成补缺失页：正文填回为空（提示词是系统拼的），留空可发；写了字作为附加要求
    await R.sysJob('generate', { prompt: 'Screen for route /audit-help', count: 1, versions: 1, route: '/audit-help', fromScreenId: s1.id });
    // 这条路由已被刚造的屏占着（懒生成撞已有路由会失败）：删掉再「修改」重发
    const made = (await apiJson<{ screens: { id: string; route: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((x) => x.route === '/audit-help');
    expect(!!made && (await apiJson(`/v1/screens/${made.id}`, { method: 'DELETE' })).status === 204, '懒生成没造出 /audit-help 或删不掉');
    await editLast('/audit-help');
    await S.check(() => eventually(async () => expect((await chip.count()) === 1 && (await chip.innerText()).includes('/audit-help'), `③ 应出缺失页胶囊：${await chipText()}`)));
    await S.check(async () => expect((await input.inputValue()) === '' && (await form.locator('button[type="submit"]').getAttribute('aria-disabled')) !== 'true', `③ 缺失页轮正文应为空且可直接发：「${await input.inputValue()}」`));
    await input.fill('顶部带搜索框');
    await input.press('Enter');
    await sendNth(3);
    await S.check(() => expect(sent[2].body.route === '/audit-help' && sent[2].body.fromScreenId === s1.id && sent[2].body.content === '顶部带搜索框', `③ 缺失页参数没随请求发出：${JSON.stringify(sent[2].body).slice(0, 160)}`));
    r = await R.round(6);
    await S.check(() => expect(r.job.kind === 'generate' && r.job.input.route === '/audit-help' && r.job.input.prompt === 'Screen for route /audit-help\n\nADDITIONAL REQUIREMENTS FROM THE USER: 顶部带搜索框', `③ 应仍是钉死路由的懒生成、附加要求接在后面：${JSON.stringify(r.job.input).slice(0, 160)}`));
    await S.check(() => expect(r.user.content === '生成缺失的页面 /audit-help：顶部带搜索框', `③ 缺失页轮的消息正文：${r.user.content}`));
    await waitJob(r.job.id, 90);

    // 4 补链：胶囊 + 两枚目标屏，正文为空，留空直接发 = 与「重试」同一个作业
    await R.sysJob('edit_screens', { prompt: LINK_REPAIR_PROMPT, screenIds: [s1.id, s2.id], versions: 1 });
    await editLast('补链');
    await S.check(() => eventually(async () => expect((await chip.count()) === 1 && (await chip.innerText()).includes('补链'), `④ 应出补链胶囊：${await chipText()}`)));
    await S.check(async () => expect((await page.getByTestId('target-chip').count()) === 2 && (await input.inputValue()) === '' && (await verbLine(page)).includes('补链 2 屏'), `④ 补链轮的目标 / 正文 / 动词行不对：${await page.getByTestId('target-chip').count()} 「${await input.inputValue()}」 ${await verbLine(page)}`));
    await input.fill('');
    await input.press('Enter');
    await sendNth(4);
    await S.check(() => expect(sent[3].body.preset === 'link_repair' && sent[3].body.content === '' && (sent[3].body.targetScreenIds as string[]).length === 2, `④ 补链参数没随请求发出：${JSON.stringify(sent[3].body).slice(0, 160)}`));
    r = await R.round(8);
    await S.check(() => expect(r.job.kind === 'edit_screens' && r.job.input.prompt === LINK_REPAIR_PROMPT && [...(r.job.input.screenIds as string[])].sort().join() === [s1.id, s2.id].sort().join(), `④ 留空发出的应与重试同一作业：${JSON.stringify(r.job.input).slice(0, 120)}`));
    await S.check(() => expect(r.user.content === '补链：把 2 屏的按钮 / 表单连上路由', `④ 补链轮的消息正文：${r.user.content}`));
    await waitJob(r.job.id, 90);

    // 5 按新约定重生成 + 附加要求；再「修改」反解回附加要求；× 去掉胶囊是普通的改；点选一屏胶囊让位
    await R.sysJob('edit_screens', { prompt: CONVENTIONS_REGENERATE_PROMPT, screenIds: [s2.id], versions: 1 });
    await editLast('按新约定重生成');
    await S.check(() => eventually(async () => expect((await chip.count()) === 1 && (await chip.innerText()).includes('按新约定重生成') && (await page.getByTestId('target-chip').count()) === 1, `⑤ 应出按新约定重生成胶囊与一枚目标：${await chipText()}`)));
    await input.fill('标题用衬线字体');
    await input.press('Enter');
    await sendNth(5);
    r = await R.round(10);
    await S.check(() => expect(r.job.kind === 'edit_screens' && r.job.input.prompt === `${CONVENTIONS_REGENERATE_PROMPT}\n\nADDITIONAL REQUIREMENTS FROM THE USER: 标题用衬线字体`, `⑤ 附加要求应接在固定指令后：${String(r.job.input.prompt).slice(-60)}`));
    await S.check(() => expect(r.user.content === '按新约定重生成 1 屏。附加要求：标题用衬线字体', `⑤ 按新约定重生成轮的消息正文：${r.user.content}`));
    await waitJob(r.job.id, 90);
    await editLast('标题用衬线字体');
    await S.check(() => eventually(async () => expect((await input.inputValue()) === '标题用衬线字体' && (await chip.count()) === 1, `⑤ 再修改应反解回附加要求：「${await input.inputValue()}」 ${await chipText()}`)));
    if (await chip.count()) {
      await chip.getByRole('button').click();
      await S.check(async () => expect((await chip.count()) === 0 && (await verbLine(page)).startsWith('改 1 屏'), `⑤ × 去掉胶囊后应是普通的改：${await verbLine(page)}`));
      await editLast('标题用衬线字体');
      await eventually(async () => expect((await chip.count()) === 1, '再修改应重新出胶囊'));
      // 点第 3 步造出的「Audit Help」：路由只对应这一张卡（Screen 1 / 2 一带叠着变体卡）；前面几轮造出的屏把它挤出了视野，先适配视图
      await page.getByRole('button', { name: '适配视图' }).click();
      await page.locator('[data-testid="screen-card"][data-route="/audit-help"] .gesture').click();
      await S.check(() => eventually(async () => expect((await chip.count()) === 0 && (await page.getByTestId('target-chip').innerText()).includes('Audit Help'), `⑤ 点选一屏后胶囊应让位、目标换成那一屏：${await chipText()} ${await verbLine(page)}`)));
    }
    await shot(page, 'CORE-043');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); }
  S.done();
  return '锚点 + 组件的造屏轮原样填回并仍建 generate；变体 / 缺失页 / 补链 / 按新约定重生成还原成胶囊并建同一类作业，补链留空 = 重试、附加要求接在系统提示词后并能反解；× 与点选屏让位；接口 400 三种';
});

// TC-CORE-044 对话记录：只在贴底时跟随、重试在途锁、大图预览按图定位（REQ-CORE-026 / PAGE-CANVAS v0.74）
await step('TC-CORE-044', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Scroll', '--device', 'mobile', '--screens', '2', '--messages', '30');
  const [s1, s2] = screens;
  const R = roundsOf(projectId);
  const S = softly();
  await R.send({ content: '带图的第一轮', targetScreenIds: [s1.id], attachmentIds: [await uploadPng(projectId)] });
  await R.send({ content: '带图的第二轮', targetScreenIds: [s2.id], attachmentIds: [await uploadPng(projectId)] });
  // 拖 4 s 才回的 OpenAI 兼容桩：别处发的那一轮走它，好在它跑着时不断有进度
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${s1.id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3994, apiKey: 'good-key-0044', reply: body0, holdMs: 4000 });
  let hold = 0;
  const sent = await pinSends(page, { holdMs: () => hold });
  const GET_RE = /\/v1\/projects\/[^/]+\/messages\?limit=100$/;
  try {
    const slow = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Slow 通道 44', endpoint: stub.url, model: 'stub-44', apiKey: 'good-key-0044' }) });
    // 第 2 步从输入框发一轮：stub 轮次没有云端通道时缺省是本机 agent、Enter 被挡，在打开画布之前验证慢桩通道（画布打开时取通道清单），打开后在输入框选中它
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${slow.body.channel.id}/probe`, { method: 'POST' })).body.ok === true, '慢桩通道验证未通过');
    await openCanvas(projectId);
    await pickOption(page, '[data-testid="runner-select"]', 'Slow 通道 44');
    const list = page.locator('[data-testid="chat-dock"] [role="log"]');
    const atBottom = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
    // 1 打开时在底部；往上翻到顶后，别处发的一轮一路推进度、落终态回执，列表不动（修复前每条进度都拽回底部）
    await eventually(async () => expect(await atBottom(), '打开时对话记录应在底部'));
    await list.hover();
    await page.mouse.wheel(0, -60000);
    await eventually(async () => expect((await list.evaluate((el) => el.scrollTop)) === 0, '滚轮应把列表翻到顶'));
    await list.evaluate((el) => { const w = window as unknown as { __maxTop: number }; w.__maxTop = 0; el.addEventListener('scroll', () => { w.__maxTop = Math.max(w.__maxTop, el.scrollTop); }); });
    const other = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ content: '别处发的一轮', targetScreenIds: [s1.id], runner: { kind: 'channel', channelId: slow.body.channel.id } }) });
    await eventually(async () => expect((await page.getByTestId('running-job').count()) > 0 && (await page.getByTestId('running-job').first().innerText()).includes('正在'), '别处发的一轮应带着进度出现在在跑作业行'), 8000);
    expect((await waitJob(other.body.job.id, 60)).status === 'succeeded', '别处发的一轮没成功');
    await eventually(async () => expect((await page.locator('[data-testid="message"]').last().innerText()).includes('已更新'), '终态回执应进对话记录'), 8000);
    const maxTop = await page.evaluate(() => (window as unknown as { __maxTop: number }).__maxTop);
    await S.check(() => expect(maxTop < 4, `① 往上翻看时，进度与新消息把列表拽走了：scrollTop 最大到 ${maxTop}`));
    // 2 自己发的一轮滚到底
    await page.locator(`[data-testid="screen-card"][data-route="${s2.route}"] .gesture`).click();
    await page.locator('#chat-input').fill('自己发的一轮');
    await page.locator('#chat-input').press('Enter');
    await S.check(() => eventually(async () => expect(await atBottom(), '② 自己发出的一轮应滚到底'), 5000));
    const own = await R.round(4);
    await waitJob(own.job.id, 60);

    // 3 重试在途：请求拖 1.5 s，同一帧里连点三次只发一次，期间置灰且 aria-busy
    const retry = page.locator('[data-testid="message"][data-role="assistant"]').last().getByTestId('msg-retry');
    await eventually(async () => expect((await retry.getAttribute('aria-disabled')) !== 'true', '跑完后「重试」应可用'), 8000);
    hold = 1500;
    const retries = () => sent.filter((x) => x.url.endsWith('/retry')).length;
    const before = retries();
    await retry.evaluate((b) => { const el = b as HTMLButtonElement; el.click(); el.click(); el.click(); });
    await page.waitForTimeout(300);
    await S.check(async () => expect((await retry.getAttribute('aria-disabled')) === 'true' && (await retry.getAttribute('aria-busy')) === 'true', `③ 在途时「重试」应置灰并标 aria-busy：${await retry.getAttribute('aria-disabled')} ${await retry.getAttribute('aria-busy')}`));
    await page.waitForTimeout(1700);
    hold = 0;
    const fired = retries() - before;
    await S.check(() => expect(fired === 1, `③ 连点三次应只发一次重试：${fired}`));
    for (const job of await Promise.all((await R.users()).slice(4).map((u) => R.jobOf(u)))) await waitJob(job.id, 60);

    // 4 大图预览翻到第 2 张后，最近 100 条的窗口滑过、带第 1 张图的那轮不在了：停在同一张图、序号变 1 / 1；这张也不在了就关闭并说明
    const withImg = (await R.users()).filter((m) => m.attachments.length).slice(0, 2);
    let drop = new Set<string>();
    await page.route(GET_RE, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      const j = (await res.json()) as { items: RoundMsg[] };
      j.items = j.items.filter((m) => !m.jobId || !drop.has(m.jobId));
      await route.fulfill({ response: res, json: j });
    });
    const thumbs = page.getByTestId('message-attachment-open');
    await eventually(async () => expect((await thumbs.count()) >= 2, `应有带图的轮次：${await thumbs.count()}`), 8000);
    await thumbs.nth(1).click();
    const viewer = page.getByTestId('image-viewer');
    await viewer.waitFor({ timeout: 3000 });
    const total = await thumbs.count();
    expect((await viewer.innerText()).includes(`参考图 2 / ${total}`), `应是 2 / ${total}：${await viewer.innerText()}`);
    const imgPath = async () => new URL((await page.getByTestId('viewer-image').getAttribute('src'))!, WEB).pathname;
    const shown = await imgPath();
    const nudge = () => R.send({ content: '触发一次对话重取', targetScreenIds: [s1.id] });
    drop = new Set([withImg[0].jobId!]);
    await nudge();
    await S.check(() => eventually(async () => expect((await viewer.count()) === 1 && (await viewer.innerText()).includes(`参考图 1 / ${total - 1}`), `④ 列表截短后应停在同一张图、序号变 1 / ${total - 1}：${(await viewer.count()) ? await viewer.innerText() : '预览不在了'}`), 8000));
    await S.check(async () => expect((await viewer.count()) === 1 && (await imgPath()) === shown, '④ 列表截短后预览换了一张图或不在了'));
    await S.check(async () => expect((await page.getByText('Unexpected Application Error').count()) === 0, '④ 列表截短后整页崩了'));
    if ((await page.getByText('Unexpected Application Error').count()) === 0) {
      drop = new Set([withImg[0].jobId!, withImg[1].jobId!]);
      // 说明是一条 3.2 s 的 toast，在 nudge 之前就开始等：页面在这一轮作业刚建出来时就补取消息、关掉预览（v0.76），
      // 而 nudge 要等作业跑完、轮询间隔 3 s，回来再找 toast 可能已经消失
      const closedNote = page.getByText(/预览已关闭/).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      await nudge();
      await S.check(() => viewer.waitFor({ state: 'detached', timeout: 8000 }));
      await S.check(async () => expect(await closedNote, '④ 图不在了应关闭预览并说明'));
      await S.check(async () => expect((await page.getByText('Unexpected Application Error').count()) === 0 && (await page.getByTestId('chat-dock').count()) === 1, '④ 关闭预览后页面应完好'));
    }
    await shot(page, 'CORE-044');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); await page.unroute(GET_RE); await stub.close(); }
  S.done();
  return '往上翻看时别处一轮的进度与回执不移动列表、自己发的一轮滚到底；重试同帧连点只发一次、在途置灰 aria-busy；预览在列表截短时停在同一张图，图不在了关闭并说明';
});

// TC-CORE-045 作业失败的呈现：失败文案、折叠横条的失败标记、toast 的位置（§14 / PAGE-CANVAS v0.74）
await step('TC-CORE-045', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Fails', '--device', 'mobile', '--screens', '2');
  const [s1, s2] = screens;
  const S = softly();
  // 桩：Key 不对回 401；Key 对时改组件回两个根元素（结构不合格），其余回一句话。每个回应拖 1.5 s，
  // 让失败落在画布认领这个作业之后
  const stub = startOpenAiStub({ port: 3995, apiKey: 'good-key-0045', holdMs: 1500, reply: (hit) => (hit.system.startsWith('You maintain ONE shared component') ? '<div class="p-2">a</div><div class="p-2">b</div>' : 'OK') });
  const channel = async (label: string, apiKey: string) => (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label, endpoint: stub.url, model: 'stub-45', apiKey }) })).body.channel.id;
  const badKey = await channel('坏 Key 通道', 'wrong-key-0045');
  const twoRoots = await channel('两根通道', 'good-key-0045');
  const comp = await apiJson<{ component: { id: string } }>(`/v1/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ name: 'AuditBar', html: `<nav class="flex gap-4 p-2"><a href="${s1.route}" aria-current="page">One</a><a href="${s2.route}">Two</a></nav>` }) });
  expect(comp.status === 201, `建组件 ${comp.status}`);
  let runner: unknown = { kind: 'channel', channelId: badKey };
  const sent = await pinSends(page, { runner: () => runner });
  try {
    await openCanvas(projectId);
    // 对话记录折叠
    await page.getByRole('button', { name: /^折叠对话记录/ }).click();
    const input = page.locator('#chat-input');
    // 1 改屏撞上 401：toast 是「改屏失败」+ HTTP 401 + 下一步、不带原始报文；toast 在输入框上方、限宽 28rem
    await page.locator(`[data-testid="screen-card"][data-route="${s1.route}"] .gesture`).click();
    await input.fill('改成深色');
    await input.press('Enter');
    const t1 = page.getByText(/^(改屏失败|生成失败)/).first();
    await t1.waitFor({ timeout: 30000 });
    const text1 = await t1.innerText();
    await S.check(() => expect(text1.startsWith('改屏失败') && text1.includes('HTTP 401') && text1.includes('设置') && !/[{}]|openai-compatible|provider|invalid api key/.test(text1), `① 失败文案应是可读原因 + 下一步：${text1}`));
    const tb = (await t1.boundingBox())!; const cb = (await page.locator('form.composer').boundingBox())!;
    await S.check(() => expect(tb.y + tb.height <= cb.y + 1 && tb.width <= 448 + 1, `① toast 应在输入框上方且限宽 28rem：toast ${JSON.stringify(tb)} 输入框 ${JSON.stringify(cb)}`));
    // 2 折叠横条留下「1 轮失败」，toast 消失后还在；展开即清，助手回执是同一句
    const mark = page.getByTestId('chat-failed');
    await S.check(() => eventually(async () => expect((await mark.count()) === 1 && (await mark.innerText()).includes('1 轮失败'), '② 折叠横条应标出 1 轮失败')));
    await eventually(async () => expect((await page.getByText(/^(改屏失败|生成失败)/).count()) === 0, 'toast 应自行消失'), 6000);
    await S.check(async () => expect((await mark.count()) === 1 && (await mark.isVisible()), '② toast 消失后失败标记应还在'));
    await page.getByRole('button', { name: /^展开对话记录/ }).click();
    await S.check(async () => expect((await mark.count()) === 0, '② 展开后失败标记应清掉'));
    const lastAsst = page.locator('[data-testid="message"][data-role="assistant"]').last();
    await S.check(() => eventually(async () => { const t = await lastAsst.innerText(); expect(t.includes('改屏失败') && t.includes('HTTP 401') && !t.includes('{'), `② 助手回执应是同一句可读文案：${t.slice(0, 120)}`); }, 8000));
    // 3 改组件：模型产出两个根 →「改组件失败」+ 中文原因 + 下一步
    runner = { kind: 'channel', channelId: twoRoots };
    await page.getByTestId('clear-targets').click();
    await page.locator('body').press('f');
    await page.locator('[data-testid="component-card"][data-name="AuditBar"]').click();
    await eventually(async () => expect((await page.locator('form.composer').getAttribute('data-verb')) === 'component', '应是改组件'));
    await input.fill('改成三个 tab');
    await input.press('Enter');
    const t2 = page.getByText(/^(改组件失败|生成失败)/).first();
    await t2.waitFor({ timeout: 30000 });
    const text2 = await t2.innerText();
    await S.check(() => expect(text2.startsWith('改组件失败') && text2.includes('根元素') && text2.includes('重试'), `③ 改组件的失败文案不对：${text2}`));
    expect(sent.length === 2, `应发出两轮：${sent.length}`);
    await shot(page, 'CORE-045');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); await stub.close(); }
  S.done();
  return '401 →「改屏失败：通道的 Key 被拒绝（HTTP 401）…」、toast 在输入框上方且 ≤ 28rem；折叠横条「1 轮失败」toast 消失后仍在、展开即清；改组件失败写「改组件失败」+ 根元素原因';
});

// TC-CORE-046 输入框：通道不被模式切换冲掉、Esc 清草稿可撤销、贴图批量与上限、Enter 被挡说明、在途输入保留（REQ-CORE-006 / 012 / 020 / 023 v0.74）
await step('TC-CORE-046', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Composer', '--device', 'mobile', '--screens', '2');
  const [s1] = screens;
  const S = softly();
  const stub = startOpenAiStub({ port: 3996, apiKey: 'good-key-0046', reply: 'OK' });
  const ch = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 通道 46', endpoint: stub.url, model: 'stub-46', apiKey: 'good-key-0046' }) })).body.channel.id;
  expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch}/probe`, { method: 'POST' })).body.ok, 'Stub 通道验证未通过');
  // 聊天通道：建一条本机 Claude 订阅，只在浏览器读到的 /v1/runners 里把它标成可用（不真的验证、这一条用例也不发聊天）
  const sub = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'agent-sdk', label: '本机 Claude 46', model: 'claude-sonnet-5' }) })).body.channel.id;
  const RUNNERS_RE = /\/v1\/runners$/;
  await page.route(RUNNERS_RE, async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as { items: { id: string; available: boolean; status?: string }[] };
    for (const it of j.items) if (it.id === `channel:${sub}`) { it.available = true; it.status = 'verified'; }
    await route.fulfill({ response: res, json: j });
  });
  let hold = 0; let upHold = 0;
  const sent = await pinSends(page, { holdMs: () => hold });
  const UP_RE = /\/v1\/projects\/[^/]+\/attachments$/;
  await page.route(UP_RE, async (route) => { if (upHold) await new Promise((r) => setTimeout(r, upHold)); await route.continue(); });
  let agentNote = '本机没有 claude，第 6 步跳过';
  try {
    await openCanvas(projectId);
    const input = page.locator('#chat-input');
    // 1 选了 Stub 通道 → 切聊天 → 切回造 / 改：通道还是它，本机记忆没被冲掉（修复前被写成空串）
    const want = `channel:${ch}`;
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 通道 46');
    expect((await selectedValue(page, '[data-testid="runner-select"]')) === want, '没选上 Stub 通道');
    await page.getByTestId('mode-chat').click();
    await eventually(async () => expect((await page.getByTestId('runner-select').innerText()).includes('本机 Claude 46'), '聊天模式应落到本机 Claude 订阅通道'));
    await page.getByTestId('mode-design').click();
    await page.waitForTimeout(300);
    const v = await selectedValue(page, '[data-testid="runner-select"]');
    const ls = await page.evaluate(() => localStorage.getItem('quilt:runner'));
    await S.check(async () => expect(v === want && ls === want && (await page.getByTestId('runner-select').innerText()).includes('Stub 通道 46'), `① 切回造 / 改后通道应还是 Stub 通道：data-value=${v} 本机记忆=${ls}`));
    if (v !== want) await pickOption(page, '[data-testid="runner-select"]', 'Stub 通道 46');
    // 2 Esc 清草稿后 ⌘Z 找回
    await input.click();
    await page.keyboard.type('一段写了很久的提示词');
    await page.keyboard.press('Escape');
    await S.check(async () => expect((await input.inputValue()) === '', `② Esc 应清掉草稿：「${await input.inputValue()}」`));
    await page.keyboard.press('ControlOrMeta+z');
    await S.check(() => eventually(async () => expect((await input.inputValue()) === '一段写了很久的提示词', `② ⌘Z 应找回草稿：「${await input.inputValue()}」`), 2000));
    // 3 上传拖 2.5 s：一次贴 3 张立刻出 3 张缩略图（都在上传）；再贴 3 张只收第 4 张、当场提示上限
    upHold = 2500;
    const paste = (n: number) => input.evaluate((el, a) => {
      const dt = new DataTransfer();
      const bin = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
      for (let i = 0; i < a.n; i++) dt.items.add(new File([bin], `p${Date.now()}-${i}.png`, { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { b64: PNG_B64, n });
    const thumbs = page.locator('button[aria-label^="移除参考图"]');
    const uploadingN = () => page.getByText('上传中…').count();
    await paste(3);
    await page.waitForTimeout(300);
    const first3 = [await thumbs.count(), await uploadingN()];
    await S.check(() => expect(first3[0] === 3 && first3[1] === 3, `③ 一次贴 3 张应立刻出 3 张缩略图：${first3[0]} 张，上传中 ${first3[1]}`));
    await paste(3);
    await S.check(() => eventually(async () => expect((await page.getByText('一条消息最多 4 张参考图').count()) > 0, '③ 超出上限应当场提示')));
    await page.waitForTimeout(300);
    await S.check(async () => expect((await thumbs.count()) === 4, `③ 上限 4 张：实际 ${await thumbs.count()}`));
    // 4 参考图还在传时按 Enter：理由写在发送键上方那一行、不发请求；传完理由撤掉
    await input.fill('照这几张图改');
    const n0 = sent.length;
    await input.press('Enter');
    await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 1 && (await page.getByTestId('send-blocked-reason').innerText()).includes('参考图还在上传'), '④ 按 Enter 被挡时应就地写出理由')));
    expect(sent.length === n0, '参考图没传完不该发出去');
    await eventually(async () => expect((await uploadingN()) === 0, '上传应完成'), 20000);
    await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 0, '④ 传完理由应撤掉')));
    // 5 发送在途（请求拖 1.5 s）时补打的字与新贴的图，发送成功后留着，只去掉发出去的那部分
    while ((await thumbs.count()) > 1) await thumbs.first().click();
    await page.locator(`[data-testid="screen-card"][data-route="${s1.route}"] .gesture`).click();
    hold = 1500;
    await input.press('End');
    await input.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(' 再补一句');
    await paste(1);
    await eventually(async () => expect(sent.length === n0 + 1, '应发出一轮'));
    expect(sent[n0].body.content === '照这几张图改' && (sent[n0].body.attachmentIds as string[] | undefined)?.length === 1, `发出的应是原来那句与 1 张图：${JSON.stringify(sent[n0].body).slice(0, 160)}`);
    await page.waitForTimeout(2000);
    await S.check(async () => expect((await input.inputValue()) === '再补一句', `⑤ 发送成功后应只去掉发出去的那段：「${await input.inputValue()}」`));
    await S.check(async () => expect((await thumbs.count()) === 1, `⑤ 在途时新贴的图应留着：${await thumbs.count()}`));
    hold = 0;
    // 6 本机 agent 通道没选会话时按 Enter（claude 在 PATH 上才有这一路）
    const agentOk = (await apiJson<{ items: { id: string; available: boolean }[] }>('/v1/runners')).body.items.some((i) => i.id === 'agent:claude-code' && i.available);
    if (agentOk) {
      await eventually(async () => expect((await uploadingN()) === 0, '上传应完成'), 20000);
      while ((await thumbs.count()) > 0) await thumbs.first().click();
      // 清掉第 5 步的目标：那一屏的改屏作业可能还在跑，冲突理由会先占住这一行
      await page.getByTestId('clear-targets').click();
      await pickOption(page, '[data-testid="runner-select"]', '交给本机 Claude Code');
      const n1 = sent.length;
      await input.fill('做一个设置页');
      await input.press('Enter');
      await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 1 && (await page.getByTestId('send-blocked-reason').innerText()).includes('会话'), '⑥ 没选会话时按 Enter 应写出理由')));
      expect(sent.length === n1, '没选会话不该发出去');
      await pickOption(page, '[data-testid="runner-select"]', 'Stub 通道 46');
      agentNote = '本机 agent 没选会话按 Enter 写出理由';
    }
    await shot(page, 'CORE-046');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); await page.unroute(RUNNERS_RE); await page.unroute(UP_RE); await stub.close(); }
  S.done();
  return `切聊天再切回通道不丢；Esc 清草稿 ⌘Z 找回；一次贴 3 张立刻 3 张、上限 4 当场提示；上传中按 Enter 写理由；在途补打的字与新图保留；${agentNote}`;
});

// v0.75 来源校验（DESIGN §15「本地服务」）：DNS 重绑后的同源请求（Host 是攻击者域名）、跨站表单与 no-cors 盲写
// （Origin 是别人的或 null）一律 403；本机画布、回环写法、MCP 客户端与脚本（不带 Origin）照常
await step('TC-CORE-060', async () => {
  const port = new URL(API).port;
  const csrfCount = async () => (await apiJson<{ items: { name: string }[] }>('/v1/projects')).body.items.filter((p) => p.name === 'csrf-060').length;
  const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quilt.list_projects', arguments: {} } });
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  // fetch（undici）会丢掉自定义的 Host 头，伪造请求头一律走 node:http
  const raw = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(`${API}${p}`, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
    });
    req.on('error', reject); req.end(init.body);
  });
  const forbidden = (r: { status: number; text: string }, what: string) => expect(r.status === 403 && r.text.includes('/errors/forbidden'), `${what} 应 403 /errors/forbidden：${r.status} ${r.text.slice(0, 120)}`);

  // 1 伪造 Host（DNS 重绑后浏览器发出的样子）：读项目、读通道、调 MCP
  const evilHost = `rebind.attacker.example:${port}`;
  forbidden(await raw('/v1/projects', { headers: { Host: evilHost } }), '伪造 Host 读项目');
  forbidden(await raw('/v1/channels', { headers: { Host: evilHost } }), '伪造 Host 读通道');
  forbidden(await raw('/mcp', { method: 'POST', headers: { ...mcpHeaders, Host: evilHost, Origin: `http://${evilHost}` }, body: mcpBody }), '伪造 Host 调 MCP');

  // 2 跨站盲写：text/plain（CORS 简单请求，不预检）+ 别人的 Origin / null
  const before = await csrfCount();
  for (const origin of ['http://evil.example', 'null']) {
    forbidden(await raw('/v1/projects', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin }, body: JSON.stringify({ name: 'csrf-060', deviceType: 'mobile' }) }), `Origin: ${origin} 的 text/plain 写请求`);
  }
  forbidden(await raw('/mcp', { method: 'POST', headers: { ...mcpHeaders, Origin: 'http://evil.example' }, body: mcpBody }), '别人的 Origin 调 MCP');

  // 3 合法来源照常：画布 origin、回环另一种写法、不带 Origin 的脚本与 MCP 客户端
  for (const origin of [new URL(WEB).origin, `http://127.0.0.1:${port}`]) {
    const r = await raw('/v1/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ name: 'legit-060', deviceType: 'mobile' }) });
    expect(r.status === 201, `Origin ${origin} 建项目应 201：${r.status} ${r.text.slice(0, 120)}`);
  }
  const loop = await raw('/v1/projects', { headers: { Host: `127.0.0.1:${port}` } });
  expect(loop.status === 200, `Host 127.0.0.1:${port} 应 200：${loop.status}`);
  const mcp = await connectMcp();
  try {
    const listed = await callTool(mcp, 'quilt.list_projects', {});
    expect(!listed.isError && listed.text.includes('legit-060'), `MCP 客户端（不带 Origin）应照常列出项目：${listed.text.slice(0, 120)}`);
  } finally { await mcp.close(); }

  // 4 真实浏览器：攻击者域名解析到回环（DNS 重绑之后的状态），页内同源 fetch 与跨站 text/plain 表单
  const rb = await chromium.launch({ channel: 'msedge', headless: true, args: ['--host-resolver-rules=MAP rebind.test 127.0.0.1', '--no-proxy-server'] });
  try {
    const pg = await rb.newPage();
    await pg.goto(`http://rebind.test:${port}/`);
    const same = await pg.evaluate(async (body) => {
      const g = await fetch('/v1/projects');
      const m = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
      return [g.status, m.status];
    }, mcpBody);
    expect(same[0] === 403 && same[1] === 403, `重绑页同源读项目 / 调 MCP 应 403：${same.join(' / ')}`);
    const [resp] = await Promise.all([
      pg.waitForResponse((r) => r.url() === `${API}/v1/projects` && r.request().method() === 'POST'),
      pg.evaluate((api) => {
        const f = document.createElement('form'); f.method = 'post'; f.enctype = 'text/plain'; f.action = `${api}/v1/projects`;
        const i = document.createElement('input'); i.name = '{"name":"csrf-060","deviceType":"mobile","x":"'; i.value = '"}';
        f.appendChild(i); document.body.appendChild(f); f.submit();
      }, API),
    ]);
    expect(resp.status() === 403, `跨站 text/plain 表单应 403：${resp.status()}`);
    await pg.waitForLoadState('load').catch(() => {});
    await pg.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-060.png`) });
  } finally { await rb.close(); }
  expect((await csrfCount()) === before, `跨站写请求建出了项目（csrf-060 多了 ${(await csrfCount()) - before} 个）`);
  return `伪造 Host 读项目 / 通道 / MCP 与 evil / null Origin 写入全部 403；画布 origin、127.0.0.1、MCP 客户端照常；重绑页同源 fetch 与跨站表单 403，未建出项目`;
});

// v0.75 屏里的脚本写不了主站（DESIGN §15「预览域」「对象下发」，ADR-004 补充）：同一张屏的脚本在截图渲染、导出抽 CSS、
// 预览域活 iframe、对象地址四处各跑一遍，每处都用 fetch no-cors 与 text/plain 表单往本机 API 写；库里一条都不能多。
// 屏里放一块探针：看到 connect-src 与 form-action 两类 CSP 违规、且预览域素材与 https 图片都加载出来才涂绿
await step('TC-CORE-061', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const pid = (await apiJson<{ project: { id: string } }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Isolation', deviceType: 'mobile' }) })).body.project.id;
  const form = new FormData();
  form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#2f9e44"/></svg>'], { type: 'image/svg+xml' }), 'green.svg');
  const assetUrl = ((await (await fetch(`${API}/v1/projects/${pid}/assets`, { method: 'POST', body: form })).json()) as { asset: { url: string } }).asset.url;
  const html = `<div class="bg-background p-6 space-y-4">
  <h1 class="text-2xl font-bold text-primary">Isolation</h1>
  <i data-lucide="house"></i>
  <img id="asset" src="${assetUrl}" width="40" height="40" alt="">
  <img id="remote" src="https://picsum.photos/id/10/40/40" width="40" height="40" alt="">
  <div id="probe" style="position:fixed;left:0;top:0;margin:0;width:60px;height:60px;background:#808080"></div>
  <script>
  (function () {
    var api = '${API}', pid = '${pid}', seen = {};
    function paint() {
      var ok = seen['form-action'] && seen['connect-src'] && document.getElementById('asset').naturalWidth > 0 && document.getElementById('remote').naturalWidth > 0;
      document.getElementById('probe').style.background = ok ? '#00c800' : '#c80000';
    }
    document.addEventListener('securitypolicyviolation', function (e) { seen[e.effectiveDirective] = 1; paint(); });
    function body(how) { return JSON.stringify({ content: 'csrf-061 ' + how + ' ' + location.origin, runner: { kind: 'model', driver: 'stub', model: 'stub' } }); }
    // 等 load 之后再动手：被 CSP 挡下的 form.submit() 会中止文档自己的加载，解析中途调用的话后面的内容与图片都不再加载
    window.addEventListener('load', function () {
      paint();
      fetch(api + '/v1/projects/' + pid + '/messages', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: body('fetch') }).catch(function () {});
      fetch(api + '/v1/projects', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: 'csrf-061', deviceType: 'mobile' }) }).catch(function () {});
      var f = document.createElement('form'); f.method = 'post'; f.enctype = 'text/plain'; f.action = api + '/v1/projects/' + pid + '/messages';
      var i = document.createElement('input'); var b = body('form'); i.name = b.slice(0, -1) + ',"x":"'; i.value = '"}';
      f.appendChild(i); document.body.appendChild(f); f.submit();
    });
  })();
  </script>
</div>`;
  // 写进库的痕迹：本项目里 csrf-061 开头的消息（每条都带发出它的 origin）与名为 csrf-061 的项目
  const leaks = async () => {
    const msgs = (await apiJson<{ items: { content: string }[] }>(`/v1/projects/${pid}/messages?limit=100`)).body.items.filter((m) => m.content.startsWith('csrf-061')).map((m) => m.content);
    const projs = (await apiJson<{ items: { name: string }[] }>('/v1/projects')).body.items.filter((p) => p.name === 'csrf-061').length;
    return { msgs, projs, none: msgs.length === 0 && projs === 0, text: `消息 ${JSON.stringify(msgs)}，csrf-061 项目 ${projs} 个` };
  };
  const probeColor = (b64: string, x: number, y: number) => page.evaluate(async ([data, px, py]) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(px as number, py as number, 1, 1).data.slice(0, 3));
  }, [b64, x, y] as const);
  const green = (rgb: number[]) => rgb[0] < 40 && rgb[1] > 160 && rgb[2] < 40;

  const mcp = await connectMcp();
  try {
    const created = await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Isolation', route: '/iso', html });
    expect(!created.isError, `推屏失败：${created.text.slice(0, 200)}`);
    const sid = (created.json as { screenId: string }).screenId;

    // 1 截图渲染：入库即截图，截图浏览器里同一段脚本执行
    let shotUrl: string | null = null;
    for (let i = 0; i < 40 && !shotUrl; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      shotUrl = (await apiJson<{ screens: { id: string; screenshotUrl: string | null }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)?.screenshotUrl ?? null;
    }
    const afterShot = await leaks();
    check(afterShot.none, `截图渲染后库里多出写入：${afterShot.text}`);
    if (!shotUrl) bad.push('截图 40 s 内未就绪');
    else {
      const b64 = Buffer.from(await (await fetch(shotUrl)).arrayBuffer()).toString('base64');
      const rgb = await probeColor(b64, 30, 30);
      check(green(rgb), `截图里探针不是绿色（${rgb.join(',')}）：截图渲染页没报出 connect-src / form-action 违规，或素材 / https 图片没加载出来`);
    }

    // 2 导出：抽 Tailwind 并集 CSS 时全部屏的 body 放进一页，脚本同样执行；产物与下载照常
    const exp = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    const expJob = await waitJob(exp.body.job.id, 90);
    check(expJob.status === 'succeeded', `导出作业 ${expJob.status}`);
    const afterExport = await leaks();
    check(afterExport.none, `导出后库里多出写入：${afterExport.text}`);
    const dl = await fetch(`${API}/v1/jobs/${exp.body.job.id}/export`);
    const dlText = await dl.text();
    check(dl.status === 200 && (dl.headers.get('content-disposition') ?? '').startsWith('attachment') && dlText.includes('Isolation') && dlText.includes('--tw-'), `画布的导出下载应 200 attachment 且含屏与 Tailwind CSS：${dl.status} ${dl.headers.get('content-disposition')}`);
    const ge = await callTool(mcp, 'quilt.get_export', { jobId: exp.body.job.id });
    const exportUrl = (ge.json as { url?: string }).url ?? '';
    check(exportUrl, `get_export 没给出地址：${ge.text.slice(0, 160)}`);

    // 3 对象地址：修订 htmlUrl 与 get_export 的 url 在 API origin 上下发——必须是附件、不在浏览器里渲染
    const rev = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${sid}/revisions`)).body.items[0];
    for (const [what, url] of [['htmlUrl', rev.htmlUrl], ['get_export url', exportUrl]] as const) {
      if (!url) continue;
      const r = await fetch(url);
      const cd = r.headers.get('content-disposition') ?? ''; const csp = r.headers.get('content-security-policy') ?? '';
      check(r.status === 200 && cd.startsWith('attachment') && csp.includes('sandbox') && r.headers.get('x-content-type-options') === 'nosniff', `${what} 响应头应为附件 + CSP sandbox + nosniff：${r.status} cd=${cd} csp=${csp}`);
      check((await r.text()).includes('csrf-061'), `${what} 的正文应照常可取`);
      const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await page.goto(url).catch(() => {});
      const d = await download;
      check(d, `浏览器打开 ${what} 应是下载，实际渲染在 ${page.url().slice(0, 60)}`);
      const name = d?.suggestedFilename() ?? '';
      check(!d || /^[0-9a-f-]{36}\.html$/.test(name), `${what} 的下载文件名应是对象键末段（<id>.html）：${name}`);
      await d?.cancel().catch(() => {});
    }
    await page.waitForTimeout(1500);
    const afterObjects = await leaks();
    check(afterObjects.none, `打开对象地址后库里多出写入：${afterObjects.text}`);

    // 4 预览域：响应头 CSP 含 form-action 'none'；双击进交互态，活 iframe 里同样报出两类违规，库里不多东西
    const pv = (await apiJson<{ screens: { id: string; previewUrl: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)!.previewUrl;
    const pvRes = await fetch(pv.replace(/\/\/[^/:]+/, '//127.0.0.1'));
    check((pvRes.headers.get('content-security-policy') ?? '').includes("form-action 'none'"), `预览响应的 CSP 缺 form-action 'none'：${pvRes.headers.get('content-security-policy')}`);
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"][data-route="/iso"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="screen-card"][data-route="/iso"] .gesture').dblclick();
    const fl = page.frameLocator('.card.focused iframe');
    let bg = '';
    if (await fl.locator('#probe').waitFor({ timeout: 15000 }).then(() => true, () => false)) {
      await eventually(async () => { bg = await fl.locator('#probe').evaluate((el) => getComputedStyle(el).backgroundColor); expect(bg === 'rgb(0, 200, 0)', bg); }, 10000).catch(() => {});
      check(bg === 'rgb(0, 200, 0)', `预览 iframe 里探针不是绿色（${bg}）：没报出 connect-src / form-action 违规，或素材 / https 图片没加载出来`);
    } else bad.push(`预览 iframe 里 15 s 找不到探针（iframe 现在是 ${await page.locator('.card.focused iframe').evaluate((el) => (el as HTMLIFrameElement).src.slice(0, 60)).catch(() => '无')}，可能被屏里的表单提交带走了）`);
    await shot(page, 'CORE-061');
    await page.waitForTimeout(1500);
    const afterPreview = await leaks();
    check(afterPreview.none, `预览 iframe 跑过后库里多出写入：${afterPreview.text}`);
    await page.keyboard.press('Escape');
  } finally { await mcp.close(); }
  if (bad.length) { console.log(`   TC-CORE-061 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '截图渲染 / 导出抽 CSS / 对象地址 / 预览 iframe 四处都没写进库；截图与预览里探针为绿（两类 CSP 违规 + 素材与 https 图片加载）；htmlUrl 与导出地址为附件，浏览器下载不渲染；导出下载照常';
});

// v0.77 接口契约（DESIGN API-CORE-006 / 010 / 019 / 034、API-EDIT-005、§14）：目标屏与组件在建作业之前复核、
// 路径参数不是 UUID 回 404、非法游标回 400、内容校验按契约回 422。全部走 stub 通道，失败项攒齐一起报
await step('TC-CORE-062', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const FAKE = '11111111-2222-4333-8444-555555555555';
  type Problem = { type?: string; errors?: { path: string }[] };
  const post = <T,>(p: string, body: unknown) => apiJson<T & Problem>(p, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Contract', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, s2, s3] = screens.map((s) => s.id);
  const jobCount = async () => (await apiJson<{ items: unknown[] }>(`/v1/projects/${pid}/jobs?limit=100`)).body.items.length;

  // 1 目标屏不存在：发消息、建 edit_screens 作业都 404，一个作业也不建
  const before1 = await jobCount();
  const m404 = await post('/v1/projects/' + pid + '/messages', { content: 'change the title', targetScreenIds: [FAKE], runner: STUB });
  check(m404.status === 404 && m404.body.type === '/errors/not-found', `发消息目标屏不存在应 404：${m404.status} ${m404.body.type}`);
  const j404 = await post(`/v1/projects/${pid}/jobs`, { kind: 'edit_screens', input: { prompt: 'x', screenIds: [s1, FAKE], versions: 1, runner: STUB } });
  check(j404.status === 404 && j404.body.type === '/errors/not-found', `建 edit_screens 带不存在的屏应 404：${j404.status} ${j404.body.type}`);
  check((await jobCount()) === before1, `目标屏不存在时仍建出了作业（${before1} → ${await jobCount()}）`);

  // 2 改屏一轮跑完 → 删掉目标屏 → 重试 404
  const edit = await post<{ userMessage: { id: string }; job: { id: string } }>(`/v1/projects/${pid}/messages`, { content: 'make the header bold', targetScreenIds: [s3], runner: STUB });
  expect(edit.status === 202, `改屏一轮 ${edit.status}`);
  await waitJob(edit.body.job.id, 60);
  expect((await apiJson(`/v1/screens/${s3}`, { method: 'DELETE' })).status === 204, '删屏失败');
  const r404 = await post(`/v1/projects/${pid}/messages/${edit.body.userMessage.id}/retry`, {});
  check(r404.status === 404 && r404.body.type === '/errors/not-found', `目标屏已删的重试应 404：${r404.status} ${r404.body.type}`);

  // 3 改组件一轮跑完 → 删掉组件 → 重试 400，path 与发消息一致
  const comp = (await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Chip', html: '<div class="px-2 py-1 rounded-full bg-primary text-on-primary"><span>chip</span></div>' }) })).body.component;
  const ce = await post<{ userMessage: { id: string }; job: { id: string } }>(`/v1/projects/${pid}/messages`, { content: 'rounder', targetComponentIds: [comp.id], runner: STUB });
  expect(ce.status === 202, `改组件一轮 ${ce.status}`);
  await waitJob(ce.body.job.id, 60);
  const ceSend = await post(`/v1/projects/${pid}/messages`, { content: 'again', targetComponentIds: [FAKE], runner: STUB });
  expect((await apiJson(`/v1/components/${comp.id}`, { method: 'DELETE' })).status === 204, '删组件失败');
  const r400 = await post(`/v1/projects/${pid}/messages/${ce.body.userMessage.id}/retry`, {});
  check(r400.status === 400 && r400.body.type === '/errors/validation' && r400.body.errors?.[0]?.path === ceSend.body.errors?.[0]?.path, `组件已删的重试应与发消息同一个 400（path ${ceSend.body.errors?.[0]?.path}）：${r400.status} ${r400.body.type} ${r400.body.errors?.[0]?.path}`);

  // 4 造变体的 variantOf 不属本项目 → 422，不建作业
  const before4 = await jobCount();
  const v422 = await post(`/v1/projects/${pid}/jobs`, { kind: 'generate', input: { prompt: 'empty state', count: 1, versions: 1, variantOf: FAKE, variantName: '空状态', runner: STUB } });
  check(v422.status === 422 && v422.body.type === '/errors/validation', `variantOf 不属本项目应 422：${v422.status} ${v422.body.type}`);
  check((await jobCount()) === before4, 'variantOf 不对时仍建出了作业');

  // 5 路径 id 不是 UUID → 404；非法游标 → 400
  const cur = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === s1)!.currentRevisionId;
  const probes: [string, string, unknown?][] = [
    ['GET', '/v1/projects/x'], ['GET', '/v1/projects/x/messages'], ['PATCH', '/v1/screens/x', { x: 1 }], ['DELETE', '/v1/screens/x'], ['GET', '/v1/jobs/x'],
    ['POST', '/v1/jobs/x/cancel', {}], ['POST', '/v1/jobs/x/candidates/adopt', { index: 0 }], ['DELETE', '/v1/components/x'], ['PATCH', '/v1/annotations/x', { note: 'n' }],
    ['DELETE', '/v1/assets/x'], ['DELETE', '/v1/design-presets/x'], ['DELETE', '/v1/channels/x'], ['POST', `/v1/projects/${pid}/messages/x/retry`, {}],
    ['GET', `/v1/screens/${s1}/revisions/x`], ['POST', `/v1/screens/${s1}/revisions/x/restore`, { expectedRevisionId: cur }],
  ];
  const not404: string[] = [];
  for (const [method, p, body] of probes) {
    const r = await apiJson<Problem>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status !== 404 || r.body?.type !== '/errors/not-found') not404.push(`${method} ${p} → ${r.status}`);
  }
  check(!not404.length, `非 UUID 的路径 id 应 404：${not404.join('，')}`);
  for (const p of [`/v1/projects/${pid}/messages?cursor=abc`, '/v1/projects?cursor=notadate']) {
    const r = await apiJson<Problem>(p);
    check(r.status === 400 && r.body.type === '/errors/validation', `非法游标应 400：${p} → ${r.status}`);
  }
  const okCursor = await apiJson<{ items: unknown[] }>(`/v1/projects/${pid}/messages?cursor=${encodeURIComponent(new Date().toISOString())}`);
  check(okCursor.status === 200, `合法游标应 200：${okCursor.status}`);

  // 6 附件与组件直改的内容校验 → 422
  const gif = await apiJson<Problem>(`/v1/projects/${pid}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/gif', bytes: 10 }) });
  check(gif.status === 422 && gif.body.type === '/errors/validation', `附件类型不对应 422：${gif.status}`);
  const signed = (await apiJson<{ putUrl: string }>(`/v1/projects/${pid}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: 10 }) })).body;
  const empty = await fetch(API + signed.putUrl, { method: 'PUT', body: new Uint8Array(0), headers: { 'content-type': 'image/png' } });
  check(empty.status === 422, `直传空文件应 422：${empty.status}`);
  const c2 = (await apiJson<{ component: { id: string; html: string; version: number } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Tag', html: '<div class="px-2"><span>tag</span></div>' }) })).body.component;
  const rootQid = /data-qid="(q\d+)"/.exec(c2.html)?.[1] ?? 'q1';
  const rm = await apiJson<Problem>(`/v1/components/${c2.id}/elements/${rootQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'remove' }], expectedVersion: c2.version }) });
  check(rm.status === 422 && rm.body.type === '/errors/validation', `组件直改删掉根元素应 422：${rm.status}`);

  if (bad.length) { console.log(`   TC-CORE-062 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '目标屏不存在 / 已删 404、组件已删的重试同发消息 400、variantOf 422，均不建作业；15 个非 UUID 路径 404、两处非法游标 400；附件类型 / 空文件与组件删根 422';
});

// v0.77 并发写入的一致性（DESIGN §16 竞态表）：采用候选 vs 回溯、设计系统同版本并发保存、同一幂等键并发、删屏 / 删项目时在途截图
await step('TC-CORE-063', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Race', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, s2] = screens.map((s) => s.id);
  const currentOf = async (sid: string) => (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)!.currentRevisionId;
  // 前面的用例刚建过作业：等限流窗口（10 次 / 分钟）清空，本条要建 8 个
  await sleep(61_000);

  // 1 采用候选 vs 回溯：每轮先出两版候选，再同时发「回溯到第 1 版」与「采用第 2 版」（采用晚 d ms）；两边不能都成功，回溯成功时它必须是 current
  for (const d of [0, 10, 20, 30]) {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: `two versions ${d}`, targetScreenIds: [s1], versions: 2, runner: STUB }) });
    expect(r.status === 202, `出候选 ${r.status}`);
    expect((await waitJob(r.body.job.id, 60)).status === 'succeeded', '出候选的作业没成功');
    const cands = (await apiJson<{ screens: { revisions: { id: string; index: number }[] }[] }>(`/v1/jobs/${r.body.job.id}/candidates`)).body.screens[0].revisions;
    const [c0, c1] = [cands.find((x) => x.index === 0)!.id, cands.find((x) => x.index === 1)!.id];
    const [restore, adopt] = await Promise.all([
      apiJson<{ revision?: { id: string } }>(`/v1/screens/${s1}/revisions/${c0}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: c0 }) }),
      sleep(d).then(() => apiJson(`/v1/screens/${s1}/revisions/${c1}/adopt`, { method: 'POST', body: '{}' })),
    ]);
    const now = await currentOf(s1);
    check(!(restore.status === 201 && adopt.status === 200), `采用晚 ${d} ms：回溯 ${restore.status} 与采用 ${adopt.status} 都成功`);
    if (restore.status === 201) check(now === restore.body.revision!.id, `采用晚 ${d} ms：回溯成功了但 current 不是它（被候选顶掉）`);
  }

  // 2 设计系统：同一 expectedVersion 并发 6 个保存，只能成一个
  const colors = ['#E03131', '#2F9E44', '#1971C2', '#F08C00', '#7048E8', '#0CA678'];
  for (let round = 0; round < 3; round++) {
    const v = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    const rs = await Promise.all(colors.map((seedColor) => apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ seedColor, expectedVersion: v }) })));
    const codes = rs.map((x) => x.status);
    const after = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    check(codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 5 && after === v + 1, `第 ${round + 1} 轮 expectedVersion=${v}：${codes.join(' ')}，之后版本 ${after}`);
  }

  // 3 同一个 Idempotency-Key 并发：导出 3 个、改屏 2 个，都拿到同一个作业，没有 409
  for (let round = 0; round < 2; round++) {
    const key = crypto.randomUUID();
    const rs = await Promise.all([0, 1, 2].map(() => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) })));
    const ids = new Set(rs.map((x) => x.body.job?.id));
    check(rs.every((x) => x.status === 202 || x.status === 200) && ids.size === 1 && !ids.has(undefined), `导出同键并发：${rs.map((x) => `${x.status}${x.body.type ? ' ' + x.body.type : ''}`).join(' / ')}`);
    const mkey = crypto.randomUUID();
    const ms = await Promise.all([0, 1].map(() => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': mkey }, body: JSON.stringify({ content: `same key ${round}`, targetScreenIds: [s2], runner: STUB }) })));
    const mids = new Set(ms.map((x) => x.body.job?.id));
    check(ms.every((x) => x.status === 202 || x.status === 200) && mids.size === 1 && !mids.has(undefined), `改屏同键并发：${ms.map((x) => `${x.status}${x.body.type ? ' ' + x.body.type : ''}`).join(' / ')}`);
    for (const id of mids) if (id) await waitJob(id, 60);
  }

  // 4 删屏 / 删项目时截图正在渲染：屏里一张连不上的外链图让截图拖十几秒，期间删掉；之后不能留下对象
  const mcp = await connectMcp();
  try {
    const STALL = '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Stall</h1><img src="http://10.255.255.1/x.png" width="40" height="40" alt=""></div>';
    const p2 = (await apiJson<{ project: { id: string } }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Orphan', deviceType: 'mobile' }) })).body.project.id;
    const a = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Stall', route: '/stall', html: STALL })).json as { screenId: string; revisionId: string };
    const b = (await callTool(mcp, 'quilt.create_screen', { projectId: p2, name: 'Stall', route: '/stall', html: STALL })).json as { screenId: string };
    // 对照屏：同一份 HTML、不删，它的截图就绪说明被删的那两张也渲染完了——之后再看目录，免得截图还没写回就判通过
    const ctl = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Control', route: '/control', html: STALL })).json as { screenId: string };
    await sleep(2000);
    const pending = (await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${a.screenId}/revisions`)).body.items[0].screenshotUrl === null;
    expect((await apiJson(`/v1/screens/${a.screenId}`, { method: 'DELETE' })).status === 204, '删屏失败');
    expect((await apiJson(`/v1/projects/${p2}`, { method: 'DELETE' })).status === 204, '删项目失败');
    let rendered = false;
    for (let i = 0; i < 90 && !rendered; i++) { await sleep(1000); rendered = !!(await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${ctl.screenId}/revisions`)).body.items[0]?.screenshotUrl; }
    expect(rendered, '对照屏 90 s 内截图未就绪，判不了被删屏的截图写回');
    await sleep(3000);
    const screenDir = path.join(ROOT, '.data/objects/projects', pid, 'screens', a.screenId);
    const projectDir = path.join(ROOT, '.data/objects/projects', p2);
    check(!existsSync(screenDir), `删屏且截图渲染完之后对象目录还在：${screenDir}（删屏时截图${pending ? '还在渲染' : '已就绪，前置不成立'}）`);
    check(!existsSync(projectDir), `删项目且截图渲染完之后对象目录还在：${projectDir}${b.screenId ? '' : '（建屏失败）'}`);
  } finally { await mcp.close(); }

  if (bad.length) { console.log(`   TC-CORE-063 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '采用 vs 回溯 4 轮无双成功、current 不被顶掉；设计系统 3 轮 × 6 并发各只成一个；同键并发导出 / 改屏都拿到首次作业；删屏 / 删项目时在途截图不留对象';
});

// v0.77 别处的写入推到已打开的画布（DESIGN API-CORE-030、PAGE-CANVAS「变化从哪来都能到」）：MCP 与另一个「标签页」（直接调 REST）
// 挪屏、删屏、改项目名、改设计系统、建组件、加批注，画布不刷新就能看到；项目被删时事件流发完 project_deleted 就关，画布重取得 404
await step('TC-CORE-064', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Live', '--device', 'mobile', '--screens', '3');
  const [s1, , s3] = screens.map((s) => s.id);
  const pg = await ctx.newPage();
  const detailGets: number[] = [];
  pg.on('response', (r) => { if (r.request().method() === 'GET' && new URL(r.url()).pathname === `/v1/projects/${pid}`) detailGets.push(r.status()); });
  const mcp = await connectMcp();
  try {
    await pg.goto(`${WEB}/p/${pid}`, { waitUntil: 'domcontentloaded' });
    const cards = pg.locator('[data-testid="screen-card"]');
    await eventually(async () => expect((await cards.count()) === 3, 'cards'), 15000);
    await pg.waitForTimeout(1500); // 首屏加载的重取落定后再数
    const refetched = async (what: string, act: () => Promise<unknown>) => {
      const n = detailGets.length;
      await act();
      await eventually(() => expect(detailGets.length > n, what), 4000).catch(() => check(false, `${what}后 4 s 内画布没有重取详情`));
    };
    // 挪屏（MCP move_screens）
    await callTool(mcp, 'quilt.move_screens', { screens: [{ id: s1, x: 3000, y: 2000 }] });
    await eventually(async () => expect((await pg.locator('[data-testid="screen-card"][data-route="/s1"]').getAttribute('style'))?.includes('translate(3000px, 2000px)'), 'move'), 4000)
      .catch(async () => check(false, `MCP 挪屏后 4 s 画布上 /s1 还在原位：${await pg.locator('[data-testid="screen-card"][data-route="/s1"]').getAttribute('style')}`));
    // 删屏（MCP delete_screen）
    await callTool(mcp, 'quilt.delete_screen', { screenId: s3 });
    await eventually(async () => expect((await cards.count()) === 2, 'delete'), 4000).catch(async () => check(false, `MCP 删屏后 4 s 画布仍有 ${await cards.count()} 张卡`));
    // 改项目名（MCP update_project）
    await callTool(mcp, 'quilt.update_project', { projectId: pid, name: 'Live 2' });
    await eventually(async () => expect((await pg.title()).startsWith('Live 2'), 'rename'), 4000).catch(async () => check(false, `MCP 改名后 4 s 标签页标题仍是「${await pg.title()}」`));
    await pg.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-064.png`) });
    // 改设计系统（另一个标签页：直接 PUT）、建组件（MCP）、加批注（REST）
    const v = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    await refetched('另一个标签页改设计系统', () => apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ seedColor: '#E03131', expectedVersion: v }) }));
    await callTool(mcp, 'quilt.create_component', { projectId: pid, name: 'Badge', html: '<span class="px-2 rounded-full bg-primary text-on-primary">new</span>' });
    await eventually(async () => expect((await pg.locator('[data-testid="component-card"][data-name="Badge"]').count()) === 1, 'component'), 4000).catch(() => check(false, 'MCP 建组件后 4 s 画布上没有组件卡'));
    await refetched('另一个标签页加批注', () => apiJson(`/v1/screens/${s1}/annotations`, { method: 'POST', body: JSON.stringify({ qid: 'q1', note: '标题再大一点', anchorText: 'Screen 1', rect: { x: 0, y: 0, w: 100, h: 40 } }) }));
    // 删项目：一条独立的事件流应收到 project_deleted 并结束；画布重取得 404
    const es = await fetch(`${API}/v1/projects/${pid}/events`, { headers: { Accept: 'text/event-stream' } });
    const reader = es.body!.getReader();
    let text = '';
    const ended = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return true; text += new TextDecoder().decode(value); } })();
    await pg.waitForTimeout(500);
    const n404 = detailGets.filter((s) => s === 404).length;
    await callTool(mcp, 'quilt.delete_project', { projectId: pid });
    const closed = await Promise.race([ended, new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!closed) await reader.cancel().catch(() => {});
    check(text.includes('project_deleted'), `删项目后 5 s 事件流没有 project_deleted：${JSON.stringify(text.slice(0, 160))}`);
    check(closed, '删项目后 5 s 事件流没有结束');
    await eventually(() => expect(detailGets.filter((s) => s === 404).length > n404, '404'), 5000).catch(() => check(false, '删项目后 5 s 画布没有重取详情（没拿到 404）'));
  } finally { await mcp.close(); await pg.close(); }
  if (bad.length) { console.log(`   TC-CORE-064 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return 'MCP 挪屏 / 删屏 / 改名、建组件在 4 s 内到画布；另一个标签页改设计系统、加批注触发重取；删项目时事件流发 project_deleted 后结束，画布重取得 404';
});

// ---- v0.78 共用（TC-CORE-047~049）----
type Box = { x: number; y: number; width: number; height: number };
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const blurActive = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
// 铺满视口、带背景模糊的 fixed 层有几层：弹层只该有一层遮罩
const backdropLayers = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return cs.position === 'fixed' && r.width >= innerWidth - 1 && r.height >= innerHeight - 1 && cs.backdropFilter !== 'none';
}).length);

// TC-CORE-047 侧面板与弹层：修订参数不残留、⌘K 列全、工具栏提示在面板之上、关面板焦点归还、单层遮罩、改名不被指针抢焦点（v0.78）
await step('TC-CORE-047', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Panels', '--device', 'mobile', '--screens', '14', '--dangling', '--no-shot');
  const other = seedJson<{ projectId: string }>('seed:project', '--name', 'Switch Target', '--device', 'mobile', '--screens', '1', '--no-shot');
  const S = softly();
  const card = (r: string) => page.locator(`[data-testid="screen-card"][data-route="${r}"] .gesture`);
  const panelN = () => page.locator('.slide-in-right').count();
  const projName = async () => (await apiJson<{ project: { name: string } }>(`/v1/projects/${projectId}`)).body.project.name;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 1 直接打开 ?panel=revisions：没有选中 → 参数从 URL 去掉；单选一屏不冒出修订面板
    await page.goto(`${WEB}/p/${projectId}?panel=revisions`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await S.check(() => eventually(async () => expect(!page.url().includes('panel=revisions'), `① 没有选中时 ?panel=revisions 应从 URL 去掉：${page.url()}`), 3000));
    await page.getByRole('button', { name: '适配视图' }).click();
    await page.waitForTimeout(600);
    await card('/s1').click();
    await page.waitForTimeout(500);
    await S.check(async () => expect((await panelN()) === 0, '① 单选一屏不该冒出修订面板'));
    // 会话内：⌥R 开修订 → Shift 加选第二屏 → 参数去掉 → 再单选一屏 → 不弹（上一步冒出了面板就先回到干净的 URL 再来）
    if (await panelN()) { await page.goto(`${WEB}/p/${projectId}`); await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 }); await page.waitForTimeout(600); await card('/s1').click(); }
    await page.keyboard.press('Alt+r');
    await eventually(async () => expect(page.url().includes('panel=revisions') && (await panelN()) === 1, '⌥R 应打开修订面板'));
    await card('/s2').click({ modifiers: ['Shift'] });
    await S.check(() => eventually(async () => expect(!page.url().includes('panel=revisions'), '① 加选成两屏后 ?panel=revisions 应去掉'), 3000));
    await card('/s2').click();
    await page.waitForTimeout(500);
    await S.check(async () => expect((await panelN()) === 0, '① 加选后再单选一屏不该冒出修订面板'));
    // 2 ⌘K：14 屏全部列出，↓ 能走到最后一行
    await blurActive();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('screen-finder').waitFor({ timeout: 3000 });
    const rowsAll = await page.getByTestId('finder-row').count();
    await S.check(() => expect(rowsAll === 14, `② ⌘K 空查询应列出全部 14 屏：${rowsAll} 行`));
    await page.getByTestId('finder-input').fill('/s');
    await page.waitForTimeout(200);
    const rowsQ = await page.getByTestId('finder-row').count();
    await S.check(() => expect(rowsQ === 14, `② 「/s」命中全部 14 屏：${rowsQ} 行`));
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    const lastId = await page.getByTestId('finder-row').last().getAttribute('data-id');
    const selId = await page.locator('[data-testid="finder-row"][aria-selected="true"]').getAttribute('data-id');
    await S.check(() => expect(selId === lastId, '② ↓ 应能走到最后一行'));
    await page.keyboard.press('Escape');
    await page.getByTestId('screen-finder').waitFor({ state: 'detached', timeout: 3000 });
    // 3 设计系统面板开着时悬停工具栏「适配视图」：提示画在面板之上
    await blurActive();
    await page.keyboard.press('Alt+d');
    await eventually(async () => expect(page.url().includes('panel=design') && (await panelN()) === 1, '⌥D 应打开设计系统面板'));
    await page.getByRole('button', { name: '适配视图' }).hover();
    await page.getByTestId('tool-tip').waitFor({ timeout: 3000 });
    const tipTop = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="tool-tip"]') as HTMLElement;
      t.style.pointerEvents = 'auto';   // 提示本身不吃指针，量层叠前临时打开命中
      const r = t.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      t.style.pointerEvents = '';
      return t.contains(el) ? 'tip' : el?.closest('.slide-in-right') ? 'panel' : el?.tagName ?? 'none';
    });
    await S.check(() => expect(tipTop === 'tip', `③ 工具栏提示应画在面板之上，中心点命中的是 ${tipTop}`));
    await page.mouse.move(700, 450);
    await page.keyboard.press('Alt+d');
    await eventually(async () => expect((await panelN()) === 0, '⌥D 应关掉设计系统面板'));
    // 4 用面板的「关闭」关掉：键盘从工具栏打开的回到那个按钮；快捷键打开的回到工具栏上同名的工具
    await page.getByTestId('toggle-screens').focus();
    await page.keyboard.press('Enter');
    await eventually(async () => expect(page.url().includes('panel=screens') && (await panelN()) === 1, '「屏列表」应打开面板'));
    await page.locator('.slide-in-right').getByRole('button', { name: '关闭' }).focus();
    await page.keyboard.press('Enter');
    await eventually(async () => expect((await panelN()) === 0, '「关闭」应关掉面板'));
    await page.waitForTimeout(200);
    const back1 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    await S.check(() => expect(back1 === 'toggle-screens', `④ 关掉后焦点应回到「屏列表」键：${back1}`));
    await blurActive();
    await page.keyboard.press('Alt+s');
    await eventually(async () => expect((await panelN()) === 1, '⌥S 应打开屏列表'));
    await page.locator('.slide-in-right').getByRole('button', { name: '关闭' }).focus();
    await page.keyboard.press('Enter');
    await eventually(async () => expect((await panelN()) === 0, '「关闭」应关掉面板'));
    await page.waitForTimeout(200);
    const back2 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    await S.check(() => expect(back2 === 'toggle-screens', `④ 快捷键打开的面板关掉后焦点应落到工具栏「屏列表」：${back2}`));
    // 5 删屏确认与断链补屏：只有一层遮罩
    await card('/s3').click();
    await page.keyboard.press('Delete');
    await page.getByTestId('delete-dialog').waitFor({ timeout: 3000 });
    const delLayers = await backdropLayers();
    await S.check(() => expect(delLayers === 1, `⑤ 删屏确认应只有一层遮罩：${delLayers} 层`));
    await page.getByTestId('delete-dialog').getByRole('button', { name: '取消' }).click();
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .warn').first().click();
    await page.getByTestId('missing-dialog').waitFor({ timeout: 3000 });
    const missLayers = await backdropLayers();
    await S.check(() => expect(missLayers === 1, `⑤ 断链补屏应只有一层遮罩：${missLayers} 层`));
    await page.keyboard.press('Escape');
    await page.getByTestId('missing-dialog').waitFor({ state: 'detached', timeout: 3000 });
    // 6 切换器行内改名：输入到一半指针移过别的行，焦点不被抢；Enter 存的是完整新名、页面不跳
    await page.getByTestId('project-switcher').click();
    const row = page.locator(`[data-testid="project-option"][data-project-id="${projectId}"]`);
    await row.waitFor({ timeout: 8000 });
    await row.hover();
    await page.waitForTimeout(200);
    await row.getByTestId('rename-project').click();
    const ri = page.getByTestId('rename-input');
    await ri.waitFor({ timeout: 5000 });
    await ri.fill('Panels');
    await page.keyboard.type('AB');
    const ob = (await page.locator(`[data-testid="project-option"][data-project-id="${other.projectId}"]`).boundingBox())!;
    await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 4 });
    await page.waitForTimeout(150);
    await page.keyboard.type('CD');
    const act = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    await S.check(() => expect(act === 'rename-input', `⑥ 指针移过别的行后焦点应还在改名框：${act}`));
    const url0 = page.url();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await S.check(() => expect(page.url() === url0, `⑥ Enter 不该切项目：${page.url()}`));
    await S.check(async () => expect((await projName()) === 'PanelsABCD', `⑥ 应存下完整新名：${await projName()}`));
    await page.keyboard.press('Escape');
    await shot(page, 'CORE-047');
  } catch (e) { S.fail(e); }
  S.done();
  return '?panel=revisions 无单选即去掉、不再自己弹；⌘K 14 行全列、↓ 到底；提示在面板之上；关面板焦点回工具栏；删屏 / 补屏各一层遮罩；改名时指针移过别的行不抢焦点、Enter 存完整新名';
});

// TC-CORE-048 表单错误态：通道弹层即时重验 / 焦点落首错 / 遮罩不丢已填内容 / 本机订阅不校验端点 / 未配主密钥；新建项目的错误关联（v0.78）
await step('TC-CORE-048', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Forms', '--device', 'mobile', '--screens', '1', '--no-shot');
  const S = softly();
  // 通道的写请求一律在浏览器里截下、记请求体、回 400：这条用例只看表单行为，不建通道、不去验证
  const CH_RE = /\/v1\/channels$/;
  const CFG_RE = /\/v1\/config$/;
  const posted: Record<string, unknown>[] = [];
  await page.route(CH_RE, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(JSON.parse(route.request().postData() || '{}') as Record<string, unknown>);
    await route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ type: '/errors/validation', title: '用例拦截，不落库', status: 400 }) });
  });
  const dlg = page.getByTestId('channel-dialog');
  const openManager = async () => {
    await page.goto(`${WEB}/p/${projectId}?settings=runners`);
    await page.getByTestId('channel-manager').waitFor({ timeout: 15000 });
    await page.getByTestId('add-channel').waitFor();
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openManager();
    // 1 空提交：3 条错误、焦点落第一个出错字段；显示名改对即清它那一条，其余不动
    await page.getByTestId('add-channel').click();
    await dlg.waitFor({ timeout: 3000 });
    await page.getByTestId('ch-save').click();
    await eventually(async () => expect((await dlg.locator('[role="alert"]').count()) === 3, `空提交应有 3 条错误：${await dlg.locator('[role="alert"]').count()}`));
    const firstErr = await page.evaluate(() => document.activeElement?.id);
    await S.check(() => expect(firstErr === 'ch-label', `① 提交失败焦点应落到第一个出错字段：${firstErr}`));
    await dlg.locator('#ch-label').fill('x');
    await S.check(async () => expect((await page.locator('#ch-label-error').count()) === 0 && (await dlg.locator('#ch-label').getAttribute('aria-invalid')) !== 'true', '① 显示名改对后它的错误应清掉'));
    await S.check(async () => expect((await page.locator('#ch-model-error').count()) === 1, '① 其余字段的错误应还在'));
    // 2 填过内容后点遮罩不关、已填的 Key 还在；Esc 仍能关
    await dlg.locator('#ch-model').fill('m-1');
    await dlg.locator('#ch-key').fill('sk-test-48');
    await page.mouse.click(8, 8);
    await page.waitForTimeout(300);
    await S.check(async () => expect((await dlg.count()) === 1 && (await dlg.locator('#ch-key').inputValue()) === 'sk-test-48', '② 填过内容后点遮罩不应关掉弹层、丢掉 Key'));
    if (await dlg.count()) { await dlg.locator('#ch-key').focus(); await page.keyboard.press('Escape'); }
    await eventually(async () => expect((await dlg.count()) === 0, 'Esc 应关掉弹层'));
    // 3 先在 OpenAI 兼容填不完整端点，再切本机 Claude 订阅：保存照常发出，且不带端点
    await page.getByTestId('add-channel').click();
    await dlg.waitFor({ timeout: 3000 });
    await pickOption(page, '#ch-kind', 'OpenAI 兼容');
    await dlg.locator('#ch-endpoint').fill('api.deepseek.com/v1');
    await pickOption(page, '#ch-kind', '本机 Claude 订阅');
    await dlg.locator('#ch-label').fill('本机 48');
    await dlg.locator('#ch-model').fill('claude-sonnet-5');
    const n0 = posted.length;
    await page.getByTestId('ch-save').click();
    await S.check(() => eventually(async () => expect(posted.length === n0 + 1, '③ 本机订阅的「保存并验证」应发出请求，不被隐藏的端点错误挡住'), 3000));
    await S.check(() => expect(posted.length === n0 + 1 && posted[n0].endpoint === undefined && posted[n0].kind === 'agent-sdk', `③ 本机订阅不应提交端点：${JSON.stringify(posted[n0] ?? null)}`));
    await dlg.locator('#ch-label').focus();
    await page.keyboard.press('Escape');
    await eventually(async () => expect((await dlg.count()) === 0, 'Esc 应关掉弹层'));
    // 4 服务端没配 QUILT_SECRETS_KEY（浏览器里把 /v1/config 的 secretsConfigured 改成 false）：
    //   管理器顶部说明；Anthropic 类型「保存并验证」不可用，切到本机订阅可用
    const cfg = await apiJson<{ secretsConfigured?: unknown }>('/v1/config');
    await S.check(() => expect(typeof cfg.body.secretsConfigured === 'boolean', `④ GET /v1/config 应带 secretsConfigured：${JSON.stringify(cfg.body)}`));
    await page.route(CFG_RE, async (route) => {
      const res = await route.fetch();
      const j = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...j, secretsConfigured: false } });
    });
    await openManager();
    await S.check(async () => expect((await page.getByTestId('secrets-missing').count()) === 1 && (await page.getByTestId('secrets-missing').innerText()).includes('QUILT_SECRETS_KEY'), '④ 未配主密钥时管理器顶部应说明'));
    await page.getByTestId('add-channel').click();
    await dlg.waitFor({ timeout: 3000 });
    const saveOff = () => page.getByTestId('ch-save').evaluate((el) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true');
    await S.check(async () => expect(await saveOff(), '④ 需要 Key 的类型「保存并验证」应不可用'));
    await pickOption(page, '#ch-kind', '本机 Claude 订阅');
    await S.check(async () => expect(!(await saveOff()), '④ 本机订阅不存密钥，「保存并验证」应可用'));
    await dlg.locator('#ch-label').focus();
    await page.keyboard.press('Escape');
    await page.unroute(CFG_RE);
    // 5 新建项目：空名回车报错并关联到输入框，输入即清
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.getByTestId('project-switcher').click();
    await page.getByTestId('new-project').click();
    const np = page.locator('#np-name');
    await np.waitFor({ timeout: 3000 });
    await np.press('Enter');
    await eventually(async () => expect((await page.locator('#np-name-error').count()) === 1, '空名应报错'));
    const aria = await np.evaluate((el) => [el.getAttribute('aria-invalid'), el.getAttribute('aria-describedby')]);
    await S.check(() => expect(aria[0] === 'true' && aria[1] === 'np-name-error', `⑤ 输入框应带 aria-invalid 并关联错误：${JSON.stringify(aria)}`));
    await np.type('P');
    await S.check(async () => expect((await page.locator('#np-name-error').count()) === 0 && (await np.getAttribute('aria-invalid')) !== 'true', '⑤ 输入后错误应清掉'));
    await page.keyboard.press('Escape');
    await shot(page, 'CORE-048');
  } catch (e) { S.fail(e); } finally { await page.unroute(CH_RE); await page.unroute(CFG_RE); }
  S.done();
  return '空提交 3 错、焦点落显示名、改对即清；填过内容点遮罩不关；OpenAI 兼容填过端点再切本机订阅照常提交且不带端点；未配主密钥时顶部说明、Key 类型禁用保存；新建项目错误关联、输入即清';
});

// TC-CORE-049 窄视口与输入框几何：首帧终值宽度、面板开时先截通道名不折行、对话记录与面板同开不挤竖条、折叠横条不被压、排列条不被小地图盖、窄屏不显示手势提示（v0.78）
await step('TC-CORE-049', async () => {
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Narrow', '--device', 'mobile', '--screens', '3', '--no-shot');
  const S = softly();
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const load = async (q = '') => {
    await page.goto(`${WEB}/p/${projectId}${q}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.locator('form.composer').waitFor();
    await page.waitForTimeout(900);
  };
  // 逐帧记输入框的左缘、宽度与通道触发器在不在，从它出现的第一帧起；只在带了标记的那一次加载里记。
  // 写成字符串：tsx 编译出的函数体带 __name 辅助调用，序列化进页面就是未定义
  await page.addInitScript(`(() => {
    if (sessionStorage.getItem('quilt:probe-composer') !== '1') return;
    window.__frames = [];
    const t0 = performance.now();
    const tick = () => {
      const f = document.querySelector('form.composer');
      if (f) { const r = f.getBoundingClientRect(); window.__frames.push([Math.round(performance.now() - t0), Math.round(r.left), Math.round(r.width), document.querySelector('[data-testid="runner-select"]') ? 1 : 0]); }
      if (window.__frames.length < 90 && performance.now() - t0 < 10000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/p/${projectId}`);
    // 前置：先完整打开一次，让通道清单在本机留底（v0.81）——测的是之后每次打开的首帧
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await page.evaluate(() => { localStorage.removeItem('quilt:chat-collapsed'); localStorage.setItem('quilt:minimap', '1'); sessionStorage.setItem('quilt:probe-composer', '1'); });
    // 1 首帧就是终值：从出现起每一帧的宽与左缘都等于最后一帧
    await load();
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => (window as unknown as { __frames: number[][] }).__frames);
    await page.evaluate(() => sessionStorage.removeItem('quilt:probe-composer'));
    expect(frames?.length > 0, '没采到输入框的逐帧几何');
    const last = frames.at(-1)!;
    const off = frames.filter((f) => Math.abs(f[1] - last[1]) > 2 || Math.abs(f[2] - last[2]) > 2 || !f[3]);
    await S.check(() => expect(frames.length > 10 && off.length === 0, `① 输入框应首帧即终值、通道触发器从第一帧起就在（${frames.length} 帧，终值 左 ${last[1]} 宽 ${last[2]}）：偏离的帧 [毫秒, 左, 宽, 触发器] ${JSON.stringify(off.slice(0, 4))}`));
    // 2 1440 下开设计系统面板：先截通道名，工具条不折行、高度不变、不压面板
    const c0 = await box('form.composer');
    const trig0 = (await box('[data-testid="runner-select"]')).width;
    await page.keyboard.press('Alt+d');
    await eventually(async () => expect(page.url().includes('panel=design'), '⌥D 应打开设计系统面板'));
    await page.waitForTimeout(600);
    const c1 = await box('form.composer'); const p1 = await box('.slide-in-right');
    const bar1 = await page.locator('form.composer').getAttribute('data-bar');
    const trig1 = (await box('[data-testid="runner-select"]')).width;
    await S.check(() => expect(bar1 !== 'wrap' && Math.abs(c1.height - c0.height) <= 1, `② 面板打开后工具条不应折行：data-bar=${bar1} 高 ${c0.height} → ${c1.height}（宽 ${c0.width} → ${c1.width}，通道 ${trig0} → ${trig1}）`));
    await S.check(() => expect(c1.x + c1.width <= p1.x + 1, `② 输入框不应压住面板：右缘 ${c1.x + c1.width} 面板左缘 ${p1.x}`));
    await page.keyboard.press('Alt+d');
    // 3 对话记录展开 + 右侧面板：1024×700、800×600 下输入框不被挤成竖条、不出视口、不压顶栏 / 对话记录 / 面板
    for (const [w, h] of [[1024, 700], [800, 600]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await load('?panel=screens');
      const c = await box('form.composer'); const d = await box('[data-testid="chat-dock"]'); const p = await box('.slide-in-right');
      await S.check(() => expect(c.width >= 280 && c.y >= 56 && c.y + c.height <= h + 1 && c.x >= 0 && c.x + c.width <= w + 1, `③ ${w}×${h} 输入框几何不对：${JSON.stringify(c)}`));
      await S.check(() => expect(overlapArea(c, d) === 0 && overlapArea(c, p) === 0, `③ ${w}×${h} 输入框与对话记录 / 面板重叠：${overlapArea(c, d)} / ${overlapArea(c, p)} px²`));
    }
    // 4 对话记录折叠：1280×800、1024×700 下横条不被输入框压住，展开箭头点得到
    await page.evaluate(() => localStorage.setItem('quilt:chat-collapsed', '1'));
    for (const [w, h] of [[1280, 800], [1024, 700]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await load();
      const c = await box('form.composer'); const d = await box('[data-testid="chat-dock"]');
      const bb = (await page.getByRole('button', { name: /^展开对话记录/ }).boundingBox())!;
      const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="chat-dock"]'), [bb.x + bb.width - 16, bb.y + bb.height / 2]);
      await S.check(() => expect(overlapArea(c, d) === 0 && hit, `④ ${w}×${h} 折叠横条被输入框压住：重叠 ${overlapArea(c, d)} px²，展开箭头可点 ${hit}`));
    }
    await page.evaluate(() => localStorage.removeItem('quilt:chat-collapsed'));
    // 5 1024×700、屏列表开着、小地图开着，多选两屏：排列条的屏数与「左对齐」不被小地图盖住
    await page.setViewportSize({ width: 1024, height: 700 });
    await load('?panel=screens');
    await page.getByRole('button', { name: '适配视图' }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.locator('[data-testid="screen-card"][data-route="/s2"] .gesture').click({ modifiers: ['Shift'] });
    await page.getByTestId('arrange-bar').waitFor({ timeout: 3000 });
    const barHit = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="arrange-bar"]')!;
      return [bar.querySelector('span')!, bar.querySelector('[data-testid="arrange-left"]')!].map((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && bar.contains(top); });
    });
    await S.check(() => expect(barHit.every(Boolean), `⑤ 排列条的屏数 / 左对齐被盖住：${JSON.stringify(barHit)}`));
    // 6 390×844：对话记录底部不显示鼠标手势提示
    await page.setViewportSize({ width: 390, height: 844 });
    await load();
    const hint = page.getByText('滚轮/触控板平移', { exact: false });
    await S.check(async () => expect((await hint.count()) === 0 || !(await hint.first().isVisible()), '⑥ 390 px 下不该显示鼠标手势提示'));
    await shot(page, 'CORE-049');
  } catch (e) { S.fail(e); } finally { await page.setViewportSize({ width: 1440, height: 1000 }); }
  S.done();
  return '首帧即终值宽度；面板开时截通道名不折行；1024 / 800 下对话记录与面板同开输入框不挤不压；折叠横条不被压、箭头可点；排列条不被小地图盖；390 px 不显示手势提示';
});

// v0.79 作业与 worker 健壮性（DESIGN §11 / §16 / §17）共用的小工具：读一条 SSE 流（不经浏览器）；探针图——屏里一张指向本机探针的图，
// 探针回 404 时 onerror 挂上一个不停清空 Tailwind 样式的定时器，截图的就绪判定等不到样式、这次拍摄失败；探针回 PNG 就一切正常
const sleep079 = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readSse = async (url: string) => {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  expect(res.ok && res.body, `打不开事件流 ${url}：${res.status}`);
  const reader = res.body!.getReader();
  const s = { text: '', done: false, close: () => reader.cancel().catch(() => {}) };
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { s.done = true; return; } s.text += new TextDecoder().decode(value); } })().catch(() => { s.done = true; });
  return s;
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const startProbe = async (port: number, ok: (hit: number) => boolean) => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; if (!ok(hits)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_1PX); });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return { hits: () => hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
};
const probeScreen = (port: number, title: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">${title}</h1><img src="http://127.0.0.1:${port}/probe.png" width="8" height="8" alt="" onerror="setInterval(function(){document.querySelectorAll('style').forEach(function(s){if(s.textContent.indexOf('--tw-')>=0)s.textContent=''})},10)"></div>`;
const bodyOf = async (screenId: string) => {
  const rev = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screenId}/revisions`)).body.items[0];
  return (await (await fetch(rev.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
};

// v0.79 服务端通知通道断线自愈（§16 一致性承诺、API-CORE-030）：从数据库那边掐掉 API 的 LISTEN 连接，项目流先收到 reconnected，
// 之后的写入照常推到，作业流不靠 15 s 一次的心跳补读也能推进。要本机 docker 里的 quilt-pg（§3）
await step('TC-CORE-065', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const dbName = ((await (await fetch(`${API}/v1/health`)).json()) as { database: string }).database;
  const psql = (q: string) => execFileSync('docker', ['exec', 'quilt-pg', 'psql', '-U', 'quilt', '-d', dbName, '-Atc', q], { encoding: 'utf8' }).trim();
  try { psql('select 1'); } catch (e) { throw new Error(`环境：连不上 docker 里的 quilt-pg，掐不了 LISTEN 连接（${(e as Error).message.split('\n')[0]}）`); }
  const LISTENING = `from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query ilike 'listen %'`;
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Listen', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  const edit = async (content: string) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, targetScreenIds: [s1], runner: STUB }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    return r.body.job.id;
  };
  // 前置：两条频道都在 API 的 LISTEN 表里——开项目流，并完整读一条作业流
  const proj = await readSse(`${API}/v1/projects/${pid}/events`);
  const warm = await edit('warm up');
  const warmStream = await readSse(`${API}/v1/jobs/${warm}/events`);
  await eventually(() => expect(warmStream.done, 'warm'), 60_000);
  await eventually(() => expect(Number(psql(`select count(*) ${LISTENING}`)) >= 1, 'listener'), 5000);
  // 1 掐掉 LISTEN 连接 → 10 s 内项目流收到 reconnected，LISTEN 连接重建
  const killed = Number(psql(`select count(*) from (select pg_terminate_backend(pid) ${LISTENING}) t`));
  expect(killed >= 1, `没有掐到 LISTEN 连接（${killed}）`);
  await eventually(() => expect(proj.text.includes('"reason":"reconnected"'), 'reconnected'), 10_000)
    .catch(() => check(false, `掐掉 LISTEN 连接后 10 s 项目流没有收到 reconnected（流里最后：${JSON.stringify(proj.text.slice(-120))}）`));
  check(Number(psql(`select count(*) ${LISTENING}`)) >= 1, 'LISTEN 连接没有重建');
  // 2 之后的写入照常推到：MCP 建一屏，5 s 内项目流里有它
  const mcp = await connectMcp();
  try {
    const made = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'After', route: '/after', html: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">After</h1></div>' })).json as { screenId: string };
    await eventually(() => expect(proj.text.includes(made.screenId), 'screen'), 5000).catch(() => check(false, '重连后 MCP 建屏，项目流 5 s 内没有它的 screen_changed'));
  } finally { await mcp.close(); }
  // 3 作业流：模型拖 3 s 的改屏，开流后 8 s 内收到 screen_html_ready（断了没重连时要等 15 s 一次的心跳才补读）
  const held = await edit('[stub-hold:3000] after reconnect');
  const t0 = Date.now();
  const js = await readSse(`${API}/v1/jobs/${held}/events`);
  await eventually(() => expect(js.text.includes('event: screen_html_ready'), 'html'), 8000)
    .catch(() => check(false, `重连后作业流 8 s 内没有收到 screen_html_ready（流里：${JSON.stringify(js.text.slice(-120))}）`));
  const htmlAt = Math.round((Date.now() - t0) / 100) / 10;
  proj.close(); js.close(); warmStream.close();
  await waitJob(held, 60);
  if (bad.length) { console.log(`   TC-CORE-065 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return `掐掉 ${killed} 条 LISTEN 连接后项目流收到 reconnected、连接重建；MCP 建屏 5 s 内推到；开作业流后 ${htmlAt} s 收到 screen_html_ready（桩拖 3 s）`;
});

// v0.79 截图：lucide 不认识的图标名不挡截图；作业里行内拍失败的截图入队重试、数秒内补上并推 screen_changed{screenshot:true}
await step('TC-CORE-066', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Shots', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  const shotOf = async (sid: string, rev: string) => (await apiJson<{ items: { id: string; screenshotUrl: string | null }[] }>(`/v1/screens/${sid}/revisions`)).body.items.find((x) => x.id === rev)?.screenshotUrl ?? null;
  // 1 同一张屏，只差第二个图标名：bell（lucide 认识）与 home-heart-sparkle（不认识）
  const icons = (name: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Icons</h1><i data-lucide="home" class="w-5 h-5"></i><i data-lucide="${name}" class="w-5 h-5"></i></div>`;
  const mcp = await connectMcp();
  let good: { screenId: string; revisionId: string }; let odd: { screenId: string; revisionId: string };
  try {
    good = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'IconGood', route: '/icon-good', html: icons('bell') })).json as typeof good;
    odd = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'IconOdd', route: '/icon-odd', html: icons('home-heart-sparkle') })).json as typeof odd;
  } finally { await mcp.close(); }
  await eventually(async () => expect(await shotOf(good.screenId, good.revisionId), 'good'), 40_000).catch(() => check(false, '图标都认识的屏 40 s 内截图没就绪（环境？）'));
  await eventually(async () => expect(await shotOf(odd.screenId, odd.revisionId), 'odd'), 40_000).catch(() => check(false, '带一个 lucide 不认识的图标名：40 s 内截图仍未就绪'));
  // 2 作业里的截图：OpenAI 兼容桩回一张带探针图的屏，探针第一次回 404（这次截图失败），之后回 PNG
  const probe = await startProbe(3989, (n) => n > 1);
  const stub = startOpenAiStub({ port: 3992, apiKey: 'good-key-0066', reply: probeScreen(3989, 'Retry shot') });
  let cid = '';
  const proj = await readSse(`${API}/v1/projects/${pid}/events`);
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 截图', endpoint: stub.url, model: 'stub-66', apiKey: 'good-key-0066' }) })).body.channel.id;
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'retry the shot', targetScreenIds: [s1], runner: { kind: 'channel', channelId: cid } }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    const job = await waitJob(r.body.job.id, 90);
    expect(job.status === 'succeeded', `改屏作业 ${job.status}`);
    const rev = (job.output as { revisionIds: string[] }).revisionIds[0];
    const t0 = Date.now();
    await eventually(async () => expect(await shotOf(s1, rev), 'shot'), 30_000)
      .catch(async () => check(false, `作业结束 30 s 后这版仍没有截图（探针被请求 ${probe.hits()} 次：第 1 次是作业里那次失败的拍摄，之后没有重试）`));
    await eventually(() => expect(proj.text.includes(rev) && /"screenshot":true/.test(proj.text), 'event'), 5000)
      .catch(() => check(false, '截图补上后项目流没有推 screen_changed{screenshot:true}'));
    check(probe.hits() >= 2, `探针只被请求 ${probe.hits()} 次，没有发生「失败 → 重试」`);
    if (!bad.length) return `未知图标名的屏照常出截图；作业里第一次拍摄失败，${Math.round((Date.now() - t0) / 1000)} s 内重试补上并推了 screenshot 事件（探针 ${probe.hits()} 次）`;
  } finally {
    proj.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' });
    await stub.close(); await probe.close();
  }
  console.log(`   TC-CORE-066 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；'));
});

// v0.79 候选批有一版失败（REQ-CORE-015 / §11 running→failed）：已落的候选接管 current、带候选角标，回执按屏计数
await step('TC-CORE-067', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Partial', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  type Scr = { id: string; currentRevisionId: string; pendingCandidates: { jobId: string; count: number } | null };
  const scr = async () => (await apiJson<{ screens: Scr[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === s1)!;
  const rev0 = (await scr()).currentRevisionId;
  // 三版并行，第 2 次调用回 400（不可重试）
  const stub = startOpenAiStub({ port: 3991, apiKey: 'good-key-0067', reply: (await bodyOf(s1)).replace('Screen 1', 'Partial'), fail: (_hit, n) => (n === 2 ? 400 : null) });
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 部分失败', endpoint: stub.url, model: 'stub-67', apiKey: 'good-key-0067' }) })).body.channel.id;
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'three versions', targetScreenIds: [s1], versions: 3, runner: { kind: 'channel', channelId: cid } }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    const job = await waitJob(r.body.job.id, 90);
    const out = job.output as { errorClass?: string; revisionIds: string[] };
    expect(job.status === 'failed' && out.errorClass === 'provider' && out.revisionIds.length === 2, `作业应 failed(provider) 且落了 2 版：${job.status} ${JSON.stringify(out).slice(0, 200)}`);
    const now = await scr();
    const cands = (await apiJson<{ screens: { revisions: { id: string; index: number }[] }[] }>(`/v1/jobs/${r.body.job.id}/candidates`)).body.screens[0]?.revisions ?? [];
    const first = [...cands].sort((a, b) => a.index - b.index)[0]?.id;
    expect(now.currentRevisionId !== rev0 && now.currentRevisionId === first, `已落的候选没有接管 current（current ${now.currentRevisionId === rev0 ? '仍是原版' : now.currentRevisionId}，第 1 版 ${first}）`);
    expect(now.pendingCandidates?.jobId === r.body.job.id && now.pendingCandidates.count === 2, `卡片应带「2 版」候选角标：${JSON.stringify(now.pendingCandidates)}`);
    const msg = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${pid}/messages`)).body.items.find((m) => m.role === 'assistant' && m.jobId === r.body.job.id);
    expect(msg?.content.includes('已保留 1 屏'), `回执应按屏计数「已保留 1 屏」：${msg?.content}`);
    return `第 2 次调用 400 → failed(provider)；另 2 版落库，current 指向第 ${cands.find((c) => c.id === first)?.index ?? '?'} 版、角标 2 版；回执「已保留 1 屏」`;
  } finally {
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' });
    await stub.close();
  }
});

// v0.79 进程重启的收口（§16 进程启动、§17 job.claim / screenshot.retry）：造屏跑到一半进程被杀、停在 queued 的本机 agent 作业、补扫补上的截图。
// 要能重启被测 API：QUILT_E2E_RESTART 是一条命令，须以 SIGKILL 结束旧进程（模拟崩溃，finally 不执行）、再起新进程并等到就绪（§3）
await step('TC-CORE-068', async () => {
  const RESTART = process.env.QUILT_E2E_RESTART;
  expect(RESTART, '环境：未设 QUILT_E2E_RESTART（重启被测 API 的命令，§3）');
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Restart', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [s1, s2] = screens.map((s) => s.id);
  type Scr = { id: string; name: string; currentRevisionId: string | null; pendingCandidates: { count: number } | null };
  const scrs = async () => (await apiJson<{ screens: Scr[] }>(`/v1/projects/${pid}`)).body.screens;
  const sendEdit = (sid: string) => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'after restart', targetScreenIds: [sid], runner: STUB }) });
  // 1 一张截图一直拍不成的屏（探针回 404），放过 30 s——重启后的首轮补扫才会扫到它
  let probeOk = false;
  const probe = await startProbe(3988, () => probeOk);
  const mcp = await connectMcp();
  const probed = await (async () => { try { return (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Probe', route: '/probe', html: probeScreen(3988, 'Probe') })).json as { screenId: string; revisionId: string }; } finally { await mcp.close(); } })();
  const probedAt = Date.now();
  // 2 造屏：规划 Cart / Checkout 两屏 × 2 版；Cart 两版立即回，Checkout 拖 120 s
  const body0 = await bodyOf(s1);
  const PLAN = JSON.stringify({ entryFrom: null, screens: [
    { name: 'Cart', route: '/cart', purpose: 'items to buy', links: ['/s1'], sections: ['items'] },
    { name: 'Checkout', route: '/checkout', purpose: 'pay', links: ['/cart'], sections: ['pay'] },
  ] });
  const stub = startOpenAiStub({ port: 3990, apiKey: 'good-key-0068', reply: (hit) => (hit.user.includes('\nRequest:') ? PLAN : body0.replace('Screen 1', hit.user.includes('screen "Checkout"') ? 'Checkout' : 'Cart')), holdMs: (hit) => (hit.user.includes('screen "Checkout"') ? 120_000 : 0) });
  let cid = '';
  let proj: Awaited<ReturnType<typeof readSse>> | null = null;
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 重启', endpoint: stub.url, model: 'stub-68', apiKey: 'good-key-0068' }) })).body.channel.id;
    const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'cart and checkout', count: 2, versions: 2, runner: { kind: 'channel', channelId: cid } }) });
    expect(g.status === 202, `造屏 ${g.status}`);
    let cart: Scr | undefined;
    await eventually(async () => {
      cart = (await scrs()).find((s) => s.name === 'Cart');
      expect(cart && (await apiJson<{ items: unknown[] }>(`/v1/screens/${cart.id}/revisions`)).body.items.length === 2, 'cart');
    }, 60_000).catch(() => { throw new Error('60 s 内 Cart 的两版没有落库'); });
    const checkout = (await scrs()).find((s) => s.name === 'Checkout');
    expect(checkout && !checkout.currentRevisionId, 'Checkout 应已规划、还没出屏');
    // 3 一个停在 queued 的本机 agent 作业占着 /s2（会话不存在）
    const agent = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--screen', s2, '--status', 'queued', '--runner', 'agent', '--input', JSON.stringify({ prompt: 'x', screenIds: [s2], versions: 1, runner: { kind: 'agent', tool: 'claude-code', sessionId: '00000000-0000-4000-8000-000000000068' } }));
    const busy = await sendEdit(s2);
    check(busy.status === 409, `重启前 /s2 应被 queued 的 agent 作业占着：${busy.status}`);
    // 4 探针放行，杀掉 API 重启；旧进程一停就抢着开项目流，赶在首轮补扫（启动后 3 s）之前
    await sleep079(Math.max(0, probedAt + 31_000 - Date.now()));
    check(!(await apiJson<{ items: { id: string; screenshotUrl: string | null }[] }>(`/v1/screens/${probed.screenId}/revisions`)).body.items[0]?.screenshotUrl, '前置不成立：探针屏在重启前已有截图');
    probeOk = true;
    const restarting = new Promise<void>((resolve, reject) => { const p = spawn('sh', ['-c', RESTART!], { stdio: 'ignore' }); p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`重启命令退出码 ${code}`)))); });
    await eventually(async () => { const ok = await fetch(`${API}/v1/health`).then(() => true, () => false); expect(!ok, 'still up'); }, 30_000, 50);
    for (let i = 0; i < 1200 && !proj; i++) { proj = await readSse(`${API}/v1/projects/${pid}/events`).catch(() => null); if (!proj) await sleep079(100); }
    await restarting;
    expect(proj, '重启后 120 s 内没连上项目流');
    // 5 造屏作业 failed(system)；Cart 的候选接管 current、带角标；Checkout（一版都没出）删掉；应用地图有 Cart 的连线
    const gj = (await apiJson<{ job: { status: string; output: { errorClass?: string } } }>(`/v1/jobs/${g.body.job.id}`)).body.job;
    check(gj.status === 'failed' && gj.output?.errorClass === 'system', `造屏作业应 failed(system)：${gj.status} ${gj.output?.errorClass}`);
    const after = await scrs();
    const cartNow = after.find((s) => s.name === 'Cart');
    const cands = (await apiJson<{ items: { id: string; candidateIndex: number | null }[] }>(`/v1/screens/${cart!.id}/revisions`)).body.items;
    const first = cands.find((c) => c.candidateIndex === 0)?.id;
    check(cartNow?.currentRevisionId === first && cartNow?.pendingCandidates?.count === 2, `Cart 的候选没有接管 current / 没有角标：current ${cartNow?.currentRevisionId ?? 'null'}，第 1 版 ${first}，角标 ${JSON.stringify(cartNow?.pendingCandidates)}`);
    check(!after.some((s) => s.name === 'Checkout'), 'Checkout 一版都没出，重启后仍留在画布上');
    const map = (await apiJson<{ edges: { fromScreenId: string; toScreenId: string | null }[] }>(`/v1/projects/${pid}/app-map`)).body;
    check(map.edges.some((e) => e.fromScreenId === cart!.id && e.toScreenId === s1), '应用地图没有 Cart → /s1 的连线（重启收尾没有重派生）');
    // 6 agent 作业补投 → 会话不在 → failed(agent)，/s2 的屏锁放开
    await eventually(async () => expect((await apiJson<{ job: { status: string } }>(`/v1/jobs/${agent.jobId}`)).body.job.status === 'failed', 'agent'), 10_000)
      .catch(async () => check(false, `queued 的 agent 作业重启后 10 s 仍是 ${(await apiJson<{ job: { status: string } }>(`/v1/jobs/${agent.jobId}`)).body.job.status}`));
    const free = await sendEdit(s2);
    check(free.status === 202, `重启后 /s2 仍被占着：${free.status} ${free.body.type ?? ''}`);
    if (free.body.job) await waitJob(free.body.job.id, 60);
    // 7 首轮补扫补上探针屏的截图，并推 screen_changed{screenshot:true}
    await eventually(async () => expect((await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${probed.screenId}/revisions`)).body.items[0]?.screenshotUrl, 'shot'), 30_000)
      .catch(() => check(false, '重启后 30 s 补扫没有补上探针屏的截图'));
    await eventually(() => expect(proj!.text.includes(probed.revisionId) && /"screenshot":true/.test(proj!.text), 'event'), 5000)
      .catch(() => check(false, `补扫补上截图后项目流没有 screen_changed{screenshot:true}（流里：${JSON.stringify(proj!.text.slice(-160))}）`));
  } finally {
    proj?.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {});
    await stub.close(); await probe.close();
  }
  if (bad.length) { console.log(`   TC-CORE-068 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '中途被杀的造屏：Cart 两版候选接管 current 并带角标、Checkout 删掉、地图有 Cart 连线；queued 的 agent 作业补投后 failed、屏锁放开；首轮补扫补上截图并推事件';
});

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

await browser.close();
console.log('\n=== RUN-' + RUN + ' ===');
const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {});
console.log(JSON.stringify(counts), '\n', results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
if (consoleErrors.length) console.log('pageerrors:', consoleErrors.slice(0, 5));
