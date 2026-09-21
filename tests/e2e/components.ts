import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB } from './lib.ts';

// docs/TEST.md TC-EDIT-012（共享组件，REQ-EDIT-006）AI 执行脚本。步骤 8 要真实 LLM；LIVE_LLM=0 只跑 1～7。
const RUN = process.env.RUN ?? '093';
const LIVE_LLM = process.env.LIVE_LLM !== '0';
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
let page: import('playwright').Page;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : result === '失败' ? '❌' : '⏭'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); record(tc, '通过', note ?? ''); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}.png`) }).catch(() => {}); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 300)); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
type Job = { id: string; kind: string; status: string; input: Record<string, unknown>; output: Record<string, unknown> | null };
const waitJob = async (jobId: string, maxSec: number): Promise<Job> => {
  for (let i = 0; i < maxSec / 3; i++) { await new Promise((r) => setTimeout(r, 3000)); const { body } = await apiJson<{ job: Job }>(`/v1/jobs/${jobId}`); if (['succeeded', 'failed', 'cancelled'].includes(body.job.status)) return body.job; }
  throw new Error('job timeout');
};
type Comp = { id: string; name: string; version: number; nav: boolean; summary: string; usedBy: string[] };
type Detail = { screens: { id: string; route: string; currentRevisionId: string }[]; components: Comp[] };
const detail = (id: string) => apiJson<Detail>(`/v1/projects/${id}`).then((r) => r.body);
type Rev = { id: string; sourceKind: string; jobId: string | null; htmlUrl: string };
const revisions = (screenId: string) => apiJson<{ items: Rev[] }>(`/v1/screens/${screenId}/revisions`).then((r) => r.body.items);
const currentHtml = async (pid: string, screenId: string) => { const d = await detail(pid); const s = d.screens.find((x) => x.id === screenId)!; const r = await apiJson<{ revision: Rev }>(`/v1/screens/${screenId}/revisions/${s.currentRevisionId}`); return { rev: r.body.revision, html: await (await fetch(r.body.revision.htmlUrl)).text() }; };
const navTag = (html: string) => html.match(/<nav[^>]*>/)?.[0] ?? '';
const qidIn = (tag: string) => tag.match(/data-qid="(q\d+)"/)?.[1] ?? null;
const linksInNav = (html: string) => (html.match(/<nav[\s\S]*?<\/nav>/)?.[0].match(/<a [^>]*href="\/s\d"/g) ?? []).length;
const post = (path: string, body: unknown) => apiJson<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': crypto.randomUUID() } });
const TWO_TABS = '<nav class="sticky bottom-0 mt-auto grid grid-cols-2 bg-surface border-t border-outline-variant"><a href="/s1" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="home" class="w-5 h-5"></i>Home</a><a href="/s2" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="search" class="w-5 h-5"></i>Find</a></nav>';

seed('seed');
const browser = await launch();
page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await openApp(page);

await step('TC-EDIT-012', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Comp', '--device', 'mobile', '--screens', '3', '--no-shot');
  const pid = r.projectId; const [s1, s2, s3] = r.screens;
  const before = await detail(pid);
  const navQid = qidIn(navTag((await currentHtml(pid, s1.id)).html));
  expect(navQid, '/s1 里没找到 <nav> 的 qid');

  // 1 提取 + 同步到其他屏
  const c1 = await post(`/v1/projects/${pid}/components`, { name: 'TabBar', fromScreenId: s1.id, qid: navQid, applyToScreens: true });
  const comp = c1.body.component as Comp;
  expect(c1.status === 201 && comp.name === 'TabBar' && comp.version === 1 && comp.nav === false && comp.summary.startsWith('nav') && comp.summary.includes('links:'), `提取返回不对：${c1.status} ${JSON.stringify(c1.body).slice(0, 300)}`);
  const applied1 = c1.body.applied as string[]; const skipped1 = c1.body.skipped as unknown[];
  expect(applied1.length === 3 && applied1.includes(s2.id) && applied1.includes(s3.id) && skipped1.length === 0, `applied / skipped 不对：${JSON.stringify({ applied: applied1, skipped: skipped1 })}`);
  const after1 = await detail(pid);
  for (const s of [s1, s2, s3]) {
    const prev = before.screens.find((x) => x.id === s.id)!; const now = after1.screens.find((x) => x.id === s.id)!;
    expect(now.currentRevisionId !== prev.currentRevisionId, `${s.route} 没出新修订`);
    const { rev, html } = await currentHtml(pid, s.id);
    expect(rev.sourceKind === 'component', `${s.route} 新修订来源是 ${rev.sourceKind}`);
    expect((html.match(/<nav data-component="TabBar"|<nav [^>]*data-component="TabBar"/g) ?? []).length === 1, `${s.route} 里 data-component="TabBar" 的 nav 不是恰好一个`);
    expect(linksInNav(html) === 3, `${s.route} 的 nav 里链接数 ${linksInNav(html)} ≠ 3`);
  }
  expect(after1.components.length === 1 && after1.components[0].usedBy.length === 3, `usedBy 应含三屏：${JSON.stringify(after1.components[0]?.usedBy)}`);

  // 2 PATCH html 改成 2 个 tab → 三屏回刷
  const p2 = await apiJson<{ component: Comp; applied: string[] }>(`/v1/components/${comp.id}`, { method: 'PATCH', body: JSON.stringify({ html: TWO_TABS, expectedVersion: 1 }) });
  expect(p2.status === 200 && p2.body.component.version === 2 && p2.body.applied.length === 3, `PATCH html 不对：${p2.status} ${JSON.stringify(p2.body).slice(0, 200)}`);
  for (const s of [s1, s2, s3]) {
    const { rev, html } = await currentHtml(pid, s.id);
    expect(rev.sourceKind === 'component' && linksInNav(html) === 2, `${s.route} 回刷后 nav 链接数 ${linksInNav(html)} ≠ 2（${rev.sourceKind}）`);
    const revs = await revisions(s.id);
    expect(revs.filter((x) => x.sourceKind === 'component').length === 2, `${s.route} 应有 2 条 component 修订，实际 ${revs.filter((x) => x.sourceKind === 'component').length}`);
  }
  const revCount = (await revisions(s1.id)).length;

  // 3 版本冲突
  const p3 = await apiJson<{ type: string }>(`/v1/components/${comp.id}`, { method: 'PATCH', body: JSON.stringify({ html: TWO_TABS, expectedVersion: 1 }) });
  expect(p3.status === 409 && p3.body.type === '/errors/version-conflict', `旧版本号该 409：${p3.status} ${p3.body?.type}`);
  expect((await detail(pid)).components[0].version === 2 && (await revisions(s1.id)).length === revCount, '409 之后版本或修订数变了');

  // 4 锁：实例里的元素直改 409；detach 放行；脱离后可改
  const h4 = await currentHtml(pid, s1.id);
  const navHtml = h4.html.match(/<nav[\s\S]*?<\/nav>/)![0];
  const aQid = qidIn(navHtml.match(/<a [^>]*>/)![0]);
  expect(aQid, 'nav 里第一条 <a> 没有 qid');
  const locked = await apiJson<{ type: string; component?: string }>(`/v1/screens/${s1.id}/elements/${aQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: 'Start' }], expectedRevisionId: h4.rev.id }) });
  expect(locked.status === 409 && locked.body.type === '/errors/component-locked' && locked.body.component === 'TabBar', `实例内直改该 409 component-locked：${locked.status} ${JSON.stringify(locked.body).slice(0, 200)}`);
  const det = await apiJson<{ revision: Rev }>(`/v1/screens/${s1.id}/elements/${aQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'detach' }], expectedRevisionId: h4.rev.id }) });
  expect(det.status === 201 && det.body.revision.sourceKind === 'manual', `detach 该 201 manual：${det.status} ${JSON.stringify(det.body).slice(0, 200)}`);
  const h4b = await currentHtml(pid, s1.id);
  expect(!/<nav [^>]*data-component=/.test(h4b.html) && linksInNav(h4b.html) === 2, '脱离后 nav 还带 data-component 或内容变了');
  const edited = await apiJson<{ revision: Rev }>(`/v1/screens/${s1.id}/elements/${aQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: 'Start' }], expectedRevisionId: h4b.rev.id }) });
  expect(edited.status === 201 && (await currentHtml(pid, s1.id)).html.includes('>Start<'), `脱离后直改该 201 且文案已换：${edited.status}`);

  // 5 改名跟随：只有仍在共享的 s2 / s3 回刷
  const s1Rev = (await detail(pid)).screens.find((x) => x.id === s1.id)!.currentRevisionId;
  const p5 = await apiJson<{ component: Comp; applied: string[] }>(`/v1/components/${comp.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'BottomNav', expectedVersion: 2 }) });
  expect(p5.status === 200 && p5.body.component.version === 3 && p5.body.applied.length === 2 && p5.body.applied.includes(s2.id) && p5.body.applied.includes(s3.id), `改名不对：${p5.status} ${JSON.stringify(p5.body).slice(0, 200)}`);
  for (const s of [s2, s3]) expect(/<nav [^>]*data-component="BottomNav"/.test((await currentHtml(pid, s.id)).html), `${s.route} 实例没跟着改名`);
  expect((await detail(pid)).screens.find((x) => x.id === s1.id)!.currentRevisionId === s1Rev, '已脱离的 /s1 不该被回刷');

  // 6 删组件屏不动
  const d6 = await detail(pid);
  const del = await apiJson(`/v1/components/${comp.id}`, { method: 'DELETE' });
  expect(del.status === 204, `删除返回 ${del.status}`);
  const d6b = await detail(pid);
  expect(d6b.components.length === 0 && d6b.screens.every((s) => s.currentRevisionId === d6.screens.find((x) => x.id === s.id)!.currentRevisionId), '删组件后屏变了或组件没删掉');
  expect(/<nav [^>]*data-component="BottomNav"/.test((await currentHtml(pid, s2.id)).html), '删组件后 /s2 里已展开的 HTML 不该被动');

  // 7 画布：重新提取，看组件卡、框选目标、检查器锁、新建组件
  const navQid2 = qidIn(navTag((await currentHtml(pid, s1.id)).html));
  const c7 = await post(`/v1/projects/${pid}/components`, { name: 'TabBar', fromScreenId: s1.id, qid: navQid2, applyToScreens: true });
  expect(c7.status === 201 && (c7.body.applied as string[]).length === 3, `重新提取不对：${c7.status} ${JSON.stringify(c7.body).slice(0, 200)}`);
  const cid = (c7.body.component as Comp).id;
  await page.goto(`${WEB}/p/${pid}`);
  const card = page.locator('[data-testid="component-card"][data-name="TabBar"]');
  await card.waitFor({ timeout: 15000 });
  expect((await card.locator('.label').innerText()).includes('用于 3 屏'), `卡片标签不对：${await card.locator('.label').innerText()}`);
  // 等预览页报了尺寸（卡片从整屏高缩到导航栏高）再框选，否则框到的是一张 844 高的卡
  await page.waitForFunction(() => { const el = document.querySelector('[data-testid="component-card"][data-name="TabBar"]') as HTMLElement | null; return !!el && el.getBoundingClientRect().height < 200; }, null, { timeout: 15000 });
  await page.keyboard.press('f');
  await page.waitForTimeout(500);
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x - 12, box.y + box.height + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const chip = page.getByTestId('component-chip');
  await chip.first().waitFor({ timeout: 5000 });
  expect((await chip.count()) === 1 && (await chip.first().innerText()).includes('TabBar'), `组件目标标签不对：${await chip.count()} ${await chip.first().innerText().catch(() => '')}`);
  expect((await page.getByTestId('verb-line').innerText()).includes('改组件「TabBar」'), `动词行不对：${await page.getByTestId('verb-line').innerText()}`);
  expect((await page.getByTestId('count-group').count()) === 0 && (await page.getByTestId('versions-group').count()) === 0, '只选组件时不该有屏数 / 版数档位');
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('nav[data-component="TabBar"] a').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await fl.locator('nav[data-component="TabBar"] a').first().click();
  const lock = page.getByTestId('el-component-lock');
  await lock.waitFor({ timeout: 5000 });
  expect((await lock.innerText()).includes('共享组件「TabBar」') && (await page.getByTestId('el-edit-component').count()) === 1 && (await page.getByTestId('el-detach').count()) === 1 && (await page.locator('#el-text').count()) === 0, '检查器锁定提示不对');
  await page.getByTestId('el-edit-component').click();
  await page.waitForTimeout(300);
  expect((await page.getByTestId('component-chip').count()) === 1 && (await page.getByTestId('target-chip').count()) === 0, '点「改组件」后目标区应只剩组件');
  expect(await page.evaluate(() => document.activeElement?.id === 'chat-input'), '点「改组件」后输入框没获得焦点');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Alt+c');
  await page.getByTestId('new-component-dialog').waitFor({ timeout: 5000 });
  await page.getByTestId('new-component-name').fill('Footer');
  await page.getByTestId('new-component-create').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="component-card"]').length === 2, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  expect((await page.getByTestId('component-chip').innerText()).includes('Footer'), `新建后目标区应为 Footer：${await page.getByTestId('component-chip').innerText()}`);
  if (!LIVE_LLM) return '提取 / 同步 / 回刷 / 版本冲突 / 锁与脱离 / 改名 / 删除 / 画布通过；真实回合跳过（LIVE_LLM=0）';

  // 8 真实 LLM：目标 TabBar，改第二个 tab 文案
  await page.locator('[data-testid="component-card"][data-name="TabBar"]').click();
  await page.waitForTimeout(300);
  expect((await page.getByTestId('component-chip').innerText()).includes('TabBar'), '点 TabBar 卡片后目标应是 TabBar');
  const versionBefore = (await detail(pid)).components.find((c) => c.id === cid)!.version;
  await page.locator('#chat-input').fill('把第二个 tab 的文案改成 Search，其他都别动。');
  const req = page.waitForRequest((x) => x.url().includes('/messages') && x.method() === 'POST');
  await page.keyboard.press('Enter');
  const sent = JSON.parse((await req).postData() ?? '{}') as { targetComponentIds?: string[] };
  expect(JSON.stringify(sent.targetComponentIds) === JSON.stringify([cid]), `消息没带 targetComponentIds=[cid]：${JSON.stringify(sent)}`);
  const row = page.locator('[data-testid="running-job"]').first();
  await row.waitFor({ timeout: 10000 });
  expect((await row.innerText()).includes('改组件「TabBar」'), `在跑作业行文案不对：${await row.innerText()}`);
  const { body: jobs } = await apiJson<{ items: Job[] }>(`/v1/projects/${pid}/jobs?limit=1`);
  expect(jobs.items[0].kind === 'edit_component', `作业类型 ${jobs.items[0].kind}`);
  const j8 = await waitJob(jobs.items[0].id, 300);
  expect(j8.status === 'succeeded', `edit_component ${j8.status}：${JSON.stringify(j8.output).slice(0, 300)}`);
  const d8 = await detail(pid);
  const c8 = d8.components.find((c) => c.id === cid)!;
  expect(c8.version === versionBefore + 1 && c8.summary.includes('Search'), `组件没升版或摘要没有 Search：v${c8.version} ${c8.summary}`);
  for (const sid of c8.usedBy) {
    const { rev, html } = await currentHtml(pid, sid);
    expect(rev.sourceKind === 'component' && rev.jobId === j8.id && html.includes('Search'), `${sid} 没按本作业回刷`);
  }
  const msgs = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${pid}/messages?limit=100`)).body.items;
  const reply = msgs.find((m) => m.jobId === j8.id && m.role === 'assistant');
  expect(reply?.content.startsWith('已更新组件「TabBar」') && /同步 \d+ 屏/.test(reply.content), `回执不对：${reply?.content}`);
  return `全部通过；真实回合 token 进/出 ${j8.output?.tokensIn}/${j8.output?.tokensOut}，同步 ${c8.usedBy.length} 屏；回执「${reply!.content.slice(0, 60)}」`;
});

await browser.close();
console.log(JSON.stringify({ run: RUN, results }, null, 2));
