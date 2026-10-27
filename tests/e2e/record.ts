import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import type { RecordingDto } from '@quilt/core';
import { launch, seed, seedJson, apiJson, assertTestApi, EVIDENCE, WEB, API, eventually } from './lib.ts';
import { startOpenAiStub, type StubHit } from './openai-stub.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { suite, expect, softly, waitJob, sleep, restartApi, Skip } from './harness.ts';

// docs/TEST.md CORE 域 · 本机使用记录（REQ-CORE-047；设计文档 v1.22 / v1.24，TC-CORE-144～149）AI 执行脚本。
// 库里的行经 docker 里的 quilt-pg 查（按 /v1/health 的库名）；对象目录与 records/ 按被测栈 /v1/config 的 home；
// API 日志按 scripts/e2e-stack.sh 的布局在 home 的上一级（.e2e/<lane>/api.log）。每条用例结束都关掉开关、恢复目录权限。
// 桩通道用 3955～3958，别的套件没用它们
await assertTestApi();
await mkdir(EVIDENCE, { recursive: true });
let page: Page | undefined;
const { step, summary, cleanups } = suite('RECORD', { page: () => page });

type Seeded = { projectId: string; screens: { id: string; route: string }[] };
type Problem = { type: string; title: string; status: number };
type Ev = { seq: number; at: string; page: string; type: string; target?: string; data?: Record<string, unknown> };
const VIEWPORT = { width: 1440, height: 900 };
const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

seed('seed');
const browser = await launch();
const health = (await apiJson<{ database?: string }>('/v1/health')).body;
const psql = (q: string) => execFileSync('docker', ['exec', 'quilt-pg', 'psql', '-U', 'quilt', '-d', health.database ?? '', '-Atc', q], { encoding: 'utf8' }).trim();
try { psql('select 1'); } catch (e) { throw new Error(`环境：连不上 docker 里的 quilt-pg，核不了记录（${(e as Error).message.split('\n')[0]}）`); }
const HOME = (await apiJson<{ home: string }>('/v1/config')).body.home;
const OBJECTS = path.join(HOME, 'objects');
const RECORDS = path.join(OBJECTS, 'records');
const LOG = path.resolve(HOME, '..', 'api.log');
const demoId = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Mobile')!.id;
const userId = psql(`select id from users where email = 'local@quilt.local'`);

const recording = async () => (await apiJson<RecordingDto>('/v1/record')).body;
const setRecording = async (enabled: boolean) => { const r = await apiJson<RecordingDto>('/v1/record', { method: 'PATCH', body: JSON.stringify({ enabled }) }); expect(r.status === 200 && r.body.enabled === enabled, `PATCH /v1/record ${enabled} → ${r.status}`); return r.body; };
const countOf = (table: string, where = 'true') => Number(psql(`select count(*) from ${table} where ${where}`));
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const exists = (p: string) => stat(p).then(() => true, () => false);
// 目录下的全部文件（相对路径）；目录不存在时空
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(path.relative(dir, p)); } };
  await walk(dir);
  return out.sort();
}
// 本机时区的自然日（与服务端 recordDay 同一口径：同一台机器）
const recordDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// 只读：去掉写权限造「写不进去」；恢复时整棵树加回写权限
const readOnly = (dir: string) => { execFileSync('chmod', ['-R', 'a-w', dir]); cleanups.push(async () => { execFileSync('chmod', ['-R', 'u+w', dir]); }); };
// API 日志：从现在起新写的部分
const logMark = async () => { if (!(await exists(LOG))) throw new Error(`环境：找不到被测 API 的日志 ${LOG}（按 scripts/e2e-stack.sh 的布局在 home 的上一级）`); return (await stat(LOG)).size; };
const logSince = async (mark: number) => (await readFile(LOG)).subarray(mark).toString('utf8');
// 每条用例都以关掉开关收尾
const offAfter = () => cleanups.push(() => setRecording(false));
const ev = (seq: number, extra: Partial<Ev> = {}): Ev => ({ seq, at: new Date(Date.UTC(2026, 9, 1, 1, 2, seq)).toISOString(), page: 'canvas', type: 'click', target: `e2e-${seq}`, ...extra });
const postEvents = (sessionId: string, events: Ev[], headers: Record<string, string> = {}) => apiJson<Problem | null>('/v1/record/events', { method: 'POST', headers, body: JSON.stringify({ sessionId, events }) });

