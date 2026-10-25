import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NEUTRAL_PALETTE, tokensFromSeed } from '@quilt/core';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB, pickOption, selectedValue, eventually } from './lib.ts';
import { suite, expect, softly, waitJob, needLiveLlm, restartApi } from './harness.ts';

// docs/TEST.md EDIT 域（TC-EDIT-001~006）AI 执行脚本。
await mkdir(EVIDENCE, { recursive: true });
let page: import('playwright').Page;
const { RUN, step, summary } = suite('EDIT', {
  page: () => page,
  onTimeout: async () => { await page.close().catch(() => {}); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await openApp(page); },
});
type Detail = { screens: { id: string; route: string; currentRevisionId: string; screenshotUrl: string | null }[]; designSystem: { version: number; seedColor: string; tokens: { colors: Record<string, string> } } };
const detail = (id: string) => apiJson<Detail>(`/v1/projects/${id}`).then((r) => r.body);
const revisionHtml = async (screenId: string, revId: string) => { const r = await apiJson<{ revision: { htmlUrl: string; sourceKind: string; screenshotUrl: string | null } }>(`/v1/screens/${screenId}/revisions/${revId}`); return { ...r.body.revision, html: await (await fetch(r.body.revision.htmlUrl)).text() }; };
// linkedom 序列化把 data-qid 放在属性最前，兼容两种顺序
const qidOf = (html: string, attrSnippet: string) => {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*${attrSnippet}[^>]*>`))?.[0] ?? '';
  return tag.match(/data-qid="(q\d+)"/)?.[1] ?? null;
};
// 画布上发出去的一轮做完了没有：等项目最新那个作业到终态（界面上只有作业 chip，成功的 1 s 后就淡出，不作判据）
const waitLatestJob = async (pid: string, kind: string, maxSec = 180) => {
  let id = '';
  await eventually(async () => {
    const j = (await apiJson<{ items: { id: string; kind: string }[] }>(`/v1/projects/${pid}/jobs?limit=1`)).body.items[0];
    expect(j?.kind === kind, `没等到 ${kind} 作业，最新的是 ${j?.kind ?? '没有作业'}`);
    id = j.id;
  }, 15000, 300);
  const job = await waitJob(id, maxSec);
  expect(job.status === 'succeeded', `${kind} 作业 ${job.status}：${JSON.stringify(job.output).slice(0, 200)}`);
  return job;
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
  // ADR-005 v0.43：偏离设计契约不阻断写入——直改照样落修订，违规记进这一版的 lintReport，画布逐屏提示
  const bad = await apiJson<{ revision: { id: string; lintReport: { violations: { rule: string }[] } } }>(`/v1/screens/${editScreen}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'style', value: 'color:#ff0000' }], expectedRevisionId: cur }) });
  expect(bad.status === 201, `直改应照常落修订，返回 ${bad.status}`);
  expect(bad.body.revision.lintReport.violations.some((v) => v.rule === 'no-raw-hex' || v.rule === 'no-inline-style'), `lintReport 没指出裸色值 / 内联样式：${JSON.stringify(bad.body.revision.lintReport).slice(0, 160)}`);
  expect((await apiJson<{ items: unknown[] }>(`/v1/screens/${editScreen}/revisions`)).body.items.length === revsBefore + 1, '偏离契约的直改应多出一条修订');
  const ok = await apiJson<{ revision: { id: string } }>(`/v1/screens/${editScreen}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'classes', value: 'inline-flex items-center justify-center h-12 px-6 rounded-full bg-secondary-container text-on-secondary-container font-semibold' }], expectedRevisionId: bad.body.revision.id }) });
  expect(ok.status === 201, `token 类改动返回 ${ok.status} ${JSON.stringify(ok.body)}`);
  return '偏离契约的直改照样落修订、lintReport 记下违规；token 类改动 201';
});

let subProject = ''; let subScreen = '';
await step('TC-EDIT-003', async () => {
  needLiveLlm();
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
  await waitLatestJob(dsProject, 'apply_design_system', 120);
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
  await page.locator('#ds-font').fill('Manrope');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('设计系统已被更新').waitFor({ timeout: 10000 });
  await page.reload();
  await page.locator('#ds-font').waitFor();
  await page.locator('#ds-font').fill('Manrope');
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

// v0.31 REQ-EDIT-003：设计系统只显式改——⌘A + 发送不碰设计系统；设计系统面板的一句话指令 → 提炼 → 预览 → 写入约定节
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
    await waitLatestJob(r.projectId, 'edit_screens', 120);
    expect((await detail(r.projectId)).designSystem.version === version0, '⌘A + 发送不该改设计系统');
    // 2 设计系统面板的一句话指令（v1.17 起「记为约定」只有这一条路）→ propose_design_system 作业（instruction = 原指令）→ 预览对话框列出绝对规则
    await page.locator('#chat-input').blur();   // 快捷键在输入框里不生效
    await page.keyboard.press('Alt+d');
    await page.getByTestId('ds-instruction').waitFor({ timeout: 10000 });
    await page.getByTestId('ds-instruction').fill('所有页面正文字再大一点');
    const req = page.waitForRequest((x) => x.url().includes('/jobs') && x.method() === 'POST');
    await page.getByTestId('ds-propose').click();
    const job = JSON.parse((await req).postData() ?? '{}') as { kind: string; input: { instruction: string } };
    expect(job.kind === 'propose_design_system' && job.input.instruction === '所有页面正文字再大一点', `提炼作业不对：${JSON.stringify(job)}`);
    const dlg = page.getByTestId('ds-proposal');
    await dlg.waitFor({ timeout: 60000 });
    const items = await dlg.locator('input[type="checkbox"]').count();
    expect(items === 2, `预览应列出 2 条约定，实际 ${items}`);
    expect(!(await dlg.innerText()).includes('再大一点'), '约定里不该出现相对表述');
    // 3 确认写入（即落库）→ 问是否重生成 → 不重生成：DESIGN.md 出现「## 约定」、version+1；面板列出 2 条约定
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
    // 删约定撤销不了，先确认（v1.03）
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ds-conventions"] li').length === 1, null, { timeout: 10000 });
    expect((await detail(r.projectId)).designSystem.version === version0 + 2, '删除约定后 version 未 +1');
    return '⌘A 不改设计系统；面板一句话指令 → 提炼作业 → 预览 2 条绝对规则 → 确认写入、不重生成 → 约定节 + version+1；面板可删';
  } finally { await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
});

await step('TC-EDIT-010', async () => {
  // 品牌色板（REQ-EDIT-005）：逐键覆盖种子派生值，亮 / 暗两套，改完按原路回刷
  const { projectId } = seedJson<{ projectId: string }>('seed:project', '--name', 'Palette', '--device', 'mobile', '--screens', '2', '--no-shot');
  type DS = { designSystem: { version: number; seedColor: string; colorMode: string; palette: unknown; tokens: { colors: Record<string, string> } } };
  const ds = async () => (await apiJson<DS>(`/v1/projects/${projectId}`)).body.designSystem;
  const put = (body: unknown) => apiJson<DS>(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify(body) });
  const before = await ds();
  // 1 任何项目都有语义色：没挂色板也能用 success / warning；新建项目默认挂中性色板（ADR-028）
  expect(!!before.tokens.colors.success && !!before.tokens.colors.warning && !!before.tokens.colors.onSuccess, '种子派生的 token 缺语义色');
  expect(before.tokens.colors.background === NEUTRAL_PALETTE.light.background, `新建项目没挂中性色板：background=${before.tokens.colors.background}`);
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
  // 5 清空回到纯派生（不是第 1 步的值：那时挂着中性色板）
  cur = await ds();
  const r3 = await put({ palette: null, colorMode: 'light', expectedVersion: cur.version });
  const derived = tokensFromSeed(before.seedColor, { colorMode: 'light' }).colors;
  expect(r3.status === 200 && r3.body.designSystem.tokens.colors.primary === derived.primary && r3.body.designSystem.tokens.colors.background === derived.background, '清空后没回到种子派生');
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

// ---- v0.78 共用（TC-EDIT-013 / 035 / 039）----
// 软断言：缺陷相关的检查不在第一处就停，整条跑完一并报（修复前一轮就能看到每一步的现象）；前置条件仍用 expect 硬停
const blurActive = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const STUB_RUNNER = { kind: 'model', driver: 'stub', model: 'stub' };

// TC-EDIT-013 设计系统提案点「确认写入」即落库、按 20 屏一批重生成全部屏；面板草稿跨关闭 / 切换留存、已保存值变了只同步没动过的格子（REQ-EDIT-003 v0.78）
await step('TC-EDIT-013', async () => {
  const { startOpenAiStub } = await import('./openai-stub.ts');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Proposal', '--device', 'mobile', '--screens', '21', '--no-shot');
  const S = softly();
  // 第一次提案一条约定，之后两条：两次确认都改了约定，都会问要不要重生成
  let calls = 0;
  const RULES = [['按钮一律圆角胶囊'], ['按钮一律圆角胶囊', '页面标题一律 text-xl']];
  const stub = startOpenAiStub({ port: 3996, apiKey: 'good-key-0013', reply: (hit) => (hit.user.startsWith('INSTRUCTION:') ? JSON.stringify({ summary: '按钮与标题定成绝对规则', conventions: RULES[Math.min(calls++, 1)], regenerate: true }) : 'OK') });
  // 画布建的作业：提炼走桩通道，重生成走 stub 驱动（缺省通道是真实模型，不能让它打出去）；请求体记下来供断言
  const JOBS_RE = /\/v1\/projects\/[^/]+\/jobs$/;
  const jobs: { kind: string; input: Record<string, unknown> }[] = [];
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 提案', endpoint: stub.url, model: 'stub-13', apiKey: 'good-key-0013' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    await page.route(JOBS_RE, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = JSON.parse(req.postData() || '{}') as { kind: string; input: Record<string, unknown> };
      jobs.push(body);
      const runner = body.kind === 'propose_design_system' ? { kind: 'channel', channelId: cid } : STUB_RUNNER;
      await route.continue({ postData: JSON.stringify({ ...body, input: { ...body.input, runner } }) });
    });
    const ds = async () => (await detail(r.projectId)).designSystem as Detail['designSystem'] & { designMd: string };
    const saved = await ds();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.keyboard.press('Alt+d');
    await page.getByTestId('ds-brief').waitFor({ timeout: 5000 });
    // 1 两个会溢出的文本框：细滚动条（RESP-015）
    const sw = await page.evaluate(() => ['#ds-brief', '#ds-md'].map((s) => getComputedStyle(document.querySelector(s)!).scrollbarWidth));
    await S.check(() => expect(sw.every((v) => v === 'thin'), `① 文本框应是细滚动条：${JSON.stringify(sw)}`));
    // 2 改种子色、DESIGN.md 与简介各加一行 → 关面板再开、切到屏列表再切回：都还在
    const hex = page.getByLabel('种子色十六进制');
    const md = page.locator('#ds-md');
    const brief = page.getByTestId('ds-brief');
    const versionLine = page.locator('.slide-in-right').getByText(/^版本 \d+/);
    await hex.fill('#123456');
    await md.fill(`${await md.inputValue()}\n草稿里加的一行`);
    await brief.fill(`${await brief.inputValue()}简介草稿`);
    expect((await versionLine.innerText()).includes('有未保存改动'), '改完版本行应标有未保存改动');
    const kept = async (where: string) => {
      await hex.waitFor({ timeout: 5000 });
      const v = { hex: await hex.inputValue(), md: await md.inputValue(), brief: await brief.inputValue(), line: await versionLine.innerText() };
      await S.check(() => expect(v.hex === '#123456' && v.md.includes('草稿里加的一行') && v.brief.endsWith('简介草稿') && v.line.includes('有未保存改动'), `② ${where}后草稿应还在：种子 ${v.hex}，DESIGN.md 末行「${v.md.trim().split('\n').at(-1)}」，简介末尾「${v.brief.slice(-6)}」，${v.line}`));
    };
    await page.locator('.slide-in-right').getByRole('button', { name: '关闭' }).click();
    await eventually(async () => expect((await page.locator('.slide-in-right').count()) === 0, '「关闭」应关掉面板'));
    await blurActive();
    await page.keyboard.press('Alt+d');
    await kept('关面板再打开');
    await blurActive();
    await page.keyboard.press('Alt+s');
    // 等屏列表真的渲染出来再按 ⌥D：URL 先变、页面后渲染，这之间按下去的键读到的还是「设计系统开着」，会把它关掉
    await eventually(async () => expect((await page.locator('.slide-in-right h2').allInnerTexts()).some((t) => t.startsWith('屏')), '⌥S 应切到屏列表'));
    await page.keyboard.press('Alt+d');
    await kept('切到屏列表再切回');
    // 3 提案：点「确认写入」就落库；第二步焦点在「不重生成」；Esc 关掉后约定还在，不建重生成作业
    await blurActive();
    await page.getByTestId('ds-instruction').fill('按钮做成胶囊');
    await page.getByTestId('ds-propose').click();
    const dlg = page.getByTestId('ds-proposal');
    await dlg.waitFor({ timeout: 60000 });
    const v0 = (await ds()).version;
    await page.getByTestId('ds-proposal-confirm').click();
    await page.getByTestId('ds-proposal-write-only').waitFor({ timeout: 5000 });
    await page.waitForTimeout(600);
    const afterConfirm = await ds();
    await S.check(() => expect(afterConfirm.version === v0 + 1 && afterConfirm.designMd.includes('按钮一律圆角胶囊'), `③ 点「确认写入」就应落库：version ${v0} → ${afterConfirm.version}`));
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    await S.check(() => expect(focused === 'ds-proposal-write-only', `③ 第二步的焦点应落在「不重生成」：${focused}`));
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(600);
    const afterEsc = await ds();
    await S.check(() => expect(afterEsc.designMd.includes('按钮一律圆角胶囊') && !jobs.some((j) => j.kind === 'edit_screens'), `③ Esc 之后约定应已写入、不建重生成作业：约定在 ${afterEsc.designMd.includes('按钮一律圆角胶囊')}，作业 ${jobs.map((j) => j.kind).join(',')}`));
    // 草稿里的约定节换成了新写入的，其余草稿不动
    await S.check(async () => { const m = await md.inputValue(); expect(m.includes('按钮一律圆角胶囊') && m.includes('草稿里加的一行') && (await hex.inputValue()) === '#123456', '③ 确认提案后 DESIGN.md 草稿应带上新约定、改过的格子留着'); });
    // 4 第二个提案 → 重生成所有屏：21 屏按 20 + 1 两个作业全部发出
    await page.getByTestId('ds-instruction').fill('标题统一');
    await page.getByTestId('ds-propose').click();
    await dlg.waitFor({ timeout: 60000 });
    await page.getByTestId('ds-proposal-confirm').click();
    await page.getByTestId('ds-proposal-regenerate').click();
    await dlg.waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(1500);
    const eds = jobs.filter((j) => j.kind === 'edit_screens');
    const ids = eds.flatMap((j) => j.input.screenIds as string[]);
    await S.check(() => expect(eds.length === 2 && eds.map((j) => (j.input.screenIds as string[]).length).sort((a, b) => a - b).join('+') === '1+20' && new Set(ids).size === 21, `④ 21 屏应分 20 + 1 两个作业全部发出：${eds.map((j) => (j.input.screenIds as string[]).length).join(' + ')}（共 ${new Set(ids).size} 屏）`));
    // 5 面板开着时删一条约定：改过的种子色与 DESIGN.md 草稿留着，草稿里的约定节换成删后的
    await eventually(async () => expect((await detail(r.projectId) as unknown as { activeJobs: unknown[] }).activeJobs.length === 0, '重生成作业应跑完'), 120000);
    await page.getByTestId('ds-conventions').locator('li').first().getByRole('button').click();
    // 删约定撤销不了，先确认（v1.03）
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ds-conventions"] li').length === 1, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    await S.check(async () => { const m = await md.inputValue(); const h = await hex.inputValue(); expect(h === '#123456' && m.includes('草稿里加的一行') && !m.includes('按钮一律圆角胶囊') && m.includes('页面标题一律 text-xl'), `⑤ 删约定后：种子 ${h}，草稿末行「${m.trim().split('\n').at(-1)}」，还含删掉的约定 ${m.includes('按钮一律圆角胶囊')}`); });
    // 6 「放弃改动」回到已保存的那份
    await page.getByRole('button', { name: '放弃改动' }).click();
    await S.check(async () => { const now = await ds(); expect((await hex.inputValue()) === saved.seedColor && (await md.inputValue()) === now.designMd && !(await versionLine.innerText()).includes('有未保存改动'), '⑥ 放弃改动后应回到已保存的值'); });
    // 7 种子色只改大小写、字体名多打空格，连同 DESIGN.md 加的一行一起保存：保存完各格是服务端的值、不再标有未保存改动；之后删约定不把别的格子的草稿冲掉
    // （只差大小写 / 空格本身不算改动、保存键不亮——v0.83，见 TC-EDIT-024——所以这里要带上一处真改动才保存得了）
    const before = await ds();
    const font = page.getByTestId('ds-font');
    await hex.fill(before.seedColor.toLowerCase());
    await font.fill(`${await font.inputValue()} `);
    await md.fill(`第 7 步加的一行\n${await md.inputValue()}`);   // 加在开头：末尾是「## 约定」节，加在那里会变成一条约定
    await page.getByTestId('ds-save').click();
    await eventually(async () => expect((await ds()).version === before.version + 1, '⑦ 保存应落库'));
    await page.waitForTimeout(600);
    if (await page.getByTestId('ds-apply-ask').count()) await page.getByTestId('ds-apply-ask').getByRole('button', { name: '以后再说' }).click();
    await S.check(async () => {
      const v = { hex: await hex.inputValue(), font: await font.inputValue(), line: await versionLine.innerText(), save: await page.getByTestId('ds-save').isEnabled(), discard: await page.getByTestId('ds-discard').count() };
      expect(v.hex === before.seedColor && !v.font.endsWith(' ') && !v.line.includes('有未保存改动') && !v.save && v.discard === 0, `⑦ 规范化后与原值相同，保存完应无未保存改动：种子 ${v.hex}，字体「${v.font}」，${v.line}，保存可点 ${v.save}，放弃改动 ${v.discard}`);
    });
    await hex.fill('#654321');
    await page.getByTestId('ds-conventions').locator('li').first().getByRole('button').click();
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
    await page.getByTestId('ds-conventions').waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(400);
    await S.check(async () => { const h = await hex.inputValue(); expect(h === '#654321', `⑦ 保存之后再删约定，改过的种子色应留着：${h}`); });
  } catch (e) { S.fail(e); } finally { await page.unroute(JOBS_RE); await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '文本框细滚动条；草稿跨关闭与切面板留存；确认写入即落库、第二步焦点在「不重生成」、Esc 不丢约定；21 屏按 20 + 1 两个作业全部重生成；删约定只同步没动过的格子、草稿约定节换新；放弃改动复原；只改大小写 / 空格的保存不留未保存标记、不冲掉之后的草稿';
});

// v0.79 作业落地与取消、组件改动（DESIGN §11 running→cancelled、§16 edit_component 两行）：模型回来时作业已取消，子树重生成与改组件都不落；
// 屏上有作业在跑时改了共享组件，作业落地写进去的是新版组件。桩认指令里的 [stub-hold:<ms>]，让作业停在模型那一步（§3）
await step('TC-EDIT-019', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const post = <T,>(p: string, body: unknown) => apiJson<T>(p, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Landing', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [s1, s2] = screens.map((s) => s.id);
  const currentOf = async (sid: string) => (await detail(pid)).screens.find((s) => s.id === sid)!.currentRevisionId;
  const htmlOf = async (sid: string) => (await revisionHtml(sid, await currentOf(sid))).html;
  const byJob = async (sid: string, jobId: string) => (await apiJson<{ items: { jobId: string | null }[] }>(`/v1/screens/${sid}/revisions`)).body.items.filter((r) => r.jobId === jobId).length;
  const comp = async () => (await apiJson<{ components: { id: string; version: number }[] }>(`/v1/projects/${pid}`)).body.components[0];
  const h1Of = async (sid: string) => /<h1[^>]*data-qid="(q\d+)"/.exec(await htmlOf(sid))?.[1];
  // 前置：/s1 的底栏提成共享组件 Nav，同步到两屏
  const navQid = /<nav[^>]*data-qid="(q\d+)"/.exec(await htmlOf(s1))?.[1];
  const made = await post<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { name: 'Nav', fromScreenId: s1, qid: navQid, applyToScreens: true });
  expect(made.status === 201, `提取组件 ${made.status}`);
  const compId = made.body.component.id;

  // 1 子树重生成：模型拖 2.5 s，0.6 s 时取消 → 作业 cancelled，/s2 current 不变、没有这个作业的修订
  const rev2 = await currentOf(s2);
  const sub = await post<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { kind: 'regenerate_subtree', input: { screenId: s2, qid: await h1Of(s2), prompt: '[stub-hold:2500] make the title bold', expectedRevisionId: rev2, runner: STUB } });
  expect(sub.status === 202, `子树重生成 ${sub.status}`);
  await sleep(600);
  const cancel1 = await post(`/v1/jobs/${sub.body.job.id}/cancel`, {});
  await sleep(3500);
  const subJob = (await apiJson<{ job: { status: string } }>(`/v1/jobs/${sub.body.job.id}`)).body.job;
  check(cancel1.status === 200 && subJob.status === 'cancelled', `子树重生成取消：cancel ${cancel1.status}，作业 ${subJob.status}`);
  check((await currentOf(s2)) === rev2 && (await byJob(s2, sub.body.job.id)) === 0, `取消后子树重生成仍落了修订（current ${rev2 === (await currentOf(s2)) ? '未变' : '被换掉'}，本作业修订 ${await byJob(s2, sub.body.job.id)} 条）`);

  // 2 改组件：同样 0.6 s 时取消 → 组件版本不变、两屏 current 不变
  const before = { v: (await comp()).version, s1: await currentOf(s1), s2: await currentOf(s2) };
  const ce = await post<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { content: '[stub-hold:2500] rounder tabs', targetComponentIds: [compId], runner: STUB });
  expect(ce.status === 202, `改组件 ${ce.status}`);
  await sleep(600);
  const cancel2 = await post(`/v1/jobs/${ce.body.job.id}/cancel`, {});
  await sleep(3500);
  const after = { v: (await comp()).version, s1: await currentOf(s1), s2: await currentOf(s2) };
  check(cancel2.status === 200, `改组件取消 ${cancel2.status}`);
  check(after.v === before.v && after.s1 === before.s1 && after.s2 === before.s2, `取消后改组件仍落了：组件 v${before.v}→v${after.v}，/s1 ${after.s1 === before.s1 ? '未变' : '被回刷'}，/s2 ${after.s2 === before.s2 ? '未变' : '被回刷'}`);

  // 3 /s1 的子树重生成跑着（模型拖 3 s）时 PATCH 组件：回刷跳过 /s1、同步 /s2；作业落地后 /s1 里是新版组件
  const MARK = 'Mark079';
  const rev1 = await currentOf(s1);
  const sub2 = await post<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { kind: 'regenerate_subtree', input: { screenId: s1, qid: await h1Of(s1), prompt: '[stub-hold:3000] make the title bold', expectedRevisionId: rev1, runner: STUB } });
  expect(sub2.status === 202, `第二次子树重生成 ${sub2.status}`);
  await sleep(800);
  const TABS = `<nav class="sticky bottom-0 mt-auto grid grid-cols-2 bg-surface border-t border-outline-variant"><a href="/s1" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="home" class="w-5 h-5"></i>${MARK}</a><a href="/s2" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="search" class="w-5 h-5"></i>Find</a></nav>`;
  const patched = await apiJson<{ applied: string[]; skipped: { screenId: string }[] }>(`/v1/components/${compId}`, { method: 'PATCH', body: JSON.stringify({ html: TABS, expectedVersion: (await comp()).version }) });
  check(patched.status === 200 && patched.body.skipped?.some((x) => x.screenId === s1) && patched.body.applied?.includes(s2), `PATCH 组件应跳过在跑的 /s1、同步 /s2：${patched.status} ${JSON.stringify(patched.body).slice(0, 200)}`);
  const done = await waitJob(sub2.body.job.id, 30);
  const html1 = await htmlOf(s1);
  const cur1 = (await revisionHtml(s1, await currentOf(s1))).sourceKind;
  check(done.status === 'succeeded' && cur1 === 'subtree', `第二次子树重生成应成功并成为 /s1 的 current：${done.status} / ${cur1}`);
  check(html1.includes(MARK), `作业落地后 /s1 的 Nav 仍是旧版（没有 ${MARK}）`);
  check((await htmlOf(s2)).includes(MARK), `/s2 没有同步到新版组件`);

  if (bad.length) { console.log(`   TC-EDIT-019 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '取消后子树重生成与改组件都不落（current、组件版本不变）；作业在跑时改组件，回刷跳过该屏，作业落地用的是新版组件';
});

