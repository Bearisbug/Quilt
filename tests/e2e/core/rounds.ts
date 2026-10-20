// docs/TEST.md CORE 域 · 对话轮次与输入框（TC-CORE-045～064）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { seedJson, apiJson, EVIDENCE, ROOT, WEB, API, eventually, pickOption, zhCN } from '../lib.ts';
import { startOpenAiStub } from '../openai-stub.ts';
import { connectMcp, callTool } from '../mcp-client.ts';
import { expect, softly, waitJob, sleep } from '../harness.ts';
import { page, ctx, RUN, step, shot, STUB_RUNNER, PNG_B64, idemKey, useStubChannel } from './shared.ts';

// ---- v0.74 共用（TC-CORE-045 / 046）：输入框发出的写请求改走 stub ----
// 种子按 .env 建了一条已验证的 Gemini 通道并成为缺省：UI 发送与重试不能打到真实模型。拦下请求体、把 runner 换成 stub
// （或用例指定的通道）再放行，并记下原始请求体供断言；holdMs 让这一个请求在途一阵
const SEND_RE = /\/v1\/projects\/[^/]+\/messages(\/[^/]+\/retry)?$/;
type Sent = { url: string; body: Record<string, unknown> };
async function pinSends(pg: import('playwright').Page, opts: { runner?: () => unknown; holdMs?: () => number } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  await pg.route(SEND_RE, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = JSON.parse(req.postData() || '{}') as Record<string, unknown>;
    sent.push({ url: req.url(), body });
    const hold = opts.holdMs?.() ?? 0;
    if (hold) await new Promise((r) => setTimeout(r, hold));
    await route.continue({ postData: JSON.stringify({ ...body, runner: opts.runner?.() ?? STUB_RUNNER }) });
  });
  return sent;
}
const openCanvas = async (projectId: string) => {
  await page.goto(`${WEB}/p/${projectId}`);
  await page.locator('[data-testid="screen-card"] img').first().waitFor({ timeout: 15000 });
};