// OpenAI 兼容桩通道：单屏规划回一屏（每次一个新路由），其余回一屏 HTML；记下每次的回复（与 hits 一一对应）。broken() 为真时回 503
async function stubChannel(port: number, label: string, broken: () => boolean = () => false) {
  const key = `good-key-${port}`;
  let n = 0;
  const replies: string[] = [];
  const stub = startOpenAiStub({
    port, apiKey: key, fail: () => (broken() ? 503 : null),
    reply: (hit: StubHit) => {
      const text = hit.user.includes('Requested screen:')
        ? JSON.stringify({ name: `Login ${++n}`, route: `/login-${port}-${n}`, purpose: 'sign in', links: [], sections: ['form'], entryFrom: null })
        : `<div class="min-h-dvh bg-background p-6"><h1 class="text-xl font-semibold">Login ${port}</h1><button type="button" class="mt-4 h-12 px-6 rounded-full bg-primary text-on-primary">Sign in</button></div>`;
      replies.push(text);
      return text;
    },
  });
  let id = '';
  cleanups.push(async () => { if (id) await apiJson(`/v1/channels/${id}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  id = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label, endpoint: stub.url, model: `stub-${port}`, apiKey: key }) })).body.channel.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${id}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
  return { stub, replies, channelId: id, runner: { kind: 'channel', channelId: id } };
}
// 从别处发一轮造 1 屏，等它结束
async function generateOne(projectId: string, runner: unknown) {
  const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: '做一个登录页', runner }) });
  expect(r.status === 202, `造屏 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return waitJob(r.body.job.id, 120);
}
async function openContext(opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, ...opts });
  cleanups.push(() => ctx.close());
  const pg = await ctx.newPage();
  page = pg;
  return { ctx, pg };
}
const openCanvas = async (pg: Page, projectId: string, query = '') => {
  await pg.goto(`${WEB}/p/${projectId}${query}`);
  await pg.getByTestId('open-settings').waitFor({ timeout: 15000 });
};
const toggleState = (pg: Page) => pg.getByTestId('record-toggle').getAttribute('aria-checked');
async function fakeSession(name: string) {
  const DIR = process.env.QUILT_CLAUDE_SESSIONS_DIR ?? '';
  if (!DIR) throw new Skip('未设 QUILT_CLAUDE_SESSIONS_DIR（API 与本脚本都要以同一目录启动，§3）');
  const { startFakeSession } = await import('./agent-stub.ts');
  const fake = await startFakeSession({ dir: DIR, name, nameSource: 'user' });
  cleanups.push(() => fake.close());
  await sleep(2100); // 服务端会话列表缓存 2 s
  return fake;
}

// TC-CORE-144 使用记录开关与状态（REQ-CORE-047；API-CORE-049、API-CORE-050）
await step('TC-CORE-144', async () => {
  // 前置：库里的开关是关的、没有任何记录（种子不清使用记录，这里清：两张表、开关与起始时间、对象目录下的 records/）
  psql(`update users set record_usage = false, record_since = null; delete from record_events; delete from model_calls;`);
  await rm(RECORDS, { recursive: true, force: true });
  offAfter();
  const S = softly();
  // 1 GET /v1/record：关着、没开过、三个计数 0、dir 是本机绝对路径
  const r1 = await apiJson<RecordingDto>('/v1/record');
  await S.check(() => expect(r1.status === 200 && r1.body.enabled === false && r1.body.since === null && r1.body.events === 0 && r1.body.modelCalls === 0 && r1.body.archived === 0, `① 应 200 { enabled:false, since:null } 且计数都是 0：${r1.status} ${JSON.stringify(r1.body)}`));
  await S.check(() => expect(r1.body.dir === RECORDS && path.isAbsolute(r1.body.dir ?? ''), `① dir 应是本机绝对路径 ${RECORDS}：${r1.body.dir}`));
  // 2 在「系统」里打开：发出 PATCH {enabled:true}，开关显示开，since 是刚才，多一条 type=record，两行写条数、占用与位置
  const { pg } = await openContext();
  await openCanvas(pg, demoId, '?settings=system');
  await pg.getByTestId('record-toggle').waitFor({ timeout: 10000 });
  await S.check(async () => expect((await toggleState(pg)) === 'false', `② 打开前开关应是关的：${await toggleState(pg)}`));
  const records0 = countOf('record_events', `type = 'record'`);
  const t0 = Date.now();
  const sent = pg.waitForResponse((q) => new URL(q.url()).pathname === '/v1/record' && q.request().method() === 'PATCH', { timeout: 5000 });
  await pg.getByTestId('record-toggle').click();
  const body = (await sent).request().postDataJSON() as { enabled?: unknown };
  await S.check(() => expect(JSON.stringify(body) === '{"enabled":true}', `② 应发出 PATCH /v1/record {enabled:true}：${JSON.stringify(body)}`));
  await S.check(() => eventually(async () => expect((await toggleState(pg)) === 'true', `② 开关应显示开：${await toggleState(pg)}`), 5000));
  const r2 = await recording();
  const since2 = r2.since ? Date.parse(r2.since) : 0;
  await S.check(() => expect(r2.enabled && since2 >= t0 - 1000 && since2 <= Date.now() + 1000, `② since 应是刚才的时间：${r2.since}`));
  await S.check(() => expect(countOf('record_events', `type = 'record'`) === records0 + 1, `② record_events 应多一条 type=record：${records0} → ${countOf('record_events', `type = 'record'`)}`));
  await S.check(async () => { const t = (await pg.getByTestId('record-stats').innerText()).replace(/\s+/g, ' '); expect(/已记 [\d,]+ 条操作 · [\d,]+ 次模型调用 · [\d,]+ 份归档 · 占用 /.test(t) && t.includes('起'), `② 应写条数、占用与起始时间：${t}`); });
  await S.check(async () => expect((await pg.getByTestId('record-dir').innerText()).includes(RECORDS), `② 应写存放位置 ${RECORDS}：${await pg.getByTestId('record-dir').innerText()}`));
  // 3 enabled 不是布尔：400，开关不变
  const r3 = await apiJson<Problem>('/v1/record', { method: 'PATCH', body: JSON.stringify({ enabled: 'yes' }) });
  await S.check(async () => expect(r3.status === 400 && r3.body.type === '/errors/validation' && (await recording()).enabled === true, `③ {enabled:"yes"} 应 400 /errors/validation、开关不变：${r3.status} ${r3.body.type}`));
  // 4 名单外来源：三个端点都 403，开关与条数不变
  const evil = { Origin: 'http://evil.example', 'Content-Type': 'application/json' };
  const evilSession = `evil-${crypto.randomUUID()}`;
  const forbidden = [
    await fetch(`${API}/v1/record`, { headers: evil }),
    await fetch(`${API}/v1/record`, { method: 'PATCH', headers: evil, body: JSON.stringify({ enabled: false }) }),
    await fetch(`${API}/v1/record/events`, { method: 'POST', headers: evil, body: JSON.stringify({ sessionId: evilSession, events: [ev(1)] }) }),
  ];
  const types = await Promise.all(forbidden.map(async (r) => `${r.status} ${((await r.json()) as Problem).type}`));
  await S.check(() => expect(types.every((t) => t === '403 /errors/forbidden'), `④ 名单外来源应都是 403 /errors/forbidden：${types.join(' ｜ ')}`));
  await S.check(async () => expect((await recording()).enabled === true && countOf('record_events', `session_id = ${sq(evilSession)}`) === 0, '④ 403 之后开关应仍开着、那一批不该写进去'));
  // 5 界面上关掉：enabled=false、since 不变；条数与位置两行照样显示
  await pg.getByTestId('record-toggle').click();
  await S.check(() => eventually(async () => expect((await toggleState(pg)) === 'false' && (await recording()).enabled === false, '⑤ 关掉后开关与接口都应是关'), 5000));
  const r5 = await recording();
  await S.check(() => expect(r5.since === r2.since, `⑤ 关掉不该改 since：${r2.since} → ${r5.since}`));
  await S.check(async () => expect(await pg.getByTestId('record-stats').isVisible() && await pg.getByTestId('record-dir').isVisible(), '⑤ 关掉后条数与位置两行应照样显示'));
  // 6 再打开：since 换成新的时间
  await sleep(1100);
  await pg.getByTestId('record-toggle').click();
  await S.check(() => eventually(async () => { const r = await recording(); expect(r.enabled && !!r.since && Date.parse(r.since) > since2, `⑥ 再打开 since 应换成新的时间：${r2.since} → ${r.since}`); }, 5000));
  S.done();
  return `开 → since ${r2.since}；400 / 403 不动开关；关掉 since 不变、两行照显；再开 since 换新`;
});

// TC-CORE-145 事件批的写入：开关、去重与上限（REQ-CORE-047；API-CORE-051）
await step('TC-CORE-145', async () => {
  offAfter();
  const S = softly();
  const session = () => `e2e-${crypto.randomUUID()}`;
  const rows = (s: string) => countOf('record_events', `session_id = ${sq(s)}`);
  // 1 开关关着：204、不写
  await setRecording(false);
  const s0 = session();
  const r1 = await postEvents(s0, [ev(1), ev(2), ev(3)]);
  await S.check(() => expect(r1.status === 204 && rows(s0) === 0, `① 关着时应 204 且不写：${r1.status}，写了 ${rows(s0)} 条`));
  // 2 打开后 seq 1～3：204、多 3 条，source=web、user_id 是默认用户、at 是请求里给的
  await setRecording(true);
  const s1 = session();
  const batch = [ev(1), ev(2), ev(3)];
  const r2 = await postEvents(s1, batch);
  const got = psql(`select seq, source, user_id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from record_events where session_id = ${sq(s1)} order by seq`).split('\n').filter(Boolean);
  const want = batch.map((e) => [e.seq, 'web', userId, e.at].join('|'));
  await S.check(() => expect(r2.status === 204 && JSON.stringify(got) === JSON.stringify(want), `② 应 204 且写 3 条 source=web、默认用户、at 照给的：${r2.status} ${JSON.stringify(got)}`));
  // 3 原样重发：204、不重复
  const r3 = await postEvents(s1, batch);
  await S.check(() => expect(r3.status === 204 && rows(s1) === 3, `③ 重发应 204 且条数不变：${r3.status}，${rows(s1)} 条`));
  // 4 201 条、单条超过 16 KB、type 不在枚举里：400，整批不写
  const bad: [string, Ev[]][] = [
    ['201 条', Array.from({ length: 201 }, (_, i) => ev(i + 1))],
    ['单条超过 16 KB', [ev(1), ev(2, { data: { value: 'x'.repeat(17 * 1024) } }), ev(3)]],
    ['type 不在枚举里', [ev(1), ev(2, { type: 'bogus' }), ev(3)]],
  ];
  for (const [what, events] of bad) {
    const s = session();
    const r = await postEvents(s, events);
    await S.check(() => expect(r.status === 400 && (r.body as Problem).type === '/errors/validation' && rows(s) === 0, `④ ${what}应 400 /errors/validation 且整批不写：${r.status} ${JSON.stringify(r.body).slice(0, 120)}，写了 ${rows(s)} 条`));
  }
  // 5 data 里有 2500 字的字符串：写进去的只有长度
  const s5 = session();
  const r5 = await postEvents(s5, [ev(1, { type: 'input', data: { value: '字'.repeat(2500) } })]);
  const data5 = psql(`select data::text from record_events where session_id = ${sq(s5)}`);
  await S.check(() => expect(r5.status === 204 && JSON.parse(data5 || '{}').value === 2500 && !data5.includes('字'), `⑤ 2500 字的字符串应只记长度：${r5.status} ${data5.slice(0, 120)}`));
  // 6 关掉后另一个 sessionId：204、不写
  await setRecording(false);
  const s6 = session();
  const r6 = await postEvents(s6, [ev(1), ev(2)]);
  await S.check(() => expect(r6.status === 204 && rows(s6) === 0, `⑥ 关掉后应 204 且不写：${r6.status}，写了 ${rows(s6)} 条`));
  S.done();
  return '关着丢弃、开着写 3 条且去重、三种超限 400 整批不写、长串只记长度';
});

// TC-CORE-146 浏览器采集：点击、输入、断线重发与密钥框（REQ-CORE-047；API-CORE-051 浏览器端）
await step('TC-CORE-146', async () => {
  offAfter();
  const S = softly();
  // 前置：开关开着；输入框要能发出去：stub 栈没有可用的云端模型，建一条验证过的桩通道（§3），它是新打开页面的缺省
  await stubChannel(3955, 'Rec 桩');
  await setRecording(true);
  const { pg } = await openContext();
  await openCanvas(pg, demoId);
  await pg.getByTestId('composer-input').waitFor({ timeout: 10000 });
  await sleep(1000); // 页面启动时取一次开关，开着才挂监听
  const sessionOf = (target: string, after: string) => psql(`select session_id from record_events where source = 'web' and target = ${sq(target)} and at >= ${sq(after)} order by id desc limit 1`);
  const eventsOf = (s: string) => psql(`select seq || '|' || type || '|' || coalesce(target, '') || '|' || coalesce(data->>'value', '') from record_events where session_id = ${sq(s)} order by seq`).split('\n').filter(Boolean).map((l) => { const [seq, type, target, value] = l.split('|'); return { seq: Number(seq), type, target, value }; });
  // 1 点「屏列表」；打字、停 2 s；发送 → 10 s 内依次有这次点击、全文快照、发送
  const active = (await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${demoId}`)).body.activeJobs.length;
  expect(active === 0, `① 发送前不该有在跑的作业：${active} 个`);
  const t1 = new Date().toISOString();
  await pg.getByTestId('toggle-screens').click();
  await pg.getByTestId('composer-input').click();
  await pg.getByTestId('composer-input').pressSequentially('做一个登录页', { delay: 60 });
  await sleep(2000);
  await pg.getByTestId('composer-send').click();
  let session = '';
  await S.check(() => eventually(() => {
    session = sessionOf('toggle-screens', t1);
    expect(session, '① 10 s 内没有「屏列表」的点击');
    const evs = eventsOf(session);
    const i = evs.findIndex((e) => e.type === 'click' && e.target === 'toggle-screens');
    const j = evs.findIndex((e, k) => k > i && e.type === 'input' && e.value === '做一个登录页');
    const k = evs.findIndex((e, n) => n > j && e.type === 'click' && e.target === 'composer-send');
    expect(i >= 0 && j > i && k > j, `① 应依次有「屏列表」的点击、「做一个登录页」的快照与发送：${JSON.stringify(evs.slice(-8))}`);
  }, 10000, 500));
  // 2 「添加模型」里的 API Key 填 sk-test-SECRET-123 再取消：整张表里搜不到
  await pg.getByTestId('open-settings').click();
  await pg.getByTestId('settings-tab-models').click();
  await pg.getByTestId('add-channel').click();
  const dlg = pg.getByTestId('channel-dialog');
  await dlg.waitFor({ timeout: 5000 });
  await pg.locator('#ch-key').pressSequentially('sk-test-SECRET-123', { delay: 30 });
  await sleep(1800);
  await dlg.getByRole('button', { name: '取消' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 5000 });
  await pg.keyboard.press('Escape');
  await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(6000);
  await S.check(() => expect(countOf('record_events r', `r::text like '%SECRET-123%'`) === 0, '② record_events 里不该有 SECRET-123'));
  // 3 发事件的请求连不上时点 3 下；放开后这 3 次写进库，同一 sessionId 的 seq 从 1 起连续
  const EVENTS = /\/v1\/record\/events/;
  await pg.route(EVENTS, (route) => route.abort('connectionrefused'));
  const t3 = new Date().toISOString();
  for (let i = 0; i < 3; i++) { await pg.getByTestId('toggle-screens').click(); await sleep(200); }
  await sleep(6000);
  const clicks3 = () => countOf('record_events', `session_id = ${sq(session)} and type = 'click' and target = 'toggle-screens' and at >= ${sq(t3)}`);
  await S.check(() => expect(clicks3() === 0, `③ 连不上时不该写进去：${clicks3()} 条`));
  await pg.unroute(EVENTS);
  await S.check(() => eventually(() => expect(clicks3() === 3, `③ 放开后这 3 次点击应写进库：${clicks3()} 条`), 12000, 500));
  const seqs = eventsOf(session).map((e) => e.seq);
  await S.check(() => expect(seqs.length > 0 && seqs.every((s, i) => s === i + 1), `③ seq 应从 1 起连续：共 ${seqs.length} 条，缺号 ${JSON.stringify(seqs.filter((s, i) => s !== i + 1).slice(0, 5))}`));
  // 4 设置里关掉开关，再点 3 下：之后没有新的点击
  await pg.getByTestId('open-settings').click();
  await pg.getByTestId('settings-tab-system').click();
  await pg.getByTestId('record-toggle').waitFor({ timeout: 10000 });
  await pg.getByTestId('record-toggle').click();
  await eventually(async () => expect((await recording()).enabled === false, '④ 开关没关掉'), 5000);
  await pg.keyboard.press('Escape');
  await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  const t4 = new Date().toISOString();
  for (let i = 0; i < 3; i++) { await pg.getByTestId('toggle-screens').click(); await sleep(200); }
  await sleep(6000);
  await S.check(() => expect(countOf('record_events', `session_id = ${sq(session)} and type = 'click' and at >= ${sq(t4)}`) === 0, '④ 关掉后不该再有点击事件'));
  S.done();
  return `会话 ${session.slice(0, 8)}：点击、快照、发送依次写入；密钥不进记录；断线后补发 seq 连续 1～${seqs.length}；关掉后不再记`;
});

// TC-CORE-147 模型调用的记录（REQ-CORE-047；ENT-ModelCall）
await step('TC-CORE-147', async () => {
  offAfter();
  const S = softly();
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Rec', '--device', 'mobile', '--screens', '1', '--no-shot');
  const good = await stubChannel(3956, 'Rec 记录');
  let broken = false;
  const bad = await stubChannel(3957, 'Rec 报错', () => broken);
  broken = true;
  await setRecording(true);
  type Call = { purpose: string; ok: boolean; error: string | null; attempts: number; body_key: string };
  const callsOf = (jobId: string) => JSON.parse(psql(`select coalesce(json_agg(json_build_object('purpose', purpose, 'ok', ok, 'error', error, 'attempts', attempts, 'body_key', body_key) order by seq), '[]') from model_calls where job_id = ${sq(jobId)}`)) as Call[];
  type Body = { system: string | null; prompt: string; response: string | null; attempts: unknown[] };
  const bodyOf = async (c: Call) => JSON.parse(await readFile(path.join(OBJECTS, c.body_key), 'utf8')) as Body;
  // 1 造 1 屏：model_calls 至少一行，正文里有发给模型的完整提示词与原始回复
  const from = good.stub.hits.length;
  const j1 = await generateOne(projectId, good.runner);
  expect(j1.status === 'succeeded', `① 造屏 ${j1.status}：${JSON.stringify(j1.output).slice(0, 200)}`);
  const c1 = callsOf(j1.id);
  await S.check(() => expect(c1.length >= 1 && c1.length === good.stub.hits.length - from, `① model_calls 应有这次作业的每次调用：${c1.length} 行，桩收到 ${good.stub.hits.length - from} 次`));
  for (const c of c1) await S.check(async () => {
    const b = await bodyOf(c);
    const i = good.stub.hits.findIndex((h, k) => k >= from && h.user === b.prompt && h.system === b.system);
    expect(i >= 0 && b.response === good.replies[i], `① ${c.purpose} 的正文应是发给模型的完整提示词与原始回复：提示词 ${b.prompt.length} 字${i < 0 ? '（桩没收到这样的请求）' : ''}，回复 ${String(b.response).slice(0, 60)}`);
  });
  // 2 会报错的模型：作业失败，那一行带错误与重试次数
  const j2 = await generateOne(projectId, bad.runner);
  const c2 = callsOf(j2.id);
  await S.check(async () => {
    expect(j2.status === 'failed', `② 作业应失败：${j2.status}`);
    const f = c2.find((c) => !c.ok);
    expect(f && f.error && f.error.includes('503') && f.attempts >= 2 && (await bodyOf(f)).attempts.length === f.attempts, `② 失败的那一行应带错误与重试次数：${JSON.stringify(c2)}`);
  });
  // 3 交给本机会话（假会话）：一行 purpose=agent，正文是投递出去的那段指令
  await S.check(async () => {
    const fake = await fakeSession('Rec 会话');
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: 'HANG 改成深色', targetScreenIds: [screens[0].id], runner: { kind: 'agent', tool: 'claude-code', sessionId: fake.sessionId } }) });
    expect(r.status === 202, `③ 交给本机会话 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    try {
      await eventually(() => expect(fake.received.length === 1, '③ 假会话没收到投递'), 15000, 250);
      await eventually(() => expect(callsOf(r.body.job.id).length === 1, '③ 投递没记进 model_calls'), 5000, 250);
      const [c] = callsOf(r.body.job.id);
      expect(c.purpose === 'agent' && (await bodyOf(c)).prompt === fake.received[0], `③ 应一行 purpose=agent、正文是投递的指令：${c.purpose}`);
    } finally { await apiJson(`/v1/jobs/${r.body.job.id}/cancel`, { method: 'POST' }); }
  });
  // 4 records/ 只读时造 1 屏：作业照常成功，API 日志记一行
  await S.check(async () => {
    const mark = await logMark();
    await mkdir(RECORDS, { recursive: true });
    readOnly(RECORDS);
    const j4 = await generateOne(projectId, good.runner);
    expect(j4.status === 'succeeded', `④ records/ 只读时作业应照常成功：${j4.status}`);
    await eventually(async () => expect((await logSince(mark)).includes(`[record] 模型调用 ${j4.id}`), `④ API 日志里没有这次作业的记录失败：${(await logSince(mark)).split('\n').filter((l) => l.includes('[record]')).slice(0, 3).join(' ｜ ') || '没有 [record] 行'}`), 5000, 250);
    execFileSync('chmod', ['-R', 'u+w', RECORDS]);
  });
  // 5 关掉开关再造 1 屏：model_calls 不再增加
  await setRecording(false);
  const before = countOf('model_calls');
  const j5 = await generateOne(projectId, good.runner);
  await S.check(() => expect(j5.status === 'succeeded' && countOf('model_calls') === before, `⑤ 关掉后 model_calls 不该增加：${before} → ${countOf('model_calls')}`));
  S.done();
  return `造屏 ${c1.length} 次调用的正文与桩一致；失败带 ${c2.find((c) => !c.ok)?.attempts} 次尝试；投递记 agent；写不进去不挡作业；关掉不记`;
});

