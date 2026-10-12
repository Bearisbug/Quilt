import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, apiJson, EVIDENCE, WEB, API, eventually, pickOption, selectedValue } from '../lib.ts';
import { startOpenAiStub } from '../openai-stub.ts';
import { suite, expect } from '../harness.ts';

// docs/TEST.md CORE 域 AI 执行脚本的共用部分：浏览器与页面、脚手架、跨文件用到的辅助；用例按组分在同目录的几个文件里，由 ../core.ts 依次引入。
// 每条用例独立前置（种子构造），
// 输出「TC 结果 备注」，证据截图落 docs/test-runs/run-<RUN>-tc-core-NNN.png。执行者=人工 的用例登记「待人工」。
// v0.32 本地版无账号：TC-CORE-001 / 002 / 021（登录、过期链接、未登录守卫）随 REQ-CORE-001 推迟。
// 脚手架（step / record / 跳过 / 预期失败 / 单步时限）在 harness.ts；单步超时时换一个新页面，后面的用例照常跑
export let page: import('playwright').Page;
export const { RUN, results, cleanups, step, summary } = suite('CORE', {
  page: () => page,
  onTimeout: async () => { await page.close().catch(() => {}); page = await ctx.newPage(); page.on('pageerror', (e) => consoleErrors.push(e.message)); },
});
await mkdir(EVIDENCE, { recursive: true });
export const shot = (pg: import('playwright').Page, tc: string) => pg.screenshot({ path: path.join(EVIDENCE, `run-${RUN}-tc-${tc.toLowerCase()}.png`) });
// 真正的画布空白 = 命中点上最顶层元素就是画布本身（浮层：对话、工具栏、面板、输入框都不算）
export const blankSpot = (pg: import('playwright').Page) => pg.evaluate(() => {
  const canvas = document.querySelector('[data-testid="canvas"]')!;
  const c = canvas.getBoundingClientRect();
  for (let y = c.top + 100; y < c.bottom - 100; y += 40) for (let x = c.left + 100; x < c.right - 100; x += 40) {
    const el = document.elementFromPoint(x, y);
    if (el === canvas || (el && el.classList.contains('world'))) return { x, y };
  }
  return null;
});
export const verbLine = (pg: import('playwright').Page) => pg.getByTestId('verb-line').innerText();
// stub 轮次没有云端通道（§3：GEMINI_API_KEY 置空，种子不建 Gemini 通道），输入框的缺省通道落到「交给本机 Claude Code」：
// 没有屏数 / 版数档位、没选会话时 Enter 被挡。要从输入框发一轮、或要量带档位的输入框的用例，先建一条 OpenAI 兼容桩通道、验证，
// 给了页面就重载（画布在打开时取通道清单）并在输入框里选中它。验证请求（用户提示 ping）不拖，其余按 holdMs 拖
export async function useStubChannel(pg: import('playwright').Page | null, opts: { port: number; label: string; holdMs?: number }) {
  const key = `good-key-${opts.port}`;
  const stub = startOpenAiStub({ port: opts.port, apiKey: key, reply: '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl">Stub</h1></div>', holdMs: (hit) => (hit.user === 'ping' ? 0 : opts.holdMs ?? 0) });
  let id = '';
  cleanups.push(async () => { if (id) await apiJson(`/v1/channels/${id}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  id = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: opts.label, endpoint: stub.url, model: `stub-${opts.port}`, apiKey: key }) })).body.channel.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${id}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
  if (pg) {
    await pg.reload();
    await pg.locator('[data-testid="screen-card"]').first().waitFor();
    await pg.getByTestId('runner-select').waitFor({ timeout: 10000 });
    await pickOption(pg, '[data-testid="runner-select"]', opts.label);
    await eventually(async () => expect((await selectedValue(pg, '[data-testid="runner-select"]')) === `channel:${id}`, `输入框没选上「${opts.label}」`));
  }
}

export const browser = await launch();
export const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// 活跃 SSE 计数探针（TC-CORE-036 第 10 步）：一个标签页应恒定只开一条项目事件流
await ctx.addInitScript(`(() => { window.__sseOpen = 0; const O = window.EventSource; function W(u, i) { const es = new O(u, i); window.__sseOpen += 1; const c = es.close.bind(es); let done = false; es.close = () => { if (!done) { done = true; window.__sseOpen -= 1; } c(); }; return es; } W.prototype = O.prototype; window.EventSource = W; })()`);
export const consoleErrors: string[] = [];
page = await ctx.newPage();
page.on('pageerror', (e) => consoleErrors.push(e.message));

// 首次运行的第一屏（PAGE-FIRST）只在一个项目都没有时出现：在建示例项目之前先量它的品牌符号与字标（TC-CORE-026 第 1、2 步），
// 结论存起来，到 TC-CORE-026 再一起登记
seed('seed', '--empty');
export const brandFirstRun = await (async (): Promise<string> => {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.getByText('还没有项目').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  // 浅色外观用石墨灰版、深色外观用反白版（v1.08）：两张都在文档里，按外观显示其中一张
  const visibleSymbol = () => page.locator('img[src^="/brand/symbol-"]:visible').evaluate((el) => {
    const i = el as HTMLImageElement; const r = i.getBoundingClientRect();
    return { src: i.getAttribute('src'), w: r.width, h: r.height, natural: i.naturalWidth, pad: parseFloat(getComputedStyle(i.parentElement!).paddingTop) };
  });
  const sym = await visibleSymbol();
  expect(sym.src === '/brand/symbol-graphite.svg', `浅色外观下显示的符号是 ${sym.src}，应是石墨灰版`);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const dark = await visibleSymbol();
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  expect(dark.src === '/brand/symbol-reverse.svg' && dark.natural > 0, `深色外观下显示的符号是 ${dark.src}（naturalWidth ${dark.natural}），应是反白版`);
  expect(sym.natural > 0, '品牌符号未加载（naturalWidth=0）');
  expect(sym.w >= 64 && sym.h >= 64, `符号 ${sym.w}×${sym.h} 低于品牌下限 64 px`);
  expect(Math.abs(sym.pad - sym.w / 8) < 1, `安全区不是坐标框的 1/8：padding ${sym.pad} vs ${sym.w / 8}`);
  expect(await page.evaluate(() => document.fonts.check('500 16px "Space Grotesk"')), 'Space Grotesk 未加载');
  const wm = await page.locator('.wordmark').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { family: cs.fontFamily.split(',')[0].replace(/"/g, ''), weight: cs.fontWeight, tracking: parseFloat(cs.letterSpacing), size: parseFloat(cs.fontSize) };
  });
  expect(wm.family === 'Space Grotesk' && wm.weight === '500', `字标字体/字重不符：${JSON.stringify(wm)}`);
  expect(Math.abs(wm.tracking / wm.size + 0.03) < 0.005, `字标字距不是 -0.03 em：${wm.tracking}px / ${wm.size}px`);
  await shot(page, 'CORE-026-first-run');
  return `首屏符号 ${Math.round(sym.w)} px（浅色石墨灰版、深色反白版）、字标 Space Grotesk 500`;
})().catch((e: Error) => e.message);
seed('seed');
await openApp(page);

// ---------- 项目 ----------

// 跨文件共用（原来定义在用到它的第一段里）
export const STUB_RUNNER = { kind: 'model', driver: 'stub', model: 'stub' };
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const uploadPng = async (projectId: string) => {
  const png = Buffer.from(PNG_B64, 'base64');
  const { body } = await apiJson<{ attachmentId: string; putUrl: string }>(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', bytes: png.length }) });
  const put = await fetch(API + body.putUrl, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } });
  expect(put.status === 204, `参考图上传 ${put.status}`);
  return body.attachmentId;
};
export const idemKey = () => ({ 'Idempotency-Key': crypto.randomUUID() });
export const sleep079 = (ms: number) => new Promise((r) => setTimeout(r, ms));
