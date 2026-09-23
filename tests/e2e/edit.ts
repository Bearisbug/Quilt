import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB, pickOption, selectedValue, eventually } from './lib.ts';

// docs/TEST.md EDIT 域（TC-EDIT-001~006）AI 执行脚本。
const RUN = process.env.RUN ?? '006';
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
type Detail = { screens: { id: string; route: string; currentRevisionId: string; screenshotUrl: string | null }[]; designSystem: { version: number; seedColor: string; tokens: { colors: Record<string, string> } } };
const detail = (id: string) => apiJson<Detail>(`/v1/projects/${id}`).then((r) => r.body);
const revisionHtml = async (screenId: string, revId: string) => { const r = await apiJson<{ revision: { htmlUrl: string; sourceKind: string; screenshotUrl: string | null } }>(`/v1/screens/${screenId}/revisions/${revId}`); return { ...r.body.revision, html: await (await fetch(r.body.revision.htmlUrl)).text() }; };
// linkedom 序列化把 data-qid 放在属性最前，兼容两种顺序
const qidOf = (html: string, attrSnippet: string) => {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*${attrSnippet}[^>]*>`))?.[0] ?? '';
  return tag.match(/data-qid="(q\d+)"/)?.[1] ?? null;
};

seed('seed');
const browser = await launch();
page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await openApp(page);
const focus = async (route: string) => {
  await page.locator(`[data-testid="screen-card"][data-route="${route}"] .gesture`).dblclick();
  await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  return page.frameLocator('.card.focused iframe');
};

let editProject = ''; let editScreen = '';
await step('TC-EDIT-001', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Edit', '--device', 'mobile', '--screens', '1');
  editProject = r.projectId; editScreen = r.screens[0].id;
  const before = await detail(editProject);
  const usageBefore = (await apiJson<{ tokensIn: number; tokensOut: number }>('/v1/me/usage')).body;
  await page.goto(`${WEB}/p/${editProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  // 选择元素可从静态卡片直接进（不必先双击进交互），且两种模式互斥：角标应显示「选择元素中」
  // 选择元素是全局模式：先开模式（不必先选中屏），再点哪一屏就进哪一屏
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  const src0 = await page.locator('.card.focused iframe').getAttribute('src');
  await fl.locator('#toggle').click();
  const textInput = page.locator('#el-text');
  await textInput.waitFor({ timeout: 5000 });
  expect((await textInput.inputValue()) === 'Follow', `检查器文案不是 Follow：${await textInput.inputValue()}`);
  // 常驻选中框：鼠标移开仍在该元素上，标签写 button · qid
  await fl.locator('h1').hover();
  await page.waitForTimeout(200);
  const selBox = fl.locator('[data-quilt-selection]');
  expect(await selBox.isVisible() && /^button · q\d+$/.test((await selBox.innerText()).trim()), `选中框没常驻或标签不对：${await selBox.innerText().catch(() => '无')}`);
  const toggleQid = (await selBox.getAttribute('data-qid')) ?? '';
  await textInput.fill('立即登录');
  const t0 = Date.now();
  await page.getByRole('button', { name: '保存（零 token）' }).click();
  await page.getByText('已更新，截图稍后刷新').waitFor({ timeout: 15000 });
  const ms = Date.now() - t0;
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 15000 });
  const after = await detail(editProject);
  const rev = after.screens[0].currentRevisionId;
  expect(rev !== before.screens[0].currentRevisionId, '未产生新修订');
  const r2 = await revisionHtml(editScreen, rev);
  expect(r2.sourceKind === 'manual' && r2.html.includes('>立即登录<'), 'sourceKind/文案不对');
  // 直改后的新修订经聚焦态热更新 swap 进 iframe（v0.33）：不重挂，src 不变；等它出现而不是睡固定时长
  await fl.locator('#toggle', { hasText: '立即登录' }).waitFor({ timeout: 15000 });
  expect((await page.locator('.card.focused iframe').getAttribute('src')) === src0, '直改后 iframe 被重挂（src 变了）');
  // 热更新后按 qid 重选：检查器不退回空态，「文案」字段刷成新值
  let reselected = false;
  for (let i = 0; i < 20 && !reselected; i++) { await page.waitForTimeout(250); reselected = (await page.locator('#el-text').count()) === 1 && (await page.locator('#el-text').inputValue()) === '立即登录'; }
  expect(reselected, `热更新后检查器未重新选中同一元素或字段未刷新（#el-text=${(await page.locator('#el-text').count()) ? await page.locator('#el-text').inputValue() : '空态'}）`);
  // 直改后：选中框仍在同一元素上，元素挂「已更新」角标
  await fl.locator('[data-quilt-mark][data-kind="done"]').waitFor({ timeout: 8000 });
  expect((await fl.locator('[data-quilt-selection]').getAttribute('data-qid')) === toggleQid, '热更新后选中框没接回同一元素');
  const usageAfter = (await apiJson<{ tokensIn: number; tokensOut: number }>('/v1/me/usage')).body;
  expect(usageAfter.tokensIn === usageBefore.tokensIn && usageAfter.tokensOut === usageBefore.tokensOut, '直改消耗了 token');
  let shot = false;
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 1000)); if ((await revisionHtml(editScreen, rev)).screenshotUrl) { shot = true; break; } }
  expect(shot, '10 s 内截图未更新');
  await page.keyboard.press('Escape');
  return `保存响应 ${ms} ms`;
});