// TC-CORE-045 作业失败的呈现：失败的作业 chip 写原因、带「重试」与 ×、不弹提示条（§14 / PAGE-CANVAS「作业 chip」v1.17）
await step('TC-CORE-045', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Fails', '--device', 'mobile', '--screens', '2');
  const [s1, s2] = screens;
  const S = softly();
  // 桩：Key 不对回 401；Key 对时改组件回两个根元素（结构不合格），其余回一句话。每个回应（401 也一样）拖 2.5 s，
  // 让画布先认领这个作业、再收到失败——没认领就不会有 chip
  const stub = startOpenAiStub({ port: 3995, apiKey: 'good-key-0045', holdMs: 2500, reply: (hit) => (hit.system.startsWith('You maintain ONE shared component') ? '<div class="p-2">a</div><div class="p-2">b</div>' : 'OK') });
  const channel = async (label: string, apiKey: string) => (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label, endpoint: stub.url, model: 'stub-45', apiKey }) })).body.channel.id;
  const badKey = await channel('坏 Key 通道', 'wrong-key-0045');
  const twoRoots = await channel('两根通道', 'good-key-0045');
  const comp = await apiJson<{ component: { id: string } }>(`/v1/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ name: 'AuditBar', html: `<nav class="flex gap-4 p-2"><a href="${s1.route}" aria-current="page">One</a><a href="${s2.route}">Two</a></nav>` }) });
  expect(comp.status === 201, `建组件 ${comp.status}`);
  let runner: unknown = { kind: 'channel', channelId: badKey };
  const sent = await pinSends(page, { runner: () => runner });
  const chipOf = (id: string) => page.locator(`[data-testid="job-chip"][data-job-id="${id}"]`);
  const failedIds = () => page.locator('[data-testid="job-chip"][data-state="failed"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-job-id') ?? ''));
  try {
    await openCanvas(projectId);
    // 输入框要选着一条云端通道才发得出去；发出的请求由 pinSends 改成用例指定的通道
    await useStubChannel(page, { port: 3972, label: 'Stub 45' });
    const input = page.locator('#chat-input');
    // 1 改屏撞上 401：失败的 chip 写「改屏失败」+ HTTP 401 + 是哪一屏，不带原始报文；带「重试」与 ×；
    //   有「重试」时原因末尾不再写「点「重试」」；整叠在输入框上方；失败不再弹提示条（chip 留到用户关掉）
    await page.locator(`[data-testid="screen-card"][data-route="${s1.route}"] .gesture`).click();
    await input.fill('改成深色');
    await input.press('Enter');
    await page.locator('[data-testid="job-chip"][data-state="failed"]').first().waitFor({ timeout: 40000 });
    const firstId = (await failedIds())[0];
    const first = chipOf(firstId);
    const text1 = await first.innerText();
    await S.check(() => expect(text1.includes('Screen 1') && text1.includes('改屏失败') && text1.includes('HTTP 401') && !/[{}]|openai-compatible|provider|invalid api key/.test(text1), `① 失败 chip 应写是哪一屏 + 可读原因：${text1.replace(/\s+/g, ' ')}`));
    await S.check(() => expect(!text1.includes('点「重试」'), `① chip 上有「重试」按钮，原因里不该再写一遍：${text1.replace(/\s+/g, ' ')}`));
    await S.check(async () => expect((await first.getByTestId('retry-job').count()) === 1 && (await first.getByTestId('dismiss-job').count()) === 1, '① 失败 chip 应带「重试」与 ×'));
    const stackBox = (await page.getByTestId('job-chips').boundingBox())!; const cb = (await page.locator('form.composer').boundingBox())!;
    await S.check(() => expect(stackBox.y + stackBox.height <= cb.y + 1, `① 作业 chip 应叠在输入框上方：chip 底 ${stackBox.y + stackBox.height} 输入框顶 ${cb.y}`));
    await S.check(async () => expect((await page.locator('[data-testid="toast"][data-kind="error"]').count()) === 0, `① 作业失败不该再弹提示条：${(await page.locator('[data-testid="toast"]').allInnerTexts()).join(' | ')}`));
    // 2 双击「重试」：只原样再发一轮（还是那条坏 Key 通道，照样 401），旧的那枚撤掉、换成新作业的 chip；点 × 关掉
    const retries = () => sent.filter((x) => x.url.endsWith('/retry')).length;
    await first.getByTestId('retry-job').dblclick();
    await S.check(() => eventually(async () => expect(retries() === 1, `② 双击「重试」应发出一次重试：${retries()} 次`), 10000));
    await sleep(1000);
    await S.check(() => expect(retries() === 1, `② 双击「重试」应只发出一次重试：${retries()} 次`));
    await S.check(() => eventually(async () => expect(!(await failedIds()).includes(firstId), '② 重试发出后旧的那枚失败 chip 应撤掉'), 10000));
    await S.check(() => eventually(async () => { const ids = (await failedIds()).filter((id) => id !== firstId); expect(ids.length === 1, `② 重试这一轮同样撞 401，应留下新作业的失败 chip：${ids.join(',')}`); }, 40000));
    const again = (await failedIds()).filter((id) => id !== firstId);
    if (again.length === 1) {
      await chipOf(again[0]).getByTestId('dismiss-job').click();
      await S.check(() => eventually(async () => expect((await chipOf(again[0]).count()) === 0, '② 点 × 后失败 chip 应消失')));
    }
    // 3 不能重试的那几类（重生成一块）撞 401：chip 上只有 ×，下一步先说检查 Key，再写它自己再发一次的入口
    const cur = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((x) => x.id === s1.id)!;
    const html = await (await fetch((await apiJson<{ revision: { htmlUrl: string } }>(`/v1/screens/${s1.id}/revisions/${cur.currentRevisionId}`)).body.revision.htmlUrl)).text();
    const qid = [...html.matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]).at(-1)!;
    const sub = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idemKey(), body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: s1.id, qid, prompt: '换成一句标语', expectedRevisionId: cur.currentRevisionId, runner: { kind: 'channel', channelId: badKey } } }) });
    expect(sub.status === 202, `建重生成一块的作业 ${sub.status} ${JSON.stringify(sub.body).slice(0, 160)}`);
    const subChip = chipOf(sub.body.job.id);
    await S.check(() => subChip.first().waitFor({ timeout: 20000 }).catch(() => { throw new Error('③ 接口建的重生成一块没在输入框上方成一枚 chip'); }));
    if (await subChip.count()) {
      await S.check(() => eventually(async () => expect((await subChip.getAttribute('data-state')) === 'failed', `③ 这一轮应失败：${await subChip.getAttribute('data-state')}`), 40000));
      const text3 = await subChip.innerText();
      await S.check(async () => expect((await subChip.getByTestId('retry-job').count()) === 0 && (await subChip.getByTestId('dismiss-job').count()) === 1, '③ 不能重试的作业 chip 上只应有 ×'));
      await S.check(() => expect(text3.includes('HTTP 401') && text3.includes('检查这条通道的 Key') && text3.includes('在检查器里再点一次「重生成这块」') && !text3.includes('点「重试」'), `③ 原因里应先说检查 Key、再写它自己再发一次的入口、不写「点「重试」」：${text3.replace(/\s+/g, ' ')}`));
      await subChip.getByTestId('dismiss-job').click().catch(() => {});
    }
    // 4 改组件：模型产出两个根 → chip 写「改组件失败」+ 中文原因，仍能重试
    runner = { kind: 'channel', channelId: twoRoots };
    await page.getByTestId('clear-targets').click();
    await page.locator('body').press('f');
    await page.locator('[data-testid="component-card"][data-name="AuditBar"]').click();
    await eventually(async () => expect((await page.locator('form.composer').getAttribute('data-verb')) === 'component', '应是改组件'));
    await input.fill('改成三个 tab');
    await input.press('Enter');
    const compChip = page.locator('[data-testid="job-chip"][data-state="failed"]').filter({ hasText: '改组件失败' });
    await S.check(() => compChip.waitFor({ timeout: 40000 }).catch(async () => { throw new Error(`④ 没出改组件的失败 chip：${(await page.locator('[data-testid="job-chip"]').allInnerTexts()).join(' | ') || '没有 chip'}`); }));
    if (await compChip.count()) {
      const text4 = await compChip.innerText();
      await S.check(() => expect(text4.includes('AuditBar') && text4.includes('根元素'), `④ 改组件的失败原因不对：${text4.replace(/\s+/g, ' ')}`));
      await S.check(async () => expect((await compChip.getByTestId('retry-job').count()) === 1, '④ 改组件失败也能原样重试'));
    }
    expect(sent.filter((x) => !x.url.endsWith('/retry')).length === 2, `应从输入框发出两轮：${sent.length} 次请求`);
    await shot(page, 'CORE-045');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); await stub.close(); }
  S.done();
  return '401 的失败 chip 写「改屏失败：通道的 Key 被拒绝（HTTP 401）」并带「重试」与 ×、不弹提示条；「重试」原样再发一轮、旧 chip 换成新作业的、× 关掉；重生成一块失败只有 × 且写回检查器的入口；改组件失败写根元素原因';
});

// TC-CORE-046 输入框：Esc 清草稿可撤销、贴图批量与上限、Enter 被挡说明、在途输入保留（REQ-CORE-006 / 012 / 020 v0.74）
await step('TC-CORE-046', async () => {
  const { projectId, screens } = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Composer', '--device', 'mobile', '--screens', '2');
  const [s1] = screens;
  const S = softly();
  const stub = startOpenAiStub({ port: 3996, apiKey: 'good-key-0046', reply: 'OK' });
  const ch = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 通道 46', endpoint: stub.url, model: 'stub-46', apiKey: 'good-key-0046' }) })).body.channel.id;
  expect((await apiJson<{ ok: boolean }>(`/v1/runners/channel:${ch}/probe`, { method: 'POST' })).body.ok, 'Stub 通道验证未通过');
  let hold = 0; let upHold = 0;
  const sent = await pinSends(page, { holdMs: () => hold });
  const UP_RE = /\/v1\/projects\/[^/]+\/attachments$/;
  await page.route(UP_RE, async (route) => { if (upHold) await new Promise((r) => setTimeout(r, upHold)); await route.continue(); });
  let agentNote = '本机没有 claude，第 5 步跳过';
  try {
    await openCanvas(projectId);
    const input = page.locator('#chat-input');
    // 发出去的请求由 pinSends 改走 stub，输入框这边也要选着一条云端通道才发得出去
    await pickOption(page, '[data-testid="runner-select"]', 'Stub 通道 46');
    // 1 Esc 清草稿后 ⌘Z 找回
    await input.click();
    await page.keyboard.type('一段写了很久的提示词');
    await page.keyboard.press('Escape');
    await S.check(async () => expect((await input.inputValue()) === '', `① Esc 应清掉草稿：「${await input.inputValue()}」`));
    await page.keyboard.press('ControlOrMeta+z');
    await S.check(() => eventually(async () => expect((await input.inputValue()) === '一段写了很久的提示词', `① ⌘Z 应找回草稿：「${await input.inputValue()}」`), 2000));
    // 2 上传拖 2.5 s：一次贴 3 张立刻出 3 张缩略图（都在上传）；再贴 3 张只收第 4 张、当场提示上限
    upHold = 2500;
    const paste = (n: number) => input.evaluate((el, a) => {
      const dt = new DataTransfer();
      const bin = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
      for (let i = 0; i < a.n; i++) dt.items.add(new File([bin], `p${Date.now()}-${i}.png`, { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { b64: PNG_B64, n });
    const thumbs = page.locator('button[aria-label^="移除参考图"]');
    const uploadingN = () => page.getByText('上传中…').count();
    await paste(3);
    await page.waitForTimeout(300);
    const first3 = [await thumbs.count(), await uploadingN()];
    await S.check(() => expect(first3[0] === 3 && first3[1] === 3, `② 一次贴 3 张应立刻出 3 张缩略图：${first3[0]} 张，上传中 ${first3[1]}`));
    await paste(3);
    await S.check(() => eventually(async () => expect((await page.getByText('一条消息最多 4 张参考图').count()) > 0, '② 超出上限应当场提示')));
    await page.waitForTimeout(300);
    await S.check(async () => expect((await thumbs.count()) === 4, `② 上限 4 张：实际 ${await thumbs.count()}`));
    // 3 参考图还在传时按 Enter：理由写在发送键上方那一行、不发请求；传完理由撤掉
    await input.fill('照这几张图改');
    const n0 = sent.length;
    await input.press('Enter');
    await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 1 && (await page.getByTestId('send-blocked-reason').innerText()).includes('参考图还在上传'), '③ 按 Enter 被挡时应就地写出理由')));
    expect(sent.length === n0, '参考图没传完不该发出去');
    await eventually(async () => expect((await uploadingN()) === 0, '上传应完成'), 20000);
    await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 0, '③ 传完理由应撤掉')));
    // 4 发送在途（请求拖 1.5 s）时补打的字与新贴的图，发送成功后留着，只去掉发出去的那部分
    while ((await thumbs.count()) > 1) await thumbs.first().click();
    await page.locator(`[data-testid="screen-card"][data-route="${s1.route}"] .gesture`).click();
    hold = 1500;
    await input.press('End');
    await input.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(' 再补一句');
    await paste(1);
    await eventually(async () => expect(sent.length === n0 + 1, '应发出一轮'));
    expect(sent[n0].body.content === '照这几张图改' && (sent[n0].body.attachmentIds as string[] | undefined)?.length === 1, `发出的应是原来那句与 1 张图：${JSON.stringify(sent[n0].body).slice(0, 160)}`);
    await page.waitForTimeout(2000);
    await S.check(async () => expect((await input.inputValue()) === '再补一句', `④ 发送成功后应只去掉发出去的那段：「${await input.inputValue()}」`));
    await S.check(async () => expect((await thumbs.count()) === 1, `④ 在途时新贴的图应留着：${await thumbs.count()}`));
    hold = 0;
    // 5 本机 agent 通道没选会话时按 Enter（claude 在 PATH 上才有这一路）
    const agentOk = (await apiJson<{ items: { id: string; available: boolean }[] }>('/v1/runners')).body.items.some((i) => i.id === 'agent:claude-code' && i.available);
    if (agentOk) {
      await eventually(async () => expect((await uploadingN()) === 0, '上传应完成'), 20000);
      while ((await thumbs.count()) > 0) await thumbs.first().click();
      // 清掉第 4 步的目标：那一屏的改屏作业可能还在跑，冲突理由会先占住这一行
      await page.getByTestId('clear-targets').click();
      await pickOption(page, '[data-testid="runner-select"]', '交给本机 Claude Code');
      const n1 = sent.length;
      await input.fill('做一个设置页');
      await input.press('Enter');
      await S.check(() => eventually(async () => expect((await page.getByTestId('send-blocked-reason').count()) === 1 && (await page.getByTestId('send-blocked-reason').innerText()).includes('会话'), '⑤ 没选会话时按 Enter 应写出理由')));
      expect(sent.length === n1, '没选会话不该发出去');
      await pickOption(page, '[data-testid="runner-select"]', 'Stub 通道 46');
      agentNote = '本机 agent 没选会话按 Enter 写出理由';
    }
    await shot(page, 'CORE-046');
  } catch (e) { S.fail(e); } finally { await page.unroute(SEND_RE); await page.unroute(UP_RE); await stub.close(); }
  S.done();
  return `Esc 清草稿 ⌘Z 找回；一次贴 3 张立刻 3 张、上限 4 当场提示；上传中按 Enter 写理由；在途补打的字与新图保留；${agentNote}`;
});

// v0.75 来源校验（DESIGN §15「本地服务」）：DNS 重绑后的同源请求（Host 是攻击者域名）、跨站表单与 no-cors 盲写
// （Origin 是别人的或 null）一律 403；本机画布、回环写法、MCP 客户端与脚本（不带 Origin）照常
await step('TC-CORE-060', async () => {
  const port = new URL(API).port;
  const csrfCount = async () => (await apiJson<{ items: { name: string }[] }>('/v1/projects')).body.items.filter((p) => p.name === 'csrf-060').length;
  const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quilt.list_projects', arguments: {} } });
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  // fetch（undici）会丢掉自定义的 Host 头，伪造请求头一律走 node:http
  const raw = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(`${API}${p}`, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
    });
    req.on('error', reject); req.end(init.body);
  });
  const forbidden = (r: { status: number; text: string }, what: string) => expect(r.status === 403 && r.text.includes('/errors/forbidden'), `${what} 应 403 /errors/forbidden：${r.status} ${r.text.slice(0, 120)}`);

  // 1 伪造 Host（DNS 重绑后浏览器发出的样子）：读项目、读通道、调 MCP
  const evilHost = `rebind.attacker.example:${port}`;
  forbidden(await raw('/v1/projects', { headers: { Host: evilHost } }), '伪造 Host 读项目');
  forbidden(await raw('/v1/channels', { headers: { Host: evilHost } }), '伪造 Host 读通道');
  forbidden(await raw('/mcp', { method: 'POST', headers: { ...mcpHeaders, Host: evilHost, Origin: `http://${evilHost}` }, body: mcpBody }), '伪造 Host 调 MCP');

  // 2 跨站盲写：text/plain（CORS 简单请求，不预检）+ 别人的 Origin / null
  const before = await csrfCount();
  for (const origin of ['http://evil.example', 'null']) {
    forbidden(await raw('/v1/projects', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin }, body: JSON.stringify({ name: 'csrf-060', deviceType: 'mobile' }) }), `Origin: ${origin} 的 text/plain 写请求`);
  }
  forbidden(await raw('/mcp', { method: 'POST', headers: { ...mcpHeaders, Origin: 'http://evil.example' }, body: mcpBody }), '别人的 Origin 调 MCP');

  // 3 合法来源照常：画布 origin、回环另一种写法、不带 Origin 的脚本与 MCP 客户端
  for (const origin of [new URL(WEB).origin, `http://127.0.0.1:${port}`]) {
    const r = await raw('/v1/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ name: 'legit-060', deviceType: 'mobile' }) });
    expect(r.status === 201, `Origin ${origin} 建项目应 201：${r.status} ${r.text.slice(0, 120)}`);
  }
  const loop = await raw('/v1/projects', { headers: { Host: `127.0.0.1:${port}` } });
  expect(loop.status === 200, `Host 127.0.0.1:${port} 应 200：${loop.status}`);
  const mcp = await connectMcp();
  try {
    const listed = await callTool(mcp, 'quilt.list_projects', {});
    expect(!listed.isError && listed.text.includes('legit-060'), `MCP 客户端（不带 Origin）应照常列出项目：${listed.text.slice(0, 120)}`);
  } finally { await mcp.close(); }

  // 4 真实浏览器：攻击者域名解析到回环（DNS 重绑之后的状态），页内同源 fetch 与跨站 text/plain 表单
  const rb = zhCN(await chromium.launch({ channel: 'msedge', headless: true, args: ['--host-resolver-rules=MAP rebind.test 127.0.0.1', '--no-proxy-server'] }));
  try {
    const pg = await rb.newPage();
    await pg.goto(`http://rebind.test:${port}/`);
    const same = await pg.evaluate(async (body) => {
      const g = await fetch('/v1/projects');
      const m = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
      return [g.status, m.status];
    }, mcpBody);
    expect(same[0] === 403 && same[1] === 403, `重绑页同源读项目 / 调 MCP 应 403：${same.join(' / ')}`);
    const [resp] = await Promise.all([
      pg.waitForResponse((r) => r.url() === `${API}/v1/projects` && r.request().method() === 'POST'),
      pg.evaluate((api) => {
        const f = document.createElement('form'); f.method = 'post'; f.enctype = 'text/plain'; f.action = `${api}/v1/projects`;
        const i = document.createElement('input'); i.name = '{"name":"csrf-060","deviceType":"mobile","x":"'; i.value = '"}';
        f.appendChild(i); document.body.appendChild(f); f.submit();
      }, API),
    ]);
    expect(resp.status() === 403, `跨站 text/plain 表单应 403：${resp.status()}`);
    await pg.waitForLoadState('load').catch(() => {});
    await pg.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-060.png`) });
  } finally { await rb.close(); }
  expect((await csrfCount()) === before, `跨站写请求建出了项目（csrf-060 多了 ${(await csrfCount()) - before} 个）`);
  return `伪造 Host 读项目 / 通道 / MCP 与 evil / null Origin 写入全部 403；画布 origin、127.0.0.1、MCP 客户端照常；重绑页同源 fetch 与跨站表单 403，未建出项目`;
});

// v0.75 屏里的脚本写不了主站（DESIGN §15「预览域」「对象下发」，ADR-004 补充）：同一张屏的脚本在截图渲染、导出抽 CSS、
// 预览域活 iframe、对象地址四处各跑一遍，每处都用 fetch no-cors 与 text/plain 表单往本机 API 写；库里一条都不能多。
// 屏里放一块探针：看到 connect-src 与 form-action 两类 CSP 违规、且预览域素材与 https 图片都加载出来才涂绿
await step('TC-CORE-061', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const pid = (await apiJson<{ project: { id: string } }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Isolation', deviceType: 'mobile' }) })).body.project.id;
  const form = new FormData();
  form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#2f9e44"/></svg>'], { type: 'image/svg+xml' }), 'green.svg');
  const assetUrl = ((await (await fetch(`${API}/v1/projects/${pid}/assets`, { method: 'POST', body: form })).json()) as { asset: { url: string } }).asset.url;
  const html = `<div class="bg-background p-6 space-y-4">
  <h1 class="text-2xl font-bold text-primary">Isolation</h1>
  <i data-lucide="house"></i>
  <img id="asset" src="${assetUrl}" width="40" height="40" alt="">
  <img id="remote" src="https://picsum.photos/id/10/40/40" width="40" height="40" alt="">
  <div id="probe" style="position:fixed;left:0;top:0;margin:0;width:60px;height:60px;background:#808080"></div>
  <script>
  (function () {
    var api = '${API}', pid = '${pid}', seen = {};
    function paint() {
      var ok = seen['form-action'] && seen['connect-src'] && document.getElementById('asset').naturalWidth > 0 && document.getElementById('remote').naturalWidth > 0;
      document.getElementById('probe').style.background = ok ? '#00c800' : '#c80000';
    }
    document.addEventListener('securitypolicyviolation', function (e) { seen[e.effectiveDirective] = 1; paint(); });
    function body(how) { return JSON.stringify({ content: 'csrf-061 ' + how + ' ' + location.origin, runner: { kind: 'model', driver: 'stub', model: 'stub' } }); }
    // 等 load 之后再动手：被 CSP 挡下的 form.submit() 会中止文档自己的加载，解析中途调用的话后面的内容与图片都不再加载
    window.addEventListener('load', function () {
      paint();
      fetch(api + '/v1/projects/' + pid + '/messages', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: body('fetch') }).catch(function () {});
      fetch(api + '/v1/projects', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: 'csrf-061', deviceType: 'mobile' }) }).catch(function () {});
      var f = document.createElement('form'); f.method = 'post'; f.enctype = 'text/plain'; f.action = api + '/v1/projects/' + pid + '/messages';
      var i = document.createElement('input'); var b = body('form'); i.name = b.slice(0, -1) + ',"x":"'; i.value = '"}';
      f.appendChild(i); document.body.appendChild(f); f.submit();
    });
  })();
  </script>
