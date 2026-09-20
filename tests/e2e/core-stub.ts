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
await page.goto(`${WEB}/p/${demo.id}`);
await page.fill('#chat-input', '做一个记账网站');
await page.keyboard.press('Enter');
const t0 = Date.now();
await page.getByText('生成失败', { exact: false }).first().waitFor({ timeout: 60000 });
const secs = Math.round((Date.now() - t0) / 1000);
const jobs = (await apiJson<{ activeJobs: unknown[] }>(`/v1/projects/${demo.id}`)).body;
const msgs = (await apiJson<{ items: { role: string; content: string; jobId: string | null }[] }>(`/v1/projects/${demo.id}/messages`)).body.items;
const assistant = msgs.find((m) => m.role === 'assistant')!;
const job = (await apiJson<{ job: { status: string; output: { errorClass?: string } } }>(`/v1/jobs/${assistant.jobId}`)).body.job;
const ok = job.status === 'failed' && job.output?.errorClass === 'provider' && jobs.activeJobs.length === 0;
await page.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-core-006.png`) });
console.log(`${ok ? '✅' : '❌'} TC-CORE-006 ${ok ? '通过' : '失败'} status=${job.status} errorClass=${job.output?.errorClass} ${secs}s 助手消息=「${assistant.content.slice(0, 60)}」`);
await browser.close();