// TC-CORE-148 MCP 调用的记录（REQ-CORE-047；API-AGENT-002）
await step('TC-CORE-148', async () => {
  offAfter();
  const S = softly();
  await setRecording(true);
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const tools = () => countOf('record_events', `source = 'mcp' and type = 'tool'`);
  const lastTool = () => JSON.parse(psql(`select data::text from record_events where source = 'mcp' and type = 'tool' order by id desc limit 1`) || '{}') as { tool?: string; ok?: boolean; ms?: unknown; args?: Record<string, unknown> };
  // 1 quilt.list_projects：多一行，带工具名、成败与耗时
  const n0 = tools();
  const r1 = await callTool(mcp, 'quilt.list_projects', {});
  const d1 = lastTool();
  await S.check(() => expect(!r1.isError && tools() === n0 + 1 && d1.tool === 'quilt.list_projects' && d1.ok === true && typeof d1.ms === 'number', `① 应多一行 source=mcp、type=tool，带工具名、成败与耗时：${tools() - n0} 行 ${JSON.stringify(d1)}`));
  // 2 quilt.validate_screen 的 html 是 3000 字：这一行的 html 只有长度
  const html = `<div class="p-6">${'a'.repeat(3000 - 23)}</div>`;
  expect(html.length === 3000, `html 应 3000 字：${html.length}`);
  await callTool(mcp, 'quilt.validate_screen', { projectId: demoId, html });
  const d2 = lastTool();
  await S.check(() => expect(d2.tool === 'quilt.validate_screen' && d2.args?.html === 3000 && d2.args?.projectId === demoId, `② html 应只记长度 3000：${JSON.stringify(d2).slice(0, 200)}`));
  // 3 关掉开关再调：不再增加
  await setRecording(false);
  const n3 = tools();
  await callTool(mcp, 'quilt.list_projects', {});
  await S.check(() => expect(tools() === n3, `③ 关掉后不该再记：${n3} → ${tools()}`));
  S.done();
  return 'MCP 调用记工具名、成败与耗时；长 html 只记长度；关掉不记';
});