</div>`;
  // 写进库的痕迹：本项目里 csrf-061 开头的消息（每条都带发出它的 origin）与名为 csrf-061 的项目
  const leaks = async () => {
    const msgs = (await apiJson<{ items: { content: string }[] }>(`/v1/projects/${pid}/messages?limit=100`)).body.items.filter((m) => m.content.startsWith('csrf-061')).map((m) => m.content);
    const projs = (await apiJson<{ items: { name: string }[] }>('/v1/projects')).body.items.filter((p) => p.name === 'csrf-061').length;
    return { msgs, projs, none: msgs.length === 0 && projs === 0, text: `消息 ${JSON.stringify(msgs)}，csrf-061 项目 ${projs} 个` };
  };
  const probeColor = (b64: string, x: number, y: number) => page.evaluate(async ([data, px, py]) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(px as number, py as number, 1, 1).data.slice(0, 3));
  }, [b64, x, y] as const);
  const green = (rgb: number[]) => rgb[0] < 40 && rgb[1] > 160 && rgb[2] < 40;

  const mcp = await connectMcp();
  try {
    const created = await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Isolation', route: '/iso', html });
    expect(!created.isError, `推屏失败：${created.text.slice(0, 200)}`);
    const sid = (created.json as { screenId: string }).screenId;

    // 1 截图渲染：入库即截图，截图浏览器里同一段脚本执行
    let shotUrl: string | null = null;
    for (let i = 0; i < 40 && !shotUrl; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      shotUrl = (await apiJson<{ screens: { id: string; screenshotUrl: string | null }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)?.screenshotUrl ?? null;
    }
    const afterShot = await leaks();
    check(afterShot.none, `截图渲染后库里多出写入：${afterShot.text}`);
    if (!shotUrl) bad.push('截图 40 s 内未就绪');
    else {
      const b64 = Buffer.from(await (await fetch(shotUrl)).arrayBuffer()).toString('base64');
      const rgb = await probeColor(b64, 30, 30);
      check(green(rgb), `截图里探针不是绿色（${rgb.join(',')}）：截图渲染页没报出 connect-src / form-action 违规，或素材 / https 图片没加载出来`);
    }

    // 2 导出：抽 Tailwind 并集 CSS 时全部屏的 body 放进一页，脚本同样执行；产物与下载照常
    const exp = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    const expJob = await waitJob(exp.body.job.id, 90);
    check(expJob.status === 'succeeded', `导出作业 ${expJob.status}`);
    const afterExport = await leaks();
    check(afterExport.none, `导出后库里多出写入：${afterExport.text}`);
    const dl = await fetch(`${API}/v1/jobs/${exp.body.job.id}/export`);
    const dlText = await dl.text();
    check(dl.status === 200 && (dl.headers.get('content-disposition') ?? '').startsWith('attachment') && dlText.includes('Isolation') && dlText.includes('--tw-'), `画布的导出下载应 200 attachment 且含屏与 Tailwind CSS：${dl.status} ${dl.headers.get('content-disposition')}`);
    const ge = await callTool(mcp, 'quilt.get_export', { jobId: exp.body.job.id });
    const exportUrl = (ge.json as { url?: string }).url ?? '';
    check(exportUrl, `get_export 没给出地址：${ge.text.slice(0, 160)}`);

    // 3 对象地址：修订 htmlUrl 与 get_export 的 url 在 API origin 上下发——必须是附件、不在浏览器里渲染
    const rev = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${sid}/revisions`)).body.items[0];
    for (const [what, url] of [['htmlUrl', rev.htmlUrl], ['get_export url', exportUrl]] as const) {
      if (!url) continue;
      const r = await fetch(url);
      const cd = r.headers.get('content-disposition') ?? ''; const csp = r.headers.get('content-security-policy') ?? '';
      check(r.status === 200 && cd.startsWith('attachment') && csp.includes('sandbox') && r.headers.get('x-content-type-options') === 'nosniff', `${what} 响应头应为附件 + CSP sandbox + nosniff：${r.status} cd=${cd} csp=${csp}`);
      check((await r.text()).includes('csrf-061'), `${what} 的正文应照常可取`);
      const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await page.goto(url).catch(() => {});
      const d = await download;
      check(d, `浏览器打开 ${what} 应是下载，实际渲染在 ${page.url().slice(0, 60)}`);
      const name = d?.suggestedFilename() ?? '';
      check(!d || /^[0-9a-f-]{36}\.html$/.test(name), `${what} 的下载文件名应是对象键末段（<id>.html）：${name}`);
      await d?.cancel().catch(() => {});
    }
    await page.waitForTimeout(1500);
    const afterObjects = await leaks();
    check(afterObjects.none, `打开对象地址后库里多出写入：${afterObjects.text}`);

    // 4 预览域：响应头 CSP 含 form-action 'none'；双击进交互态，活 iframe 里同样报出两类违规，库里不多东西
    const pv = (await apiJson<{ screens: { id: string; previewUrl: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)!.previewUrl;
    const pvRes = await fetch(pv.replace(/\/\/[^/:]+/, '//127.0.0.1'));
    check((pvRes.headers.get('content-security-policy') ?? '').includes("form-action 'none'"), `预览响应的 CSP 缺 form-action 'none'：${pvRes.headers.get('content-security-policy')}`);
    await page.goto(`${WEB}/p/${pid}`);
    await page.locator('[data-testid="screen-card"][data-route="/iso"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="screen-card"][data-route="/iso"] .gesture').dblclick();
    const fl = page.frameLocator('.card.focused iframe');
    let bg = '';
    if (await fl.locator('#probe').waitFor({ timeout: 15000 }).then(() => true, () => false)) {
      await eventually(async () => { bg = await fl.locator('#probe').evaluate((el) => getComputedStyle(el).backgroundColor); expect(bg === 'rgb(0, 200, 0)', bg); }, 10000).catch(() => {});
      check(bg === 'rgb(0, 200, 0)', `预览 iframe 里探针不是绿色（${bg}）：没报出 connect-src / form-action 违规，或素材 / https 图片没加载出来`);
    } else bad.push(`预览 iframe 里 15 s 找不到探针（iframe 现在是 ${await page.locator('.card.focused iframe').evaluate((el) => (el as HTMLIFrameElement).src.slice(0, 60)).catch(() => '无')}，可能被屏里的表单提交带走了）`);
    await shot(page, 'CORE-061');
    await page.waitForTimeout(1500);
    const afterPreview = await leaks();
    check(afterPreview.none, `预览 iframe 跑过后库里多出写入：${afterPreview.text}`);
    await page.keyboard.press('Escape');
  } finally { await mcp.close(); }
  if (bad.length) { console.log(`   TC-CORE-061 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '截图渲染 / 导出抽 CSS / 对象地址 / 预览 iframe 四处都没写进库；截图与预览里探针为绿（两类 CSP 违规 + 素材与 https 图片加载）；htmlUrl 与导出地址为附件，浏览器下载不渲染；导出下载照常';
});

// v0.77 接口契约（DESIGN API-CORE-006 / 010 / 019 / 034、API-EDIT-005、§14）：目标屏与组件在建作业之前复核、
// 路径参数不是 UUID 回 404、非法游标回 400、内容校验按契约回 422。全部走 stub 通道，失败项攒齐一起报
await step('TC-CORE-062', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const FAKE = '11111111-2222-4333-8444-555555555555';
  type Problem = { type?: string; errors?: { path: string }[] };
  const post = <T,>(p: string, body: unknown) => apiJson<T & Problem>(p, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Contract', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, s2, s3] = screens.map((s) => s.id);
  const jobCount = async () => (await apiJson<{ items: unknown[] }>(`/v1/projects/${pid}/jobs?limit=100`)).body.items.length;

  // 1 目标屏不存在：发消息、建 edit_screens 作业都 404，一个作业也不建
  const before1 = await jobCount();
  const m404 = await post('/v1/projects/' + pid + '/messages', { content: 'change the title', targetScreenIds: [FAKE], runner: STUB });
  check(m404.status === 404 && m404.body.type === '/errors/not-found', `发消息目标屏不存在应 404：${m404.status} ${m404.body.type}`);
  const j404 = await post(`/v1/projects/${pid}/jobs`, { kind: 'edit_screens', input: { prompt: 'x', screenIds: [s1, FAKE], versions: 1, runner: STUB } });
  check(j404.status === 404 && j404.body.type === '/errors/not-found', `建 edit_screens 带不存在的屏应 404：${j404.status} ${j404.body.type}`);
  check((await jobCount()) === before1, `目标屏不存在时仍建出了作业（${before1} → ${await jobCount()}）`);

  // 2 改屏一轮跑完 → 删掉目标屏 → 重试 404
  const edit = await post<{ userMessage: { id: string }; job: { id: string } }>(`/v1/projects/${pid}/messages`, { content: 'make the header bold', targetScreenIds: [s3], runner: STUB });
  expect(edit.status === 202, `改屏一轮 ${edit.status}`);
  await waitJob(edit.body.job.id, 60);
  expect((await apiJson(`/v1/screens/${s3}`, { method: 'DELETE' })).status === 204, '删屏失败');
  const r404 = await post(`/v1/projects/${pid}/messages/${edit.body.userMessage.id}/retry`, {});
  check(r404.status === 404 && r404.body.type === '/errors/not-found', `目标屏已删的重试应 404：${r404.status} ${r404.body.type}`);

  // 3 改组件一轮跑完 → 删掉组件 → 重试 400，path 与发消息一致
  const comp = (await apiJson<{ component: { id: string } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Chip', html: '<div class="px-2 py-1 rounded-full bg-primary text-on-primary"><span>chip</span></div>' }) })).body.component;
  const ce = await post<{ userMessage: { id: string }; job: { id: string } }>(`/v1/projects/${pid}/messages`, { content: 'rounder', targetComponentIds: [comp.id], runner: STUB });
  expect(ce.status === 202, `改组件一轮 ${ce.status}`);
  await waitJob(ce.body.job.id, 60);
  const ceSend = await post(`/v1/projects/${pid}/messages`, { content: 'again', targetComponentIds: [FAKE], runner: STUB });
  expect((await apiJson(`/v1/components/${comp.id}`, { method: 'DELETE' })).status === 204, '删组件失败');
  const r400 = await post(`/v1/projects/${pid}/messages/${ce.body.userMessage.id}/retry`, {});
  check(r400.status === 400 && r400.body.type === '/errors/validation' && r400.body.errors?.[0]?.path === ceSend.body.errors?.[0]?.path, `组件已删的重试应与发消息同一个 400（path ${ceSend.body.errors?.[0]?.path}）：${r400.status} ${r400.body.type} ${r400.body.errors?.[0]?.path}`);

  // 4 造变体的 variantOf 不属本项目 → 422，不建作业
  const before4 = await jobCount();
  const v422 = await post(`/v1/projects/${pid}/jobs`, { kind: 'generate', input: { prompt: 'empty state', count: 1, versions: 1, variantOf: FAKE, variantName: '空状态', runner: STUB } });
  check(v422.status === 422 && v422.body.type === '/errors/validation', `variantOf 不属本项目应 422：${v422.status} ${v422.body.type}`);
  check((await jobCount()) === before4, 'variantOf 不对时仍建出了作业');

  // 5 路径 id 不是 UUID → 404；非法游标 → 400
  const cur = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === s1)!.currentRevisionId;
  const probes: [string, string, unknown?][] = [
    ['GET', '/v1/projects/x'], ['GET', '/v1/projects/x/messages'], ['PATCH', '/v1/screens/x', { x: 1 }], ['DELETE', '/v1/screens/x'], ['GET', '/v1/jobs/x'],
    ['POST', '/v1/jobs/x/cancel', {}], ['POST', '/v1/jobs/x/candidates/adopt', { index: 0 }], ['DELETE', '/v1/components/x'], ['PATCH', '/v1/annotations/x', { note: 'n' }],
    ['DELETE', '/v1/assets/x'], ['DELETE', '/v1/design-presets/x'], ['DELETE', '/v1/channels/x'], ['POST', `/v1/projects/${pid}/messages/x/retry`, {}],
    ['GET', `/v1/screens/${s1}/revisions/x`], ['POST', `/v1/screens/${s1}/revisions/x/restore`, { expectedRevisionId: cur }],
  ];
  const not404: string[] = [];
  for (const [method, p, body] of probes) {
    const r = await apiJson<Problem>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status !== 404 || r.body?.type !== '/errors/not-found') not404.push(`${method} ${p} → ${r.status}`);
  }
  check(!not404.length, `非 UUID 的路径 id 应 404：${not404.join('，')}`);
  for (const p of [`/v1/projects/${pid}/messages?cursor=abc`, '/v1/projects?cursor=notadate']) {
    const r = await apiJson<Problem>(p);
    check(r.status === 400 && r.body.type === '/errors/validation', `非法游标应 400：${p} → ${r.status}`);
  }
  const okCursor = await apiJson<{ items: unknown[] }>(`/v1/projects/${pid}/messages?cursor=${encodeURIComponent(new Date().toISOString())}`);
  check(okCursor.status === 200, `合法游标应 200：${okCursor.status}`);

  // 6 附件与组件直改的内容校验 → 422
  const gif = await apiJson<Problem>(`/v1/projects/${pid}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/gif', bytes: 10 }) });
  check(gif.status === 422 && gif.body.type === '/errors/validation', `附件类型不对应 422：${gif.status}`);
  const signed = (await apiJson<{ putUrl: string }>(`/v1/projects/${pid}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: 10 }) })).body;
  const empty = await fetch(API + signed.putUrl, { method: 'PUT', body: new Uint8Array(0), headers: { 'content-type': 'image/png' } });
  check(empty.status === 422, `直传空文件应 422：${empty.status}`);
  const c2 = (await apiJson<{ component: { id: string; html: string; version: number } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Tag', html: '<div class="px-2"><span>tag</span></div>' }) })).body.component;
  const rootQid = /data-qid="(q\d+)"/.exec(c2.html)?.[1] ?? 'q1';
  const rm = await apiJson<Problem>(`/v1/components/${c2.id}/elements/${rootQid}`, { method: 'POST', body: JSON.stringify({ ops: [{ type: 'remove' }], expectedVersion: c2.version }) });
  check(rm.status === 422 && rm.body.type === '/errors/validation', `组件直改删掉根元素应 422：${rm.status}`);

  // 7 发消息的正文与隐藏参数要配套（API-CORE-010）：正文只在带隐藏参数（补链、出变体、钉死路由）时可空，参数与动词不配套一律 400
  const pairs: [Record<string, unknown>, string][] = [
    [{ content: '', targetScreenIds: [s1] }, 'content'],
    [{ content: '', preset: 'link_repair' }, 'targetScreenIds'],
    [{ content: 'x', variantOf: s1, variantName: 'Empty', targetScreenIds: [s2] }, 'targetScreenIds'],
  ];
  for (const [body, at] of pairs) {
    const r = await post<Problem>(`/v1/projects/${pid}/messages`, { runner: STUB, ...body });
    check(r.status === 400 && !!r.body.errors?.some((e) => e.path === at), `${JSON.stringify(body)} 应 400 path=${at}：${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }

  if (bad.length) { console.log(`   TC-CORE-062 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '目标屏不存在 / 已删 404、组件已删的重试同发消息 400、variantOf 422，均不建作业；15 个非 UUID 路径 404、两处非法游标 400；附件类型 / 空文件与组件删根 422；空正文与不配套的隐藏参数 400';
});

// v0.77 并发写入的一致性（DESIGN §16 竞态表）：采用候选 vs 回溯、设计系统同版本并发保存、同一幂等键并发、删屏 / 删项目时在途截图
await step('TC-CORE-063', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Race', '--device', 'mobile', '--screens', '3', '--no-shot');
  const [s1, s2] = screens.map((s) => s.id);
  const currentOf = async (sid: string) => (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === sid)!.currentRevisionId;

  // 1 采用候选 vs 回溯：每轮先出两版候选，再同时发「回溯到第 1 版」与「采用第 2 版」（采用晚 d ms）；两边不能都成功，回溯成功时它必须是 current
  for (const d of [0, 10, 20, 30]) {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: `two versions ${d}`, targetScreenIds: [s1], versions: 2, runner: STUB }) });
    expect(r.status === 202, `出候选 ${r.status}`);
    expect((await waitJob(r.body.job.id, 60)).status === 'succeeded', '出候选的作业没成功');
    const cands = (await apiJson<{ screens: { revisions: { id: string; index: number }[] }[] }>(`/v1/jobs/${r.body.job.id}/candidates`)).body.screens[0].revisions;
    const [c0, c1] = [cands.find((x) => x.index === 0)!.id, cands.find((x) => x.index === 1)!.id];
    const [restore, adopt] = await Promise.all([
      apiJson<{ revision?: { id: string } }>(`/v1/screens/${s1}/revisions/${c0}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId: c0 }) }),
      sleep(d).then(() => apiJson(`/v1/screens/${s1}/revisions/${c1}/adopt`, { method: 'POST', body: '{}' })),
    ]);
    const now = await currentOf(s1);
    check(!(restore.status === 201 && adopt.status === 200), `采用晚 ${d} ms：回溯 ${restore.status} 与采用 ${adopt.status} 都成功`);
    if (restore.status === 201) check(now === restore.body.revision!.id, `采用晚 ${d} ms：回溯成功了但 current 不是它（被候选顶掉）`);
  }

  // 2 设计系统：同一 expectedVersion 并发 6 个保存，只能成一个
  const colors = ['#E03131', '#2F9E44', '#1971C2', '#F08C00', '#7048E8', '#0CA678'];
  for (let round = 0; round < 3; round++) {
    const v = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    const rs = await Promise.all(colors.map((seedColor) => apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ seedColor, expectedVersion: v }) })));
    const codes = rs.map((x) => x.status);
    const after = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    check(codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 5 && after === v + 1, `第 ${round + 1} 轮 expectedVersion=${v}：${codes.join(' ')}，之后版本 ${after}`);
  }

  // 3 同一个 Idempotency-Key 并发：导出 3 个、改屏 2 个，都拿到同一个作业，没有 409
  for (let round = 0; round < 2; round++) {
    const key = crypto.randomUUID();
    const rs = await Promise.all([0, 1, 2].map(() => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/jobs`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ kind: 'export_prototype', input: {} }) })));
    const ids = new Set(rs.map((x) => x.body.job?.id));
    check(rs.every((x) => x.status === 202 || x.status === 200) && ids.size === 1 && !ids.has(undefined), `导出同键并发：${rs.map((x) => `${x.status}${x.body.type ? ' ' + x.body.type : ''}`).join(' / ')}`);
    const mkey = crypto.randomUUID();
    const ms = await Promise.all([0, 1].map(() => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': mkey }, body: JSON.stringify({ content: `same key ${round}`, targetScreenIds: [s2], runner: STUB }) })));
    const mids = new Set(ms.map((x) => x.body.job?.id));
    check(ms.every((x) => x.status === 202 || x.status === 200) && mids.size === 1 && !mids.has(undefined), `改屏同键并发：${ms.map((x) => `${x.status}${x.body.type ? ' ' + x.body.type : ''}`).join(' / ')}`);
    for (const id of mids) if (id) await waitJob(id, 60);
  }

  // 4 删屏 / 删项目时截图正在渲染：屏里一张连不上的外链图让截图拖十几秒，期间删掉；之后不能留下对象
  const mcp = await connectMcp();
  try {
    const STALL = '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Stall</h1><img src="http://10.255.255.1/x.png" width="40" height="40" alt=""></div>';
    const p2 = (await apiJson<{ project: { id: string } }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Orphan', deviceType: 'mobile' }) })).body.project.id;
    const a = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Stall', route: '/stall', html: STALL })).json as { screenId: string; revisionId: string };
    const b = (await callTool(mcp, 'quilt.create_screen', { projectId: p2, name: 'Stall', route: '/stall', html: STALL })).json as { screenId: string };
    // 对照屏：同一份 HTML、不删，它的截图就绪说明被删的那两张也渲染完了——之后再看目录，免得截图还没写回就判通过
    const ctl = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Control', route: '/control', html: STALL })).json as { screenId: string };
    await sleep(2000);
    const pending = (await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${a.screenId}/revisions`)).body.items[0].screenshotUrl === null;
    expect((await apiJson(`/v1/screens/${a.screenId}`, { method: 'DELETE' })).status === 204, '删屏失败');
    expect((await apiJson(`/v1/projects/${p2}`, { method: 'DELETE' })).status === 204, '删项目失败');
    let rendered = false;
    for (let i = 0; i < 90 && !rendered; i++) { await sleep(1000); rendered = !!(await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${ctl.screenId}/revisions`)).body.items[0]?.screenshotUrl; }
    expect(rendered, '对照屏 90 s 内截图未就绪，判不了被删屏的截图写回');
    await sleep(3000);
    const screenDir = path.join(ROOT, '.data/objects/projects', pid, 'screens', a.screenId);
    const projectDir = path.join(ROOT, '.data/objects/projects', p2);
    check(!existsSync(screenDir), `删屏且截图渲染完之后对象目录还在：${screenDir}（删屏时截图${pending ? '还在渲染' : '已就绪，前置不成立'}）`);
    check(!existsSync(projectDir), `删项目且截图渲染完之后对象目录还在：${projectDir}${b.screenId ? '' : '（建屏失败）'}`);
  } finally { await mcp.close(); }

  if (bad.length) { console.log(`   TC-CORE-063 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '采用 vs 回溯 4 轮无双成功、current 不被顶掉；设计系统 3 轮 × 6 并发各只成一个；同键并发导出 / 改屏都拿到首次作业；删屏 / 删项目时在途截图不留对象';
});

// v0.77 别处的写入推到已打开的画布（DESIGN API-CORE-030、PAGE-CANVAS「变化从哪来都能到」）：MCP 与另一个「标签页」（直接调 REST）
// 挪屏、删屏、改项目名、改设计系统、建组件、加批注，画布不刷新就能看到；项目被删时事件流发完 project_deleted 就关，画布重取得 404
await step('TC-CORE-064', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Live', '--device', 'mobile', '--screens', '3');
  const [s1, , s3] = screens.map((s) => s.id);
  const pg = await ctx.newPage();
  const detailGets: number[] = [];
  pg.on('response', (r) => { if (r.request().method() === 'GET' && new URL(r.url()).pathname === `/v1/projects/${pid}`) detailGets.push(r.status()); });
  const mcp = await connectMcp();
  try {
    await pg.goto(`${WEB}/p/${pid}`, { waitUntil: 'domcontentloaded' });
    const cards = pg.locator('[data-testid="screen-card"]');
    await eventually(async () => expect((await cards.count()) === 3, 'cards'), 15000);
    await pg.waitForTimeout(1500); // 首屏加载的重取落定后再数
    const refetched = async (what: string, act: () => Promise<unknown>) => {
      const n = detailGets.length;
      await act();
      await eventually(() => expect(detailGets.length > n, what), 4000).catch(() => check(false, `${what}后 4 s 内画布没有重取详情`));
    };
    // 挪屏（MCP move_screens）
    await callTool(mcp, 'quilt.move_screens', { screens: [{ id: s1, x: 3000, y: 2000 }] });
    await eventually(async () => expect((await pg.locator('[data-testid="screen-card"][data-route="/s1"]').getAttribute('style'))?.includes('translate(3000px, 2000px)'), 'move'), 4000)
      .catch(async () => check(false, `MCP 挪屏后 4 s 画布上 /s1 还在原位：${await pg.locator('[data-testid="screen-card"][data-route="/s1"]').getAttribute('style')}`));
    // 删屏（MCP delete_screen）
    await callTool(mcp, 'quilt.delete_screen', { screenId: s3 });
    await eventually(async () => expect((await cards.count()) === 2, 'delete'), 4000).catch(async () => check(false, `MCP 删屏后 4 s 画布仍有 ${await cards.count()} 张卡`));
    // 改项目名（MCP update_project）
    await callTool(mcp, 'quilt.update_project', { projectId: pid, name: 'Live 2' });
    await eventually(async () => expect((await pg.title()).startsWith('Live 2'), 'rename'), 4000).catch(async () => check(false, `MCP 改名后 4 s 标签页标题仍是「${await pg.title()}」`));
    await pg.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-064.png`) });
    // 改设计系统（另一个标签页：直接 PUT）、建组件（MCP）、加批注（REST）
    const v = (await apiJson<{ designSystem: { version: number } }>(`/v1/projects/${pid}`)).body.designSystem.version;
    await refetched('另一个标签页改设计系统', () => apiJson(`/v1/projects/${pid}/design-system`, { method: 'PUT', body: JSON.stringify({ seedColor: '#E03131', expectedVersion: v }) }));
    await callTool(mcp, 'quilt.create_component', { projectId: pid, name: 'Badge', html: '<span class="px-2 rounded-full bg-primary text-on-primary">new</span>' });
    await eventually(async () => expect((await pg.locator('[data-testid="component-card"][data-name="Badge"]').count()) === 1, 'component'), 4000).catch(() => check(false, 'MCP 建组件后 4 s 画布上没有组件卡'));
    await refetched('另一个标签页加批注', () => apiJson(`/v1/screens/${s1}/annotations`, { method: 'POST', body: JSON.stringify({ qid: 'q1', note: '标题再大一点', anchorText: 'Screen 1', rect: { x: 0, y: 0, w: 100, h: 40 } }) }));
    // 删项目：一条独立的事件流应收到 project_deleted 并结束；画布重取得 404
    const es = await fetch(`${API}/v1/projects/${pid}/events`, { headers: { Accept: 'text/event-stream' } });
    const reader = es.body!.getReader();
    let text = '';
    const ended = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return true; text += new TextDecoder().decode(value); } })();
    await pg.waitForTimeout(500);
    const n404 = detailGets.filter((s) => s === 404).length;
    await callTool(mcp, 'quilt.delete_project', { projectId: pid });
    const closed = await Promise.race([ended, new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!closed) await reader.cancel().catch(() => {});
    check(text.includes('project_deleted'), `删项目后 5 s 事件流没有 project_deleted：${JSON.stringify(text.slice(0, 160))}`);
    check(closed, '删项目后 5 s 事件流没有结束');
    await eventually(() => expect(detailGets.filter((s) => s === 404).length > n404, '404'), 5000).catch(() => check(false, '删项目后 5 s 画布没有重取详情（没拿到 404）'));
  } finally { await mcp.close(); await pg.close(); }
  if (bad.length) { console.log(`   TC-CORE-064 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return 'MCP 挪屏 / 删屏 / 改名、建组件在 4 s 内到画布；另一个标签页改设计系统、加批注触发重取；删项目时事件流发 project_deleted 后结束，画布重取得 404';
});
