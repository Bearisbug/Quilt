// docs/TEST.md CORE 域 · 截图链（TC-CORE-065～068）。由 ../core.ts 按顺序引入，共用的浏览器、页面与脚手架在 ./shared.ts
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { seedJson, apiJson, API, eventually } from '../lib.ts';
import { startOpenAiStub } from '../openai-stub.ts';
import { connectMcp, callTool } from '../mcp-client.ts';
import { expect, waitJob } from '../harness.ts';
import { step, shot, sleep079 } from './shared.ts';

// v0.79 作业与 worker 健壮性（DESIGN §11 / §16 / §17）共用的小工具：读一条 SSE 流（不经浏览器）；探针图——屏里一张指向本机探针的图，
// 探针回 404 时 onerror 挂上一个不停清空 Tailwind 样式的定时器，截图的就绪判定等不到样式、这次拍摄失败；探针回 PNG 就一切正常
const readSse = async (url: string) => {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  expect(res.ok && res.body, `打不开事件流 ${url}：${res.status}`);
  const reader = res.body!.getReader();
  const s = { text: '', done: false, close: () => reader.cancel().catch(() => {}) };
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) { s.done = true; return; } s.text += new TextDecoder().decode(value); } })().catch(() => { s.done = true; });
  return s;
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const startProbe = async (port: number, ok: (hit: number) => boolean) => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; if (!ok(hits)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_1PX); });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return { hits: () => hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
};
const probeScreen = (port: number, title: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">${title}</h1><img src="http://127.0.0.1:${port}/probe.png" width="8" height="8" alt="" onerror="setInterval(function(){document.querySelectorAll('style').forEach(function(s){if(s.textContent.indexOf('--tw-')>=0)s.textContent=''})},10)"></div>`;
const bodyOf = async (screenId: string) => {
  const rev = (await apiJson<{ items: { htmlUrl: string }[] }>(`/v1/screens/${screenId}/revisions`)).body.items[0];
  return (await (await fetch(rev.htmlUrl)).text()).split('<body')[1].replace(/^[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/\sdata-qid="q\d+"/g, '');
};

// v0.79 服务端通知通道断线自愈（§16 一致性承诺、API-CORE-030）：从数据库那边掐掉 API 的 LISTEN 连接，项目流先收到 reconnected，
// 之后的写入照常推到，作业流不靠 15 s 一次的心跳补读也能推进。要本机 docker 里的 quilt-pg（§3）
await step('TC-CORE-065', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const dbName = ((await (await fetch(`${API}/v1/health`)).json()) as { database: string }).database;
  const psql = (q: string) => execFileSync('docker', ['exec', 'quilt-pg', 'psql', '-U', 'quilt', '-d', dbName, '-Atc', q], { encoding: 'utf8' }).trim();
  try { psql('select 1'); } catch (e) { throw new Error(`环境：连不上 docker 里的 quilt-pg，掐不了 LISTEN 连接（${(e as Error).message.split('\n')[0]}）`); }
  const LISTENING = `from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query ilike 'listen %'`;
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Listen', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  const edit = async (content: string) => {
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, targetScreenIds: [s1], runner: STUB }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    return r.body.job.id;
  };
  // 前置：两条频道都在 API 的 LISTEN 表里——开项目流，并完整读一条作业流
  const proj = await readSse(`${API}/v1/projects/${pid}/events`);
  const warm = await edit('warm up');
  const warmStream = await readSse(`${API}/v1/jobs/${warm}/events`);
  await eventually(() => expect(warmStream.done, 'warm'), 60_000);
  await eventually(() => expect(Number(psql(`select count(*) ${LISTENING}`)) >= 1, 'listener'), 5000);
  // 1 掐掉 LISTEN 连接 → 10 s 内项目流收到 reconnected，LISTEN 连接重建
  const killed = Number(psql(`select count(*) from (select pg_terminate_backend(pid) ${LISTENING}) t`));
  expect(killed >= 1, `没有掐到 LISTEN 连接（${killed}）`);
  await eventually(() => expect(proj.text.includes('"reason":"reconnected"'), 'reconnected'), 10_000)
    .catch(() => check(false, `掐掉 LISTEN 连接后 10 s 项目流没有收到 reconnected（流里最后：${JSON.stringify(proj.text.slice(-120))}）`));
  check(Number(psql(`select count(*) ${LISTENING}`)) >= 1, 'LISTEN 连接没有重建');
  // 2 之后的写入照常推到：MCP 建一屏，5 s 内项目流里有它
  const mcp = await connectMcp();
  try {
    const made = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'After', route: '/after', html: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">After</h1></div>' })).json as { screenId: string };
    await eventually(() => expect(proj.text.includes(made.screenId), 'screen'), 5000).catch(() => check(false, '重连后 MCP 建屏，项目流 5 s 内没有它的 screen_changed'));
  } finally { await mcp.close(); }
  // 3 作业流：模型拖 3 s 的改屏，开流后 8 s 内收到 screen_html_ready（断了没重连时要等 15 s 一次的心跳才补读）
  const held = await edit('[stub-hold:3000] after reconnect');
  const t0 = Date.now();
  const js = await readSse(`${API}/v1/jobs/${held}/events`);
  await eventually(() => expect(js.text.includes('event: screen_html_ready'), 'html'), 8000)
    .catch(() => check(false, `重连后作业流 8 s 内没有收到 screen_html_ready（流里：${JSON.stringify(js.text.slice(-120))}）`));
  const htmlAt = Math.round((Date.now() - t0) / 100) / 10;
  proj.close(); js.close(); warmStream.close();
  await waitJob(held, 60);
  // 4 掐掉被测库的全部连接（连接池里的空闲连接也在内，§16 v1.03）：API 进程不退，10 s 内 health 照常、能写库
  const all = Number(psql(`select count(*) from (select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()) t`));
  await eventually(async () => expect((await fetch(`${API}/v1/health`).then((r) => r.status, () => 0)) === 200, 'health'), 10_000)
    .catch(() => check(false, `掐掉全部 ${all} 条连接后 10 s 内 health 不通（进程多半退了）`));
  const renamed = await apiJson(`/v1/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ name: 'Listen 2' }) }).then((r) => r.status, () => 0);
  check(renamed === 200, `掐掉全部连接后写库失败：${renamed}`);
  if (bad.length) { console.log(`   TC-CORE-065 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return `掐掉 ${killed} 条 LISTEN 连接后项目流收到 reconnected、连接重建；MCP 建屏 5 s 内推到；开作业流后 ${htmlAt} s 收到 screen_html_ready（桩拖 3 s）；掐掉全部 ${all} 条连接后进程照常`;
});

