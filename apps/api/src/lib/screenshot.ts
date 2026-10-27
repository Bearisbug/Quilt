import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request } from 'playwright';
import { withOverlayStyle, withDraftComponentStyle, DRAFT_PAD, withPaletteDarkMode, withScreenCsp, vendorFileFor } from '@quilt/core';
import { config } from '../config.ts';
import { SHOT_SCALE, imageHead, slots } from './shots.ts';

// 服务端截图（ADR-002）：单浏览器实例复用，按屏开 page。
// 浏览器来源（REQ-CORE-017）：SCREENSHOT_BROWSER_CHANNEL 指定的 → 本机 Chrome → 本机 Edge → Playwright 自带 Chromium；
// 都没有时抛错并在日志里给安装命令，画布用骨架占位、screenshot.retry 装好后补扫。
let browser: Promise<Browser> | null = null;
const browserPid = new WeakMap<Browser, number>();
let hinted = false;
export const INSTALL_HINT = '没有可用的浏览器做截图：安装 Chrome / Edge，或运行 npx playwright install chromium';

// 本进程拉起的截图浏览器（§16 进程启动）：父进程是本进程、命令行带 Playwright 建的临时 --user-data-dir。
// Playwright 拉起的浏览器不随本进程退出，被 SIGKILL 时它连同子进程一直留着，所以每次拉起后把浏览器主进程 PID 与这个目录记进数据目录。
// 一个进程一个文件（按本进程 PID 命名）：同一数据目录下种子脚本也会拍截图，记在同一个文件里会把 API 的记录冲掉
type Owned = { pid: number; dir: string };
const RECORDS = path.join(config.dataDir, 'screenshot-browsers');
function processes(): { pid: number; ppid: number; command: string }[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); } catch { return []; }
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
}
const userDataDir = (command: string) => /--user-data-dir=(\S+)/.exec(command)?.[1];
function ownedBrowsers(): Owned[] {
  return processes().filter((p) => p.ppid === process.pid && p.command.includes('--remote-debugging-pipe'))
    .flatMap((p) => { const dir = userDataDir(p.command); return dir ? [{ pid: p.pid, dir }] : []; });
}
const OWN_RECORD = path.join(RECORDS, `${process.pid}.json`);
let exitHooked = false;
function saveRecord(owned: Owned[]) {
  try { mkdirSync(RECORDS, { recursive: true }); writeFileSync(OWN_RECORD, JSON.stringify(owned)); } catch { /* 记不下只影响下次启动的清理 */ }
  // 正常退出时 Playwright 自己结束浏览器，这份记录随之作废；只有被 SIGKILL 时它才留给下次启动
  if (!exitHooked) { exitHooked = true; process.on('exit', () => { try { rmSync(OWN_RECORD, { force: true }); } catch { /* 留给下次启动 */ } }); }
}

// 启动时结束上次进程留下的截图浏览器：只认记录里的临时目录，结束命令行带 --user-data-dir=<该目录> 的进程（主进程与子进程），
// 再删目录。用户自己开的 Edge / Chrome 不带这个参数；PID 被别的进程复用了也对不上目录，不会误杀。
// 浏览器主进程仍挂在记录它的那个进程名下，说明那个进程还活着（同一数据目录里另一套 API、正在跑的种子脚本），它的浏览器不动
export function reapOrphanBrowsers(): number {
  let files: string[];
  try { files = readdirSync(RECORDS); } catch { return 0; }
  let killed = 0;
  const running = processes();
  for (const file of files) {
    const owner = Number(path.basename(file, '.json'));
    let saved: Owned[] = [];
    try { saved = JSON.parse(readFileSync(path.join(RECORDS, file), 'utf8')) as Owned[]; } catch { /* 坏文件当空记录 */ }
    const procsOf = (dir: string) => running.filter((p) => userDataDir(p.command) === dir);
    if (saved.some(({ dir }) => procsOf(dir).some((p) => p.ppid === owner))) continue;
    for (const { dir } of saved) {
      if (!path.basename(dir).startsWith('playwright_')) continue;
      for (const p of procsOf(dir)) {
        try { process.kill(p.pid, 'SIGKILL'); killed++; } catch { /* 已经退出 */ }
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉的目录不挡启动 */ }
    }
    try { rmSync(path.join(RECORDS, file), { force: true }); } catch { /* 同上 */ }
  }
  return killed;
}

