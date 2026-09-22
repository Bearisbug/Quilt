import { COLOR_CLASS_NAMES, type Tokens } from './tokens.ts';
import { DEVICE_SIZE, type DeviceType } from './device.ts';
import { componentPlacement, sharedComponentsSection, type SharedComponentCard } from './components.ts';

// 设计契约（ADR-005 / ADR-012）：每次生成都带，体积与屏幕数无关。组件配方来自设计系统 components。
export type ComponentRecipe = { name: string; html: string; note?: string };
export type PlannedScreen = { name: string; route: string; purpose: string; links: string[]; sections: string[] };
// 整组规划（REQ-CORE-003）：brief 只在空项目首轮扩写；entryFrom 是既有哪一屏进入新组（反向连线的靶子）
export type Plan = { screens: PlannedScreen[]; brief?: string; entryFrom?: string | null };
export type AppContext = { name: string; description: string; brief?: string };
/** 屏注册表条目（ADR-012 稳定前缀）：每屏 route / name / purpose */
export type RegistryEntry = { route: string; name: string; purpose?: string };
/** 情境层参考屏（ADR-012）：样板屏 / 来源屏 */
export type ReferenceScreen = { label: string; body: string };

export const DEFAULT_COMPONENTS: ComponentRecipe[] = [
  { name: 'AppBar', html: '<header class="h-14 flex items-center justify-between px-4 bg-surface border-b border-outline-variant">', note: 'title text-lg font-semibold; icon buttons w-10 h-10 flex items-center justify-center rounded-full' },
  { name: 'TabBar', html: '<nav class="sticky bottom-0 mt-auto grid grid-cols-4 bg-surface border-t border-outline-variant">', note: 'mobile main screens only; each tab <a class="flex flex-col items-center gap-1 py-2 text-xs text-on-surface-variant">, active tab text-primary; scrolling content lives in <main class="flex-1 overflow-y-auto"> above it' },
  { name: 'Sidebar', html: '<aside class="w-60 shrink-0 h-dvh sticky top-0 flex flex-col bg-surface border-r border-outline-variant">', note: 'desktop only; nav list <nav class="flex-1 overflow-y-auto p-3 space-y-1">, active link bg-primary-container text-on-primary-container rounded-md' },
  { name: 'Card', html: '<div class="bg-surface rounded-lg border border-outline-variant p-4">' },
  { name: 'ListItem', html: '<a class="flex items-center gap-3 py-3 border-b border-outline-variant">', note: 'w-12 h-12 rounded-md image/avatar, flex-1 text block, trailing chevron-right icon' },
  { name: 'PrimaryButton', html: '<button type="button" class="inline-flex items-center justify-center h-12 px-6 rounded-full bg-primary text-on-primary font-semibold">' },
  { name: 'SecondaryButton', html: '<button type="button" class="inline-flex items-center justify-center h-12 px-6 rounded-full border border-outline text-primary font-semibold">' },
  { name: 'Chip', html: '<span class="inline-flex items-center h-8 px-3 rounded-full bg-secondary-container text-on-secondary-container text-sm">' },
  { name: 'Input', html: '<input class="w-full h-12 px-4 rounded-md bg-surface border border-outline-variant text-on-surface placeholder:text-on-surface-variant">', note: 'always with a visible <label for> or aria-label' },
  { name: 'ProgressBar', html: '<div class="h-2 rounded-full bg-surface-variant"><div class="h-2 w-3/5 rounded-full bg-primary"></div></div>', note: 'widths via fraction classes w-1/12 … w-11/12 / w-full; bar charts are flex rows of such bars; never inline style' },
];

// 稳定前缀（ADR-012 v0.31）：规则 → DESIGN.md（含约定）→ 配方 → 应用简介 → 屏注册表；参考屏放在最后（每作业可变）。
// 同一作业里多屏并行共用这一份 system，prompt cache 命中的就是这个前缀。
export type ProjectAsset = { name: string; url: string; width: number; height: number };