// v0.82 截图链与回刷作业（DESIGN §17 Chromium 一行、§11 超时）。两种卡法都用屏自己的脚本造：
// 字体就绪——把 document.fonts.ready 换成永不落定的 promise；图标——页面加载完之后再调 lucide.createIcons 就死循环（截图就绪判定会再调一次）
const HANG_FONTS = (title: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">${title}</h1><script>Object.defineProperty(document.fonts, 'ready', { get: function () { return new Promise(function () {}); } });</script></div>`;
const HANG_ICONS = (title: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">${title}</h1><i data-lucide="home" class="w-5 h-5"></i><script>(function wrap() { if (!window.lucide || !window.lucide.createIcons) return setTimeout(wrap, 5); var orig = window.lucide.createIcons; window.lucide.createIcons = function () { if (document.readyState === 'complete') { for (;;) {} } return orig.apply(this, arguments); }; })();</script></div>`;
type Rev082 = { id: string; jobId: string | null; screenshotUrl: string | null };
const revs082 = async (sid: string) => (await apiJson<{ items: Rev082[] }>(`/v1/screens/${sid}/revisions`)).body.items;
const mcpScreens = async (pid: string, items: { name: string; route: string; html: string }[]) => {
  const { connectMcp, callTool } = await import('./mcp-client.ts');
  const mcp = await connectMcp();
  try {
    const out: string[] = [];
    for (const it of items) {
      const r = await callTool(mcp, 'quilt.create_screen', { projectId: pid, ...it });
      expect(!r.isError, `建屏 ${it.name} 出错：${r.text.slice(0, 200)}`);
      out.push((r.json as { screenId: string }).screenId);
    }
    return out;
  } finally { await mcp.close(); }
};

// TC-EDIT-022 截图卡住时回刷作业照常收口：字体就绪永不落定的屏照常出截图（软条件）；图标那一步卡死的屏这一张按时放弃、交给重试，作业不等它；
// 之后的新屏截图照常
await step('TC-EDIT-022', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'HangShots', '--device', 'mobile', '--screens', '1');
  const s1 = screens[0].id;
  try {
    const [fonts, icons] = await mcpScreens(pid, [{ name: 'Fonts', route: '/fonts', html: HANG_FONTS('Fonts') }, { name: 'Icons', route: '/icons', html: HANG_ICONS('Icons') }]);
    // 1 回刷全部 3 屏：120 s 内终态 succeeded、3 屏都落了新修订（修复前停在 running）
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: 'all' } }) });
    expect(r.status === 202, `回刷 ${r.status}`);
    const t0 = Date.now();
    let job: Awaited<ReturnType<typeof waitJob>>;
    try { job = await waitJob(r.body.job.id, 120); }
    catch { throw new Error(`回刷作业 120 s 仍是 ${(await apiJson<{ job: { status: string } }>(`/v1/jobs/${r.body.job.id}`)).body.job.status}（截图卡住时跟着挂住）`); }
    const took = Math.round((Date.now() - t0) / 1000);
    expect(job.status === 'succeeded' && (job.output.revisionIds as string[]).length === 3, `回刷作业应 succeeded 且 3 屏都有新修订：${job.status} ${JSON.stringify(job.output).slice(0, 200)}`);
    const newRev = async (sid: string) => (await revs082(sid)).find((x) => x.jobId === r.body.job.id);
    // 2 字体就绪永不落定的屏、正常的屏：新修订 60 s 内有截图
    for (const [name, sid] of [['Fonts', fonts], ['Screen 1', s1]] as const) {
      await eventually(async () => expect((await newRev(sid))?.screenshotUrl, 'shot'), 60_000).catch(() => check(false, `「${name}」回刷后的修订 60 s 内没有截图`));
    }
    // 3 之后建的新屏截图照常（浏览器没被卡死的那一张拖住）
    const [after] = await mcpScreens(pid, [{ name: 'After', route: '/after', html: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">After</h1></div>' }]);
    await eventually(async () => expect((await revs082(after))[0]?.screenshotUrl, 'after'), 60_000).catch(() => check(false, '回刷之后新建的屏 60 s 内没有截图'));
    // 4 图标那一步卡死的屏：这一张没拍成（等待交给截图重试），修订照常在
    check(!(await newRev(icons))?.screenshotUrl, '「Icons」的截图不该拍成（它每次都卡死在图标那一步）');
    if (bad.length) { console.log(`   TC-EDIT-022 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
    return `回刷 3 屏 ${took} s 内 succeeded；字体卡住的屏照常出截图，图标卡死的那张按时放弃；之后的新屏截图照常`;
  } finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
});

// TC-EDIT-023 回刷超时收口（§11 超时）：超时基数用 QUILT_JOB_TIMEOUT_BASE_MS 改到 1 s、SCREEN_CONCURRENCY=1 重启 API，回刷两张截图要 ~20 s 的屏：
// 超时 = 1 s + 2 × 5 s = 11 s，第一屏落修订、第二屏没轮到被跳过，作业 failed(timeout)。要 QUILT_E2E_RESTART（§3），跑完按原环境重启
await step('TC-EDIT-023', async () => {
  const http = await import('node:http');
  // 一张永远等不到的图：截图等 networkidle 等满 15 s、视口内图片再等 4 s，一张 ~20 s
  const hold = http.createServer(() => { /* 不回 */ });
  await new Promise<void>((r) => hold.listen(3987, '127.0.0.1', () => r()));
  const SLOW = (title: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">${title}</h1><img src="http://127.0.0.1:3987/hang.png" width="8" height="8" alt=""></div>`;
  let pid = '';
  try {
    await restartApi({ QUILT_JOB_TIMEOUT_BASE_MS: '1000', SCREEN_CONCURRENCY: '1' });
    pid = seedJson<{ projectId: string }>('seed:project', '--name', 'Timeout', '--device', 'mobile', '--screens', '1', '--no-shot').projectId;
    const [a, b] = await mcpScreens(pid, [{ name: 'Slow A', route: '/slow-a', html: SLOW('Slow A') }, { name: 'Slow B', route: '/slow-b', html: SLOW('Slow B') }]);
    const cur = async (sid: string) => (await revs082(sid))[0]?.id;
    const before = { [a]: await cur(a), [b]: await cur(b) };
    // 1 回刷两张慢屏：failed(timeout)、消息写明 11 s；一屏落了修订、另一屏 current 不变；作业不挂住
    const t0 = Date.now();
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'apply_design_system', input: { screenIds: [a, b] } }) });
    expect(r.status === 202, `回刷 ${r.status}`);
    const job = await waitJob(r.body.job.id, 120);
    const took = Math.round((Date.now() - t0) / 1000);
    const out = job.output as { errorClass?: string; message?: string; revisionIds?: string[] };
    expect(job.status === 'failed' && out.errorClass === 'timeout' && out.message === 'job exceeded 11s', `回刷两屏应 failed(timeout)「job exceeded 11s」：${job.status} ${out.errorClass ?? ''} ${out.message ?? ''}（${took} s）`);
    const changed = [a, b].filter((sid) => before[sid] !== undefined);
    const moved: string[] = [];
    for (const sid of changed) if ((await cur(sid)) !== before[sid]) moved.push(sid);
    expect(out.revisionIds?.length === 1 && moved.length === 1, `应恰好一屏落了新修订、另一屏没轮到：revisionIds ${out.revisionIds?.length}，current 变了 ${moved.length} 屏`);
    expect(took <= 60, `作业 ${took} s 才收口`);
    return `两张慢屏超时 11 s → ${took} s 收口为 failed(timeout)，落 1 屏、跳过 1 屏`;
  } finally {
    if (pid) await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
    hold.closeAllConnections(); hold.close();
    await restartApi({});
  }
});

