import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, Request } from 'playwright';
import { launch, seed, seedJson, apiJson, EVIDENCE, WEB, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';

// docs/TEST.md 画布加载与数据新鲜度（v0.76）用例 TC-CORE-050~056 的 AI 执行脚本：组件卡首帧、首次适配、适配视图下限、
// 聚焦过渡与热更新基线、截图换图、项目事件流断线、加载失败与外壳常驻、切项目不串状态、对话记录一致性。
// 全部走 stub：composer 发出的请求经路由把通道改成 stub（种子会按 .env 建一条真实 Gemini 通道并设为缺省）。
const RUN = process.env.RUN ?? '001';
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
let current: Page | null = null;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : '❌'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  try { const note = await fn(); record(tc, '通过', note ?? ''); await current?.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}.png`) }).catch(() => {}); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 400)); await current?.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
type Detail = { project: { id: string; name: string }; screens: { id: string; route: string; currentRevisionId: string; screenshotUrl: string | null; previewUrl: string | null }[] };
const detail = (pid: string) => apiJson<Detail>(`/v1/projects/${pid}`).then((r) => r.body);
const seedProject = (name: string, ...args: string[]) => seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', name, ...args);
// 屏里某个元素的 qid 与当前修订：零 token 直改（API-EDIT-001）要用
const qidOf = async (pid: string, screenId: string, id: string) => {
  const s = (await detail(pid)).screens.find((x) => x.id === screenId)!;
  const revs = (await apiJson<{ items: { id: string; htmlUrl: string }[] }>(`/v1/screens/${screenId}/revisions`)).body.items;
  const html = await (await fetch(revs.find((r) => r.id === s.currentRevisionId)!.htmlUrl)).text();
  const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))![0];
  return { qid: tag.match(/data-qid="(q\d+)"/)![1], rev: s.currentRevisionId };
};
const editText = async (pid: string, screenId: string, id: string, text: string) => {
  const { qid, rev } = await qidOf(pid, screenId, id);
  const r = await apiJson<{ revision: { id: string } }>(`/v1/screens/${screenId}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: text }], expectedRevisionId: rev }) });
  expect(r.status === 201, `直改 ${screenId} 返回 ${r.status}`);
  return r.body.revision.id;
};
const isDetailGet = (req: Request, pid: string) => req.method() === 'GET' && new URL(req.url()).pathname === `/v1/projects/${pid}`;
const isMessagesGet = (req: Request, pid: string) => req.method() === 'GET' && new URL(req.url()).pathname === `/v1/projects/${pid}/messages`;
// composer 发出的一轮一律改走 stub：种子建的缺省通道是真实 Gemini
const stubComposer = (page: Page, pid: string) => page.route(`**/v1/projects/${pid}/messages`, async (route) => {
  if (route.request().method() !== 'POST') return route.fallback();
  const body = JSON.parse(route.request().postData() ?? '{}');
  await route.continue({ postData: JSON.stringify({ ...body, runner: STUB }) });
});
const switchTo = async (page: Page, name: string) => {
  await page.getByTestId('project-switcher').click();
  await page.getByTestId('project-switcher-list').getByTestId('project-option').filter({ hasText: name }).first().click();
};

seed('seed');
const browser = await launch();
const newPage = async (opts: { clock?: boolean } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // tsx 编出来的函数带 __name(...) 包装，传进页面的采样函数里有具名内部函数时页面侧要有这个名字
  await ctx.addInitScript('window.__name = window.__name || ((f) => f);');
  const page = await ctx.newPage();
  if (opts.clock) await page.clock.install();
  current = page;
  return page;
};