// shared（REQ-EDIT-006）：项目的共享组件卡——每张都进前缀（名字 / 摘要 / 占位写法），与本次相关的附完整 HTML
export function screenSystemPrompt(app: AppContext, device: DeviceType, tokens: Tokens, designMd: string, components: ComponentRecipe[], registry: RegistryEntry[], refs: ReferenceScreen[], assets: ProjectAsset[] = [], shared: SharedComponentCard[] = []): string {
  const size = DEVICE_SIZE[device];
  const deviceRules = device === 'mobile'
    ? `- Device: mobile, viewport ${size.w}×${size.h}. No device status bar. Main screens have a top AppBar and a bottom TabBar linking to the 4 main routes. Detail/flow screens have a back-arrow AppBar (<a href="/previous-route">) and no TabBar.`
    : `- Device: desktop web app, viewport ${size.w}×${size.h}. Layout: the Sidebar recipe on the left with nav links (<a href="/route">) and a main content area with a page header. No bottom tab bar.`;
  const recipes = components.map((c) => `  - ${c.name}: ${c.html}${c.note ? ` — ${c.note}` : ''}`).join('\n');
  const brief = app.brief?.trim() ? `\nAPP BRIEF\n${app.brief.trim()}\n` : '';
  const routes = registry.map((r) => `${r.route} (${r.name}${r.purpose ? `: ${r.purpose}` : ''})`).join(', ');
  // 项目素材（v0.35 `REQ-CORE-019`）：给出真实可用的 URL，模型才不会拿占位图糊弄品牌位
  const assetList = assets.length
    ? `\nPROJECT ASSETS (real files; use these exact URLs in <img src>, never invent asset URLs):\n${assets.map((x) => `  - ${x.name} → ${x.url}${x.width && x.height ? ` (${x.width}×${x.height})` : ''}`).join('\n')}\nUse the brand mark asset wherever a logo belongs (app bar, splash, empty states). Size it with w-*/h-* classes; SVG assets scale cleanly.\n`
    : '';
  const references = refs.length
    ? `\nREFERENCE SCREENS (same design system; match their density, spacing rhythm and component usage — do not copy their content):\n${refs.map((g) => `--- ${g.label} ---\n${g.body}`).join('\n')}\n`
    : '';
  return `You are Quilt's screen generator. You produce exactly ONE app screen as HTML that renders inside a preloaded document.

OUTPUT RULES (structure is required; the rest is the house vocabulary — see WHEN TO BREAK THEM below):
- Output ONLY the HTML of the screen's single root element. No markdown fences, no explanation, no <html>, <head> or <body> wrapper.
- Root element: <div class="min-h-dvh flex flex-col bg-background text-on-background"> ... </div>
- Default to Tailwind utility classes. COLORS: prefer the token classes bg-X / text-X / border-X / ring-X where X is one of: ${COLOR_CLASS_NAMES.join(', ')}. These tokens are what makes a theme change sweep every screen at once, so stay inside them unless the design genuinely needs something they cannot express.
- Semantic colors: bg-success/text-success for completed & confirmed states, bg-warning/text-warning for caution, bg-error/text-error for failure — never repurpose primary for these. Pair each with its on-* class for text on top.
- Radius: rounded-sm, rounded-md, rounded-lg, rounded-full are the house scale. Shadows: shadow-sm by default.
- Simple progress bars: the ProgressBar recipe (fraction widths) needs no script. Real data visualisation may pull in a charting library — see LIBRARIES.
- Typography: text-xs … text-3xl, font-medium / font-semibold / font-bold. ${tokens.typography.fontFamily} is ${tokens.typography.fontSource === 'system' ? 'the device font (installed locally, no webfont to load)' : 'preloaded'}.
- Icons: <i data-lucide="icon-name" class="w-5 h-5"></i> using lucide icon names (home, search, heart, user, plus, chevron-left, chevron-right, settings, bell, message-circle, camera, map-pin, calendar, clock, star, bookmark, filter, more-horizontal, check, x, play, pause, wallet, trending-up, receipt, dumbbell, flame, book-open, moon, sun).
- Images: <img src="https://picsum.photos/seed/UNIQUE-WORD/W/H" class="... object-cover" alt="..."> with explicit w-*/h-* or aspect classes.
- Navigation: every tappable element that leads to another screen MUST navigate to a route from ALLOWED ROUTES only. Links, cards and button-like actions are <a href="/route"> (style them with the button recipes). Every <form> MUST have action="/route" (the screen shown after submitting) and its primary action MUST be <button type="submit"> — never type="button" for Log in / Sign up / Send / Save / Continue. A button that must stay a <button> but leads somewhere carries data-href="/route". If the destination screen is NOT in ALLOWED ROUTES (a tab or action that has no screen yet), write href="#" — a dead link the prototype explains to the user — and NEVER point it at an unrelated existing screen. Only buttons that truly do nothing (toggles, steppers) are <button type="button"> without data-href.
- Forms: every <input>/<select>/<textarea> has a meaningful name, a visible <label for> (or aria-label for search fields), and autocomplete/inputmode where relevant. Tap targets are at least h-11 (44px). Disabled controls use the disabled attribute plus opacity-50, never color alone.
${deviceRules}
- LIBRARIES: <script> tags and any https: CDN are allowed (Chart.js, ECharts, your own component library…). Load them inside the screen's root element, keep the screen self-contained, and remember the screen must still render something sensible if the CDN is slow — no blank screens waiting on network.
- WHEN TO BREAK THEM: the tokens and recipes above are this project's shared vocabulary, not a fence. If the design you are asked for needs a colour, spacing, shape or effect they cannot express — you are exploring a NEW visual direction, not filling in the current one — write it directly (hex, inline style, arbitrary values, your own CSS in a <style> tag). Nothing is rejected for it. Know the price and take it deliberately: hardcoded colours will NOT follow a later theme change, and screens that lean on a CDN degrade when it is unavailable. Quilt records every deviation per screen so the designer can see what drifted.
- Content: realistic and specific (real-sounding names, prices, dates, counts). No lorem ipsum. English UI copy.

DESIGN SYSTEM
${designMd.trim()}

COMPONENT RECIPES (reuse verbatim for consistency)
${recipes}
${sharedComponentsSection(shared)}${assetList}${brief}
APP CONTEXT
- App: ${app.name} — ${app.description}
- ALLOWED ROUTES: ${routes}
${references}`;
}

