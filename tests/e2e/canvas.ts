import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { launch, seed, seedJson, apiJson, EVIDENCE, WEB, eventually } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';

// docs/TEST.md 画布交互与键盘（v0.80）用例 TC-CORE-057~059 的 AI 执行脚本：Esc 由近及远、卡片标签与选中描边、
// 空格平移、框选与 iframe、交互态组件卡的捏合与滚轮、小地图拖框、⌘A、工具栏几何、卡片键盘可达、iframe 里的 ⌥ 快捷键、减少动态效果。
// 每一步各开一个新页面、各自记结果：修复前的复现轮要看到每条缺陷各自失败，不被前一步挡住。全程不调模型。
const RUN = process.env.RUN ?? '001';
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
let current: Page | null = null;
let ctx: BrowserContext | null = null;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : '❌'} ${tc} ${result} ${note}`); };
const step = async (tc: string, n: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  const name = `${tc} 第 ${n} 步`;
  const file = `run-${RUN}-${tc.toLowerCase()}-${n}`;
  try { const note = await fn(); record(name, '通过', note ?? ''); await current?.screenshot({ path: path.join(EVIDENCE, `${file}.png`) }).catch(() => {}); }
  catch (e) { record(name, '失败', (e as Error).message.split('\n')[0].slice(0, 400)); await current?.screenshot({ path: path.join(EVIDENCE, `${file}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type View = { x: number; y: number; zoom: number };
const seedProject = (name: string, ...args: string[]) => seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', name, ...args);
const addComponent = async (pid: string, name: string, html: string, x: number, y: number) => {
  const c = await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name, html }) });
  expect(c.status === 201, `建组件 ${name} 返回 ${c.status}`);
  await apiJson(`/v1/components/${c.body.component.id}`, { method: 'PATCH', body: JSON.stringify({ x, y }) });
  return c.body.component.id;
};
// 项目里恰好一个在跑的种子作业（不入队、worker 不碰它）：上一步取消了就再种一个
const ensureJob = async (pid: string, prev: string | null) => {
  if (prev && (await apiJson<{ job: { status: string } }>(`/v1/jobs/${prev}`)).body.job.status === 'running') return prev;
  return seedJson<{ jobId: string }>('seed:job', '--project', pid, '--status', 'running').jobId;
};

