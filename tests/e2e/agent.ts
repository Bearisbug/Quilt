import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, pickOption, EVIDENCE, WEB, API } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';

// docs/TEST.md AGENT 域（TC-AGENT-001 / 003 / 004 / 009 / 010）AI 执行脚本（v0.34 本地版：MCP 免鉴权、本机 agent = 投递到本机 Claude Code 会话）。
// TC-AGENT-009 需要 API 与本脚本都以同一个 QUILT_CLAUDE_SESSIONS_DIR 启动（§3，假会话把登记文件与 socket 放进去）；TC-AGENT-010 是人工用例。
const RUN = process.env.RUN ?? '009';
const LIVE_LLM = process.env.LIVE_LLM !== '0';
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
let page: import('playwright').Page;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : result === '失败' ? '❌' : '⏭'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  if (ONLY && !ONLY.includes(tc)) return;
  try { const note = await fn(); record(tc, note?.startsWith('跳过') ? '跳过' : note?.startsWith('待人工') ? '待人工' : '通过', note ?? ''); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}.png`) }).catch(() => {}); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 300)); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OK_HTML = `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="h-14 flex items-center justify-between px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">Agent screen</h1></header><main class="flex-1 overflow-y-auto px-4 py-6 space-y-6"><div class="bg-surface rounded-lg border border-outline-variant p-4"><p class="text-sm">Pushed by an external agent.</p><a href="/s1" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Back home</a></div></main></div>`;
type Job = { id: string; status: string; runner: string; output: { screenIds?: string[]; delivery?: { sessionId: string; name: string }; summary?: string; errorClass?: string; message?: string } | null };
const jobOf = async (id: string) => (await apiJson<{ job: Job }>(`/v1/jobs/${id}`)).body.job;
const waitJob = async (id: string, maxSec: number) => { for (let i = 0; i < maxSec * 2; i++) { const j = await jobOf(id); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j; await sleep(500); } return jobOf(id); };

seed('seed');
const browser = await launch();
page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await openApp(page);
const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!;
const runners = (await apiJson<{ items: { id: string; available: boolean; hint?: string; unavailableReason?: string; setupHint?: string }[] }>('/v1/runners')).body.items;
const claudeRunner = runners.find((r) => r.id === 'agent:claude-code')!;

await step('TC-AGENT-001', async () => {
  // 本地版免鉴权：不带任何凭据直接连 MCP，工具 / 资源 / 提示词齐全；没有派活类工具；服务只绑回环地址
  const mcp = await connectMcp();
  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  for (const t of ['quilt.list_projects', 'quilt.generate_screens', 'quilt.edit_screens', 'quilt.get_design_contract', 'quilt.validate_screen', 'quilt.create_screen', 'quilt.update_screen', 'quilt.get_screenshot']) expect(tools.includes(t), `缺工具 ${t}`);
  expect(!tools.some((t) => /task/.test(t)), `本地版不该有派活工具：${tools.filter((t) => /task/.test(t)).join(',')}`);
  const list = await callTool(mcp, 'quilt.list_projects', {});
  expect(!list.isError && (list.json as { name: string }[]).some((p) => p.name === 'Demo Mobile'), 'list_projects 失败');
  const resources = (await mcp.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
  expect(resources.some((r) => r.endsWith('/design.md')) && resources.some((r) => r.endsWith('/golden')), `资源模板不全：${resources.join(',')}`);
  const cfg = (await apiJson<{ local: boolean; previewOrigin: string }>('/v1/config')).body;
  expect(cfg.local === true && /^http:\/\/(127\.0\.0\.1|preview\.localhost|localhost)/.test(cfg.previewOrigin), `运行时配置不对：${JSON.stringify(cfg)}`);
  let note = `免鉴权连上，${tools.length} 个工具、${resources.length} 类资源`;
  if (LIVE_LLM) {
    const usageBefore = (await apiJson<{ screens: number }>('/v1/me/usage')).body.screens;
    const gen = await callTool(mcp, 'quilt.generate_screens', { projectId: demo.id, prompt: 'A todo app with lists, tasks and reminders', count: 2 });
    expect(!gen.isError, `generate_screens 出错 ${gen.text}`);
    const jobId = (gen.json as { id: string }).id;
    let status = 'queued';
    for (let i = 0; i < 60; i++) { await sleep(3000); const r = await callTool(mcp, 'quilt.get_job', { jobId }); status = (r.json as { status: string }).status; if (['succeeded', 'failed', 'cancelled'].includes(status)) break; }
    expect(status === 'succeeded', `作业 ${status}`);
    const usageAfter = (await apiJson<{ screens: number }>('/v1/me/usage')).body.screens;
    expect(usageAfter > usageBefore, '用量未记入台账');
    note += `，生成 ${usageAfter - usageBefore} 屏记入台账`;
    await page.goto(`${WEB}/p/${demo.id}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
  }
  await mcp.close();
  // 设置弹层给出的接入命令与本机 API 一致
  await page.goto(`${WEB}/p/${demo.id}?settings=runners`);
  const cmd = await page.getByTestId('mcp-add').innerText();
  expect(cmd.trim() === `claude mcp add --transport http quilt ${API}/mcp`, `接入命令不对：${cmd}`);
  return note;
});

