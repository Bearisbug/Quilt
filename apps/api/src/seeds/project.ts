import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { createProject } from '../services/projects.ts';
import { createRevision, deriveLinks } from '../services/screens.ts';
import { buildPrelude, injectQids, assembleDocument, lintScreenBody, DEVICE_SIZE, type DeviceType, type Tokens } from '@quilt/core';
import { screenshotHtml, closeScreenshotBrowser } from '../lib/screenshot.ts';
import { storage, objectKeys } from '../lib/storage.ts';
import { OWNER, arg, flag, userByEmail, done } from './_lib.ts';

// pnpm seed:project --name X --device mobile|desktop --screens N [--revisions M] [--dangling] [--messages K] [--no-shot]
// fixture HTML 直接落库（不调 LLM）：每屏含 data-qid、路由 /s1…/sN 与互链；--dangling 让 /s1 多一条 /settings 断链。
const owner = await userByEmail(arg('owner', OWNER));
const name = arg('name');
const device = arg('device', 'mobile') as DeviceType;
const count = Number(arg('screens', '3'));
const revisions = Number(arg('revisions', '1'));
const messagesN = Number(arg('messages', '0'));
const dangling = flag('dangling');
const withForm = flag('form');
const unlinked = flag('unlinked');
const shot = !flag('no-shot');

const { project, designSystem } = await createProject(owner.id, { name, deviceType: device });
const prelude = buildPrelude(designSystem.tokens as Tokens);
const size = DEVICE_SIZE[device];
const routes = Array.from({ length: count }, (_, i) => `/s${i + 1}`);

function fixtureBody(i: number, rev: number): string {
  const next = routes[(i + 1) % routes.length];
  const extra = dangling && i === 0 ? '<a href="/settings" class="text-sm text-primary">Settings (dangling)</a>' : '';
  // --form：/s1 多一个提交去 /s2 的表单和一个 data-href 去 /s3 的按钮（TC-PROTO-007 三种导航源）
  const form = withForm && i === 0
    ? `<form action="/s2" class="bg-surface rounded-lg border border-outline-variant p-4 space-y-3"><label for="email" class="text-sm font-medium">Email</label><input id="email" name="email" type="email" class="w-full h-12 px-4 rounded-md bg-surface-variant text-on-surface" placeholder="you@example.com"><button type="submit" class="w-full inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Sign in</button></form>
<button type="button" data-href="/s3" class="w-full inline-flex items-center justify-center h-12 px-6 rounded-full border border-outline text-primary font-semibold">Skip to /s3</button>
<a href="#" class="block text-center text-sm text-on-surface-variant">Coming soon (not designed)</a>`
    : '';
  // --unlinked：/s1 多一个没有任何跳转目标的主按钮（TC-PROTO-009 补链修复轮的靶子）
  const unlinkedBtn = unlinked && i === 0 ? '<button type="button" class="w-full inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Continue</button>' : '';
  const items = [1, 2, 3].map((k) => `<li><a href="${next}" class="flex items-center gap-3 py-3 border-b border-outline-variant"><span class="w-12 h-12 rounded-md bg-surface-variant"></span><span class="flex-1 text-sm">Item ${k} of screen ${i + 1}</span><i data-lucide="chevron-right" class="w-5 h-5"></i></a></li>`).join('');
  const list = Array.from({ length: 30 }, (_, k) => `<li class="py-2 text-sm border-b border-outline-variant">Row ${k + 1}</li>`).join('');
  return `<div class="min-h-dvh flex flex-col bg-background text-on-background">
<header class="h-14 flex items-center justify-between px-4 bg-surface border-b border-outline-variant"><h1 class="text-lg font-semibold">Screen ${i + 1} v${rev}</h1>${extra}</header>
<main class="flex-1 overflow-y-auto px-4 py-6 space-y-6">
<div class="bg-surface rounded-lg border border-outline-variant p-4 space-y-3"><label for="addr" class="text-sm font-medium">Address</label><input id="addr" name="address" class="w-full h-12 px-4 rounded-md bg-surface border border-outline-variant text-on-surface" placeholder="Your address"><button type="button" id="toggle" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold" onclick="this.textContent = this.textContent === 'Follow' ? 'Following' : 'Follow'">Follow</button><button type="button" class="inline-flex items-center justify-center h-11 px-4 rounded-full border border-outline text-primary" onclick="this.textContent = 'cookie=' + document.cookie">Read parent cookie</button></div>
${form}${unlinkedBtn}
<ul>${items}</ul>
<ul class="max-h-48 overflow-y-auto">${list}</ul>
<a href="${next}" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">Go to ${next}</a>
</main>
<nav class="sticky bottom-0 mt-auto grid grid-cols-4 bg-surface border-t border-outline-variant">${routes.slice(0, 4).map((r) => `<a href="${r}" class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant"><i data-lucide="home" class="w-5 h-5"></i>${r.slice(1)}</a>`).join('')}</nav>
</div>`;
}

const created: { id: string; route: string }[] = [];
for (let i = 0; i < count; i++) {
  const [screen] = await db.insert(schema.screens).values({ projectId: project.id, name: `Screen ${i + 1}`, route: routes[i], x: i * (size.w + 80), y: 0 }).returning();
  created.push({ id: screen.id, route: screen.route });
  for (let r = 1; r <= revisions; r++) {
    const body = injectQids(fixtureBody(i, r));
    const html = assembleDocument(body, prelude, `${name} · Screen ${i + 1}`);
    const rev = await db.transaction((tx) => createRevision(tx, { projectId: project.id, screenId: screen.id, html, sourceKind: 'generate', lintReport: lintScreenBody(body, routes, true), expectedRevisionId: undefined }));
    if (shot && rev && r === revisions) {
      const png = await screenshotHtml(html, size).catch(() => null);
      if (png) { const key = objectKeys.revisionShot(project.id, screen.id, rev.id); await storage.put(key, png, 'image/png'); await db.update(schema.screenRevisions).set({ screenshotKey: key }).where(eq(schema.screenRevisions.id, rev.id)); }
    }
  }
}
for (let k = 0; k < messagesN; k++) {
  await db.insert(schema.messages).values({ projectId: project.id, role: k % 2 ? 'assistant' : 'user', content: k % 2 ? `已更新 1 屏：Screen 1（消息 ${k + 1}）` : `请把首页改得更活泼一点（消息 ${k + 1}）`, affectedScreenIds: k % 2 ? [created[0].id] : [] });
}
await db.transaction((tx) => deriveLinks(tx, project.id));
await closeScreenshotBrowser();
await done({ projectId: project.id, screens: created });
