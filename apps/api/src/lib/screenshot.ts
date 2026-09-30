import { chromium, type Browser } from 'playwright';
import { withOverlayStyle, withScreenCsp } from '@quilt/core';
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
// 不保证它们已经生效：抢在前面截图会拍到无 preflight（<a> 带下划线）的半成品。所以等一个确定信号而不是等一个够长的时间。
// 图标只要求 lucide 脚本已加载（有图标时），拍之前再换一遍：lucide 不认识的名字会原样留下 <i data-lucide>，
// 把「页面里不剩 <i>」当条件，模型编出一个不存在的图标名这屏就永远拍不成。
// 视口内的 <img> 也要等到 complete——外网占位图（picsum）比脚本和字体都慢，以图为主的瀑布流屏否则会拍成空壳；视口外的懒加载图不等。
const STYLED = `(() => {
  const tw = Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.cssText.indexOf('--tw-') >= 0); } catch { return false; } });
  return tw && (!!(window.lucide && window.lucide.createIcons) || document.querySelectorAll('i[data-lucide]').length === 0);
})()`;
const ICONS = 'window.lucide && window.lucide.createIcons && window.lucide.createIcons()';
const IMAGES_IN_VIEW = `Array.from(document.images).every((i) => { const b = i.getBoundingClientRect(); return i.complete || b.bottom <= 0 || b.top >= innerHeight; })`;
async function settle(page: import('playwright').Page, timeoutMs: number) {
  // 样式与图标是硬条件：CDN 慢到超时就抛，让 shotQueue 的重试与 screenshot.retry 补扫，
  // 不能把没有 preflight 的半成品存成缩略图——存下去就是永久的假图
  await page.waitForFunction(STYLED, { timeout: Math.min(timeoutMs, 5_000) }).catch(() => { throw new Error('页面未就绪：Tailwind CDN 未生效或图标库未加载'); });
  // 运行时在 DOMContentLoaded 时换过一遍；这里再换一遍，保证认得的图标都已是 svg（重复执行无害）
  await page.evaluate(ICONS).catch(() => {});
  // 图片是软条件：外网占位图挂了也得出一张图
  await page.waitForFunction(IMAGES_IN_VIEW, { timeout: 4_000 }).catch(() => {});
  await page.evaluate('document.fonts.ready').catch(() => {});
  await page.waitForTimeout(120);
}

// overlay（v0.63 REQ-PROTO-005）：叠层屏拍成带 alpha 的 PNG——注入透明背景、omitBackground，卡片再铺暗底
export async function screenshotHtml(html: string, size: { w: number; h: number }, opts: { timeoutMs?: number; overlay?: boolean } = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    // 预览域外链（Tailwind CDN / 字体 / 图片）需要网络；等 networkidle 但不超过超时。
    // 屏的脚本在这里同样会执行，带上与预览域同一份 CSP（§15）：不带的话它一入库就能往本机 API 发写请求。
    // 不能改成 context.route 拦截一个固定地址来带响应头——拦截返回的文档没有对端 IP，Chromium 按公网算，
    // 本地网络访问限制会把屏里引用的预览域素材（回环地址）整张拦掉
    await page.setContent(withScreenCsp(opts.overlay ? withOverlayStyle(html) : html), { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    return await page.screenshot({ type: 'png', fullPage: false, omitBackground: !!opts.overlay });
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
    // 全部屏的 body 拼在这一页里，脚本同样会执行：带同一份 CSP
    const html = withScreenCsp(`<!doctype html><html><head>${prelude}</head><body>${bodies.map((x) => `<div>${x}</div>`).join('')}</body></html>`);
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