let ingestProject = '';
await step('TC-AGENT-003', async () => {
  const r = seedJson<{ projectId: string }>('seed:project', '--name', 'Ingest', '--device', 'mobile', '--screens', '1', '--no-shot');
  ingestProject = r.projectId;
  const mcp = await connectMcp();
  const md = await mcp.readResource({ uri: `quilt://projects/${ingestProject}/design.md` });
  expect(String(md.contents[0].text).includes('## Colors'), 'design.md 资源不对');
  const tokens = await mcp.readResource({ uri: `quilt://projects/${ingestProject}/tokens.json` });
  expect(JSON.parse(String(tokens.contents[0].text)).tokens.colors.primary, 'tokens.json 资源不对');
  const contract = await callTool(mcp, 'quilt.get_design_contract', { projectId: ingestProject });
  expect((contract.json as { colorClasses: string[] }).colorClasses.includes('on-primary'), '设计契约缺 colorClasses');
  const val = await callTool(mcp, 'quilt.validate_screen', { projectId: ingestProject, html: OK_HTML });
  expect((val.json as { violations: unknown[] }).violations.length === 0, `validate 有违规 ${val.text.slice(0, 200)}`);
  const created = await callTool(mcp, 'quilt.create_screen', { projectId: ingestProject, name: 'Agent 屏', route: '/agent', html: OK_HTML });
  expect(!created.isError, `create_screen 出错 ${created.text.slice(0, 200)}`);
  const { screenId, revisionId } = created.json as { screenId: string; revisionId: string };
  const html = await callTool(mcp, 'quilt.get_screen', { screenId });
  expect(html.text.includes('data-qid="q1"') && !html.text.includes('<head>'), 'get_screen 应给注入过 qid 的 body（v0.64 起不带 prelude）');
  let shot: Awaited<ReturnType<typeof callTool>> | null = null;
  for (let i = 0; i < 20; i++) { await sleep(1000); const s = await callTool(mcp, 'quilt.get_screenshot', { screenId }); if (s.image) { shot = s; break; } }
  expect(shot?.image, '20 s 内截图未就绪');
  await mcp.close();
  await page.goto(`${WEB}/p/${ingestProject}`);
  await page.locator('[data-testid="screen-card"][data-route="/agent"]').waitFor({ timeout: 10000 });
  return `screen ${screenId.slice(0, 8)} rev ${revisionId.slice(0, 8)}，截图 ${Math.round((shot!.image!.length * 0.75) / 1024)} KB`;
});

await step('TC-AGENT-004', async () => {
  const mcp = await connectMcp();
  const before = (await apiJson<{ screens: unknown[] }>(`/v1/projects/${ingestProject}`)).body.screens.length;
  const bad = await callTool(mcp, 'quilt.create_screen', { projectId: ingestProject, name: 'Bad', route: '/bad', html: OK_HTML.replace('bg-primary', 'bg-[#123456]') });
  // v0.43：契约是透镜不是闸门——推什么都写得进去，偏离只进 lintReport
  expect(!bad.isError && ((bad.json as { lintReport?: { violations: unknown[] } }).lintReport?.violations.length ?? 0) > 0, '违规 HTML 应照常写入并带偏离报告');
  const n = (bad.json as { lintReport: { violations: unknown[] } }).lintReport.violations.length;
  const d = (await apiJson<{ screens: { id: string; deviations: number }[] }>(`/v1/projects/${ingestProject}`)).body.screens;
  expect(d.length === before + 1, '违规 HTML 应照常建屏（v0.43）');
  expect(d.find((s) => s.id === (bad.json as { screenId: string }).screenId)?.deviations === n, `卡片上的偏离数应等于 lintReport 条数 ${n}`);
  await mcp.close();
});