// TC-EDIT-024 设计系统面板：只差大小写 / 首尾空格的值不算改动，保存不因它问「回刷所有屏？」（REQ-EDIT-003 v0.83）
await step('TC-EDIT-024', async () => {
  const r = seedJson<{ projectId: string }>('seed:project', '--name', 'Normalize', '--device', 'mobile', '--screens', '2', '--no-shot');
  const S = softly();
  try {
    const ds = async () => (await detail(r.projectId)).designSystem as Detail['designSystem'] & { designMd: string };
    const saved = await ds();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.keyboard.press('Alt+d');
    const hex = page.getByLabel('种子色十六进制');
    const font = page.getByTestId('ds-font');
    const md = page.locator('#ds-md');
    const versionLine = page.locator('.slide-in-right').getByText(/^版本 \d+/);
    await hex.waitFor({ timeout: 5000 });
    const fontSaved = await font.inputValue();
    const state = async () => ({ line: await versionLine.innerText(), save: await page.getByTestId('ds-save').isEnabled(), discard: await page.getByTestId('ds-discard').count() });
    // 1 种子色改成已保存值的小写、字体名前后加空格：规范化后与已保存值相同，不算改动
    await hex.fill(saved.seedColor.toLowerCase());
    await font.fill(`  ${fontSaved}  `);
    const s1 = await state();
    await S.check(() => expect(!s1.line.includes('有未保存改动') && !s1.save && s1.discard === 0, `① 只差大小写 / 空格不该算改动：${s1.line}，保存可点 ${s1.save}，放弃改动 ${s1.discard}`));
    // 2 再在 DESIGN.md 开头加一行并保存：只有 DESIGN.md 真变了，不问「回刷所有屏？」；保存后各格是服务端规范化后的值
    await md.fill(`规范化用例加的一行\n${await md.inputValue()}`);
    await page.getByTestId('ds-save').click();
    await eventually(async () => expect((await ds()).version === saved.version + 1, '② 保存应落库'));
    await page.waitForTimeout(1200);
    const asked = await page.getByTestId('ds-apply-ask').count();
    if (asked) await page.getByTestId('ds-apply-ask').getByRole('button', { name: '以后再说' }).click();
    await S.check(() => expect(asked === 0, '② 只改了 DESIGN.md（种子色只差大小写、字体名只多空格），保存后不该问「回刷所有屏？」'));
    const after = await ds();
    const s2 = { ...(await state()), hex: await hex.inputValue(), font: await font.inputValue() };
    await S.check(() => expect(after.seedColor === saved.seedColor && s2.hex === saved.seedColor && s2.font === fontSaved && !s2.line.includes('有未保存改动') && !s2.save, `② 保存后应是规范化后的已保存值、无未保存改动：库里 ${after.seedColor}，种子「${s2.hex}」字体「${s2.font}」，${s2.line}，保存可点 ${s2.save}`));
    // 3 真改了种子色（小写写法）：算改动，保存后照常问「回刷所有屏？」，库里存大写
    await hex.fill('#c2410c');
    const s3 = await state();
    await S.check(() => expect(s3.line.includes('有未保存改动') && s3.save, `③ 换了种子色应算改动：${s3.line}，保存可点 ${s3.save}`));
    await page.getByTestId('ds-save').click();
    await S.check(() => page.getByTestId('ds-apply-ask').waitFor({ timeout: 5000 }));
    if (await page.getByTestId('ds-apply-ask').count()) await page.getByTestId('ds-apply-ask').getByRole('button', { name: '以后再说' }).click();
    await S.check(async () => expect((await ds()).seedColor === '#C2410C', `③ 库里的种子色应是大写 #C2410C：${(await ds()).seedColor}`));
  } catch (e) { S.fail(e); }
  S.done();
  return '只差大小写 / 空格不标未保存、保存置灰；连同 DESIGN.md 一起保存不问回刷、保存后各格是规范化后的值；真换种子色照常问回刷、库里存大写';
});

// TC-EDIT-025 / 026 历史指令（ADR-012 v0.87）：OpenAI 兼容桩截获发给模型的用户提示，看「此前已生效的用户指令」那一块收了哪些轮、按什么顺序。
// 两条共用一个项目、一个桩与一条通道（026 接着 025 的项目往下走），按需建一次，跑完关桩、删通道
type History = { pid: string; s1: string; compId: string; channelId: string; stub: ReturnType<typeof import('./openai-stub.ts').startOpenAiStub> };
let hist: History | null = null;
const HIST_SCREEN = '<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="h-14 flex items-center px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">History</h1></header><main class="flex-1 px-4 py-6 space-y-6"><button type="button" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Primary action</button></main></div>';
const HIST_NAV = '<nav class="grid grid-cols-2 bg-surface border-t border-outline-variant"><a href="/s1" aria-current="page" class="flex items-center justify-center py-3 text-primary">Home</a><a href="/s1" class="flex items-center justify-center py-3 text-on-surface-variant">More</a></nav>';
const histSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 每分钟 10 个作业的限流（§15）：本组一口气建十几个，撞上 429 就等 5 s 再发
const until429 = async <T,>(f: () => Promise<{ status: number; body: T }>) => { for (let i = 0; ; i++) { const r = await f(); if (r.status !== 429 || i >= 15) return r; await histSleep(5000); } };
const histPost = <T,>(p: string, body: unknown) => until429(() => apiJson<T>(p, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) }));
const histJob = async (id: string, maxSec = 90) => {
  for (let i = 0; i < maxSec * 2; i++) { const j = (await apiJson<{ job: { status: string; output: Record<string, unknown> | null } }>(`/v1/jobs/${id}`)).body.job; if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j; await histSleep(500); }
  throw new Error(`作业 ${id} ${maxSec} s 没结束`);
};
// 「EARLIER INSTRUCTIONS ALREADY APPLIED TO THIS <subject>」之后的编号列表；没有这一块返回 null
const historyIn = (user: string, subject: 'SCREEN' | 'COMPONENT'): string[] | null => {
  const i = user.indexOf(`EARLIER INSTRUCTIONS ALREADY APPLIED TO THIS ${subject}`);
  if (i < 0) return null;
  const items: string[] = [];
  for (const l of user.slice(i).split('\n').slice(1)) { const m = /^\d+\. (.*)$/.exec(l); if (!m) break; items.push(m[1]); }
  return items;
};
async function historySetup(): Promise<History> {
  if (hist) return hist;
  const { startOpenAiStub } = await import('./openai-stub.ts');
  const stub = startOpenAiStub({
    port: 3976, apiKey: 'good-key-0087',
    reply: (h) => (h.user.startsWith('Revise the shared component') ? HIST_NAV : h.user.startsWith('Within the screen') ? '<h1 class="text-xl font-semibold">History</h1>' : HIST_SCREEN),
    fail: (h) => (h.user.includes('FAILME') ? 400 : null),
    cut: (h) => h.user.includes('CUTME'),
  });
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'History', '--device', 'mobile', '--screens', '1', '--no-shot');
  const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 历史', endpoint: stub.url, model: 'stub-hist', apiKey: 'good-key-0087' }) });
  expect(ch.status === 201, `建桩通道 ${ch.status}`);
  expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
  const comp = await histPost<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { name: 'TabBar', html: HIST_NAV });
  expect(comp.status === 201, `建组件 ${comp.status}`);
  hist = { pid, s1: screens[0].id, compId: comp.body.component.id, channelId: ch.body.channel.id, stub };
  return hist;
}
// 发一轮并等它结束，返回这一轮桩收到的、用户提示里含 marker 的那次请求（没调到模型时为 undefined）
async function histRound(h: History, body: Record<string, unknown>, marker: string) {
  const from = h.stub.hits.length;
  const r = await histPost<{ job: { id: string } }>(`/v1/projects/${h.pid}/messages`, { runner: { kind: 'channel', channelId: h.channelId }, ...body });
  expect(r.status === 202, `发「${marker}」${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const job = await histJob(r.body.job.id);
  return { job, hit: h.stub.hits.slice(from).find((x) => x.user.includes(marker)) };
}

await step('TC-EDIT-025', async () => {
  const h = await historySetup();
  const S = softly();
  const comp = { targetComponentIds: [h.compId] };
  const version = async () => (await apiJson<{ components: { id: string; version: number }[] }>(`/v1/projects/${h.pid}`)).body.components.find((c) => c.id === h.compId)!.version;
  try {
    const r1 = await histRound(h, { ...comp, content: 'H1 点击的背景高亮就行，不需要下面的那个圆点' }, 'H1 点击');
    await S.check(() => expect(r1.job.status === 'succeeded' && r1.hit && !r1.hit.user.includes('EARLIER INSTRUCTIONS'), `① 首轮应成功且没有历史块：${r1.job.status}`));
    const v1 = await version();
    const r2 = await histRound(h, { ...comp, content: 'H2 FAILME 切换加 200ms 过渡' }, 'H2 FAILME');
    await S.check(async () => expect(r2.job.status === 'failed' && (await version()) === v1, `② 桩回 400 时应失败、组件版本不变：${r2.job.status}`));
    const r3 = await histRound(h, { ...comp, content: 'H3 选中项文字加粗' }, 'H3 选中项');
    const b3 = r3.hit ? historyIn(r3.hit.user, 'COMPONENT') : null;
    await S.check(() => expect(r3.job.status === 'succeeded' && JSON.stringify(b3) === JSON.stringify(['H1 点击的背景高亮就行，不需要下面的那个圆点']), `③ 历史块应只有 H1：${JSON.stringify(b3)}`));
    const r4 = await histRound(h, { ...comp, content: 'H4 图标换成线性风格' }, 'H4 图标');
    const b4 = r4.hit ? historyIn(r4.hit.user, 'COMPONENT') : null;
    await S.check(() => expect(JSON.stringify(b4) === JSON.stringify(['H3 选中项文字加粗', 'H1 点击的背景高亮就行，不需要下面的那个圆点']), `④ 历史块应依次 H3、H1：${JSON.stringify(b4)}`));
    await S.check(() => expect(r4.hit && !r4.hit.user.includes('H2') && !r4.hit.user.includes('改组件：'), '④ 提示词里不该有失败的 H2 与「改组件：」'));
  } catch (e) { S.fail(e); }
  S.done();
  return '首轮无历史；失败的一轮不进；第 3、4 轮带此前成功的原话、从新到旧';
});

await step('TC-EDIT-026', async () => {
  const h = await historySetup();
  const S = softly();
  const scr = { targetScreenIds: [h.s1] };
  const currentOf = async () => (await detail(h.pid)).screens.find((s) => s.id === h.s1)!.currentRevisionId;
  try {
    expect((await apiJson<{ default: string }>('/v1/runners')).body.default === `channel:${h.channelId}`, '账号默认通道不是桩通道：先确认没有别的已验证通道（GEMINI_API_KEY= 运行）');
    // 1 对话改
    const r1 = await histRound(h, { ...scr, content: 'S1 标题改成「我的订单」' }, 'S1 标题');
    await S.check(() => expect(r1.job.status === 'succeeded' && r1.hit && !r1.hit.user.includes('EARLIER INSTRUCTIONS'), `① 首轮应成功且没有历史块：${r1.job.status}`));
    // 2 MCP 改
    const { connectMcp, callTool } = await import('./mcp-client.ts');
    const mcp = await connectMcp();
    let mj: { id: string } | null = null;
    try {
      for (let i = 0; i < 16 && !mj; i++) {
        const r = await callTool(mcp, 'quilt.edit_screens', { projectId: h.pid, screenIds: [h.s1], prompt: 'S3 底部加一行版权说明', runner: { kind: 'channel', channelId: h.channelId } });
        if (!r.isError) mj = r.json as { id: string };
        else if ((r.json as { type?: string }).type === '/errors/rate-limited') await histSleep(5000);
        else throw new Error(`② MCP edit_screens：${r.text.slice(0, 160)}`);
      }
    } finally { await mcp.close(); }
    expect(mj, '② MCP edit_screens 一直被限流');
    await S.check(async () => expect((await histJob(mj!.id)).status === 'succeeded', '② MCP 改屏应成功'));
    // 3 设计系统回刷 + 不写附加要求的补链
    const ap = await histPost<{ job: { id: string } }>(`/v1/projects/${h.pid}/jobs`, { kind: 'apply_design_system', input: { screenIds: 'all' } });
    await S.check(async () => expect(ap.status === 202 && (await histJob(ap.body.job.id)).status === 'succeeded', `③ 回刷应成功：${ap.status}`));
    const lr = await histRound(h, { ...scr, content: '', preset: 'link_repair' }, 'Connect every navigation action');
    await S.check(() => expect(lr.job.status === 'succeeded', `③ 补链应成功：${lr.job.status}`));
    // 4 再改：历史块 = MCP、对话两轮，从新到旧；回刷与补链不进、不带 qid
    const r4 = await histRound(h, { ...scr, content: 'S4 列表项加分隔线' }, 'S4 列表项');
    const b4 = r4.hit ? historyIn(r4.hit.user, 'SCREEN') : null;
    const want4 = ['S3 底部加一行版权说明', 'S1 标题改成「我的订单」'];
    await S.check(() => expect(JSON.stringify(b4) === JSON.stringify(want4), `④ 历史块应为 ${JSON.stringify(want4)}：${JSON.stringify(b4)}`));
    await S.check(() => expect(b4 && !/data-qid|回刷|接上跳转|Apply the following/.test(b4.join('\n')), `④ 历史块里混进了 qid / 系统描述：${JSON.stringify(b4)}`));
    const rev4 = await currentOf();
    // 5 改一轮再回溯：当前版指回被回溯到的那一版（v1.43）
    const r5 = await histRound(h, { ...scr, content: 'S5 顶部加一条促销横幅' }, 'S5 顶部');
    expect(r5.job.status === 'succeeded', `⑤ S5 应成功：${r5.job.status}`);
    const rev5 = await currentOf();
    const back = await apiJson<{ revision: { id: string } }>(`/v1/screens/${h.s1}/revisions/${rev4}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: rev5 }) });
    const cur5 = await currentOf();
    await S.check(() => expect(back.status === 200 && back.body.revision?.id === rev4 && cur5 === rev4, `⑤ 回溯应 200 且当前版指回被回溯到的那一版：${back.status} current=${cur5} 期望 ${rev4}`));
    // 6 回溯之后再改：被撤销的 S5 不在
    const r6 = await histRound(h, { ...scr, content: 'S6 标题居中' }, 'S6 标题');
    const b6 = r6.hit ? historyIn(r6.hit.user, 'SCREEN') : null;
    await S.check(() => expect(b6?.[0] === 'S4 列表项加分隔线' && r6.hit && !r6.hit.user.includes('S5'), `⑥ 历史块第 1 条应是 S4、不含 S5：${JSON.stringify(b6)}`));
    // 7 局部重生成也带历史
    const html7 = (await revisionHtml(h.s1, await currentOf())).html;
    const h1 = /<h1[^>]*data-qid="(q\d+)"/.exec(html7)?.[1] ?? /data-qid="(q\d+)"[^>]*>History<\/h1>/.exec(html7)?.[1];
    const from = h.stub.hits.length;
    const sub = await histPost<{ job: { id: string } }>(`/v1/projects/${h.pid}/jobs`, { kind: 'regenerate_subtree', input: { screenId: h.s1, qid: h1, prompt: 'S7 标题字号加大', expectedRevisionId: await currentOf(), runner: { kind: 'channel', channelId: h.channelId } } });
    expect(sub.status === 202, `⑦ 局部重生成 ${sub.status} ${JSON.stringify(sub.body).slice(0, 160)}`);
    await histJob(sub.body.job.id);
    const hit7 = h.stub.hits.slice(from).find((x) => x.user.includes('S7 标题字号'));
    const b7 = hit7 ? historyIn(hit7.user, 'SCREEN') : null;
    await S.check(() => expect(b7?.[0] === 'S6 标题居中' && hit7 && !hit7.user.includes('S5'), `⑦ 局部重生成的历史块第 1 条应是 S6、不含 S5：${JSON.stringify(b7)}`));
  } catch (e) { S.fail(e); }
  S.done();
  return '对话 / MCP 两类进历史、回刷与补链不进、不带 qid；回溯把当前版指回那一版，撤销的那轮不在改屏与局部重生成的历史里';
});

