import { mkdir } from 'node:fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launch, seed, seedJson, apiJson, bareContext, pickOption, selectedValue, EVIDENCE, WEB, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';
import { suite, expect, sleep, softly } from './harness.ts';

// docs/TEST.md 协作显示（v1.32 REQ-CORE-048）与作业完成 chip（v1.33）用例 TC-CORE-153~157、159 的 AI 执行脚本。
// 两个人 = 同一浏览器里两个不带预置身份的上下文（lib.ts 的 bareContext），各自在 localStorage 里记一个名字；
// 从输入框发改屏要一条云端通道：建一条 OpenAI 兼容桩通道，按 holdMs 拖住，好在作业进行中看「正在改」
await mkdir(EVIDENCE, { recursive: true });
const contexts: BrowserContext[] = [];
let current: Page | null = null;
const { RUN, step, summary } = suite('COLLAB', { page: () => current ?? undefined, onTimeout: async () => { for (const c of contexts.splice(0)) await c.close().catch(() => {}); } });

type Person = { id: string; name: string; color: number };
const JIA: Person = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '甲', color: 1 };
const YI: Person = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '乙', color: 3 };
const BING: Person = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: '丙', color: 5 };
const STUB_RUNNER = { kind: 'model', driver: 'stub', model: 'stub' } as const;
const STUB_PORT = 3962;
const STUB_LABEL = '协作桩';
const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

seed('seed');
const browser: Browser = await launch();
// 改屏桩：验证请求（ping）不拖，其余拖 4 s，作业进行中够看到「正在改」
const stub = startOpenAiStub({ port: STUB_PORT, apiKey: `good-key-${STUB_PORT}`, reply: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Collab</h1><p class="text-text-secondary">改过了</p></div>', holdMs: (hit) => (hit.user === 'ping' ? 0 : 4000) });
const channel = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: STUB_LABEL, endpoint: stub.url, model: `stub-${STUB_PORT}`, apiKey: `good-key-${STUB_PORT}` }) })).body.channel.id;
expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${channel}/probe`, { method: 'POST' })).body.ok === true, '桩通道验证未通过');

const project = seedJson<{ projectId: string; screens: { id: string; route: string; name: string }[] }>('seed:project', '--name', 'Collab', '--device', 'mobile', '--screens', '3', '--no-shot');
const pid = project.projectId;
const routeId = (route: string) => project.screens.find((s) => s.route === route)!.id;

/** 开一个上下文：person = null 时不带名字（第一次打开），否则把这个人记进 localStorage */
async function open(person: Person | null, url: string, opts: { reduced?: boolean } = {}): Promise<Page> {
  const ctx = await bareContext(browser, { viewport: { width: 1440, height: 900 }, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  contexts.push(ctx);
  await ctx.addInitScript('window.__name = window.__name || ((f) => f);');
  if (person) await ctx.addInitScript((me) => { if (!localStorage.getItem('quilt:me')) localStorage.setItem('quilt:me', me); }, JSON.stringify(person));
  const page = await ctx.newPage();
  current = page;
  await page.goto(`${WEB}${url}`);
  return page;
}
const openCanvas = async (person: Person | null, opts: { reduced?: boolean } = {}) => {
  const page = await open(person, `/p/${pid}`, opts);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  return page;
};
const closeAll = async () => { for (const c of contexts.splice(0)) await c.close().catch(() => {}); current = null; };
const card = (page: Page, route: string) => page.locator(`[data-testid="screen-card"][data-route="${route}"]`);
const translateOf = (s: string) => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(s); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; };
const cardBox = (page: Page, route: string) => card(page, route).evaluate((el) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((el as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight };
});
const world = (page: Page) => page.evaluate(() => (document.querySelector('.world') as HTMLElement).style.transform);
const shownCursor = (page: Page, name: string) => page.locator(`[data-testid="peer-cursor"][data-name="${name}"]:not([hidden])`);
const useStub = async (page: Page) => {
  const sel = '[data-testid="runner-select"]';
  await page.locator(sel).waitFor({ timeout: 10000 });
  if ((await selectedValue(page, sel)) !== `channel:${channel}`) await pickOption(page, sel, STUB_LABEL);
  await eventually(async () => expect((await selectedValue(page, sel)) === `channel:${channel}`, `输入框没选上「${STUB_LABEL}」`));
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${EVIDENCE}/run-${RUN}-${name}.png` });