// TC-CORE-149 删除时留归档（REQ-CORE-047；API-CORE-018、API-CORE-031）
await step('TC-CORE-149', async () => {
  offAfter();
  const S = softly();
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Arch', '--device', 'mobile', '--screens', '3');
  const byRoute = (r: string) => screens.find((s) => s.route === r)!.id;
  await setRecording(true);
  const day = recordDay();
  const archiveDir = (name: string) => path.join(RECORDS, 'archive', day, name);
  const manifestOf = async (name: string) => JSON.parse(await readFile(path.join(archiveDir(name), 'manifest.json'), 'utf8')) as { revisions?: { htmlKey: string; screenshotKey: string | null }[] };
  const base = `projects/${projectId}/`;
  // 1 删 /s3：清单与这屏每个修订的 HTML、截图
  const s3 = byRoute('/s3');
  const shots = psql(`select count(*) filter (where screenshot_key is null) from screen_revisions where screen_id = ${sq(s3)}`);
  expect(shots === '0', `前置：/s3 的修订应都有截图（种子拍图失败时看 Tailwind CDN）：${shots} 个没有`);
  const d1 = await apiJson(`/v1/screens/${s3}`, { method: 'DELETE' });
  await S.check(async () => {
    expect(d1.status === 204, `① 删 /s3 应 204：${d1.status}`);
    const m = await manifestOf(`screen-${s3}`);
    const keys = (m.revisions ?? []).flatMap((r) => [r.htmlKey, r.screenshotKey]);
    expect(keys.length >= 2 && keys.every(Boolean), `① 清单里应有这屏的修订与截图键：${JSON.stringify(m.revisions).slice(0, 200)}`);
    const missing = []; for (const k of keys) if (!(await exists(path.join(archiveDir(`screen-${s3}`), k!.slice(base.length))))) missing.push(k);
    expect(missing.length === 0, `① 归档里缺这些文件：${missing.join(', ')}`);
  });
  // 2 草稿本里的新草稿生成中取消：空草稿删掉，records/archive/ 下多一份它的归档
  await S.check(async () => {
    const sb = (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId;
    const ids = async () => (await apiJson<{ screens: { id: string }[] }>(`/v1/projects/${sb}`)).body.screens.map((s) => s.id);
    const before = await ids();
    const held = await apiJson<{ job: { id: string } }>(`/v1/projects/${sb}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: '一张慢慢出来的卡片\n[stub-hold:6000]', runner: STUB }) });
    expect(held.status === 202, `② 出新草稿 ${held.status}`);
    let draft = '';
    await eventually(async () => { draft = (await ids()).find((id) => !before.includes(id)) ?? ''; expect(draft, '② 新草稿的屏行还没建出来'); }, 10000, 200);
    expect((await apiJson(`/v1/jobs/${held.body.job.id}/cancel`, { method: 'POST' })).status === 200, '② 取消失败');
    await eventually(async () => expect(!(await ids()).includes(draft), '② 取消后空草稿应删掉'), 15000, 300);
    await eventually(() => exists(path.join(archiveDir(`screen-${draft}`), 'manifest.json')).then((ok) => expect(ok, `② records/archive/${day}/screen-${draft}/ 下应有清单`)), 5000, 250);
  });
  // 3 records/archive/ 只读时删 /s2：照常 204，API 日志记一行归档失败
  await S.check(async () => {
    const s2 = byRoute('/s2');
    const mark = await logMark();
    await mkdir(path.join(RECORDS, 'archive', day), { recursive: true });
    readOnly(path.join(RECORDS, 'archive'));
    const d3 = await apiJson(`/v1/screens/${s2}`, { method: 'DELETE' });
    execFileSync('chmod', ['-R', 'u+w', path.join(RECORDS, 'archive')]);
    expect(d3.status === 204, `③ 归档写不进去时删除应照常 204：${d3.status}`);
    await eventually(async () => expect((await logSince(mark)).includes(`[record] 归档 screen-${s2}`), `③ API 日志里没有这屏的归档失败：${(await logSince(mark)).split('\n').filter((l) => l.includes('[record]')).slice(0, 3).join(' ｜ ') || '没有 [record] 行'}`), 5000, 250);
  });
  // 4 删项目 Arch：清单与 projects/<id>/ 的全部对象
  const objs = await filesUnder(path.join(OBJECTS, 'projects', projectId));
  const d4 = await apiJson(`/v1/projects/${projectId}`, { method: 'DELETE' });
  await S.check(async () => {
    expect(d4.status === 204 && objs.length > 0, `④ 删项目应 204：${d4.status}（删前 ${objs.length} 个对象）`);
    const got = await filesUnder(archiveDir(`project-${projectId}`));
    const missing = objs.filter((f) => !got.includes(f));
    expect(got.includes('manifest.json') && missing.length === 0, `④ 项目归档应有清单与全部 ${objs.length} 个对象：缺 ${missing.slice(0, 5).join(', ')}${got.includes('manifest.json') ? '' : '；没有清单'}`);
    const surfaces = ((await manifestOf(`project-${projectId}`)) as { surfaces?: { projectId: string }[] }).surfaces ?? [];
    expect(surfaces.length >= 1 && surfaces.every((x) => x.projectId === projectId), `④ 项目清单里应带这个项目的端：${JSON.stringify(surfaces).slice(0, 200)}`);
  });
  // 5 关掉开关，另建一个项目再删：不留归档
  await setRecording(false);
  const other = seedJson<Seeded>('seed:project', '--name', 'Arch2', '--device', 'mobile', '--screens', '1', '--no-shot');
  const d5 = await apiJson(`/v1/projects/${other.projectId}`, { method: 'DELETE' });
  await S.check(async () => expect(d5.status === 204 && !(await exists(archiveDir(`project-${other.projectId}`))), `⑤ 开关关着删项目不该留归档：${d5.status}`));
  // 6 触发一次 storage.gc（重启后 1 分钟先扫一轮；拿一份拨旧的导出确认它真扫过）：records/ 下的文件一个不少
  await S.check(async () => {
    const probe = seedJson<Seeded>('seed:project', '--name', 'GcProbe', '--device', 'mobile', '--screens', '1', '--no-shot');
    cleanups.push(() => apiJson(`/v1/projects/${probe.projectId}`, { method: 'DELETE' }));
    const ex = await apiJson<{ job: { id: string } }>(`/v1/projects/${probe.projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'export_prototype', input: {} }) });
    expect((await waitJob(ex.body.job.id, 90)).status === 'succeeded', '⑥ 导出没成功');
    const exportFile = path.join(OBJECTS, 'projects', probe.projectId, 'exports', `${ex.body.job.id}.html`);
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(exportFile, old, old);
    const kept = await filesUnder(RECORDS);
    await restartApi();
    await eventually(async () => expect(!(await exists(exportFile)), 'gc'), 150_000, 2000).catch(() => { throw new Error('⑥ 重启 2.5 分钟内 storage.gc 没扫过（拨旧的导出还在）'); });
    const now = await filesUnder(RECORDS);
    const lost = kept.filter((f) => !now.includes(f));
    expect(kept.length > 0 && lost.length === 0, `⑥ storage.gc 之后 records/ 下少了 ${lost.length} 个文件：${lost.slice(0, 5).join(', ')}（之前 ${kept.length} 个）`);
  });
  // 7 删一端（v1.52）：清单带端的行、这一端的屏与修订，对象是这些屏的前缀
  await S.check(async () => {
    await setRecording(true);
    const p7 = seedJson<Seeded>('seed:project', '--name', 'ArchSurface', '--device', 'mobile', '--screens', '1', '--no-shot');
    cleanups.push(() => apiJson(`/v1/projects/${p7.projectId}`, { method: 'DELETE' }));
    const add = await apiJson<{ surface: { id: string } }>(`/v1/projects/${p7.projectId}/surfaces`, { method: 'POST', body: JSON.stringify({ name: '后台', deviceType: 'desktop' }) });
    expect(add.status === 201, `⑦ 加一端 ${add.status}`);
    const sid = add.body.surface.id;
    const mcp = await connectMcp();
    cleanups.push(() => mcp.close());
    const made = await callTool(mcp, 'quilt.create_screen', { projectId: p7.projectId, surfaceId: sid, name: '概览', route: '/dashboard', html: '<main class="p-8"><h1 class="text-2xl">概览</h1></main>' });
    expect(!made.isError, `⑦ create_screen：${made.text.slice(0, 200)}`);
    const screenId = (made.json as { screenId: string }).screenId;
    const d7 = await apiJson(`/v1/surfaces/${sid}`, { method: 'DELETE' });
    expect(d7.status === 204, `⑦ 删端应 204：${d7.status}`);
    const m = (await manifestOf(`surface-${sid}`)) as { kind?: string; surface?: { id: string }; screens?: { id: string }[]; revisions?: { htmlKey: string }[] };
    expect(m.kind === 'surface' && m.surface?.id === sid && m.screens?.length === 1 && m.screens[0].id === screenId && (m.revisions?.length ?? 0) >= 1, `⑦ 端的清单应带端的行、这一屏与修订：${JSON.stringify(m).slice(0, 300)}`);
    const missing = []; for (const r of m.revisions ?? []) if (!(await exists(path.join(archiveDir(`surface-${sid}`), r.htmlKey.slice(`projects/${p7.projectId}/`.length))))) missing.push(r.htmlKey);
    expect(missing.length === 0, `⑦ 归档里缺这屏的 HTML：${missing.join(', ')}`);
  });
  S.done();
  return `删屏、空草稿、删项目、删端都留归档；写不进去照常删；关着不留；gc 不碰 records/`;
});

const counts = summary();
await browser.close();
process.exit(counts['失败'] ? 1 : 0);