// TC-EDIT-027 输出到上限被截断（§17 LLM 一行，v0.90）：桩对带 CUTME 的请求回 finish_reason=length，截断的文字不能落成一版残屏
await step('TC-EDIT-027', async () => {
  const h = await historySetup();
  const S = softly();
  const screenOf = async () => (await detail(h.pid)).screens.find((s) => s.id === h.s1)!;
  try {
    const before = await screenOf();
    const revs0 = (await apiJson<{ items: unknown[] }>(`/v1/screens/${h.s1}/revisions`)).body.items.length;
    const from = h.stub.hits.length;
    const r = await histRound(h, { targetScreenIds: [h.s1], content: 'C1 CUTME 加一张很长的数据表' }, 'C1 CUTME');
    const out = r.job.output as { errorClass?: string; message?: string } | null;
    await S.check(() => expect(r.job.status === 'failed' && out?.errorClass === 'provider' && /output hit the token limit/.test(out?.message ?? ''), `① 应按 provider 失败、报输出上限：${r.job.status} ${JSON.stringify(out)}`));
    const after = await screenOf();
    const revs1 = (await apiJson<{ items: unknown[] }>(`/v1/screens/${h.s1}/revisions`)).body.items.length;
    await S.check(() => expect(after.currentRevisionId === before.currentRevisionId && revs1 === revs0, `① 当前修订与修订数应不变：${revs0} → ${revs1}`));
    const msgs = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${h.pid}/messages`)).body.items;
    const reply = msgs.find((m) => m.role === 'assistant' && m.jobId === (r.job as unknown as { id: string }).id)?.content ?? '';
    await S.check(() => expect(reply.startsWith('改屏失败：模型这次要写的内容超过了单次输出上限，结果不完整，没有保存。') && reply.includes('拆成几次'), `① 回执文案：${reply}`));
    await S.check(() => expect(h.stub.hits.slice(from).filter((x) => x.user.includes('C1 CUTME')).length === 1, '② 带 CUTME 的请求应只发 1 次（不重试）'));
  } catch (e) { S.fail(e); }
  S.done();
  return '输出到上限的半截不落修订、当前版不变；回执说输出超限并建议拆开发；不重试';
});
// hist 在 step 的回调里赋值，控制流分析看不到，这里按声明的类型取
const h0 = hist as History | null;
if (h0) { await h0.stub.close(); await apiJson(`/v1/channels/${h0.channelId}`, { method: 'DELETE' }).catch(() => {}); }

// TC-EDIT-028 改元素之后截图及时换上（§17 Chromium 一行，v0.93）：截图浏览器在进程内缓存外网 CDN 的脚本、样式与字体，第二张起不再等外网；
// 视口内的图一直等不到时按 4 s 软上限照常出图，不撞「载入到拍完」30 s 的上限
await step('TC-EDIT-028', async () => {
  const S = softly();
  const http = await import('node:http');
  const hold = http.createServer(() => { /* 不回 */ });
  await new Promise<void>((r) => hold.listen(3988, '127.0.0.1', () => r()));
  const pid = seedJson<{ projectId: string }>('seed:project', '--name', 'QuickShot', '--device', 'mobile', '--screens', '1', '--no-shot').projectId;
  // 从调用返回起计时，等到这一版有截图
  const shotIn = async (sid: string, rid: string, ms: number) => {
    const t0 = Date.now();
    await eventually(async () => expect((await revs082(sid)).find((x) => x.id === rid)?.screenshotUrl, 'shot'), ms, 200);
    return Date.now() - t0;
  };
  try {
    // 1 MCP 建一屏（prelude 带 Tailwind CDN 与 Google Fonts，屏里一个 lucide 图标）：首张截图从外网取，120 s 内出来
    const [quick] = await mcpScreens(pid, [{ name: 'Quick', route: '/quick', html: '<div class="min-h-dvh bg-background p-6"><h1 id="title" class="text-xl">Quick</h1><i data-lucide="home" class="w-5 h-5"></i></div>' }]);
    let cur = (await revs082(quick))[0].id;
    const t1 = await shotIn(quick, cur, 120_000).catch(() => { throw new Error('① 首张截图 120 s 内没出来（外网 CDN 不可达时记环境）'); });
    // 2 连改三次标题的类（检查器保存走的同一个接口）：每次的新修订 3 s 内有截图
    const times: number[] = [];
    for (const cls of ['text-2xl font-semibold', 'text-lg', 'text-xl font-bold']) {
      const qid = qidOf((await revisionHtml(quick, cur)).html, 'id="title"')!;
      const r = await apiJson<{ revision: { id: string } }>(`/v1/screens/${quick}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'classes', value: cls }], expectedRevisionId: cur }) });
      expect(r.status === 201, `改类返回 ${r.status}`);
      cur = r.body.revision.id;
      times.push(await shotIn(quick, cur, 40_000).catch(() => 40_000));
    }
    await S.check(() => expect(times.every((t) => t <= 3000), `② 改元素后的截图应各在 3 s 内换上：${times.join(' / ')} ms`));
    // 3 MCP 建一屏，视口内一张图指向只收不回的服务：首张截图 30 s 内出来（等 networkidle 满 15 s、图片再等 4 s）
    const [slow] = await mcpScreens(pid, [{ name: 'Slow', route: '/slow', html: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Slow</h1><img src="http://127.0.0.1:3988/hang.png" width="8" height="8" alt=""></div>' }]);
    const t3 = await shotIn(slow, (await revs082(slow))[0].id, 30_000).catch(() => -1);
    await S.check(() => expect(t3 >= 0, '③ 视口内的图等不到时，截图应在 30 s 内照常出来'));
    S.done();
    return `首张 ${t1} ms；改元素后 ${times.join(' / ')} ms；带等不到的图 ${t3} ms`;
  } finally {
    await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
    hold.closeAllConnections(); hold.close();
  }
});

// TC-EDIT-029 检查器的键盘操作与直改撤销（REQ-EDIT-001 v0.95）：点了屏里的元素焦点挪到检查器；⌘S 保存（焦点在文案框、检查器或屏里都行，拦掉浏览器的保存）、
// Delete 删选中元素（焦点在输入框里时只删字）、⌘Z 逐步撤销直改（连按不误判冲突；之后被别的写入改过就不撤）；组件里的直改撤不了
await step('TC-EDIT-029', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Keys', '--device', 'mobile', '--screens', '1', '--no-shot');
  const pid = r.projectId; const sid = r.screens[0].id;
  const S = softly();
  const cur = async () => (await detail(pid)).screens[0].currentRevisionId;
  const htmlNow = async () => (await revisionHtml(sid, await cur())).html;
  const toastSeen = (text: string) => page.getByText(text).last().waitFor({ timeout: 15000 });
  // 记下 ⌘S 是否被拦：父页的处理挂在 window 上、运行时的挂在 document 上，探针挂在同一层、注册在它们之后才看得到结果
  const record = (on: 'window' | 'document') => `const w = window; w.__s = []; ${on}.addEventListener('keydown', (e) => { if (e.code === 'KeyS') w.__s.push(e.defaultPrevented); });`;
  // 保存后新内容换进 iframe 要过一段切换动画（约 250 ms），检查器的重选在那之后才到；之前输入的草稿挂在旧值上、重选一到就作废，所以新文案出现后再等 1 s
  const settled = async (text: string) => { await fl.locator('#toggle', { hasText: text }).waitFor({ timeout: 15000 }); await page.waitForTimeout(1000); };
  const fl = page.frameLocator('.card.focused iframe');
  try {
    await page.goto(`${WEB}/p/${pid}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await card.waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    await fl.locator('#toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(record('window'));
    // 1 焦点在检查器文案框里按 ⌘S：保存，并拦掉浏览器的保存
    await fl.locator('#toggle').click();
    await page.locator('#el-text').fill('快捷一');
    await page.keyboard.press('ControlOrMeta+s');
    await eventually(async () => expect((await htmlNow()).includes('>快捷一<'), '焦点在文案框里时 ⌘S 没保存'), 15000);
    const s1 = await page.evaluate(() => (window as unknown as { __s: boolean[] }).__s);
    await S.check(() => expect(s1.length === 1 && s1[0], `① ⌘S 应拦掉浏览器的保存：${JSON.stringify(s1)}`));
    await settled('快捷一');
    // 2 文案框里改了、再点回屏里的这个元素：焦点挪到检查器（不再停在 iframe 里），直接按 ⌘S 就保存；Tab 一下进文案框
    await page.locator('#el-text').fill('快捷二');
    await fl.locator('#toggle').click();
    await S.check(() => eventually(async () => expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid) === 'inspector-body', '② 点了屏里的元素后焦点没挪到检查器'), 3000));
    await page.keyboard.press('ControlOrMeta+s');
    await eventually(async () => expect((await htmlNow()).includes('>快捷二<'), '点了屏里的元素后直接按 ⌘S 没保存'), 15000);
    const s2 = await page.evaluate(() => (window as unknown as { __s: boolean[] }).__s);
    await S.check(() => expect(s2.length === 2 && s2[1], `② ⌘S 应拦掉浏览器的保存：${JSON.stringify(s2)}`));
    const r2 = await cur();
    await settled('快捷二');
    await page.locator('[data-testid="inspector-body"]').focus();
    await page.keyboard.press('Tab');
    await S.check(async () => expect(await page.evaluate(() => document.activeElement?.id) === 'el-text', '② 从检查器按 Tab 应进文案框'));
    // 3 焦点在文案框里按 Backspace：只删字，不删元素
    // 光标放到末尾（Tab 进来时整段是选中的；macOS 上 End 在输入框里不挪光标）
    await page.locator('#el-text').evaluate((el) => { const i = el as HTMLInputElement; i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(800);
    await S.check(async () => expect((await page.locator('#el-text').inputValue()) === '快捷' && (await cur()) === r2, `③ 文案框里的 Backspace 应只删字：${await page.locator('#el-text').inputValue()}，当前版 ${(await cur()) === r2 ? '未变' : '变了'}`));
    await page.locator('#el-text').fill('快捷二');
    // 4 焦点仍在屏里（运行时转发）：⌘S 没改动时提示「没有改动」、预览文档里拦掉浏览器的保存；Delete 删掉选中的元素
    await fl.locator('#toggle').click();
    await page.waitForTimeout(300);
    const frame = page.frames().find((f) => f.url().includes(`/p/${pid}/${sid}`));
    expect(frame, '找不到聚焦屏的预览文档');
    await frame!.evaluate(record('document'));
    await page.evaluate(() => (document.querySelector('.card.focused iframe') as HTMLIFrameElement).focus());
    await page.keyboard.press('ControlOrMeta+s');
    await toastSeen('没有改动');
    const s4 = await frame!.evaluate(() => (window as unknown as { __s: boolean[] }).__s);
    await S.check(() => expect(s4.length === 1 && s4[0], `④ 预览文档里的 ⌘S 应被拦掉：${JSON.stringify(s4)}`));
    await page.keyboard.press('Delete');
    await eventually(async () => expect(!(await htmlNow()).includes('id="toggle"'), '焦点在屏里时 Delete 没删元素'), 15000);
    await eventually(async () => expect((await fl.locator('#toggle').count()) === 0, 'iframe 里元素还在'), 15000);
    // 5 ⌘Z 撤销删除：元素回来、文案是「快捷二」
    await page.keyboard.press('ControlOrMeta+z');
    await toastSeen('已撤销删除元素');
    await eventually(async () => expect((await htmlNow()).includes('>快捷二<'), '⌘Z 没撤销删除'), 15000);
    await fl.locator('#toggle', { hasText: '快捷二' }).waitFor({ timeout: 15000 });
    // 6 再按 ⌘Z 撤销第二次保存（连按不能判成冲突）：文案回到「快捷一」
    await page.keyboard.press('ControlOrMeta+z');
    await toastSeen('已撤销修改元素');
    await eventually(async () => expect((await htmlNow()).includes('>快捷一<'), '第二次 ⌘Z 没撤销保存'), 15000);
    await fl.locator('#toggle', { hasText: '快捷一' }).waitFor({ timeout: 15000 });
    // 7 之后被别的写入改过（直接调直改接口，不经检查器）：⌘Z 不撤，提示去修订面板，当前版不动
    const html7 = await htmlNow();
    const q7 = qidOf(html7, 'id="toggle"')!;
    const ext = await apiJson<{ revision: { id: string } }>(`/v1/screens/${sid}/elements/${q7}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: '外部改' }], expectedRevisionId: await cur() }) });
    expect(ext.status === 201, `外部直改 ${ext.status}`);
    await fl.locator('#toggle', { hasText: '外部改' }).waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+z');
    await toastSeen('这一屏之后又改过了，撤销不了这一步，去修订面板找回');
    await page.waitForTimeout(500);
    await S.check(async () => expect((await cur()) === ext.body.revision.id, '⑦ 被别的写入改过后 ⌘Z 不该动当前版'));
    // 8 组件里的直改：保存（⌘S）后 ⌘Z 提示撤销不了
    const headerQid = qidOf(await htmlNow(), 'class="h-14 flex')!;
    const c = await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'AppBar', fromScreenId: sid, qid: headerQid, applyToScreens: false }) });
    expect(c.status === 201, `建组件 ${c.status}`);
    // 新组件卡默认落在左下，可能被输入框压住；挪到屏的右侧再进
    await apiJson(`/v1/components/${c.body.component.id}`, { method: 'PATCH', body: JSON.stringify({ x: 460, y: 0 }) });
    // 不用 reload：选择元素态记在地址里，reload 后仍在该模式，再按 ⌘E 就成了退出
    await page.goto(`${WEB}/p/${pid}`);
    const comp = page.locator('[data-testid="component-card"][data-name="AppBar"]');
    await page.locator('[data-testid="component-card"][data-name="AppBar"][data-ready]').waitFor({ timeout: 20000 });
    await comp.locator('.gesture').dblclick();
    await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
    await page.keyboard.press('ControlOrMeta+e');
    const cf = page.frameLocator('.comp.focused iframe');
    await page.waitForTimeout(500);
    // 检查器从右侧滑出会盖住组件卡；这一步验的是撤销而不是点选手感，直接在组件文档里派发点击
    await cf.locator('h1').dispatchEvent('click');
    await page.locator('#el-text').waitFor({ timeout: 8000 });
    await page.locator('#el-text').fill('组件改');
    await page.keyboard.press('ControlOrMeta+s');
    await toastSeen('已更新组件「AppBar」');
    await page.keyboard.press('ControlOrMeta+z');
    await toastSeen('组件「AppBar」里的改动撤销不了，要改回去就再改一次组件');
  } catch (e) { S.fail(e); }
  finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '点了屏里的元素焦点就到检查器、直接 ⌘S 保存、Tab 进文案框；焦点在屏里时 ⌘S / Delete / ⌘Z 经运行时转发、⌘S 拦掉浏览器保存；文案框里 Backspace 只删字；⌘Z 连撤删除与保存；被别的写入改过后不撤；组件直改提示撤销不了';
});