// ---------- TC-CORE-050 组件卡首帧尺寸与首次适配（load-1 / canvas-4 / load-5） ----------
await step('TC-CORE-050', async () => {
  const { projectId: pid } = seedProject('Comps', '--device', 'mobile', '--screens', '0', '--no-shot');
  // 后四个按视口 / 父宽定尺寸或根元素是 fixed：iframe 视口跟着卡片缩的话，它们会随每次上报一路缩到 48×32 的下限
  const rows = Array.from({ length: 40 }, (_, i) => `<li class="h-10 px-4 flex items-center">Row ${i + 1}</li>`).join('');
  const comps: [string, string, number, number][] = [
    ['Header Tab', '<header class="h-[60px] flex items-center px-4 bg-surface border-b border-outline-variant"><span class="font-semibold">Header</span></header>', -480, 760],
    ['Bottom Bar', '<nav class="h-[100px] grid grid-cols-3 bg-surface border-t border-outline-variant"><a href="/s1" aria-current="page" class="flex items-center justify-center text-primary">A</a><a href="/s2" class="flex items-center justify-center">B</a><a href="/s3" class="flex items-center justify-center">C</a></nav>', -480, 900],
    ['Side Rail', '<aside class="h-dvh w-64 bg-surface border-r border-outline-variant p-4">Menu</aside>', 0, 760],
    ['Half Sheet', '<section class="h-[50vh] bg-surface border-t border-outline-variant p-4">Sheet</section>', 480, 760],
    ['Half Pane', '<div class="w-1/2 h-20 bg-surface p-2">Pane</div>', 960, 760],
    ['Long List', `<ul class="max-h-[60vh] overflow-auto bg-surface">${rows}</ul>`, 1440, 760],
    ['Dock', '<nav class="fixed bottom-0 inset-x-0 h-14 flex items-center justify-around bg-surface border-t border-outline-variant"><span>Home</span><span>Me</span></nav>', -480, 1100],
  ];
  for (const [name, html, x, y] of comps) {
    const c = await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name, html }) });
    expect(c.status === 201, `建组件 ${name} 返回 ${c.status}`);
    await apiJson(`/v1/components/${c.body.component.id}`, { method: 'PATCH', body: JSON.stringify({ x, y }) });
  }
  // 设备 390×844：50vh = 422，60vh ≈ 507，w-1/2 = 195
  const final: Record<string, [number, number]> = { 'Header Tab': [390, 60], 'Bottom Bar': [390, 100], 'Side Rail': [256, 844], 'Half Sheet': [390, 422], 'Half Pane': [195, 80], 'Long List': [390, 507], Dock: [390, 56] };
  const N = comps.length;
  const page = await newPage();
  // 逐帧采样组件卡的尺寸、iframe 是否可见与世界层 transform；组件文档推迟 1.5 s 回，把「上报之前」那一段拉长
  await page.addInitScript(() => {
    const w = window as unknown as { __samples: unknown[] };
    w.__samples = [];
    const t0 = performance.now();
    const tick = () => {
      const world = document.querySelector('.world') as HTMLElement | null;
      const cards = [...document.querySelectorAll('[data-testid="component-card"]')] as HTMLElement[];
      if (world) w.__samples.push({ t: Math.round(performance.now() - t0), world: world.style.transform, cards: cards.map((c) => { const f = c.querySelector('iframe'); const sk = c.querySelector('.skeleton'); return { name: c.dataset.name, w: c.offsetWidth, h: c.offsetHeight, shown: !!f && getComputedStyle(f).opacity !== '0', skeleton: !!sk && !!sk.querySelector('.sk-sweep') && getComputedStyle(sk).visibility === 'visible' }; }) });
      if (performance.now() - t0 < 9000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.route(/\/c\/[^/]+\/[^/?]+\?/, async (route) => { await sleep(1500); await route.continue(); });
  type Sample = { t: number; world: string; cards: { name: string; w: number; h: number; shown: boolean; skeleton: boolean }[] };
  const off = (c: { name: string; w: number; h: number }) => Math.abs(c.w - final[c.name][0]) > 2 || Math.abs(c.h - final[c.name][1]) > 2;
  const settle = async () => {
    await eventually(async () => {
      const cs = await page.locator('[data-testid="component-card"]').evaluateAll((els) => els.map((e) => ({ name: (e as HTMLElement).dataset.name!, w: (e as HTMLElement).offsetWidth, h: (e as HTMLElement).offsetHeight })));
      expect(cs.length === N && !cs.some(off), `组件卡没量到终值：${JSON.stringify(cs.map((c) => `${c.name} ${c.w}×${c.h}`))}`);
    }, 15000);
    await sleep(1200);
    const ss = await page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples);
    // 量到终值之后不再变：尺寸上报与 iframe 视口之间没有反馈循环
    const drift = ss[ss.length - 1].cards.filter(off).map((c) => `${c.name} ${c.w}×${c.h}`);
    expect(drift.length === 0, `量到终值后组件卡又变了：${drift.join('，')}`);
    return ss;
  };
  await page.goto(`${WEB}/p/${pid}`);
  const s1 = await settle();
  expect(s1.length > 10 && s1.some((s) => s.cards.length === N), `没采到帧：${s1.length}`);
  // 1 全程不出现整屏高的卡（没记过尺寸时是 64 高的紧凑占位）；iframe 可见时卡片已是终值
  for (const name of Object.keys(final)) {
    const max = Math.max(...s1.flatMap((s) => s.cards.filter((c) => c.name === name).map((c) => c.h)));
    expect(max <= Math.max(final[name][1], 64) + 2, `「${name}」加载途中出现过 ${max} 高的卡（终值 ${final[name][1]}）`);
  }
  const early = s1.flatMap((s) => s.cards.filter((c) => c.shown && off(c)).map((c) => `${s.t}ms ${c.name}=${c.w}×${c.h}`));
  expect(early.length === 0, `iframe 可见时卡片还不是终值：${early.slice(0, 3).join('，')}`);
  // iframe 还透明的那些帧，卡片里是屏卡片那一套骨架（呼吸 + 扫光），不是白底
  const bare = s1.flatMap((s) => s.cards.filter((c) => !c.shown && !c.skeleton).map((c) => `${s.t}ms ${c.name}`));
  expect(s1.some((s) => s.cards.some((c) => !c.shown)) && bare.length === 0, `上报前的卡片没有骨架：${bare.slice(0, 3).join('，')}`);
  // 卡片里露出来的是组件本身：根元素左上角落在卡片左上角（fixed 贴底的 Dock 在设备视口里位于 y≈788）
  const misplaced: string[] = [];
  for (const name of Object.keys(final)) {
    const card = page.locator(`[data-testid="component-card"][data-name="${name}"]`);
    const frame = (await card.locator('iframe').elementHandle())!;
    const root = await (await frame.contentFrame())!.evaluate(() => { const b = document.querySelector('[data-component]')!.getBoundingClientRect(); return { x: b.left, y: b.top }; });
    const [cr, fr, ch] = await Promise.all([card.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect), frame.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect), card.evaluate((e) => (e as HTMLElement).offsetHeight)]);
    const z = cr.height / ch;
    if (Math.abs(fr.left + root.x * z - cr.left) > 2 || Math.abs(fr.top + root.y * z - cr.top) > 2) misplaced.push(`${name}：根元素在 (${(fr.left + root.x * z - cr.left).toFixed(1)}, ${(fr.top + root.y * z - cr.top).toFixed(1)})`);
  }
  expect(misplaced.length === 0, `卡片没对准组件根元素：${misplaced.join('，')}`);
  // 2 自动适配不落盘；镜头首帧不是默认位、没有逐帧滑动（至多首帧适配 + 量完补一次）
  expect(await page.evaluate((k) => localStorage.getItem(k), `quilt:view:${pid}`) === null, '自动适配的镜头被写进了 quilt:view');
  const views = [...new Set(s1.map((s) => s.world))];
  expect(views[0] !== 'translate(80px, 80px) scale(0.5)', `首帧停在默认镜头：${views[0]}`);
  expect(views.length <= 2, `镜头自己动了 ${views.length - 1} 次（${views.slice(0, 4).join(' → ')}）`);
  // 3 量完之后的镜头与手动「适配视图」一致
  const scaleOf = (t: string) => Number(t.match(/scale\(([\d.]+)\)/)?.[1] ?? NaN);
  const auto = scaleOf(views[views.length - 1]);
  await page.keyboard.press('f');
  await sleep(600);
  const manual = scaleOf(await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform));
  expect(Math.abs(auto - manual) < 0.01, `自动适配 ${auto} 与按 F ${manual} 不一致`);
  // 4 刷新：首帧就是记住的尺寸，卡片一帧都不变；按过 F 的镜头留着
  const cached = await page.evaluate((k) => localStorage.getItem(k), `quilt:comp-size:${pid}`);
  expect(cached && Object.keys(JSON.parse(cached)).length === N, `量到的尺寸没记到本机：${cached}`);
  await page.reload();
  const s2 = await settle();
  const jumps = Object.keys(final).map((n) => [n, [...new Set(s2.flatMap((s) => s.cards.filter((c) => c.name === n).map((c) => `${c.w}×${c.h}`)))]] as const).filter(([, hs]) => hs.length > 1);
  expect(jumps.length === 0, `刷新后组件卡跳变：${JSON.stringify(jumps)}`);
  expect(new Set(s2.map((s) => s.world)).size === 1, '刷新后镜头动了');
  return `首次：${N} 张卡不超过 max(终值, 64)、量完不再变、根元素对准卡片左上角，镜头 ${views.length} 个取值、自动 ${auto.toFixed(3)} ≈ F ${manual.toFixed(3)}；刷新后卡片一帧不变`;
});