await step('TC-EDIT-002', async () => {
  const d = await detail(editProject);
  const cur = d.screens[0].currentRevisionId;
  const html = (await revisionHtml(editScreen, cur)).html;
  const qid = qidOf(html, 'id="toggle"')!;
  const revsBefore = (await apiJson<{ items: unknown[] }>(`/v1/screens/${editScreen}/revisions`)).body.items.length;
  const bad = await apiJson<{ type: string; violations: { rule: string }[] }>(`/v1/screens/${editScreen}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'style', value: 'color:#ff0000' }], expectedRevisionId: cur }) });
  // v0.43：偏离不再阻断写入，改为断言修订照样落地、偏离被记下来
  expect(bad.status === 201, `直改应照常落修订，返回 ${bad.status}`);
  expect(bad.body.violations.some((v) => v.rule === 'no-raw-hex' || v.rule === 'no-inline-style'), 'violations 未指出裸色值/内联样式');
  expect((await apiJson<{ items: unknown[] }>(`/v1/screens/${editScreen}/revisions`)).body.items.length === revsBefore, '违规仍产生了修订');
  const ok = await apiJson<{ revision: { id: string } }>(`/v1/screens/${editScreen}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'classes', value: 'inline-flex items-center justify-center h-12 px-6 rounded-full bg-secondary-container text-on-secondary-container font-semibold' }], expectedRevisionId: cur }) });
  expect(ok.status === 201, `token 类改动返回 ${ok.status} ${JSON.stringify(ok.body)}`);
});

