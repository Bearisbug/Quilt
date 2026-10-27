// docs/TEST.md CORE 域 · 聚焦交互（TC-CORE-010～042）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openApp, seed, seedJson, apiJson, localFetch, previewHost, objectsDir, WEB, API, eventually, pickOption } from '../lib.ts';
import { startOpenAiStub } from '../openai-stub.ts';
import { expect, waitJob, needLiveLlm, Skip } from '../harness.ts';
import { page, browser, ctx, consoleErrors, RUN, step, shot, blankSpot, verbLine } from './shared.ts';

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
    const d = (await res.json()) as { screens: { id: string; screenshotUrl: string | null; thumbUrl: string | null; previewUrl: string | null }[] };
    for (const x of d.screens) if (x.id === focusScreens[0].id) {
      // 卡片按缩放用原图或缩略图（v1.02），两张都换成过期的
      if (kind === 'shot' && x.screenshotUrl) x.screenshotUrl = x.screenshotUrl.replace(/exp=\d+/, 'exp=1000000000');
      if (kind === 'shot' && x.thumbUrl) x.thumbUrl = x.thumbUrl.replace(/exp=\d+/, 'exp=1000000000');
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
    const zoom = Number((await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform)).match(/scale\(([\d.]+)\)/)?.[1] ?? 0);
    expect(Math.abs(zoom - 1) < 0.005, `聚焦后不是 1:1：${zoom}`);
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
    // 等改屏作业收口：v0.36 起输入框不再随作业禁用，改问后端还有没有在跑的作业；页面上的作业 chip 要等它自己收到终态事件才转成完成态（v1.33 完成态要停 10 s，只等在跑的没了）
    for (let i = 0; i < 30; i++) { if (!(await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${r.projectId}`)).body.activeJobs.length) break; await page.waitForTimeout(1000); }
    await page.locator('[data-testid="job-chip"][data-state="running"]').first().waitFor({ state: 'detached', timeout: 10000 });
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
  needLiveLlm();
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Iter', '--device', 'mobile', '--screens', '5');
  const before = await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`);
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor();
  await page.locator('[data-testid="screen-card"][data-route="/s3"] .gesture').click();
  await page.getByTestId('target-chip').filter({ hasText: 'Screen 3' }).waitFor();
  expect((await verbLine(page)).includes('改 1 屏'), `动词行应为「改 1 屏」：${await verbLine(page)}`);
  await page.fill('#chat-input', 'Turn this page into a grouped list with section headers');
  await page.keyboard.press('Enter');
  // 这一轮跑完 = 它的作业 chip 不再是在跑态（v1.33 成功的转成「任务完成」停 10 s）
  await page.locator('[data-testid="job-chip"]').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="job-chip"][data-state="running"]').length === 0, null, { timeout: 120000 });
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
  // v1.43：回溯只把「当前」移到第 2 版，不多出一行
  await page.locator('[data-testid="revision"][data-seq="2"]', { hasText: '当前' }).waitFor({ timeout: 10000 });
  expect((await page.locator('[data-testid="revision"]').count()) === 6 && (await page.locator('[data-testid="revision"]', { hasText: '当前' }).count()) === 1, `回溯后面板应仍是 6 行、只有一行标当前：${await page.locator('[data-testid="revision"]').count()}`);
  const revs = await apiJson<{ items: { id: string; seq: number }[] }>(`/v1/screens/${screens[0].id}/revisions`);
  expect(revs.body.items.length === 6, `修订链长度 ${revs.body.items.length}`);
  const r2 = revs.body.items.find((r) => r.seq === 2)!;
  const cur = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens[0].currentRevisionId;
  expect(cur === r2.id, `回溯后当前版应是 seq 2，实际 ${revs.body.items.find((r) => r.id === cur)?.seq}`);
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
  const ok = await apiJson<{ revision: { id: string } }>(`/v1/screens/${screens[0].id}/revisions/${seq(2)}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: seq(6) }) });
  expect(ok.status === 200 && ok.body.revision.id === seq(2), `正确 expected 返回 ${ok.status}`);
  expect((await apiJson<{ items: unknown[] }>(`/v1/screens/${screens[0].id}/revisions`)).body.items.length === 6, '回溯不该建修订');
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
  // 界面上没有对话记录（v1.17）：消息照旧存着，从接口看还是 12 条
  const msgs = (await apiJson<{ items: { content: string }[] }>(`/v1/projects/${projectId}/messages?limit=100`)).body.items;
  expect(msgs.length === 12, `消息数不是 12：${msgs.length}`);
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.getByRole('button', { name: '修订' }).click();
  await page.locator('[data-testid="revision"]').first().waitFor();
  expect((await page.locator('[data-testid="revision"]').count()) === 4 && (await page.locator('[data-testid="revision"]').first().getAttribute('data-seq')) === '4', '修订面板不是 4 条/当前 seq 4');
  // 关掉标签页重新打开（v0.32 本地版无会话）：从 `/` 进来仍落到同一项目、内容不变
  const again = await ctx.newPage();
  await openApp(again);
  await again.goto(`${WEB}/p/${projectId}`);
  await again.locator('[data-testid="screen-card"]').first().waitFor();
  expect((await again.locator('[data-testid="screen-card"]').count()) === 8, '新标签页里不一致');
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

await step('TC-CORE-006', async () => { throw new Skip('需 LLM_STUB=503 重启 worker；由 core-stub.ts 单独执行'); });

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
  expect(!existsSync(path.join(await objectsDir(), 'projects', b.projectId)), '对象目录未清理');
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
    const got = await localFetch(a1.body.asset.url);
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
    // v0.98：底色取项目色板——第 1 步那块钴蓝判为深色标志，瓦片衬项目 background（新建项目的中性色板够亮）
    await page.waitForFunction(() => /asset-on-(light|dark)/.test(document.querySelector('[data-testid="guide-assets"] [data-asset]')?.className ?? ''), undefined, { timeout: 10000 });
    const bgHex = (await apiJson<{ designSystem: { tokens: { colors: { background: string } } } }>(`/v1/projects/${projectId}`)).body.designSystem.tokens.colors.background;
    const bgRgb = `rgb(${[1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16)).join(', ')})`;
    const tile = await guide.locator('[data-asset]').first().evaluate((el) => ({ cls: el.className, bg: getComputedStyle(el).backgroundColor }));
    expect(tile.cls.includes('asset-on-light') && tile.bg === bgRgb, `深色素材的瓦片应衬项目 background ${bgRgb}，实为 ${tile.cls.match(/asset-\S+/)?.[0]} ${tile.bg}`);
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
    expect((await localFetch(a1.body.asset.url)).status === 404, '删除后 URL 仍可取');
    await shot(page, 'CORE-035');
    return 'SVG 上传取到 viewBox 尺寸；URL 不签名可取且长缓存；非图片 422；素材清单进 system 前缀；详情带 assets[] 且风格指南卡片画出来；面板列出并确认后删除，删完 URL 404';
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
});

// 并行作业（REQ-CORE-020）：多个作业同时在跑时输入框不上锁，只有这一轮真冲突才挡住发送；在跑作业各成一枚 chip 叠在输入框上方、逐个取消（v1.17）
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
    const chipOf = (id: string) => page.locator(`[data-testid="job-chip"][data-job-id="${id}"]`);
    const sendBtn = page.locator('form.composer button[type="submit"]');
    const reason = page.getByTestId('send-blocked-reason');
    await page.goto(`${WEB}/p/${projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    // 1 两个在跑作业各成一枚 chip（v1.17）：整叠在输入框上方、最新的贴着输入框（DOM 里排在最后）、写清在做什么、各带取消键
    await page.getByTestId('job-chips').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job-chip"]').length === 2, null, { timeout: 10000 });
    const ids = await page.getByTestId('job-chip').evaluateAll((els) => els.map((e) => e.getAttribute('data-job-id')));
    expect(ids.includes(genJob) && ids.includes(editJob), `两枚 chip 的 data-job-id 不是那两个作业：${ids.join(',')}`);
    expect(ids.at(-1) === editJob, `最新的改屏作业应贴着输入框、即 DOM 里的最后一枚，实际 ${ids.join(',')}`);
    const genText = await chipOf(genJob).innerText();
    expect(/造\s*1\s*屏/.test(genText), `造屏那枚 chip 没写清在做什么：${genText.replace(/\s+/g, ' ')}`);
    const editText = await chipOf(editJob).innerText();
    expect(editText.includes('改') && editText.includes('Screen 1'), `改屏那枚 chip 没点名是哪一屏：${editText.replace(/\s+/g, ' ')}`);
    for (const id of [genJob, editJob]) expect((await chipOf(id).getByTestId('cancel-job').count()) === 1, `${id} 那枚 chip 没有单独的取消键`);
    const stackBox = (await page.getByTestId('job-chips').boundingBox())!;
    const inputBox = (await page.locator('#chat-input').boundingBox())!;
    expect(stackBox.y + stackBox.height <= inputBox.y + 1, `作业 chip 没落在输入框上方（chip 底 ${stackBox.y + stackBox.height} vs 输入区顶 ${inputBox.y}）`);
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
    // 第 6 步那条落地后的「任务完成」chip 要 10 s 才收起，只数在跑的
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job-chip"][data-state="running"]').length === 1, null, { timeout: 10000 });
    await chipOf(editJob).waitFor({ state: 'detached', timeout: 5000 });
    expect((await jobOf(editJob)).status === 'cancelled', 'Esc 没取消最新那个作业');
    expect((await jobOf(genJob)).status === 'running', 'Esc 把另一个作业也取消了（应按一次取消一个）');
    // 9 chip 上的取消键只取消那一个；造屏名额一松，无目标发送立刻恢复
    await chipOf(genJob).getByTestId('cancel-job').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job-chips"]').length === 0, null, { timeout: 15000 });
    expect((await jobOf(genJob)).status === 'cancelled', '点 chip 上的取消键没取消那个作业');
    await page.getByTestId('clear-targets').click();
    await page.fill('#chat-input', '再造一屏设置页');

    await eventually(async () => expect((await reason.count()) === 0, '造屏作业已取消，拦截理由还在'));
    expect((await sendBtn.getAttribute('aria-disabled')) === null, '造屏作业已取消，发送键仍不可点');
    await shot(page, 'CORE-036');
    // 10 一个标签页只开一条 SSE（v0.37）：作业进度改走项目事件流的 job_changed 投影，不随在跑作业数增长
    const sseOpen = await page.evaluate('window.__sseOpen');
    expect(sseOpen === 1, `标签页活跃 SSE 应恒为 1，实际 ${sseOpen}`);
    return `一个标签页只一条 SSE；两个在跑作业各一枚 chip（最新的贴着输入框、各带取消键）、输入框照旧可输入；造屏撞造屏与改占用屏就地写理由且不发请求；改另一屏放行，两条真作业并行落地（A ${a.startedAt}→${a.finishedAt} / B ${b.startedAt}→${b.finishedAt}）；Esc 取消最新、chip 上取消键只取消那一个`;
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
  // 改名用 Enter / Esc 收尾后下拉仍开着（v0.78：Enter 只提交改名、不切项目）；开着时 Radix 让页面其余部分不接指针，再点触发器会被挡住
  const openRow = async () => {
    if (!(await page.getByTestId('project-switcher-list').count())) await page.getByTestId('project-switcher').click();
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
  const zoomPct = Math.round(Number((await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform)).match(/scale\(([\d.]+)\)/)?.[1] ?? 0) * 100);
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
  // 截图重拍看卡片拿到的截图地址（v1.03）：对象键带呈现方式，按叠层拍的是 <修订>.overlay.webp——地址变了，浏览器才不会拿内存里的旧图顶替
  const shotKeyOf = async (id: string) => decodeURIComponent((await shots()).find((x) => x.id === id)?.screenshotUrl ?? '');
  expect((await apiJson(`/v1/screens/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'overlay' }) })).status === 200, '默认屏改呈现方式应 200');
  const fam = (await shots()).filter((s) => s.id === s1.id || s.id === v!.id);
  expect(fam.every((s) => s.presentation === 'overlay'), `默认屏改呈现方式后变体应跟着改：${fam.map((s) => s.presentation).join('/')}`);
  await eventually(async () => {
    for (const id of [s1.id, v!.id]) expect((await shotKeyOf(id)).includes('.overlay.webp'), `家族两屏都应按叠层重拍、截图地址换成 .overlay.webp：${await shotKeyOf(id)}`);
  }, 30000, 1000);
  await apiJson(`/v1/screens/${s1.id}`, { method: 'PATCH', body: JSON.stringify({ presentation: 'push' }) });
  await eventually(async () => {
    for (const id of [s1.id, v!.id]) { const k = await shotKeyOf(id); expect(/[0-9a-f-]{36}\.webp/.test(k) && !k.includes('.overlay'), `切回整屏后截图地址应换回 <修订>.webp：${k}`); }
  }, 30000, 1000);
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

// TC-CORE-042 重试一轮的接口契约（REQ-CORE-026 / API-CORE-034）：原样再发、只换通道；在跑 409、助手消息 404、不能重试的种类 400。
// v1.17 起界面上的「重试」只在失败的作业 chip 上（见 TC-CORE-045），对话记录与消息操作条已去掉，这里只验接口
await step('TC-CORE-042', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Msgs', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [, s2] = screens;
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
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const sent = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: '照这两张图改', targetScreenIds: [s2.id], attachmentIds: [await upload(), await upload()], runner: STUB }) });
  expect(sent.status === 202, `发消息 ${sent.status}`);
  expect((await waitJob(sent.body.job.id, 60)).status === 'succeeded', '这一轮作业没成功');
  // 拖 6 s 才回的 OpenAI 兼容桩：重试这一轮要走它，好在它跑着的时候验 409
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${s2.id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const stub = startOpenAiStub({ port: 3993, apiKey: 'good-key-0042', reply: body0, holdMs: 6000 });
  try {
    const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Slow 通道', endpoint: stub.url, model: 'stub-42', apiKey: 'good-key-0042' }) });
    const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' });
    expect(probe.body.ok, '慢桩通道验证未通过');
    // 1 重试：新一轮追加，正文、两张图、原目标照旧，只有通道换了
    const before = (await messages()).length;
    const oldUser = (await messages()).filter((m) => m.role === 'user').at(-1)!;
    const re = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages/${oldUser.id}/retry`, { method: 'POST', headers: idem(), body: JSON.stringify({ runner: { kind: 'channel', channelId: ch.body.channel.id } }) });
    expect(re.status === 202, `重试 ${re.status} ${JSON.stringify(re.body).slice(0, 160)}`);
    await eventually(async () => expect((await messages()).length === before + 2, '重试后应追加一轮（两条消息）'), 5000);
    const newUser = (await messages()).filter((m) => m.role === 'user').at(-1)!;
    expect(newUser.content === oldUser.content && newUser.attachments.map((a) => a.id).join() === oldUser.attachments.map((a) => a.id).join(), '重试的这一轮正文与参考图应与原来一致');
    const oldJob = (await apiJson<{ job: Job }>(`/v1/jobs/${oldUser.jobId}`)).body.job;
    const newJob = (await apiJson<{ job: Job }>(`/v1/jobs/${newUser.jobId}`)).body.job;
    expect(newJob.kind === 'edit_screens' && newJob.input.screenIds?.join() === s2.id && newJob.input.imageKeys?.length === 2, `重试作业的种类 / 目标 / 参考图不对：${JSON.stringify(newJob.input).slice(0, 200)}`);
    expect(newJob.input.runner?.kind === 'channel' && newJob.input.runner.channelId === ch.body.channel.id && oldJob.input.runner?.kind !== 'channel', '重试应改用请求里给的通道');
    // 2 这一轮还在跑时再重试 → 409
    const busy = await apiJson<{ type: string }>(`/v1/projects/${projectId}/messages/${newUser.id}/retry`, { method: 'POST', headers: idem(), body: '{}' });
    expect(busy.status === 409 && busy.body.type === '/errors/job-not-finished', `在跑时重试应 409 job-not-finished：${busy.status} ${busy.body.type}`);
    const done = await waitJob(newJob.id, 60);
    expect(done.status === 'succeeded' && stub.hits.some((h) => h.hasImage), `重试作业 ${done.status}，或桩没收到参考图`);
    // 3 接口边界：助手消息 id → 404；不能重试的种类（导出）→ 400 path=messageId
    const asst = await apiJson(`/v1/projects/${projectId}/messages/${(await messages()).at(-1)!.id}/retry`, { method: 'POST', headers: idem(), body: '{}' });
    expect(asst.status === 404, `对助手消息重试应 404：${asst.status}`);
    const exp = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    await waitJob(exp.body.job.id, 90);
    const expUser = (await messages()).filter((m) => m.role === 'user').at(-1)!;
    const bad = await apiJson<{ errors?: { path: string }[] }>(`/v1/projects/${projectId}/messages/${expUser.id}/retry`, { method: 'POST', headers: idem(), body: '{}' });
    expect(bad.status === 400 && bad.body.errors?.[0]?.path === 'messageId', `导出这一轮重试应 400 path=messageId：${bad.status} ${JSON.stringify(bad.body).slice(0, 160)}`);
    return '重试原样再发（正文 / 两张参考图 / 目标屏照旧）、只换通道；跑着时再重试 409、助手消息 404、导出这一轮 400';
  } finally { await stub.close(); }
});