// 整组规划（REQ-CORE-003 v0.31）：count 是屏数档位——auto 时空项目 4–6 屏主流程、非空项目 2–6 屏子流程；
// 数字时严格出 N 屏。非空项目要给出 entryFrom（既有哪一屏进入新组，反向连线的靶子）；空项目首轮顺手扩写应用简介。
export function planSystemPrompt(opts: { count: number | 'auto'; empty: boolean }): string {
  const countRule = opts.count === 'auto'
    ? (opts.empty ? 'between 4 and 6 screens; the first 4 are the main tab/nav destinations; any others are detail or flow screens reachable from one of them' : 'between 2 and 6 screens forming ONE coherent sub-flow (e.g. checkout: cart → address → payment → success); do not re-plan screens that already exist')
    : `exactly ${opts.count} screens${opts.empty ? '; the first ones are the main tab/nav destinations' : ' forming one coherent sub-flow; do not re-plan screens that already exist'}`;
  const extra = opts.empty
    ? `"brief" is 3–5 sentences describing the app for future generations: what it is, who uses it, the tone and the main flows (written from the description, do not invent features the description rules out).`
    : `"entryFrom" is the route of the EXISTING screen that should link into this new group (the natural entry point), or null if none is obvious.`;
  return `You are Quilt's app planner. Given an app description${opts.empty ? '' : ' and the screens that already exist'}, output a JSON object (no markdown fences, no prose) with this exact shape:
{${opts.empty ? '"brief":"…",' : '"entryFrom":"/existing-route",'}"screens":[{"name":"Home","route":"/home","purpose":"one sentence","links":["/other-route"],"sections":["section 1","section 2"]}]}
Rules: ${countRule}; routes are lowercase kebab-case starting with "/" and MUST NOT collide with EXISTING ROUTES; every screen links to at least one other screen and all links use routes from this plan or from EXISTING ROUTES; sections are 3–5 short phrases describing what the screen contains, top to bottom; ${extra} Strictly valid JSON: double quotes, no trailing commas, no comments.`;
}
export function planUserPrompt(app: AppContext, description: string, existing: RegistryEntry[]): string {
  const list = existing.map((r) => `${r.route} (${r.name}${r.purpose ? `: ${r.purpose}` : ''})`).join(', ') || '(none)';
  return `App: ${app.name}${app.brief ? ` — ${app.brief}` : ''}\nEXISTING ROUTES: ${list}\nRequest: ${description}`;
}

// 参考图说明（REQ-CORE-012）。必须写清它是「风格参照」而不是「照着抄」，否则模型会去复刻
// 图里的具体文案和品牌色，产出既违反设计契约、又不是用户这个 APP 的内容。
export const REFERENCE_IMAGE_NOTE = `The user attached reference image(s) with this request. Treat them as a visual reference for layout, density, spacing rhythm and component style only. Do NOT copy their text content, brand colours or logos: colours must still come from the token classes of THIS project's design system, and the copy must be about this app. If a reference conflicts with the design system or the output rules, the design system and the output rules win.`;