// ---------- TC-CORE-153 第一次打开填名字 ----------
await step('TC-CORE-153', async () => {
  const S = softly();
  try {
    // 前置：一个已有名字的人（颜色 1）先在这个项目里
    const other = await openCanvas({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: '丙', color: 1 });
    const page = await openCanvas(null);
    // 1 弹出对话框，名字为空时「开始」不可用；Esc 关不掉
    const dialog = page.getByTestId('collab-name-dialog');
    await dialog.waitFor({ timeout: 5000 });
    await S.check(async () => expect((await page.getByTestId('collab-name-start').getAttribute('aria-disabled')) === 'true', '① 名字为空时「开始」应 aria-disabled'));
    await page.keyboard.press('Escape');
    await sleep(300);
    await S.check(async () => expect((await dialog.count()) === 1, '① Esc 不该关掉填名字的对话框'));
    // 2 填名字点「开始」：对话框关掉，记下名字与颜色——颜色跳过在线的丙用着的 1
    await page.getByTestId('collab-name-input').fill('  甲  ');
    await S.check(async () => expect((await page.getByTestId('collab-name-start').getAttribute('aria-disabled')) === null, '② 填了名字「开始」应可用'));
    await page.getByTestId('collab-name-start').click();
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
    const me = JSON.parse((await page.evaluate(() => localStorage.getItem('quilt:me'))) ?? 'null') as Person | null;
    await S.check(() => expect(me?.name === '甲' && me.color === 2 && /^[0-9a-f-]{36}$/.test(me.id), `② 应记下名字「甲」、颜色 2：${JSON.stringify(me)}`));
    await S.check(() => eventually(async () => expect((await other.getByTestId('peer-avatar').getAttribute('data-name')) === '甲', '② 丙这边应出现甲的头像'), 5000));
    // 3 刷新、换到草稿本：都不再问
    await page.reload();
    await card(page, '/s1').waitFor({ timeout: 15000 });
    await sleep(800);
    await S.check(async () => expect((await dialog.count()) === 0, '③ 刷新后不该再问名字'));
    await page.goto(`${WEB}/sketch`);
    await page.getByTestId('sketch-stage').waitFor({ timeout: 15000 });
    await sleep(800);
    await S.check(async () => expect((await dialog.count()) === 0, '③ 草稿本也不该再问名字'));
    // 4 设置「系统」里改名、换色：localStorage 跟着变，别人那边当场换
    await page.goto(`${WEB}/p/${pid}?settings=system`);
    await page.getByTestId('collab-settings-name').waitFor({ timeout: 10000 });
    await page.getByTestId('collab-settings-name').fill('甲二');
    await page.getByTestId('collab-settings-save').click();
    await page.getByTestId('collab-colors').locator('input[value="5"]').check({ force: true });
    const me2 = JSON.parse((await page.evaluate(() => localStorage.getItem('quilt:me'))) ?? 'null') as Person | null;
    await S.check(() => expect(me2?.name === '甲二' && me2.color === 5 && me2.id === me?.id, `④ 改名换色后应是「甲二」、颜色 5、id 不变：${JSON.stringify(me2)}`));
    await S.check(() => eventually(async () => expect((await other.getByTestId('peer-avatar').getAttribute('data-name')) === '甲二', '④ 丙这边的头像应换成「甲二」'), 5000));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '对话框必填、不能 Esc 关；颜色避开在线的人；刷新与草稿本不再问；设置里改名换色当场生效';
});

// ---------- TC-CORE-154 两人同开一个项目 ----------
await step('TC-CORE-154', async () => {
  const S = softly();
  try {
    const A = await openCanvas(JIA);
    const B = await openCanvas(YI);
    // 1 甲的顶栏出现乙的头像
    await A.getByTestId('peer-avatar').waitFor({ timeout: 5000 });
    await S.check(async () => expect((await A.getByTestId('peer-avatar').getAttribute('data-name')) === '乙' && (await A.getByTestId('peer-avatar').count()) === 1, '① 甲的顶栏应恰好一个乙的头像'));
    // 2 乙在画布上移动指针：甲这边 2 s 内出现乙的光标与名字
    const cv = (await B.getByTestId('canvas').boundingBox())!;
    await B.mouse.move(cv.x + 300, cv.y + 600); await B.mouse.move(cv.x + 320, cv.y + 620);
    await S.check(() => shownCursor(A, '乙').waitFor({ timeout: 2000 }).catch(() => { throw new Error('② 甲这边 2 s 内没出现乙的光标'); }));
    await S.check(async () => expect((await shownCursor(A, '乙').innerText()).includes('乙'), '② 光标上应写乙的名字'));
    // 3 乙选中 /s1：甲这边 /s1 多一道描边与「乙」的标签
    await card(B, '/s1').locator('.gesture').click();
    await S.check(() => A.getByTestId('peer-outline').waitFor({ timeout: 3000 }).catch(() => { throw new Error('③ 甲这边没出现乙的选中描边'); }));
    await S.check(async () => { const o = (await A.getByTestId('peer-outline').first().evaluate((el) => (el as HTMLElement).style.transform)); const b = await cardBox(A, '/s1'); const t = translateOf(o); expect(t && Math.abs(t.x - b.x) < 1 && Math.abs(t.y - b.y) < 1, `③ 描边应套在 /s1 上：${o} vs ${JSON.stringify(b)}`); });
    await S.check(async () => expect((await A.locator(`.peer-chips[data-card="${routeId('/s1')}"] [data-testid="peer-chip"]`).allInnerTexts()).includes('乙'), '③ /s1 卡上应挂「乙」的标签'));
    await shot(A, 'tc-core-154-select');
    // 4 乙拖动 /s2：拖动中甲这边跟着动，松手后两边位置一致、与库里一致
    const before = await cardBox(A, '/s2');
    const g = (await card(B, '/s2').locator('.gesture').boundingBox())!;
    await B.mouse.move(g.x + g.width / 2, g.y + 40); await B.mouse.down();
    for (let i = 1; i <= 12; i++) { await B.mouse.move(g.x + g.width / 2 + i * 15, g.y + 40 + i * 5); await sleep(30); }
    await sleep(400);
    const during = await cardBox(A, '/s2');
    await S.check(() => expect(during.x > before.x + 20, `④ 拖动中甲这边 /s2 应跟着动：${before.x} → ${during.x}`));
    await B.mouse.up();
    await S.check(() => eventually(async () => {
      const a = await cardBox(A, '/s2'); const b = await cardBox(B, '/s2');
      const db = (await apiJson<{ screens: { id: string; x: number; y: number }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === routeId('/s2'))!;
      expect(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(db.x - b.x) < 1 && Math.abs(db.y - b.y) < 1, `④ 松手后应一致：甲 ${JSON.stringify(a)} 乙 ${JSON.stringify(b)} 库 ${db.x},${db.y}`);
    }, 5000));
    // 5 甲点乙的头像跟随：视口四周描乙的颜色；乙平移，甲的镜头跟着动；甲自己滚动即停；再跟随后 Esc 停
    await A.getByTestId('peer-avatar').click();
    await S.check(async () => expect((await A.getByTestId('peer-avatar').getAttribute('aria-pressed')) === 'true', '⑤ 跟随时头像应 aria-pressed'));
    await S.check(() => A.getByTestId('follow-frame').waitFor({ timeout: 2000 }).catch(() => { throw new Error('⑤ 没出现跟随描边'); }));
    await S.check(async () => expect((await A.getByTestId('follow-frame').innerText()).includes('正在跟随 乙'), `⑤ 横幅应写「正在跟随 乙」：${await A.getByTestId('follow-frame').innerText()}`));
    await sleep(500);
    const w0 = await world(A);
    await B.mouse.move(cv.x + 700, cv.y + 400);
    for (let i = 0; i < 10; i++) { await B.mouse.wheel(0, 60); await sleep(30); }
    await S.check(() => eventually(async () => expect((await world(A)) !== w0, '⑤ 乙平移后甲的镜头没跟着动'), 3000));
    await shot(A, 'tc-core-154-follow');
    const ac = (await A.getByTestId('canvas').boundingBox())!;
    await A.mouse.move(ac.x + 600, ac.y + 500);
    await A.mouse.wheel(0, 120);
    await S.check(() => eventually(async () => expect((await A.getByTestId('follow-frame').count()) === 0 && (await A.getByTestId('peer-avatar').getAttribute('aria-pressed')) !== 'true', '⑤ 甲自己滚动后应停止跟随'), 2000));
    await A.getByTestId('peer-avatar').click();
    await A.getByTestId('follow-frame').waitFor({ timeout: 2000 });
    await A.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await A.keyboard.press('Escape');
    await S.check(() => eventually(async () => expect((await A.getByTestId('follow-frame').count()) === 0, '⑤ Esc 应停止跟随'), 2000));
    // 6 跟随着乙时乙关掉页面：头像、光标、描边都消失，提示「乙 已离开」
    await A.getByTestId('peer-avatar').click();
    await A.getByTestId('follow-frame').waitFor({ timeout: 2000 });
    await B.context().close();
    await S.check(() => A.getByTestId('peer-avatar').waitFor({ state: 'detached', timeout: 15000 }).catch(() => { throw new Error('⑥ 15 s 内乙的头像没消失'); }));
    await S.check(async () => expect((await A.locator('[data-testid="peer-cursor"]').count()) === 0 && (await A.getByTestId('peer-outline').count()) === 0 && (await A.getByTestId('follow-frame').count()) === 0, '⑥ 乙离开后光标、描边与跟随描边都应消失'));
    await S.check(() => A.locator('[data-testid="toast"]', { hasText: '乙 已离开' }).waitFor({ timeout: 3000 }).catch(() => { throw new Error('⑥ 没提示「乙 已离开」'); }));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '头像、光标、选中描边与标签、拖卡同步、跟随（滚动与 Esc 停）、离开后清掉并提示';
});

// ---------- TC-CORE-155 屏内光标与正在改 ----------
await step('TC-CORE-155', async () => {
  const S = softly();
  try {
    const A = await openCanvas(JIA);
    const B = await openCanvas(YI);
    await A.getByTestId('peer-avatar').waitFor({ timeout: 5000 });
    // 1 乙双击 /s1 进交互、在屏里移动指针：甲看到「乙 · 交互中 /s1」，乙的光标落在 /s1 卡里
    await card(B, '/s1').locator('.gesture').dblclick();
    await B.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
    await S.check(() => A.locator(`.peer-chips[data-card="${routeId('/s1')}"] [data-testid="peer-chip"]`, { hasText: '乙 · 交互中 /s1' }).waitFor({ timeout: 3000 }).catch(() => { throw new Error('① /s1 卡上没标「乙 · 交互中 /s1」'); }));
    const fr = (await B.locator('.card.focused iframe').boundingBox())!;
    await B.mouse.move(fr.x + 120, fr.y + 200); await B.mouse.move(fr.x + 140, fr.y + 220);
    await S.check(() => eventually(async () => {
      const t = translateOf(await A.locator('[data-testid="peer-cursor"][data-name="乙"]').evaluate((el) => (el as HTMLElement).style.transform));
      const b = await cardBox(A, '/s1');
      expect(!!t && t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h && !(await A.locator('[data-testid="peer-cursor"][data-name="乙"]').getAttribute('hidden')), `① 乙的光标应落在 /s1 卡里：${JSON.stringify(t)} vs ${JSON.stringify(b)}`);
    }, 3000));
    await shot(A, 'tc-core-155-in-frame');
    // 2 乙退出交互、选中 /s2 发改屏：作业进行中甲看到 /s2 卡上标「乙 正在改」；作业结束后这枚标签撤掉
    await B.keyboard.press('Escape');
    await B.locator('.card.focused').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await useStub(B);
    await card(B, '/s2').locator('.gesture').click();
    await B.locator('#chat-input').fill('改成深色');
    await B.keyboard.press('Enter');
    const working = A.locator(`.peer-chips[data-card="${routeId('/s2')}"] [data-testid="peer-chip"]`, { hasText: '乙 正在改' });
    await S.check(() => working.waitFor({ timeout: 4000 }).catch(() => { throw new Error('② 作业进行中 /s2 卡上没标「乙 正在改」'); }));
    await shot(A, 'tc-core-155-working');
    await S.check(() => working.waitFor({ state: 'detached', timeout: 30000 }).catch(() => { throw new Error('② 作业结束后「乙 正在改」没撤掉'); }));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '交互中的标签与屏内光标落点、发改屏期间的「正在改」';
});

// ---------- TC-CORE-156 草稿本里的协作者 ----------
await step('TC-CORE-156', async () => {
  const S = softly();
  try {
    const sb = (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId;
    const draft = async (content: string) => {
      const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${sb}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content, frame: 'mobile', runner: STUB_RUNNER }) });
      expect(r.status === 202, `建草稿 ${r.status}`);
      let id = '';
      await eventually(async () => { const j = (await apiJson<{ job: { status: string; output: { screenIds?: string[] } } }>(`/v1/jobs/${r.body.job.id}`)).body.job; expect(j.status === 'succeeded', `建草稿 ${j.status}`); id = j.output.screenIds![0]; }, 30000, 300);
      return id;
    };
    const d1 = await draft('一个登录页'); const d2 = await draft('一个设置页');
    const openDraft = async (person: Person, d: string) => { const p = await open(person, `/sketch?d=${d}`); await p.getByTestId('draft-iframe').waitFor({ timeout: 20000 }); await sleep(1200); return p; };
    const A = await openDraft(JIA, d2);
    const B = await openDraft(YI, d1);
    // 1 甲的记录栏里草稿 1 的缩略图角上有乙的小头像
    await A.getByTestId('peer-avatar').waitFor({ timeout: 5000 });
    await S.check(() => eventually(async () => expect((await A.locator(`[data-testid="rail-item"][data-draft-id="${d1}"] [data-testid="rail-viewers"]`).count()) === 1, '① 记录栏里草稿 1 上应有乙的小头像'), 3000));
    // 2 甲点乙的头像跟随：看板换到草稿 1
    await A.getByTestId('peer-avatar').click();
    await S.check(() => A.waitForURL((u) => u.searchParams.get('d') === d1, { timeout: 5000 }).catch(() => { throw new Error('② 跟随后甲没换到草稿 1'); }));
    await A.getByTestId('draft-iframe').waitFor({ timeout: 20000 });
    await sleep(1200);
    // 3 乙在草稿上移动指针：甲看到乙的光标
    const fr = (await B.getByTestId('draft-iframe').boundingBox())!;
    await B.mouse.move(fr.x + 60, fr.y + 80); await B.mouse.move(fr.x + 80, fr.y + 100);
    await S.check(() => shownCursor(A, '乙').waitFor({ timeout: 3000 }).catch(() => { throw new Error('③ 甲没看到乙在草稿上的光标'); }));
    await shot(A, 'tc-core-156-cursor');
    // 4 乙对这张草稿发一轮改：作业进行中甲看到画框上方「乙 正在改」
    await useStub(B);
    await B.getByTestId('composer-input').fill('改成深色');
    await B.getByTestId('composer-send').click();
    await S.check(() => A.locator('[data-testid="peer-chip"]', { hasText: '乙 正在改' }).waitFor({ timeout: 5000 }).catch(() => { throw new Error('④ 甲没看到「乙 正在改」'); }));
    await shot(A, 'tc-core-156-working');
    await B.locator('[data-testid="job-chip"][data-state="running"]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await B.getByTestId('draft-iframe').waitFor({ timeout: 20000 });
    await sleep(1500);
    // 5 乙开「选元素」点一块：甲的草稿里这一块套上乙颜色的框、写乙的名字
    await B.getByTestId('draft-pick').click();
    const target = B.frameLocator('[data-testid="draft-iframe"]').locator('h1[data-qid], p[data-qid]').first();
    const c = await target.evaluate((el) => { const x = el.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; });
    const shown = (await B.getByTestId('draft-iframe').boundingBox())!;
    const laid = await B.getByTestId('draft-iframe').evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
    await B.mouse.click(shown.x + c.x * (shown.width / laid.w), shown.y + c.y * (shown.height / laid.h));
    await B.getByTestId('draft-pick-chip').waitFor({ timeout: 5000 });
    const box = A.frameLocator('[data-testid="draft-iframe"]').locator('[data-quilt-peer]');
    await S.check(() => box.first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => { throw new Error('⑤ 甲的草稿里没出现乙选中那一块的框'); }));
    await S.check(async () => expect((await box.first().innerText().catch(() => '')).includes('乙'), '⑤ 框上应写乙的名字'));
    await shot(A, 'tc-core-156-block');
    // 6 乙换到草稿 2：甲跟着换；甲自己点开草稿 1 就停止跟随
    await B.locator(`[data-testid="rail-item"][data-draft-id="${d2}"]`).click();
    await S.check(() => A.waitForURL((u) => u.searchParams.get('d') === d2, { timeout: 5000 }).catch(() => { throw new Error('⑥ 乙换到草稿 2 后甲没跟着换'); }));
    await A.locator(`[data-testid="rail-item"][data-draft-id="${d1}"]`).click();
    await sleep(500);
    await S.check(async () => expect((await A.getByTestId('peer-avatar').getAttribute('aria-pressed')) !== 'true' && new URL(A.url()).searchParams.get('d') === d1, '⑥ 甲自己点开草稿 1 后应停止跟随、留在草稿 1'));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '记录栏小头像、跟随换草稿、草稿上的光标、正在改、选中块的框、自己选草稿停止跟随';
});

// ---------- TC-CORE-157 作业完成的 chip ----------
await step('TC-CORE-157', async () => {
  const S = softly();
  const s1 = routeId('/s1');
  const edit = async (content: string) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content, targetScreenIds: [s1], runner: STUB_RUNNER }) });
    expect(r.status === 202, `发改屏 ${r.status}`);
    return r.body.job.id;
  };
  try {
    const page = await openCanvas(JIA);
    await sleep(800);
    // 1 别处发起的一轮改屏：先是在跑的 chip
    const j1 = await edit('[stub-hold:1500] 改成深色');
    const chip = page.locator(`[data-testid="job-chip"][data-job-id="${j1}"]`);
    await chip.waitFor({ timeout: 10000 });
    await S.check(async () => expect((await chip.getAttribute('data-state')) === 'running', `① 应先是在跑态：${await chip.getAttribute('data-state')}`));
    // 2 作业成功：chip 原地转成完成态，圆形对勾弹出、写「任务完成 · 改「Screen 1」」；× 平时看不见
    await chip.and(page.locator('[data-state="succeeded"]')).waitFor({ timeout: 30000 });
    const t0 = Date.now();
    await S.check(async () => expect((await chip.locator('[role="status"]').innerText()).replace(/\s+/g, ' ').trim() === '任务完成 · 改「Screen 1」', `② 文案不对：${await chip.locator('[role="status"]').innerText()}`));
    await S.check(async () => expect((await chip.locator('.job-done-icon').evaluate((el) => getComputedStyle(el).animationName)) === 'job-done-pop', '② 对勾应有弹出动效'));
    await S.check(async () => expect((await chip.getByTestId('dismiss-job').evaluate((el) => getComputedStyle(el).opacity)) === '0', '② 没悬停时 × 应看不见'));
    await shot(page, 'tc-core-157-done');
    // 3 悬停：× 显出来，停表——悬停 11 s 后它还在
    await chip.hover();
    await S.check(() => eventually(async () => expect((await chip.getByTestId('dismiss-job').evaluate((el) => getComputedStyle(el).opacity)) === '1', '③ 悬停时 × 应显出来'), 2000));
    await shot(page, 'tc-core-157-hover');
    await sleep(Math.max(0, 11_000 - (Date.now() - t0)));
    await S.check(async () => expect((await chip.count()) === 1, '③ 悬停期间 chip 不该淡出'));
    // 4 移开：按剩下的时间接着走，3 s 后还在，12 s 内淡出撤掉
    const cv = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.move(cv.x + 200, cv.y + 200);
    await sleep(3000);
    await S.check(async () => expect((await chip.count()) === 1, '④ 移开 3 s 时 chip 应还在（剩余时间没清零）'));
    await S.check(() => chip.waitFor({ state: 'detached', timeout: 12000 }).catch(() => { throw new Error('④ 移开后 12 s 内 chip 没淡出'); }));
    // 5 再来一轮：完成后悬停点 ×，当场撤掉
    const j2 = await edit('[stub-hold:500] 再改一次');
    const chip2 = page.locator(`[data-testid="job-chip"][data-job-id="${j2}"][data-state="succeeded"]`);
    await chip2.waitFor({ timeout: 30000 });
    await chip2.hover();
    await chip2.getByTestId('dismiss-job').click();
    await S.check(() => chip2.waitFor({ state: 'detached', timeout: 1000 }).catch(() => { throw new Error('⑤ 点 × 后 chip 没撤掉'); }));
    await closeAll();
    // 6 减弱动态：直接换成完成态，对勾不弹
    const rp = await openCanvas(JIA, { reduced: true });
    await sleep(800);
    const j3 = await edit('[stub-hold:500] 第三次');
    const chip3 = rp.locator(`[data-testid="job-chip"][data-job-id="${j3}"][data-state="succeeded"]`);
    await chip3.waitFor({ timeout: 30000 });
    await S.check(async () => expect((await chip3.locator('.job-done-icon').evaluate((el) => getComputedStyle(el).animationName)) === 'none', '⑥ 减弱动态时对勾不该有动效'));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '完成态文案与对勾、悬停停表与 ×、移开按剩余时间淡出、点 × 即撤、减弱动态';
});