let subProject = ''; let subScreen = '';
await step('TC-EDIT-003', async () => {
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Subtree', '--device', 'mobile', '--screens', '1');
  subProject = r.projectId; subScreen = r.screens[0].id;
  const d = await detail(subProject);
  const cur = d.screens[0].currentRevisionId;
  const oldHtml = (await revisionHtml(subScreen, cur)).html;
  const qid = qidOf(oldHtml, 'class="max-h-48')!; // 30 行列表容器
  expect(qid, '未找到列表容器 qid');
  const headerOld = oldHtml.match(/<header[\s\S]*?<\/header>/)![0];
  const navOld = oldHtml.match(/<nav[\s\S]*?<\/nav>/)![0];
  // 前置：选择元素态进屏——热更新（v0.33）要在不退出交互的前提下看到
  await page.goto(`${WEB}/p/${subProject}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  const container = fl.locator(`[data-qid="${qid}"]`);
  await container.waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  const src0 = await page.locator('.card.focused iframe').getAttribute('src');
  const innerOld = await container.evaluate((el) => el.innerHTML);
  // 1a 通道单独选（v0.34）：默认沿用输入框当前通道；改选另一个可用云端通道后刷新重进仍记住，输入框不受影响
  await container.evaluate((el) => (el as HTMLElement).click());
  await page.locator('#el-prompt').waitFor({ timeout: 5000 });
  const catalog = (await apiJson<{ items: { id: string; label: string; available: boolean; hidden?: boolean; runner: { kind: string; model?: string } }[]; default: string }>('/v1/runners')).body;
  const composerRunner = (await selectedValue(page, '[data-testid="runner-select"]')) || catalog.default;
  expect((await selectedValue(page, '[data-testid="el-runner-select"]')) === composerRunner, `检查器通道默认应沿用输入框当前通道 ${composerRunner}，实际 ${await selectedValue(page, '[data-testid="el-runner-select"]')}`);
  const alt = catalog.items.find((i) => i.available && !i.hidden && i.runner.kind !== 'agent' && i.id !== composerRunner);
  if (alt) {
    await pickOption(page, '[data-testid="el-runner-select"]', alt.label);
    expect((await selectedValue(page, '[data-testid="el-runner-select"]')) === alt.id && (await selectedValue(page, '[data-testid="runner-select"]')) === composerRunner, '检查器改选通道后输入框的通道不该跟着变');
    await page.reload();
    await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    await container.waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    await container.evaluate((el) => (el as HTMLElement).click());
    await page.locator('#el-prompt').waitFor({ timeout: 5000 });
    expect((await selectedValue(page, '[data-testid="el-runner-select"]')) === alt.id, '刷新重进后检查器的通道没记住');
  }
  // 1 检查器里用 AI 重生成（容器已选中）：文本框里 Shift+Enter 即发（v0.34），按钮旁标有该键
  await page.fill('#el-prompt', 'Turn this list into a horizontal scrolling row of small cards with an image and a title each');
  expect((await page.locator('kbd', { hasText: 'Shift+Enter' }).count()) === 1, '重生成按钮旁没标 Shift+Enter');
  await page.locator('#el-prompt').press('Shift+Enter');
  await page.waitForTimeout(1500);
  // 发出后检查器留在这个元素上：说明框清空、字段还在，不退回空态；屏内 q40 挂「修改中…」角标，检查器写明正在改
  expect((await page.locator('#el-prompt').count()) === 1 && (await page.locator('#el-prompt').inputValue()) === '' && (await page.locator('#el-text').count()) === 1, '发出重生成后检查器退回了空态或说明框没清');
  await fl.locator('[data-quilt-mark][data-kind="working"]').waitFor({ timeout: 8000 });
  await page.getByTestId('el-working').waitFor({ timeout: 5000 });
  const jobs = await apiJson<{ items: { id: string; kind: string; input: { runner?: { model?: string } } }[] }>(`/v1/projects/${subProject}/jobs?limit=1`);
  expect(jobs.body.items[0]?.kind === 'regenerate_subtree', `未创建 regenerate_subtree 作业：${JSON.stringify(jobs.body.items[0] ?? null)}`);
  if (alt) expect(jobs.body.items[0].input.runner?.model === alt.runner.model, `作业未带检查器改选的通道：${JSON.stringify(jobs.body.items[0].input.runner)}`);
  const done = await waitJob(jobs.body.items[0].id);
  expect(done.status === 'succeeded', `作业 ${done.status} ${JSON.stringify(done.output).slice(0, 200)}`);
  // 2 不退出交互：iframe 内 q40 子树换新（旧 innerHTML 消失或该 qid 已被新子树顶掉）；src 不变、角标仍「选择元素中」
  let innerNow: string | null = innerOld;
  for (let i = 0; i < 20 && innerNow === innerOld; i++) { await page.waitForTimeout(500); innerNow = await fl.locator('body').evaluate((b, q) => b.querySelector(`[data-qid="${q}"]`)?.innerHTML ?? null, qid); }
  expect(innerNow !== innerOld, '作业完成 10 s 内 iframe 里的子树没有换新（仍需退出交互才能看到）');
  expect((await page.locator('.card.focused iframe').getAttribute('src')) === src0, '热更新重挂了 iframe（src 变了）');
  expect((await page.locator('.card.focused .badge').innerText()).includes('选择元素中'), '热更新后角标不再是「选择元素中」');
  // 根沿用原 qid：热更新后 q40 挂「已更新」角标，检查器重选后仍停在 q40 上
  await fl.locator('[data-quilt-mark][data-kind="done"]').waitFor({ timeout: 8000 });
  await page.getByText(`· ${qid}`).waitFor({ timeout: 5000 });
  expect((await page.locator('#el-text').count()) === 1, '热更新后检查器没有重选到 q40');
  const d2 = await detail(subProject);
  const newRev = d2.screens[0].currentRevisionId;
  expect(newRev !== cur, '未产生新修订');
  const newHtml = (await revisionHtml(subScreen, newRev)).html;
  expect((newHtml.match(new RegExp(`data-qid="${qid}"`, 'g')) ?? []).length === 1, '替换后的根应恰好保留一次原 qid');
  expect(newHtml.includes(headerOld) && newHtml.includes(navOld), '兄弟节点（header/nav）被改动');
  return `子树 ${qid} 已替换`;
});

await step('TC-EDIT-004', async () => {
  const d = await detail(editProject);
  const cur = d.screens[0].currentRevisionId;
  const r = await apiJson<{ type: string }>(`/v1/projects/${editProject}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: editScreen, qid: 'q999', prompt: 'x', expectedRevisionId: cur } }), headers: { 'Idempotency-Key': crypto.randomUUID() } });
  expect(r.status === 404 && r.body.type === '/errors/element-not-found', `返回 ${r.status} ${r.body?.type}`);
  expect((await detail(editProject)).screens.length === 1, 'screens 变化');
});

