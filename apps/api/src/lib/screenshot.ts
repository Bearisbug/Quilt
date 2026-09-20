import { chromium, type Browser } from 'playwright';
import { config } from '../config.ts';

// 服务端截图（ADR-002）：单浏览器实例复用，按屏开 page。
// 浏览器来源（REQ-CORE-017）：SCREENSHOT_BROWSER_CHANNEL 指定的 → 本机 Chrome → 本机 Edge → Playwright 自带 Chromium；
// 都没有时抛错并在日志里给安装命令，画布用骨架占位、screenshot.retry 装好后补扫。
let browser: Browser | null = null;
let hinted = false;
export const INSTALL_HINT = '没有可用的浏览器做截图：安装 Chrome / Edge，或运行 npx playwright install chromium';
async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  const channels: (string | undefined)[] = config.screenshotChannel ? [config.screenshotChannel] : ['chrome', 'msedge', undefined];
  let lastErr: Error | null = null;
  for (const channel of channels) {
    try { browser = await chromium.launch({ channel, headless: true }); return browser; }
    catch (e) { lastErr = e as Error; }
  }
  if (!hinted) { hinted = true; console.warn(`[screenshot] ${INSTALL_HINT}（${lastErr?.message.split('\n')[0] ?? ''}）`); }
  throw new Error(INSTALL_HINT);
}

// Tailwind Play CDN 与 lucide 都是「脚本跑完才改 DOM / 注样式」，networkidle 只保证请求停了、
// 不保证它们已经生效：抢在前面截图会拍到无 preflight（<a> 带下划线）、<i data-lucide> 还没换成
// svg 的半成品。所以等一个确定信号而不是等一个够长的时间。视口内的 <img> 也要等到 complete——
// 外网占位图（picsum）比脚本和字体都慢，以图为主的瀑布流屏否则会拍成空壳；视口外的懒加载图不等。
const STYLED = `(() => {
  const tw = Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.cssText.indexOf('--tw-') >= 0); } catch { return false; } });
  return tw && document.querySelectorAll('i[data-lucide]').length === 0;
})()`;
const IMAGES_IN_VIEW = `Array.from(document.images).every((i) => { const b = i.getBoundingClientRect(); return i.complete || b.bottom <= 0 || b.top >= innerHeight; })`;
async function settle(page: import('playwright').Page, timeoutMs: number) {
  // 样式与图标是硬条件：CDN 慢到超时就抛，让 shotQueue 的重试与 screenshot.retry 补扫，
  // 不能把没有 preflight 的半成品存成缩略图——存下去就是永久的假图
  await page.waitForFunction(STYLED, { timeout: Math.min(timeoutMs, 5_000) }).catch(() => { throw new Error('页面未就绪：Tailwind CDN 未生效或图标未替换'); });
  // 图片是软条件：外网占位图挂了也得出一张图
  await page.waitForFunction(IMAGES_IN_VIEW, { timeout: 4_000 }).catch(() => {});
  await page.evaluate('document.fonts.ready').catch(() => {});
  await page.waitForTimeout(120);
}

export async function screenshotHtml(html: string, size: { w: number; h: number }, timeoutMs = 15_000): Promise<Buffer> {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    // 预览域外链（Tailwind CDN / 字体 / 图片）需要网络；等 networkidle 但不超过超时
    await page.setContent(html, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    return await page.screenshot({ type: 'png', fullPage: false });
  } finally {
    await context.close();
  }
}

// 导出用：把全部屏放进一页让 Tailwind Play CDN 生成并集 CSS，抽出来内联（REQ-PROTO-004）
export async function extractTailwindCss(prelude: string, bodies: string[], timeoutMs = 20_000): Promise<string> {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const html = `<!doctype html><html><head>${prelude}</head><body>${bodies.map((x) => `<div>${x}</div>`).join('')}</body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    return await page.evaluate(() => Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent ?? '').filter((t) => t.includes('--tw-') || t.includes('.bg-')).join('\n'));
  } finally {
    await context.close();
  }
}

export async function closeScreenshotBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}
