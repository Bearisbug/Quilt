import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const WEB = 'http://localhost:5173';
export const API = 'http://localhost:3100';
export const EVIDENCE = path.join(ROOT, 'docs/test-runs');

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

export async function launch(): Promise<Browser> {
  return chromium.launch({ channel: 'msedge', headless: true });
}

// 打开应用（v0.32 本地版无登录）：`/` 直接落到最近更新的项目画布 /p/<id>；一个项目都没有时停在 /（PAGE-FIRST）
export async function openApp(page: Page): Promise<void> {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.waitForURL(/\/p\/|\/$/, { timeout: 15000 });
}

// API 直调：本地版免鉴权，所有请求都是默认用户
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
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
