// 出屏提示词与新建项目设计系统的 A/B 对比（TEST.md TC-CORE-084，ADR-027 / ADR-028）：同一批冻结的规划，分别用基线 / 候选系统提示词出屏、截图，供盲评。
// 与 pipeline.ts 的 runGenerate 对空项目首轮的做法一致：规划器 → 每屏 screenSystemPrompt + screenUserPrompt →
// stripFences → lint → injectQids → assembleDocument(buildPrelude(tokens))。唯一的变量是系统提示词。
// 需要真实模型（Gemini 走 .env 的 GEMINI_API_KEY / Vertex，Sonnet 走本机 Claude 订阅），不写任何库。
// 用法（在 tests/ 下）：
//   npx tsx bench/craft/harness.mts plan                             补齐 plans.json 里缺的需求（已冻结的不重跑）
//   npx tsx bench/craft/harness.mts gen <variant> <channel> [ids]    variant = base（当前代码）| <candidate.json>；channel = gemini | sonnet
//   npx tsx bench/craft/harness.mts reshoot <variant> <channel> [brief-idx …]  用存下的 HTML 重拍（不调模型）
//   npx tsx bench/craft/harness.mts pairs <a> <b> <channel> <label>  盲评对：路径只带中性标签，左右两种顺序
//   npx tsx bench/craft/harness.mts sysprompt <variant> <briefId>    打印系统提示词（核对候选插入位置）
//   npx tsx bench/craft/harness.mts audit <variant> <channel>        「AI 味」机械指标（粗线、胶囊、大圆角、阴影、渐变、折行短文本）记进 manifest
// variant 除了 base 与 *.json，也可以是已有产物的目录名（pairs / audit 用）；AES_LABEL 改 gen base 的产物目录名。
// 新建项目的设计系统按被测代码里的 newProjectDesign 取（没有这个函数的旧代码退回种子派生 + 默认配方）
// 候选 JSON：{ block, mobile?, desktop?, edits?: [{find, replace, device?}], designMdEdits?: [{find, replace, device?}] }，
// block 插在 DESIGN SYSTEM 一节之前，edits 改系统提示词原文，designMdEdits 改默认 DESIGN.md 原文。
// 产物在 CRAFT_BENCH_OUT（缺省 docs/test-runs/craft-bench，已 gitignore）。环境变量 AES_CONC：并发数（缺省 4；
// Gemini 走 Vertex 时 4 并发会撞 120 s 请求超时，用 2）。本机 Claude 订阅每次调用会在 ~/.claude/projects/<cwd> 下留一份会话记录，跑完删掉。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO = path.resolve(import.meta.dirname, '../../..');
const core = await import(path.join(REPO, 'packages/core/src/index.ts'));
const { completeWithRetry } = await import(path.join(REPO, 'apps/api/src/lib/llm.ts'));

const HERE = import.meta.dirname;
const DIR = process.env.CRAFT_BENCH_OUT ?? path.join(REPO, 'docs/test-runs/craft-bench');
fs.mkdirSync(DIR, { recursive: true });
const SEED = '#3B5BDB';
type Brief = { id: string; name: string; device: 'mobile' | 'desktop'; prompt: string };
type Planned = { name: string; route: string; purpose: string; links: string[]; sections: string[]; presentation?: 'push' | 'overlay' };
type Plan = { brief?: string; screens: Planned[] };
const CHANNELS = {
  gemini: { spec: { driver: 'gemini' as const }, model: 'gemini-3.7-flash' },
  sonnet: { spec: { driver: 'agent-sdk' as const }, model: 'claude-sonnet-5-5' },
};
type Channel = keyof typeof CHANNELS;
type Candidate = { name?: string; block: string; mobile?: string; desktop?: string; edits?: { find: string; replace: string; device?: 'mobile' | 'desktop' }[]; designMdEdits?: { find: string; replace: string; device?: 'mobile' | 'desktop' }[] };

const briefs: Brief[] = JSON.parse(fs.readFileSync(path.join(HERE, 'briefs.json'), 'utf8'));
const SCREENS_PER_BRIEF = 3;