let dsProject = '';
await step('TC-EDIT-005', async () => {
  const r = seedJson<{ projectId: string }>('seed:project', '--name', 'DS', '--device', 'mobile', '--screens', '10', '--no-shot');
  dsProject = r.projectId;
  const before = await detail(dsProject);
  await page.goto(`${WEB}/p/${dsProject}`);
  await page.locator('[data-testid="style-guide"]').waitFor();
  await page.locator('[data-testid="style-guide"]').click();
  await page.locator('#ds-seed').waitFor();
  await page.fill('input[aria-label="种子色十六进制"]', '#C2410C');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('设计系统已保存').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const mid = await detail(dsProject);
  expect(mid.designSystem.version === before.designSystem.version + 1 && mid.designSystem.seedColor === '#C2410C', `version/seed 未更新: ${mid.designSystem.version} ${mid.designSystem.seedColor}`);
  const primary = mid.designSystem.tokens.colors.primary;
  const rgb = [parseInt(primary.slice(1, 3), 16), parseInt(primary.slice(3, 5), 16), parseInt(primary.slice(5, 7), 16)];
  expect(rgb[0] > rgb[2], `primary 不是暖色: ${primary}`);
  // 保存成功即弹「回刷所有屏？」（v0.38）：面板那颗同名键此刻被 inert 挡着，要点弹层里的确认键
  await page.getByTestId('ds-apply-confirm').click();
  await page.locator('.bg-panel-2', { hasText: '设计系统已回刷 10 屏' }).waitFor({ timeout: 120000 });
  const after = await detail(dsProject);
  for (const s of after.screens) {
    const prev = before.screens.find((x) => x.id === s.id)!;
    expect(s.currentRevisionId !== prev.currentRevisionId, `${s.route} 未回刷`);
  }
  for (const s of after.screens.slice(0, 3)) {
    const rev = await revisionHtml(s.id, s.currentRevisionId);
    expect(rev.sourceKind === 'apply_ds' && rev.html.includes(`--color-primary:${primary}`), `${s.route} prelude 未更新`);
  }
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 60000 });
  const fl = await focus('/s1');
  const bg = await fl.locator('#toggle').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg === `rgb(${rgb.join(', ')})`, `主按钮色 ${bg} ≠ ${primary}`);
  await page.keyboard.press('Escape');
  return `primary=${primary}`;
});

await step('TC-EDIT-006', async () => {
  await page.goto(`${WEB}/p/${dsProject}?panel=design`);
  await page.locator('#ds-font').waitFor();
  seedJson('seed:design-system', '--project', dsProject, '--bump');
  await pickOption(page, '#ds-font', 'Manrope');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('设计系统已被更新').waitFor({ timeout: 10000 });
  await page.reload();
  await page.locator('#ds-font').waitFor();
  await pickOption(page, '#ds-font', 'Manrope');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('设计系统已保存').waitFor({ timeout: 10000 });
  const d = await detail(dsProject);
  expect((d.designSystem.tokens as { typography?: { fontFamily: string } }).typography?.fontFamily === 'Manrope', '字体未保存');
});