// ---------- TC-CORE-159 链式跟随与互相跟随 ----------
await step('TC-CORE-159', async () => {
  const S = softly();
  try {
    const A = await openCanvas(JIA);
    const B = await openCanvas(YI);
    const C = await openCanvas(BING);
    const avatar = (pg: Page, name: string) => pg.locator(`[data-testid="peer-avatar"][data-name="${name}"]`);
    for (const [pg, n] of [[A, '乙'], [A, '丙'], [B, '甲'], [B, '丙']] as const) await avatar(pg, n).waitFor({ timeout: 5000 });
    const pan = async (pg: Page, dy: number) => { const cv = (await pg.getByTestId('canvas').boundingBox())!; await pg.mouse.move(cv.x + 700, cv.y + 400); for (let i = 0; i < 6; i++) { await pg.mouse.wheel(0, dy); await sleep(30); } };
    // 1 乙跟随丙、甲跟随乙：甲的横幅写「正在跟随 乙 · 乙在跟随 丙」；丙平移后甲、乙的镜头都摆到丙的视野（同样大的视口，世界层一样）
    await avatar(B, '丙').click();
    await B.getByTestId('follow-frame').waitFor({ timeout: 3000 });
    await avatar(A, '乙').click();
    await S.check(() => eventually(async () => expect((await A.getByTestId('follow-frame').innerText()).includes('正在跟随 乙 · 乙在跟随 丙'), `① 甲的横幅不对：${await A.getByTestId('follow-frame').innerText()}`), 3000));
    await S.check(() => eventually(async () => expect((await avatar(A, '乙').getAttribute('aria-pressed')) === 'true', '① 甲这边乙的头像应按下'), 2000));
    const a0 = await world(A);
    await pan(C, 80);
    await S.check(() => eventually(async () => { const a = await world(A); const b = await world(B); expect(a !== a0 && a === b, `① 丙平移后甲、乙应都摆到丙的视野：甲 ${a} 乙 ${b}`); }, 3000));
    await shot(A, 'tc-core-159-chain');
    // 2 乙改为跟随甲：连成一圈，甲（先开始跟随的那个）停下并收到提示，乙留着；两边镜头不再动
    await avatar(B, '甲').click();
    await S.check(() => A.locator('[data-testid="toast"]', { hasText: '乙 也在跟随你，你已停止跟随乙' }).waitFor({ timeout: 3000 }).catch(() => { throw new Error('② 甲没收到「乙 也在跟随你」的提示'); }));
    await S.check(() => eventually(async () => expect((await A.getByTestId('follow-frame').count()) === 0 && (await avatar(A, '乙').getAttribute('aria-pressed')) !== 'true', '② 甲应停止跟随乙'), 3000));
    await S.check(async () => expect((await B.getByTestId('follow-frame').innerText()).includes('正在跟随 甲'), `② 乙应留在跟随甲：${await B.getByTestId('follow-frame').innerText().catch(() => '没有跟随描边')}`));
    await sleep(800);
    const still = [await world(A), await world(B)];
    await sleep(2000);
    await S.check(async () => expect((await world(A)) === still[0] && (await world(B)) === still[1], '② 解开之后两边的镜头不该再动'));
    // 3 乙先停下，甲、乙同时点对方的头像：只留一个在跟随
    await B.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await B.keyboard.press('Escape');
    await B.getByTestId('follow-frame').waitFor({ state: 'detached', timeout: 3000 });
    await Promise.all([avatar(A, '乙').click(), avatar(B, '甲').click()]);
    await S.check(() => eventually(async () => expect((await A.getByTestId('follow-frame').count()) + (await B.getByTestId('follow-frame').count()) === 1, '③ 同时点之后应只留一个人在跟随'), 4000));
  } catch (e) { S.fail(e); } finally { await closeAll(); }
  S.done();
  return '链式跟随看领头人的视野；连成一圈时先开始的那个停下并收到提示、镜头不再动；同时互点只留一个';
});

await apiJson(`/v1/channels/${channel}`, { method: 'DELETE' }).catch(() => {});
stub.server.closeAllConnections(); await stub.close();
const counts = summary();
await browser.close();
process.exit(counts['失败'] ? 1 : 0);