function parsePlan(text: string): Plan {
  const s = core.stripFences(text);
  const plan = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) as Plan;
  if (!Array.isArray(plan.screens) || !plan.screens.length) throw new Error('empty plan');
  return plan;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!); }));
}

// 新建项目拿到的设计系统：代码里有 newProjectDesign（v0.92 起）就用它，否则是此前的种子派生 + 默认配方 + 默认 DESIGN.md
function projectDesign(b: Brief): { tokens: any; designMd: string; components: unknown[] } {
  if (typeof core.newProjectDesign === 'function') return core.newProjectDesign(b.name, b.device, SEED);
  return { tokens: core.tokensFromSeed(SEED), designMd: core.defaultDesignMd(b.name, SEED, b.device), components: core.DEFAULT_COMPONENTS };
}

// 候选 = 在 DESIGN SYSTEM 一节之前插入 CRAFT 段（+ 设备专属几行），可选地替换现有规则里的原文
function systemFor(variant: Candidate | null, b: Brief, registry: { route: string; name: string; purpose?: string }[]): string {
  const { tokens, designMd: md, components } = projectDesign(b);
  const app = { name: b.name, description: b.prompt };
  // 候选也可以改默认 DESIGN.md 的原文（新建项目拿到的那份）：模板里与做工规则冲突的句子按优先级会压过它
  let designMd: string = md;
  for (const e of variant?.designMdEdits ?? []) {
    if (e.device && e.device !== b.device) continue;
    if (!designMd.includes(e.find)) throw new Error(`designMd edit not found verbatim: ${e.find.slice(0, 80)}`);
    designMd = designMd.replace(e.find, e.replace);
  }
  let sys: string = core.screenSystemPrompt(app, b.device, tokens, designMd, components, registry, [], [], []);
  if (!variant) return sys;
  for (const e of variant.edits ?? []) {
    if (!sys.includes(e.find)) { if (e.device && e.device !== b.device) continue; throw new Error(`candidate edit not found verbatim: ${e.find.slice(0, 80)}`); }
    sys = sys.replace(e.find, e.replace);
  }
  const extra = (b.device === 'mobile' ? variant.mobile : variant.desktop)?.trim();
  const block = `${variant.block.trim()}${extra ? `\n${extra}` : ''}\n\n`;
  const anchor = '\nDESIGN SYSTEM\n';
  if (!sys.includes(anchor)) throw new Error('anchor missing');
  return sys.replace(anchor, `\n${block}DESIGN SYSTEM\n`);
}

// variant：base = 当前代码；*.json = 候选；其他字符串 = 只当产物目录名用（pairs / audit 比较已有产物）。AES_LABEL 可改 base 的目录名
function loadVariant(v: string): { name: string; cand: Candidate | null } {
  if (v === 'base') return { name: process.env.AES_LABEL ?? 'base', cand: null };
  if (!v.endsWith('.json')) return { name: v, cand: null };
  const cand = JSON.parse(fs.readFileSync(path.resolve(v), 'utf8')) as Candidate;
  return { name: path.basename(v, '.json'), cand };
}