// v0.79 截图：lucide 不认识的图标名不挡截图；作业里行内拍失败的截图入队重试、数秒内补上并推 screen_changed{screenshot:true}
await step('TC-CORE-066', async () => {
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Shots', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  const shotOf = async (sid: string, rev: string) => (await apiJson<{ items: { id: string; screenshotUrl: string | null }[] }>(`/v1/screens/${sid}/revisions`)).body.items.find((x) => x.id === rev)?.screenshotUrl ?? null;
  // 1 同一张屏，只差第二个图标名：bell（lucide 认识）与 home-heart-sparkle（不认识）
  const icons = (name: string) => `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Icons</h1><i data-lucide="home" class="w-5 h-5"></i><i data-lucide="${name}" class="w-5 h-5"></i></div>`;
  const mcp = await connectMcp();
  let good: { screenId: string; revisionId: string }; let odd: { screenId: string; revisionId: string };
  try {
    good = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'IconGood', route: '/icon-good', html: icons('bell') })).json as typeof good;
    odd = (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'IconOdd', route: '/icon-odd', html: icons('home-heart-sparkle') })).json as typeof odd;
  } finally { await mcp.close(); }
  await eventually(async () => expect(await shotOf(good.screenId, good.revisionId), 'good'), 40_000).catch(() => check(false, '图标都认识的屏 40 s 内截图没就绪（环境？）'));
  await eventually(async () => expect(await shotOf(odd.screenId, odd.revisionId), 'odd'), 40_000).catch(() => check(false, '带一个 lucide 不认识的图标名：40 s 内截图仍未就绪'));
  // 2 作业里的截图：OpenAI 兼容桩回一张带探针图的屏，探针第一次回 404（这次截图失败），之后回 PNG
  const probe = await startProbe(3989, (n) => n > 1);
  const stub = startOpenAiStub({ port: 3992, apiKey: 'good-key-0066', reply: probeScreen(3989, 'Retry shot') });
  let cid = '';
  const proj = await readSse(`${API}/v1/projects/${pid}/events`);
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 截图', endpoint: stub.url, model: 'stub-66', apiKey: 'good-key-0066' }) })).body.channel.id;
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'retry the shot', targetScreenIds: [s1], runner: { kind: 'channel', channelId: cid } }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    const job = await waitJob(r.body.job.id, 90);
    expect(job.status === 'succeeded', `改屏作业 ${job.status}`);
    const rev = (job.output as { revisionIds: string[] }).revisionIds[0];
    const t0 = Date.now();
    await eventually(async () => expect(await shotOf(s1, rev), 'shot'), 30_000)
      .catch(async () => check(false, `作业结束 30 s 后这版仍没有截图（探针被请求 ${probe.hits()} 次：第 1 次是作业里那次失败的拍摄，之后没有重试）`));
    await eventually(() => expect(proj.text.includes(rev) && /"screenshot":true/.test(proj.text), 'event'), 5000)
      .catch(() => check(false, '截图补上后项目流没有推 screen_changed{screenshot:true}'));
    check(probe.hits() >= 2, `探针只被请求 ${probe.hits()} 次，没有发生「失败 → 重试」`);
    if (!bad.length) return `未知图标名的屏照常出截图；作业里第一次拍摄失败，${Math.round((Date.now() - t0) / 1000)} s 内重试补上并推了 screenshot 事件（探针 ${probe.hits()} 次）`;
  } finally {
    proj.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' });
    await stub.close(); await probe.close();
  }
  console.log(`   TC-CORE-066 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；'));
});

// v0.79 候选批有一版失败（REQ-CORE-015 / §11 running→failed）：已落的候选接管 current、带候选角标，回执按屏计数
await step('TC-CORE-067', async () => {
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Partial', '--device', 'mobile', '--screens', '1', '--no-shot');
  const s1 = screens[0].id;
  type Scr = { id: string; currentRevisionId: string; pendingCandidates: { jobId: string; count: number } | null };
  const scr = async () => (await apiJson<{ screens: Scr[] }>(`/v1/projects/${pid}`)).body.screens.find((s) => s.id === s1)!;
  const rev0 = (await scr()).currentRevisionId;
  // 三版并行，第 2 次调用回 400（不可重试）
  const stub = startOpenAiStub({ port: 3991, apiKey: 'good-key-0067', reply: (await bodyOf(s1)).replace('Screen 1', 'Partial'), fail: (_hit, n) => (n === 2 ? 400 : null) });
  let cid = '';
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 部分失败', endpoint: stub.url, model: 'stub-67', apiKey: 'good-key-0067' }) })).body.channel.id;
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'three versions', targetScreenIds: [s1], versions: 3, runner: { kind: 'channel', channelId: cid } }) });
    expect(r.status === 202, `改屏 ${r.status}`);
    const job = await waitJob(r.body.job.id, 90);
    const out = job.output as { errorClass?: string; revisionIds: string[] };
    expect(job.status === 'failed' && out.errorClass === 'provider' && out.revisionIds.length === 2, `作业应 failed(provider) 且落了 2 版：${job.status} ${JSON.stringify(out).slice(0, 200)}`);
    const now = await scr();
    const cands = (await apiJson<{ screens: { revisions: { id: string; index: number }[] }[] }>(`/v1/jobs/${r.body.job.id}/candidates`)).body.screens[0]?.revisions ?? [];
    const first = [...cands].sort((a, b) => a.index - b.index)[0]?.id;
    expect(now.currentRevisionId !== rev0 && now.currentRevisionId === first, `已落的候选没有接管 current（current ${now.currentRevisionId === rev0 ? '仍是原版' : now.currentRevisionId}，第 1 版 ${first}）`);
    expect(now.pendingCandidates?.jobId === r.body.job.id && now.pendingCandidates.count === 2, `卡片应带「2 版」候选角标：${JSON.stringify(now.pendingCandidates)}`);
    const msg = (await apiJson<{ items: { role: string; jobId: string | null; content: string }[] }>(`/v1/projects/${pid}/messages`)).body.items.find((m) => m.role === 'assistant' && m.jobId === r.body.job.id);
    expect(msg?.content.includes('已保留 1 屏'), `回执应按屏计数「已保留 1 屏」：${msg?.content}`);
    return `第 2 次调用 400 → failed(provider)；另 2 版落库，current 指向第 ${cands.find((c) => c.id === first)?.index ?? '?'} 版、角标 2 版；回执「已保留 1 屏」`;
  } finally {
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' });
    await stub.close();
  }
});

// v0.79 进程重启的收口（§16 进程启动、§17 job.claim / screenshot.retry）：造屏跑到一半进程被杀、停在 queued 的本机 agent 作业、补扫补上的截图。
// 要能重启被测 API：QUILT_E2E_RESTART 是一条命令，须以 SIGKILL 结束旧进程（模拟崩溃，finally 不执行）、再起新进程并等到就绪（§3）
await step('TC-CORE-068', async () => {
  const RESTART = process.env.QUILT_E2E_RESTART;
  expect(RESTART, '环境：未设 QUILT_E2E_RESTART（重启被测 API 的命令，§3）');
  const bad: string[] = [];
  const check = (cond: unknown, msg: string) => { if (!cond) bad.push(msg); };
  const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
  const { projectId: pid, screens } = seedJson<{ projectId: string; screens: { id: string }[] }>('seed:project', '--name', 'Restart', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [s1, s2] = screens.map((s) => s.id);
  type Scr = { id: string; name: string; currentRevisionId: string | null; pendingCandidates: { count: number } | null };
  const scrs = async () => (await apiJson<{ screens: Scr[] }>(`/v1/projects/${pid}`)).body.screens;
  const sendEdit = (sid: string) => apiJson<{ job?: { id: string }; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'after restart', targetScreenIds: [sid], runner: STUB }) });
  // 1 一张截图一直拍不成的屏（探针回 404），放过 30 s——重启后的首轮补扫才会扫到它
  let probeOk = false;
  const probe = await startProbe(3988, () => probeOk);
  const mcp = await connectMcp();
  const probed = await (async () => { try { return (await callTool(mcp, 'quilt.create_screen', { projectId: pid, name: 'Probe', route: '/probe', html: probeScreen(3988, 'Probe') })).json as { screenId: string; revisionId: string }; } finally { await mcp.close(); } })();
  const probedAt = Date.now();
  // 2 造屏：规划 Cart / Checkout 两屏 × 2 版；Cart 两版立即回，Checkout 拖 120 s
  const body0 = await bodyOf(s1);
  const PLAN = JSON.stringify({ entryFrom: null, screens: [
    { name: 'Cart', route: '/cart', purpose: 'items to buy', links: ['/s1'], sections: ['items'] },
    { name: 'Checkout', route: '/checkout', purpose: 'pay', links: ['/cart'], sections: ['pay'] },
  ] });
  const stub = startOpenAiStub({ port: 3990, apiKey: 'good-key-0068', reply: (hit) => (hit.user.includes('\nRequest:') ? PLAN : body0.replace('Screen 1', hit.user.includes('screen "Checkout"') ? 'Checkout' : 'Cart')), holdMs: (hit) => (hit.user.includes('screen "Checkout"') ? 120_000 : 0) });
  let cid = '';
  let proj: Awaited<ReturnType<typeof readSse>> | null = null;
  try {
    cid = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Stub 重启', endpoint: stub.url, model: 'stub-68', apiKey: 'good-key-0068' }) })).body.channel.id;
    const g = await apiJson<{ job: { id: string } }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content: 'cart and checkout', count: 2, versions: 2, runner: { kind: 'channel', channelId: cid } }) });
    expect(g.status === 202, `造屏 ${g.status}`);
    let cart: Scr | undefined;
    await eventually(async () => {
      cart = (await scrs()).find((s) => s.name === 'Cart');
      expect(cart && (await apiJson<{ items: unknown[] }>(`/v1/screens/${cart.id}/revisions`)).body.items.length === 2, 'cart');
    }, 60_000).catch(() => { throw new Error('60 s 内 Cart 的两版没有落库'); });
    const checkout = (await scrs()).find((s) => s.name === 'Checkout');
    expect(checkout && !checkout.currentRevisionId, 'Checkout 应已规划、还没出屏');
    // 3 一个停在 queued 的本机 agent 作业占着 /s2（会话不存在）
    const agent = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--screen', s2, '--status', 'queued', '--runner', 'agent', '--input', JSON.stringify({ prompt: 'x', screenIds: [s2], versions: 1, runner: { kind: 'agent', tool: 'claude-code', sessionId: '00000000-0000-4000-8000-000000000068' } }));
    const busy = await sendEdit(s2);
    check(busy.status === 409, `重启前 /s2 应被 queued 的 agent 作业占着：${busy.status}`);
    // 4 探针放行，杀掉 API 重启；旧进程一停就抢着开项目流，赶在首轮补扫（启动后 3 s）之前
    await sleep079(Math.max(0, probedAt + 31_000 - Date.now()));
    check(!(await apiJson<{ items: { id: string; screenshotUrl: string | null }[] }>(`/v1/screens/${probed.screenId}/revisions`)).body.items[0]?.screenshotUrl, '前置不成立：探针屏在重启前已有截图');
    probeOk = true;
    const restarting = new Promise<void>((resolve, reject) => { const p = spawn('sh', ['-c', RESTART!], { stdio: 'ignore' }); p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`重启命令退出码 ${code}`)))); });
    await eventually(async () => { const ok = await fetch(`${API}/v1/health`).then(() => true, () => false); expect(!ok, 'still up'); }, 30_000, 50);
    for (let i = 0; i < 1200 && !proj; i++) { proj = await readSse(`${API}/v1/projects/${pid}/events`).catch(() => null); if (!proj) await sleep079(100); }
    await restarting;
    expect(proj, '重启后 120 s 内没连上项目流');
    // 5 造屏作业 failed(system)；Cart 的候选接管 current、带角标；Checkout（一版都没出）删掉；应用地图有 Cart 的连线
    const gj = (await apiJson<{ job: { status: string; output: { errorClass?: string } } }>(`/v1/jobs/${g.body.job.id}`)).body.job;
    check(gj.status === 'failed' && gj.output?.errorClass === 'system', `造屏作业应 failed(system)：${gj.status} ${gj.output?.errorClass}`);
    const after = await scrs();
    const cartNow = after.find((s) => s.name === 'Cart');
    const cands = (await apiJson<{ items: { id: string; candidateIndex: number | null }[] }>(`/v1/screens/${cart!.id}/revisions`)).body.items;
    const first = cands.find((c) => c.candidateIndex === 0)?.id;
    check(cartNow?.currentRevisionId === first && cartNow?.pendingCandidates?.count === 2, `Cart 的候选没有接管 current / 没有角标：current ${cartNow?.currentRevisionId ?? 'null'}，第 1 版 ${first}，角标 ${JSON.stringify(cartNow?.pendingCandidates)}`);
    check(!after.some((s) => s.name === 'Checkout'), 'Checkout 一版都没出，重启后仍留在画布上');
    const map = (await apiJson<{ edges: { fromScreenId: string; toScreenId: string | null }[] }>(`/v1/projects/${pid}/app-map`)).body;
    check(map.edges.some((e) => e.fromScreenId === cart!.id && e.toScreenId === s1), '应用地图没有 Cart → /s1 的连线（重启收尾没有重派生）');
    // 6 agent 作业补投 → 会话不在 → failed(agent)，/s2 的屏锁放开
    await eventually(async () => expect((await apiJson<{ job: { status: string } }>(`/v1/jobs/${agent.jobId}`)).body.job.status === 'failed', 'agent'), 10_000)
      .catch(async () => check(false, `queued 的 agent 作业重启后 10 s 仍是 ${(await apiJson<{ job: { status: string } }>(`/v1/jobs/${agent.jobId}`)).body.job.status}`));
    const free = await sendEdit(s2);
    check(free.status === 202, `重启后 /s2 仍被占着：${free.status} ${free.body.type ?? ''}`);
    if (free.body.job) await waitJob(free.body.job.id, 60);
    // 7 首轮补扫补上探针屏的截图，并推 screen_changed{screenshot:true}
    await eventually(async () => expect((await apiJson<{ items: { screenshotUrl: string | null }[] }>(`/v1/screens/${probed.screenId}/revisions`)).body.items[0]?.screenshotUrl, 'shot'), 30_000)
      .catch(() => check(false, '重启后 30 s 补扫没有补上探针屏的截图'));
    await eventually(() => expect(proj!.text.includes(probed.revisionId) && /"screenshot":true/.test(proj!.text), 'event'), 5000)
      .catch(() => check(false, `补扫补上截图后项目流没有 screen_changed{screenshot:true}（流里：${JSON.stringify(proj!.text.slice(-160))}）`));
  } finally {
    proj?.close();
    if (cid) await apiJson(`/v1/channels/${cid}`, { method: 'DELETE' }).catch(() => {});
    await stub.close(); await probe.close();
  }
  if (bad.length) { console.log(`   TC-CORE-068 全部失败项：\n   - ${bad.join('\n   - ')}`); throw new Error(bad.join('；')); }
  return '中途被杀的造屏：Cart 两版候选接管 current 并带角标、Checkout 删掉、地图有 Cart 连线；queued 的 agent 作业补投后 failed、屏锁放开；首轮补扫补上截图并推事件';
});
