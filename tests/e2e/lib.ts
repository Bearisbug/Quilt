import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

export const ROOT = path.resolve(import.meta.dirname, '../..');
// 可指到另一处前端：3100 / 5173 被别的会话占着时，按打包形态起一套（`WEB_DIST=apps/web/dist` 的 API 同端口托管前端）再跑浏览器用例
export const WEB = process.env.QUILT_E2E_WEB ?? 'http://localhost:5173';
// 可指到另一套 API（e2e:mcp 在独立端口 + 测试库上跑，不占用 3100 的开发实例）
export const API = process.env.QUILT_E2E_API ?? 'http://localhost:3100';
export const EVIDENCE = path.join(ROOT, 'docs/test-runs');
// 预览域的 host（含端口）：从被测 API 的 /v1/config 取，隔离栈（3200 / 3201）上跑也对得上；取不到时回落到开发默认 3101
export const previewHost = async (): Promise<string> => { try { const c = (await (await fetch(`${API}/v1/config`)).json()) as { previewOrigin?: string }; return c.previewOrigin ? new URL(c.previewOrigin).host : 'preview.localhost:3101'; } catch { return 'preview.localhost:3101'; } };

// 种子脚本：走 apps/api 的 pnpm scripts，返回最后一行输出
export function seed(script: string, ...args: string[]): string {
  // `pnpm seed` 会删光当前库里的全部项目（本地版只有一个用户，种子数据就是全量重置）。
  // 每个 e2e 套件在模块顶层就调它，所以「只想看看脚本能不能跑」也会清库——实测清掉过开发库里的真实项目。
  // 因此除非 DATABASE_URL 指向测试库，一律拒绝；要在开发库上重置，显式给 ALLOW_SEED_DEV=1。
  if (script === 'seed' && !/quilt_test/.test(process.env.DATABASE_URL ?? '') && process.env.ALLOW_SEED_DEV !== '1') {
    throw new Error('拒绝执行 pnpm seed：它会删光当前库的全部项目。e2e 请对测试库跑（DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test），确实要重置开发库时设 ALLOW_SEED_DEV=1。');
  }
  const out = execFileSync('pnpm', ['-s', script, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim().split('\n').pop() ?? '';
}
export const seedJson = <T = Record<string, unknown>>(script: string, ...args: string[]): T => {
  const out = execFileSync('pnpm', ['-s', script, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const start = out.indexOf('{');
  return JSON.parse(out.slice(start)) as T;
};

// 动手之前先认库：e2e 会经浏览器与 MCP 逐屏写删，这些路径绕得过 seed() 那道守卫。
// 2026-09-21 实测过后果——并行会话把 e2e 打到 3100 的开发实例上，开发库里四个项目的屏被清空、
// 只剩项目壳（`pnpm seed` 被拦住了，所以项目还在）。所以每个套件跑起来的第一件事是问 API 它背后是哪个库，
// 不是测试库就当场停，不要等到第一条断言。要故意对开发库跑就显式 ALLOW_E2E_DEV=1。
let dbChecked: Promise<void> | null = null;
export const assertTestApi = (): Promise<void> => (dbChecked ??= checkTestApi());
async function checkTestApi(): Promise<void> {
  if (process.env.ALLOW_E2E_DEV === '1') return;
  let db: string;
  try {
    const r = await fetch(`${API}/v1/health`);
    db = ((await r.json()) as { database?: string }).database ?? '';
  } catch (e) {
    throw new Error(`连不上 ${API}/v1/health，先把 API 起起来：${(e as Error).message}`);
  }
  if (!/_test\b|_test$/.test(db)) {
    throw new Error(
      `拒绝对 ${API} 跑 e2e：它背后是「${db}」而不是测试库。e2e 会逐屏写删，打到开发库上就是清空真实项目。\n` +
      `把 API 指到测试库（DATABASE_URL=postgres://quilt:quilt@127.0.0.1:5439/quilt_test），或另起一套：\n` +
      `  DATABASE_URL=…/quilt_test API_PORT=3200 PREVIEW_PORT=3201 pnpm --filter @quilt/api dev\n` +
      `  QUILT_E2E_API=http://localhost:3200 pnpm e2e:<套件>\n` +
      `确实要对开发库跑，显式设 ALLOW_E2E_DEV=1。`,
    );
  }
}

// 轮询到断言成立：替代「固定睡一段再断言」——负载高或 SSE 刷新晚到时固定睡眠会在落库之前就断言，快的时候又白等。
// 只用于「等某件事发生」；要确认某件事「没有发生」时仍用固定等待，否则轮询会在事情发生之前就判通过
export async function eventually(check: () => unknown, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; }
    catch (e) { if (Date.now() >= end) throw e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function launch(): Promise<Browser> {
  await assertTestApi();
  return chromium.launch({ channel: 'msedge', headless: true });
}

// 打开应用（v0.32 本地版无登录）：`/` 直接落到最近更新的项目画布 /p/<id>；一个项目都没有时停在 /（PAGE-FIRST）
export async function openApp(page: Page): Promise<void> {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.waitForURL(/\/p\/|\/$/, { timeout: 15000 });
}

// API 直调：本地版免鉴权，所有请求都是默认用户
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  await assertTestApi(); // 不经浏览器的套件（MCP / 纯接口）也要过这道闸，见 assertTestApi
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

// 表单下拉（components/Select.tsx，Radix 底座）的测试助手。
// 它渲染成 button + portal 里的 listbox，所以 selectOption / inputValue 都用不了：
// 选值用 pickOption（按可见文案点），读值用 selectedValue（读触发器上的 data-value）。
export async function pickOption(page: import('playwright').Page, triggerSelector: string, optionText: string): Promise<void> {
  await page.locator(triggerSelector).click();
  const list = page.getByRole('listbox');
  await list.waitFor({ timeout: 5000 });
  await list.getByRole('option').filter({ hasText: optionText }).first().click();
  await list.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}
export const selectedValue = (page: import('playwright').Page, triggerSelector: string): Promise<string | null> =>
  page.locator(triggerSelector).getAttribute('data-value');