async function plan() {
  const out: Record<string, Plan> = fs.existsSync(path.join(HERE, 'plans.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'plans.json'), 'utf8')) : {};
  await pool(briefs.filter((b) => !out[b.id]), 3, async (b) => {
    const system = core.planSystemPrompt({ count: 'auto', empty: true });
    const user = core.planUserPrompt({ name: b.name, description: b.prompt }, b.prompt, []);
    const r = await completeWithRetry({ system, prompt: user, model: CHANNELS.sonnet.model, spec: CHANNELS.sonnet.spec });
    out[b.id] = parsePlan(r.text);
    console.log(b.id, out[b.id].screens.map((s) => `${s.name} ${s.route}`).join(' | '));
    fs.writeFileSync(path.join(HERE, 'plans.json'), JSON.stringify(out, null, 2));
  });
}

function plannedFor(plans: Record<string, Plan>, b: Brief) {
  const all = plans[b.id].screens.slice(0, 6).map((s) => ({ ...s, route: s.route.startsWith('/') ? s.route : `/${s.route}` }));
  const routes = new Set(all.map((s) => s.route));
  const fixed = all.map((s) => ({ ...s, links: (s.links ?? []).filter((l) => routes.has(l)), sections: s.sections ?? [] }));
  return { all: fixed, registry: fixed.map((s) => ({ route: s.route, name: s.name, purpose: s.purpose })) };
}

// 截图：与 apps/api/src/lib/screenshot.ts 的就绪判定同口径（Tailwind 生效、lucide 换成 svg、字体与视口内图片软等待），
// 另拍一张「主滚动容器下滚一屏」的帧——卡片截图只看得到首屏
// 就绪判定要包含「Tailwind 配置生效」：CDN 脚本没加载上时 tailwind.config 那行报 tailwind is not defined，
// token 类（bg-primary）算不出颜色，拍出来是半套样式或纯 HTML——评审会把它当成设计差。拍不成就重来，最多 3 次
async function shoot(browser: import('playwright').Browser, html: string, device: 'mobile' | 'desktop', base: string) {
  let last: Awaited<ReturnType<typeof shootOnce>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await shootOnce(browser, html, device, base);
    if (!last.errors.some((e) => /not styled|tailwind is not defined/.test(e))) return { ...last, attempts: attempt };
  }
  return { ...last!, attempts: 3, unstyled: true };
}

async function shootOnce(browser: import('playwright').Browser, html: string, device: 'mobile' | 'desktop', base: string) {
  const size = core.DEVICE_SIZE[device];
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.setContent(core.withPaletteDarkMode(html), { waitUntil: 'networkidle', timeout: 25_000 }).catch(() => {});
    await page.waitForFunction(() => {
      const w = window as unknown as { lucide?: unknown; tailwind?: unknown };
      if (getComputedStyle(document.body).marginTop !== '0px' || !w.lucide || !w.tailwind) return false;
      let probe = document.getElementById('__aes_probe');
      if (!probe) { probe = document.createElement('div'); probe.id = '__aes_probe'; probe.className = 'bg-primary'; probe.style.cssText = 'position:absolute;width:1px;height:1px;left:-9px;top:-9px'; document.body.appendChild(probe); return false; }
      const ok = getComputedStyle(probe).backgroundColor !== 'rgba(0, 0, 0, 0)';
      if (ok) probe.remove();
      return ok;
    }, undefined, { timeout: 15_000, polling: 200 }).catch(() => errors.push('not styled'));
    await page.evaluate(() => { const l = (window as unknown as { lucide?: { createIcons: () => void } }).lucide; l?.createIcons(); }).catch(() => {});
    await page.evaluate('document.fonts.ready').catch(() => {});
    const imgsReady = () => Array.from(document.images).filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every((i) => i.complete);
    await page.waitForFunction(imgsReady, undefined, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${base}.top.jpg`, type: 'jpeg', quality: 88 });
    const scrolled = await page.evaluate(() => {
      const se = document.scrollingElement as HTMLElement;
      const cands = [se, ...Array.from(document.querySelectorAll<HTMLElement>('*'))].filter((e) => e && e.scrollHeight > e.clientHeight + 40 && (e === se || /(auto|scroll)/.test(getComputedStyle(e).overflowY)));
      cands.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
      const sc = cands[0];
      if (!sc) return { scrollable: false, ratio: 1 };
      const ratio = sc.scrollHeight / sc.clientHeight;
      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.9, sc.scrollHeight);
      return { scrollable: true, ratio };
    });
    await page.evaluate(() => { const l = (window as unknown as { lucide?: { createIcons: () => void } }).lucide; l?.createIcons(); }).catch(() => {});
    await page.waitForFunction(imgsReady, undefined, { timeout: 4_000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${base}.scroll.jpg`, type: 'jpeg', quality: 88 });
    return { ...scrolled, errors };
  } finally {
    await ctx.close();
  }
}