// 单屏规划（REQ-CORE-003 屏数=1）：用户只给一句描述，先把它规划成与整组生成同形的 PlannedScreen，
// 再走同一条出屏路径。路由不许撞现有的；链接只许指向现有的、且可以为空——交互还没想好时先把屏设计出来，不强迫它连到谁。
export function planOneScreenSystemPrompt(): string {
  return `You are Quilt's screen planner. The user wants ONE additional screen for an existing app. Output a JSON object (no markdown fences, no prose) with this exact shape:
{"name":"Profile Detail","route":"/profile-detail","purpose":"one sentence","links":["/existing-route"],"sections":["section 1","section 2","section 3"],"entryFrom":"/existing-route"}
Rules: route is lowercase kebab-case starting with "/" and MUST NOT be one of the EXISTING ROUTES; links is a subset of EXISTING ROUTES — only include a route when this screen obviously navigates there, and leave it an empty array when the flow is not decided yet (empty is the normal case, do not force links); entryFrom is the EXISTING route that would naturally link INTO this screen, or null when none is obvious; sections are 3–5 short phrases describing what the screen contains, top to bottom; name is 1–3 words in the same language as the existing screen names. Strictly valid JSON: double quotes, no trailing commas, no comments.`;
}
export function planOneScreenUserPrompt(app: AppContext, description: string, existing: RegistryEntry[]): string {
  const list = existing.map((r) => `${r.route} (${r.name}${r.purpose ? `: ${r.purpose}` : ''})`).join(', ') || '(none)';
  return `App: ${app.name}${app.brief ? ` — ${app.brief}` : ` — ${app.description}`}\nEXISTING ROUTES: ${list}\nRequested screen: ${description}`;
}

export function screenUserPrompt(s: PlannedScreen, all: PlannedScreen[]): string {
  const links = s.links.map((r) => `${r} (${all.find((x) => x.route === r)?.name ?? r})`).join(', ');
  // 没规划出链接的屏（凭空生成常见）：明说它暂不需要跳转，免得模型硬编去向；表单的 action 仍受 lint 约束（form-action）
  const nav = links ? `It must link to: ${links}.` : 'It does not need to navigate to any other screen yet: use href="#" for actions whose destination is undecided; forms still need action="/route" (a plausible new route is fine).';
  return `Generate the screen "${s.name}" at route ${s.route}.\nPurpose: ${s.purpose}\nSections, top to bottom: ${s.sections.join('; ')}\n${nav}\nReturn only the root element HTML.`;
}

// 「补链」修复轮（REQ-PROTO-002）：作为 edit_screens 的固定指令，把未连上路由的导航动作连好，其余不动
export const LINK_REPAIR_PROMPT = 'Connect every navigation action on this screen to a route from ALLOWED ROUTES: form submit buttons must be <button type="submit"> inside a <form action="/route">; buttons, cards or rows that lead to another screen must become <a href="/route"> (or keep the <button> and add data-href="/route"); navigation whose destination has no screen in ALLOWED ROUTES becomes href="#" instead of pointing at an unrelated screen. Keep all text, layout and classes identical otherwise.';
// 反向连线（REQ-CORE-014）：造一组屏后对入口屏跑一次补链，把新组路由标为「本次新增」让它优先连过去
export function linkRepairPrompt(newRoutes: string[]): string {
  return newRoutes.length ? `${LINK_REPAIR_PROMPT}\nNEWLY ADDED ROUTES (this screen is their entry point — connect the matching actions to them first): ${newRoutes.join(', ')}.` : LINK_REPAIR_PROMPT;
}
// 「按新约定重生成」（REQ-EDIT-003）：约定写进 DESIGN.md 之后对全部屏跑一轮的固定指令
export const CONVENTIONS_REGENERATE_PROMPT = 'Rework this screen so it follows every rule in the DESIGN SYSTEM section named "约定" (conventions). Keep the screen\'s purpose, content, links and overall layout; change only what the conventions require.';

// 批注合并成一条整屏指令（REQ-EDIT-004）：每屏一次作业，逐条点名元素 qid 与当初的可见文案，
// 元素已不存在时让模型按文案自行判断、忽略即可，不要因为一条批注失效就放弃整屏。
export function annotationsPrompt(items: { qid: string; note: string; anchorText: string }[]): string {
  const list = items.map((a, i) => `${i + 1}. 元素 data-qid="${a.qid}"${a.anchorText ? `（当时文案「${a.anchorText}」）` : ''}：${a.note}`).join('\n');
  return `Apply the following element-level change requests to this screen. Each item names the element by its data-qid (and the visible text it had when the note was written):\n${list}\n\nChange only what these items ask for; keep every other element's text, layout, classes and links identical. If an element no longer exists, use its recorded text to locate the equivalent element, and skip the item if there is none.`;
}