// TC-EDIT-030 检查器的类名一行一个（REQ-EDIT-001 v0.96 PAGE-CANVAS「类名编辑」）：按原顺序一行一个、每个类配说明且按本项目取值；
// ‹ › 换档、到头不可点；颜色下拉换 token；× 删、末行加（多个类拆成多行）、行里打空格失焦拆行；未收录 / 非 token 色有标注；打字时输入框不横跳；⌘S 按行序存回
await step('TC-EDIT-030', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Classes', '--device', 'mobile', '--screens', '1', '--no-shot');
  const pid = r.projectId; const sid = r.screens[0].id;
  const S = softly();
  const rows = page.locator('[data-testid="class-row"]');
  const row = (cls: string) => page.locator(`[data-testid="class-row"][data-class="${cls}"]`);
  const classesNow = async () => rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.class));
  const desc = async (cls: string) => (await row(cls).locator('[data-testid="class-desc"]').innerText()).trim();
  try {
    await page.goto(`${WEB}/p/${pid}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await card.waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('#toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await fl.locator('#toggle').click();
    await rows.first().waitFor({ timeout: 5000 });
    // 1 按原顺序一行一个，说明按本项目取值
    const orig = ['inline-flex', 'items-center', 'justify-center', 'h-12', 'px-6', 'rounded-full', 'bg-primary', 'text-on-primary', 'font-semibold'];
    await S.check(async () => expect(JSON.stringify(await classesNow()) === JSON.stringify(orig), `① 行序不对：${JSON.stringify(await classesNow())}`));
    const want: [string, string][] = [['px-6', '左右内边距 24px'], ['h-12', '高度 48px'], ['items-center', '子元素纵向居中'], ['rounded-full', '圆角：全圆'], ['bg-primary', '背景色 primary'], ['font-semibold', '字重 600']];
    for (const [cls, d] of want) await S.check(async () => expect((await desc(cls)) === d, `① ${cls} 的说明：${await desc(cls)}`));
    await S.check(async () => expect((await row('bg-primary').getByTestId('class-color').getAttribute('data-value')) === 'primary', '① bg-primary 的色板下拉应选中 primary'));
    // 2 换档：px-6 › → px-7（28px），‹ ‹ → px-5；rounded-full 已是最大一档，› 不可点
    await row('px-6').getByTestId('class-up').click();
    await S.check(async () => expect((await desc('px-7')) === '左右内边距 28px', '② › 后应是 px-7 / 28px'));
    await row('px-7').getByTestId('class-down').click();
    await row('px-6').getByTestId('class-down').click();
    await S.check(async () => expect((await row('px-5').count()) === 1, '② ‹ ‹ 后应是 px-5'));
    await S.check(async () => expect((await row('rounded-full').getByTestId('class-up').getAttribute('aria-disabled')) === 'true', '② rounded-full 的 › 应不可点'));
    // 3 颜色下拉：bg-primary → bg-secondary
    await pickOption(page, '[data-testid="class-row"][data-class="bg-primary"] [data-testid="class-color"]', 'secondary');
    await S.check(async () => expect((await row('bg-secondary').count()) === 1, '③ 换色后应是 bg-secondary'));
    // 4 删 font-semibold；末行加 shadow-md、再一次加两个类
    await row('font-semibold').getByTestId('class-remove').click();
    const add = page.getByTestId('class-add');
    await add.fill('shadow-md'); await add.press('Enter');
    await add.fill('gap-2 tracking-wide'); await add.press('Enter');
    await S.check(async () => expect(JSON.stringify((await classesNow()).slice(-3)) === JSON.stringify(['shadow-md', 'gap-2', 'tracking-wide']), `④ 末尾应加上三行：${JSON.stringify(await classesNow())}`));
    // 5 打字时输入框不横跳：px-5 删成 px-（不能换档了），输入框的位置与宽度不变；再改成「px-5 py-3」失焦拆成两行
    const input = row('px-5').locator('input');
    const box0 = await input.boundingBox();
    await input.fill('px-');
    const box1 = await page.locator('[data-testid="class-row"][data-class="px-"] input').boundingBox();
    await S.check(() => expect(!!box0 && !!box1 && box0.x === box1.x && box0.width === box1.width, `⑤ 打字时输入框横跳：${JSON.stringify(box0)} → ${JSON.stringify(box1)}`));
    await page.locator('[data-testid="class-row"][data-class="px-"] input').fill('px-5 py-3');
    await page.locator('[data-testid="class-row"][data-class="px-5 py-3"] input').blur();
    await S.check(async () => expect((await row('px-5').count()) === 1 && (await row('py-3').count()) === 1, `⑤ 带空格的行失焦应拆成两行：${JSON.stringify(await classesNow())}`));
    // 6 没收录 / 非 token 色的标注（看完删掉）
    await add.fill('foo-bar bg-blue-500'); await add.press('Enter');
    await S.check(async () => expect((await desc('foo-bar')) === '未收录', `⑥ foo-bar：${await desc('foo-bar')}`));
    await S.check(async () => expect((await desc('bg-blue-500')).includes('非 token 色'), `⑥ bg-blue-500：${await desc('bg-blue-500')}`));
    await row('foo-bar').getByTestId('class-remove').click();
    await row('bg-blue-500').getByTestId('class-remove').click();
    // 7 ⌘S：按行序存回
    await page.locator('[data-testid="inspector-body"]').focus();
    await page.keyboard.press('ControlOrMeta+s');
    const expected = 'inline-flex items-center justify-center h-12 px-5 py-3 rounded-full bg-secondary text-on-primary shadow-md gap-2 tracking-wide';
    await S.check(() => eventually(async () => {
      const html = (await revisionHtml(sid, (await detail(pid)).screens[0].currentRevisionId)).html;
      const tag = html.match(/<button[^>]*id="toggle"[^>]*>/)?.[0] ?? '';
      expect(tag.includes(`class="${expected}"`), `⑦ 存回的类名：${tag.match(/class="([^"]*)"/)?.[1]}`);
    }, 15000));
  } catch (e) { S.fail(e); }
  finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '一行一个、说明按项目取值；‹ › 换档且到头不可点；颜色下拉换 token；删行 / 加行 / 失焦拆行；未收录与非 token 色有标注；打字不横跳；⌘S 按行序存回';
});