async function gen(variantArg: string, channel: Channel, only?: string[]) {
  const plans: Record<string, Plan> = JSON.parse(fs.readFileSync(path.join(HERE, 'plans.json'), 'utf8'));
  const { name: vname, cand } = loadVariant(variantArg);
  const outDir = path.join(DIR, 'out', vname, channel);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest: Record<string, unknown>[] = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
  const done = new Set(manifest.filter((m) => m.ok).map((m) => `${m.brief}-${m.idx}`));
  const tasks = briefs.filter((b) => !only?.length || only.includes(b.id)).flatMap((b) => Array.from({ length: SCREENS_PER_BRIEF }, (_, idx) => ({ b, idx }))).filter((t) => !done.has(`${t.b.id}-${t.idx}`));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ch = CHANNELS[channel];
  try {
    await pool(tasks, Number(process.env.AES_CONC ?? 4), async ({ b, idx }) => {
      const { all, registry } = plannedFor(plans, b);
      const s = all[idx];
      const system = systemFor(cand, b, registry);
      const user = core.screenUserPrompt(s, all);
      const base = path.join(outDir, `${b.id}-${idx}`);
      const t0 = Date.now();
      const rec: Record<string, unknown> = { brief: b.id, idx, device: b.device, screen: { name: s.name, route: s.route, purpose: s.purpose }, variant: vname, channel, systemChars: system.length };
      try {
        const r = await completeWithRetry({ system, prompt: user, model: ch.model, spec: ch.spec, signal: AbortSignal.timeout(900_000) });
        const body = core.stripFences(r.text);
        const report = core.lintScreenBody(body, all.map((x) => x.route), true);
        const html = core.assembleDocument(core.injectQids(body), core.buildPrelude(projectDesign(b).tokens), `${b.name} · ${s.name}`);
        fs.writeFileSync(`${base}.html`, html);
        const shot = await shoot(browser, html, b.device, base);
        const byRule: Record<string, number> = {};
        for (const v of report.violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
        Object.assign(rec, { ok: true, ms: Date.now() - t0, tokensIn: r.tokensIn, tokensOut: r.tokensOut, chars: body.length, violations: report.violations.length, byRule, ...shot });
        console.log(`${vname}/${channel} ${b.id}-${idx} ok ${Math.round((Date.now() - t0) / 1000)}s ${body.length}ch v=${report.violations.length}`);
      } catch (e) {
        Object.assign(rec, { ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 300) });
        console.log(`${vname}/${channel} ${b.id}-${idx} FAIL ${(e as Error).message.slice(0, 160)}`);
      }
      // 首次失败另记一笔（重跑成功会覆盖这条记录，失败率要从这里算）
      if (!rec.ok) fs.appendFileSync(path.join(outDir, 'failures.log'), `${b.id}-${idx} ${rec.error}\n`);
      const i = manifest.findIndex((m) => m.brief === b.id && m.idx === idx);
      if (i >= 0) manifest[i] = rec; else manifest.push(rec);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    });
  } finally {
    await browser.close();
  }
}