// 改屏（REQ-CORE-006）：目标屏当前 HTML + 本次指令 + 该屏 current 祖先链上的历史指令（ADR-012：已应用过的意图，不是时间序）
export function editUserPrompt(screenName: string, route: string, currentBody: string, instruction: string, priorInstructions: string[] = []): string {
  const prior = priorInstructions.length
    ? `\nEARLIER INSTRUCTIONS ALREADY APPLIED TO THIS SCREEN (keep honoring them unless the new instruction overrides):\n${priorInstructions.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n`
    : '';
  return `Revise the screen "${screenName}" at route ${route} according to this instruction:\n${instruction}\n${prior}\nKeep the design system, recipes and all links intact unless the instruction says otherwise. Return the complete revised root element HTML only.\n\nCURRENT HTML:\n${currentBody}`;
}

// 聊天（REQ-CORE-023 / ADR-018）：住在 Quilt 进程里的助手的稳定前缀——每轮重发、随项目更新。
// 不带任何整屏 HTML：屏的结构靠 quilt.get_outline 看目录，整屏只在助手用 get_screen 读时进上下文；对话记忆在 SDK 会话里。
export type ChatScreen = { id: string; name: string; route: string; purpose?: string; currentRevisionId: string | null };
export function chatSystemPrompt(args: { app: AppContext; device: DeviceType; designMd: string; screens: ChatScreen[]; projectId: string; jobId: string; designVersion: number; components?: SharedComponentCard[] }): string {
  const size = DEVICE_SIZE[args.device];
  const registry = args.screens.length
    ? args.screens.map((s) => `  - ${s.name} (${s.route}) screenId=${s.id} revision=${s.currentRevisionId ?? 'none'}${s.purpose ? ` — ${s.purpose}` : ''}`).join('\n')
    : '  (no screens yet)';
  // 共享组件（REQ-EDIT-006）：助手改导航这类东西要走组件，而不是逐屏手改它的副本
  const shared = args.components?.length
    ? `\n- SHARED COMPONENTS (project-level; every screen places them by reference and Quilt fills them in — quilt.get_design_contract has their full HTML):\n${args.components.map((c) => `  - ${c.name} — ${c.summary} · placed with ${componentPlacement(c.name, c.tag, c.slots)}`).join('\n')}\n  To change how one looks everywhere, call quilt.update_component (expectedVersion from the contract) — never hand-edit its copy inside a screen (Quilt overwrites that on the next write). To turn part of a screen into a new shared component, quilt.create_component with that element's HTML, then place it on the screens with the tag above.`
    : '';
  return `You are Quilt's design assistant, living inside the Quilt canvas for the app "${args.app.name}" (projectId ${args.projectId}, ${args.device} ${size.w}×${size.h}). The designer talks to you in the chat box. The app's screens live on an infinite canvas as separate HTML documents — one per screen, all sharing one design system — and you reach them only through the quilt.* tools. You decide the scope yourself: answer a question without touching anything, change one screen, change several, or change the design system — whatever the message actually asks for. When it is only a question or a request for an opinion, reply and change nothing.

HOW TO SEE THE PROJECT
- SCREENS below is the registry: name, route, screenId, current revision id, purpose.
- quilt.get_outline { projectId, screenIds? } gives every screen's structure (landmarks, headings, links, buttons, inputs, images — each with its data-qid and text). Call it first whenever the message concerns existing screens; it is cheap and usually enough to decide what to do.
- quilt.get_screen { screenId } returns the full HTML of ONE screen. Read only the screens you are going to change or must inspect in detail.
- quilt.get_screenshot { screenId } shows how a screen renders. Use it when the question is visual (spacing, hierarchy, colour, "does this look right").
- quilt.get_design_contract { projectId } is the design system in machine form: tokens, colour classes, component recipes, DESIGN.md, assets, rules. Read it once before writing any HTML in this conversation, and again after you change the design system.

HOW TO CHANGE THINGS
- Write a screen back with quilt.update_screen { projectId, screenId, name, route, html, expectedRevisionId, jobId }. ALWAYS pass jobId="${args.jobId}" and the screen's current revision id (from SCREENS or quilt.get_outline). On 409 revision-conflict re-read the screen and redo the change on the current version; on 409 screen-busy another job is editing that screen — say so in your reply instead of retrying.
- html is the screen's single root element (<div class="min-h-dvh flex flex-col bg-background text-on-background">…</div>) with everything inside it; no <html>, <head> or <body>. Keep every part the message did not ask you to change identical (text, classes, links, data-qid attributes). Stay inside the design system's token classes and recipes unless the design genuinely needs something they cannot express — Quilt records such deviations per screen and they will not follow a later theme change.
- New screen: quilt.create_screen { projectId, name, route, html, jobId } with a route that is not in SCREENS; link it from the screen it belongs to when that is obvious.
- Theme-wide changes (colour, font, radius, palette, DESIGN.md text): quilt.update_design_system with expectedVersion=${args.designVersion} and applyToScreens=true so every screen is re-baked — never hand-edit every screen for something a token change expresses.
- Project name or brief: quilt.update_project.
- Do NOT call quilt.finish_job (this turn closes itself), and do not start quilt.generate_screens / quilt.edit_screens unless the designer explicitly asks for many new screens at once — those run as separate jobs on another channel.

HOW TO REPLY
- Reply in the designer's language, plainly, in a few sentences or a short list — this is a chat, not a report. No markdown headings.
- Say what you changed (screen names) and any decision you made on the designer's behalf; if you took a deviation from the design system or hit a conflict, say so. If you changed nothing, say that.
- Earlier turns of this conversation are in your context: "刚才那个", "the one before", "put it back" refer to them.

DESIGN SYSTEM
${args.designMd.trim()}

APP CONTEXT
- App: ${args.app.name}${args.app.brief?.trim() ? ` — ${args.app.brief.trim()}` : ''}
- Device: ${args.device}, viewport ${size.w}×${size.h}
- SCREENS:
${registry}${shared}`;
}
export function chatUserPrompt(instruction: string, selected: ChatScreen[]): string {
  const context = selected.length
    ? `(The designer currently has ${selected.length} screen${selected.length > 1 ? 's' : ''} selected on the canvas — context for what "this" / "these" refer to, not a restriction: ${selected.map((s) => `${s.name} (${s.route}, screenId=${s.id})`).join('; ')}.)\n\n`
    : '';
  return `${context}${instruction}`;
}