seed('seed');
const browser = await launch();
// 每步一个新上下文：view 预置镜头（quilt:view:<pid>），reduced 模拟系统「减少动态效果」
const open = async (pid: string, opts: { view?: View; reduced?: boolean } = {}) => {
  await ctx?.close().catch(() => {});
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript('window.__name = window.__name || ((f) => f);');
  if (opts.view) await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, [`quilt:view:${pid}`, JSON.stringify(opts.view)]);
  const page = await ctx.newPage();
  current = page;
  await page.goto(`${WEB}/p/${pid}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await sleep(400);
  return page;
};
const world = (page: Page) => page.evaluate(() => {
  const m = (document.querySelector('.world') as HTMLElement).style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)!;
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
});
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const panelParam = (page: Page) => new URL(page.url()).searchParams.get('panel');
const card = (page: Page, route: string) => page.locator(`[data-testid="screen-card"][data-route="${route}"]`);
const center = async (page: Page, sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// 颜色一律画进 1×1 canvas 读回字节：计算样式可能是 oklab / lab，alpha 合成也交给浏览器（flow-verification「颜色与对比度」）
const contrastOverWhite = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement;
  const cs = getComputedStyle(el);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const paint = (fill: string, over: [number, number, number]) => { g.clearRect(0, 0, 1, 1); g.fillStyle = `rgb(${over.join(',')})`; g.fillRect(0, 0, 1, 1); g.fillStyle = fill; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]] as [number, number, number]; };
  const bg = paint(cs.backgroundColor, [255, 255, 255]);
  const fg = paint(cs.color, bg);
  const lum = ([r, gg, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return { ratio: (a + 0.05) / (b + 0.05), bg, fg, text: el.innerText };
}, sel);

// ---------- 前置 ----------
const esc = seedProject('EscChain', '--device', 'mobile', '--screens', '3', '--no-shot');
const escPid = esc.projectId;
await addComponent(escPid, 'Bar', '<nav class="h-16 flex items-center justify-around bg-surface border-t border-outline-variant"><span>A</span><span>B</span></nav>', 0, 1000);
let escJob: string | null = null;
const cancels: string[] = [];
const openEsc = async () => {
  escJob = await ensureJob(escPid, escJob);
  cancels.length = 0;
  const page = await open(escPid);
  page.on('request', (r) => { if (r.method() === 'POST' && /\/v1\/jobs\/[^/]+\/cancel$/.test(new URL(r.url()).pathname)) cancels.push(r.url()); });
  await page.locator(`[data-testid="running-job"][data-job-id="${escJob}"]`).waitFor({ timeout: 10000 });
  await blur(page);
  return page;
};

// ---------- TC-CORE-057 Esc 由近及远（canvas-1 / panels-1 / panels-5 / cross-15 / canvas-10） ----------
await step('TC-CORE-057', '1', async () => {
  const page = await openEsc();
  for (const [key, name] of [['Alt+s', 'screens'], ['Alt+t', 'agent'], ['Alt+d', 'design']] as const) {
    await blur(page);
    await page.keyboard.press(key);
    // 等面板真的画出来再按：URL 先于这一轮渲染更新，键位表在渲染时才换成新状态
    await eventually(async () => expect(panelParam(page) === name && (await page.locator('.canvas-shell').getAttribute('data-panel')) === 'open', `${key} 没开出 ${name} 面板`));
    await page.keyboard.press('Escape');
    await sleep(500);
    expect(cancels.length === 0, `${name} 面板开着时按 Esc 取消了在跑作业（${cancels.length} 次）`);
    expect(panelParam(page) === null && (await page.locator('.canvas-shell').getAttribute('data-panel')) === 'closed', `${name} 面板开着时按 Esc 面板没关（panel=${panelParam(page)}）`);
  }
  return '屏列表 / 本机 agent / 设计系统三块面板各按一次 Esc 即关，作业未被取消';
});

await step('TC-CORE-057', '2', async () => {
  const page = await openEsc();
  await page.keyboard.press('Alt+d');
  const md = page.locator('#ds-md');
  await md.waitFor({ timeout: 5000 });
  await md.click();
  await page.keyboard.type('草稿 42');
  await page.keyboard.press('Escape');
  await sleep(500);
  expect(cancels.length === 0, `面板文本框里按 Esc 取消了在跑作业（${cancels.length} 次）`);
  expect(!(await md.evaluate((el) => el === document.activeElement)), '文本框里按 Esc 没失焦');
  expect(panelParam(page) === 'design' && (await md.inputValue()).includes('草稿 42'), '文本框里按 Esc 关掉了面板或丢了草稿');
  await page.keyboard.press('Escape');
  await sleep(500);
  expect(panelParam(page) === null && cancels.length === 0, `第二下 Esc 应关面板且不取消作业（panel=${panelParam(page)}，取消 ${cancels.length} 次）`);
  return '第一下只失焦、草稿与面板都在；第二下关面板；作业一直在跑';
});

await step('TC-CORE-057', '3', async () => {
  const page = await openEsc();
  const hint = page.getByTestId('armed-hint');
  await page.keyboard.press('ControlOrMeta+e');
  await eventually(async () => expect(panelParam(page) === 'inspect' && (await hint.count()) === 1, '⌘E 没进待命态'));
  await page.keyboard.press('Escape');
  await sleep(500);
  expect(cancels.length === 0, `待命态按 Esc 取消了在跑作业（${cancels.length} 次）`);
  expect(panelParam(page) === null && (await hint.count()) === 0, '待命态按 Esc 没退出模式');
  // 模式开着、聚焦了一屏：第一下退出聚焦、模式留着；第二下才退出模式
  await page.keyboard.press('ControlOrMeta+e');
  // 等待命提示画出来再点：URL 先于这一轮渲染更新，卡片的按下处理在渲染时才知道模式开了
  await eventually(async () => expect(panelParam(page) === 'inspect' && (await hint.count()) === 1, '⌘E 没进待命态'));
  const c = await center(page, '[data-testid="screen-card"][data-route="/s1"]');
  await page.mouse.click(c.x, c.y);
  await eventually(async () => expect((await page.locator('.card.focused').count()) === 1, '待命态点一屏没进去'));
  await blur(page);
  await page.keyboard.press('Escape');
  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, '第一下 Esc 没退出聚焦'));
  expect(panelParam(page) === 'inspect', '退出聚焦时模式也被关了');
  await page.keyboard.press('Escape');
  await sleep(500);
  expect(panelParam(page) === null && cancels.length === 0, `第二下 Esc 应退出模式且不取消作业（panel=${panelParam(page)}，取消 ${cancels.length} 次）`);
  return '待命态 Esc 退出模式；聚焦时先退聚焦、再退模式；作业一直在跑';
});

await step('TC-CORE-057', '4', async () => {
  const page = await openEsc();
  const c = await center(page, '[data-testid="screen-card"][data-route="/s2"]');
  await page.mouse.click(c.x, c.y);
  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1 && (await page.getByTestId('target-chip').count()) === 1, '单击没选中一屏'));
  await page.keyboard.press('Escape');
  await sleep(500);
  expect(cancels.length === 0, `有选中时按 Esc 取消了在跑作业（${cancels.length} 次）`);
  expect((await page.locator('[data-testid="screen-card"].selected').count()) === 0, 'Esc 没清空画布选中');
  expect((await page.getByTestId('target-chip').count()) === 1, 'Esc 连目标标签一起清了');
  await page.keyboard.press('Escape');
  await eventually(async () => expect(cancels.length === 1 && (await apiJson<{ job: { status: string } }>(`/v1/jobs/${escJob}`)).body.job.status === 'cancelled', `什么都没开时 Esc 应取消最新作业（取消请求 ${cancels.length} 次）`), 8000);
  return '第一下清选中（目标标签留着），第二下才取消作业';
});

await step('TC-CORE-057', '5', async () => {
  const page = await openEsc();
  const comp = page.locator('[data-testid="component-card"][data-name="Bar"]');
  await comp.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  await blur(page);
  await page.keyboard.press('Alt+n');
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 0, '组件交互态下按 ⌥N，组件没退出交互态'));
  expect(panelParam(page) === 'annotate', `⌥N 后应开批注模式（panel=${panelParam(page)}）`);
  expect((await page.getByTestId('armed-hint').innerText()).includes('批注模式'), '待命提示不是批注模式');
  await eventually(async () => expect((await page.locator('[aria-live="polite"]').filter({ hasText: '共享组件不能批注' }).count()) === 1, '没说明组件不能批注'));
  await page.keyboard.press('Escape');
  await sleep(400);
  expect(panelParam(page) === null && cancels.length === 0, 'Esc 应退出批注模式、不取消作业');
  return '组件交互态 ⌥N：退出组件交互态、开批注模式并 toast 说明';
});

// ---------- TC-CORE-058 卡片标签、选中描边、指针与小地图（load-10 / canvas-2 / 3 / 7 / 8 / 9 / 14 / 15 / 17） ----------
const ptr = seedProject('Pointer', '--device', 'mobile', '--screens', '4', '--no-shot');
const ptrPid = ptr.projectId;
await addComponent(ptrPid, 'Header Bar', '<header class="h-14 flex items-center px-4 bg-surface border-b border-outline-variant"><span class="font-semibold">Header</span></header>', 0, 1000);
await addComponent(ptrPid, 'Tab Bar', '<nav class="h-16 grid grid-cols-3 bg-surface border-t border-outline-variant"><span class="grid place-items-center">A</span><span class="grid place-items-center">B</span><span class="grid place-items-center">C</span></nav>', 470, 1000);

await step('TC-CORE-058', '1', async () => {
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 1 } });
  await page.locator('[data-testid="component-card"][data-ready]').first().waitFor({ timeout: 20000 }).catch(() => {});
  const probe = (sel: string) => page.evaluate((s) => {
    const label = document.querySelector(`${s} .label`) as HTMLElement;
    const r = label.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
    return { text: label.innerText, hit: !!hit && label.contains(hit), rect: [r.left, r.top, r.width, r.height].map(Math.round), card: Math.round(label.parentElement!.getBoundingClientRect().top) };
  }, sel);
  const s = await probe('[data-testid="screen-card"][data-route="/s1"]');
  expect(s.hit, `屏卡标签「${s.text}」画不出来：标签 ${s.rect.join(',')}，卡顶 ${s.card}，该点命中的不是标签`);
  const page2 = await open(ptrPid, { view: { x: 400, y: -760, zoom: 1 } });
  await page2.locator('[data-testid="component-card"][data-ready]').first().waitFor({ timeout: 20000 }).catch(() => {});
  const c = await page2.evaluate((s) => {
    const label = document.querySelector(`${s} .label`) as HTMLElement;
    const r = label.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
    return { text: label.innerText, hit: !!hit && label.contains(hit), rect: [r.left, r.top, r.width, r.height].map(Math.round), card: Math.round(label.parentElement!.getBoundingClientRect().top) };
  }, '[data-testid="component-card"][data-name="Header Bar"]');
  expect(c.hit, `组件卡标签「${c.text}」画不出来：标签 ${c.rect.join(',')}，卡顶 ${c.card}`);
  expect(c.text.includes('用于 0 屏'), `组件卡标签文字不对：${c.text}`);
  return `屏卡「${s.text}」与组件卡「${c.text}」的标签都在画面上（elementFromPoint 命中标签）`;
});

await step('TC-CORE-058', '2', async () => {
  const page = await open(ptrPid, { view: { x: 200, y: 60, zoom: 0.6 } });
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH') patches.push(r.url()); });
  const before = { world: await world(page), card: await card(page, '/s2').evaluate((el) => (el as HTMLElement).style.transform) };
  const c = await center(page, '[data-testid="screen-card"][data-route="/s2"]');
  await blur(page);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + 10 * i, c.y + 6 * i);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await sleep(600);
  const after = { world: await world(page), card: await card(page, '/s2').evaluate((el) => (el as HTMLElement).style.transform) };
  expect(after.card === before.card, `空格拖拽从卡片起手把卡片拖走了：${before.card} → ${after.card}`);
  expect(patches.length === 0, `空格拖拽写了库：${patches.join(' ')}`);
  expect(Math.abs(after.world.x - before.world.x - 100) <= 3 && Math.abs(after.world.y - before.world.y - 60) <= 3, `空格拖拽没平移画布：${JSON.stringify(before.world)} → ${JSON.stringify(after.world)}`);
  return `世界层平移 (${Math.round(after.world.x - before.world.x)}, ${Math.round(after.world.y - before.world.y)})，卡片不动、没有 PATCH`;
});

await step('TC-CORE-058', '3', async () => {
  const page = await open(ptrPid, { view: { x: 600, y: 300, zoom: 0.1 } });
  await page.keyboard.press('ControlOrMeta+a');
  await sleep(600);
  const w = await world(page);
  const widths = await page.locator('[data-testid="screen-card"].selected').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).outlineWidth)));
  expect(widths.length === 4, `⌘A 后应选中 4 屏，实际 ${widths.length}`);
  const px = widths.map((x) => x * w.zoom);
  expect(px.every((v) => v >= 1.5 && v <= 3), `10% 缩放下选中描边的屏幕宽度 ${px.map((v) => v.toFixed(2)).join(' / ')} px（应约 2 px）`);
  return `缩放 ${w.zoom} 下选中描边屏幕宽 ${px[0].toFixed(2)} px`;
});

await step('TC-CORE-058', '4', async () => {
  const page = await open(ptrPid, { view: { x: 420, y: 20, zoom: 0.5 } });
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 3000 });
  const r = await contrastOverWhite(page, '[data-testid="armed-hint"]');
  expect(r.ratio >= 4.5, `待命提示压在白卡上对比度 ${r.ratio.toFixed(2)}:1（字 ${r.fg}，底 ${r.bg}）`);
  expect(r.text.includes('Esc'), `待命提示没写 Esc 退出：${r.text}`);
  return `对比度 ${r.ratio.toFixed(1)}:1，文案「${r.text}」`;
});

await step('TC-CORE-058', '5', async () => {
  const page = await open(ptrPid, { view: { x: 400, y: -780, zoom: 1 } });
  const comp = page.locator('[data-testid="component-card"][data-name="Tab Bar"]');
  await page.locator('[data-testid="component-card"][data-name="Tab Bar"][data-ready]').waitFor({ timeout: 20000 });
  await comp.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  const f = (await comp.boundingBox())!;
  const start = { x: f.x - 150, y: f.y + f.height + 200 };
  const target = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(start.x + ((target.x - start.x) * i) / 20, start.y + ((target.y - start.y) * i) / 20);
  await sleep(200);
  const m = await page.getByTestId('marquee').boundingBox();
  const want = [Math.min(start.x, target.x), Math.min(start.y, target.y), Math.max(start.x, target.x), Math.max(start.y, target.y)];
  const got = m ? [m.x, m.y, m.x + m.width, m.y + m.height] : null;
  expect(!!got && got.every((v, i) => Math.abs(v - want[i]) <= 4), `拖进组件 iframe 后选框没跟手：选框 ${got ? got.map(Math.round).join(',') : '无'}，应为 ${want.map(Math.round).join(',')}`);
  await page.mouse.up();
  await sleep(300);
  expect((await page.getByTestId('marquee').count()) === 0, '在 iframe 上松手后选框残留');
  expect((await page.locator('[data-testid="component-card"][data-name="Tab Bar"].selected').count()) === 1, '选框拖过的组件卡没被选中');
  return '选框拖进交互态组件卡的 iframe 仍跟手，在 iframe 上松手即结算、选中该组件';
});

await step('TC-CORE-058', '6', async () => {
  const page = await open(ptrPid, { view: { x: 400, y: -780, zoom: 1 } });
  const comp = page.locator('[data-testid="component-card"][data-name="Tab Bar"]');
  await page.locator('[data-testid="component-card"][data-name="Tab Bar"][data-ready]').waitFor({ timeout: 20000 });
  await comp.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  const c = await center(page, '[data-testid="component-card"][data-name="Tab Bar"]');
  await page.mouse.move(c.x, c.y);
  const w0 = await world(page);
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -40); await sleep(30); }
  await page.keyboard.up('Control');
  await sleep(500);
  const w1 = await world(page);
  expect(w1.zoom > w0.zoom * 1.05, `交互态组件卡上捏合没缩放画布：${w0.zoom} → ${w1.zoom}`);
  return `捏合缩放 ${w0.zoom.toFixed(3)} → ${w1.zoom.toFixed(3)}`;
});

await step('TC-CORE-058', '7', async () => {
  const page = await open(ptrPid, { view: { x: 400, y: -780, zoom: 1 } });
  const comp = page.locator('[data-testid="component-card"][data-name="Tab Bar"]');
  await page.locator('[data-testid="component-card"][data-name="Tab Bar"][data-ready]').waitFor({ timeout: 20000 });
  await comp.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  const c = await center(page, '[data-testid="component-card"][data-name="Tab Bar"]');
  await page.mouse.move(c.x, c.y);
  const w1 = await world(page);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 60); await sleep(30); }
  await sleep(500);
  const w2 = await world(page);
  expect(w2.y < w1.y - 20, `交互态组件卡上滚轮没平移画布：y ${w1.y} → ${w2.y}`);
  return `滚轮平移 y ${Math.round(w1.y)} → ${Math.round(w2.y)}`;
});

await step('TC-CORE-058', '8', async () => {
  const page = await open(ptrPid, { view: { x: 700, y: 380, zoom: 0.1 } });
  const mm = page.getByTestId('minimap');
  await mm.waitFor({ timeout: 3000 });
  await sleep(300);
  const frame = async () => (await mm.getAttribute('data-view'))!.split(' ').map(Number);
  const box = (await mm.boundingBox())!;
  const [fx, fy, fw, fh] = await frame();
  const g = { x: box.x + fx + fw / 2, y: box.y + fy + fh / 2 };
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  const seen: number[][] = [];
  for (let i = 1; i <= 15; i++) { await page.mouse.move(g.x + 20 * i, g.y + 12 * i); await sleep(20); seen.push(await frame()); }
  await sleep(100);
  const last = await frame();
  await page.mouse.up();
  await sleep(400);
  const after = await frame();
  const out = seen.filter(([x, y, w, h]) => x < -0.5 || y < -0.5 || x + w > 176.5 || y + h > 112.5);
  expect(out.length === 0, `拖动中视口框跑出小地图 ${out.length} 次，如 ${out[0]?.map((n) => n.toFixed(1)).join(' ')}`);
  expect(after.every((v, i) => Math.abs(v - last[i]) <= 0.6), `松手后视口框跳了：${last.map((n) => n.toFixed(1)).join(' ')} → ${after.map((n) => n.toFixed(1)).join(' ')}`);
  return `拖动中框始终在小地图内，松手前后 ${last.map((n) => n.toFixed(1)).join(' ')}`;
});

await step('TC-CORE-058', '9', async () => {
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 0.4 } });
  await blur(page);
  await page.keyboard.press('ControlOrMeta+a');
  await sleep(400);
  const s = await page.locator('[data-testid="screen-card"].selected').count();
  const c = await page.locator('[data-testid="component-card"].selected').count();
  expect(s === 4 && c === 2, `⌘A 应选中 4 屏 + 2 个组件卡，实际 ${s} 屏 + ${c} 个组件`);
  expect((await page.getByTestId('selection-stat').innerText()).includes('4 屏 · 2 个组件'), '顶栏选中计数不对');
  return '⌘A 选中 4 屏 + 2 个组件卡';
});

await step('TC-CORE-058', '10', async () => {
  // 拖卡片拖过交互态组件卡的 iframe（与第 5 步同一类：指针进跨源 iframe 后父页收不到事件）
  const page = await open(ptrPid, { view: { x: 400, y: -780, zoom: 1 } });
  const tab = page.locator('[data-testid="component-card"][data-name="Tab Bar"]');
  const head = page.locator('[data-testid="component-card"][data-name="Header Bar"]');
  await page.locator('[data-testid="component-card"][data-name="Tab Bar"][data-ready]').waitFor({ timeout: 20000 });
  await tab.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  const t = (await tab.boundingBox())!; const h = (await head.boundingBox())!;
  const from = { x: h.x + 40, y: h.y + h.height / 2 };
  const to = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
  await sleep(200);
  const hb = (await head.boundingBox())!;
  await page.mouse.up();
  expect(Math.abs(hb.x - (h.x + to.x - from.x)) <= 4 && Math.abs(hb.y - (h.y + to.y - from.y)) <= 4, `拖卡片拖进组件 iframe 后卡片没跟手：卡片在 ${Math.round(hb.x)},${Math.round(hb.y)}，应在 ${Math.round(h.x + to.x - from.x)},${Math.round(h.y + to.y - from.y)}`);
  await page.keyboard.press('ControlOrMeta+z');
  return '拖卡片拖过交互态组件卡的 iframe 照样跟手（随后 ⌘Z 撤回）';
});

await step('TC-CORE-058', '11', async () => {
  // 拖过视口框、松手后落地一屏（卡片变化）：小地图按含新屏的外接框重算，不沿用拖动时冻结的那个
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 1 } });
  const mm = page.getByTestId('minimap');
  await mm.waitFor({ timeout: 3000 });
  await sleep(300);
  const frame = async (m = mm) => (await m.getAttribute('data-view'))!.split(' ').map(Number);
  const fmt = (f: number[]) => f.map((n) => n.toFixed(1)).join(' ');
  const box = (await mm.boundingBox())!;
  const [fx, fy, fw, fh] = await frame();
  const g = { x: box.x + fx + fw / 2, y: box.y + fy + fh / 2 };
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(g.x + 2 * i, g.y + i);
  await page.mouse.up();
  await sleep(300);
  const cam = await world(page);
  const released = await frame();
  const mcp = await connectMcp();
  const created = await callTool(mcp, 'quilt.create_screen', { projectId: ptrPid, name: 'Landed', route: '/landed', html: '<main class="min-h-dvh bg-background p-6"><h1 class="text-lg font-semibold text-on-background">Landed</h1></main>' });
  await mcp.close();
  expect(!created.isError, `create_screen 出错：${created.text.slice(0, 200)}`);
  const sid = (created.json as { screenId: string }).screenId;
  try {
    await eventually(async () => expect((await mm.getAttribute('data-screens')) === '5', '新屏没落到画布上'), 10000);
    await sleep(300);
    const landed = await frame();
    const fresh = await open(ptrPid, { view: cam });
    const mm2 = fresh.getByTestId('minimap');
    await eventually(async () => expect((await mm2.getAttribute('data-screens')) === '5', '新开页面没有新屏'), 10000);
    await sleep(300);
    const want = await frame(mm2);
    expect(landed.every((v, i) => Math.abs(v - want[i]) <= 0.6), `新屏落地后小地图没重算外接框：松手时 ${fmt(released)}，落地后 ${fmt(landed)}，同一镜头新开页面是 ${fmt(want)}`);
    return `落地后视口框 ${fmt(released)} → ${fmt(landed)}，与同一镜头新开页面一致`;
  } finally { await apiJson(`/v1/screens/${sid}`, { method: 'DELETE' }); }
});

await step('TC-CORE-058', '12', async () => {
  // 框选拖到一半按下空格（视口的 className 随之重写）再拖进 iframe：选框照样跟手
  const page = await open(ptrPid, { view: { x: 400, y: -780, zoom: 1 } });
  const comp = page.locator('[data-testid="component-card"][data-name="Tab Bar"]');
  await page.locator('[data-testid="component-card"][data-name="Tab Bar"][data-ready]').waitFor({ timeout: 20000 });
  await comp.locator('.gesture').dblclick();
  await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
  await blur(page);
  const f = (await comp.boundingBox())!;
  const start = { x: f.x - 150, y: f.y + f.height + 200 };
  const target = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(start.x + ((target.x - start.x) * i) / 20, start.y + ((target.y - start.y) * i) / 20);
    if (i === 10) { await page.keyboard.down('Space'); await sleep(100); }
  }
  await sleep(200);
  const m = await page.getByTestId('marquee').boundingBox();
  await page.mouse.up();
  await page.keyboard.up('Space');
  const want = [Math.min(start.x, target.x), Math.min(start.y, target.y), Math.max(start.x, target.x), Math.max(start.y, target.y)];
  const got = m ? [m.x, m.y, m.x + m.width, m.y + m.height] : null;
  expect(!!got && got.every((v, i) => Math.abs(v - want[i]) <= 4), `中途按空格后拖进 iframe，选框没跟手：选框 ${got ? got.map(Math.round).join(',') : '无'}，应为 ${want.map(Math.round).join(',')}`);
  await sleep(300);
  expect((await page.getByTestId('marquee').count()) === 0, '在 iframe 上松手后选框残留');
  return '框选中途按空格再拖进 iframe，选框仍跟手、松手即结算';
});

// ---------- TC-CORE-059 键盘、工具栏几何、iframe 里的 ⌥ 快捷键、减少动态效果（canvas-6 / 12 / 13、cross-12 / 13 / 17） ----------
const keys = seedProject('Keys', '--device', 'mobile', '--screens', '4', '--no-shot');
const keysPid = keys.projectId;
const activeInfo = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  const cardEl = a?.closest('[data-testid="screen-card"]') as HTMLElement | null;
  return { tag: a?.tagName ?? '', testid: a?.getAttribute('data-testid') ?? '', label: a?.getAttribute('aria-label') ?? '', route: cardEl?.dataset.route ?? null };
});

await step('TC-CORE-059', '1', async () => {
  const page = await open(keysPid, { view: { x: 3000, y: 2400, zoom: 0.5 } });
  await blur(page);
  await page.keyboard.press('Tab');
  const first = await activeInfo(page);
  expect(first.testid === 'project-switcher', `第一个 Tab 停靠点是 ${first.tag} ${first.label || first.testid}，不是项目切换器`);
  let sg = false;
  for (let i = 0; i < 8 && !sg; i++) { await page.keyboard.press('Tab'); sg = (await activeInfo(page)).label === '风格指南'; }
  expect(sg, '8 次 Tab 内没走到风格指南卡');
  await sleep(500);
  const st = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { inView: r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight, color: cs.outlineColor, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
  expect(st.inView, '风格指南卡获焦时在视口外');
  expect(st.style !== 'none' && st.width > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(st.color), `风格指南卡获焦时没有可见焦点环：${st.style} ${st.width} ${st.color}`);
  return `Tab 序：项目切换器 → … → 风格指南卡（获焦时进视口，焦点环 ${st.color}）`;
});

await step('TC-CORE-059', '2', async () => {
  const page = await open(keysPid, { view: { x: 200, y: 80, zoom: 0.5 } });
  await blur(page);
  let onCard = false;
  for (let i = 0; i < 10 && !onCard; i++) { await page.keyboard.press('Tab'); onCard = !!(await activeInfo(page)).route; }
  expect(onCard, '10 次 Tab 内走不到任何一张屏卡');
  const a = await activeInfo(page);
  expect(a.route === '/s1', `卡片停靠点应是阅读顺序第一张 /s1，实际 ${a.route}`);
  await page.keyboard.press('ArrowRight');
  const b = await activeInfo(page);
  expect(b.route === '/s2', `→ 应移到 /s2，实际 ${b.route}`);
  await page.keyboard.press('Space');
  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1 && (await card(page, '/s2').getAttribute('class'))!.includes('selected'), '空格没选中 /s2'));
  await page.keyboard.press('Enter');
  await eventually(async () => expect((await page.locator('.card.focused[data-route="/s2"]').count()) === 1, 'Enter 没进入 /s2 的交互'));
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 30000 });
  await eventually(async () => expect((await activeInfo(page)).tag === 'IFRAME', '进入交互后焦点没移进 iframe'), 3000);
  await page.keyboard.press('Escape');
  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, 'iframe 里按 Esc 没退出交互'));
  await eventually(async () => expect((await activeInfo(page)).route === '/s2', `退出后焦点没回到 /s2 卡片：${JSON.stringify(await activeInfo(page))}`), 3000);
  // 画布外的 Enter：⌘K 选中一屏，再按 Enter 进去
  await blur(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('finder-input').fill('s3');
  await page.keyboard.press('Enter');
  await eventually(async () => expect((await card(page, '/s3').getAttribute('class'))!.includes('selected'), '⌘K 没选中 /s3'));
  await sleep(400);
  await page.keyboard.press('Enter');
  await eventually(async () => expect((await page.locator('.card.focused[data-route="/s3"]').count()) === 1, '选中一屏后按 Enter 没进入交互'));
  return 'Tab 到卡片（/s1）→ → 到 /s2 → 空格选中 → Enter 进交互、焦点进 iframe → Esc 退出、焦点回卡片；⌘K 选中 /s3 后 Enter 进入';
});

await step('TC-CORE-059', '3', async () => {
  const page = await open(keysPid, { view: { x: 200, y: 80, zoom: 0.5 } });
  const tools = ['适配视图', '批注', '设计系统', '本机 agent'];
  const tops = async () => Object.fromEntries(await Promise.all(tools.map(async (n) => [n, Math.round((await page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: n, exact: true }).boundingBox())!.y)])));
  const idle = await tops();
  const c = await center(page, '[data-testid="screen-card"][data-route="/s1"]');
  await page.mouse.click(c.x, c.y);
  await eventually(async () => expect((await page.locator('[data-testid="screen-card"].selected').count()) === 1, '单击没选中'));
  const sel = await tops();
  const shifted = tools.filter((n) => Math.abs(sel[n] - idle[n]) > 1);
  expect(shifted.length === 0, `选中一屏后基础工具移位：${shifted.map((n) => `${n} ${idle[n]}→${sel[n]}`).join('；')}`);
  const enter = page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: '进入交互', exact: true });
  expect((await enter.count()) === 1, '恰好选中一屏时工具栏没有「进入交互」');
  const eb = (await enter.boundingBox())!;
  const at = { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 };
  await page.mouse.click(at.x, at.y);
  await eventually(async () => expect((await page.locator('.card.focused[data-route="/s1"]').count()) === 1, '点「进入交互」没进去'));
  await sleep(400);
  const foc = await tops();
  const under = () => page.evaluate(({ x, y }) => (document.elementFromPoint(x, y)?.closest('button') as HTMLElement | null)?.getAttribute('aria-label') ?? '', at);
  expect((await under()) === '退出交互', `「进入交互」那一格进去之后是「${await under()}」，应是「退出交互」`);
  await page.mouse.click(at.x, at.y);
  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, '点「退出交互」没退出'));
  await sleep(400);
  const back = await tops();
  const u2 = await under();
  const focusLabel = (await activeInfo(page)).label;
  const moved = tools.filter((n) => [sel[n], foc[n], back[n]].some((v) => Math.abs(v - idle[n]) > 1));
  expect(moved.length === 0, `基础工具随选中 / 聚焦移位：${moved.map((n) => `${n} ${idle[n]}→${sel[n]}→${foc[n]}→${back[n]}`).join('；')}`);
  expect(u2 === '进入交互', `退出后指针下的工具是「${u2}」，应回到「进入交互」`);
  expect(focusLabel === '进入交互', `退出后焦点在「${focusLabel || 'body'}」，应留在这一格`);
  return `基础工具 4 个在空闲 / 选中 / 聚焦 / 退出后纵坐标不变（适配视图 ${idle['适配视图']}）；同一格 进入交互 ↔ 退出交互，焦点留在这一格`;
});

await step('TC-CORE-059', '4', async () => {
  const page = await open(keysPid, { view: { x: 200, y: 80, zoom: 0.5 } });
  await card(page, '/s1').locator('.gesture').dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 30000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('h1').first().click();
  expect((await activeInfo(page)).tag === 'IFRAME', '点屏里之后焦点不在 iframe');
  await page.keyboard.press('Alt+n');
  await eventually(() => expect(panelParam(page) === 'annotate', `焦点在 iframe 里按 ⌥N 没开批注（panel=${panelParam(page)}）`), 3000);
  await page.keyboard.press('Alt+n');
  await sleep(300);
  await card(page, '/s2').locator('.gesture').dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 30000 });
  await page.frameLocator('.card.focused iframe').locator('h1').first().click();
  await page.keyboard.press('Alt+d');
  await eventually(() => expect(panelParam(page) === 'design', `焦点在 iframe 里按 ⌥D 没开设计系统（panel=${panelParam(page)}）`), 3000);
  return '焦点在预览 iframe 里 ⌥N 开批注、⌥D 开设计系统';
});

await step('TC-CORE-059', '5', async () => {
  const page = await open(keysPid, { view: { x: 900, y: 500, zoom: 1.2 }, reduced: true });
  // 记下世界层 transform 的每一次写入（MutationObserver，不靠 rAF 采样——负载高时 rAF 会漏帧）
  const sample = async (act: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as { __t: string[]; __mo?: MutationObserver };
      const world = document.querySelector('.world') as HTMLElement;
      w.__t = [world.style.transform];
      w.__mo?.disconnect();
      w.__mo = new MutationObserver(() => { if (w.__t[w.__t.length - 1] !== world.style.transform) w.__t.push(world.style.transform); });
      w.__mo.observe(world, { attributes: true, attributeFilter: ['style'] });
    });
    await act();
    await sleep(700);
    return page.evaluate(() => (window as unknown as { __t: string[] }).__t);
  };
  await blur(page);
  const fit = await sample(() => page.keyboard.press('KeyF'));
  expect(fit.length === 2, fit.length < 2 ? '按 F 镜头没动' : `减少动态效果下按 F 镜头经过 ${fit.length - 2} 个中间值（应一步到位）`);
  const jump = await sample(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('finder-input').fill('s4');
    await eventually(async () => expect((await page.getByTestId('finder-row').count()) === 1, '找屏列表没筛到 /s4'));
    await page.keyboard.press('Enter');
  });
  expect(jump.length === 2, jump.length < 2 ? '⌘K 跳屏镜头没动' : `减少动态效果下 ⌘K 跳屏镜头经过 ${jump.length - 2} 个中间值`);
  return `适配视图与 ⌘K 跳屏都一步到位（${fit[1]}）`;
});

// ---------- TC-CORE-079 小地图拖完视口框之后的镜头变化不跳（canvas-15 残留，v0.83） ----------
// 视口框在小地图里该挪多少：屏幕上平移 d px，框挪 d × 框宽 / 画布视口宽（框宽就是视口宽按小地图比例换算的结果）
const miniFrame = async (page: Page) => (await page.getByTestId('minimap').getAttribute('data-view'))!.split(' ').map(Number);
const fmtFrame = (f: number[]) => f.map((n) => n.toFixed(1)).join(' ');
const dragFrame = async (page: Page, dx: number, dy: number, steps: number) => {
  const box = (await page.getByTestId('minimap').boundingBox())!;
  const [fx, fy, fw, fh] = await miniFrame(page);
  const g = { x: box.x + fx + fw / 2, y: box.y + fy + fh / 2 };
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(g.x + (dx * i) / steps, g.y + (dy * i) / steps);
  await page.mouse.up();
  await sleep(300);
};

await step('TC-CORE-079', '1', async () => {
  // 拖完视口框、松手，再滚一下滚轮：框只按镜头的位移挪，不重新缩放、不跳
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 1 } });
  await page.getByTestId('minimap').waitFor({ timeout: 3000 });
  await sleep(300);
  await dragFrame(page, 24, 12, 6);
  const released = await miniFrame(page);
  const vb = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  const w0 = await world(page);
  await page.mouse.wheel(0, 40);
  await sleep(400);
  const w1 = await world(page);
  const after = await miniFrame(page);
  const k = released[2] / vb.width;
  const want = [released[0] - (w1.x - w0.x) * k, released[1] - (w1.y - w0.y) * k, released[2], released[3]];
  expect(Math.abs(w1.y - w0.y) > 5, `滚轮没平移画布：${w0.y} → ${w1.y}`);
  expect(after.every((v, i) => Math.abs(v - want[i]) <= 1), `拖完视口框后第一次镜头变化，框跳了：松手 ${fmtFrame(released)}，镜头平移 ${(w1.y - w0.y).toFixed(0)} px 后 ${fmtFrame(after)}，应为 ${fmtFrame(want)}`);
  return `松手 ${fmtFrame(released)} → 平移 ${(w1.y - w0.y).toFixed(0)} px 后 ${fmtFrame(after)}（应为 ${fmtFrame(want)}）`;
});

await step('TC-CORE-079', '2', async () => {
  // 拖完之后一直往外平移：视口框到了小地图边上，外接框逐帧向外扩，每一步只挪「镜头位移」那么多，框始终在小地图里
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 1 } });
  await page.getByTestId('minimap').waitFor({ timeout: 3000 });
  await sleep(300);
  await dragFrame(page, 30, 16, 6);
  const vb = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  let prev = await miniFrame(page);
  const bad: string[] = [];
  for (let i = 0; i < 24; i++) {
    const w0 = await world(page);
    await page.mouse.wheel(0, 200);
    await sleep(120);
    const w1 = await world(page);
    const f = await miniFrame(page);
    // 框在扩张的外接框里贴边时，位置随比例一起收；单步位移不超过镜头位移按上一步比例换算 + 2 px
    const allow = Math.abs(w1.y - w0.y) * (prev[2] / vb.width) + 2;
    const moved = Math.max(Math.abs(f[0] - prev[0]), Math.abs(f[1] - prev[1]));
    if (moved > allow) bad.push(`第 ${i + 1} 步框挪了 ${moved.toFixed(1)} px（镜头 ${(w1.y - w0.y).toFixed(0)} px，上限 ${allow.toFixed(1)}）：${fmtFrame(prev)} → ${fmtFrame(f)}`);
    if (f[0] < -0.5 || f[1] < -0.5 || f[0] + f[2] > 176.5 || f[1] + f[3] > 112.5) bad.push(`第 ${i + 1} 步框出了小地图：${fmtFrame(f)}`);
    prev = f;
  }
  expect(bad.length === 0, bad.slice(0, 3).join('；'));
  return `连续向外平移 24 步，每步框的位移都不超过镜头位移换算值 + 2 px、始终在小地图内，末了 ${fmtFrame(prev)}`;
});

await step('TC-CORE-079', '3', async () => {
  // 拖完之后来一次与卡片几何无关的整体重取（别处改了项目名 → 项目事件）：框不动
  const page = await open(ptrPid, { view: { x: 400, y: 120, zoom: 1 } });
  await page.getByTestId('minimap').waitFor({ timeout: 3000 });
  await sleep(300);
  await dragFrame(page, 24, 12, 6);
  const released = await miniFrame(page);
  const name = `Pointer ${Date.now() % 1000}`;
  const refetched = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/v1/projects/${ptrPid}`, { timeout: 10000 });
  await apiJson(`/v1/projects/${ptrPid}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  await refetched;
  await sleep(500);
  const after = await miniFrame(page);
  await apiJson(`/v1/projects/${ptrPid}`, { method: 'PATCH', body: JSON.stringify({ name: 'Pointer' }) });
  expect(after.every((v, i) => Math.abs(v - released[i]) <= 0.6), `拖完视口框后一次与卡片无关的重取让框跳了：${fmtFrame(released)} → ${fmtFrame(after)}`);
  return `重取详情前后框都是 ${fmtFrame(after)}`;
});

await ctx?.close().catch(() => {});
console.log('\n| 用例 | 结果 | 备注 |\n| --- | --- | --- |');
for (const r of results) console.log(`| ${r.tc} | ${r.result} | ${r.note} |`);
await browser.close();
process.exit(results.some((r) => r.result === '失败') ? 1 : 0);
