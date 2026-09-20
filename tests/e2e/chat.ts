import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, apiJson, EVIDENCE, WEB } from './lib.ts';

// docs/TEST.md TC-CORE-039（聊天模式，REQ-CORE-023）AI 执行脚本。
// 真实回合走「本机 Claude 订阅」通道（Agent SDK），要本机 claude 已登录；LIVE_LLM=0 只跑校验与串行守卫。
const RUN = process.env.RUN ?? '092';
const LIVE_LLM = process.env.LIVE_LLM !== '0';
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-sonnet-5';
await mkdir(EVIDENCE, { recursive: true });
const results: { tc: string; result: string; note: string }[] = [];
let page: import('playwright').Page;
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : result === '失败' ? '❌' : '⏭'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); record(tc, '通过', note ?? ''); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}.png`) }).catch(() => {}); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 300)); await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-${tc.toLowerCase()}-fail.png`) }).catch(() => {}); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
type Job = { id: string; kind: string; status: string; output: Record<string, unknown> | null };
const waitJob = async (jobId: string, maxSec: number): Promise<Job> => {
  for (let i = 0; i < maxSec / 3; i++) { await new Promise((r) => setTimeout(r, 3000)); const { body } = await apiJson<{ job: Job }>(`/v1/jobs/${jobId}`); if (['succeeded', 'failed', 'cancelled'].includes(body.job.status)) return body.job; }
  throw new Error('job timeout');
};
type Detail = { screens: { id: string; name: string; route: string; currentRevisionId: string }[]; activeJobs: { id: string; kind: string }[] };
const detail = (id: string) => apiJson<Detail>(`/v1/projects/${id}`).then((r) => r.body);
type Message = { role: string; content: string; jobId: string | null; affectedScreenIds: string[] };
const messages = (id: string) => apiJson<{ items: Message[] }>(`/v1/projects/${id}/messages?limit=100`).then((r) => r.body.items);
const revision = async (screenId: string, revId: string) => { const r = await apiJson<{ revision: { htmlUrl: string; sourceKind: string; jobId: string | null } }>(`/v1/screens/${screenId}/revisions/${revId}`); return { ...r.body.revision, html: await (await fetch(r.body.revision.htmlUrl)).text() }; };
const send = (pid: string, body: Record<string, unknown>) => apiJson<{ job: Job; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });

seed('seed');
const browser = await launch();
page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await openApp(page);