// 改共享组件（REQ-EDIT-006）：模型只产出组件自己的那一个根元素；激活态由 Quilt 按屏路由算，模型只需在正式 HTML 里标出一条 aria-current
export function componentSystemPrompt(args: { app: AppContext; device: DeviceType; tokens: Tokens; designMd: string; registry: RegistryEntry[] }): string {
  const size = DEVICE_SIZE[args.device];
  const routes = args.registry.map((r) => `${r.route} (${r.name})`).join(', ') || '(none yet)';
  return `You maintain ONE shared component of an app in Quilt. A shared component is a project-level HTML fragment (a tab bar, an app bar, a sidebar, a footer…) that every screen places by reference; Quilt fills it in on each screen, so what you return here is what every screen will show.

OUTPUT RULES
- Output ONLY the component's single root element HTML. No markdown fences, no explanation, no <html>/<head>/<body>, no <script>, no <style>, and never a whole screen around it.
- Keep the root element's tag unless the instruction requires otherwise. Keep every data-slot="…" element that exists (screens fill them in per screen); you may add a data-slot where per-screen content belongs (a screen title, for example).
- Tailwind utility classes with this project's token colours: bg-X / text-X / border-X where X is one of ${COLOR_CLASS_NAMES.join(', ')}. Radius: rounded-sm/md/lg/full. Icons: <i data-lucide="icon-name" class="w-5 h-5"></i>.
- Device: ${args.device}, viewport ${size.w}×${size.h}. Stay self-contained: the component must look right on any screen of this app.
- Content: realistic and specific; English UI copy.

TWO KINDS OF "SELECTED" — DO NOT MIX THEM
- Items that go to ANOTHER SCREEN (bottom tab bar, sidebar): <a href="/route"> with routes from ALLOWED ROUTES only; keep existing hrefs unless told otherwise. Mark exactly ONE link with aria-current="page" and give it the active styling — Quilt derives which link is active on each screen from that pair of styles. The component itself holds no state here.
- Items that switch content WITHIN the same screen (channel tabs, segmented controls, filter chips, toggles, accordions): this is the component's own state and it MUST actually switch when clicked. Build it CSS-only, per the next section.

INTERACTIVE STATE IS CSS-ONLY (no JavaScript — the component HTML is copied into every screen that uses it, so a <script> would be duplicated N times and is rejected)
- Pattern: each item is a <label> (the WHOLE item is the hit area, not just the text) whose FIRST child is a hidden native control — <input type="radio" class="peer sr-only" name="<component-name>-<group>"> for "pick one of N", <input type="checkbox" class="peer sr-only"> for on/off. Every sibling AFTER it styles the state with peer-checked: variants (weight, colour, indicator opacity/transform).
- The default selection is the \`checked\` attribute on that input. NEVER hardcode the selected look into one item's classes — if the active styling only exists on one item, the component cannot switch and is wrong.
- The radio \`name\` must be prefixed with the component name so two components on one screen don't fight over the same group.
- Keep the semantics: aria-label on each input, role="radiogroup"/aria-label on the root, aria-hidden="true" on pure decoration (indicator bars). Native radios are keyboard-operable for free (Tab into the group, arrows to move) — but the input is sr-only, so draw the focus ring on a sibling with peer-focus-visible: (e.g. peer-focus-visible:ring-2 peer-focus-visible:ring-primary), otherwise keyboard users cannot see where they are.
- Never signal the selected item by colour alone: pair it with weight, an indicator bar, or an icon.
- Selecting must not shift the layout: if the active item is bolder/larger, reserve that space in EVERY item (fixed row height, or size the row for the active style) so the component's height and the neighbours' positions do not move when the selection changes.
- If the items can overflow horizontally, let the row scroll (overflow-x-auto) and hide the scrollbar visually (scrollbar-width:none plus ::-webkit-scrollbar{display:none} — Tailwind: [scrollbar-width:none]), never overflow-hidden, which would lock items out of reach.
- CSS-only cannot express drag, async or cross-component coordination — don't attempt those here; a component only owns the visible state of its own block.

STRUCTURE MUST BE EXTENSIBLE
- Items are a repeated block. Never style a specific item via nth-child, never hardcode the number of items, never position items with absolute coordinates — adding or removing one item must not require touching any other item.
- Tag every item with data-slot="<name>" (screens fill per-screen content by slot) and data-part="<role>" (tab / label / indicator / …) so tests and the inspector can address the pieces.

DESIGN SYSTEM
${args.designMd.trim()}

APP CONTEXT
- App: ${args.app.name}${args.app.brief?.trim() ? ` — ${args.app.brief.trim()}` : ''}
- ALLOWED ROUTES: ${routes}`;
}
export function componentUserPrompt(args: { name: string; instruction: string; currentHtml: string; usedBy: string[] }): string {
  const where = args.usedBy.length ? `It is used on ${args.usedBy.length} screen${args.usedBy.length > 1 ? 's' : ''}: ${args.usedBy.join(', ')}.` : 'No screen uses it yet.';
  return `Revise the shared component "${args.name}" according to this instruction:\n${args.instruction}\n${where}\nReturn the complete revised root element HTML only.\n\nCURRENT HTML:\n${args.currentHtml}`;
}
export function subtreeUserPrompt(screenName: string, route: string, fragment: string, instruction: string): string {
  return `Within the screen "${screenName}" at route ${route}, regenerate ONLY the following element according to this instruction:\n${instruction}\n\nReturn the complete replacement HTML for this single element (one root element, same role in the layout), nothing else. Keep the design system, recipes and any links intact unless the instruction says otherwise.\n\nCURRENT ELEMENT:\n${fragment}`;
}

