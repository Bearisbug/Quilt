// docs/TEST.md CORE 域 · 浮层与面板层级（TC-CORE-047～049，v0.78）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import { seedJson, apiJson, WEB, eventually, pickOption } from '../lib.ts';
import { expect, softly } from '../harness.ts';
import { page, step, shot } from './shared.ts';

// ---- v0.78 共用（TC-CORE-047~049）----
type Box = { x: number; y: number; width: number; height: number };
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const blurActive = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
// 铺满视口、有底色的 fixed 层（弹层遮罩）有几层：弹层只该有一层遮罩。遮罩是半透明墨色（v1.15 起加 6 px 背景模糊，§13.1），按底色认
const backdropLayers = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return cs.position === 'fixed' && r.width >= innerWidth - 1 && r.height >= innerHeight - 1 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
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
    await page.goto(`${WEB}/p/${projectId}?settings=models`);
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

// TC-CORE-049 窄视口与输入框几何：首帧终值宽度、面板开时先截通道名不折行、窄视口下开着面板不挤竖条、排列条不被小地图盖（v0.78）
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
    await page.evaluate(() => { localStorage.setItem('quilt:minimap', '1'); sessionStorage.setItem('quilt:probe-composer', '1'); });
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
    // 3 右侧面板开着：1024×700、800×600 下输入框不被挤成竖条、不出视口、不压顶栏 / 面板
    for (const [w, h] of [[1024, 700], [800, 600]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await load('?panel=screens');
      const c = await box('form.composer'); const p = await box('.slide-in-right');
      await S.check(() => expect(c.width >= 280 && c.y >= 56 && c.y + c.height <= h + 1 && c.x >= 0 && c.x + c.width <= w + 1, `③ ${w}×${h} 输入框几何不对：${JSON.stringify(c)}`));
      await S.check(() => expect(overlapArea(c, p) === 0, `③ ${w}×${h} 输入框与面板重叠：${overlapArea(c, p)} px²`));
    }
    // 4 1024×700、屏列表开着、小地图开着，多选两屏：排列条的屏数与「左对齐」不被小地图盖住
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
    await S.check(() => expect(barHit.every(Boolean), `④ 排列条的屏数 / 左对齐被盖住：${JSON.stringify(barHit)}`));
    await shot(page, 'CORE-049');
  } catch (e) { S.fail(e); } finally { await page.setViewportSize({ width: 1440, height: 1000 }); }
  S.done();
  return '首帧即终值宽度；面板开时截通道名不折行；1024 / 800 下开着面板输入框不挤不压；排列条不被小地图盖';
});
