import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { requestSource } from '../lib/origin.ts';
import { UUID } from './app.ts';
import { verifyPreview } from '../lib/signing.ts';
import { storage } from '../lib/storage.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withCurrentRuntime, withPaletteDarkMode, withOverlayStyle, withDraftComponentStyle, withLocalVendor, withSurfaceStates, buildPrelude, pickLocale, SCREEN_CSP, VENDOR, type Tokens, type SurfaceStates } from '@quilt/core';
import { sketchbookName } from '../lib/locale.ts';
import { readAsset } from '../services/assets.ts';
import { componentPreviewDocument } from '../services/components.ts';
import { DRAFT_ROOT_JS } from '../lib/screenshot.ts';
import { requestLog } from '../lib/reqlog.ts';

// 预览域服务（ADR-004 / API-CORE-016）：独立 origin、无 cookie、HMAC 签名。
// CSP 在 v0.43 放开到任意 https: 源——屏里允许用 Chart.js 这类开源库（REQ-CORE-022）；v0.75 补 form-action 'none'（SCREEN_CSP）。
// 安全边界：独立 origin、无 cookie、拿不到主站 storage，也写不了主站 API，屏里的脚本只能影响它自己那张屏。
// 下发时把修订里存的运行时脚本换成当前版本（v0.34）：运行时是 Quilt 的代码，修复不该等每张屏再出一版修订。
export const previewApp = new Hono();
// 请求日志（§21 v1.29）：预览域的 4xx/5xx 率与 P95 按它的 5 分钟汇总算
previewApp.use('*', requestLog('preview'));

previewApp.get('/healthz', (c) => c.text('ok'));