async function launchBrowser(): Promise<Browser> {
  const channels: (string | undefined)[] = config.screenshotChannel ? [config.screenshotChannel] : ['chrome', 'msedge', undefined];
  let lastErr: Error | null = null;
  const before = new Set(ownedBrowsers().map((o) => o.pid));
  for (const channel of channels) {
    try {
      const b = await chromium.launch({ channel, headless: true, timeout: 30_000 });
      const owned = ownedBrowsers();
      const pid = owned.find((o) => !before.has(o.pid))?.pid;
      if (pid) browserPid.set(b, pid);
      saveRecord(owned);
      return b;
    } catch (e) { lastErr = e as Error; }
  }
  if (!hinted) { hinted = true; console.warn(`[screenshot] ${INSTALL_HINT}（${lastErr?.message.split('\n')[0] ?? ''}）`); }
  throw new Error(INSTALL_HINT);
}

// 启动单飞（§17）：浏览器还没起来时并发进来的截图共用同一次启动——各自 launch 会起好几个，只有最后一个被记住、其余泄漏到进程退出
function getBrowser(): Promise<Browser> {
  if (!browser) {
    const p: Promise<Browser> = launchBrowser().then(
      (b) => { b.on('disconnected', () => { if (browser === p) browser = null; saveRecord(ownedBrowsers()); }); return b; },
      (e) => { if (browser === p) browser = null; throw e; },
    );
    browser = p;
  }
  return browser;
}

// 卡死的浏览器整个换掉：单例当场清掉（卡死的浏览器关不掉时 'disconnected' 不会来），结束它的进程，下一张截图重新起一个
function discard(b: Browser) {
  const p = browser;
  void p?.then((cur) => { if (cur === b && browser === p) browser = null; }, () => {});
  const pid = browserPid.get(b);
  if (pid) { try { process.kill(pid, 'SIGKILL'); return; } catch { /* 已经退出 */ } }
  void b.close().catch(() => {});
}