await step('TC-CORE-039', async () => {
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Chat', '--device', 'mobile', '--screens', '2', '--no-shot');
  const pid = r.projectId; const [s1, s2] = r.screens;
  // 1. 通道校验：非 Claude 通道 400；一条 agent-sdk 通道都没有时缺省也 400
  const bad = await send(pid, { content: '你好', mode: 'chat', runner: { kind: 'model', driver: 'gemini', model: 'gemini-3.7-flash' } });
  expect(bad.status === 400 && bad.body.type === '/errors/validation' && JSON.stringify(bad.body).includes('"runner"'), `非 Claude 通道该 400 path=runner：${bad.status} ${JSON.stringify(bad.body).slice(0, 200)}`);
  const none = await send(pid, { content: '你好', mode: 'chat' });
  expect(none.status === 400 && JSON.stringify(none.body).includes('本机 Claude 订阅'), `没有 agent-sdk 通道该 400 并点名：${none.status} ${JSON.stringify(none.body).slice(0, 200)}`);
  // 建一条本机 Claude 订阅通道并验证（探测会真的拉起 claude，冷启动 3~15 s）
  const ch = await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'agent-sdk', vendor: 'claude-subscription', label: '本机 Claude', model: CHAT_MODEL }) });
  expect(ch.status === 201, `建通道失败：${ch.status} ${JSON.stringify(ch.body).slice(0, 200)}`);
  const probe = await apiJson<{ ok: boolean; error?: string }>(`/v1/runners/channel:${ch.body.channel.id}/probe`, { method: 'POST' });
  expect(probe.body.ok, `本机 Claude 订阅通道验证失败：${probe.body.error}`);
  const runner = { kind: 'channel', channelId: ch.body.channel.id };
  // 4. 串行守卫：项目里已有在跑的 chat 作业 → 409 screen-busy
  const busy = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--kind', 'chat', '--input', JSON.stringify({ prompt: 'x' }));
  const conflict = await send(pid, { content: '再说一句', mode: 'chat', runner });
  expect(conflict.status === 409 && conflict.body.type === '/errors/screen-busy', `在跑 chat 作业期间该 409 screen-busy：${conflict.status} ${JSON.stringify(conflict.body).slice(0, 200)}`);
  await apiJson(`/v1/jobs/${busy.jobId}/cancel`, { method: 'POST' });
  if (!LIVE_LLM) return '真实回合跳过（LIVE_LLM=0）；通道校验与串行守卫通过';

  // 2. 只问不改：回执点到屏、修订不动
  const before = await detail(pid);
  const q1 = await send(pid, { content: '这个项目现在有哪些屏？每张各是做什么的？只回答，不要改任何东西。', mode: 'chat', runner });
  expect(q1.status === 202 && q1.body.job.kind === 'chat', `第一轮该 202 kind=chat：${q1.status} ${JSON.stringify(q1.body).slice(0, 200)}`);
  const j1 = await waitJob(q1.body.job.id, 420);
  expect(j1.status === 'succeeded', `第一轮作业 ${j1.status}：${JSON.stringify(j1.output).slice(0, 300)}`);
  const m1 = (await messages(pid)).find((m) => m.jobId === q1.body.job.id && m.role === 'assistant');
  expect(m1?.content && /Screen 1|\/s1/i.test(m1.content) && /Screen 2|\/s2/i.test(m1.content), `助手回执没点到两屏：${m1?.content?.slice(0, 200)}`);
  const after1 = await detail(pid);
  expect(before.screens.every((s) => after1.screens.find((x) => x.id === s.id)?.currentRevisionId === s.currentRevisionId), '只问不改却动了屏');
  expect((m1?.affectedScreenIds ?? []).length === 0, `只问不改的回执不该有受影响屏：${JSON.stringify(m1?.affectedScreenIds)}`);

  // 3. 跨轮指代 + 改一屏：修订记在聊天作业名下，另一屏不动
  const q2 = await send(pid, { content: '把刚才说的第一张屏（/s1）的标题改成「Hello Chat」，其他都别动。', mode: 'chat', runner });
  expect(q2.status === 202, `第二轮该 202：${q2.status} ${JSON.stringify(q2.body).slice(0, 200)}`);
  const j2 = await waitJob(q2.body.job.id, 600);
  expect(j2.status === 'succeeded', `第二轮作业 ${j2.status}：${JSON.stringify(j2.output).slice(0, 300)}`);
  const after2 = await detail(pid);
  const s1Before = before.screens.find((s) => s.id === s1.id)!; const s2Before = before.screens.find((s) => s.id === s2.id)!;
  const s1After = after2.screens.find((s) => s.id === s1.id)!; const s2After = after2.screens.find((s) => s.id === s2.id)!;
  expect(s1After.currentRevisionId !== s1Before.currentRevisionId, '第一屏没出新修订');
  expect(s2After.currentRevisionId === s2Before.currentRevisionId, '第二屏被动了');
  const rev = await revision(s1.id, s1After.currentRevisionId);
  expect(rev.sourceKind === 'agent_ingest' && rev.jobId === q2.body.job.id, `新修订来源 / 作业不对：${rev.sourceKind} ${rev.jobId}`);
  expect(rev.html.includes('Hello Chat'), '新修订里没有 Hello Chat');
  const m2 = (await messages(pid)).find((m) => m.jobId === q2.body.job.id && m.role === 'assistant');
  expect(m2?.content && JSON.stringify(m2.affectedScreenIds) === JSON.stringify([s1.id]), `第二轮回执 / 受影响屏不对：${m2?.content?.slice(0, 120)} ${JSON.stringify(m2?.affectedScreenIds)}`);

  // 5. 画布：段控切聊天 → 档位隐藏、动词行、通道只列本机 Claude 订阅；发一句看在跑作业行与回执；刷新后模式记忆
  await page.goto(`${WEB}/p/${pid}`);
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await page.getByTestId('mode-chat').click();
  expect((await page.getByTestId('count-group').count()) === 0 && (await page.getByTestId('versions-group').count()) === 0, '聊天模式不该显示屏数 / 版数档位');
  expect((await page.getByTestId('verb-line').innerText()).includes('聊 · 整个项目'), `动词行不对：${await page.getByTestId('verb-line').innerText()}`);
  expect((await page.getByTestId('runner-select').getAttribute('data-value')) === `channel:${ch.body.channel.id}`, `聊天模式没自动落到本机 Claude 订阅通道：${await page.getByTestId('runner-select').getAttribute('data-value')}`);
  await page.getByTestId('runner-select').click();
  const list = page.getByRole('listbox'); await list.waitFor({ timeout: 5000 });
  const opts = await list.getByRole('option').count();
  await page.keyboard.press('Escape'); await list.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  expect(opts === 2, `聊天模式下拉应只列 1 条通道 + 管理入口，实际 ${opts} 项`);
  await page.locator('#chat-input').fill('第二张屏（/s2）是做什么的？只回答，别改。');
  await page.keyboard.press('Enter');
  const row = page.locator('[data-testid="running-job"]').first();
  await row.waitFor({ timeout: 10000 });
  expect((await row.innerText()).includes('聊「'), `在跑作业行没按聊天口径写：${await row.innerText()}`);
  const { body: jobs } = await apiJson<{ items: Job[] }>(`/v1/projects/${pid}/jobs?limit=1`);
  const j3 = await waitJob(jobs.items[0].id, 420);
  expect(j3.status === 'succeeded', `画布发的回合 ${j3.status}：${JSON.stringify(j3.output).slice(0, 300)}`);
  const m3 = (await messages(pid)).find((m) => m.jobId === j3.id && m.role === 'assistant');
  const head = (m3?.content ?? '').slice(0, 12);
  await page.locator('[data-testid="chat-dock"] [role="log"]').getByText(head, { exact: false }).first().waitFor({ timeout: 10000 });
  await page.reload();
  await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  expect((await page.getByTestId('mode-chat').getAttribute('aria-checked')) === 'true', '刷新后聊天模式没记住');
  const tok = (j: Job) => `${j.output?.tokensIn ?? '?'}/${j.output?.tokensOut ?? '?'}`;
  return `三轮回合成功，token 进/出：${tok(j1)}、${tok(j2)}、${tok(j3)}；回执「${(m2?.content ?? '').slice(0, 60).replace(/\n/g, ' ')}」`;
});

await browser.close();
console.log(JSON.stringify({ run: RUN, results }, null, 2));
