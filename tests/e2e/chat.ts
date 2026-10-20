import { seed, seedJson, apiJson } from './lib.ts';
import { suite, expect, waitJob, LIVE_LLM } from './harness.ts';

// docs/TEST.md TC-CORE-039（聊天作业接口，REQ-CORE-023）AI 执行脚本：界面不提供聊天（v1.17），这条只走接口。
// 真实回合走「本机 Claude 订阅」通道（Agent SDK），要本机 claude 已登录；LIVE_LLM=0 只跑校验与串行守卫。
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-sonnet-5';
const { step, summary } = suite('CHAT');
type Job = { id: string; kind: string; status: string; output: Record<string, unknown> | null };
type Detail = { screens: { id: string; name: string; route: string; currentRevisionId: string }[]; activeJobs: { id: string; kind: string }[] };
const detail = (id: string) => apiJson<Detail>(`/v1/projects/${id}`).then((r) => r.body);
type Message = { role: string; content: string; jobId: string | null; affectedScreenIds: string[] };
const messages = (id: string) => apiJson<{ items: Message[] }>(`/v1/projects/${id}/messages?limit=100`).then((r) => r.body.items);
const revision = async (screenId: string, revId: string) => { const r = await apiJson<{ revision: { htmlUrl: string; sourceKind: string; jobId: string | null } }>(`/v1/screens/${screenId}/revisions/${revId}`); return { ...r.body.revision, html: await (await fetch(r.body.revision.htmlUrl)).text() }; };
const send = (pid: string, body: Record<string, unknown>) => apiJson<{ job: Job; type?: string }>(`/v1/projects/${pid}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });

seed('seed');

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

  const tok = (j: Job) => `${j.output?.tokensIn ?? '?'}/${j.output?.tokensOut ?? '?'}`;
  return `两轮回合成功，token 进/出：${tok(j1)}、${tok(j2)}；回执「${(m2?.content ?? '').slice(0, 60).replace(/\n/g, ' ')}」`;
});

summary();