// ---------- TC-CORE-051 适配视图装得下大项目（canvas-11） ----------
await step('TC-CORE-051', async () => {
  const { projectId: pid } = seedProject('Wide', '--device', 'desktop', '--screens', '25', '--no-shot');
  const page = await newPage();
  await page.goto(`${WEB}/p/${pid}`);
  await page.locator('[data-testid="screen-card"]').nth(24).waitFor({ timeout: 15000 });
  await page.keyboard.press('f');
  await sleep(800);
  const r = await page.evaluate(() => {
    const safe = document.querySelector('[data-testid="safe-area"]')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid="screen-card"]')].map((c) => c.getBoundingClientRect());
    const inside = cards.filter((b) => b.left >= safe.left - 1 && b.right <= safe.right + 1 && b.top >= safe.top - 1 && b.bottom <= safe.bottom + 1).length;
    return { inside, total: cards.length, transform: (document.querySelector('.world') as HTMLElement).style.transform };
  });
  expect(r.inside === r.total, `适配视图后只有 ${r.inside}/${r.total} 屏完整落在可用区（${r.transform}）`);
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();
  const after = await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform);
  expect(after === r.transform, `刷新后镜头没留住：${r.transform} → ${after}`);
  // 3 缩到下限也装不下（45 张桌面屏横排约 61000 px）：适配到下限并说一声，不静默裁掉
  const { projectId: huge } = seedProject('Huge', '--device', 'desktop', '--screens', '45', '--no-shot');
  await page.goto(`${WEB}/p/${huge}`);
  await page.locator('[data-testid="screen-card"]').nth(44).waitFor({ timeout: 15000 });
  await page.keyboard.press('f');
  await page.getByText('最小缩放也装不下全部').waitFor({ timeout: 3000 });
  await sleep(500);
  const zoom = Number((await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform)).match(/scale\(([\d.]+)\)/)?.[1]);
  expect(Math.abs(zoom - 0.02) < 0.0005, `装不下时没停在下限 0.02：${zoom}`);
  return `${r.inside}/${r.total} 屏在可用区（${r.transform}），刷新后原样；45 屏时停在 0.02 并提示`;
});