const within = <T>(work: Promise<T>, ms: number, step: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`截图超时：${step}超过 ${ms / 1000} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

// 外网的脚本、样式与字体（Tailwind Play CDN、lucide、Google Fonts、屏自己引的库）按地址缓存在进程内：每张截图都是新上下文、没有 HTTP 缓存，
// 不缓存的话每张都重下一遍（实测约 5 s，外网抖动时整张拍不成）。只存 https 上 200 的响应，跳转前的地址一并记上；没取到的不存，下次照常走网络
const vendorCache = new Map<string, { body: Buffer; contentType?: string; cors?: string }>();
const VENDOR_TYPES = new Set(['script', 'stylesheet', 'font']);
// Tailwind Play 与 lucide 不走外网：直接用仓库里的副本应答（§17 v1.06），种子、测试与刚重启的进程第一张截图也不等外网
const vendorCopies = new Map<string, Buffer>();
const vendorCopy = (file: string) => { let b = vendorCopies.get(file); if (!b) { b = readFileSync(path.join(config.vendorDir, file)); vendorCopies.set(file, b); } return b; };
async function useVendorCache(context: BrowserContext) {
  await context.route(/^https:/, (route) => {
    const copy = vendorFileFor(route.request().url());
    if (copy) return route.fulfill({ body: vendorCopy(copy), contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' } });
    const hit = vendorCache.get(route.request().url());
    return hit ? route.fulfill({ body: hit.body, contentType: hit.contentType, headers: hit.cors ? { 'access-control-allow-origin': hit.cors } : {} }) : route.continue();
  });
  context.on('response', (res) => {
    const req = res.request();
    if (res.status() !== 200 || !res.url().startsWith('https:') || !VENDOR_TYPES.has(req.resourceType()) || vendorCache.has(res.url())) return;
    res.body().then((body) => {
      const h = res.headers();
      const entry = { body, contentType: h['content-type'], cors: h['access-control-allow-origin'] };
      for (let r: Request | null = req; r; r = r.redirectedFrom()) vendorCache.set(r.url(), entry);
    }, () => { /* 上下文已关，下次再存 */ });
  });
}

// 一次截图 / 抽 CSS 的整条链分段设上限（§17 Chromium 一行）：建上下文 ≤ 5 s，载入到拍完 ≤ capMs，关上下文 ≤ 5 s。
// 任何一段超时都抛错交给调用方的重试，调用方（作业里的回刷、截图队列）不跟着挂住；建或关上下文超时说明浏览器本身卡住了，换掉它
// 闲置关掉（§17 v1.49）：截图、缩略图、抽样式都做完，config.screenshotIdleMs（5 分钟）内没有新的，就关掉浏览器，下一张再起（多等 1–2 s）。
// 单例当场清掉，关的过程中进来的截图另起一个，不会拿到正在关的这个
let busy = 0;
let idleTimer: NodeJS.Timeout | undefined;
function closeIdle() {
  if (busy) return;
  const p = browser;
  browser = null;
  void p?.then((b) => b.close(), () => {}).catch(() => {});
}
async function inPage<T>(options: BrowserContextOptions, capMs: number, fn: (page: Page) => Promise<T>): Promise<T> {
  busy++;
  clearTimeout(idleTimer);
  try {
    const b = await getBrowser();
    const context = await within(b.newContext(options), 5_000, '建上下文').catch((e: Error) => { discard(b); throw e; });
    try { return await within(useVendorCache(context).then(() => context.newPage()).then(fn), capMs, '载入与拍摄'); }
    finally { await within(context.close(), 5_000, '关上下文').catch(() => discard(b)); }
  } finally {
    if (--busy === 0) idleTimer = setTimeout(closeIdle, config.screenshotIdleMs).unref();
  }
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
  await page.waitForFunction(STYLED, undefined, { timeout: Math.min(timeoutMs, 5_000) }).catch(() => { throw new Error('页面未就绪：Tailwind CDN 未生效或图标库未加载'); });
  // 运行时在 DOMContentLoaded 时换过一遍；这里再换一遍，保证认得的图标都已是 svg（重复执行无害）
  await page.evaluate(ICONS).catch(() => {});
  // 图片与字体是软条件：外网占位图挂了、字体请求一直不回，也得出一张图
  await page.waitForFunction(IMAGES_IN_VIEW, undefined, { timeout: 4_000 }).catch(() => {});
  await within(page.evaluate('document.fonts.ready'), 4_000, '等字体').catch(() => {});
  await page.waitForTimeout(120);
}

// 草稿根（REQ-CORE-040）：body 下第一个会渲染的元素。截图（rootOnly）与预览域的 quilt:draft-size 测量脚本共用这一段，
// 跳过模型偶尔放在根前面的 <link> / <style> / <script>，两边才量的是同一个框
export const DRAFT_ROOT_JS = `(function(){var r=document.body&&document.body.firstElementChild;while(r&&/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(r.tagName))r=r.nextElementSibling;return r||null;})()`;

// overlay（v0.63 REQ-PROTO-005）：叠层屏拍成带 alpha 的 PNG——注入透明背景、omitBackground，卡片再铺暗底。
// rootOnly（REQ-CORE-040）：组件画框的草稿在给定视口里渲染、只拍草稿根的框；量不出框（没有根、宽或高为 0）时退回整视口。
// 它与叠层屏一样拍透明底：圆角根的四角露出看板底色，而不是草稿本设计系统的背景色
export async function screenshotHtml(html: string, size: { w: number; h: number }, opts: { timeoutMs?: number; overlay?: boolean; rootOnly?: boolean } = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const transparent = !!(opts.overlay || opts.rootOnly);
  return inPage({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: SHOT_SCALE }, timeoutMs * 2, async (page) => {
    // 预览域外链（Tailwind CDN / 字体 / 图片）需要网络；等 networkidle 但不超过超时。
    // 屏的脚本在这里同样会执行，带上与预览域同一份 CSP（§15）：不带的话它一入库就能往本机 API 发写请求。
    // 不能改成 context.route 拦截一个固定地址来带响应头——拦截返回的文档没有对端 IP，Chromium 按公网算，
    // 本地网络访问限制会把屏里引用的预览域素材（回环地址）整张拦掉
    // dark: 按配色判（v0.89）：v0.89 之前写入的修订补上，截图与交互态才是同一个样子
    const doc = withPaletteDarkMode(html);
    await page.setContent(withScreenCsp(opts.rootOnly ? withDraftComponentStyle(doc) : transparent ? withOverlayStyle(doc) : doc), { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    if (opts.rootOnly) {
      // 根自己带无限动画（漂浮、转圈）时元素截图要等「连续两帧边框不变」，永远等不到——先停掉动画与过渡，按静止时的框裁整页截图，不经元素截图的稳定性等待
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' }).catch(() => {});
      const root = (await page.evaluateHandle<Element | null>(DRAFT_ROOT_JS)).asElement();
      const box = await root?.boundingBox();
      // 连同四周那圈透明边一起拍（DRAFT_PAD），根的阴影不被裁掉
      if (box && box.width >= 1 && box.height >= 1) {
        const x = Math.max(0, box.x - DRAFT_PAD); const y = Math.max(0, box.y - DRAFT_PAD);
        return await page.screenshot({ type: 'png', fullPage: true, clip: { x, y, width: box.x + box.width + DRAFT_PAD - x, height: box.y + box.height + DRAFT_PAD - y }, omitBackground: true, timeout: timeoutMs });
      }
    }
    return await page.screenshot({ type: 'png', fullPage: false, omitBackground: transparent });
  });
}

// 截图浏览器里编码 WebP，空白页里做、屏自己的脚本碰不到它：卡片缩略图（v1.02 ADR-029）缩到 1/4、质量 0.8；
// sharp 用不了时整屏截图也走这里（v1.27 ADR-037），原尺寸、质量 1 就是无损编码。来源是 PNG 截图或已存成 WebP 的截图
async function webpInBrowser(image: Buffer, scale: number, quality: number, capMs: number): Promise<Buffer> {
  const type = imageHead(image)?.format === 'webp' ? 'image/webp' : 'image/png';
  return inPage({}, capMs, async (page) => {
    const b64 = await page.evaluate(async ({ src, type, scale, quality }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type }));
      const w = Math.max(1, Math.round(bitmap.width * scale)); const h = Math.max(1, Math.round(bitmap.height * scale));
      const img = scale === 1 ? bitmap : await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
      if (blob.type !== 'image/webp') throw new Error(`浏览器编码不出 WebP（得到 ${blob.type}）`); // 不支持时会静默退回 PNG
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, { src: image.toString('base64'), type, scale, quality });
    return Buffer.from(b64, 'base64');
  });
}

export const thumbnailOf = (image: Buffer): Promise<Buffer> => webpInBrowser(image, 1 / 4, 0.8, 5_000);

// 整屏截图存成无损 WebP（v1.27 ADR-037）：sharp（libvips）压缩档 4（比最高档 6 大 0.69%、快 22.7%，ADR-037 v1.29），逐像素不变（exact：透明像素的颜色也照存）。
// sharp 加载失败（这个平台没有预编译包）时退回浏览器自带的无损 WebP：压缩率低得多，色块简单的屏可能比 PNG 还大；加载结果记一次，启动日志里写明用的是哪个
type Sharp = (typeof import('sharp'))['default'];
let sharpLoad: Promise<Sharp | null> | null = null;
export function loadWebpEncoder(): Promise<Sharp | null> {
  sharpLoad ??= import('sharp').then((m) => m.default, (e: Error) => {
    console.warn(`[screenshot] sharp 加载失败，整屏截图改用浏览器自带的无损 WebP 编码（${e.message.split('\n')[0]}）`);
    return null;
  });
  return sharpLoad;
}

// 进程里同时最多 2 张在编码（ADR-037）：sharp 每张占一个 libuv 线程，线程池默认 4 个，占满时同进程的文件读（预览、对象）全部排队
const encodeSlot = slots(2);

// 单张 ≤ 10 s（只计编码，不计排队），失败重试 2 次（§17 sharp 一行）；编出来的必须是无损 WebP，否则当失败
export async function losslessWebp(png: Buffer): Promise<Buffer> {
  const sharp = await loadWebpEncoder();
  let last: Error = new Error('WebP 编码失败');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { work } = await encodeSlot(() => (sharp ? sharp(png).webp({ lossless: true, effort: 4, exact: true }).toBuffer() : webpInBrowser(png, 1, 1, 10_000)));
      const out = await within(work, 10_000, '编码 WebP');
      if (!imageHead(out)?.lossless) throw new Error('编出来的不是无损 WebP');
      return out;
    } catch (e) { last = e as Error; }
  }
  throw last;
}

// 导出用：把全部屏放进一页让 Tailwind Play CDN 生成并集 CSS，抽出来内联（REQ-PROTO-004）
export async function extractTailwindCss(prelude: string, bodies: string[], timeoutMs = 20_000): Promise<string> {
  return inPage({ viewport: { width: 1280, height: 800 } }, timeoutMs * 2, async (page) => {
    // 全部屏的 body 拼在这一页里，脚本同样会执行：带同一份 CSP
    const html = withScreenCsp(`<!doctype html><html><head>${prelude}</head><body>${bodies.map((x) => `<div>${x}</div>`).join('')}</body></html>`);
    await page.setContent(html, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    return await page.evaluate(() => Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent ?? '').filter((t) => t.includes('--tw-') || t.includes('.bg-')).join('\n'));
  });
}

export async function closeScreenshotBrowser() {
  const b = await browser?.catch(() => null);
  browser = null;
  await b?.close().catch(() => {});
}
