import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'playwright';
import { launch, seed, seedJson, apiJson, assertTestApi, EVIDENCE, WEB, API, eventually } from './lib.ts';
import { startOpenAiStub } from './openai-stub.ts';
import { connectMcp, callTool } from './mcp-client.ts';
import { suite, expect, softly, waitJob, type JobView } from './harness.ts';

// docs/TEST.md CORE 域 · 界面语言（REQ-CORE-046，TC-CORE-130～136）AI 执行脚本。
// 浏览器上下文按用例给 locale（lib.ts 给的缺省是 zh-CN，这里显式传的照传）；每条用例自己开上下文、用完关掉，本机记录（localStorage）不带到下一条。
// 桩通道用 3941 / 3942 两个端口，别的套件没用它们，几条 lane 同时跑也撞不上
await mkdir(EVIDENCE, { recursive: true });
let page: Page | undefined;
const { step, summary, cleanups } = suite('I18N', { page: () => page });

type Seeded = { projectId: string; screens: { id: string; route: string }[] };
type Problem = { type: string; title: string; status: number; errors?: { path: string; message: string }[] };
type Msg = { role: string; content: string; jobId: string | null };
const STUB = { kind: 'model', driver: 'stub', model: 'stub' };
const VIEWPORT = { width: 1440, height: 900 };
// 中文字符与中文标点（含全角符号）：英文界面上不该出现
const HAN = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
// 提示词末尾的语言要求（@quilt/core 的 uiLanguageRule）：用例按设计文档的说法逐字认
const rule = (lang: string) => `LANGUAGE: unless the request explicitly asks for a language, write all visible text on the screen in ${lang}. This takes precedence over any other language rule above.`;

seed('seed');
const browser = await launch();

// 新开一个浏览器上下文（本机记录是空的）；stored 给了就先在同源页面写进 localStorage 的 quilt:locale。
// 记下页面发往 /v1/ 的 fetch / xhr 请求带的 X-Quilt-Locale（项目事件流是 EventSource，带不了自定义头，按设计不算在内）
async function openPage(locale: string, stored?: string) {
  const ctx = await browser.newContext({ locale, viewport: VIEWPORT });
  cleanups.push(() => ctx.close());
  const pg = await ctx.newPage();
  page = pg;
  const sent: { path: string; locale: string | undefined }[] = [];
  pg.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/v1/') || !['fetch', 'xhr'].includes(r.resourceType())) return;
    void r.allHeaders().then((h) => sent.push({ path: u.pathname, locale: h['x-quilt-locale'] })).catch(() => {});
  });
  if (stored) {
    await pg.goto(`${WEB}/v1/health`);
    await pg.evaluate((v) => localStorage.setItem('quilt:locale', v), stored);
  }
  return { ctx, pg, sent };
}
const openCanvas = async (pg: Page, projectId: string, query = '') => {
  await pg.goto(`${WEB}/p/${projectId}${query}`);
  await pg.locator('[data-testid="screen-card"]').first().waitFor({ timeout: 15000 });
  await pg.getByTestId('open-settings').waitFor({ timeout: 10000 });
};
const htmlLang = (pg: Page) => pg.evaluate(() => document.documentElement.lang);
// 字阶跟着 <html lang> 换（§13.1）：中文时正文 PingFang SC 在前、行高 1.6，英文时西文字体在前、行高 1.5
const bodyType = (pg: Page) => pg.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return { font: cs.getPropertyValue('--semantic-typography-body-font-family').trim(), lineHeight: cs.getPropertyValue('--semantic-typography-body-line-height').trim() };
});
// 页面上还剩哪些中文：文字节点（含读屏专用的 sr-only）与 aria-label / title / placeholder / alt；
// 标了 lang="zh…" 的元素（设置里的语言名「中文」）是有意用中文写的，跳过。iframe 里是用户的屏，不在这里。
// 页面里执行的函数不能再声明具名函数：tsx 给它们包的 __name 在页面里不存在
const chineseLeft = (pg: Page) => pg.evaluate((src) => {
  const re = new RegExp(src);
  const zh = /^zh/i;
  const out = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').trim();
    const el = n.parentElement;
    if (!text || !re.test(text) || !el || el.closest('script, style, noscript, template')) continue;
    const l = el.closest('[lang]');
    if (l && l !== document.documentElement && zh.test(l.getAttribute('lang') ?? '')) continue;
    out.add(text.slice(0, 60));
  }
  for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) {
    const l = el.closest('[lang]');
    if (l && l !== document.documentElement && zh.test(l.getAttribute('lang') ?? '')) continue;
    for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
      const v = el.getAttribute(a);
      if (v && re.test(v)) out.add(`${a}=${v.slice(0, 60)}`);
    }
  }
  return [...out];
}, HAN.source);
const tabTexts = async (pg: Page) => (await pg.locator('[data-testid^="settings-tab-"]').allInnerTexts()).map((s) => s.trim());
// 从工具栏「设置」进「语言」节点一种语言，再按 Esc 关掉弹层
async function switchLocale(pg: Page, to: 'zh' | 'en') {
  await pg.getByTestId('open-settings').click();
  await pg.getByTestId('settings-modal').waitFor({ timeout: 5000 });
  await pg.getByTestId('settings-tab-language').click();
  await pg.getByTestId(`locale-${to}`).click();
  await pg.keyboard.press('Escape');
  await pg.getByTestId('settings-modal').waitFor({ state: 'detached', timeout: 5000 });
}
const currentRev = async (projectId: string, screenId: string) => {
  const s = (await apiJson<{ screens: { id: string; currentRevisionId: string }[] }>(`/v1/projects/${projectId}`)).body.screens.find((x) => x.id === screenId)!;
  const r = await apiJson<{ revision: { htmlUrl: string } }>(`/v1/screens/${screenId}/revisions/${s.currentRevisionId}`);
  return { id: s.currentRevisionId, html: await (await fetch(r.body.revision.htmlUrl)).text() };
};
const h1Qid = (html: string) => html.match(/<h1\b[^>]*>/)?.[0].match(/data-qid="(q\d+)"/)?.[1] ?? [...html.matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]).at(-1)!;
const assistantOf = async (projectId: string, jobId: string) =>
  (await apiJson<{ items: Msg[] }>(`/v1/projects/${projectId}/messages?limit=100`)).body.items.find((m) => m.jobId === jobId && m.role === 'assistant')?.content ?? '';
