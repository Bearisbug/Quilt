import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, apiJson, EVIDENCE, WEB, API } from './lib.ts';

// TC-CORE-006：供应商持续故障。前置：API/worker 以 LLM_DRIVER=stub LLM_STUB=503 启动。
const RUN = process.env.RUN ?? '001';
await mkdir(EVIDENCE, { recursive: true });
const health = await (await fetch(`${API}/v1/health`)).json() as { llm: string };
if (health.llm !== 'stub') { console.log('❌ TC-CORE-006 阻塞 worker 不是 stub 模式（当前 ' + health.llm + '）'); process.exit(2); }
seed('seed');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await openApp(page);
const demo = (await apiJson<{ items: { id: string; name: string }[] }>('/v1/projects')).body.items.find((p) => p.name === 'Demo Desktop')!;
// 种子按 .env 建了一条已验证的 Gemini 通道并成为缺省：发出去的这一轮改走 stub，否则打到的是真实模型而不是 503 桩
await page.route(/\/v1\/projects\/[^/]+\/messages$/, async (route) => {
  if (route.request().method() !== 'POST') return route.fallback();
  const body = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
  await route.continue({ postData: JSON.stringify({ ...body, runner: { kind: 'model', driver: 'stub', model: 'stub' } }) });
});
await page.goto(`${WEB}/p/${demo.id}`);
await page.fill('#chat-input', '做一个记账网站');
await page.keyboard.press('Enter');
const t0 = Date.now();
await page.getByText('造屏失败', { exact: false }).first().waitFor({ timeout: 60000 });
const secs = Math.round((Date.now() - t0) / 1000);
const jobs = (await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${demo.id}`)).body;
const msgs = (await apiJson<{ items: { role: string; content: string; jobId: string | null }[] }>(`/v1/projects/${demo.id}/messages`)).body.items;
const assistant = msgs.find((m) => m.role === 'assistant')!;
const job = (await apiJson<{ job: { status: string; output: { errorClass?: string } } }>(`/v1/jobs/${assistant.jobId}`)).body.job;
// 失败文案（DESIGN §14 v0.74）：按作业种类开头、写出 HTTP 状态与下一步，不带原始报文
const copyOk = assistant.content.startsWith('造屏失败：模型服务暂时不可用（HTTP 503）') && assistant.content.includes('重试') && !assistant.content.includes('stub 503');
const ok = job.status === 'failed' && job.output?.errorClass === 'provider' && jobs.activeJobs.length === 0 && copyOk;
await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-006.png`) });
console.log(`${ok ? '✅' : '❌'} TC-CORE-006 ${ok ? '通过' : '失败'} status=${job.status} errorClass=${job.output?.errorClass} ${secs}s 助手消息=「${assistant.content.slice(0, 60)}」`);
await browser.close();