// ---------- TC-CORE-052 聚焦过渡、热更新基线、截图换图（load-3 / canvas-5 / canvas-18 / load-11） ----------
await step('TC-CORE-052', async () => {
  const { projectId: pid, screens } = seedProject('Focus52', '--device', 'mobile', '--screens', '2');
  const [s1, s2] = screens;
  const page = await newPage();
  // iframe 文档（只拦第一份，也就是聚焦时的那次导航）：第 1 步推迟 1.2 s；第 2 步扣住，等页面拿到新修订再放
  let hold: 'delay' | 'gate' = 'delay';
  let gate: (() => void) | null = null;
  let docs = 0;
  await page.route(new RegExp(`/p/${pid}/${s1.id}\\?`), async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    docs += 1;
    if (hold === 'delay') { await sleep(1200); return route.continue(); }
    await new Promise<void>((r) => { gate = r; });
    return route.continue();
  });
  await page.goto(`${WEB}/p/${pid}`);
  const card = page.locator(`[data-testid="screen-card"][data-route="/s1"]`);
  await eventually(async () => expect(await card.locator('img').evaluateAll((els) => els.some((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)), '截图没加载出来'), 15000);
  // 1 双击进屏：「加载中」期间卡片上始终有一张可见的截图
  const sample = () => card.evaluate((el) => {
    const w = window as unknown as { __frames: { badge: string; shot: boolean; frame: string }[] };
    w.__frames = [];
    const t0 = performance.now();
    const tick = () => {
      const badge = el.querySelector('.badge')?.textContent ?? '';
      const shot = [...el.querySelectorAll('img')].some((i) => { const cs = getComputedStyle(i); return i.complete && i.naturalWidth > 0 && cs.opacity === '1' && cs.visibility === 'visible'; });
      const f = el.querySelector('iframe');
      w.__frames.push({ badge, shot, frame: f ? getComputedStyle(f).opacity : '' });
      if (performance.now() - t0 < 30000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sample();
  await card.locator('.gesture').dblclick();
  // 就绪要等预览文档里的 Tailwind CDN（实测 2.5–10 s，看网络），给足
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 30000 });
  const frames = await page.evaluate(() => (window as unknown as { __frames: { badge: string; shot: boolean; frame: string }[] }).__frames);
  const loading = frames.filter((f) => f.badge.startsWith('加载中'));
  const blank = loading.filter((f) => !f.shot).length;
  const showing = loading.filter((f) => f.frame === '1').length;
  expect(loading.length > 0, '没采到「加载中」那一段');
  expect(blank === 0, `「加载中」${loading.length} 帧里有 ${blank} 帧卡片上没有截图（白板）`);
  expect(showing === 0, `「加载中」${loading.length} 帧里有 ${showing} 帧 iframe 已经可见`);
  await page.keyboard.press('Escape');
  await page.locator('.card.focused').waitFor({ state: 'detached', timeout: 5000 });

  // 2 聚焦加载期间落地的新修订：就绪后换进来
  hold = 'gate';
  const before = docs;
  await card.locator('.gesture').dblclick();
  await eventually(() => expect(docs > before && gate, '聚焦的 iframe 文档没发出'), 8000);
  const newRev = await editText(pid, s1.id, 'toggle', '新版本');
  // 截图就绪的项目事件带来新修订：等页面把它取回来再放行 iframe 文档
  await page.waitForResponse(async (res) => isDetailGet(res.request(), pid) && ((await res.json()) as Detail).screens.some((s) => s.currentRevisionId === newRev), { timeout: 20000 });
  (gate as unknown as () => void)();
  const fl = page.frameLocator('.card.focused iframe');
  await eventually(async () => expect((await fl.locator('#toggle').innerText()) === '新版本', `iframe 里仍是旧版：${await fl.locator('#toggle').innerText().catch(() => '?')}`), 30000);
  await page.keyboard.press('Escape');
  await page.locator('.card.focused').waitFor({ state: 'detached', timeout: 5000 });

  // 3 截图换 URL：/s2 的截图地址变了（追加一个服务端不认的参数，对象响应推迟 800 ms），换图期间卡片上始终有一张解码好的图
  let roll = false;
  await page.route(`**/v1/projects/${pid}`, async (route) => {
    if (!roll || route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const d = (await res.json()) as Detail;
    for (const s of d.screens) if (s.id === s2.id && s.screenshotUrl) s.screenshotUrl += '&roll=1';
    await route.fulfill({ response: res, json: d });
  });
  await page.route(/roll=1/, async (route) => { await sleep(800); await route.continue(); });
  const card2 = page.locator(`[data-testid="screen-card"][data-route="/s2"]`);
  await card2.evaluate((el) => {
    const w = window as unknown as { __shots: boolean[] };
    w.__shots = [];
    const t0 = performance.now();
    const tick = () => {
      w.__shots.push([...el.querySelectorAll('img')].some((i) => { const cs = getComputedStyle(i); return i.complete && i.naturalWidth > 0 && cs.opacity === '1'; }));
      if (performance.now() - t0 < 30000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  roll = true;
  await editText(pid, s1.id, 'toggle', '再改一次');   // 另一屏出新截图 → 项目事件 → 整体重取，/s2 的截图地址随之变
  await eventually(async () => expect(await card2.locator('img').evaluateAll((els) => els.some((i) => (i as HTMLImageElement).src.includes('roll=1') && (i as HTMLImageElement).complete && getComputedStyle(i).opacity === '1')), '新地址的截图没换上'), 30000);   // 等的是另一屏出截图后的项目事件，负载高时 10 s 以上
  const shots = await page.evaluate(() => (window as unknown as { __shots: boolean[] }).__shots);
  const gaps = shots.filter((x) => !x).length;
  expect(gaps === 0, `换图期间 ${shots.length} 帧里有 ${gaps} 帧卡片上没有解码好的图`);
  return `加载中 ${loading.length} 帧全有截图、iframe 透明；加载期间落地的新修订就绪后换入；换图 ${shots.length} 帧无空档`;
});

// ---------- TC-CORE-053 项目事件流断线重连（load-4 / cross-9） ----------
await step('TC-CORE-053', async () => {
  const { projectId: pid } = seedProject('Live', '--device', 'mobile', '--screens', '1', '--no-shot');
  const page = await newPage();
  const t0 = Date.now();
  const log: { t: number; what: string }[] = [];
  page.on('request', (req) => { if (isDetailGet(req, pid)) log.push({ t: Date.now() - t0, what: 'detail' }); if (isMessagesGet(req, pid)) log.push({ t: Date.now() - t0, what: 'messages' }); });
  let n = 0;
  // 第 1 条连上就断（EventSource 自己重连）；第 2~4 条回 502（Vite 代理在 API 重启期间的回包，EventSource 会永久关闭）；之后放行
  await page.route(`**/v1/projects/${pid}/events`, async (route) => {
    n += 1;
    log.push({ t: Date.now() - t0, what: `events#${n}` });
    if (n === 1) return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'retry: 300\n\n' });
    if (n <= 4) return route.fulfill({ status: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad Gateway' });
    return route.continue();
  });
  await page.goto(`${WEB}/p/${pid}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  const status = page.getByTestId('live-status');
  await status.filter({ hasText: '实时更新已断开' }).waitFor({ timeout: 9000 }).catch(() => { throw new Error(`断线超过 3 s 没有提示（事件流已连 ${n} 条）`); });
  await eventually(() => expect(n >= 5, `第 2 条回 502 之后没有再连（共 ${n} 条）`), 20000);
  const reopenAt = log.find((x) => x.what === 'events#5')!.t;
  await eventually(() => expect(log.some((x) => x.what === 'detail' && x.t > reopenAt) && log.some((x) => x.what === 'messages' && x.t > reopenAt), `重连后没有重取详情与消息：${JSON.stringify(log.slice(-6))}`), 6000);
  await eventually(async () => expect((await status.count()) === 0, '重连后断线提示没撤'), 6000);
  await page.context().close();
  // 4 事件密集、详情 GET 慢于 250 ms 防抖：事件流每 ~300 ms 重连一次并带一条 screen_changed，详情 GET 推迟 900 ms、项目名改成 Tick <序号>。
  // 每个回包到达时都已有更晚的请求发出，详情仍要跟着前进（只丢早于最近已应用的回包）
  const p2 = await newPage();
  let burst = false; let tick = 0; let held = 0;
  await p2.route(`**/v1/projects/${pid}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const resp = await route.fetch();
    const body = await resp.json();
    if (burst) { held += 1; body.project.name = `Tick ${++tick}`; await sleep(900); }
    await route.fulfill({ response: resp, json: body });
  });
  await p2.route(`**/v1/projects/${pid}/events`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 300\n\nevent: screen_changed\ndata: ${JSON.stringify({ projectId: pid, type: 'screen_changed', data: {}, at: new Date().toISOString() })}\n\n` }));
  await p2.goto(`${WEB}/p/${pid}`);
  await p2.waitForFunction(() => document.title.startsWith('Live'), null, { timeout: 15000 });
  burst = true;
  const titles = new Set<string>();
  const tb = Date.now();
  while (Date.now() - tb < 6000) { titles.add(await p2.title()); await sleep(100); }
  burst = false;
  const applied = [...titles].filter((t) => t.startsWith('Tick')).length;
  expect(applied >= 3, `事件密集、详情慢时 6 s 里发了 ${held} 次详情 GET，页面只应用了 ${applied} 次`);
  return `${JSON.stringify(log.filter((x) => x.what.startsWith('events')).map((x) => x.t))} ms 各连一次；重连后重取详情与消息、提示撤掉；事件密集时 6 s 发出 ${held} 次慢详情 GET、应用了 ${applied} 次`;
});

// ---------- TC-CORE-054 加载失败与外壳常驻（load-8 / cross-6 / load-9 / cross-7） ----------
await step('TC-CORE-054', async () => {
  const { projectId: pid } = seedProject('Shell', '--device', 'mobile', '--screens', '2', '--messages', '2', '--no-shot');
  const page = await newPage();
  // 1 不存在的项目：说明 + 回到最近的项目；顶栏切换器照常
  await page.goto(`${WEB}/p/11111111-2222-4333-8444-555555555555`);
  const pending = page.getByTestId('canvas-pending');
  await pending.getByText('这个项目不存在或已被删除').waitFor({ timeout: 8000 });
  expect(await page.getByTestId('project-switcher').isVisible(), '不存在的项目页上没有项目切换器');
  await pending.getByRole('button', { name: '回到最近的项目' }).click();
  await page.waitForURL((u) => /\/p\//.test(u.pathname) && !u.pathname.includes('11111111'), { timeout: 8000 });
  await page.getByTestId('canvas').waitFor({ timeout: 10000 });
  // 2 详情 502：说明 + 重试
  await page.route(`**/v1/projects/${pid}`, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.fallback()));
  await page.goto(`${WEB}/p/${pid}`);
  await pending.getByText('项目没加载出来').waitFor({ timeout: 8000 });
  await page.unroute(`**/v1/projects/${pid}`);
  await pending.getByRole('button', { name: '重试' }).click();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  // 3 运行时配置取不到：同一个失败态，重试会重取配置
  await page.route('**/v1/config', (route) => route.abort());
  await page.reload();
  await pending.getByText('项目没加载出来').waitFor({ timeout: 8000 });
  await page.unroute('**/v1/config');
  await pending.getByRole('button', { name: '重试' }).click();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  // 4 根路径取列表失败：中文错误页 + 重试
  await page.route('**/v1/projects', (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()));
  await page.goto(`${WEB}/`);
  await page.getByText('没连上 Quilt 服务').waitFor({ timeout: 8000 });
  expect(!(await page.getByText('Unexpected Application Error').count()), '仍是路由库的英文默认错误页');
  await page.unroute('**/v1/projects');
  await page.getByRole('button', { name: '重试' }).click();
  await page.waitForURL(/\/p\//, { timeout: 10000 });
  // 5 慢详情：加载期间外壳都在，画布区是加载态
  await page.route(`**/v1/projects/${pid}`, async (route) => { if (route.request().method() === 'GET') await sleep(1500); await route.fallback(); });
  await page.goto(`${WEB}/p/${pid}`);
  await page.getByTestId('canvas-pending').waitFor({ timeout: 3000 });
  const shell = await page.evaluate(() => ({ switcher: !!document.querySelector('[data-testid="project-switcher"]'), chat: !!document.querySelector('[data-testid="chat-dock"]'), composer: !!document.querySelector('form.composer'), toolbar: !!document.querySelector('[aria-label="画布工具"]') }));
  expect(Object.values(shell).every(Boolean), `加载期间外壳不全：${JSON.stringify(shell)}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  await page.unroute(`**/v1/projects/${pid}`);
  // 6 对话记录取不到：写明没加载出来，不当成空
  await page.route(`**/v1/projects/${pid}/messages?*`, (route) => route.abort());
  await page.reload();
  const dock = page.getByTestId('chat-dock');
  if ((await dock.getAttribute('data-state')) === 'collapsed') await page.getByRole('button', { name: '展开对话记录' }).click();
  await dock.getByRole('alert').getByText('对话没加载出来').waitFor({ timeout: 8000 });
  expect(!(await dock.innerText()).includes('试试这样描述') && !(await dock.innerText()).includes('0 条'), `对话取不到时仍显示成空：${await dock.innerText()}`);
  await page.unroute(`**/v1/projects/${pid}/messages?*`);
  await dock.getByRole('button', { name: '重试' }).click();
  await eventually(async () => expect((await dock.getByTestId('message').count()) === 2, '重试后消息没出来'), 8000);
  // 7 通道清单取不到：通道位写明，重试后回来
  await page.route('**/v1/runners', (route) => route.abort());
  await page.reload();
  const failed = page.getByTestId('runners-failed');
  await failed.waitFor({ timeout: 8000 });
  await page.unroute('**/v1/runners');
  await failed.click();
  await page.getByTestId('runner-select').waitFor({ timeout: 8000 });
  // 8 样式表到达前的底色：从第一帧起就是画布底色 #0E1725，不是浏览器深色默认的 #121212（开发形态下样式表由脚本注入，约 0.5 s 后才生效；
  // 打包形态下样式表在 head 里阻塞首帧，这一步恒过）。根元素透明时画布底取 body 的背景（CSS 背景传播），两者都透明就是浏览器默认底
  const p8 = await newPage();
  await p8.addInitScript(() => {
    const w = window as unknown as { __bg: string[] };
    w.__bg = [];
    const t0 = performance.now();
    const tick = () => {
      const clear = 'rgba(0, 0, 0, 0)';
      const h = getComputedStyle(document.documentElement).backgroundColor;
      w.__bg.push(h !== clear ? h : document.body ? getComputedStyle(document.body).backgroundColor : clear);
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await p8.goto(`${WEB}/p/${pid}`);
  await p8.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  await sleep(1600);
  const bgs = await p8.evaluate(() => (window as unknown as { __bg: string[] }).__bg);
  const off = [...new Set(bgs.filter((b) => b !== 'rgb(14, 23, 37)'))];
  expect(bgs.length > 0 && off.length === 0, `${bgs.length} 帧里有 ${bgs.filter((b) => b !== 'rgb(14, 23, 37)').length} 帧不是画布底色：${off.join('，')}`);
  return `404 / 502 / 配置 / 根路径列表各有原因与出口；加载期间外壳常驻；对话与通道失败可重试；${bgs.length} 帧底色都是 #0E1725`;
});

// ---------- TC-CORE-055 切项目不串状态（frontend-1 / composer-4 / cross-11 / load-9） ----------
await step('TC-CORE-055', async () => {
  const a = seedProject('Alpha', '--device', 'mobile', '--screens', '2', '--messages', '2');
  const b = seedProject('Bravo', '--device', 'mobile', '--screens', '3', '--no-shot');
  const page = await newPage();
  await page.goto(`${WEB}/p/${a.projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  const toB = async () => {
    await switchTo(page, 'Bravo');
    await page.waitForURL(new RegExp(b.projectId));
    await eventually(async () => expect((await page.locator('[data-testid="screen-card"]').count()) === 3, 'B 的卡片没出来'), 10000);
  };
  const toA = async () => {
    await switchTo(page, 'Alpha');
    await page.waitForURL(new RegExp(a.projectId));
    await eventually(async () => expect((await page.locator('[data-testid="screen-card"]').count()) === 2, 'A 的卡片没出来'), 10000);
  };
  // 1a A 里放锚点、选 2 版，切到 B：没有锚点、版数回到 1
  await page.keyboard.press('Alt+g');
  await page.getByTestId('anchor-chip').waitFor({ timeout: 3000 });
  await page.getByTestId('versions-2').click();
  await toB();
  const inB = { anchor: await page.getByTestId('anchor-chip').count(), ghost: await page.getByTestId('anchor').count(), versions: await page.getByTestId('versions-1').getAttribute('aria-checked') };
  expect(inB.anchor === 0 && inB.ghost === 0 && inB.versions === 'true', `A 的锚点 / 版数带进了 B：${JSON.stringify(inB)}`);
  // 1b A 里双击进交互，切到 B：输入框在、没有聚焦的卡
  await toA();
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
  await page.locator('.card.focused').waitFor({ timeout: 5000 });
  await toB();
  const inB2 = { composer: await page.locator('form.composer').isVisible(), focused: await page.locator('.card.focused').count() };
  expect(inB2.composer && inB2.focused === 0, `A 的交互态带进了 B：${JSON.stringify(inB2)}`);
  // 2 A 的在途刷新晚到：不覆盖 B
  await toA();
  let slowA = false;
  await page.route(`**/v1/projects/${a.projectId}`, async (route) => { if (slowA && route.request().method() === 'GET') await sleep(2500); await route.fallback(); });
  slowA = true;
  const pending = page.waitForRequest((req) => isDetailGet(req, a.projectId), { timeout: 20000 });
  await editText(a.projectId, a.screens[1].id, 'toggle', '晚到');   // 截图就绪的项目事件 → A 的刷新（被拖 2.5 s）
  await pending;
  await switchTo(page, 'Bravo');
  await page.waitForURL(new RegExp(b.projectId));
  await sleep(4000);
  const state = { cards: await page.locator('[data-testid="screen-card"]').count(), pending: await page.getByTestId('canvas-pending').count(), title: await page.title() };
  expect(state.cards === 3 && state.pending === 0 && state.title.startsWith('Bravo'), `A 晚到的刷新覆盖了 B：${JSON.stringify(state)}`);
  slowA = false;
  // 3 B 的对话慢：新项目顶栏下不显示 A 的对话
  await switchTo(page, 'Alpha');
  await page.waitForURL(new RegExp(a.projectId));
  const dock = page.getByTestId('chat-dock');
  if ((await dock.getAttribute('data-state')) === 'collapsed') await page.getByRole('button', { name: '展开对话记录' }).click();
  await eventually(async () => expect((await dock.innerText()).includes('请把首页改得更活泼一点'), 'A 的对话没出来'), 8000);
  await page.route(`**/v1/projects/${b.projectId}/messages?*`, async (route) => { await sleep(1200); await route.fallback(); });
  await switchTo(page, 'Bravo');
  await page.waitForURL(new RegExp(b.projectId));
  // 顶栏切换器还写着 Alpha 的那几帧是旧页面还没换下来，不算；换下来之后（加载中或 Bravo）对话里不能有 A 的消息
  const leaked: string[] = [];
  for (let i = 0; i < 16; i++) {
    const snap = await page.evaluate(() => ({ who: document.querySelector('[data-testid="project-switcher"]')?.textContent ?? '', chat: document.querySelector('[data-testid="chat-dock"]')?.textContent ?? '' }));
    if (!snap.who.includes('Alpha') && snap.chat.includes('请把首页改得更活泼一点')) leaked.push(`${i * 50}ms（顶栏「${snap.who}」）`);
    await sleep(50);
  }
  expect(leaked.length === 0, `B 的顶栏下显示了 A 的对话：${leaked.join('，')}`);
  return 'B 里无锚点、1 版、输入框在、无聚焦；A 晚到的刷新丢弃；B 的对话慢时不串显 A 的';
});

// ---------- TC-CORE-056 对话记录一致性（frontend-2 / cross-10） ----------
await step('TC-CORE-056', async () => {
  const { projectId: pid, screens } = seedProject('Talk', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [s1, s2] = screens;
  const page = await newPage();
  await stubComposer(page, pid);
  await page.goto(`${WEB}/p/${pid}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  const dock = page.getByTestId('chat-dock');
  if ((await dock.getAttribute('data-state')) === 'collapsed') await page.getByRole('button', { name: '展开对话记录' }).click();
  // 1 较早发起的消息 GET 晚到：另一个作业引起的消息 GET 全部扣住，这期间在输入框发出一轮，发出后再按原顺序放行
  const held: (() => void)[] = [];
  let holding = false;
  await page.route(`**/v1/projects/${pid}/messages?*`, async (route) => {
    if (!holding) return route.fallback();
    const res = await route.fetch();
    await new Promise<void>((r) => held.push(r));
    await route.fulfill({ response: res });
  });
  holding = true;
  const other = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'edit_screens', input: { prompt: '另一个作业', screenIds: [s2.id], versions: 1, runner: STUB } }) });
  expect(other.status === 202, `建作业 ${other.status}`);
  await eventually(async () => expect(['succeeded', 'failed'].includes((await apiJson<{ job: { status: string } }>(`/v1/jobs/${other.body.job.id}`)).body.job.status) && held.length > 0, `另一个作业结束后没有取消息（扣住 ${held.length} 个）`), 20000);
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('form.composer textarea').fill('唯一的一轮 42');
  const posted = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/v1/projects/${pid}/messages`);
  await page.keyboard.press('Enter');
  await posted;
  holding = false;
  await eventually(async () => expect((await dock.innerText()).includes('唯一的一轮 42'), '发出的一轮没出现在对话里'), 8000);
  for (const release of held.splice(0)) { release(); await sleep(100); }
  await sleep(1500);
  const count = async () => (await dock.getByTestId('message').filter({ hasText: '唯一的一轮 42' }).count());
  expect((await count()) === 1, `较早发起的消息 GET 晚到后这一轮出现 ${await count()} 次`);
  // 2 别处发起的一轮：作业还在跑就出现在本页
  const stub = startOpenAiStub({ port: 3993, apiKey: 'good-key-0056', reply: '<div class="p-4">slow</div>', holdMs: 8000 });
  try {
    const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Slow 056', endpoint: stub.url, model: 'stub-56', apiKey: 'good-key-0056' }) });
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' })).body.ok, '慢桩通道验证未通过');
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '别处发起的一轮', targetScreenIds: [s1.id], runner: { kind: 'channel', channelId: ch.body.channel.id } }) });
    expect(r.status === 202, `别处发起 ${r.status}`);
    await eventually(async () => expect((await dock.innerText()).includes('别处发起的一轮'), '别处发起的一轮在作业结束前没出现'), 4000);
    const job = (await apiJson<{ job: { status: string } }>(`/v1/jobs/${r.body.job.id}`)).body.job;
    expect(['queued', 'running'].includes(job.status), `断言时作业已经 ${job.status}，没测到「结束前」`);
    await apiJson(`/v1/jobs/${r.body.job.id}/cancel`, { method: 'POST' });
    await apiJson(`/v1/channels/${ch.body.channel.id}`, { method: 'DELETE' });
  } finally { await stub.close(); }
  return '晚到的旧消息快照不抹掉刚发的一轮（出现 1 次）；别处发起的一轮在作业结束前出现';
});

console.log('\n| 用例 | 结果 | 备注 |\n| --- | --- | --- |');
for (const r of results) console.log(`| ${r.tc} | ${r.result} | ${r.note} |`);
await browser.close();
process.exit(results.some((r) => r.result === '失败') ? 1 : 0);