// 盲评对：路径与文件名不带变体名（评审看得到路径）；每对两种左右顺序（o1 = A 在左，o2 = B 在左），映射只写进 pairs-<a>-vs-<b>-<channel>.json
function pairs(aArg: string, bArg: string, channel: Channel, label: string) {
  const a = loadVariant(aArg).name, b = loadVariant(bArg).name;
  const ma: Record<string, any>[] = JSON.parse(fs.readFileSync(path.join(DIR, 'out', a, channel, 'manifest.json'), 'utf8'));
  const mb: Record<string, any>[] = JSON.parse(fs.readFileSync(path.join(DIR, 'out', b, channel, 'manifest.json'), 'utf8'));
  const root = path.join(DIR, 'pairs', label, channel);
  fs.rmSync(root, { recursive: true, force: true });
  const list: Record<string, unknown>[] = [];
  let n = 0;
  for (const br of briefs) for (let idx = 0; idx < SCREENS_PER_BRIEF; idx++) {
    const ra = ma.find((m) => m.brief === br.id && m.idx === idx), rb = mb.find((m) => m.brief === br.id && m.idx === idx);
    if (!ra?.ok || !rb?.ok) { list.push({ brief: br.id, idx, skipped: true, why: `${a}:${ra?.ok ? 'ok' : ra?.error ?? 'missing'} ${b}:${rb?.ok ? 'ok' : rb?.error ?? 'missing'}` }); continue; }
    n += 1;
    const id = `${channel === 'gemini' ? 'g' : 's'}${String(n).padStart(2, '0')}`;
    for (const [order, left, right] of [['o1', a, b], ['o2', b, a]] as const) {
      const d = path.join(root, id, order);
      fs.mkdirSync(d, { recursive: true });
      for (const [side, v] of [['L', left], ['R', right]] as const) for (const f of ['top', 'scroll']) fs.copyFileSync(path.join(DIR, 'out', v, channel, `${br.id}-${idx}.${f}.jpg`), path.join(d, `${side}-${f}.jpg`));
    }
    list.push({ id, dir: path.join(root, id), brief: br.id, appName: br.name, appPrompt: br.prompt, device: br.device, idx, screen: ra.screen, o1: { L: a, R: b }, o2: { L: b, R: a } });
  }
  fs.writeFileSync(path.join(DIR, `pairs-${a}-vs-${b}-${channel}.json`), JSON.stringify(list, null, 2));
  console.log(`${list.filter((x) => !x.skipped).length} pairs, ${list.filter((x) => x.skipped).length} skipped → ${root}`);
}