// v0.6：检查器手动连线（link 操作零 token）+ 表单去掉 action 被 form-action 规则拒绝
await step('TC-EDIT-007', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Link', '--device', 'mobile', '--screens', '2', '--form');
  const s1 = r.screens[0].id;
  const edgesOf = async () => (await apiJson<{ edges: { fromScreenId: string; href: string; toScreenId: string | null }[] }>(`/v1/projects/${r.projectId}/app-map`)).body.edges.filter((e) => e.fromScreenId === s1 && e.href === '/s2').length;
  const edgesBefore = await edgesOf();
  const usageBefore = (await apiJson<{ tokensIn: number; tokensOut: number }>('/v1/me/usage')).body;
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+e');
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await fl.locator('#toggle').click();
  const sel = page.getByTestId('el-link');
  await sel.waitFor({ timeout: 5000 });
  expect((await selectedValue(page, '[data-testid="el-link"]')) === '__none__', `未连线按钮的「跳转到」应为「不跳转」，实际 ${await selectedValue(page, '[data-testid="el-link"]')}`);
  await pickOption(page, '[data-testid="el-link"]', '/s2');
  await page.getByRole('button', { name: '保存（零 token）' }).click();
  await page.getByText('已更新，截图稍后刷新').waitFor({ timeout: 15000 });
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 15000 });
  const rev = (await detail(r.projectId)).screens.find((s) => s.id === s1)!.currentRevisionId;
  const r2 = await revisionHtml(s1, rev);
  expect(r2.sourceKind === 'manual' && /<button[^>]*data-href="\/s2"[^>]*id="toggle"|<button[^>]*id="toggle"[^>]*data-href="\/s2"/.test(r2.html), '按钮未带 data-href="/s2"');
  expect((await edgesOf()) === edgesBefore + 1, `s1→/s2 边数应 +1（${edgesBefore} → ${await edgesOf()}）`);
  const usageAfter = (await apiJson<{ tokensIn: number; tokensOut: number }>('/v1/me/usage')).body;
  expect(usageAfter.tokensIn === usageBefore.tokensIn && usageAfter.tokensOut === usageBefore.tokensOut, '连线消耗了 token');
  // 选择元素态与交互态互斥：退出选择元素会回到静态卡片，要验跳转得重新双击进交互
  await page.getByRole('button', { name: '选择元素中' }).click();

  await eventually(async () => expect((await page.locator('.card.focused').count()) === 0, '退出选择元素后卡片未回到静态'));
  const fl2 = await focus('/s1');
  await fl2.locator('#toggle').click();
  await page.locator('.card.focused .badge', { hasText: '/s2' }).waitFor({ timeout: 10000 });
  const formQid = qidOf(r2.html, 'action="/s2"')!;
  const bad = await apiJson<{ type: string }>(`/v1/screens/${s1}/elements/${formQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'link', value: null }], expectedRevisionId: rev }) });
  expect(bad.status === 201, `表单去掉 action 也应照常落修订（v0.43），得到 ${bad.status}`);
  await page.keyboard.press('Escape');
});

// TC-EDIT-008 元素批注：攒一批再一起发（REQ-EDIT-004）
await step('TC-EDIT-008', async () => {
  if (!LIVE_LLM) throw new Error('LIVE_LLM=0');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Anno', '--device', 'mobile', '--screens', '1');
  const s1 = r.screens[0].id;
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });

  // 进批注态：与选择元素同源入口，不必先双击进交互
  // 批注同样是全局模式
  await page.keyboard.press('Alt+n');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.locator('.card.focused .badge', { hasText: '批注中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  // quilt:mode 是在 iframe ready 之后才发过去的；抢在它送达前点，元素点击会被当成普通交互而非选中
  // 必须等面板的标签真的换成这个元素——只等输入框可用是不够的：上一次选中会让它一直可用，
  // 于是第二条批注会悄悄挂到同一个元素上（实测踩过）
  // 按选中的 qid 变化判定：只等输入框可用不行（上一次选中会让它一直可用，第二条会悄悄挂到同一元素），
  // 按文案也不行（容器类元素没有直接文本节点）
  const pickedQid = () => page.getByTestId('anno-target').getAttribute('data-qid');
  const pickElement = async (sel: string) => {
    const from = await pickedQid();
    for (let i = 0; i < 6; i++) {
      await fl.locator(sel).first().click();
      await page.waitForTimeout(600);
      const now = await pickedQid();
      if (now && now !== from) return now;
    }
    throw new Error(`点选 ${sel} 后选中的元素没变（仍为 ${from || '空'}）`);
  };
  // 换一个元素：直接遍历带 qid 的可点元素，点到选中变了为止（不依赖任何文案/选择器猜测）
  const pickAnother = async () => {
    const from = await pickedQid();
    const n = await fl.locator('[data-qid]').count();
    for (let i = 0; i < Math.min(n, 20); i++) {
      const el = fl.locator('[data-qid]').nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      const now = await pickedQid();
      if (now && now !== from) return now;
    }
    throw new Error(`遍历 ${n} 个带 qid 的元素后选中仍为 ${from || '空'}`);
  };

  // 第 1 条
  await pickElement('#toggle');
  await page.fill('#anno-note', '这个按钮改成次要样式');
  await page.getByRole('button', { name: '记下（不发送）' }).click();
  await page.locator('[data-testid="anno-item"]').first().waitFor({ timeout: 10000 });

  // 第 2 条（换一个元素）
  await pickAnother();
  await page.fill('#anno-note', '这一行右边加个数量角标');
  await page.getByRole('button', { name: '记下（不发送）' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="anno-item"]').length === 2, null, { timeout: 10000 });

  // 气泡画在画布层，编号可见
  expect((await page.locator('[data-testid="anno-pin"]').count()) === 2, `画布上批注气泡不是 2 个，实际 ${await page.locator('[data-testid="anno-pin"]').count()}`);
  const before = (await apiJson<{ items: { id: string; qid: string; status: string }[] }>(`/v1/screens/${s1}/annotations`)).body.items;
  expect(before.length === 2 && before.every((a) => a.status === 'open'), '批注未落库或状态不对');
  // 保存过一条之后仍然能换元素——previewUrl 每次 refresh 都重新签名，
  // 若 iframe 的 src 不钉住就会静默重载、掉回 interact 模式，选择元素当场失效（实测踩过）
  expect(before[0].qid !== before[1].qid, `两条批注挂在了同一个元素上（qid ${before[0].qid}）——保存后选不中别的元素`);

  // 一起发送：2 条批注合成 1 个作业（不是 2 个）
  const jobsBefore = (await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${r.projectId}`)).body.activeJobs.length;
  await page.getByTestId('send-annotations').click();
  await page.waitForTimeout(2500);
  const afterSend = (await apiJson<{ items: { status: string; sentJobId: string | null }[] }>(`/v1/screens/${s1}/annotations`)).body.items;
  expect(afterSend.every((a) => a.status === 'sent'), '发送后批注未置为 sent');
  const jobIds = new Set(afterSend.map((a) => a.sentJobId));
  expect(jobIds.size === 1 && [...jobIds][0], `2 条批注应合成 1 个作业，实际 ${jobIds.size} 个`);
  const jobId = [...jobIds][0]!;
  const job = (await apiJson<{ job: { kind: string; input: { prompt: string; screenIds: string[] } } }>(`/v1/jobs/${jobId}`)).body.job;
  expect(job.kind === 'edit_screens' && job.input.screenIds.length === 1, `作业类型/目标屏不对：${job.kind}`);
  expect(job.input.prompt.includes('次要样式') && job.input.prompt.includes('数量角标') && /data-qid="q\d+"/.test(job.input.prompt), '合并指令未包含两条批注与元素定位');
  expect(jobsBefore === 0, '发送前不应已有进行中作业');

  // 作业完成后批注收口为已处理，画布上的气泡随之消失
  const done = await waitJob(jobId, 240);
  expect(done.status === 'succeeded', `作业未成功：${done.status}`);
  const resolved = (await apiJson<{ items: { status: string }[] }>(`/v1/screens/${s1}/annotations`)).body.items;
  expect(resolved.every((a) => a.status === 'resolved'), `作业成功后批注未置为 resolved：${resolved.map((a) => a.status).join(',')}`);
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor();

  await eventually(async () => expect((await page.locator('[data-testid="anno-pin"]').count()) === 0, '已处理的批注仍在画布上留着气泡'));
  return '2 条批注合成 1 个作业；成功后收口为已处理、气泡收起';
});