// 真正不带任何头的请求（curl 那样）：Node 的 fetch 缺省会带 Accept-Language: *
const bare = (path: string) => new Promise<{ status: number; body: Problem }>((resolve, reject) => {
  const u = new URL(path, API);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { host: u.host } }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Problem }));
  });
  req.on('error', reject);
  req.end();
});
// MCP 客户端带上自定义请求头（connectMcp 不带）：动手前同样先认库
async function mcpWith(headers: Record<string, string>) {
  await assertTestApi();
  const client = new Client({ name: 'quilt-tests-i18n', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers } }));
  return client;
}
// OpenAI 兼容桩通道：单屏规划回一屏（每次一个新路由，几轮造屏互不撞路由），其余回一屏 HTML；记下每次请求的系统提示
async function stubChannel(port: number, label: string) {
  const key = `good-key-${port}`;
  let n = 0;
  const stub = startOpenAiStub({
    port, apiKey: key,
    reply: (hit) => (hit.user.includes('Requested screen:')
      ? JSON.stringify({ name: `Login ${++n}`, route: `/login-${n}`, purpose: 'sign in', links: [], sections: ['form'], entryFrom: null })
      : '<div class="min-h-dvh bg-background p-6"><h1 class="text-xl font-semibold">Login</h1><button type="button" class="mt-4 h-12 px-6 rounded-full bg-primary text-on-primary">Sign in</button></div>'),
  });
  let id = '';
  cleanups.push(async () => { if (id) await apiJson(`/v1/channels/${id}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  id = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label, endpoint: stub.url, model: `stub-${port}`, apiKey: key }) })).body.channel.id;
  const probe = await apiJson<{ ok: boolean }>(`/v1/runners/channel:${id}/probe`, { method: 'POST' });
  expect(probe.body.ok === true, `桩通道验证未通过：${JSON.stringify(probe.body)}`);
  return { stub, runner: { kind: 'channel', channelId: id } };
}

// TC-CORE-130 缺省语言跟随浏览器（REQ-CORE-046；PAGE-CANVAS 设置弹层「语言」、§13.1 字体与字阶）
await step('TC-CORE-130', async () => {
  const { projectId } = seedJson<Seeded>('seed:project', '--name', 'Locale', '--device', 'mobile', '--screens', '2', '--no-shot');
  const S = softly();
  const look = async (locale: string, stored?: string) => {
    const { pg, sent } = await openPage(locale, stored);
    await openCanvas(pg, projectId);
    await pg.waitForTimeout(800); // 首屏的请求发完再数
    return { pg, sent, lang: await htmlLang(pg), type: await bodyType(pg), settings: await pg.getByTestId('open-settings').getAttribute('aria-label') };
  };
  // 1 en-US：英文界面、<html lang="en">、西文字阶；页面上没有中文；发往 /v1 的请求都带 X-Quilt-Locale: en
  const en = await look('en-US');
  await S.check(() => expect(en.lang === 'en', `① en-US 下 <html lang> 应为 en：${en.lang}`));
  await S.check(() => expect(en.settings === 'Settings', `① 工具栏「设置」应写 Settings：${en.settings}`));
  await S.check(() => expect(en.type.font.startsWith('-apple-system') && en.type.lineHeight === '1.5', `① 英文时正文应西文字体在前、行高 1.5：${JSON.stringify(en.type)}`));
  const left = await chineseLeft(en.pg);
  await S.check(() => expect(left.length === 0, `① 英文界面上还有中文 ${left.length} 处：${left.slice(0, 10).join(' ｜ ')}`));
  await S.check(() => expect(en.sent.length >= 3 && en.sent.every((s) => s.locale === 'en'), `① /v1 请求应都带 X-Quilt-Locale: en：${JSON.stringify(en.sent.filter((s) => s.locale !== 'en').slice(0, 5))}（共 ${en.sent.length} 个）`));
  // 2 zh-CN：中文界面、<html lang="zh-CN">、中文字阶；请求都带 zh
  const zh = await look('zh-CN');
  await S.check(() => expect(zh.lang === 'zh-CN', `② zh-CN 下 <html lang> 应为 zh-CN：${zh.lang}`));
  await S.check(() => expect(zh.settings === '设置', `② 工具栏「设置」应写「设置」：${zh.settings}`));
  await S.check(() => expect(zh.type.font.startsWith('PingFang SC') && zh.type.lineHeight === '1.6', `② 中文时正文应 PingFang SC 在前、行高 1.6：${JSON.stringify(zh.type)}`));
  await S.check(() => expect(zh.sent.length >= 3 && zh.sent.every((s) => s.locale === 'zh'), `② /v1 请求应都带 X-Quilt-Locale: zh：${JSON.stringify(zh.sent.filter((s) => s.locale !== 'zh').slice(0, 5))}（共 ${zh.sent.length} 个）`));
  // 量具自检：同一个扫描在中文界面上要扫得出中文，第 1 步的「没有中文」才算数
  await S.check(async () => expect((await chineseLeft(zh.pg)).length > 0, '② 中文界面上扫不出中文：扫描本身失效'));
  // 3 只看语言列表的第一项是不是 zh 开头：zh-TW 中文、ja-JP 英文
  const tw = await look('zh-TW');
  await S.check(() => expect(tw.lang === 'zh-CN' && tw.settings === '设置', `③ zh-TW 应是中文界面：lang=${tw.lang} 设置=${tw.settings}`));
  const ja = await look('ja-JP');
  await S.check(() => expect(ja.lang === 'en' && ja.settings === 'Settings', `③ ja-JP 应是英文界面：lang=${ja.lang} 设置=${ja.settings}`));
  // 4 本机选过的优先于浏览器语言；记录的值不认识时按浏览器
  const chosen = await look('zh-CN', 'en');
  await S.check(() => expect(chosen.lang === 'en' && chosen.settings === 'Settings' && chosen.sent.every((s) => s.locale === 'en'), `④ 浏览器 zh-CN、本机记为 en 时应是英文：lang=${chosen.lang} 设置=${chosen.settings} 请求=${[...new Set(chosen.sent.map((s) => s.locale))].join(',')}`));
  const bogus = await look('en-US', 'fr');
  await S.check(() => expect(bogus.lang === 'en' && bogus.settings === 'Settings', `④ 本机记录是 fr（不认识）时应按浏览器 en-US：lang=${bogus.lang} 设置=${bogus.settings}`));
  S.done();
  return `en-US 下 ${en.sent.length} 个 /v1 请求都带 en；zh-TW 中文、ja-JP 英文；本机记录优先`;
});

// TC-CORE-131 设置里切换语言即时生效、刷新后记住、对所有页面生效（REQ-CORE-046；PAGE-CANVAS 设置弹层「语言」）
await step('TC-CORE-131', async () => {
  const { projectId } = seedJson<Seeded>('seed:project', '--name', 'Switch', '--device', 'mobile', '--screens', '2', '--no-shot');
  const S = softly();
  const { ctx, pg, sent } = await openPage('en-US');
  // 1 ?settings=language：左栏四节英文、「Language」选中；两个选项各用自己的文字写、标 lang；English 选中；四节逐节看都没有中文（语言名「中文」除外）
  await openCanvas(pg, projectId, '?settings=language');
  const modal = pg.getByTestId('settings-modal');
  await modal.waitFor({ timeout: 5000 });
  await S.check(async () => expect(JSON.stringify(await tabTexts(pg)) === JSON.stringify(['Usage this month', 'Channels', 'Appearance', 'Language']), `① 左栏应是四节英文：${JSON.stringify(await tabTexts(pg))}`));
  await S.check(async () => expect((await pg.getByTestId('settings-tab-language').getAttribute('aria-selected')) === 'true', '① 「Language」应是选中的那一节'));
  await S.check(async () => expect((await pg.locator('#settings-title').innerText()).trim() === 'Settings', `① 弹层标题应是 Settings：${await pg.locator('#settings-title').innerText()}`));
  await S.check(async () => {
    const zhOpt = (await pg.getByTestId('locale-zh').locator('span[lang="zh-CN"]').innerText()).trim();
    const enOpt = (await pg.getByTestId('locale-en').locator('span[lang="en"]').innerText()).trim();
    expect(zhOpt === '中文' && enOpt === 'English', `① 选项应写「中文」（lang=zh-CN）与「English」（lang=en）：${zhOpt} / ${enOpt}`);
  });
  await S.check(async () => expect(await pg.getByTestId('locale-en').locator('input').isChecked() && !(await pg.getByTestId('locale-zh').locator('input').isChecked()), '① 应是 English 选中'));
  await S.check(async () => expect((await pg.getByTestId('language').innerText()).includes('Screens you generate from now on are written in this language too'), '① 「Language」一节的说明应写明之后生成的屏也用这种语言'));
  for (const sec of ['usage', 'runners', 'appearance', 'language']) {
    await pg.getByTestId(`settings-tab-${sec}`).click();
    await pg.getByTestId(sec).waitFor({ timeout: 5000 });
    if (sec === 'usage') await pg.getByTestId('usage-totals').waitFor({ timeout: 10000 }).catch(() => {});
    if (sec === 'runners') await pg.getByTestId('channel-manager').waitFor({ timeout: 10000 }).catch(() => {});
    await pg.waitForTimeout(600);
    const left = await chineseLeft(pg);
    await S.check(() => expect(left.length === 0, `① 设置「${sec}」一节还有中文 ${left.length} 处：${left.slice(0, 10).join(' ｜ ')}`));
  }
  // 2 点「中文」：不刷新页面，当场换成中文，<html lang="zh-CN">，本机记为 zh；之后的请求带 zh
  await pg.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1; });
  await pg.getByTestId('locale-zh').click();
  await S.check(() => eventually(async () => expect((await htmlLang(pg)) === 'zh-CN', `② 点「中文」后 <html lang> 应为 zh-CN：${await htmlLang(pg)}`), 3000));
  await S.check(async () => expect((await pg.locator('#settings-title').innerText()).trim() === '设置' && JSON.stringify(await tabTexts(pg)) === JSON.stringify(['本月用量', '生成通道', '外观', '语言']), `② 弹层应当场换成中文：${await pg.locator('#settings-title').innerText()} ${JSON.stringify(await tabTexts(pg))}`));
  await S.check(async () => expect((await pg.evaluate(() => localStorage.getItem('quilt:locale'))) === 'zh', `② 本机应记为 zh：${await pg.evaluate(() => localStorage.getItem('quilt:locale'))}`));
  await S.check(async () => expect((await pg.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)) === 1 && pg.url().includes('settings=language'), `② 切换不该刷新页面：${pg.url()}`));
  await S.check(async () => expect(await pg.getByTestId('locale-zh').locator('input').isChecked(), '② 「中文」应变成选中'));
  const from = sent.length;
  await pg.getByTestId('settings-tab-runners').click();
  await pg.getByTestId('channel-manager').waitFor({ timeout: 10000 }).catch(() => {});
  await S.check(() => eventually(() => expect(sent.length > from, '② 切到「生成通道」应发出新请求'), 5000));
  await S.check(() => expect(sent.slice(from).every((s) => s.locale === 'zh'), `② 切换后的请求应带 X-Quilt-Locale: zh：${JSON.stringify(sent.slice(from))}`));
  // 3 刷新：仍是中文，「中文」选中
  await pg.reload();
  await modal.waitFor({ timeout: 10000 });
  await S.check(async () => expect((await htmlLang(pg)) === 'zh-CN' && (await pg.locator('#settings-title').innerText()).trim() === '设置', `③ 刷新后应仍是中文：lang=${await htmlLang(pg)}`));
  await pg.getByTestId('settings-tab-language').click();
  await S.check(async () => expect(await pg.getByTestId('locale-zh').locator('input').isChecked(), '③ 刷新后「中文」应仍是选中'));
  // 4 点「English」换回；同一浏览器里打开草稿本也是英文
  await pg.getByTestId('locale-en').click();
  await S.check(() => eventually(async () => expect((await htmlLang(pg)) === 'en' && (await pg.evaluate(() => localStorage.getItem('quilt:locale'))) === 'en', `④ 点「English」后应换回英文、本机记为 en：lang=${await htmlLang(pg)}`), 3000));
  const sketch = await ctx.newPage();
  page = sketch;
  await sketch.goto(`${WEB}/sketch`);
  await sketch.getByTestId('sketch-page').waitFor({ timeout: 15000 });
  await sketch.waitForTimeout(800);
  await S.check(async () => expect((await htmlLang(sketch)) === 'en', `④ 草稿本页应也是英文：${await htmlLang(sketch)}`));
  const leftSketch = await chineseLeft(sketch);
  await S.check(() => expect(leftSketch.length === 0, `④ 英文的草稿本页上还有中文 ${leftSketch.length} 处：${leftSketch.slice(0, 10).join(' ｜ ')}`));
  S.done();
  return '切换不刷新、刷新后记住、草稿本跟着换';
});

// TC-CORE-132 接口错误文案按请求的界面语言（REQ-CORE-046；§8 开头、§14）
await step('TC-CORE-132', async () => {
  await assertTestApi();
  const S = softly();
  const missing = `/v1/projects/${crypto.randomUUID()}`;
  const get = async (headers: Record<string, string>) => { const r = await fetch(`${API}${missing}`, { headers }); return { status: r.status, body: (await r.json()) as Problem }; };
  const ZH = '资源不存在'; const EN = 'Not found';
  // 1 不带语言头（真不带、以及只有 *）：中文
  const none = await bare(missing);
  await S.check(() => expect(none.status === 404 && none.body.type === '/errors/not-found' && none.body.title === ZH, `① 不带任何头应 404 + 中文 title：${none.status} ${JSON.stringify(none.body)}`));
  const star = await get({ 'Accept-Language': '*' });
  await S.check(() => expect(star.body.title === ZH, `① Accept-Language: * 应按没有处理、中文：${star.body.title}`));
  // 2-4 判定表：X-Quilt-Locale 优先（不分大小写，别的值当没有），其次 Accept-Language 优先级最高的一项
  const cases: [string, Record<string, string>, string][] = [
    ['②', { 'X-Quilt-Locale': 'en' }, EN],
    ['②', { 'X-Quilt-Locale': 'EN' }, EN],
    ['③', { 'Accept-Language': 'en-US,en;q=0.9' }, EN],
    ['③', { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, ZH],
    ['③', { 'Accept-Language': 'en;q=0.5, zh-TW;q=0.8' }, ZH],
    ['③', { 'Accept-Language': 'fr-FR' }, EN],
    ['④', { 'X-Quilt-Locale': 'zh', 'Accept-Language': 'en-US' }, ZH],
    ['④', { 'X-Quilt-Locale': 'fr', 'Accept-Language': 'en-US' }, EN],
    ['④', { 'X-Quilt-Locale': 'fr' }, ZH],
  ];
  for (const [no, headers, want] of cases) {
    const r = await get(headers);
    await S.check(() => expect(r.status === 404 && r.body.type === '/errors/not-found' && r.body.status === 404 && r.body.title === want, `${no} ${JSON.stringify(headers)} 应得「${want}」：${r.status} ${JSON.stringify(r.body)}`));
    await S.check(() => expect(JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(Object.keys(none.body).sort()), `${no} 换语言不该改字段：${Object.keys(r.body).join(',')} vs ${Object.keys(none.body).join(',')}`));
  }
  // 5 校验错误：title 与 errors[].message 换语言，type、status、errors[].path 不变
  const badChannel = JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'No endpoint', model: 'm-1', apiKey: 'k-0001' });
  const vEn = await apiJson<Problem>('/v1/channels', { method: 'POST', body: badChannel, headers: { 'X-Quilt-Locale': 'en' } });
  const vZh = await apiJson<Problem>('/v1/channels', { method: 'POST', body: badChannel });
  await S.check(() => expect(vEn.status === 400 && vEn.body.type === '/errors/validation' && vEn.body.title === 'Invalid request parameters' && vEn.body.errors?.[0]?.message === 'OpenAI-compatible channels need an endpoint', `⑤ 英文的校验错误不对：${vEn.status} ${JSON.stringify(vEn.body)}`));
  await S.check(() => expect(vZh.status === 400 && vZh.body.type === '/errors/validation' && vZh.body.title === '请求参数不合法' && vZh.body.errors?.[0]?.message === 'OpenAI 兼容通道必须填端点', `⑤ 不带语言头的校验错误应是中文：${vZh.status} ${JSON.stringify(vZh.body)}`));
  await S.check(() => expect(JSON.stringify(vEn.body.errors?.map((e) => e.path)) === JSON.stringify(vZh.body.errors?.map((e) => e.path)) && vEn.body.errors?.[0]?.path === 'endpoint', `⑤ errors[].path 应两边一样且是 endpoint：${JSON.stringify(vEn.body.errors)} / ${JSON.stringify(vZh.body.errors)}`));
  // 6 来源校验拒掉的请求也按语言出文案（语言先于来源校验定下来）
  const fEn = await fetch(`${API}/v1/projects`, { headers: { Origin: 'http://evil.example', 'X-Quilt-Locale': 'en' } });
  const fEnBody = (await fEn.json()) as Problem;
  const fZh = await fetch(`${API}/v1/projects`, { headers: { Origin: 'http://evil.example' } });
  const fZhBody = (await fZh.json()) as Problem;
  await S.check(() => expect(fEn.status === 403 && fEnBody.type === '/errors/forbidden' && fEnBody.title === 'Request origin is not on the local allowlist (Host / Origin)', `⑥ 名单外来源 + en 应 403 英文：${fEn.status} ${JSON.stringify(fEnBody)}`));
  await S.check(() => expect(fZh.status === 403 && fZhBody.title === '请求来源不在本机名单（Host / Origin）', `⑥ 名单外来源不带语言头应 403 中文：${fZh.status} ${JSON.stringify(fZhBody)}`));
  // 7 MCP 同一判定：缺省客户端（不带语言头）中文；带 X-Quilt-Locale: en 的英文
  const plain = await connectMcp();
  const en = await mcpWith({ 'X-Quilt-Locale': 'en' });
  cleanups.push(() => plain.close(), () => en.close());
  const id = crypto.randomUUID();
  const mZh = await callTool(plain, 'quilt.get_project', { projectId: id });
  const mEn = await callTool(en, 'quilt.get_project', { projectId: id });
  await S.check(() => expect(mZh.isError && (mZh.json as Problem).type === '/errors/not-found' && (mZh.json as Problem).title === ZH, `⑦ MCP 缺省应中文：${mZh.text.slice(0, 200)}`));
  await S.check(() => expect(mEn.isError && (mEn.json as Problem).type === '/errors/not-found' && (mEn.json as Problem).title === EN, `⑦ MCP 带 X-Quilt-Locale: en 应英文：${mEn.text.slice(0, 200)}`));
  S.done();
  return `判定表 ${cases.length + 2} 种头、校验错误、来源校验、MCP 都对`;
});

// TC-CORE-133 作业失败 chip 的英文文案、切语言跟着换（REQ-CORE-046；§14 作业失败文案、PAGE-CANVAS「作业 chip」）
await step('TC-CORE-133', async () => {
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Fails EN', '--device', 'mobile', '--screens', '2', '--no-shot');
  const [s1] = screens;
  const S = softly();
  // 桩：Key 不对回 401；每个回应拖 2.5 s，让画布先认领作业再收到失败（同 TC-CORE-045）
  const stub = startOpenAiStub({ port: 3941, apiKey: 'good-key-0133', holdMs: 2500, reply: 'OK' });
  let chId = '';
  cleanups.push(async () => { if (chId) await apiJson(`/v1/channels/${chId}`, { method: 'DELETE' }).catch(() => {}); stub.server.closeAllConnections(); await stub.close(); });
  chId = (await apiJson<{ channel: { id: string } }>('/v1/channels', { method: 'POST', body: JSON.stringify({ kind: 'openai', vendor: 'custom', label: 'Bad key 133', endpoint: stub.url, model: 'stub-133', apiKey: 'wrong-key-0133' }) })).body.channel.id;
  const runner = { kind: 'channel', channelId: chId };
  const { pg } = await openPage('en-US');
  await openCanvas(pg, projectId);
  const chipOf = (id: string) => pg.locator(`[data-testid="job-chip"][data-job-id="${id}"]`);
  const failed = async (id: string) => {
    const chip = chipOf(id);
    await chip.waitFor({ timeout: 20000 });
    await eventually(async () => expect((await chip.getAttribute('data-state')) === 'failed', `作业 ${id} 的 chip 没转失败：${await chip.getAttribute('data-state')}`), 40000);
    return chip;
  };
  // 1 改屏（别处发的一轮，能重试）撞 401：英文 chip，只写原因不写下一步，按钮写 Retry
  const msg = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: idem(), body: JSON.stringify({ content: 'make it dark', targetScreenIds: [s1.id], runner }) });
  expect(msg.status === 202, `发改屏 ${msg.status} ${JSON.stringify(msg.body).slice(0, 160)}`);
  const chip1 = await failed(msg.body.job.id);
  const t1 = flat(await chip1.locator('[role="status"]').innerText());
  await S.check(() => expect(t1 === 'Edit “Screen 1” · Edit failed: the channel’s key was rejected (HTTP 401).', `① 改屏失败 chip 的英文不对：${t1}`));
  await S.check(async () => { const b = chip1.getByTestId('retry-job'); expect((await b.innerText()).trim() === 'Retry' && (await b.getAttribute('aria-label')) === 'Retry: Edit “Screen 1”', `① 「重试」应写 Retry、标签 Retry: Edit “Screen 1”：${await b.innerText()} / ${await b.getAttribute('aria-label')}`); });
  await S.check(async () => expect((await chip1.getByTestId('dismiss-job').getAttribute('aria-label')) === 'Dismiss failure notice: Edit “Screen 1”', `① × 的标签不对：${await chip1.getByTestId('dismiss-job').getAttribute('aria-label')}`));
  await S.check(async () => expect((await pg.getByTestId('job-chips').getAttribute('aria-label')) === 'Jobs', `① 整叠的标签应是 Jobs：${await pg.getByTestId('job-chips').getAttribute('aria-label')}`));
  // 2 重生成一块（不能重试）撞 401：英文的原因 + 下一步（检查 Key、再点一次 Regenerate block），只有 ×
  const cur = await currentRev(projectId, s1.id);
  const qid = [...cur.html.matchAll(/data-qid="(q\d+)"/g)].map((m) => m[1]).at(-1)!;
  const sub = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: s1.id, qid, prompt: 'make it a tagline', expectedRevisionId: cur.id, runner } }) });
  expect(sub.status === 202, `建重生成一块 ${sub.status} ${JSON.stringify(sub.body).slice(0, 160)}`);
  const chip2 = await failed(sub.body.job.id);
  const t2 = flat(await chip2.locator('[role="status"]').innerText());
  await S.check(() => expect(t2 === 'Regenerate block in “Screen 1” · Regenerating this block failed: the channel’s key was rejected (HTTP 401). Check this channel’s key in Settings → Channels or switch to another channel, then click “Regenerate block” in the Inspector again', `② 重生成一块失败 chip 的英文不对：${t2}`));
  await S.check(async () => expect((await chip2.getByTestId('retry-job').count()) === 0 && (await chip2.getByTestId('dismiss-job').count()) === 1, '② 不能重试的 chip 上应只有 ×'));
  const chipsText = flat(await pg.getByTestId('job-chips').innerText());
  await S.check(() => expect(!HAN.test(chipsText), `①② 英文界面的作业 chip 里不该有中文：${chipsText}`));
  // 3 换成中文：两枚失败 chip 留着，文字当场换成中文
  await switchLocale(pg, 'zh');
  await S.check(() => eventually(async () => { const t = flat(await chip1.locator('[role="status"]').innerText()); expect(t === '改「Screen 1」 · 改屏失败：通道的 Key 被拒绝（HTTP 401）。', `③ 换中文后改屏 chip 不对：${t}`); }, 3000));
  await S.check(() => eventually(async () => { const t = flat(await chip2.locator('[role="status"]').innerText()); expect(t === '重生成「Screen 1」的一块 · 重做这一块失败：通道的 Key 被拒绝（HTTP 401）。到「设置 → 生成通道」检查这条通道的 Key 或换一个通道，然后在检查器里再点一次「重生成这块」', `③ 换中文后重生成一块 chip 不对：${t}`); }, 3000));
  await S.check(async () => expect((await chip1.getByTestId('retry-job').innerText()).trim() === '重试', `③ 「重试」应换成中文：${await chip1.getByTestId('retry-job').innerText()}`));
  S.done();
  return '两枚失败 chip 英文正确，换中文后当场换字';
});

// TC-CORE-134 预览运行时的修改标记用界面语言（REQ-CORE-046；§13.1「画布标记」）
await step('TC-CORE-134', async () => {
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Marks EN', '--device', 'mobile', '--screens', '1', '--no-shot');
  const [s1] = screens;
  const S = softly();
  const { pg } = await openPage('en-US');
  await openCanvas(pg, projectId);
  await pg.locator(`[data-testid="screen-card"][data-route="${s1.route}"] .gesture`).dblclick();
  await pg.locator('.card.focused .badge', { hasText: 'Interactive' }).waitFor({ timeout: 20000 });
  const fl = pg.frameLocator('.card.focused iframe');
  await fl.locator('h1').first().waitFor({ timeout: 15000 });
  const working = fl.locator('[data-quilt-mark][data-kind="working"]');
  const done = fl.locator('[data-quilt-mark][data-kind="done"]');
  // 经接口建一个拖住的重生成一块（stub 认 [stub-hold]），画布从项目事件流认出它在改哪一块
  const regen = async (holdMs: number) => {
    const cur = await currentRev(projectId, s1.id);
    const r = await apiJson<{ job: { id: string } }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: idem(), body: JSON.stringify({ kind: 'regenerate_subtree', input: { screenId: s1.id, qid: h1Qid(cur.html), prompt: `[stub-hold:${holdMs}] make the title bold`, expectedRevisionId: cur.id, runner: STUB } }) });
    expect(r.status === 202, `建重生成一块 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    return r.body.job.id;
  };
  // 1 改着的那一块挂「Editing…」
  const j1 = await regen(6000);
  await working.waitFor({ timeout: 10000 });
  await S.check(async () => expect((await working.textContent())?.trim() === 'Editing…', `① 修改中的角标应写 Editing…：${await working.textContent()}`));
  // 2 改完挂「Updated」
  const r1 = await waitJob(j1, 60);
  expect(r1.status === 'succeeded', `重生成一块 ${r1.status}：${JSON.stringify(r1.output).slice(0, 200)}`);
  await done.waitFor({ timeout: 8000 });
  await S.check(async () => expect((await done.first().textContent())?.trim() === 'Updated', `② 改完的角标应写 Updated：${await done.first().textContent()}`));
  await done.first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  // 3 改着的时候换成中文：不退出交互，屏里的角标当场换成「修改中…」，改完是「已更新」
  const j2 = await regen(15000);
  await working.waitFor({ timeout: 10000 });
  await S.check(async () => expect((await working.textContent())?.trim() === 'Editing…', `③ 换语言前角标应写 Editing…：${await working.textContent()}`));
  await switchLocale(pg, 'zh');
  await S.check(() => pg.locator('.card.focused .badge', { hasText: '交互中' }).waitFor({ timeout: 5000 }).catch(() => { throw new Error('③ 换语言后应仍在交互中（角标「交互中」）'); }));
  await S.check(() => eventually(async () => expect((await working.textContent())?.trim() === '修改中…', `③ 换中文后角标应当场写「修改中…」：${await working.textContent()}`), 5000));
  const r2 = await waitJob(j2, 60);
  expect(r2.status === 'succeeded', `重生成一块 ${r2.status}：${JSON.stringify(r2.output).slice(0, 200)}`);
  await S.check(() => done.first().waitFor({ timeout: 8000 }).catch(() => { throw new Error('③ 改完没挂「已更新」角标'); }));
  await S.check(async () => expect((await done.first().textContent())?.trim() === '已更新', `③ 改完的角标应写「已更新」：${await done.first().textContent()}`));
  S.done();
  return 'Editing… / Updated；换中文后当场换成 修改中… / 已更新';
});

// TC-CORE-135 带 X-Quilt-Locale 的写屏作业记下界面语言、提示词补语言要求；不带的不记（REQ-CORE-046；API-CORE-006 界面语言、ENT-GenerationJob input.locale）
await step('TC-CORE-135', async () => {
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Locale Jobs', '--device', 'mobile', '--screens', '1', '--no-shot');
  const [s1] = screens;
  const S = softly();
  const { stub, runner } = await stubChannel(3942, 'Stub 语言');
  const send = async (headers: Record<string, string>, body: Record<string, unknown> = {}) => {
    const from = stub.hits.length;
    const r = await apiJson<{ job: JobView }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { ...idem(), ...headers }, body: JSON.stringify({ content: '做一个登录页', runner, ...body }) });
    expect(r.status === 202, `发消息 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const job = await waitJob(r.body.job.id, 120);
    return { created: r.body.job, job, hits: stub.hits.slice(from), receipt: await assistantOf(projectId, job.id) };
  };
  const endsWithRule = (hits: { system: string }[], lang: string) => hits.length >= 1 && hits.every((h) => h.system.trimEnd().endsWith(rule(lang)));
  const noRule = (hits: { system: string }[]) => hits.length >= 1 && hits.every((h) => !h.system.includes('LANGUAGE:'));
  // 1 X-Quilt-Locale: en 造屏：input.locale=en，每次调用的系统提示末尾要求英文，回执是英文
  const en = await send({ 'X-Quilt-Locale': 'en' });
  await S.check(() => expect(en.created.kind === 'generate' && en.created.input.locale === 'en', `① 作业 input.locale 应为 en：${JSON.stringify(en.created.input)}`));
  await S.check(() => expect(en.job.status === 'succeeded', `① 作业 ${en.job.status}：${JSON.stringify(en.job.output).slice(0, 200)}`));
  await S.check(() => expect(en.hits.length >= 2 && endsWithRule(en.hits, 'English'), `① ${en.hits.length} 次调用的系统提示末尾应都是英文要求：${en.hits.map((h) => h.system.slice(-80)).join(' ｜ ')}`));
  await S.check(() => expect(en.receipt.startsWith('Generated 1 screen: '), `① 助手回执应是英文：${en.receipt}`));
  // 2 X-Quilt-Locale: zh：input.locale=zh，系统提示末尾要求简体中文，回执是中文
  const zh = await send({ 'X-Quilt-Locale': 'zh' });
  await S.check(() => expect(zh.created.input.locale === 'zh', `② 作业 input.locale 应为 zh：${JSON.stringify(zh.created.input)}`));
  await S.check(() => expect(endsWithRule(zh.hits, 'Simplified Chinese'), `② 系统提示末尾应要求简体中文：${zh.hits.map((h) => h.system.slice(-80)).join(' ｜ ')}`));
  await S.check(() => expect(zh.receipt.startsWith('已生成 1 屏：'), `② 助手回执应是中文：${zh.receipt}`));
  // 3 只带 Accept-Language: en-US（脚本、MCP 一类调用方）：不记 locale，提示词不加语言要求，回执是中文
  const al = await send({ 'Accept-Language': 'en-US,en;q=0.9' });
  await S.check(() => expect(!('locale' in al.created.input), `③ 只带 Accept-Language 时作业不该有 locale：${JSON.stringify(al.created.input)}`));
  await S.check(() => expect(noRule(al.hits), `③ 系统提示不该带语言要求：${al.hits.map((h) => h.system.slice(-80)).join(' ｜ ')}`));
  await S.check(() => expect(al.receipt.startsWith('已生成 1 屏：'), `③ 没有 locale 的作业回执应是中文：${al.receipt}`));
  // 4 MCP 的 quilt.generate_screens 发同一句：不记 locale，提示词不加语言要求
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const from = stub.hits.length;
  const g = await callTool(mcp, 'quilt.generate_screens', { projectId, prompt: '做一个登录页', count: 1, runner });
  const gJob = g.json as JobView;
  await S.check(() => expect(!g.isError && !!gJob.id && !('locale' in gJob.input), `④ MCP 建的作业不该有 locale：${g.text.slice(0, 300)}`));
  if (gJob.id) await waitJob(gJob.id, 120);
  await S.check(() => expect(noRule(stub.hits.slice(from)), `④ MCP 作业的系统提示不该带语言要求：${stub.hits.slice(from).map((h) => h.system.slice(-80)).join(' ｜ ')}`));
  // 5 改屏同样：X-Quilt-Locale: en 的 edit_screens 记 en、系统提示末尾要求英文、回执英文
  const edit = await send({ 'X-Quilt-Locale': 'en' }, { content: '改成深色', targetScreenIds: [s1.id] });
  await S.check(() => expect(edit.created.kind === 'edit_screens' && edit.created.input.locale === 'en', `⑤ 改屏作业 input.locale 应为 en：${edit.created.kind} ${JSON.stringify(edit.created.input)}`));
  await S.check(() => expect(endsWithRule(edit.hits, 'English'), `⑤ 改屏的系统提示末尾应要求英文：${edit.hits.map((h) => h.system.slice(-80)).join(' ｜ ')}`));
  await S.check(() => expect(edit.receipt.startsWith('Updated 1 screen: '), `⑤ 改屏回执应是英文：${edit.receipt}`));
  S.done();
  return `en 造屏 ${en.hits.length} 次调用都带英文要求；zh、只带 Accept-Language、MCP、en 改屏都对`;
});

// TC-CORE-136 作业的界面语言只取这次请求的头：重试换头、重试不带头、请求体里的 locale（REQ-CORE-046；API-CORE-006、API-CORE-034）
await step('TC-CORE-136', async () => {
  const { projectId, screens } = seedJson<Seeded>('seed:project', '--name', 'Locale Retry', '--device', 'mobile', '--screens', '1', '--no-shot');
  const [s1] = screens;
  const S = softly();
  const { runner } = await stubChannel(3942, 'Stub 重试');
  const first = await apiJson<{ job: JobView; userMessage: { id: string } }>(`/v1/projects/${projectId}/messages`, { method: 'POST', headers: { ...idem(), 'X-Quilt-Locale': 'en' }, body: JSON.stringify({ content: '做一个登录页', runner }) });
  expect(first.status === 202 && first.body.job.input.locale === 'en', `前置：en 造屏应 202 且记 en：${first.status} ${JSON.stringify(first.body.job?.input)}`);
  await waitJob(first.body.job.id, 120);
  const retry = async (headers: Record<string, string>) => {
    const r = await apiJson<{ job: JobView }>(`/v1/projects/${projectId}/messages/${first.body.userMessage.id}/retry`, { method: 'POST', headers: { ...idem(), ...headers }, body: '{}' });
    expect(r.status === 202, `重试 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    await waitJob(r.body.job.id, 120);
    return r.body.job;
  };
  // 1 重试带 X-Quilt-Locale: zh：新作业记 zh
  const rZh = await retry({ 'X-Quilt-Locale': 'zh' });
  await S.check(() => expect(rZh.input.locale === 'zh', `① 带 zh 重试的新作业应记 zh：${JSON.stringify(rZh.input)}`));
  // 2 重试不带语言头：新作业不记 locale（不沿用旧作业的 en）
  const rNone = await retry({});
  await S.check(() => expect(!('locale' in rNone.input), `② 不带语言头重试的新作业不该有 locale：${JSON.stringify(rNone.input)}`));
  // 3 经 POST /jobs 建作业、请求体 input 里写 locale：不带头时不记，带头时以头为准
  const viaJobs = async (headers: Record<string, string>) => {
    const r = await apiJson<{ job: JobView }>(`/v1/projects/${projectId}/jobs`, { method: 'POST', headers: { ...idem(), ...headers }, body: JSON.stringify({ kind: 'edit_screens', input: { prompt: '改成深色', screenIds: [s1.id], runner, locale: 'en' } }) });
    expect(r.status === 202, `POST /jobs ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    await waitJob(r.body.job.id, 120);
    return r.body.job;
  };
  const bodyOnly = await viaJobs({});
  await S.check(() => expect(!('locale' in bodyOnly.input), `③ 只在请求体里写 locale 的作业不该有 locale：${JSON.stringify(bodyOnly.input)}`));
  const withHeader = await viaJobs({ 'X-Quilt-Locale': 'zh' });
  await S.check(() => expect(withHeader.input.locale === 'zh', `③ 带 X-Quilt-Locale: zh 时应以头为准记 zh：${JSON.stringify(withHeader.input)}`));
  S.done();
  return '重试与请求体都只认这次请求的头';
});

// ---------- TC-CORE-137 草稿本的名字跟着请求的界面语言（API-CORE-046，v1.20） ----------
await step('TC-CORE-137', async () => {
  const S = softly();
  const sb = (await apiJson<{ projectId: string }>('/v1/sketchbook')).body.projectId;
  type Detail = { project: { name: string }; screens: { id: string; previewUrl: string | null }[] };
  const detail = (headers: Record<string, string>) => apiJson<Detail>(`/v1/projects/${sb}`, { headers });
  // 1 项目详情里的名字按语言头给
  const heads: Record<string, string>[] = [{ 'X-Quilt-Locale': 'en' }, { 'X-Quilt-Locale': 'zh' }, { 'Accept-Language': 'en-US,en;q=0.9' }, {}];
  const names = await Promise.all(heads.map(async (h) => (await detail(h)).body.project.name));
  await S.check(() => expect(names.join('/') === 'Sketchbook/草稿本/Sketchbook/草稿本', `① 草稿本的名字应按 X-Quilt-Locale / Accept-Language / 缺省中文给：${names.join(' / ')}`));
  // 2 草稿的预览地址带界面语言，下发的文档标题按它给（草稿名带 $，替换不能把它当成替换语法）
  const mcp = await connectMcp();
  cleanups.push(() => mcp.close());
  const made = await callTool(mcp, 'quilt.create_screen', { projectId: sb, name: '标题 $5 套餐', html: '<div data-frame="mobile" class="min-h-dvh bg-white p-5"><h1 class="text-2xl">Plan</h1></div>' });
  const draftId = (made.json as { screenId: string }).screenId;
  expect(draftId, `建草稿失败：${made.text.slice(0, 160)}`);
  for (const [lang, want] of [['en', 'Sketchbook · 标题 $5 套餐'], ['zh', '草稿本 · 标题 $5 套餐']] as const) {
    const url = (await detail({ 'X-Quilt-Locale': lang })).body.screens.find((s) => s.id === draftId)?.previewUrl ?? '';
    const title = (await (await fetch(url)).text()).match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    await S.check(() => expect(url.includes(`lang=${lang}`) && title === want, `② ${lang}：预览地址应带 lang=${lang}、文档标题应是「${want}」：${url.slice(-40)}「${title}」`));
  }
  // 3 普通项目的预览地址不带 lang
  const { projectId } = seedJson<Seeded>('seed:project', '--name', 'No Lang', '--device', 'mobile', '--screens', '1', '--no-shot');
  const plain = (await apiJson<Detail>(`/v1/projects/${projectId}`, { headers: { 'X-Quilt-Locale': 'en' } })).body.screens[0]?.previewUrl ?? '';
  await S.check(() => expect(plain && !plain.includes('lang='), `③ 普通项目的预览地址不该带 lang：${plain.slice(-60)}`));
  S.done();
  return `名字 ${names.join(' / ')}；草稿预览标题按 lang 给`;
});

const counts = summary();
await browser.close();
process.exit(counts['失败'] ? 1 : 0);