// 外网脚本的副本（§17 v1.06）：/p/ 与 /c/ 下发时把 Tailwind Play 与 lucide 的地址换成这里，屏不再等外网。文件名带版本，内容不变，长缓存
const vendorBodies = new Map<string, Buffer>();
previewApp.get('/vendor/:file', async (c) => {
  const file = c.req.param('file');
  if (!VENDOR.some((v) => v.file === file)) return problem(c, 404, '/errors/not-found', '资源不存在');
  let body = vendorBodies.get(file);
  if (!body) { body = await readFile(path.join(config.vendorDir, file)); vendorBodies.set(file, body); }
  c.header('Content-Type', 'text/javascript; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(new Uint8Array(body));
});

// 路径里的 id 与 /p/ 的 rev 都是 UUID（§14 v0.82）：不是的直接 404，同 /v1——原样进 uuid 列的查询会被 Postgres 报 22P02，落成 500
for (const route of ['/p/:projectId/:id', '/c/:projectId/:id', '/a/:projectId/:id']) {
  previewApp.use(route, async (c, next) => {
    const ids = [...Object.values(c.req.param() as Record<string, string>), ...(route.startsWith('/p/') ? [c.req.query('rev') ?? ''] : [])];
    if (!ids.every((v) => UUID.test(v))) return problem(c, 404, '/errors/not-found', '资源不存在');
    await next();
  });
}
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const retitle = (doc: string, title: string) => doc.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeText(title)}</title>`);
// 画布可能从来源名单里任一种回环写法打开（§15）：frame-ancestors 列全，ACAO 回显名单内的请求 Origin
const FRAME_ANCESTORS = requestSource.origins.join(' ');

previewApp.get('/p/:projectId/:screenId', async (c) => {
  const { projectId, screenId } = c.req.param();
  const rev = c.req.query('rev') ?? '';
  const token = c.req.query('t') ?? '';
  if (!verifyPreview(token, projectId)) return problem(c, 403, '/errors/preview-token-invalid', '预览签名无效或过期');
  const [row] = await db.select({ htmlKey: schema.screenRevisions.htmlKey, presentation: schema.screens.presentation, frame: schema.screens.frame, kind: schema.projects.kind, name: schema.screens.name, states: schema.surfaces.states })
    .from(schema.screenRevisions).innerJoin(schema.screens, eq(schema.screens.id, schema.screenRevisions.screenId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.screens.projectId))
    .leftJoin(schema.surfaces, eq(schema.surfaces.id, schema.screens.surfaceId))
    .where(and(eq(schema.screenRevisions.id, rev), eq(schema.screenRevisions.screenId, screenId), eq(schema.screens.projectId, projectId)));
  if (!row) return problem(c, 404, '/errors/not-found', '修订不存在');
  // 叠层屏（v0.63）：呈现方式是元数据，下发时临时注入透明背景，压在别的屏上时露出底下那一屏
  // 端上的维度（REQ-CORE-051）放进 head，运行时按它取缺省值；屏的修订里不存它——端上的维度会变
  const raw = withSurfaceStates(withLocalVendor(withPaletteDarkMode(withCurrentRuntime((await storage.get(row.htmlKey)).toString('utf8')))), row.states as SurfaceStates | null);
  // 组件画框的草稿（REQ-CORE-040）：看板按根元素的大小摆它；画框还没定（null）的按组件量。手机页 / 桌面页由父页按画框给视口，不报。
  // 它同样注入透明背景：看板上组件四周露出看板底色，而不是草稿本设计系统的背景色
  const draftComponent = row.kind === 'sketchbook' && (row.frame === 'component' || row.frame === null);
  const shown = draftComponent ? withDraftComponentStyle(raw) : row.presentation === 'overlay' ? withOverlayStyle(raw) : raw;
  const measured = draftComponent ? withDraftMeasure(shown, screenId) : shown;
  // 草稿本的草稿：文档标题里的草稿本名按预览地址带的界面语言给（没带看 Accept-Language），存修订时写进去的那个不算（API-CORE-046）
  const html = row.kind === 'sketchbook' ? retitle(measured, `${sketchbookName(pickLocale(c.req.query('lang'), c.req.header('accept-language')))} · ${row.name}`) : measured;
  c.header('Content-Type', 'text/html; charset=utf-8');
  // 修订本身不可变，但这份响应不是：运行时每次下发都换成当前版本（上一行）。标成 immutable 时浏览器 10 分钟内
  // 连条件请求都不发，运行时修复到不了已经开着的会话，而 iframe 是聚焦时才建的、硬刷新页面也绕不过这层缓存。
  c.header('Cache-Control', 'no-cache');
  c.header('Content-Security-Policy', `${SCREEN_CSP}; frame-ancestors ${FRAME_ANCESTORS}`);
  c.header('Referrer-Policy', 'no-referrer');
  // 父页需要 fetch 目标屏 HTML 做同 iframe 换屏（ADR-003）；URL 已带签名，只放行画布 origin
  const origin = c.req.header('Origin');
  c.header('Access-Control-Allow-Origin', origin && requestSource.origins.includes(origin) ? origin : config.webOrigin);
  c.header('Vary', 'Origin');
  return c.body(html);
});

// 共享组件预览（REQ-EDIT-006）：画布上的组件卡是活 iframe，只渲染这一个组件；URL 带版本，改完即换、可缓存
previewApp.get('/c/:projectId/:componentId', async (c) => {
  const { projectId, componentId } = c.req.param();
  if (!verifyPreview(c.req.query('t') ?? '', projectId)) return problem(c, 403, '/errors/preview-token-invalid', '预览签名无效或过期');
  const [row] = await db.select().from(schema.components).where(and(eq(schema.components.id, componentId), eq(schema.components.projectId, projectId)));
  if (!row) return problem(c, 404, '/errors/not-found', '组件不存在');
  const [ds] = await db.select({ tokens: schema.designSystems.tokens }).from(schema.designSystems).where(eq(schema.designSystems.projectId, projectId));
  c.header('Content-Type', 'text/html; charset=utf-8');
  // 同 /p/：这份文档是每次请求现拼的（prelude 里带当前运行时与当前 token），缓存住等于把 Quilt 自己的代码冻在旧版
  c.header('Cache-Control', 'no-cache');
  c.header('Content-Security-Policy', `${SCREEN_CSP}; frame-ancestors ${FRAME_ANCESTORS}`);
  c.header('Referrer-Policy', 'no-referrer');
  return c.body(withLocalVendor(componentPreviewDocument(row, buildPrelude(ds.tokens as Tokens))));
});

// 项目素材（ADR-017）：不签名、不过期，凭 UUID 不可猜；URL 会被烤进修订 HTML，必须长期可用
previewApp.get('/a/:projectId/:assetId', async (c) => {
  const found = await readAsset(c.req.param('projectId'), c.req.param('assetId'));
  if (!found) return problem(c, 404, '/errors/not-found', '素材不存在');
  c.header('Content-Type', found.mediaType);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('X-Content-Type-Options', 'nosniff');
  // 素材本就不鉴权（ADR-017），这里放行任意来源：画布可能被 localhost / 127.0.0.1 / 局域网地址打开，
  // 锁成单一 origin 只会让另外几种入口的取色（画布要按素材亮度选底）拿不到像素，图本身照样显示
  c.header('Access-Control-Allow-Origin', '*');
  return c.body(new Uint8Array(found.body));
});

// 草稿尺寸上报（API-CORE-016 草稿条目），与共享组件预览的测量脚本同一机制：load 后报一次草稿根的框（向上取整），之后 ResizeObserver 盯着、
// 尺寸变了再报。运行时换 body（quilt:swap）时会重跑 body 里的脚本，那时 load 早已过去，按 readyState 直接开始、盯住新的根；
// 旧根离开文档时 ResizeObserver 还会回调一次 0×0，isConnected 把它挡掉。内联脚本由 SCREEN_CSP 的 'unsafe-inline' 放行
function withDraftMeasure(html: string, screenId: string): string {
  const script = `<script>(function(){function start(){var r=${DRAFT_ROOT_JS};if(!r)return;var send=function(){if(!r.isConnected)return;var b=r.getBoundingClientRect();parent.postMessage({type:'quilt:draft-size',screenId:${JSON.stringify(screenId)},w:Math.ceil(b.width),h:Math.ceil(b.height)},'*');};if(window.ResizeObserver)new ResizeObserver(send).observe(r,{box:'border-box'});else send();}if(document.readyState==='complete')start();else window.addEventListener('load',start);})();</script>`;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? `${html}${script}` : `${html.slice(0, at)}${script}\n${html.slice(at)}`;
}

function problem(c: Context, status: 403 | 404, type: string, title: string) {
  c.header('Content-Type', 'application/problem+json');
  return c.body(JSON.stringify({ type, title, status }), status);
}
