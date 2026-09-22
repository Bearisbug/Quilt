import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seed, seedJson, apiJson, EVIDENCE, API } from './lib.ts';
import { connectMcp, callTool } from './mcp-client.ts';

// docs/TEST.md TC-AGENT-011（MCP 与画布同面，REQ-AGENT-002 v0.51）AI 执行脚本。纯 MCP / REST，不开浏览器。
// 作业类工具只验「作业输入与 API-CORE-006 同义 + 终态」，模型行为由各自用例覆盖——API 以 LLM_DRIVER=stub 启动即可全程跑完。
// 可用 QUILT_E2E_API 指到独立端口上的一套 API（配 DATABASE_URL=…quilt_test），不占用 3100 上的开发实例。
const RUN = process.env.RUN ?? '099';
await mkdir(EVIDENCE, { recursive: true });
const health = await (await fetch(`${API}/v1/health`)).json() as { llm: string };
if (health.llm !== 'stub') { console.log(`❌ TC-AGENT-011 阻塞：API 不是 stub 驱动（当前 ${health.llm}），作业类步骤要确定性驱动`); process.exit(2); }
const results: { tc: string; result: string; note: string }[] = [];
const record = (tc: string, result: string, note = '') => { results.push({ tc, result, note }); console.log(`${result === '通过' ? '✅' : '❌'} ${tc} ${result} ${note}`); };
const step = async (tc: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); record(tc, '通过', note ?? ''); }
  catch (e) { record(tc, '失败', (e as Error).message.split('\n')[0].slice(0, 400)); }
};
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OK_HTML = `<div class="min-h-dvh flex flex-col bg-background text-on-background"><header class="h-14 flex items-center justify-between px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">Agent screen</h1></header><main class="flex-1 overflow-y-auto px-4 py-6 space-y-6"><div class="bg-surface rounded-lg border border-outline-variant p-4"><p class="text-sm">Pushed by an external agent.</p><a href="/s1" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Back home</a></div></main></div>`;
// 1×1 PNG：素材与参考图直传都用它（类型按魔数认定，尺寸不重要）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_PATH = path.join(os.tmpdir(), 'quilt-e2e-logo.png');
const FAKE = '00000000-0000-4000-8000-000000000000';

type Job = { id: string; kind: string; status: string; input: Record<string, unknown>; output: Record<string, unknown> | null };
type Screen = { id: string; name: string; route: string; x: number; y: number; currentRevisionId: string | null };
type Detail = { project: { exemplarScreenId: string | null }; screens: Screen[]; components: { id: string; name: string; version: number; x: number; y: number }[]; designSystem: { version: number; designMd: string; seedColor: string } };

seed('seed');
await writeFile(PNG_PATH, PNG);
const mcp = await connectMcp();
const NEW_TOOLS = ['delete_screen', 'delete_component', 'delete_project', 'get_revision', 'restore_revision', 'list_candidates', 'adopt_candidate', 'adopt_candidates', 'move_screens', 'edit_element', 'regenerate_subtree', 'edit_component', 'propose_design_system', 'export_prototype', 'get_export', 'list_runners', 'create_attachment_upload_url', 'list_jobs', 'cancel_job', 'get_job_events', 'list_assets', 'create_asset', 'delete_asset', 'list_design_presets', 'create_design_preset', 'apply_design_preset', 'delete_design_preset', 'list_annotations', 'update_annotation', 'delete_annotation', 'send_annotations', 'list_messages'].map((t) => `quilt.${t}`);
// 工具调用助手：成功要 JSON、失败要错误类型
const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown>, what = name): Promise<T> => { const r = await callTool(mcp, name, args); expect(!r.isError, `${what} 出错：${r.text.slice(0, 300)}`); return r.json as T; };
const fail = async (name: string, args: Record<string, unknown>, type: string, what = name) => { const r = await callTool(mcp, name, args); expect(r.isError, `${what} 应失败（${type}），实际成功：${r.text.slice(0, 200)}`); const t = (r.json as { type?: string }).type; expect(t === type, `${what} 应 ${type}，实际 ${t}：${r.text.slice(0, 200)}`); };
const detail = async (pid: string) => call<Detail>('quilt.get_project', { projectId: pid });
const waitJob = async (jobId: string, maxSec = 60): Promise<Job> => { for (let i = 0; i < maxSec * 2; i++) { const j = await call<Job>('quilt.get_job', { jobId }); if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j; await sleep(500); } throw new Error(`作业 ${jobId.slice(0, 8)} ${maxSec} s 内未结束`); };
const revisionsOf = async (screenId: string) => call<{ id: string; seq: number; sourceKind: string; jobId: string | null; candidateIndex: number | null }[]>('quilt.list_revisions', { screenId });