// v0.34（ADR-015 修订）：本机 agent = 投递到本机正在运行的 Claude Code 会话。用假会话（登记文件 + inbox socket，agent-stub.ts）验整条链：
// 列表（名字 / UUID 规则）→ 输入框会话下拉 → 投递（提示词、running、回执）→ 持屏锁 → 取消 → finish_job 三种收口 → 选择记忆与失效
await step('TC-AGENT-009', async () => {
  const DIR = process.env.QUILT_CLAUDE_SESSIONS_DIR ?? '';
  if (!DIR) return '跳过：未设 QUILT_CLAUDE_SESSIONS_DIR（API 与本脚本都要以同一目录启动，§3）';
  if (!claudeRunner.available) return `跳过：本机 claude 不可用（${claudeRunner.unavailableReason ?? ''}）`;
  const { startFakeSession } = await import('./agent-stub.ts');
  const named = await startFakeSession({ dir: DIR, name: 'Stub 会话', nameSource: 'user' });
  const derived = await startFakeSession({ dir: DIR, name: 'quilt-ab', nameSource: 'derived', status: 'busy', updatedAt: Date.now() - 60_000 });
  try {
    // 1 列表（API-AGENT-010）：两个假会话都在；起过名的 named=true，派生名 named=false 且带 busy；按最近活跃排序
    await sleep(2100); // 服务端列表缓存 2 s
    const list = (await apiJson<{ items: { sessionId: string; name: string; named: boolean; status: string }[] }>('/v1/agent/sessions')).body.items;
    const li = list.findIndex((s) => s.sessionId === named.sessionId); const di = list.findIndex((s) => s.sessionId === derived.sessionId);
    expect(li >= 0 && list[li].named && list[li].name === 'Stub 会话', `列表里没有假会话「Stub 会话」——API 是否以同一个 QUILT_CLAUDE_SESSIONS_DIR 启动？${JSON.stringify(list).slice(0, 300)}`);
    expect(di >= 0 && !list[di].named && list[di].status === 'busy' && li < di, '派生名会话未标 named=false / busy，或排序不按最近活跃');

    const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'AgentJob', '--device', 'mobile', '--screens', '2', '--no-shot');
    const s1 = r.screens[0].id;
    const currentOf = async () => (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${r.projectId}`)).body.screens.find((s) => s.id === s1)!.currentRevisionId;
    const send = (content: string, sessionId = named.sessionId) => apiJson<{ job: { id: string; runner: string; status: string }; assistantMessage: { content: string }; type?: string }>(`/v1/projects/${r.projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, targetScreenIds: [s1], runner: { kind: 'agent', tool: 'claude-code', sessionId } }) });
    const rev0 = await currentOf();

    // 2 输入框：通道选「交给本机 Claude Code」→ 会话下拉出现；打开后起过名的显示名字、派生名的显示 UUID；选「Stub 会话」
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 10000 });
    await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await pickOption(page, '[data-testid="runner-select"]', '交给本机 Claude Code');
    const sel = page.getByTestId('session-select');
    await sel.waitFor({ timeout: 5000 });
    expect((await page.getByTestId('versions-group').count()) === 0 && (await page.getByTestId('verb-line').innerText()).includes('交给本机会话'), '本机 agent 通道下档位没藏起来或动词行没写去向');
    await sel.click();
    const options = page.locator('[data-testid="session-option"]');
    await options.first().waitFor({ timeout: 5000 });
    const texts = await options.allInnerTexts();
    expect(texts.some((t) => t.includes('Stub 会话')) && texts.some((t) => t.includes(derived.sessionId)), `下拉未按「有名字显名字、派生名显 UUID」列出：${JSON.stringify(texts)}`);
    await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-agent-009-sessions.png`) });
    await page.getByRole('option', { name: /Stub 会话/ }).click();
    expect((await sel.getAttribute('data-value')) === named.sessionId, '选中的会话没落到触发器');

    // 3 发 HANG：作业 running、output.delivery.name=Stub 会话、假会话收到提示词（jobId / 基线 / 收口要求 / 接入命令）、回执写明去向；
    //   不记用量、不占输入框；持屏锁（直改 409、同屏再派 409）；面板「已投递」→ 取消 → cancelled、锁释放；取消后 finish_job 409
    const usageBefore = (await apiJson<{ tokensIn: number; inflight: { screens: number } }>('/v1/me/usage')).body;
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
    await page.getByTestId('target-chip').waitFor({ timeout: 5000 });
    await page.fill('#chat-input', 'HANG 把首页改成分组列表');
    await page.keyboard.press('Enter');
    const card = page.locator('[data-testid="agent-job"]').first();
    await card.waitFor({ timeout: 10000 }); // 发出后画布切到 agent 面板
    for (let i = 0; i < 40 && named.received.length === 0; i++) await sleep(250);
    expect(named.received.length === 1, '假会话没收到投递');
    const prompt = named.received[0];
    const hangId = prompt.match(/\(job ([0-9a-f-]{36})\)/)?.[1] ?? '';
    expect(hangId && prompt.includes(`expectedRevisionId=${rev0}`) && prompt.includes('quilt.finish_job') && prompt.includes('claude mcp add'), '提示词缺作业 id / 基线 / 收口要求 / 接入命令');
    const hang = await jobOf(hangId);
    expect(hang.status === 'running' && hang.output?.delivery?.name === 'Stub 会话', `投递后作业应 running 且 delivery.name=Stub 会话：${JSON.stringify(hang)}`);
    const msgs0 = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${r.projectId}/messages`)).body.items;
    expect(msgs0.some((m) => m.role === 'assistant' && m.jobId === hangId && m.content.includes('已投递到本机 Claude Code 会话「Stub 会话」')), '回执没写明投递去向');
    const usageMid = (await apiJson<{ tokensIn: number; inflight: { screens: number } }>('/v1/me/usage')).body;
    expect(usageMid.tokensIn === usageBefore.tokensIn && usageMid.inflight.screens === usageBefore.inflight.screens, 'agent 作业记了用量或计入在途');
    expect(!(await page.locator('#chat-input').isDisabled()), 'runner=agent 的作业把输入框禁用了');
    const busy = await apiJson<{ type: string }>(`/v1/screens/${s1}/elements/q1`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: 'x' }], expectedRevisionId: rev0 }) });
    expect(busy.status === 409 && busy.body.type === '/errors/screen-busy', `作业持锁期间直改应 409 screen-busy，实际 ${busy.status}`);
    const dup = await send('HANG 再派一次');
    expect(dup.status === 409 && dup.body.type === '/errors/screen-busy', `同屏再派应 409，实际 ${dup.status}`);
    // 面板改成轮询后「已投递」最长 1.5s 才翻牌，等它出现而不是一次性断言（v0.38）
    await card.getByTestId('agent-line').filter({ hasText: '已投递' }).waitFor({ timeout: 5000 });
    expect((await card.getAttribute('data-status')) === 'running', '面板首条应为 running');
    expect((await card.getByTestId('agent-session').innerText()) === 'Stub 会话', '面板未写明投递到哪个会话');
    await card.getByTestId('cancel-agent-job').click();
    const cancelled = await waitJob(hangId, 10);
    expect(cancelled.status === 'cancelled', `取消后作业应 cancelled，实际 ${cancelled.status}`);
    await page.locator('[data-testid="agent-job"][data-status="cancelled"]').first().waitFor({ timeout: 10000 });
    const unlocked = await apiJson<{ revision: { id: string } }>(`/v1/screens/${s1}/elements/q1`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'text', value: 'Edited by user' }], expectedRevisionId: rev0 }) });
    expect(unlocked.status === 201, `取消后锁应释放、直改成功，实际 ${unlocked.status} ${JSON.stringify(unlocked.body)}`);
    const rev1 = await currentOf();
    const mcp = await connectMcp();
    const late = await callTool(mcp, 'quilt.finish_job', { jobId: hangId, summary: 'too late' });
    await mcp.close();
    expect(late.isError && (late.json as { type: string }).type === '/errors/job-finished', `取消后的 finish_job 应 409 job-finished：${late.text.slice(0, 120)}`);

    // 4 FAIL：会话直接 finish_job failed → 作业 failed errorClass=agent、summary 进 output
    const fail = await send('FAIL 这次会失败');
    const failed = await waitJob(fail.body.job.id, 20);
    expect(failed.status === 'failed' && failed.output?.errorClass === 'agent' && failed.output?.summary === 'simulated failure', `finish_job failed 应 failed(agent)：${JSON.stringify(failed.output)}`);

    // 5 STALE：假基线回写 → 409 revision-conflict → 会话报失败；current 不动
    const stale = await send('STALE 用旧基线回写');
    const staleJob = await waitJob(stale.body.job.id, 20);
    expect(staleJob.status === 'failed' && /revision-conflict/.test(staleJob.output?.summary ?? ''), `旧基线回写应 409 并让作业失败：${JSON.stringify(staleJob.output)}`);
    expect((await currentOf()) === rev1, '旧基线回写改了 current');

    // 6 正常：先双击 s1 进交互、什么面板都不开，再派活——会话回写后画布不做任何操作就该原地换新（项目级事件 → 热更新，API-CORE-030）
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').dblclick();
    const fl = page.frameLocator('.card.focused iframe');
    await fl.locator('#toggle').waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    const ok = await send('把首页改成分组列表');
    await fl.locator('h1', { hasText: 'by fake session' }).waitFor({ timeout: 15000 });
    expect((await page.locator('.card.focused .badge').innerText()).includes('交互中'), '热更新后角标不是「交互中」');
    const okJob = await waitJob(ok.body.job.id, 30);
    expect(okJob.status === 'succeeded' && okJob.output?.screenIds?.[0] === s1 && okJob.output?.summary === 'rewrote Screen 1 as asked', `作业应 succeeded 且 screenIds=[s1]：${JSON.stringify(okJob)}`);
    expect((await currentOf()) !== rev1, '回写后 current 未变');
    const msgs = (await apiJson<{ items: { role: string; jobId: string | null; content: string; affectedScreenIds: string[] }[] }>(`/v1/projects/${r.projectId}/messages`)).body.items;
    const receipt = msgs.find((m) => m.role === 'assistant' && m.jobId === ok.body.job.id)!;
    expect(receipt.content.includes('本机 agent 已完成') && receipt.content.includes('rewrote Screen 1') && receipt.affectedScreenIds[0] === s1, `回执不对：${receipt.content}`);
    await page.goto(`${WEB}/p/${r.projectId}?panel=agent`);
    await page.locator('[data-testid="agent-jobs"]').waitFor({ timeout: 10000 });
    expect((await page.locator('[data-testid="agent-job"]').count()) === 4, `面板应列 4 条 agent 作业，实际 ${await page.locator('[data-testid="agent-job"]').count()}`);
    const done = page.locator('[data-testid="agent-job"][data-status="succeeded"]').first();
    expect((await done.innerText()).includes('回写了 1 屏') && (await done.innerText()).includes('rewrote Screen 1'), '完成的作业未显示回写屏数与摘要');

    // 7 记忆与失效：刷新后会话仍选中；假会话关掉后打开下拉重取 → 回到「选择会话」、发送钮不可用；直接 POST 旧 sessionId → 400
    await page.goto(`${WEB}/p/${r.projectId}`);
    await page.getByTestId('session-select').waitFor({ timeout: 10000 });
    expect((await page.getByTestId('session-select').getAttribute('data-value')) === named.sessionId, '刷新后会话选择没记住');
    await named.close();
    await sleep(2100);
    await page.getByTestId('session-select').click();
    await page.getByRole('listbox').waitFor({ timeout: 5000 });
    await sleep(500);
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    expect((await page.getByTestId('session-select').getAttribute('data-value')) === '' && (await page.getByTestId('session-select').innerText()).includes('选择会话'), '会话关掉后触发器没回到「选择会话」');
    await page.fill('#chat-input', '还能发吗');
    expect((await page.getByRole('button', { name: /^发送/ }).getAttribute('aria-disabled')) === 'true', '会话失效后发送钮仍可用');
    const gone = await send('会话已关', named.sessionId);
    expect(gone.status === 400 && gone.body.type === '/errors/validation', `旧 sessionId 直接 POST 应 400：${gone.status}`);
    return '列表 / 下拉按名字或 UUID；投递 → running + 回执；持锁 / 取消 / 取消后 finish_job 409；failed / 旧基线 409 / succeeded 三种收口；选择记忆、失效回到占位';
  } finally { await named.close().catch(() => {}); await derived.close().catch(() => {}); }
});

// 真实 Claude Code：投递进真实会话要用户在终端确认权限门，AI 不代按——登记「待人工」，步骤见 TEST.md
await step('TC-AGENT-010', async () => '待人工：投递到真实 Claude Code 会话需要在终端确认接收，按 TEST.md 的步骤人工执行');

await browser.close();
console.log(`\n=== RUN-${RUN} AGENT ===`, JSON.stringify(results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {})));
console.log(results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
