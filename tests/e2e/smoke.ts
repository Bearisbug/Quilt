import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, openApp, seed, seedJson, EVIDENCE } from './lib.ts';

// 开发冒烟（v0.32 本地版）：种子一个带屏的项目 → 打开应用 → 顶栏项目切换器 → 切到该项目 → 卡片截图渲染 → 双击聚焦 → 对话面板可见
await mkdir(EVIDENCE, { recursive: true });
seed('seed');
seedJson('seed:project', '--name', 'Smoke', '--device', 'mobile', '--screens', '3');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page);
console.log('app ok →', page.url());
await page.getByTestId('project-switcher').click();
const options = page.getByTestId('project-switcher-list').getByTestId('project-option');
await options.first().waitFor();
console.log('projects:', await options.count());
await page.screenshot({ path: path.join(EVIDENCE, 'smoke-projects.png') });
await options.filter({ hasText: 'Smoke' }).first().click();
await page.waitForURL(/\/p\//);
await page.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
const n = await page.locator('[data-testid="screen-card"]').count();
const imgs = await page.locator('[data-testid="screen-card"] img').count();
console.log('screen cards:', n, 'with screenshot:', imgs, 'stat:', await page.locator('[data-testid="stat"]').innerText());
console.log('style guide present:', await page.locator('[data-testid="style-guide"]').count());
await page.screenshot({ path: path.join(EVIDENCE, 'smoke-canvas.png') });

// 双击聚焦第一屏
await page.locator('[data-testid="screen-card"]').first().locator('.gesture').dblclick();
const iframe = page.locator('.card.focused iframe');
await iframe.waitFor({ timeout: 10000 });
console.log('iframe src origin:', new URL((await iframe.getAttribute('src'))!).origin);
await page.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(EVIDENCE, 'smoke-focused.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('iframe after esc:', await page.locator('.card.focused iframe').count());
console.log('chat input:', await page.locator('#chat-input').count());
console.log('errors:', JSON.stringify(errors));
await browser.close();