// 用存下的 HTML 重拍（不再调模型）：reshoot <variant> <channel> [brief-idx …]，不给条目就重拍 manifest 里带渲染错误的
async function reshoot(variantArg: string, channel: Channel, items: string[]) {
  const { name: vname } = loadVariant(variantArg);
  const outDir = path.join(DIR, 'out', vname, channel);
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest: Record<string, any>[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const targets = items.length ? items : manifest.filter((m) => m.ok && (m.errors ?? []).some((e: string) => /not styled|tailwind is not defined/.test(e))).map((m) => `${m.brief}-${m.idx}`);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const t of targets) {
      const m = manifest.find((x) => `${x.brief}-${x.idx}` === t)!;
      const base = path.join(outDir, t);
      const shot = await shoot(browser, fs.readFileSync(`${base}.html`, 'utf8'), m.device, base);
      Object.assign(m, shot, { reshot: true });
      console.log(`${vname}/${channel} ${t} reshot attempts=${shot.attempts} errors=${JSON.stringify(shot.errors)}${shot.unstyled ? ' STILL UNSTYLED' : ''}`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// 页内统计用纯 JS 字符串传进去：tsx 会给具名内部函数包一层 __name()，浏览器里没有这个函数
const AUDIT_JS = `(() => {
  const rgba = (c) => { const n = (c.match(/[\\d.]+/g) || [0, 0, 0, 0]).map(Number); return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const behind = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c.a > 0.5) return c; } return { r: 255, g: 255, b: 255 }; };
  const contrast = (a, b) => { const x = Math.max(lum(a), lum(b)), y = Math.min(lum(a), lum(b)); return (x + 0.05) / (y + 0.05); };
  let lines = 0, heavyLines = 0, pills = 0, bigRadius = 0, shadows = 0, gradients = 0;
  const radii = new Set();
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none" || (el.closest("svg") && el.tagName.toLowerCase() !== "svg")) continue;
    const control = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const bg = rgba(cs.backgroundColor);
    const base = behind(el.parentElement);
    for (const side of ["top", "right", "bottom", "left"]) {
      const w = parseFloat(cs.getPropertyValue("border-" + side + "-width"));
      const st = cs.getPropertyValue("border-" + side + "-style");
      const col = rgba(cs.getPropertyValue("border-" + side + "-color"));
      const len = side === "top" || side === "bottom" ? r.width : r.height;
      if (!(w > 0) || st === "none" || col.a < 0.05 || len < 8 || control) continue;
      lines++;
      if (contrast(col, bg.a > 0.5 ? bg : base) >= 1.5) heavyLines++;
    }
    const shaped = (bg.a > 0.05 && contrast(bg, base) > 1.02) || parseFloat(cs.borderTopWidth) > 0 || el.tagName === "IMG";
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (shaped && rad > 0) {
      const half = Math.min(r.width, r.height) / 2;
      if (rad >= half - 0.5) { if (r.width >= 1.6 * r.height && r.height >= 12) pills++; }
      else { radii.add(Math.round(rad)); if (rad >= 12) bigRadius++; }
    }
    if (cs.boxShadow && cs.boxShadow !== "none") shadows++;
    if (/gradient/.test(cs.backgroundImage)) gradients++;
  }
  // wrapped = 被折成多行的短文本（≤ 24 字的单个文本节点跨了行）：表格里的人名、状态、操作链接、拆碎的元信息
  let wrapped = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || "").trim();
    if (!t || t.length > 24 || !n.parentElement || n.parentElement.closest("script,style")) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const tops = new Set(Array.from(rg.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top)));
    if (tops.size > 1) wrapped++;
  }
  return { lines, heavyLines, pills, bigRadius, shadows, gradients, wrapped, radii: Array.from(radii).sort((a, b) => a - b) };
})()`;

// 「AI 味」机械指标（TC-CORE-084 v0.92）：按渲染后的 DOM 数，与截图同一套就绪判定。逐屏记进 manifest 的 audit：
// lines = 可见的边框线段（每条边长 ≥ 8px 算一段，输入控件的边框不算），heavyLines = 其中对背后底色对比度 ≥ 1.5 的；
// pills = 胶囊形（圆角 ≥ 半高、宽 ≥ 1.6 倍高、高 ≥ 12px，头像与计数徽标宽高接近、不算）；bigRadius = 非胶囊非圆的形状圆角 ≥ 12px；
// shadows = 带阴影的可见元素；gradients = 背景用渐变的元素；wrapped = 折成多行的短文本（≤ 24 字）
async function audit(variantArg: string, channel: Channel) {
  const { name: vname } = loadVariant(variantArg);
  const outDir = path.join(DIR, 'out', vname, channel);
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest: Record<string, any>[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const m of manifest.filter((x) => x.ok)) {
      const size = core.DEVICE_SIZE[m.device as 'mobile' | 'desktop'];
      const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: 'light' });
      const page = await ctx.newPage();
      try {
        await page.setContent(core.withPaletteDarkMode(fs.readFileSync(path.join(outDir, `${m.brief}-${m.idx}.html`), 'utf8')), { waitUntil: 'networkidle', timeout: 25_000 }).catch(() => {});
        await page.waitForFunction(() => !!(window as unknown as { tailwind?: unknown }).tailwind && getComputedStyle(document.body).marginTop === '0px', undefined, { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(500);
        m.audit = await page.evaluate(AUDIT_JS);
      } finally {
        await ctx.close();
      }
      console.log(`${vname}/${channel} ${m.brief}-${m.idx} ${JSON.stringify(m.audit)}`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'audit') await audit(rest[0], rest[1] as Channel);
else if (cmd === 'reshoot') await reshoot(rest[0], rest[1] as Channel, rest.slice(2));
else if (cmd === 'plan') await plan();
else if (cmd === 'gen') await gen(rest[0], rest[1] as Channel, rest.slice(2));
else if (cmd === 'pairs') pairs(rest[0], rest[1], rest[2] as Channel, rest[3]);
else if (cmd === 'sysprompt') {
  const plans: Record<string, Plan> = JSON.parse(fs.readFileSync(path.join(HERE, 'plans.json'), 'utf8'));
  const b = briefs.find((x) => x.id === rest[1])!;
  console.log(systemFor(loadVariant(rest[0]).cand, b, plannedFor(plans, b).registry));
} else { console.error('usage: plan | gen <variant> <channel> [ids] | pairs <a> <b> <channel> <label> | sysprompt <variant> <briefId>'); process.exit(2); }
process.exit(0);