// v0.31 REQ-EDIT-003：设计系统只显式改——⌘A + 发送不碰设计系统；回执「记为约定」→ 提炼 → 预览 → 写入约定节
await step('TC-EDIT-009', async () => {
  const { startOpenAiStub } = await import('./openai-stub.ts');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Conv', '--device', 'mobile', '--screens', '2', '--no-shot');
  const rev0 = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${r.screens[0].id}/revisions`)).body.items[0];
  const body0 = (await (await fetch(rev0.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
  const PROPOSAL = JSON.stringify({ summary: '正文与标题字号定为绝对值', conventions: ['正文字号 text-base（16px），不再用 text-sm 做正文', '页面标题 text-xl'], regenerate: true });
  const stub = startOpenAiStub({ port: 3996, apiKey: 'good-key-0004', reply: (hit) => (hit.user.startsWith('INSTRUCTION:') ? PROPOSAL : body0.replace('text-sm">Item', 'text-base">Item')) });
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 约定', endpoint: stub.url, model: 'stub-4', apiKey: 'good-key-0004' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    const version0 = (await detail(r.projectId)).designSystem.version;
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor();
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 约定');
    // 1 ⌘A + 发送 = 普通改全部，设计系统 version 不变
    await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.fill('#chat-input', '所有页面正文字再大一点');
    await page.keyboard.press('Enter');
    await page.locator('.bg-panel-2', { hasText: '已更新 2 屏' }).waitFor({ timeout: 120000 });
    expect((await detail(r.projectId)).designSystem.version === version0, '⌘A + 发送不该改设计系统');
    // 2 回执「记为约定」→ propose_design_system 作业（instruction = 原指令、screenId = 一张改后的屏）→ 预览对话框列出绝对规则
    const remember = page.getByTestId('remember-convention').last();
    await remember.waitFor({ timeout: 5000 });
    const req = page.waitForRequest((x) => x.url().includes('/jobs') && x.method() === 'POST');
    await remember.click();
    const job = JSON.parse((await req).postData() ?? '{}') as { kind: string; input: { instruction: string; screenId?: string } };
    expect(job.kind === 'propose_design_system' && job.input.instruction === '所有页面正文字再大一点' && !!job.input.screenId, `提炼作业不对：${JSON.stringify(job)}`);
    const dlg = page.getByTestId('ds-proposal');
    await dlg.waitFor({ timeout: 60000 });
    const items = await dlg.locator('input[type="checkbox"]').count();
    expect(items === 2, `预览应列出 2 条约定，实际 ${items}`);
    expect(!(await dlg.innerText()).includes('再大一点'), '约定里不该出现相对表述');
    // 3 确认写入 → 问是否重生成 → 只写入：DESIGN.md 出现「## 约定」、version+1；面板列出 2 条约定
    await page.getByTestId('ds-proposal-confirm').click();
    await page.getByTestId('ds-proposal-write-only').waitFor({ timeout: 5000 });
    await page.getByTestId('ds-proposal-write-only').click();
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(500);
    const d1 = await detail(r.projectId);
    const md = (d1.designSystem as unknown as { designMd: string }).designMd;
    expect(d1.designSystem.version === version0 + 1 && md.includes('## 约定') && md.includes('text-base（16px）'), `约定未写入：version ${d1.designSystem.version}`);
    await page.getByTestId('ds-conventions').waitFor({ timeout: 5000 });
    expect((await page.getByTestId('ds-conventions').locator('li').count()) === 2, '设计系统面板未列出 2 条约定');
    // 4 面板删除一条 → 剩 1 条、version 再 +1
    await page.getByTestId('ds-conventions').locator('li').first().getByRole('button').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ds-conventions"] li').length === 1, null, { timeout: 10000 });
    expect((await detail(r.projectId)).designSystem.version === version0 + 2, '删除约定后 version 未 +1');
    return '⌘A 不改设计系统；记为约定 → 提炼作业 → 预览 2 条绝对规则 → 只写入 → 约定节 + version+1；面板可删';
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
});

await step('TC-EDIT-010', async () => {
  // 品牌色板（REQ-EDIT-005）：逐键覆盖种子派生值，亮 / 暗两套，改完按原路回刷
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Palette', '--device', 'mobile', '--screens', '2', '--no-shot');
  type DS = { designSystem: { version: number; colorMode: string; palette: unknown; tokens: { colors: Record<string, string> } } };
  const ds = async () => (await apiJson<DS>(`/v1/projects/${projectId}`)).body.designSystem;
  const put = (body: unknown) => apiJson<DS>(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify(body) });
  const before = await ds();
  // 1 任何项目都有语义色：没挂色板也能用 success / warning
  expect(!!before.tokens.colors.success && !!before.tokens.colors.warning && !!before.tokens.colors.onSuccess, '种子派生的 token 缺语义色');
  const derivedSecondary = before.tokens.colors.secondary;
  // 2 挂三键品牌色板：这三键取原值，其余仍是派生值
  const r1 = await put({ palette: { light: { primary: '#284CCA', background: '#F4F1EA', success: '#1D7153' } }, expectedVersion: before.version });
  expect(r1.status === 200, `挂色板返回 ${r1.status}`);
  let cur = await ds();
  expect(cur.tokens.colors.primary === '#284CCA' && cur.tokens.colors.background === '#F4F1EA' && cur.tokens.colors.success === '#1D7153', `品牌键未取原值：${JSON.stringify(cur.tokens.colors).slice(0, 120)}`);
  expect(cur.tokens.colors.secondary === derivedSecondary, '没覆盖的键不该跟着变');
  expect(cur.version === before.version + 1, 'version 未 +1');
  // 3 回刷：prelude 换成品牌色，body 一字不改
  const screens = (await apiJson<{ screens: { id: string }[] }>(`/v1/projects/${projectId}`)).body.screens;
  const bodyOf = async (screenId: string) => {
    const revs = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screenId}/revisions`)).body.items;
    const html = await (await fetch(revs[0].htmlUrl)).text();
    return { html, body: html.split('<body')[1] };
  };
  const b0 = await bodyOf(screens[0].id);
  const job = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: 'all' } }) });
  expect(job.status === 202, `回刷作业返回 ${job.status}`);
  const done = await waitJob(job.body.job.id, 120);
  expect(done.status === 'succeeded', `回刷未成功：${done.status}`);
  const b1 = await bodyOf(screens[0].id);
  expect(b1.html.includes('--color-primary:#284CCA') && b1.html.includes('--color-success:#1D7153'), 'prelude 没换成品牌色');
  expect(b1.body === b0.body, '回刷不该动 body');
  // 4 没有暗色色板时不许切暗色；给了就能切
  cur = await ds();
  const bad = await apiJson(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify({ colorMode: 'dark', expectedVersion: cur.version }) });
  expect(bad.status === 400, `无暗色色板时切暗色应 400，实际 ${bad.status}`);
  const r2 = await put({ palette: { light: { primary: '#284CCA' }, dark: { primary: '#AFCBFF', background: '#111820' } }, colorMode: 'dark', expectedVersion: cur.version });
  expect(r2.status === 200 && r2.body.designSystem.tokens.colors.primary === '#AFCBFF' && r2.body.designSystem.tokens.colors.background === '#111820', '切暗色后没用暗色色板');
  // 5 清空回到纯派生
  cur = await ds();
  const r3 = await put({ palette: null, colorMode: 'light', expectedVersion: cur.version });
  expect(r3.status === 200 && r3.body.designSystem.tokens.colors.primary === before.tokens.colors.primary && r3.body.designSystem.tokens.colors.background === before.tokens.colors.background, '清空后没回到种子派生');
  // 6 面板：来源写明、26 键、清空按钮
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.locator('.styleguide').click();
  const section = page.getByTestId('palette-section');
  await section.waitFor({ timeout: 5000 });
  expect((await section.getByTestId('palette-toggle').innerText()).includes('种子派生'), '清空后面板仍显示品牌色板');
  await section.getByTestId('palette-toggle').click();
  await page.getByTestId('palette-grid').waitFor({ timeout: 5000 });
  expect((await page.locator('[data-testid="palette-grid"] li').count()) === 26, '色板表应有 26 个 token 色键');
  expect((await page.locator('[data-testid="palette-grid"] li[data-source="brand"]').count()) === 0, '清空后不该还有品牌键');
  return '语义色任何项目都有；三键色板只覆盖三键、其余仍派生；回刷只换 prelude；无暗色色板拒绝切暗色；清空回到纯派生；面板 26 键并写明来源';
});