await step('TC-AGENT-011', async () => {
  const notes: string[] = [];
  const r = seedJson<{ projectId: string; screens: { id: string; route: string }[] }>('seed:project', '--name', 'Parity', '--device', 'mobile', '--screens', '3', '--no-shot');
  const pid = r.projectId; const [s1, s2, s3] = r.screens.map((s) => s.id);
  const footer = (await apiJson<{ component: { id: string; version: number } }>(`/v1/projects/${pid}/components`, { method: 'POST', body: JSON.stringify({ name: 'Footer', html: '<footer class="p-4 text-sm">Footer</footer>' }) })).body.component;

  // 1 工具面：54 个工具、7 类资源；list_runners 不含密钥
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  const missing = NEW_TOOLS.filter((t) => !tools.includes(t));
  expect(missing.length === 0, `缺工具：${missing.join(',')}`);
  expect(tools.length === 54, `工具数应为 54，实际 ${tools.length}`);
  const resources = (await mcp.listResourceTemplates()).resourceTemplates.length;
  expect(resources === 7, `资源模板应为 7 类，实际 ${resources}`);
  const runnersRaw = await callTool(mcp, 'quilt.list_runners', {});
  expect(!runnersRaw.isError && Array.isArray((runnersRaw.json as { items: unknown[] }).items) && !runnersRaw.text.includes('"apiKey"'), `list_runners 不对：${runnersRaw.text.slice(0, 200)}`);
  notes.push(`${tools.length} 工具 / ${resources} 资源`);

  // 2 推屏回归（原 TC-AGENT-003 / 004 的 MCP 部分）+ delete_screen
  const val = await call<{ violations: unknown[] }>('quilt.validate_screen', { projectId: pid, html: OK_HTML });
  expect(val.violations.length === 0, `validate 有违规 ${JSON.stringify(val.violations).slice(0, 200)}`);
  const created = await call<{ screenId: string; revisionId: string }>('quilt.create_screen', { projectId: pid, name: 'Agent 屏', route: '/agent', html: OK_HTML });
  const agent = created.screenId; const rev1 = created.revisionId;
  const html1 = await callTool(mcp, 'quilt.get_screen', { screenId: agent });
  expect(html1.text.includes('data-qid="q1"') && html1.text.includes('--color-primary'), '未注入 qid / prelude');
  let shot = false;
  for (let i = 0; i < 20 && !shot; i++) { await sleep(1000); shot = !!(await callTool(mcp, 'quilt.get_screenshot', { screenId: agent })).image; }
  expect(shot, '20 s 内截图未就绪');
  const bad = await call<{ screenId: string; lintReport?: { violations: unknown[] } }>('quilt.create_screen', { projectId: pid, name: 'Bad', route: '/bad', html: OK_HTML.replace('bg-primary', 'bg-[#123456]') });
  expect((bad.lintReport?.violations.length ?? 0) > 0, '违规 HTML 应照常写入并带偏离报告');
  await call('quilt.delete_screen', { screenId: bad.screenId });
  expect((await detail(pid)).screens.length === 4 && !(await detail(pid)).screens.some((s) => s.route === '/bad'), '删屏后屏数应回到 4 且 /bad 不在');
  notes.push('推屏 / 截图 / 删屏');

  // 3 修订：update_screen 只传 html；get_revision 给旧版 HTML；restore_revision 回溯；旧基线 409
  const up = await call<{ revisionId: string }>('quilt.update_screen', { projectId: pid, screenId: agent, html: OK_HTML.replace('Agent screen', 'Agent screen v2'), expectedRevisionId: rev1 });
  const sAgent = (await detail(pid)).screens.find((s) => s.id === agent)!;
  expect(sAgent.name === 'Agent 屏' && sAgent.route === '/agent' && sAgent.currentRevisionId === up.revisionId, 'update_screen 不传 name / route 应沿用当前值并推进 current');
  const old = await call<{ revision: { seq: number }; html: string }>('quilt.get_revision', { screenId: agent, revisionId: rev1 });
  expect(old.revision.seq === 1 && old.html.includes('Agent screen') && !old.html.includes('v2'), 'get_revision 应给第 1 版 HTML');
  const restored = await call<{ revision: { id: string; sourceKind: string } }>('quilt.restore_revision', { screenId: agent, revisionId: rev1, expectedRevisionId: up.revisionId });
  expect(restored.revision.sourceKind === 'restore', `回溯应产生 restore 修订：${restored.revision.sourceKind}`);
  expect((await detail(pid)).screens.find((s) => s.id === agent)!.currentRevisionId === restored.revision.id, '回溯后 current 未变');
  await fail('quilt.restore_revision', { screenId: agent, revisionId: rev1, expectedRevisionId: rev1 }, '/errors/revision-conflict', '旧基线回溯');
  notes.push('修订取 / 回溯 / 旧基线 409');

  // 4 候选：edit_screens × 2 版 → list_candidates → adopt_candidate 第 2 版 → adopt_candidates 不存在的 index 全部 skipped
  const cand = await call<Job>('quilt.edit_screens', { projectId: pid, screenIds: [agent], prompt: 'make it blue', versions: 2 });
  expect(cand.kind === 'edit_screens' && (cand.input.versions as number) === 2, `edit_screens 作业不对：${JSON.stringify(cand.input)}`);
  expect((await waitJob(cand.id)).status === 'succeeded', 'edit_screens × 2 版未成功');
  const cands = await call<{ screens: { screenId: string; currentRevisionId: string; settled: boolean; revisions: { id: string; index: number }[] }[] }>('quilt.list_candidates', { jobId: cand.id });
  expect(cands.screens.length === 1 && cands.screens[0].revisions.length === 2 && !cands.screens[0].settled, `候选应 1 屏 × 2 版未结清：${JSON.stringify(cands).slice(0, 200)}`);
  const second = cands.screens[0].revisions.find((x) => x.index === 1)!;
  const adopted = await call<{ screen: Screen }>('quilt.adopt_candidate', { screenId: agent, revisionId: second.id });
  expect(adopted.screen.currentRevisionId === second.id, '采用后 current 应指向第 2 版');
  expect((await call<{ screens: { settled: boolean }[] }>('quilt.list_candidates', { jobId: cand.id })).screens[0].settled, '采用后该批应结清');
  const group = await call<{ adopted: string[]; skipped: string[] }>('quilt.adopt_candidates', { jobId: cand.id, index: 3 });
  expect(group.adopted.length === 0 && group.skipped[0] === agent, `不存在的 index 应全部 skipped：${JSON.stringify(group)}`);
  notes.push('候选列 / 采用 / 整组跳过');

  // 5 摆放：2 屏 + 1 组件一次摆好，假 id 逐张报错不拖累其余；组件只挪位置不升版
  const mv = await call<{ moved: { screens: string[]; components: string[] }; failed: { id: string; error: string }[] }>('quilt.move_screens', { screens: [{ id: s1, x: 100, y: 200 }, { id: s2, x: 600, y: 200 }], components: [{ id: footer.id, x: -300, y: 0 }, { id: FAKE, x: 0, y: 0 }] });
  expect(mv.moved.screens.length === 2 && mv.moved.components.length === 1 && mv.failed.length === 1 && mv.failed[0].id === FAKE && mv.failed[0].error === '/errors/not-found', `move_screens 结果不对：${JSON.stringify(mv)}`);
  const d5 = await detail(pid);
  expect(d5.screens.find((s) => s.id === s1)!.x === 100 && d5.screens.find((s) => s.id === s2)!.x === 600, '屏位置未落库');
  const f5 = d5.components.find((c) => c.id === footer.id)!;
  expect(f5.x === -300 && f5.version === footer.version, `组件应只挪位置不升版：${JSON.stringify(f5)}`);
  notes.push('摆放逐张成败');

  // 6 元素直改：零 token 落 manual 修订；旧基线 409
  const cur6 = (await detail(pid)).screens.find((s) => s.id === agent)!.currentRevisionId!;
  const ed = await call<{ revision: { id: string; sourceKind: string } }>('quilt.edit_element', { screenId: agent, qid: 'q1', ops: [{ type: 'text', value: 'Edited by MCP' }], expectedRevisionId: cur6 });
  expect(ed.revision.sourceKind === 'manual', `直改应落 manual 修订：${ed.revision.sourceKind}`);
  expect((await callTool(mcp, 'quilt.get_screen', { screenId: agent })).text.includes('Edited by MCP'), '直改文案未落到当前 HTML');
  await fail('quilt.edit_element', { screenId: agent, qid: 'q1', ops: [{ type: 'text', value: 'again' }], expectedRevisionId: cur6 }, '/errors/revision-conflict', '旧基线直改');
  notes.push('直改');

  // 7 参考图直传 + 素材：签名 PUT 落对象；create_asset 读本机文件；预览域可取；相对路径 400、不存在 404；删素材
  const upl = await call<{ attachmentId: string; putUrl: string }>('quilt.create_attachment_upload_url', { projectId: pid, mediaType: 'image/png', bytes: PNG.length });
  expect(upl.putUrl.startsWith(API), `putUrl 应是绝对地址：${upl.putUrl}`);
  const put = await fetch(upl.putUrl, { method: 'PUT', body: PNG });
  expect(put.status === 204, `参考图直传应 204，实际 ${put.status}`);
  const asset = (await call<{ asset: { id: string; name: string; url: string; mediaType: string } }>('quilt.create_asset', { projectId: pid, path: PNG_PATH, name: 'Logo' })).asset;
  expect(asset.mediaType === 'image/png' && asset.url.includes(`/a/${pid}/${asset.id}`), `素材不对：${JSON.stringify(asset)}`);
  expect((await call<{ items: { id: string }[] }>('quilt.list_assets', { projectId: pid })).items.some((a) => a.id === asset.id), 'list_assets 缺新素材');
  expect((await call<{ assets: { name: string }[] }>('quilt.get_design_contract', { projectId: pid })).assets.some((a) => a.name === 'Logo'), '设计契约 assets[] 缺新素材');
  const previewGet = await fetch(asset.url.replace('preview.localhost', '127.0.0.1'));
  expect(previewGet.status === 200 && (previewGet.headers.get('content-type') ?? '').includes('image/png'), `预览域取素材应 200 image/png，实际 ${previewGet.status} ${previewGet.headers.get('content-type')}`);
  await fail('quilt.create_asset', { projectId: pid, path: 'relative.png' }, '/errors/validation', '相对路径');
  await fail('quilt.create_asset', { projectId: pid, path: '/nonexistent/quilt-e2e-missing.png' }, '/errors/not-found', '不存在的文件');
  await call('quilt.delete_asset', { assetId: asset.id });
  expect(!(await call<{ items: { id: string }[] }>('quilt.list_assets', { projectId: pid })).items.some((a) => a.id === asset.id), '删素材后仍在列表');
  notes.push('参考图直传 / 素材建取删');

  // 8 作业：造（anchor + 参考图 + 组件上下文）、懒生成、子树重生成、提炼、AI 改组件、导出 + 下载、列表 / 事件 / 取消、通道校验
  const gen = await call<Job>('quilt.generate_screens', { projectId: pid, prompt: 'Onboarding flow', count: 2, anchor: { x: 5000, y: 0 }, attachmentIds: [upl.attachmentId], componentIds: [footer.id] });
  expect(gen.kind === 'generate' && (gen.input.anchor as { x: number }).x === 5000 && (gen.input.imageKeys as string[]).length === 1 && (gen.input.componentIds as string[])[0] === footer.id, `generate 作业输入不对：${JSON.stringify(gen.input)}`);
  const genDone = await waitJob(gen.id, 120);
  expect(genDone.status === 'succeeded', `generate ${genDone.status}：${JSON.stringify(genDone.output).slice(0, 200)}`);
  const d8 = await detail(pid);
  expect(d8.screens.some((s) => s.x === 5000 - 195 && s.y === 0 - 422), `锚点是首屏中心：应有一屏落在 (4805, −422)：${d8.screens.map((s) => `${s.route}@${s.x}`).join(' ')}`);
  const lazy = await call<Job>('quilt.generate_screens', { projectId: pid, prompt: 'settings page', route: '/settings', name: 'Settings', fromScreenId: s1 });
  expect(lazy.input.route === '/settings' && lazy.input.fromScreenId === s1, `懒生成作业输入不对：${JSON.stringify(lazy.input)}`);
  expect((await waitJob(lazy.id, 120)).status === 'succeeded', '懒生成未成功');
  expect((await detail(pid)).screens.some((s) => s.route === '/settings' && s.name === 'Settings'), '懒生成的 /settings 屏不在');
  const cur8 = (await detail(pid)).screens.find((s) => s.id === s1)!.currentRevisionId!;
  const sub = await call<Job>('quilt.regenerate_subtree', { screenId: s1, qid: 'q1', prompt: 'make the header bigger', expectedRevisionId: cur8 });
  expect(sub.kind === 'regenerate_subtree' && sub.input.qid === 'q1', `子树作业不对：${JSON.stringify(sub.input)}`);
  expect((await waitJob(sub.id, 120)).status === 'succeeded', '子树重生成未成功');
  expect((await revisionsOf(s1))[0].sourceKind === 'subtree', 's1 最新修订应为 subtree');
  const prop = await call<Job>('quilt.propose_design_system', { projectId: pid, instruction: 'body text 16px everywhere', screenId: s1 });
  expect(prop.kind === 'propose_design_system' && prop.input.instruction === 'body text 16px everywhere', `提炼作业不对：${JSON.stringify(prop.input)}`);
  const propDone = await waitJob(prop.id, 120);
  await fail('quilt.edit_component', { componentId: footer.id, prompt: 'add the year', runner: { kind: 'agent', tool: 'claude-code', sessionId: FAKE } }, '/errors/validation', '改组件带本机会话');
  const ec = await call<Job>('quilt.edit_component', { componentId: footer.id, prompt: 'add the year' });
  expect(ec.kind === 'edit_component' && ec.input.componentId === footer.id, `改组件作业不对：${JSON.stringify(ec.input)}`);
  const ecDone = await waitJob(ec.id, 120);
  const exp = await call<Job>('quilt.export_prototype', { projectId: pid });
  expect(exp.kind === 'export_prototype', `导出作业 kind ${exp.kind}`);
  expect((await waitJob(exp.id, 120)).status === 'succeeded', '导出未成功');
  const dl = await call<{ url: string; bytes: number }>('quilt.get_export', { jobId: exp.id });
  const file = await fetch(dl.url);
  const body = await file.text();
  expect(file.status === 200 && dl.bytes > 0 && body.includes('Screen 1') && body.includes('/settings'), `导出下载不对：${file.status} ${dl.bytes} B`);
  await fail('quilt.get_export', { jobId: sub.id }, '/errors/job-not-finished', '非导出作业取下载');
  const jobs = await call<{ items: Job[] }>('quilt.list_jobs', { projectId: pid });
  expect(jobs.items.some((j) => j.id === exp.id) && jobs.items.some((j) => j.id === gen.id), 'list_jobs 缺作业');
  const events = await call<{ items: { seq: number; type: string }[] }>('quilt.get_job_events', { jobId: exp.id });
  expect(events.items.length > 0 && events.items[events.items.length - 1].type === 'succeeded' && events.items.every((e, i) => i === 0 || e.seq > events.items[i - 1].seq), `事件不对：${JSON.stringify(events).slice(0, 200)}`);
  expect((await call<{ items: unknown[] }>('quilt.get_job_events', { jobId: exp.id, after: events.items[events.items.length - 1].seq })).items.length === 0, 'after=末尾 seq 应为空');
  const running = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--status', 'running');
  expect((await call<{ job: Job }>('quilt.cancel_job', { jobId: running.jobId })).job.status === 'cancelled', '取消后应 cancelled');
  await fail('quilt.cancel_job', { jobId: running.jobId }, '/errors/job-finished', '重复取消');
  await fail('quilt.edit_screens', { projectId: pid, screenIds: [s1], prompt: 'x', runner: { kind: 'channel', channelId: FAKE } }, '/errors/not-found', '不属于自己的通道');
  notes.push(`作业：造(anchor) / 懒生成 / 子树 / 提炼→${propDone.status} / 改组件→${ecDone.status} / 导出 ${dl.bytes} B / 取消`);

  // 9 预设：存 → 按预设建项目 → 套用 + 回刷 → 版本过期 409 → 删
  const preset = (await call<{ preset: { id: string; seedColor: string } }>('quilt.create_design_preset', { projectId: pid, name: 'Brand' })).preset;
  expect((await call<{ items: { id: string }[] }>('quilt.list_design_presets', {})).items.some((p) => p.id === preset.id), 'list_design_presets 缺新预设');
  const fromPreset = await call<{ project: { id: string }; designSystem: { seedColor: string } }>('quilt.create_project', { name: 'FromPreset', deviceType: 'desktop', presetId: preset.id });
  expect(fromPreset.designSystem.seedColor.toUpperCase() === preset.seedColor.toUpperCase(), '按预设建的项目种子色应与预设一致');
  const v9 = (await call<{ version: number }>('quilt.get_design_contract', { projectId: pid })).version;
  const applied = await call<{ designSystem: { version: number }; job: Job | null }>('quilt.apply_design_preset', { projectId: pid, presetId: preset.id, expectedVersion: v9, applyToScreens: true });
  expect(applied.designSystem.version === v9 + 1 && applied.job?.kind === 'apply_design_system', `套用预设结果不对：${JSON.stringify(applied).slice(0, 200)}`);
  expect((await waitJob(applied.job!.id, 120)).status === 'succeeded', '套用后的回刷未成功');
  await fail('quilt.apply_design_preset', { projectId: pid, presetId: preset.id, expectedVersion: v9 }, '/errors/version-conflict', '过期版本套预设');
  await call('quilt.delete_design_preset', { presetId: preset.id });
  expect(!(await call<{ items: { id: string }[] }>('quilt.list_design_presets', {})).items.some((p) => p.id === preset.id), '删预设后仍在列表');
  notes.push('预设存 / 建项目 / 套用回刷 / 409 / 删');

  // 10 批注：列（项目内未处理 / 单屏全部）、改状态、发送成作业、删
  const mk = async (screenId: string, note: string) => (await apiJson<{ annotation: { id: string } }>(`/v1/screens/${screenId}/annotations`, { method: 'POST', body: JSON.stringify({ qid: 'q1', note, anchorText: 'Screen', rect: { x: 0, y: 0, w: 10, h: 10 } }) })).body.annotation.id;
  const a1 = await mk(s2, '改成蓝色'); const a2 = await mk(s3, '标题加粗');
  type Ann = { id: string; status: string };
  const open = (await call<{ items: Ann[] }>('quilt.list_annotations', { projectId: pid })).items;
  expect(open.some((a) => a.id === a1 && a.status === 'open') && open.some((a) => a.id === a2), 'list_annotations(projectId) 应列出两条 open');
  expect((await call<{ annotation: Ann }>('quilt.update_annotation', { annotationId: a1, status: 'resolved' })).annotation.status === 'resolved', '改状态未生效');
  expect(!(await call<{ items: Ann[] }>('quilt.list_annotations', { projectId: pid })).items.some((a) => a.id === a1), 'resolved 的批注不该出现在项目级未处理列表');
  expect((await call<{ items: Ann[] }>('quilt.list_annotations', { projectId: pid, screenId: s2 })).items.some((a) => a.id === a1 && a.status === 'resolved'), '单屏列表应含 resolved 的批注');
  const sent = await call<{ jobs: Job[] }>('quilt.send_annotations', { projectId: pid, annotationIds: [a2] });
  expect(sent.jobs.length === 1 && sent.jobs[0].kind === 'edit_screens' && (sent.jobs[0].input.screenIds as string[])[0] === s3, `发送批注应建 1 条 edit_screens：${JSON.stringify(sent).slice(0, 200)}`);
  expect((await waitJob(sent.jobs[0].id, 120)).status === 'succeeded', '批注作业未成功');
  expect((await call<{ items: Ann[] }>('quilt.list_annotations', { projectId: pid, screenId: s3 })).items.find((a) => a.id === a2)?.status === 'resolved', '作业成功后批注应 resolved');
  await call('quilt.delete_annotation', { annotationId: a1 });
  expect((await call<{ items: Ann[] }>('quilt.list_annotations', { projectId: pid, screenId: s2 })).items.length === 0, '删批注后单屏列表应为空');
  notes.push('批注列 / 改 / 发 / 删');

  // 11 项目与设计系统：样板屏（golden 资源跟着变）、空 patch 400、约定节写回、对话记录
  expect((await call<{ exemplarScreenId: string | null }>('quilt.update_project', { projectId: pid, exemplarScreenId: s2 })).exemplarScreenId === s2, '样板屏未落库');
  const golden = await mcp.readResource({ uri: `quilt://projects/${pid}/golden` });
  expect(String(golden.contents[0].text).includes('Screen 2'), 'golden 资源应是样板屏 s2 的正文');
  expect((await call<{ exemplarScreenId: string | null }>('quilt.update_project', { projectId: pid, exemplarScreenId: null })).exemplarScreenId === null, '样板屏应能回落');
  await fail('quilt.update_project', { projectId: pid }, '/errors/validation', '空 patch');
  const v11 = (await call<{ version: number }>('quilt.get_design_contract', { projectId: pid })).version;
  const ds = await call<{ designSystem: { designMd: string; version: number } }>('quilt.update_design_system', { projectId: pid, expectedVersion: v11, conventions: ['正文 16px', '按钮全圆角'] });
  expect(ds.designSystem.designMd.includes('## 约定') && ds.designSystem.designMd.includes('正文 16px') && ds.designSystem.designMd.includes('按钮全圆角') && ds.designSystem.version === v11 + 1, '约定节未写回');
  const msg = await apiJson<{ job: Job }>(`/v1/projects/${pid}/messages`, { method: 'POST', body: JSON.stringify({ content: '做一个记账 app', count: 2 }), headers: { 'Idempotency-Key': crypto.randomUUID() } });
  expect(msg.status === 202, `发消息应 202，实际 ${msg.status}`);
  await waitJob(msg.body.job.id, 120);
  const msgs = await call<{ items: { role: string; content: string; jobId: string | null }[]; nextCursor: string | null }>('quilt.list_messages', { projectId: pid, limit: 10 });
  expect(msgs.items.some((m) => m.role === 'user' && m.content === '做一个记账 app') && msgs.items.some((m) => m.role === 'assistant' && m.jobId === msg.body.job.id), `list_messages 缺这一轮：${JSON.stringify(msgs).slice(0, 200)}`);
  notes.push('样板屏 / 约定写回 / 对话记录');

  // 12 删组件、删项目：有在跑作业 409 project-busy，取消后级联删除；顺手删掉按预设建的项目
  await call('quilt.delete_component', { componentId: footer.id });
  expect((await detail(pid)).components.length === 0, '删组件后详情仍有组件');
  const busy = seedJson<{ jobId: string }>('seed:job', '--project', pid, '--status', 'running');
  await fail('quilt.delete_project', { projectId: pid }, '/errors/project-busy', '有在跑作业时删项目');
  await call('quilt.cancel_job', { jobId: busy.jobId });
  await call('quilt.delete_project', { projectId: pid });
  await call('quilt.delete_project', { projectId: fromPreset.project.id });
  const left = await call<{ id: string; name: string }[]>('quilt.list_projects', {});
  expect(!left.some((p) => p.name === 'Parity' || p.name === 'FromPreset'), '删项目后仍在列表');
  await fail('quilt.get_project', { projectId: pid }, '/errors/not-found', '删后取详情');
  notes.push('删组件 / 删项目 busy→409→cancel→删');
  return notes.join('；');
});

await mcp.close();
await rm(PNG_PATH, { force: true });
await writeFile(path.join(EVIDENCE, `run-${RUN}-tc-agent-011.txt`), results.map((x) => `${x.tc} ${x.result} ${x.note}`).join('\n') + '\n');
console.log(`\n=== RUN-${RUN} MCP ===`, JSON.stringify(results.reduce<Record<string, number>>((m, x) => ((m[x.result] = (m[x.result] ?? 0) + 1), m), {})));
console.log(results.map((x) => `${x.tc} ${x.result} ${x.note}`).join('\n'));
process.exit(results.some((x) => x.result === '失败') ? 1 : 0);