// TC-EDIT-031 逐级选（REQ-EDIT-001 v1.00）：Shift+↑ 选父级、Shift+↓ 回到子级；悬停时扩大高亮、选中后移动选中；检查器祖先路径点选与悬停预览
await step('TC-EDIT-031', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Climb', '--device', 'mobile', '--screens', '1', '--no-shot');
  const pid = r.projectId;
  const S = softly();
  type Box = { x: number; y: number; w: number; h: number } | null;
  const near = (a: Box, b: Box) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
  // 屏内两层框：悬停框是虚线那层（外扩 2 px），选中框带 data-quilt-selection、标签写「tag · qid」
  const probe = (frameSel: string) => ({
    frame: async () => (await page.locator(frameSel).elementHandle())!.contentFrame(),
    hover: async (): Promise<Box> => (await (await page.locator(frameSel).elementHandle())!.contentFrame())!.evaluate(() => {
      const b = Array.from(document.querySelectorAll<HTMLElement>('div[data-quilt-ui]')).find((d) => d.style.borderStyle === 'dashed');
      if (!b || b.style.display === 'none') return null;
      const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    rect: async (q: string): Promise<Box> => (await (await page.locator(frameSel).elementHandle())!.contentFrame())!.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect(); return { x: Math.round(r.x - 2), y: Math.round(r.y - 2), w: Math.round(r.width + 4), h: Math.round(r.height + 4) };
    }, q),
    label: async () => (await (await page.locator(frameSel).elementHandle())!.contentFrame())!.evaluate(() => document.querySelector('[data-quilt-selection] span')?.textContent ?? ''),
  });
  // 画布上的卡片带缩放：Playwright 按 iframe 内坐标算的指针位置会偏到别的元素上，这里按 iframe 的实际缩放自己换算
  const pointAt = async (frameSel: string, q: string) => {
    const fr = page.locator(frameSel);
    const box = (await fr.boundingBox())!;
    const inner = await (await (await fr.elementHandle())!.contentFrame())!.evaluate((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, vw: window.innerWidth }; }, q);
    const k = box.width / inner.vw;
    return { x: box.x + inner.x * k, y: box.y + inner.y * k };
  };
  const current = async () => (await page.locator('[data-testid="el-path"] [aria-current="location"]').innerText().catch(() => '')).trim();
  const crumbs = async () => (await page.locator('[data-testid="el-path"] button').allInnerTexts()).map((t) => t.trim()).join(' › ');
  const at = (tag: string, msg: string) => eventually(async () => expect((await current()) === tag, `${msg}：当前层是 ${await current()}`), 5000);
  try {
    const comp = await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Box', html: '<section class="p-4"><div><p><span>x</span></p></div></section>' }) });
    expect(comp.status === 201, `建组件 Box ${comp.status}`);
    // 组件卡默认落在左下可能被输入框压住，摆在右边又会被检查器盖住：摆到风格指南左边、竖向居中
    await apiJson(`/v1/components/${comp.body.component.id}`, { method: 'PATCH', body: JSON.stringify({ x: -1000, y: 300 }) });
    await page.goto(`${WEB}/p/${pid}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await card.waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    const P1 = probe('.card.focused iframe');
    const SPAN = 'ul li a span.flex-1';
    await fl.locator(SPAN).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    // 1 悬停在最里层的 span 上，焦点在画布：Shift+↑ 两次，悬停框扩到 a、li；还没选中
    const p1 = await pointAt('.card.focused iframe', SPAN);
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    await S.check(() => eventually(async () => expect(near(await P1.hover(), await P1.rect(SPAN)), '① 悬停框应先在 span 上'), 3000));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => eventually(async () => expect(near(await P1.hover(), await P1.rect('ul li a')), '① 第一次 Shift+↑ 悬停框应框住 a'), 3000));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => eventually(async () => expect(near(await P1.hover(), await P1.rect('ul li')), '① 第二次 Shift+↑ 悬停框应框住 li'), 3000));
    await S.check(async () => expect((await page.getByTestId('el-path').count()) === 0, '① 还没点，检查器不该有选中'));
    // 2 不动指针点一下：选中 li，路径到 span，li 当前、a / span 在它之下
    await page.mouse.down(); await page.mouse.up();
    await at('li', '② 点一下应选中悬停框所在的 li');
    await S.check(async () => expect((await crumbs()) === 'div › main › ul › li › a › span', `② 祖先路径不对：${await crumbs()}`));
    await S.check(async () => expect((await P1.label()).startsWith('li · '), `② 选中框标签不对：${await P1.label()}`));
    // 3 焦点在检查器上按 Shift+↑：选中上移到 ul
    await S.check(() => eventually(async () => expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid) === 'inspector-body', '③ 点选后焦点应在检查器上'), 3000));
    await page.keyboard.press('Shift+ArrowUp');
    await at('ul', '③ Shift+↑ 应选中 ul');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await S.check(async () => expect((await current()) === 'ul', `③ Enter 不该换层：${await current()}`));
    await S.check(() => eventually(async () => expect((await P1.label()).startsWith('ul · '), `③ 选中框标签应跟到 ul：${await P1.label()}`), 3000));
    // 4 Shift+↓ 沿锚点链往下走，到 span 为止
    for (const tag of ['li', 'a', 'span']) { await page.keyboard.press('Shift+ArrowDown'); await at(tag, `④ Shift+↓ 应回到 ${tag}`); }
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(400);
    await S.check(async () => expect((await current()) === 'span', `④ 到锚点后再按 Shift+↓ 应停在 span：${await current()}`));
    // 5 点路径上的 main：选中 main、路径不变；Shift+↓ 回到 ul
    await page.locator('[data-testid="el-path"] button', { hasText: /^main$/ }).click();
    await at('main', '⑤ 点路径上的 main 应选中它');
    await S.check(async () => expect((await crumbs()) === 'div › main › ul › li › a › span', `⑤ 路径应不变：${await crumbs()}`));
    await page.keyboard.press('Shift+ArrowDown');
    await at('ul', '⑤ 从 main 按 Shift+↓ 应回到 ul');
    // 6 悬停路径上的 div：屏上悬停框框住屏根，移开撤掉
    const rootCrumb = page.locator('[data-testid="el-path"] button').first();
    await rootCrumb.hover();
    await S.check(() => eventually(async () => expect(near(await P1.hover(), await P1.rect('body > div[data-qid]')), '⑥ 悬停路径上的 div 应在屏上框住屏根'), 3000));
    await page.getByTestId('inspector-body').hover({ position: { x: 10, y: 200 } });
    await S.check(() => eventually(async () => expect((await P1.hover()) === null, '⑥ 移开后悬停框应撤掉'), 3000));
    // 7 Tab 从检查器直接进文案框（路径按钮不进 Tab 序）；文案框里 Shift+↑ 不换选中
    await page.locator('[data-testid="inspector-body"]').focus();
    await page.keyboard.press('Tab');
    await S.check(async () => expect(await page.evaluate(() => document.activeElement?.id) === 'el-text', `⑦ 从检查器按 Tab 应进文案框：${await page.evaluate(() => document.activeElement?.tagName + ' ' + (document.activeElement?.getAttribute('data-qid') ?? ''))}`));
    await page.locator('#el-text').focus();
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(400);
    await S.check(async () => expect((await current()) === 'ul', `⑦ 文案框里按 Shift+↑ 不该换选中：${await current()}`));
    // 8 焦点在预览 iframe 里：运行时就地处理
    await page.locator('.card.focused iframe').focus();
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => at('main', '⑧ 焦点在 iframe 里按 Shift+↑ 应上移到 main'));
    // 9 组件卡：Esc 退出这一屏后选择元素态仍开着，双击组件卡聚焦它就在它上面选元素；点 span，Shift+↑ 两次
    await page.keyboard.press('Escape');
    await page.locator('.card.focused').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    const compCard = page.locator('[data-testid="component-card"][data-name="Box"]');
    // 组件卡摆在视口外时不量尺寸、不出 data-ready：先适配视图让它进画面再等
    await page.keyboard.press('f');
    await page.waitForTimeout(600);
    await page.locator('[data-testid="component-card"][data-name="Box"][data-ready]').waitFor({ timeout: 20000 });
    await compCard.locator('.gesture').dblclick();
    await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '⑨ 选择元素态下双击组件卡没聚焦它'));
    const cf = page.frameLocator('.comp.focused iframe');
    await cf.locator('section span').waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    const p9 = await pointAt('.comp.focused iframe', 'section span');
    await page.mouse.click(p9.x, p9.y);
    await at('span', '⑨ 组件里点 span 应选中它');
    await S.check(async () => expect((await crumbs()) === 'section › div › p › span', `⑨ 组件的祖先路径不对：${await crumbs()}`));
    await page.locator('[data-testid="inspector-body"]').focus();
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => at('p', '⑨ 组件里 Shift+↑ 应选中 p'));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => at('div', '⑨ 再按应选中 div'));
  } catch (e) { S.fail(e); }
  finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '悬停 Shift+↑ 扩到 a、li，点中 li；选中后 Shift+↑ / Shift+↓ 上下走、到锚点为止；路径点选不改路径、悬停预览；文案框里不触发；iframe 里就地处理；组件卡同样可用';
});

// TC-EDIT-032 撤销不了的删除先确认（v1.03 UX-1）：组件里的元素（Delete 键与「删除元素」按钮都先弹确认，写明同步屏数；取消不删、确认才删）；
// 设计系统面板删约定
await step('TC-EDIT-032', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Confirm', '--device', 'mobile', '--screens', '2', '--no-shot');
  const pid = r.projectId; const s1 = r.screens[0].id;
  const S = softly();
  const dialog = page.getByRole('alertdialog');
  type CompRow = { id: string; html: string; usedBy: string[] };
  try {
    const html1 = (await revisionHtml(s1, (await detail(pid)).screens.find((s) => s.id === s1)!.currentRevisionId)).html;
    const c = await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'AppBar', fromScreenId: s1, qid: qidOf(html1, 'class="h-14 flex')!, applyToScreens: true }) });
    expect(c.status === 201, `建组件 ${c.status}`);
    const compId = c.body.component.id;
    const comp = async () => ((await detail(pid)) as unknown as { components: CompRow[] }).components.find((x) => x.id === compId)!;
    const used = (await comp()).usedBy.length;
    expect(used >= 1, '前置不成立：组件没用在任何屏上');
    // 组件卡挪到屏的右侧，别压在检查器底下
    await apiJson(`/v1/components/${compId}`, { method: 'PATCH', body: JSON.stringify({ x: 900, y: 0 }) });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="component-card"][data-name="AppBar"][data-ready]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="component-card"][data-name="AppBar"] .gesture').dblclick();
    await eventually(async () => expect((await page.locator('.comp.focused').count()) === 1, '双击组件卡没进交互态'));
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForTimeout(500);
    await page.frameLocator('.comp.focused iframe').locator('h1').dispatchEvent('click');
    await page.locator('#el-text').waitFor({ timeout: 8000 });
    // 1 焦点在检查器上按 Delete：弹确认、写明同步屏数；取消不删
    await page.locator('[data-testid="inspector-body"]').focus();
    await page.keyboard.press('Delete');
    await dialog.waitFor({ timeout: 5000 });
    const t1 = await dialog.innerText();
    await S.check(() => expect(t1.includes('删除组件「AppBar」里的这个元素？') && t1.includes(`会同步到用它的 ${used} 屏，撤销不了`), `① 确认框文案不对：${t1}`));
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(800);
    await S.check(async () => expect((await comp()).html.includes('<h1'), '① 取消后组件里的 h1 不该被删'));
    // 2 「删除元素」按钮同样先确认；确认后删，提示写同步屏数
    await page.getByRole('button', { name: '删除元素' }).click();
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: '删除' }).click();
    await page.getByText(`已删除组件「AppBar」里的元素，同步 ${used} 屏`).last().waitFor({ timeout: 15000 });
    await S.check(async () => expect(!(await comp()).html.includes('<h1'), '② 确认后组件里的 h1 应被删'));
    // 3 删约定：先确认，取消不删、确认才删
    const ds = (await detail(pid)).designSystem as unknown as { version: number };
    const put = await apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ conventions: ['按钮一律用主色'], expectedVersion: ds.version }) });
    expect(put.status === 200, `写约定 ${put.status}`);
    // 约定存在 DESIGN.md 的「## 约定」一节里，项目详情不单列
    const conventions = async () => ((await detail(pid)).designSystem as unknown as { designMd: string }).designMd.includes('按钮一律用主色') ? ['按钮一律用主色'] : [];
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.keyboard.press('Alt+d');
    const delConv = page.getByRole('button', { name: '删除约定：按钮一律用主色' });
    await delConv.click();
    await dialog.waitFor({ timeout: 5000 });
    await S.check(async () => expect((await dialog.innerText()).includes('删除这条约定？'), `③ 删约定没先确认：${await dialog.innerText()}`));
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(500);
    await S.check(async () => expect((await conventions()).length === 1, '③ 取消后约定不该被删'));
    await delConv.click();
    await dialog.getByRole('button', { name: '删除' }).click();
    await page.getByText('已删除这条约定').last().waitFor({ timeout: 10000 });
    await S.check(async () => expect((await conventions()).length === 0, '③ 确认后约定应被删'));
  } catch (e) { S.fail(e); }
  finally { await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '组件里删元素（Delete 与按钮）先确认、写明同步屏数，取消不删、确认才删；删约定同样先确认';
});

// TC-EDIT-033 计划的修订全部落库后被时限中止，按成功收尾（§11 v1.03 GEN-3）：用 QUILT_JOB_TIMEOUT_TOTAL_MS 把时限定死在 5 s 重启 API，
// 对一张截图要 ~20 s 的慢屏重生成一块（桩模型立刻回）：修订 1 s 内落库、5 s 时截图还没拍完。作业应 succeeded、current 已前移。要 QUILT_E2E_RESTART
await step('TC-EDIT-033', async () => {
  const http = await import('node:http');
  const hold = http.createServer(() => { /* 不回 */ });
  await new Promise<void>((r) => hold.listen(3987, '127.0.0.1', () => r()));
  let pid = '';
  try {
    await restartApi({ QUILT_JOB_TIMEOUT_TOTAL_MS: '5000' });
    pid = seedJson<{ projectId: string }>('seed:project', '--name', 'Landed', '--device', 'mobile', '--screens', '1', '--no-shot').projectId;
    const [sid] = await mcpScreens(pid, [{ name: 'Slow', route: '/slow', html: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Slow</h1><img src="http://127.0.0.1:3987/hang.png" width="8" height="8" alt=""></div>' }]);
    const rev0 = (await revs082(sid))[0]!.id;
    const qid = qidOf((await revisionHtml(sid, rev0)).html, 'class="text-xl"')!;
    const t0 = Date.now();
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: sid, qid, prompt: '换成一句标语', expectedRevisionId: rev0, runner: { kind: 'model', driver: 'stub', model: 'stub' } } }) });
    expect(r.status === 202, `重生成一块 ${r.status}`);
    const job = await waitJob(r.body.job.id, 120);
    const took = Math.round((Date.now() - t0) / 1000);
    expect(job.status === 'succeeded', `修订已落库后被时限中止应按成功收尾：${job.status} ${JSON.stringify(job.output)}（${took} s）`);
    expect((await revs082(sid))[0]!.id !== rev0, 'current 应前移到新修订');
    expect(took > 5, `作业 ${took} s 就收口，时限没在截图途中触发，前置不成立`);
    return `时限 5 s、截图拍了约 ${took} s：succeeded，修订已生效`;
  } finally {
    if (pid) await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
    hold.closeAllConnections(); hold.close();
    await restartApi({});
  }
});

// TC-EDIT-034 提示条（PAGE-CANVAS「提示条」v1.04 UX-5）：直改成功的提示带「撤销（⌘Z）」，点了等于 ⌘Z；删元素写「已删除元素」；
// 带动作的提示条悬停不计时、移开后照常消失；错误提示 5 s 时还在、可手动关；多选对齐的提示同样带撤销
await step('TC-EDIT-034', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Toasts', '--device', 'mobile', '--screens', '2', '--no-shot');
  const pid = r.projectId; const [s1, s2] = r.screens.map((s) => s.id);
  const S = softly();
  const toast = (text: string) => page.getByTestId('toast').filter({ hasText: text });
  const currentHtml = async () => (await revisionHtml(s1, (await detail(pid)).screens.find((s) => s.id === s1)!.currentRevisionId)).html;
  const pickIn = async (selector: string) => {
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator(selector).waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await fl.locator(selector).click();
    await page.locator('#el-text').waitFor({ timeout: 5000 });
  };
  try {
    // 1 改文案保存：提示带「撤销（⌘Z）」，点了 current 回到改之前的内容
    await pickIn('#toggle');
    await page.locator('#el-text').fill('立即登录');
    await page.getByRole('button', { name: '保存（零 token）' }).click();
    const saved = toast('已更新，截图稍后刷新');
    await saved.waitFor({ timeout: 15000 });
    await S.check(async () => expect((await currentHtml()).includes('立即登录'), '① 保存没落库'));
    await S.check(async () => expect((await saved.getByTestId('toast-action').innerText()) === '撤销（⌘Z）', '① 直改成功的提示没带「撤销（⌘Z）」'));
    await saved.getByTestId('toast-action').click();
    await S.check(() => toast('已撤销修改元素').waitFor({ timeout: 10000 }).catch(() => { throw new Error('① 点撤销后没出「已撤销修改元素」'); }));
    await S.check(() => eventually(async () => expect(!(await currentHtml()).includes('立即登录'), 'undo'), 10000).catch(() => { throw new Error('① 点撤销后 current 仍是改过的内容'); }));
    // 2 删元素：提示写「已删除元素」并带撤销；悬停 5 s 不消失，移开后 3.2 s 内（留余量 4.5 s）消失
    await pickIn('h1');
    await page.getByRole('button', { name: '删除元素' }).click();
    const removed = toast('已删除元素');
    await removed.waitFor({ timeout: 15000 });
    await S.check(async () => expect((await removed.getByTestId('toast-action').count()) === 1, '② 删元素的提示没带撤销'));
    // 悬停 5 s：提示条会随输入框高度变化挪位置，挪出指针下方时重新悬停（移开即重新计时，所以持续悬停期间它不该消失）
    await removed.hover();
    let at = await removed.boundingBox();
    let pointer = at && { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    for (const t0 = Date.now(); Date.now() - t0 < 5000;) {
      await page.waitForTimeout(250);
      at = await removed.boundingBox();
      if (!at || !pointer) break;
      if (pointer.x < at.x || pointer.x > at.x + at.width || pointer.y < at.y || pointer.y > at.y + at.height) { await removed.hover(); pointer = { x: at.x + at.width / 2, y: at.y + at.height / 2 }; }
    }
    await S.check(async () => expect((await removed.count()) === 1, '② 悬停 5 s 后提示条不该消失'));
    await page.mouse.move(10, 10);
    await S.check(() => eventually(async () => expect((await removed.count()) === 0, 'gone'), 4500).catch(() => { throw new Error('② 移开后提示条 4.5 s 内没消失'); }));
    // 3 错误提示：5 s 时还在、带关闭键，点了就收
    await page.route('**/v1/screens/*/elements/*', (rt) => rt.abort());
    await pickIn('#toggle');
    await page.locator('#el-text').fill('失败一次');
    await page.getByRole('button', { name: '保存（零 token）' }).click();
    const failed = toast('保存失败');
    await failed.waitFor({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await S.check(async () => expect((await failed.count()) === 1 && (await failed.getAttribute('data-kind')) === 'error', '③ 错误提示 5 s 时不该消失'));
    await failed.getByRole('button', { name: '关闭提示' }).click();
    await S.check(async () => expect((await failed.count()) === 0, '③ 点关闭后错误提示应收起'));
    await page.unroute('**/v1/screens/*/elements/*');
    // 4 多选上对齐：提示「已对齐 2 屏」带撤销，点了两屏回到原位
    for (const [id, x, y] of [[s1, 0, 0], [s2, 700, 150]] as const) await apiJson(`/v1/screens/${id}`, { method: 'PATCH', body: JSON.stringify({ x, y }) });
    const pos = async () => Object.fromEntries((await apiJson<{ screens: { id: string; x: number; y: number }[] }>(`/v1/projects/${pid}`)).body.screens.map((s) => [s.id, s]));
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.locator('[data-testid="screen-card"]').first().locator('.gesture').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByTestId('arrange-bar').getByTestId('arrange-top').click();
    const aligned = toast('已对齐 2 屏');
    await aligned.waitFor({ timeout: 8000 });
    await S.check(() => eventually(async () => expect((await pos())[s2].y === 0, 'aligned'), 8000).catch(() => { throw new Error('④ 上对齐没落库'); }));
    await aligned.getByTestId('toast-action').click();
    await S.check(() => eventually(async () => { const p = await pos(); expect(p[s2].y === 150 && p[s1].y === 0, 'undo'); }, 8000).catch(() => { throw new Error('④ 点撤销后两屏没回到原位'); }));
  } catch (e) { S.fail(e); }
  finally { await page.unroute('**/v1/screens/*/elements/*').catch(() => {}); await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '直改、删元素、对齐的提示带「撤销（⌘Z）」且点了即撤销；删元素写「已删除元素」；悬停不计时；错误提示 5 s 时仍在、可手动关';
});

// TC-EDIT-035 作业进行中时的面板（PAGE-CANVAS「作业进行中时的面板」v1.04 UX-3）：别的屏有作业在跑时，删约定、一句话改设计系统照常可点；
// 回刷所有屏不可点、就地写是哪个作业；检查器所在的屏正在改时写明原因，按 ⌘S 弹同样的提示
await step('TC-EDIT-035', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'BusyPanels', '--device', 'mobile', '--screens', '2', '--no-shot');
  const pid = r.projectId; const s1 = r.screens[0].id;
  const S = softly();
  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  let held = '';
  try {
    // 前置：写一条约定；再对 s1 起一个停 60 s 的改屏
    const ds = (await detail(pid)).designSystem;
    expect((await apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ conventions: ['按钮一律用主色'], expectedVersion: ds.version }) })).status === 200, '写约定失败');
    const h = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'edit_screens', input: { prompt: '[stub-hold:60000] 改标题', screenIds: [s1], versions: 1, runner: STUB_RUNNER } }) });
    expect(h.status === 202, `起停顿作业 ${h.status}`);
    held = h.body.job.id;
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    // 1 设计系统面板：回刷不可点并写明原因；删约定、一句话改设计系统照常可用
    await page.keyboard.press('Alt+d');
    const blocked = page.getByTestId('ds-apply-blocked');
    await blocked.waitFor({ timeout: 10000 });
    const why = await blocked.innerText();
    await S.check(() => expect(why === '有作业进行中：改「Screen 1」，等它结束再回刷', `① 回刷的原因不对：${why}`));
    await S.check(async () => expect(await page.getByRole('button', { name: '回刷所有屏' }).isDisabled(), '① 有作业在跑时回刷所有屏应不可点'));
    await S.check(async () => expect(!(await page.getByRole('button', { name: '删除约定：按钮一律用主色' }).isDisabled()), '① 删约定不该被作业挡住'));
    await page.getByTestId('ds-instruction').fill('正文大一号');
    await S.check(async () => expect(!(await page.getByTestId('ds-propose').isDisabled()), '① 提炼并预览不该被作业挡住'));
    // 2 检查器在正改的 s1 上：写明原因，按 ⌘S 弹同样的提示（先让指令框失焦再按 ⌥D 关掉设计系统面板，快捷键在输入框里不生效）
    await blurActive();
    await page.keyboard.press('Alt+d');
    await page.keyboard.press('ControlOrMeta+e');
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('h1').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await fl.locator('h1').click();
    const note = page.getByTestId('el-busy');
    await note.waitFor({ timeout: 5000 });
    await S.check(async () => expect((await note.innerText()) === '这一屏正在改，等这一轮完事', `② 检查器的原因不对：${await note.innerText()}`));
    await page.keyboard.press('ControlOrMeta+s');
    await S.check(() => page.getByTestId('toast').filter({ hasText: '这一屏正在改，等这一轮完事' }).waitFor({ timeout: 3000 }).catch(() => { throw new Error('② 屏忙时按 ⌘S 没有提示'); }));
  } catch (e) { S.fail(e); }
  finally {
    if (held) await apiJson(`/v1/jobs/${held}/cancel`, { method: 'POST' }).catch(() => {});
    await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
  }
  S.done();
  return '别的屏有作业在跑时删约定、一句话改设计系统照常可点；回刷所有屏不可点并写明是哪个作业；检查器写明这一屏正在改，⌘S 弹同样的提示';
});

// TC-EDIT-036 改屏走补丁（ADR-007 / ADR-012 v1.05）：OpenAI 兼容桩看到的是补丁提示词，回一块把第一个 <h1> 换掉的补丁——新修订里标题变了、
// 其余元素的 qid 一个不变；补丁对不上时同一轮改用整屏提示词再要一次；只改样板屏这一屏时参考屏里没有样板屏，和别的屏一起改时有
await step('TC-EDIT-036', async () => {
  const { startOpenAiStub } = await import('./openai-stub.ts');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Patch', '--device', 'mobile', '--screens', '2', '--no-shot');
  const pid = r.projectId; const [s1, s2] = r.screens.map((s) => s.id);
  const S = softly();
  const FIND = '<<<<<<< FIND';
  const WHOLE = '<div class="min-h-dvh flex flex-col bg-background text-on-background"><h1 class="text-xl">整屏重写</h1></div>';
  const stub = startOpenAiStub({ port: 3975, apiKey: 'good-key-0036', reply: (hit) => {
    if (!hit.user.includes(FIND)) return WHOLE;   // 退回的整屏提示词（与通道验证）
    const current = hit.user.split('\nCURRENT HTML:\n')[1] ?? '';
    const h1 = /<h1[^>]*>[^<]*<\/h1>/.exec(current)?.[0] ?? '';
    if (hit.user.includes('MISS') || !h1) return `${FIND}\n<h1 data-qid="q0">没有这一处</h1>\n=======\n<h1>x</h1>\n>>>>>>> REPLACE`;
    return `${FIND}\n${h1}\n=======\n${h1.replace(/>[^<]*</, '>补丁标题<')}\n>>>>>>> REPLACE`;
  } });
  const qids = (html: string) => [...html.matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]).sort().join(',');
  const current = async (sid: string) => { const d = await detail(pid); const s = d.screens.find((x) => x.id === sid)!; return { rev: s.currentRevisionId, html: (await revisionHtml(sid, s.currentRevisionId)).html }; };
  const run = async (prompt: string, screenIds: string[], channelId: string) => {
    const j = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'edit_screens', input: { prompt, screenIds, versions: 1, runner: { kind: 'channel', channelId } } }) });
    expect(j.status === 202, `建改屏作业 ${j.status}`);
    return waitJob(j.body.job.id, 90) as Promise<{ status: string; output: { tokensOut?: number } }>;
  };
  try {
    const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 补丁', endpoint: stub.url, model: 'stub-36', apiKey: 'good-key-0036' }) });
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' })).body.ok, '桩通道验证未通过');
    const cid = ch.body.channel.id;
    expect((await apiJson(`/v1/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ exemplarScreenId: s1 }) })).status === 200, '设样板屏失败');
    // 1 只改样板屏 s1：一次调用、补丁提示词、参考屏里没有样板屏；新修订标题是「补丁标题」，qid 集合不变
    const before = await current(s1);
    stub.hits.length = 0;
    const j1 = await run('标题改一下', [s1], cid);
    const after = await current(s1);
    await S.check(() => expect(j1.status === 'succeeded' && stub.hits.length === 1, `① 应一次调用成功：${j1.status}，${stub.hits.length} 次`));
    await S.check(() => expect(stub.hits[0]?.user.includes(FIND) && !stub.hits[0]?.system.includes('exemplar screen'), '① 应是补丁提示词，且只改样板屏时参考屏里不放样板屏'));
    await S.check(() => expect(after.rev !== before.rev && after.html.includes('>补丁标题<'), '① 新修订里标题没换成「补丁标题」'));
    await S.check(() => expect(qids(after.html) === qids(before.html), `① 补丁之后 qid 集合变了：${qids(before.html).split(',').length} → ${qids(after.html).split(',').length}`));
    // 2 两屏一起改：样板屏照旧在参考屏里
    stub.hits.length = 0;
    const j2 = await run('标题都改一下', [s1, s2], cid);
    await S.check(() => expect(j2.status === 'succeeded' && stub.hits.length === 2 && stub.hits.every((h) => h.system.includes('exemplar screen')), `② 两屏一起改时参考屏里应有样板屏：${j2.status}，${stub.hits.length} 次`));
    // 3 补丁对不上：同一轮里第二次调用是整屏提示词，落下的是整屏重写的结果，两次调用都计用量
    stub.hits.length = 0;
    const j3 = await run('MISS 改标题', [s2], cid);
    const s2now = await current(s2);
    await S.check(() => expect(j3.status === 'succeeded' && stub.hits.length === 2 && stub.hits[0].user.includes(FIND) && !stub.hits[1].user.includes(FIND), `③ 应先补丁、再退回整屏：${j3.status}，${stub.hits.map((h) => (h.user.includes(FIND) ? '补丁' : '整屏')).join(' → ')}`));
    await S.check(() => expect(s2now.html.includes('整屏重写') && j3.output.tokensOut === 14, `③ 应落整屏重写的结果、用量记两次调用（tokensOut ${j3.output.tokensOut}）`));
  } catch (e) { S.fail(e); }
  finally { await stub.close(); await apiJson(`/v1/projects/${pid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '只改样板屏：一次补丁调用、参考屏不放样板屏、标题换上且 qid 集合不变；两屏一起改：参考屏有样板屏；补丁对不上：同一轮退回整屏、用量记两次';
});

// TC-EDIT-038 检查器没存的文案与说明按元素暂存（REQ-EDIT-001 / REQ-EDIT-002 v1.23）：换到别的元素时字段是它自己的，点回来没存的还在
await step('TC-EDIT-038', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Drafts', '--device', 'mobile', '--screens', '1');
  const S = softly();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${WEB}/p/${r.projectId}`);
  const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
  await card.waitFor({ timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
  await card.locator('.gesture').click();
  await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
  const fl = page.frameLocator('.card.focused iframe');
  await fl.locator('#toggle').waitFor({ timeout: 15000 });
  // 点屏内元素，直到检查器标题报的 qid 就是它（quilt:mode 送达前的那一下会被当成普通交互）
  const inspQid = async () => (await page.locator('.slide-in-right').innerText()).match(/· (q\d+)/)?.[1] ?? null;
  const pickIn = async (sel: string) => {
    const want = await fl.locator(sel).first().getAttribute('data-qid');
    for (let i = 0; i < 6; i++) { await fl.locator(sel).first().click(); await page.waitForTimeout(500); if ((await inspQid()) === want) return; }
    throw new Error(`点 ${sel} 后没选中它（要 ${want}，实际 ${await inspQid()}）`);
  };
  try {
    await pickIn('#toggle');
    await page.locator('#el-text').fill('改过但还没保存的文案');
    await page.locator('#el-prompt').fill('改成横向卡片');
    await pickIn('h1');
    const other = { text: await page.locator('#el-text').inputValue(), prompt: await page.locator('#el-prompt').inputValue() };
    await S.check(() => expect(other.text.startsWith('Screen 1') && other.prompt === '', `换到标题时字段应是标题自己的：${JSON.stringify(other)}`));
    await pickIn('#toggle');
    const back = { text: await page.locator('#el-text').inputValue(), prompt: await page.locator('#el-prompt').inputValue() };
    await S.check(() => expect(back.text === '改过但还没保存的文案' && back.prompt === '改成横向卡片', `点回按钮时没存的文案与说明应还在：${JSON.stringify(back)}`));
  } catch (e) { S.fail(e); }
  S.done();
  return '换到标题时文案是它自己的、说明为空；点回按钮时没存的文案与说明都还在';
});

// TC-EDIT-039 批注已撤下（REQ-EDIT-004 / REQ-AGENT-002 v1.23）：画布与草稿本没有入口、⌥N 不开任何东西，批注接口 404，MCP 没有批注工具、项目详情没有批注字段
await step('TC-EDIT-039', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'NoNotes', '--device', 'mobile', '--screens', '1', '--no-shot');
  const pid = r.projectId; const sid = r.screens[0].id;
  const S = softly();
  // 前置：草稿本里用 stub 出一张组件草稿（第二行的标记定画框）
  const sb = (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId;
  const m = await apiJson<{ job: { id: string } }>(`/v1/projects/${sb}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '一张播放卡片\n[stub-frame:component]', runner: STUB_RUNNER }) });
  expect(m.status === 202, `出草稿 ${m.status} ${JSON.stringify(m.body).slice(0, 160)}`);
  const dj = await waitJob(m.body.job.id, 120);
  const draft = (dj.output?.screenIds as string[] | undefined)?.[0];
  expect(dj.status === 'succeeded' && draft, `出草稿作业 ${dj.status}：${JSON.stringify(dj.output).slice(0, 160)}`);
  try {
    // 1 画布：工具栏没有「批注」；⌥N 不开批注、不出待命提示；带 panel=annotate 打开不开任何面板
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    const annoTool = page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: /批注/ });
    await S.check(async () => expect((await annoTool.count()) === 0, '① 工具栏还有「批注」'));
    await blurActive();
    await page.keyboard.press('Alt+n');
    await page.waitForTimeout(500);
    await S.check(async () => expect(!page.url().includes('panel=annotate') && (await page.getByTestId('armed-hint').count()) === 0, `① ⌥N 后不该开批注：${page.url()}，待命提示 ${await page.getByTestId('armed-hint').count()}`));
    await page.goto(`${WEB}/p/${pid}?panel=annotate`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const shellPanel = await page.locator('.canvas-shell').getAttribute('data-panel');
    await S.check(async () => expect(shellPanel === 'closed' && (await page.getByTestId('armed-hint').count()) === 0, `① 带 panel=annotate 打开不该开任何面板：data-panel=${shellPanel}`));
    // 2 草稿本：工具条没有「批注」开关；⌥N 后看板不变
    await page.goto(`${WEB}/sketch?d=${draft}`);
    await page.getByTestId('sketch-page').waitFor({ timeout: 15000 });
    await eventually(async () => expect((await page.getByTestId('sketch-stage').getAttribute('data-state')) === 'draft', '看板没打开这张草稿'), 10000);
    await S.check(async () => expect((await page.getByTestId('draft-annotate').count()) === 0, '② 草稿工具条还有「批注」'));
    const board = async () => ({ url: page.url(), stage: await page.getByTestId('sketch-stage').getAttribute('data-state'), pick: await page.getByTestId('draft-pick').getAttribute('aria-pressed') });
    await blurActive();
    const b0 = await board();
    await page.keyboard.press('Alt+n');
    await page.waitForTimeout(500);
    const b1 = await board();
    await S.check(() => expect(JSON.stringify(b1) === JSON.stringify(b0), `② ⌥N 后看板变了：${JSON.stringify(b0)} → ${JSON.stringify(b1)}`));
    // 3 批注接口都没有了
    const FAKE = crypto.randomUUID();
    const gone: [string, string, unknown?][] = [
      ['GET', `/v1/screens/${sid}/annotations`],
      ['POST', `/v1/screens/${sid}/annotations`, { qid: 'q1', note: '标题再大一点', anchorText: 'Screen 1', rect: { x: 0, y: 0, w: 100, h: 40 } }],
      ['PATCH', `/v1/annotations/${FAKE}`, { note: 'n' }],
      ['POST', `/v1/projects/${pid}/annotations/send`, { annotationIds: [FAKE] }],
    ];
    for (const [method, p, body] of gone) {
      const res = await apiJson<{ type?: string } | null>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      await S.check(() => expect(res.status === 404 && res.body?.type === '/errors/not-found', `③ ${method} ${p} 应 404 /errors/not-found：${res.status} ${res.body?.type}`));
    }
    // 4 MCP：没有名字里带 annotation 的工具；项目详情里没有 annotations 字段
    const { connectMcp, callTool } = await import('./mcp-client.ts');
    const mcp = await connectMcp();
    try {
      const annoTools = (await mcp.listTools()).tools.map((t) => t.name).filter((n) => n.includes('annotation'));
      await S.check(() => expect(annoTools.length === 0, `④ 还有批注工具：${annoTools.join(',')}`));
      const proj = await callTool(mcp, 'quilt.get_project', { projectId: pid });
      await S.check(() => expect(!proj.isError && !/"annotations"\s*:/.test(proj.text), `④ get_project 结果里还有 annotations 字段：${proj.text.slice(0, 160)}`));
    } finally { await mcp.close(); }
  } catch (e) { S.fail(e); }
  S.done();
  return '画布工具栏与草稿工具条都没有「批注」，⌥N 不开任何东西，panel=annotate 不开面板；四个批注接口 404；MCP 没有批注工具、项目详情没有 annotations';
});

// TC-EDIT-040 逐级选不被焦点控件的默认动作吃掉（源自缺陷 2026-10-22；v1.28 改用 Shift+↑ / Shift+↓）：点过路径按钮、用鼠标按过「保存」之后照样换层；
// 键盘 Tab 到的按钮上 Enter 照旧按下它；屏里点过链接后 Shift+↑ 不开新窗口
await step('TC-EDIT-040', async () => {
  const r = seedJson<{ projectId: string }>('seed:project', '--name', 'Climb2', '--device', 'mobile', '--screens', '1', '--no-shot');
  const S = softly();
  const current = async () => (await page.locator('[data-testid="el-path"] [aria-current="location"]').innerText().catch(() => '')).trim();
  const at = (tag: string, msg: string) => eventually(async () => expect((await current()) === tag, `${msg}：当前层是 ${await current()}`), 4000);
  const noChanges = () => page.getByText('没有改动', { exact: true }).count();
  const pages0 = page.context().pages().length;
  try {
    await page.goto(`${WEB}/p/${r.projectId}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await card.waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    const SPAN = 'ul li a span.flex-1';
    await fl.locator(SPAN).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    // 1 点 span 选中，再点路径上的 li：选中 li（焦点停在路径按钮上也不影响下一步）
    await fl.locator(SPAN).first().click();
    await at('span', '① 点文字应选中 span');
    await page.locator('[data-testid="el-path"] button', { hasText: /^li$/ }).click();
    await at('li', '① 点路径上的 li 应选中它');
    // 2 紧接着按 Shift+↓、两次 Shift+↑
    await page.keyboard.press('Shift+ArrowDown');
    await S.check(() => at('a', '② 点过路径后 Shift+↓ 应回到 a'));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => at('li', '② Shift+↑ 应选中 li'));
    await page.keyboard.press('Shift+ArrowUp');
    await S.check(() => at('ul', '② 再按 Shift+↑ 应选中 ul'));
    // 3 鼠标按「保存」（没有改动），再按 Shift+↓：换层，不再按一次保存
    const save = page.getByRole('button', { name: /^保存/ });
    await save.click();
    await eventually(async () => expect((await noChanges()) >= 1, '③ 点保存应提示没有改动'), 3000);
    await page.waitForTimeout(3500);
    const before3 = await noChanges();
    await page.keyboard.press('Shift+ArrowDown');
    await S.check(() => at('li', '③ 鼠标按过保存后 Shift+↓ 应回到 li'));
    await page.waitForTimeout(400);
    await S.check(async () => expect((await noChanges()) <= before3, '③ Enter 又按了一次保存'));
    // 4 键盘 Tab 到「保存」上按 Enter：照旧按下它，选中不变
    await page.waitForTimeout(3500);
    await page.locator('#el-text').focus();
    let onSave = false;
    for (let i = 0; i < 25 && !onSave; i++) { await page.keyboard.press('Tab'); onSave = await page.evaluate(() => !!(document.activeElement as HTMLElement | null)?.innerText?.trim().startsWith('保存')); }
    await S.check(async () => expect(onSave, '④ Tab 走不到「保存」'));
    if (onSave) {
      const before4 = await noChanges();
      await page.keyboard.press('Enter');
      await S.check(() => eventually(async () => expect((await noChanges()) > before4 || before4 > 0 && (await noChanges()) >= 1, '④ 键盘走到保存按 Enter 应提示没有改动'), 3000));
      await S.check(async () => expect((await current()) === 'li', `④ 键盘按保存不该换层：${await current()}`));
    }
    // 5 屏里点链接 a 本身（左缘），再按 Shift+↑：选中上移一级，不开新窗口、屏不跳走
    const box = await fl.locator('ul li a').first().boundingBox();
    if (box) await page.mouse.click(box.x + 3, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const picked = await current();
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(600);
    const after5 = await current();
    await S.check(async () => expect(!!picked && after5 !== picked, `⑤ 点过链接后 Shift+↑ 应换层：${picked} → ${after5}`));
    await S.check(async () => expect(page.context().pages().length === pages0, `⑤ 开了新窗口：${page.context().pages().length - pages0}`));
    await S.check(async () => expect((await page.locator('.card.focused').getAttribute('data-route')) === '/s1', '⑤ 屏跳走了'));
  } catch (e) { S.fail(e); }
  S.done();
  return '点过路径按钮、鼠标按过保存后 Shift+↓ / Shift+↑ 照样换层；Tab 到的保存按 Enter 照旧按下；点过链接 Shift+↑ 不开新窗口';
});