await step('TC-EDIT-011', async () => {
  // 字体来源（REQ-EDIT-003 v0.44）：Google 任意族名 / 本机字体不发外链 / 自定义样式表链接；来源为 url 却没链接 → 400
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Fonts', '--device', 'mobile', '--screens', '1', '--no-shot');
  type DS = { designSystem: { version: number; tokens: { typography: { fontFamily: string; fontSource?: string; fontUrl?: string | null } } } };
  const ds = async () => (await apiJson<DS>(`/v1/projects/${projectId}`)).body.designSystem;
  const put = (body: unknown) => apiJson<DS>(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify(body) });
  const screen = (await apiJson<{ screens: { id: string }[] }>(`/v1/projects/${projectId}`)).body.screens[0];
  const headAfterApply = async () => {
    const job = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: 'all' } }) });
    expect(job.status === 202, `回刷作业返回 ${job.status}`);
    const done = await waitJob(job.body.job.id, 120);
    expect(done.status === 'succeeded', `回刷未成功：${done.status}`);
    const revs = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screen.id}/revisions`)).body.items;
    return (await (await fetch(revs[0].htmlUrl)).text()).split('<body')[0];
  };
  const fontOf = (head: string) => head.match(/font-family:[^;]+/)?.[0] ?? '(无 font-family)';
  // 1 白名单外的 Google 族名
  let cur = await ds();
  const r1 = await put({ fontFamily: 'Plus Jakarta Sans', fontSource: 'google', expectedVersion: cur.version });
  expect(r1.status === 200 && r1.body.designSystem.tokens.typography.fontSource === 'google', `Google 族名保存返回 ${r1.status}`);
  let head = await headAfterApply();
  expect(head.includes('fonts.googleapis.com/css2?family=Plus%20Jakarta%20Sans'), 'prelude 没发 Google Fonts 链接');
  expect(head.includes('font-family:"Plus Jakarta Sans",system-ui'), `font-family 没以族名开头：${fontOf(head)}`);
  // 2 本机字体：不发任何外链，族名后面是本机字体栈
  cur = await ds();
  const r2 = await put({ fontFamily: 'PingFang SC', fontSource: 'system', expectedVersion: cur.version });
  expect(r2.status === 200, `本机字体保存返回 ${r2.status}`);
  head = await headAfterApply();
  // 运行时脚本里有 link[href*="fonts.googleapis.com/css"] 这个选择器字面量，所以只认 <link> 标签本身
  expect(!head.includes('<link href="https://fonts.googleapis.com'), '本机字体不该发 Google Fonts 链接');
  expect(head.includes('font-family:"PingFang SC",-apple-system'), `本机字体栈不对：${fontOf(head)}`);
  // 3 自定义链接
  cur = await ds();
  const r3 = await put({ fontFamily: 'Manrope', fontSource: 'url', fontUrl: 'https://fonts.bunny.net/css?family=manrope:400,600', expectedVersion: cur.version });
  expect(r3.status === 200, `自定义链接保存返回 ${r3.status}`);
  head = await headAfterApply();
  expect(head.includes('<link href="https://fonts.bunny.net/css?family=manrope:400,600" rel="stylesheet">'), 'prelude 没发自定义样式表链接');
  expect(!head.includes('<link href="https://fonts.googleapis.com'), '自定义链接来源不该再发 Google Fonts 链接');
  // 4 来源 url 却没链接 → 400；族名带引号 → 400（它会进 <link>、CSS 与 JS 字符串）
  cur = await ds();
  const bad = await apiJson(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify({ fontSource: 'url', fontUrl: null, expectedVersion: cur.version }) });
  expect(bad.status === 400, `缺链接应 400，实际 ${bad.status}`);
  const bad2 = await apiJson(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify({ fontFamily: 'Inter"; }', expectedVersion: cur.version }) });
  expect(bad2.status === 400, `带引号的族名应 400，实际 ${bad2.status}`);
  expect((await ds()).version === cur.version, '被拒的请求不该改 version');
  // 5 面板：回显来源与链接、缺链接就地报错不提交、切来源收起链接框
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.locator('.styleguide').click();
  await page.getByTestId('ds-font-source').waitFor({ timeout: 5000 });
  expect((await page.getByTestId('ds-font-source').getAttribute('data-value')) === 'url', '面板没回显当前来源');
  expect((await page.getByTestId('ds-font-url').inputValue()).includes('fonts.bunny.net'), '面板没回显样式表地址');
  await page.getByTestId('ds-font-url').fill('');
  await page.getByTestId('ds-save').click();
  await page.locator('#ds-font-url-error').waitFor({ timeout: 3000 });
  expect((await ds()).version === cur.version, '就地报错后不该提交');
  await page.locator('[data-testid="ds-font-source"] label', { hasText: '本机字体' }).click();
  expect((await page.getByTestId('ds-font-url').count()) === 0, '切到本机字体后链接框应收起');
  return 'Google 任意族名进 prelude 链接；本机字体不发外链、栈以族名开头带 -apple-system 回退；自定义链接原样进 <link>；缺链接 / 带引号族名 400；面板回显、就地报错、切来源收起链接框';
});

await browser.close();
console.log(`\n=== RUN-${RUN} EDIT ===`, JSON.stringify(results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {})));
console.log(results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
