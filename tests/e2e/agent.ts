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
// 作业创建限流 10 次 / 分钟（§15）：TC-AGENT-009 与 012 各建五六个作业，同一轮连着跑会撞上，012 开头等过 009 留下的窗口
let burstAt = 0;
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
    // 触发器先渲染、会话列表稍后才到（到之前 data-value 为空），等值出现而不是立刻读
    await page.locator(`[data-testid="session-select"][data-value="${named.sessionId}"]`).waitFor({ timeout: 10000 }).catch(() => { throw new Error('刷新后会话选择没记住'); });
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
  } finally { await named.close().catch(() => {}); await derived.close().catch(() => {}); burstAt = Date.now(); }
});

// 真实 Claude Code：投递进真实会话要用户在终端确认权限门，AI 不代按——登记「待人工」，步骤见 TEST.md
await step('TC-AGENT-010', async () => '待人工：投递到真实 Claude Code 会话需要在终端确认接收，按 TEST.md 的步骤人工执行');

// v0.68（ADR-020）：Codex 线程投递 + 本机 Codex 订阅通道。API 与本脚本都以同一个 QUILT_CODEX_HOME 启动，API 另以
// QUILT_CODEX_BIN / QUILT_CODEX_OPENER 指向 codex-stub.mjs（§3）。脚本自建假线程库；「Codex 窗口」一侧由脚本扮演：
// 读桩记下的队列消息，线程打开着（有写锁）才取走，经 MCP 回写并收口——与真 Codex 的行为一致
await step('TC-AGENT-012', async () => {
  const HOME = process.env.QUILT_CODEX_HOME ?? '';
  if (burstAt) await sleep(Math.max(0, burstAt + 61_000 - Date.now()));
  if (!HOME) return '跳过：未设 QUILT_CODEX_HOME（API 与本脚本都要以同一目录启动，API 另设 QUILT_CODEX_BIN / QUILT_CODEX_OPENER 指向 tests/e2e/codex-stub.mjs，§3）';
  const { DatabaseSync } = await import('node:sqlite');
  const { rm: rmrf, writeFile: wf, readFile: rf, open: fopen } = await import('node:fs/promises');
  await rmrf(HOME, { recursive: true, force: true });
  await mkdir(path.join(HOME, 'thread-writer-locks'), { recursive: true });
  const T_OPEN = '01a0d6fc-0000-7000-8000-00000000a001'; const T_CLOSED = '01a0d6fc-0000-7000-8000-00000000a002';
  const T_EXEC = '01a0d6fc-0000-7000-8000-00000000a003'; const T_BROKEN = '01a0d6fc-0000-7000-8000-00000000ffff';
  const T_NOAPP = '01a0d6fc-0000-7000-8000-00000000eeee'; // 桩打不开它：模拟本机没装 Codex 桌面版
  const db = new DatabaseSync(path.join(HOME, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, source TEXT, originator TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER)');
  const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run(T_OPEN, '设计稿', '把首页改成分组列表', '/Users/me/Quilt', 'vscode', 'Codex Desktop', 'user', 0, Date.now());
  add.run(T_CLOSED, null, '帮我看看首页', '/Users/me/app', 'vscode', null, 'user', 0, Date.now() - 60_000);
  add.run(T_EXEC, null, '无头 exec', '/tmp', 'exec', 'codex_exec', 'user', 0, Date.now() + 1000);
  add.run(T_BROKEN, '坏线程', '队列写不进', '/tmp', 'cli', 'codex_cli_rs', 'user', 0, Date.now() - 120_000);
  add.run(T_NOAPP, '终端线程', '只装了 CLI', '/tmp', 'cli', 'codex_cli_rs', 'user', 0, Date.now() - 180_000);
  db.close();
  // 「打开着」= 有进程占着写锁（Quilt 用 lsof 查）：本脚本扮演开着 T_OPEN 的 Codex 窗口，打开它的锁文件不放
  const lockPath = (id: string) => path.join(HOME, 'thread-writer-locks', `${id}.lock`);
  await wf(lockPath(T_OPEN), '');
  const held = new Map([[T_OPEN, await fopen(lockPath(T_OPEN), 'r')]]);
  await wf(lockPath(T_CLOSED), ''); // 残留的锁文件（Codex 进程被杀后留下）：没人占着，应判为未打开
  type Rec = { cmd: string; thread?: string; message?: string; url?: string; args?: string[]; hasApiKey?: boolean; cwd?: string; promptHead?: string };
  const stubLog = async (): Promise<Rec[]> => { try { return (await rf(path.join(HOME, 'stub-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // 深链接打开过的线程（桩记下 open）也由本脚本占住锁，等于桌面版把它打开了
  const isOpen = async (id: string) => {
    if (!held.has(id) && (await stubLog()).some((x) => x.cmd === 'open' && x.thread === id)) held.set(id, await fopen(lockPath(id), 'r'));
    return held.has(id);
  };
  // 「Codex 窗口」：线程打开着才取走排队的消息，按提示词里的基线回写并收口
  const handled = new Set<string>();
  const drain = async () => {
    for (const r of await stubLog()) {
      if (r.cmd !== 'queue' || !r.message || handled.has(r.message) || !(await isOpen(r.thread!))) continue;
      handled.add(r.message);
      const jobId = r.message.match(/\(job ([0-9a-f-]{36})\)/)?.[1]; const projectId = r.message.match(/projectId ([0-9a-f-]{36})/)?.[1];
      const target = r.message.match(/screenId=([0-9a-f-]{36}) expectedRevisionId=([0-9a-f-]{36}|none)/);
      if (!jobId || !projectId || !target) continue;
      const mcp = await connectMcp();
      try {
        const screen = await callTool(mcp, 'quilt.get_screen', { screenId: target[1] });
        const body = screen.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\sdata-qid="q\d+"/g, '').replace('Screen 1', 'Screen 1 (by codex thread)').trim();
        await callTool(mcp, 'quilt.update_screen', { projectId, screenId: target[1], name: 'Screen 1', route: '/s1', html: body, jobId, expectedRevisionId: target[2] === 'none' ? undefined : target[2] });
        await callTool(mcp, 'quilt.finish_job', { jobId, summary: `done in ${r.thread!.slice(-4)}` });
      } finally { await mcp.close(); }
    }
  };

  // 1 列表：只有桌面版 / VS Code / 终端的用户线程（exec 不列），打开与否、在哪个应用、名字规则
  await sleep(2100);
  const lr = (await apiJson<{ items: { sessionId: string; name: string; named: boolean; open: boolean; app?: string; tool: string }[]; reason?: string }>('/v1/agent/sessions?tool=codex')).body;
  const ids = lr.items.map((t) => t.sessionId);
  expect(ids.join() === [T_OPEN, T_CLOSED, T_BROKEN, T_NOAPP].join(), `Codex 线程列表不对（API 是否以同一个 QUILT_CODEX_HOME 启动？）：${JSON.stringify(lr).slice(0, 300)}`);
  const [tOpen, tClosed] = lr.items;
  expect(tOpen.named && tOpen.name === '设计稿' && tOpen.open && tOpen.app === 'desktop' && tOpen.tool === 'codex', `打开的线程字段不对：${JSON.stringify(tOpen)}`);
  expect(!tClosed.named && tClosed.name === '帮我看看首页' && !tClosed.open && tClosed.app === 'vscode', `未打开的线程字段不对：${JSON.stringify(tClosed)}`);
  // 2 通道目录：交给本机 Codex 可用，hint 是桩的版本号；setupHint 带 codex mcp add
  const codexRunner = (await apiJson<{ items: { id: string; available: boolean; hint?: string; setupHint?: string }[] }>('/v1/runners')).body.items.find((x) => x.id === 'agent:codex');
  expect(codexRunner?.available && codexRunner.hint === 'codex-cli 0.0.0-stub' && codexRunner.setupHint?.includes('codex mcp add quilt --url'), `目录里的 agent:codex 不对：${JSON.stringify(codexRunner)}`);

  const r = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'CodexJob', '--device', 'mobile', '--screens', '2', '--no-shot');
  const s1 = r.screens[0].id;
  const currentOf = async () => (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${r.projectId}`)).body.screens.find((s) => s.id === s1)!.currentRevisionId;
  const send = (content: string, sessionId: string) => apiJson<{ job: { id: string }; type?: string }>(`/v1/projects/${r.projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, targetScreenIds: [s1], runner: { kind: 'agent', tool: 'codex', sessionId } }) });

  // 3 输入框：通道选「交给本机 Codex」→ 会话下拉的组标题、名字 / 标题、应用、已打开 / 未打开；选「设计稿」
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.getByTestId('runner-select').waitFor({ timeout: 10000 });
  await pickOption(page, '[data-testid="runner-select"]', '交给本机 Codex');
  const sel = page.getByTestId('session-select');
  await sel.waitFor({ timeout: 5000 });
  await sel.click();
  await page.locator('[data-testid="session-option"]').first().waitFor({ timeout: 5000 });
  const texts = await page.locator('[data-testid="session-option"]').allInnerTexts();
  const group = await page.getByRole('listbox').innerText();
  expect(group.includes('本机 Codex 线程') && texts.some((t) => t.includes('设计稿') && t.includes('桌面版') && t.includes('已打开')) && texts.some((t) => t.includes('帮我看看首页') && t.includes('VS Code') && t.includes('未打开')), `Codex 会话下拉不对：${JSON.stringify(texts)}`);
  await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-agent-012-threads.png`) });
  await page.getByRole('option', { name: /设计稿/ }).click();
  expect((await sel.getAttribute('data-value')) === T_OPEN, '选中的线程没落到触发器');

  // 4 投给打开着的线程：codex queue 一次、不开深链接；提示词带作业 id / 基线 / 收口 / codex 接入命令；回执写明线程名
  const rev0 = await currentOf();
  await page.locator('[data-testid="screen-card"][data-route="/s1"] .gesture').click();
  await page.getByTestId('target-chip').waitFor({ timeout: 5000 });
  await page.fill('#chat-input', '把首页改成分组列表');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="agent-job"]').first().waitFor({ timeout: 10000 });
  let q: Rec | undefined;
  for (let i = 0; i < 40 && !q; i++) { await sleep(250); q = (await stubLog()).find((x) => x.cmd === 'queue' && x.thread === T_OPEN); }
  expect(q?.message, '没有执行 codex queue');
  const jobId = q!.message!.match(/\(job ([0-9a-f-]{36})\)/)?.[1] ?? '';
  expect(jobId && q!.message!.includes(`expectedRevisionId=${rev0}`) && q!.message!.includes('quilt.finish_job') && q!.message!.includes('codex mcp add quilt --url') && !q!.message!.includes('claude mcp add'), '提示词缺作业 id / 基线 / 收口 / Codex 接入命令');
  expect(!(await stubLog()).some((x) => x.cmd === 'open'), '线程打开着却还去开深链接');
  const j1 = await jobOf(jobId);
  const d1 = j1.output?.delivery as { tool?: string; name?: string; opened?: boolean } | undefined;
  expect(j1.status === 'running' && d1?.tool === 'codex' && d1.name === '设计稿' && d1.opened === false, `投递后作业字段不对：${JSON.stringify(j1)}`);
  const msgs = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${r.projectId}/messages`)).body.items;
  expect(msgs.some((m) => m.role === 'assistant' && m.jobId === jobId && m.content.includes('已投递到本机 Codex 线程「设计稿」')), '回执没写明投递到哪个 Codex 线程');
  // 图标 SVG 里带着不可见的 <title>Codex</title>，按可见文字断言
  expect((await page.locator('[data-testid="agent-job"]').first().innerText()).includes('Codex'), 'agent 面板没把这条作业标成 Codex');
  await drain();
  const done1 = await waitJob(jobId, 20);
  expect(done1.status === 'succeeded' && done1.output?.screenIds?.[0] === s1 && done1.output?.summary === 'done in a001', `打开着的线程收口后应 succeeded：${JSON.stringify(done1)}`);

  // 5 投给未打开的线程：先 queue 再开深链接（桌面版打开 → 写锁出现 → 取走执行），delivery.opened=true
  const second = await send('再改一次', T_CLOSED);
  expect(second.status === 202, `投给未打开的线程应 202：${second.status} ${JSON.stringify(second.body)}`);
  let opened: Rec | undefined;
  for (let i = 0; i < 40 && !opened; i++) { await sleep(250); opened = (await stubLog()).find((x) => x.cmd === 'open' && x.thread === T_CLOSED); }
  const log2 = await stubLog();
  const qi = log2.findIndex((x) => x.cmd === 'queue' && x.thread === T_CLOSED); const oi = log2.findIndex((x) => x.cmd === 'open' && x.thread === T_CLOSED);
  expect(opened?.url === `codex://threads/${T_CLOSED}` && qi >= 0 && qi < oi, `未打开的线程应先 queue 再开 codex://threads/<id>：${JSON.stringify(log2.slice(-3))}`);
  const j2 = await jobOf(second.body.job.id);
  expect((j2.output?.delivery as { opened?: boolean } | undefined)?.opened === true, '深链接打开后 delivery.opened 应为 true');
  await drain();
  expect((await waitJob(second.body.job.id, 20)).status === 'succeeded', '打开后取走的消息没有收口');

  // 6 拒绝：exec 线程、不存在的线程 → 400；codex queue 失败 → 作业 failed(agent) 写明原因
  expect((await send('exec 线程', T_EXEC)).status === 400, 'exec 线程不该能投');
  expect((await send('不存在', '01a0d6fc-0000-7000-8000-00000000beef')).status === 400, '不存在的线程应 400');
  const broken = await send('队列写不进', T_BROKEN);
  const bj = await waitJob(broken.body.job.id, 10);
  expect(bj.status === 'failed' && bj.output?.errorClass === 'agent' && /投递失败/.test(bj.output?.message ?? ''), `codex queue 失败应 failed(agent)：${JSON.stringify(bj.output)}`);

  // 6a 本机没有 Codex 桌面版：排进队列成功、打开线程失败 → 不算投递失败，作业仍 running（opened=false、记 openError），
  //    回执与 agent 面板提示在 Codex 里打开；用户之后打开这个线程（脚本占住它的锁）→ 线程取走消息、回写并收口 → succeeded
  const noApp = await send('没装桌面版', T_NOAPP);
  expect(noApp.status === 202, `投给打不开的线程应 202：${noApp.status}`);
  let openFailed: Rec | undefined;
  for (let i = 0; i < 40 && !openFailed; i++) { await sleep(250); openFailed = (await stubLog()).find((x) => x.cmd === 'open-failed' && x.thread === T_NOAPP); }
  expect(openFailed && (await stubLog()).some((x) => x.cmd === 'queue' && x.thread === T_NOAPP), '应先排进队列、再尝试打开线程');
  await sleep(500);
  const nj = await jobOf(noApp.body.job.id);
  const nd = nj.output?.delivery as { opened?: boolean; openError?: string } | undefined;
  expect(nj.status === 'running' && nd?.opened === false && /No application knows/.test(nd?.openError ?? ''), `打开线程失败后作业应仍 running 并记 openError：${JSON.stringify({ status: nj.status, output: nj.output })}`);
  const nmsg = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${r.projectId}/messages`)).body.items.find((m) => m.role === 'assistant' && m.jobId === noApp.body.job.id);
  expect(nmsg?.content.includes('在 Codex 里打开这个线程'), `回执没提示在 Codex 里打开线程：${nmsg?.content}`);
  await page.goto(`${WEB}/p/${r.projectId}?panel=agent`);
  const line = page.locator('[data-testid="agent-job"]').first().getByTestId('agent-line');
  await line.waitFor({ timeout: 10000 });
  expect((await line.innerText()).includes('在 Codex 里打开这个线程'), `agent 面板没提示在 Codex 里打开线程：${await line.innerText()}`);
  await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-agent-012-open-failed.png`) });
  await wf(lockPath(T_NOAPP), '');
  held.set(T_NOAPP, await fopen(lockPath(T_NOAPP), 'r'));
  await drain();
  const nDone = await waitJob(noApp.body.job.id, 20);
  expect(nDone.status === 'succeeded' && nDone.output?.summary === 'done in eeee', `用户打开线程后排队的消息应执行并收口：${JSON.stringify(nDone)}`);

  // 7 记忆：刷新后 Codex 线程仍选中「设计稿」（本机记忆按工具分开）；切回 Claude Code 不带 Codex 的线程 id
  await page.goto(`${WEB}/p/${r.projectId}`);
  await page.getByTestId('session-select').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="session-select"][data-value="${T_OPEN}"]`).waitFor({ timeout: 5000 }).catch(async () => {
    const st = await page.evaluate(() => ({ runner: localStorage.getItem('quilt:runner'), codex: localStorage.getItem('quilt:agent-session:codex'), value: document.querySelector('[data-testid="session-select"]')?.getAttribute('data-value'), text: (document.querySelector('[data-testid="session-select"]') as HTMLElement | null)?.innerText }));
    throw new Error(`刷新后 Codex 线程选择没记住：${JSON.stringify(st)}`);
  });
  await pickOption(page, '[data-testid="runner-select"]', '交给本机 Claude Code');
  await sleep(500);
  expect((await page.getByTestId('session-select').getAttribute('data-value')) !== T_OPEN, '切到 Claude Code 后会话下拉带着 Codex 的线程 id');

  // 8 本机 Codex 订阅通道：在设置弹窗里添加（不填 Key）→「保存并验证」。桩让验证拖 18 s（真 codex 约 20 s），
  //   前端要等得住——此前所有请求共用 15 s 上限，服务端验证成功了面板却报「保存失败」（v0.69）。
  //   探测经 codex exec（--json --ephemeral 只读、去掉 API Key）；再用它改屏，产出进修订、用量记账
  await page.goto(`${WEB}/p/${r.projectId}?settings=runners`);
  await page.getByTestId('add-channel').click();
  const dlg = page.getByTestId('channel-dialog');
  await dlg.waitFor({ timeout: 5000 });
  await pickOption(page, '#ch-kind', '本机 Codex 订阅');
  expect((await page.locator('#ch-key').count()) === 0 && (await page.locator('#ch-endpoint').count()) === 0, 'Codex 订阅通道不该有 Key / 端点字段');
  await page.fill('#ch-label', 'Codex 订阅');
  await page.fill('#ch-model', 'gpt-stub');
  const t0 = Date.now();
  await page.getByTestId('ch-save').click();
  await dlg.waitFor({ state: 'detached', timeout: 60_000 }).catch(async () => { throw new Error(`「保存并验证」没有成功关掉面板：${(await dlg.innerText()).slice(0, 160)}`); });
  const waited = Math.round((Date.now() - t0) / 1000);
  expect(waited >= 15, `验证应等过桩的 18 s，实际 ${waited} s（桩没生效？）`);
  const ch = { body: { channel: (await apiJson<{ items: { id: string; label: string; apiKeyHint: string | null; status: string }[] }>('/v1/channels')).body.items.find((c) => c.label === 'Codex 订阅')! } };
  expect(ch.body.channel?.apiKeyHint === null && ch.body.channel.status === 'verified', `Codex 订阅通道应无 Key 且已验证：${JSON.stringify(ch.body.channel)}`);
  const ex = (await stubLog()).filter((x) => x.cmd === 'exec').pop()!;
  const a = ex.args ?? [];
  // v0.70：不读用户的 Codex 配置与规则（不起用户配的 MCP），输入开头明说不许调工具
  expect(['--ignore-user-config', '--ignore-rules'].every((f) => a.includes(f)) && /^Answer directly .* Do not run shell commands/.test(ex.promptHead ?? ''), `codex exec 没有隔离用户配置或缺「不许调工具」前置说明：${JSON.stringify({ args: a, head: ex.promptHead })}`);
  expect(['--json', '--ephemeral', '--skip-git-repo-check'].every((f) => a.includes(f)) && a[a.indexOf('-s') + 1] === 'read-only' && a[a.indexOf('-m') + 1] === 'gpt-stub' && ex.hasApiKey === false && !(ex.cwd ?? '').includes('Quilt'), `codex exec 参数 / 环境不对：${JSON.stringify(ex)}`);
  const usage0 = (await apiJson<{ tokensIn: number }>('/v1/me/usage')).body.tokensIn;
  const edit = await apiJson<{ job: { id: string } }>(`/v1/projects/${r.projectId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: '用 Codex 订阅改首页', targetScreenIds: [s1], runner: { kind: 'channel', channelId: ch.body.channel.id } }) });
  expect(edit.status === 202, `用 Codex 订阅通道发改屏消息应 202：${edit.status} ${JSON.stringify(edit.body).slice(0, 300)}`);
  const ej = await waitJob(edit.body.job.id, 60);
  expect(ej.status === 'succeeded', `Codex 订阅改屏应成功：${JSON.stringify(ej)}`);
  const mcp8 = await connectMcp();
  const html = (await callTool(mcp8, 'quilt.get_screen', { screenId: s1 })).text;
  await mcp8.close();
  expect(html.includes('(by codex stub)'), '新修订里没有 codex exec 的产出');
  expect((await apiJson<{ tokensIn: number }>('/v1/me/usage')).body.tokensIn >= usage0 + 20000, 'Codex 订阅的用量没有记账');
  await apiJson(`/v1/channels/${ch.body.channel.id}`, { method: 'DELETE' });
  for (const h of held.values()) await h.close();
  return `列表只含用户线程且标出应用 / 打开与否；打开的线程只 queue、未打开的 queue 后开深链接；回执 / 面板写明 Codex；exec 线程与不存在 400、队列失败 failed(agent)；打不开线程时作业仍 running、提示打开，打开后收口；选择按工具记忆；Codex 订阅通道 exec 参数与记账`;
});

await browser.close();
console.log(`\n=== RUN-${RUN} AGENT ===`, JSON.stringify(results.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {})));
console.log(results.map((r) => `${r.tc} ${r.result} ${r.note}`).join('\n'));