// TC-EDIT-042 画布选择元素按住 Shift 多选，检查器一起改（v1.26）：多选列表、× 回到单选、Shift+↑ 只移最后点中的那块、
// 一句话一次重生成这几块、退出聚焦清空；MCP 带 qids
await step('TC-EDIT-042', async () => {
  const { startOpenAiStub } = await import('./openai-stub.ts');
  const { connectMcp, callTool } = await import('./mcp-client.ts');
  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Multi', '--device', 'mobile', '--screens', '1', '--no-shot');
  const pid = r.projectId; const sid = r.screens[0].id;
  const S = softly();
  // 测试库里只有本机 agent 通道，检查器选它要先选会话才能发：建一条桩通道给检查器选上，建作业的请求在网络层换成 stub 驱动
  // （它按多块提示词逐块回、根元素加 data-stub="multi"），界面拼的请求体原样记下来核对
  const LABEL = 'Stub 多选';
  const stub = startOpenAiStub({ port: 3977, apiKey: 'good-key-0042', reply: 'OK' });
  const JOBS_RE = /\/v1\/projects\/[^/]+\/jobs$/;
  const sent: { kind: string; input: { qid?: string; qids?: string[] } }[] = [];
  let cid = '';
  const SPAN = 'ul li a span.flex-1';
  const set = (...xs: string[]) => [...xs].sort().join(',');
  const frame = async () => (await page.locator('.card.focused iframe').elementHandle())!.contentFrame();
  const boxes = async () => set(...((await (await frame())?.evaluate(() => Array.from(document.querySelectorAll('[data-quilt-selection]')).map((b) => (b as HTMLElement).innerText.trim()))) ?? []));
  const qidAt = async (sel: string, i: number) => (await frame())!.evaluate(({ s, k }) => document.querySelectorAll(s)[k]?.getAttribute('data-qid') ?? '', { s: sel, k: i });
  const rows = async () => set(...(await page.getByTestId('el-multi-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-qid') ?? ''))));
  // 卡片带缩放：按 iframe 的实际缩放换算指针位置（同 TC-EDIT-031 的 pointAt）；按住 Shift 点是加选 / 减选
  const clickIn = async (sel: string, i: number, shift = false) => {
    const box = (await page.locator('.card.focused iframe').boundingBox())!;
    const p = await (await frame())!.evaluate(({ s, k }) => { const b = document.querySelectorAll(s)[k].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, vw: innerWidth }; }, { s: sel, k: i });
    const z = box.width / p.vw;
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(box.x + p.x * z, box.y + p.y * z);
    if (shift) await page.keyboard.up('Shift');
  };
  const stubbed = (html: string, qid: string) => (new RegExp(`<[a-z][a-z0-9]*\\b[^>]*data-qid="${qid}"[^>]*>`).exec(html)?.[0] ?? '').includes('data-stub="multi"');
  const currentRev = async () => (await detail(pid)).screens[0].currentRevisionId;
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: LABEL, endpoint: stub.url, model: 'stub-42', apiKey: 'good-key-0042' }) })).body.channel.id;
    expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${cid}/probe`, { method: 'POST' })).body.ok, '桩通道探测未通过');
    await page.route(JOBS_RE, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = JSON.parse(req.postData() || '{}') as { kind: string; input: Record<string, unknown> };
      sent.push(JSON.parse(JSON.stringify(body)));
      await route.continue({ postData: JSON.stringify({ ...body, input: { ...body.input, runner: STUB_RUNNER } }) });
    });
    await page.goto(`${WEB}/p/${pid}`);
    const card = page.locator('[data-testid="screen-card"][data-route="/s1"]');
    await card.waitFor({ timeout: 15000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.getByTestId('armed-hint').waitFor({ timeout: 5000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator(SPAN).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    const q1 = await qidAt(SPAN, 0); const q2 = await qidAt(SPAN, 1);
    // 1 点 Item 1，按住 Shift 点 Item 2：「已选 2 个元素」、两行、两处选中框；没有文案框、类名框与「删除元素」
    await clickIn(SPAN, 0);
    await page.locator('#el-text').waitFor({ timeout: 5000 });
    await clickIn(SPAN, 1, true);
    await page.getByTestId('el-multi-title').waitFor({ timeout: 5000 });
    await S.check(async () => expect((await page.getByTestId('el-multi-title').innerText()).trim() === '已选 2 个元素' && (await rows()) === set(q1, q2), `① 检查器应是「已选 2 个元素」与这两行：「${await page.getByTestId('el-multi-title').innerText()}」 ${await rows()}`));
    await S.check(() => eventually(async () => expect((await boxes()) === set(`span · ${q1}`, `span · ${q2}`), `① 屏里应框住这两块：${await boxes()}`), 3000));
    await S.check(async () => expect((await page.locator('#el-text').count()) === 0 && (await page.getByTestId('class-list').count()) === 0 && (await page.getByRole('button', { name: '删除元素' }).count()) === 0, '① 多选时不该有文案框、类名框与「删除元素」'));
    // 2 点 Item 2 那一行的 ×：回到单选，检查器是 Item 1 的直改表单
    await page.locator(`[data-testid="el-multi-row"][data-qid="${q2}"] [data-testid="el-multi-remove"]`).click();
    await S.check(() => eventually(async () => expect((await page.getByTestId('el-multi').count()) === 0 && (await page.locator('#el-text').count()) === 1 && (await page.locator('#el-text').inputValue()) === 'Item 1 of screen 1', `② × 之后应回到 Item 1 的直改表单：多选 ${await page.getByTestId('el-multi').count()}，文案框 ${await page.locator('#el-text').count()}`), 5000));
    // 3 按住 Shift 再点 Item 2，按 Shift+↑：最后点中的 Item 2 上移到 a，Item 1 仍是 span
    await clickIn(SPAN, 1, true);
    await page.getByTestId('el-multi-title').waitFor({ timeout: 5000 });
    await page.keyboard.press('Shift+ArrowUp');
    const a2 = await qidAt('ul li a', 1);
    await S.check(() => eventually(async () => expect((await boxes()) === set(`span · ${q1}`, `a · ${a2}`) && (await rows()) === set(q1, a2), `③ 应是 Item 1 的 span 与 Item 2 的 a：框 ${await boxes()}，行 ${await rows()}`), 5000));
    // 4 「用 AI 重生成这几块」写一句发送：一个带两个 qids 的 regenerate_subtree，屏多一版，这两块换了、第 3 项原样
    const rev4 = await currentRev();
    if ((await selectedValue(page, '[data-testid="el-runner-select"]')) !== `channel:${cid}`) await pickOption(page, '[data-testid="el-runner-select"]', LABEL);
    await page.locator('#el-prompt').fill('都改成红色');
    await page.getByRole('button', { name: '重生成这几块' }).click();
    await S.check(async () => {
      const job = await waitLatestJob(pid, 'regenerate_subtree', 60);
      const ui = sent.filter((b) => b.kind === 'regenerate_subtree');
      expect(ui.length === 1 && set(...(ui[0].input.qids ?? [])) === set(q1, a2) && set(...((job.input.qids as string[] | undefined) ?? [])) === set(q1, a2), `④ 应建一个 qids 为这两块的作业：请求 ${JSON.stringify(ui.map((b) => b.input.qids))}，作业 ${JSON.stringify(job.input.qids)}`);
      const rev = await currentRev();
      const html = (await revisionHtml(sid, rev)).html;
      const item3 = /<span[^>]*data-qid="(q\d+)"[^>]*>Item 3 of screen 1<\/span>/.exec(html)?.[1] ?? '';
      expect(rev !== rev4 && stubbed(html, q1) && stubbed(html, a2) && (html.match(/data-stub="multi"/g) ?? []).length === 2 && !!item3 && !stubbed(html, item3), `④ 屏应多一版、这两块换了、第 3 项原样：换版 ${rev !== rev4}，标记 ${(html.match(/data-stub="multi"/g) ?? []).length}，第 3 项 ${item3 || '没找到'}`);
    });
    // 5 按 Esc 退出聚焦，再进 /s1：多选已清空，检查器是空态
    await S.check(() => eventually(async () => expect((await rows()) === set(q1, a2), `⑤ 退出前多选应还在（热更新后逐块接回）：${await rows()}`), 10000));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await page.locator('.card.focused').waitFor({ state: 'detached', timeout: 10000 });
    await card.locator('.gesture').click();
    await page.locator('.card.focused .badge', { hasText: '选择元素中' }).waitFor({ timeout: 20000 });
    await fl.locator(SPAN).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await S.check(async () => expect((await page.getByTestId('el-multi').count()) === 0 && (await page.locator('#el-text').count()) === 0 && (await boxes()) === '' && (await page.getByText('在屏幕里点选一个元素').count()) === 1, `⑤ 再进 /s1 应清空多选、检查器空态：多选 ${await page.getByTestId('el-multi').count()}，文案框 ${await page.locator('#el-text').count()}，框 ${await boxes()}`));
    // 6 MCP 调 quilt.regenerate_subtree 带 3 个 qids（标题、Follow、第 3 项）：作业成功，屏多一版
    const rev6 = await currentRev();
    const html6 = (await revisionHtml(sid, rev6)).html;
    const three = [qidOf(html6, 'class="text-lg font-semibold"'), qidOf(html6, 'id="toggle"'), /<span[^>]*data-qid="(q\d+)"[^>]*>Item 3 of screen 1<\/span>/.exec(html6)?.[1] ?? null];
    expect(three.every(Boolean), `⑥ 取不到三块的 qid：${JSON.stringify(three)}`);
    const mcp = await connectMcp();
    try {
      const m = await callTool(mcp, 'quilt.regenerate_subtree', { screenId: sid, qid: three[0], qids: three, prompt: '都改成蓝色', expectedRevisionId: rev6, runner: STUB_RUNNER });
      expect(!m.isError, `⑥ MCP regenerate_subtree 报错：${m.text.slice(0, 200)}`);
      const mj = await waitJob((m.json as { id: string }).id, 60);
      const rev = await currentRev();
      const html = (await revisionHtml(sid, rev)).html;
      await S.check(() => expect(mj.status === 'succeeded' && (mj.input.qids as string[]).length === 3 && rev !== rev6 && three.every((qq) => stubbed(html, qq!)), `⑥ MCP 作业应成功、屏多一版、三块都换了：${mj.status}，换版 ${rev !== rev6}，qids ${JSON.stringify(mj.input.qids)}，换了的 ${three.filter((qq) => stubbed(html, qq!)).join(',')}`));
    } finally { await mcp.close(); }
  } catch (e) { S.fail(e); }
  finally { await page.unroute(JOBS_RE).catch(() => {}); await stub.close(); if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {}); }
  S.done();
  return '多选两块出列表、两处选中框、没有直改；× 回单选；Shift+↑ 只移最后点中的那块；一次重生成两块、第 3 项原样；退出聚焦清空；MCP 带 3 个 qids 成功';
});

await browser.close();
summary();