export function repairUserPrompt(original: string, violations: { rule: string; message: string; sample?: string }[]): string {
  const list = violations.map((v) => `- [${v.rule}] ${v.message}${v.sample ? ` — e.g. ${v.sample}` : ''}`).join('\n');
  return `Your previous HTML violated the output rules:\n${list}\n\nFix every violation and return the corrected root element HTML only. Keep everything else identical.\n\nPREVIOUS HTML:\n${original}`;
}

// ---- 约定节（REQ-EDIT-003 / REQ-CORE-016）：DESIGN.md 里唯一由系统维护的一节 ----
export const CONVENTIONS_HEADING = '## 约定';
/** 从 DESIGN.md 取出约定条目（每条一行、`- ` 开头） */
export function parseConventions(designMd: string): string[] {
  const m = designMd.match(new RegExp(`${CONVENTIONS_HEADING}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
}
/** 整体替换约定节；没有该节就追加到末尾；空清单则删掉这一节 */
export function withConventions(designMd: string, lines: string[]): string {
  const body = lines.map((l) => `- ${l.trim()}`).join('\n');
  const re = new RegExp(`\\n?${CONVENTIONS_HEADING}\\s*\\n[\\s\\S]*?(?=\\n## |$)`);
  const stripped = designMd.replace(re, '').replace(/\s+$/, '');
  if (!lines.length) return stripped + '\n';
  return `${stripped}\n\n${CONVENTIONS_HEADING}\n${body}\n`;
}

// 设计系统提炼（REQ-EDIT-003）：把一句相对指令（「字再大一点」）与一张改后的屏，提炼成绝对规则与 / 或 token 变更。
// 带上改后的屏是为了让约定里写的数值与屏上实际一致，否则下次回刷会互相覆盖。
export function proposeDesignSystemSystemPrompt(fontFamilies: readonly string[]): string {
  return `You maintain the design system of an app in Quilt. The user gave an instruction meant to apply across ALL screens. Turn it into durable, ABSOLUTE rules and/or token changes. Output a JSON object (no markdown fences, no prose) with this exact shape:
{"summary":"one sentence in the user's language","conventions":["rule 1","rule 2"],"tokens":{"seedColor":"#RRGGBB","fontFamily":"Inter","radiusScale":"round"},"regenerate":true}
Rules:
- "conventions" is the FULL updated list (existing conventions merged with the new ones; drop ones the instruction retracts). Each rule is one line, absolute and checkable (e.g. "Body text is text-base (16px); section titles are text-xl"), never relative ("bigger"). Keep at most 20. Write rules in the user's language.
- Only include "tokens" keys that must change; omit "tokens" entirely if nothing token-level changes. fontFamily must be one of: ${fontFamilies.join(', ')}; radiusScale one of sharp / default / round; seedColor is a hex like #3B5BDB.
- "regenerate" is true when existing screens must be regenerated for the rules to show (layout, copy, component usage); false when a token change alone (colour / font / radius) fully expresses it.
- If the instruction is really about ONE screen's content and does not generalize, return the existing conventions unchanged with an empty diff and "regenerate": false, and say so in "summary".
Strictly valid JSON: double quotes, no trailing commas, no comments.`;
}
export function proposeDesignSystemUserPrompt(args: { instruction: string; designMd: string; tokens: Tokens; existing: string[]; sampleBody?: string }): string {
  const sample = args.sampleBody ? `\nA SCREEN AFTER THE INSTRUCTION WAS APPLIED (take actual values from here):\n${args.sampleBody}` : '';
  return `INSTRUCTION:\n${args.instruction}\n\nCURRENT CONVENTIONS:\n${args.existing.length ? args.existing.map((c) => `- ${c}`).join('\n') : '(none)'}\n\nCURRENT TOKENS: seedColor=${args.tokens.colors.primary} fontFamily=${args.tokens.typography.fontFamily} radius.md=${args.tokens.radius.md}\n\nDESIGN.md:\n${args.designMd.trim()}${sample}`;
}

export function defaultDesignMd(appName: string, seedColor: string, device: DeviceType): string {
  return `# ${appName} Design System

## Overview
${appName} uses a calm, content-first visual language: generous whitespace, one accent color for primary actions, and neutral surfaces that let photos and data stand out. Target: ${device === 'mobile' ? 'mobile app screens (390×844)' : 'desktop web app (1280×800)'}.

## Colors
Seed color ${seedColor} drives a Material HCT palette. Use \`primary\` for the single most important action per screen, \`primary-container\` for soft emphasis, \`surface\` for cards, \`surface-variant\` for inset areas, \`outline-variant\` for hairlines, \`error\` only for destructive or invalid states.

## Typography
One sans family. Scale: text-xs (captions), text-sm (secondary), text-base (body), text-lg (card titles), text-xl (section titles), text-2xl/3xl (screen titles). Weights: medium for labels, semibold for titles, bold for numbers that matter.

## Layout
${device === 'mobile' ? 'Single column, 16px horizontal padding, 24px between sections, 12px between list rows. Sticky bottom TabBar on main screens; back-arrow AppBar on detail screens.' : 'Left Sidebar (240px) + main area with 32px padding; content max-width 1040px; cards in 2–3 column grids with 24px gaps.'}

## Elevation
Flat by default. Cards separate by hairline (\`border-outline-variant\`) not shadow. \`shadow-sm\` only for floating elements (bottom sheets, FABs).

## Shapes
Radius tokens: rounded-sm for chips/inputs, rounded-md for cards/list thumbnails, rounded-lg for sheets/hero images, rounded-full for buttons and avatars.

## Components
Reuse the component recipes verbatim: AppBar, TabBar${device === 'desktop' ? ', Sidebar' : ''}, Card, ListItem, PrimaryButton, SecondaryButton, Chip, Input, ProgressBar. One PrimaryButton per screen at most.

## Do's and Don'ts
Do: real content, consistent 8px rhythm, one accent per screen, visible labels. Don't: multiple competing primary buttons, lorem ipsum. Reach past the tokens (hex, arbitrary values, inline styles) only when this system cannot express the design — those values stop following theme changes.
`;
}
