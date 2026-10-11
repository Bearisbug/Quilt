import { COLOR_CLASS_NAMES, NEUTRAL_PALETTE, tokensFromSeed, type Tokens } from './tokens.ts';
import { EDIT_BLOCK } from './edits.ts';
import { DEVICE_SIZE, type DeviceType, type Presentation } from './device.ts';
import { componentPlacement, sharedComponentsSection, type SharedComponentCard } from './component-meta.ts';

// 设计契约（ADR-005 / ADR-012）：每次生成都带，体积与屏幕数无关。组件配方来自设计系统 components。
export type ComponentRecipe = { name: string; html: string; note?: string };
export type PlannedScreen = { name: string; route: string; purpose: string; links: string[]; sections: string[]; presentation?: Presentation };
// 整组规划（REQ-CORE-003）：brief 只在空项目首轮扩写；entryFrom 是既有哪一屏进入新组（反向连线的靶子）
export type Plan = { screens: PlannedScreen[]; brief?: string; entryFrom?: string | null };
export type AppContext = { name: string; description: string; brief?: string };
/** 屏注册表条目（ADR-012 稳定前缀）：每屏 route / name / purpose */
export type RegistryEntry = { route: string; name: string; purpose?: string };
/** 情境层参考屏（ADR-012）：样板屏 / 来源屏 */
export type ReferenceScreen = { label: string; body: string };

// 新建项目的组件配方（ADR-028 v0.92，按设备各一套）：克制的现代风格——圆角按角色取小档（新项目用 sharp 档：
// rounded-md 4px、rounded-lg 8px），rounded-full 只给头像、计数徽标与进度条；分隔先靠留白与底色，线只在行与行之间。
// 配方随项目存（design_systems.components），改这里只影响新建项目
const MOBILE_COMPONENTS: ComponentRecipe[] = [
  { name: 'AppBar', html: '<header class="h-14 flex items-center justify-between px-4 bg-background">', note: 'title text-on-surface: main screens text-2xl font-semibold tracking-tight, detail screens text-base font-semibold; icon buttons w-11 h-11 -mr-2 flex items-center justify-center rounded-lg text-on-surface-variant; no bottom border' },
  { name: 'TabBar', html: '<nav class="sticky bottom-0 mt-auto grid grid-cols-4 bg-background border-t border-outline-variant">', note: 'mobile main screens only; each tab <a class="flex flex-col items-center gap-1 pt-2 pb-3 text-xs text-on-surface-variant">, the active tab text-primary font-medium (icon and label); scrolling content lives in <main class="flex-1 overflow-y-auto"> above it' },
  { name: 'Card', html: '<div class="bg-surface rounded-lg border border-outline-variant p-4">', note: 'one standalone object without a photo (a chart panel, a summary with 3+ facts and an action); an item with a photo is the photo with its text below on the page, never a photo inset in a bordered box; at most two per screen; never nested, never around a list or a form' },
  { name: 'ListItem', html: '<a class="flex items-center gap-3 py-3">', note: 'rows live in <ul class="divide-y divide-outline-variant"> (directly on the page; only a settings or form group sits in a bg-surface rounded-lg border border-outline-variant px-4 block); leading Avatar or w-10 h-10 rounded-lg thumbnail, a flex-1 min-w-0 text block, a trailing value or chevron-right w-4 h-4 text-on-surface-variant' },
  { name: 'PrimaryButton', html: '<button type="button" class="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg bg-primary text-on-primary text-sm font-medium">' },
  { name: 'SecondaryButton', html: '<button type="button" class="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg border border-outline-variant bg-surface text-on-surface text-sm font-medium">' },
  { name: 'Chip', html: '<span class="inline-flex items-center h-8 px-3 rounded-lg bg-surface-variant text-on-surface-variant text-sm">', note: 'filters; the one selected filter is bg-primary text-on-primary font-medium; categories, breeds and statuses are text, not chips' },
  { name: 'Input', html: '<input class="w-full h-11 px-3 rounded-lg bg-surface border border-outline text-base text-on-surface placeholder:text-on-surface-variant">', note: 'label text-sm font-medium above it, hint or error text-sm below' },
  { name: 'Avatar', html: '<span class="inline-flex items-center justify-center w-10 h-10 shrink-0 rounded-full bg-surface-variant text-on-surface-variant text-sm font-medium">', note: 'initials; a photo only from PROJECT ASSETS' },
  { name: 'Badge', html: '<span class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary text-on-primary text-xs font-medium tabular-nums">', note: 'unread / open counts on tabs, nav items and rows' },
  { name: 'ProgressBar', html: '<div class="h-1.5 rounded-full bg-surface-variant"><div class="h-1.5 w-3/5 rounded-full bg-primary"></div></div>', note: 'widths via fraction classes w-1/12 … w-11/12 / w-full; bar charts are flex rows of such bars; the fill turns bg-warning from 85% of a limit and bg-error past it; never inline style' },
];
const DESKTOP_COMPONENTS: ComponentRecipe[] = [
  { name: 'Sidebar', html: '<aside class="w-60 shrink-0 h-dvh sticky top-0 flex flex-col bg-background border-r border-outline-variant">', note: 'brand row h-14 px-4 (the PROJECT ASSETS logo plus the app name, else the app name alone, text-sm font-semibold); nav <nav class="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">, each link <a class="flex items-center gap-2 h-8 px-2 rounded-md text-sm text-on-surface-variant"> with a w-4 h-4 icon, the active link bg-surface-variant text-on-surface font-medium; counts as a Badge at the end of the link' },
  { name: 'PageHeader', html: '<header class="flex items-start justify-between gap-6 pb-6">', note: 'left: h1 text-xl font-semibold tracking-tight plus one line of facts text-sm text-on-surface-variant; right: actions at natural width; filters or tabs directly below' },
  { name: 'Card', html: '<div class="bg-surface rounded-lg border border-outline-variant">', note: 'a dashboard panel: header row px-5 py-4 (title text-base font-semibold, an action link right, no rule under it), body px-5 pb-5; never nested, never around a whole page section, a full-width table, a list or a filter row' },
  { name: 'StatRow', html: '<div class="grid grid-cols-4 gap-8">', note: 'headline figures: each a label text-sm text-on-surface-variant, a value text-2xl font-semibold tabular-nums, a delta text-xs below; no boxes, icons or dividers between figures' },
  { name: 'Table', html: '<table class="w-full text-sm">', note: 'thead th h-9 px-3 text-left text-xs font-medium text-on-surface-variant border-b border-outline-variant whitespace-nowrap, no fill; tbody tr border-b border-outline-variant last:border-0, td h-11 px-3; numbers, dates, statuses and actions whitespace-nowrap, numbers text-right tabular-nums; the first column is the record name font-medium with secondary facts (provider, ID, owner) as a text-xs text-on-surface-variant line under it, not extra columns; at most 7 columns (4 in a half-width panel); one action per row (a text link or a more-horizontal icon button); a full-width table sits on the page under its heading, no Card around it' },
  { name: 'ListItem', html: '<a class="flex items-center gap-3 py-2.5">', note: 'rows live in <ul class="divide-y divide-outline-variant">; leading Avatar or w-8 h-8 rounded-md thumbnail, a flex-1 min-w-0 text block, a trailing value' },
  { name: 'PrimaryButton', html: '<button type="button" class="inline-flex items-center justify-center gap-2 h-9 px-3.5 rounded-md bg-primary text-on-primary text-sm font-medium">' },
  { name: 'SecondaryButton', html: '<button type="button" class="inline-flex items-center justify-center gap-2 h-9 px-3.5 rounded-md border border-outline-variant bg-surface text-on-surface text-sm font-medium">' },
  { name: 'Chip', html: '<span class="inline-flex items-center h-6 px-2 rounded-md bg-surface-variant text-on-surface-variant text-xs font-medium">', note: 'filters; the one selected filter is bg-primary text-on-primary; categories and statuses are text, not chips' },
  { name: 'Input', html: '<input class="w-full h-9 px-3 rounded-md bg-surface border border-outline text-sm text-on-surface placeholder:text-on-surface-variant">', note: 'label text-sm font-medium above it, hint or error text-xs below; form fields and search only: a filter dropdown in a toolbar is a SecondaryButton with a trailing chevron-down w-4 h-4' },
  { name: 'Avatar', html: '<span class="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full bg-surface-variant text-on-surface-variant text-xs font-medium">', note: 'initials; a photo only from PROJECT ASSETS' },
  { name: 'Badge', html: '<span class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-surface-variant text-on-surface-variant text-xs font-medium tabular-nums">', note: 'counts on nav items, tabs and rows; bg-primary text-on-primary only for something that needs action' },
  { name: 'ProgressBar', html: '<div class="h-1.5 rounded-full bg-surface-variant"><div class="h-1.5 w-3/5 rounded-full bg-primary"></div></div>', note: 'widths via fraction classes w-1/12 … w-11/12 / w-full; the fill turns bg-warning from 85% of a limit and bg-error past it; never inline style' },
];
export function defaultComponents(device: DeviceType): ComponentRecipe[] {
  return device === 'mobile' ? MOBILE_COMPONENTS : DESKTOP_COMPONENTS;
}

// 稳定前缀（ADR-012 v0.31）：规则 → DESIGN.md（含约定）→ 配方 → 应用简介 → 屏注册表；参考屏放在最后（每作业可变）。
// 同一作业里多屏并行共用这一份 system，prompt cache 命中的就是这个前缀。
export type ProjectAsset = { name: string; url: string; width: number; height: number };

// 美学基线（ADR-028，v0.92 接替 v0.91 的 CRAFT DEFAULTS）：克制的现代风格——中性灰承担界面，一个强调色标出重点，
// 结构靠对齐与留白，不靠框、线和特效。具体颜色、字体、圆角数值仍由项目 token 定；第一行写优先级。
// 只随设备变、不随项目变，放在稳定前缀里输出规则之后（ADR-012 v0.91 修订）。文字经过真实模型盲评（TEST.md TC-CORE-084），改动要重跑
const CRAFT_LINES = [
  `AESTHETIC BASELINE (restrained, modern; the tokens set the actual values)`,
  `- Precedence: the request (incl. planned sections and EARLIER INSTRUCTIONS), APP BRIEF, DESIGN SYSTEM and its 约定, recipes, shared components and PROJECT ASSETS override any line here. REFERENCE SCREENS set density and component usage, not what the Lines, Radius and Never lines rule out. When revising or making a state variant, apply this only to what changes.`,
  `- The look: calm and precise; neutral greys carry the screen, one accent marks what matters, structure comes from alignment and spacing.`,
  `- Lines and boxes: separate by spacing first, then by a bg-surface-variant block, lines last. A line is 1px border-outline-variant, only between rows of one list or table, under a sticky bar, or around an input or one panel. A section is its heading plus content on the page, not a box; never box every section, stack a border, a divider and a fill on one block, or use border-2+; no rule between gapped columns or on a list's outer edge.`,
  `- Radius (small, set by role): controls and thumbnails use the recipes' radius, containers rounded-lg; rounded-full only for avatars, status dots, count badges, toggles and progress tracks. No pill-shaped buttons, chips or tabs, no rounded-xl or larger; an inner corner is never rounder than its container.`,
  `- Type: hierarchy by size and weight, not colour or boxes; page title, section heading and row title each a size step apart; titles and key figures font-semibold (page titles tracking-tight), labels and buttons font-medium, secondary text text-on-surface-variant; at most 5 sizes; tabular-nums on figures and numeric cells only; no all-caps or letter-spaced labels.`,
  `- Colour: primary only for the primary action, links, the selected filter or tab, the active item and the main data series (a second series in the outline grey); everything else neutral. No tinted section backgrounds, no icon tiles of any colour. Status colours only for real status, as a dot, text or bar fill with a word; outside a status column mark only the exceptions.`,
  `- Space: 4px grid; within a group gap-1 or gap-2, between groups gap-3 or gap-4, between sections gap-8 (mobile gap-6); one value per tier per screen; a heading sits closer to its content than to what comes before it.`,
  `- Focus: the first viewport holds the title, what the user came for and its primary action. Only overview, report and monitoring screens open with 2-4 headline figures (text-2xl font-semibold tabular-nums over a text-sm label) before any chart or list; key totals never hide in a subtitle.`,
  `- Components: at most one PrimaryButton, other actions SecondaryButton or text-primary links; each action appears once per screen; metadata is text, not chips.`,
  `- Fit: figures with units, prices, times, statuses, chips, button and link labels and table headers whitespace-nowrap; facts on one line are one text run joined by ' · '; truncate meta, IDs, emails and previews, never a name or price; titles wrap or line-clamp-2; in rows the text column is flex-1 min-w-0 and trailing values share one right edge.`,
  `- Data and copy: specific, realistic, internally consistent (every count, total and 'X of Y' matches what is shown); every figure has its unit, currency or period. Headings name the content, buttons start with a verb. No greetings, emoji, taglines, buzzwords, New or AI pills, or text explaining the UI.`,
  `- Icons: lucide, w-4 h-4 in rows and buttons, w-5 h-5 in bars, in the colour of their text, only where they help scanning; never one on every heading, stat or card.`,
  `- Never unless the request or DESIGN SYSTEM asks: gradients, glows, coloured or large shadows, glass or backdrop-blur, text-shadow, hero banners on app screens, icon + title + blurb card trios, letter-tile logos, decorative illustrations. Asked to make it nicer: fix hierarchy, spacing and copy, remove decoration, never add boxes, shadows, badges or icons.`,
  `- States: keep the chrome. Empty: one muted w-8 h-8 icon, a title, one sentence, one action. Loading: bg-surface-variant blocks shaped like the content, motion-safe:animate-pulse. Error: inline, saying what failed and the fixing action.`,
];
const CRAFT_DEVICE: Record<DeviceType, string> = {
  mobile: `- Mobile: one column with px-4 on bg-background; lists are divide-y ListItem rows on the page under their heading; at most two Cards; controls h-11; 8-10 rows per list. Feed media runs edge to edge (-mx-4, no radius) with text below. Carousels: -mx-4 px-4 py-1 flex gap-3 overflow-x-auto inside a px-4 block, items shrink-0. A flow screen (no TabBar) pins its primary action in a sticky bottom-0 bar (px-4 py-3 bg-background border-t border-outline-variant) as the root's last child, or for a submit the last child of its <form class="flex-1 flex flex-col">; never inside an overflow-y-auto box.`,
  desktop: `- Desktop: denser. Body text-sm, controls h-9. The page opens with the PageHeader (title and one line of facts left, actions right, filters below). Records compared field by field go in the Table recipe (8-12 rows, at most 7 columns); feeds and messages stay rows in a max-w-3xl column; card grids only for visual objects. Dashboards: the StatRow of headline figures, then panels (the Card recipe) in a 2-3 column grid; panels in one row of similar length, none stretched. Forms: a max-w-2xl field column with a w-80 summary or preview aside on the right (sticky top-8) that holds the primary action; never one narrow column with the right half empty.`,
};
export function craftRules(device: DeviceType): string {
  return [...CRAFT_LINES, CRAFT_DEVICE[device]].join('\n');
}
// 图片（ADR-027 ④）：picsum 只给随机照片，种子只保证稳定——照片不能承载含义，头像与 logo 另有来源。
// 出屏提示词与 get_design_contract 共用这一句
export const PICSUM_PHOTO_NOTE = 'picsum returns a RANDOM photo: the seed keeps it stable (reuse it for the same item on every screen) but never picks the subject, so a photo must not carry meaning. Use photos where any real-world photo fits (feed media, covers, places), with titles beside or below, never on top.';
const IMAGES_RULE = `- Images: <img src="https://picsum.photos/seed/ITEM-ID/W/H" class="... object-cover" alt="..."> in a fixed frame (w-*/h-*, aspect-square, aspect-video, or w-full with a fixed h-* for other ratios), W/H about 2× the frame and at most 1600. ${PICSUM_PHOTO_NOTE} Avatars are initials (bg-surface-variant text-on-surface-variant) unless PROJECT ASSETS has the photo; logos come only from PROJECT ASSETS, else the app name alone as a text wordmark (no letter tile).`;

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
- Radius: small and set by role (see AESTHETIC BASELINE): the recipes' radius for controls, rounded-lg for containers, rounded-full only for avatars, dots, count badges, toggles and progress tracks. Shadows: none on in-flow content; shadow-sm only on layers that float over it (sheets, menus, FABs) unless the DESIGN SYSTEM's Elevation says otherwise.
- Simple progress bars: the ProgressBar recipe (fraction widths) needs no script. Real data visualisation may pull in a charting library — see LIBRARIES.
- Typography: text-xs … text-3xl, font-medium / font-semibold / font-bold. ${tokens.typography.fontFamily} is ${tokens.typography.fontSource === 'system' ? 'the device font (installed locally, no webfont to load)' : 'preloaded'}.
- Icons: <i data-lucide="icon-name" class="w-5 h-5"></i> using any lucide icon name that fits the meaning (e.g. home, search, bell, settings, user, users, calendar, clock, map-pin, message-circle, wallet, receipt, credit-card, shopping-cart, utensils, car, book-open, chart-line, wind, moon, heart, star, plus, check, x, chevron-left, chevron-right, more-horizontal).
${IMAGES_RULE}
- Navigation: every tappable element that leads to another screen MUST navigate to a route from ALLOWED ROUTES only. Links, cards and button-like actions are <a href="/route"> (style them with the button recipes). Every <form> MUST have action="/route" (the screen shown after submitting) and its primary action MUST be <button type="submit"> — never type="button" for Log in / Sign up / Send / Save / Continue. A button that must stay a <button> but leads somewhere carries data-href="/route". If the destination screen is NOT in ALLOWED ROUTES (a tab or action that has no screen yet), write href="#" — a dead link the prototype explains to the user — and NEVER point it at an unrelated existing screen. Only buttons that truly do nothing (toggles, steppers) are <button type="button"> without data-href.
- Forms: every <input>/<select>/<textarea> has a meaningful name, a visible <label for> (or aria-label for search fields), and autocomplete/inputmode where relevant. Tap targets are at least h-11 (44px) on mobile and h-8 (32px) on desktop; recipes keep their own sizes. Disabled controls use the disabled attribute plus opacity-50, never color alone.
${deviceRules}
- LIBRARIES: <script> tags and any https: CDN are allowed (Chart.js, ECharts, your own component library…). Load them inside the screen's root element, keep the screen self-contained, and remember the screen must still render something sensible if the CDN is slow — no blank screens waiting on network. The player re-runs a screen's inline scripts every time it is shown in the same page: bind listeners to elements inside the root (not to document/window), so they do not pile up across visits.
- WHEN TO BREAK THEM: the tokens and recipes above are this project's shared vocabulary, not a fence. If the design you are asked for needs a colour, spacing, shape or effect they cannot express — you are exploring a NEW visual direction, not filling in the current one — write it directly (hex, inline style, arbitrary values, your own CSS in a <style> tag). Nothing is rejected for it. Know the price and take it deliberately: hardcoded colours will NOT follow a later theme change, and screens that lean on a CDN degrade when it is unavailable. Quilt records every deviation per screen so the designer can see what drifted.
- Content: realistic and specific (real-sounding names, prices, dates, counts). No lorem ipsum. English UI copy.

${craftRules(device)}

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
{${opts.empty ? '"brief":"…",' : '"entryFrom":"/existing-route",'}"screens":[{"name":"Home","route":"/home","purpose":"one sentence","links":["/other-route"],"sections":["section 1","section 2"],"presentation":"push"}]}
Rules: ${countRule}; ${PRESENTATION_RULE} routes are lowercase kebab-case starting with "/" and MUST NOT collide with EXISTING ROUTES; every screen links to at least one other screen and all links use routes from this plan or from EXISTING ROUTES; sections are 3–5 short phrases describing what the screen contains, top to bottom; ${extra} Strictly valid JSON: double quotes, no trailing commas, no comments.`;
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
{"name":"Profile Detail","route":"/profile-detail","purpose":"one sentence","links":["/existing-route"],"sections":["section 1","section 2","section 3"],"entryFrom":"/existing-route","presentation":"push"}
Rules: ${PRESENTATION_RULE} route is lowercase kebab-case starting with "/" and MUST NOT be one of the EXISTING ROUTES; links is a subset of EXISTING ROUTES — only include a route when this screen obviously navigates there, and leave it an empty array when the flow is not decided yet (empty is the normal case, do not force links); entryFrom is the EXISTING route that would naturally link INTO this screen, or null when none is obvious; sections are 3–5 short phrases describing what the screen contains, top to bottom; name is 1–3 words in the same language as the existing screen names. Strictly valid JSON: double quotes, no trailing commas, no comments.`;
}
export function planOneScreenUserPrompt(app: AppContext, description: string, existing: RegistryEntry[]): string {
  const list = existing.map((r) => `${r.route} (${r.name}${r.purpose ? `: ${r.purpose}` : ''})`).join(', ') || '(none)';
  return `App: ${app.name}${app.brief ? ` — ${app.brief}` : ` — ${app.description}`}\nEXISTING ROUTES: ${list}\nRequested screen: ${description}`;
}

export function screenUserPrompt(s: PlannedScreen, all: PlannedScreen[], opts: { variant?: { ofName: string; name: string } } = {}): string {
  const links = s.links.map((r) => `${r} (${all.find((x) => x.route === r)?.name ?? r})`).join(', ');
  // 没规划出链接的屏（凭空生成常见）：明说它暂不需要跳转，免得模型硬编去向；表单的 action 仍受 lint 约束（form-action）
  const nav = links ? `It must link to: ${links}.` : 'It does not need to navigate to any other screen yet: use href="#" for actions whose destination is undecided; forms still need action="/route" (a plausible new route is fine).';
  const sections = s.sections.length ? `\nSections, top to bottom: ${s.sections.join('; ')}` : '';
  const variant = opts.variant ? `\n${variantNote(opts.variant.ofName, opts.variant.name)}` : '';
  const overlay = s.presentation === 'overlay' ? `\n${OVERLAY_SCREEN_NOTE}` : '';
  return `Generate the screen "${s.name}" at route ${s.route}.\nPurpose: ${s.purpose}${sections}\n${nav}${variant}${overlay}\nReturn only the root element HTML.`;
}

// 规划器给每屏定呈现方式（v0.63 REQ-PROTO-005）：弹层类才是 overlay，其余一律 push
const PRESENTATION_RULE = '"presentation" is "overlay" ONLY for a screen that is presented on top of another one (bottom sheet, dialog, action sheet, picker, confirmation) and "push" for every full screen;';
// 叠层屏的出屏说明（v0.63）：只写弹层本身，根透明，遮罩由播放器画；关闭动作指回来处
export const OVERLAY_SCREEN_NOTE = 'This screen is an OVERLAY presented on top of another screen (a bottom sheet, dialog or action sheet). Output only the overlay surface: the root element must have a transparent background (class "bg-transparent", never bg-background) and position the surface — a bottom sheet is a min-h-dvh flex flex-col justify-end root with the sheet panel (bg-surface, rounded-t-lg) at the bottom; a dialog is a min-h-dvh flex items-center justify-center root with a centered panel (bg-surface, rounded-lg, mx-6). Do NOT draw a dim scrim yourself — the player dims the screen underneath. Include an explicit close/cancel action that navigates back to the screen it opened from (<a href="/that-route">).';
// 状态变体的出屏说明（v0.62 REQ-CORE-025）：同一屏的另一个状态——布局、导航、视觉不变，只改状态所指的那部分
export function variantNote(ofName: string, name: string): string {
  return `This is the "${name}" state VARIANT of the existing screen "${ofName}" (same route, same app bar, same navigation, same visual language — the reference labelled "default screen" shows exactly how it looks). Keep everything that does not depend on the state identical to that default screen; change only what the "${name}" state implies (for example an empty state replaces the list with an illustration, a one-line explanation and the primary action; an error state shows what went wrong and a retry; a loading state shows skeleton placeholders; a logged-out state shows the sign-in prompt where the personal content would be).`;
}

// 「补链」修复轮（REQ-PROTO-002）：作为 edit_screens 的固定指令，把未连上路由的导航动作连好，其余不动
export const LINK_REPAIR_PROMPT = 'Connect every navigation action on this screen to a route from ALLOWED ROUTES: form submit buttons must be <button type="submit"> inside a <form action="/route">; buttons, cards or rows that lead to another screen must become <a href="/route"> (or keep the <button> and add data-href="/route"); navigation whose destination has no screen in ALLOWED ROUTES becomes href="#" instead of pointing at an unrelated screen. Keep all text, layout and classes identical otherwise.';
// 反向连线（REQ-CORE-014）：造一组屏后对入口屏跑一次补链，把新组路由标为「本次新增」让它优先连过去
export function linkRepairPrompt(newRoutes: string[]): string {
  return newRoutes.length ? `${LINK_REPAIR_PROMPT}\nNEWLY ADDED ROUTES (this screen is their entry point — connect the matching actions to them first): ${newRoutes.join(', ')}.` : LINK_REPAIR_PROMPT;
}
// 「按新约定重生成」（REQ-EDIT-003）：约定写进 DESIGN.md 之后对全部屏跑一轮的固定指令
export const CONVENTIONS_REGENERATE_PROMPT = 'Rework this screen so it follows every rule in the DESIGN SYSTEM section named "约定" (conventions). Keep the screen\'s purpose, content, links and overall layout; change only what the conventions require.';
// 懒生成补屏（REQ-PROTO-003）与出变体（REQ-CORE-025）的提示词：画布发起与「修改」重发共用
export const missingPagePrompt = (route: string): string => `Screen for route ${route}`;
export const variantPrompt = (name: string): string => `The ${name} state`;
// 系统代发轮次的提示词底稿（REQ-CORE-026 v0.74）：「修改」重发时用户写的字作为附加要求接在底稿之后；
// presetNote 从提示词里反解出附加要求（没有附加要求为空串），不是这份底稿时返回 null
export const ROUND_PRESETS = ['link_repair', 'conventions'] as const;
export type RoundPresetKind = (typeof ROUND_PRESETS)[number];
export const ROUND_PRESET_PROMPTS: Record<RoundPresetKind, string> = { link_repair: LINK_REPAIR_PROMPT, conventions: CONVENTIONS_REGENERATE_PROMPT };
const NOTE_MARK = '\n\nADDITIONAL REQUIREMENTS FROM THE USER: ';
export const presetPrompt = (base: string, note: string): string => (note.trim() ? `${base}${NOTE_MARK}${note.trim()}` : base);
export function presetNote(prompt: string, base: string): string | null {
  if (prompt === base) return '';
  return prompt.startsWith(base + NOTE_MARK) ? prompt.slice(base.length + NOTE_MARK.length) : null;
}

// 批注合并成一条整屏指令（REQ-EDIT-004）：每屏一次作业，逐条点名元素 qid 与当初的可见文案，
// 元素已不存在时让模型按文案自行判断、忽略即可，不要因为一条批注失效就放弃整屏。
export function annotationsPrompt(items: { qid: string; note: string; anchorText: string }[]): string {
  const list = items.map((a, i) => `${i + 1}. 元素 data-qid="${a.qid}"${a.anchorText ? `（当时文案「${a.anchorText}」）` : ''}：${a.note}`).join('\n');
  return `Apply the following element-level change requests to this screen. Each item names the element by its data-qid (and the visible text it had when the note was written):\n${list}\n\nChange only what these items ask for; keep every other element's text, layout, classes and links identical. If an element no longer exists, use its recorded text to locate the equivalent element, and skip the item if there is none.`;
}

// 历史指令块（ADR-012 v0.87）：改屏 / 局部重生成 / 改组件 / 本机 agent 投递共用；items 已按新到旧排好（history.ts）。
// subject 如 THIS SCREEN、THIS COMPONENT、SCREEN "首页" (/home)；没有历史时为空串
export function priorInstructionsBlock(subject: string, items: string[]): string {
  return items.length
    ? `EARLIER INSTRUCTIONS ALREADY APPLIED TO ${subject} (most recent first; keep honoring them unless the new instruction overrides one):\n${items.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n`
    : '';
}

// 改屏（REQ-CORE-006）：目标屏当前 HTML + 本次指令 + 该屏 current 祖先链上的历史指令（ADR-012：已应用过的意图，不是时间序）
export function editUserPrompt(screenName: string, route: string, currentBody: string, instruction: string, priorInstructions: string[] = []): string {
  const prior = priorInstructions.length ? `\n${priorInstructionsBlock('THIS SCREEN', priorInstructions)}` : '';
  return `Revise the screen "${screenName}" at route ${route} according to this instruction:\n${instruction}\n${prior}\nKeep the design system, recipes and all links intact unless the instruction says otherwise. Return the complete revised root element HTML only.\n\nCURRENT HTML:\n${currentBody}`;
}
// 改屏默认要补丁（ADR-007 v1.05）：只写改动，不重抄整屏——桌面屏整屏重写要输出几万 token、写几分钟。
// 改动占了大半屏时模型可以直接回整屏；补丁对不上当前 HTML 时由流水线退回上面的整屏提示词再要一次
export function editPatchUserPrompt(screenName: string, route: string, currentBody: string, instruction: string, priorInstructions: string[] = []): string {
  const prior = priorInstructions.length ? `\n${priorInstructionsBlock('THIS SCREEN', priorInstructions)}` : '';
  return `Revise the screen "${screenName}" at route ${route} according to this instruction:\n${instruction}\n${prior}\nKeep the design system, recipes and all links intact unless the instruction says otherwise.

Reply with edits to CURRENT HTML instead of rewriting it: one or more blocks, each exactly

${EDIT_BLOCK.find}
text copied verbatim from CURRENT HTML
${EDIT_BLOCK.sep}
what replaces it (empty to delete)
${EDIT_BLOCK.replace}

- FIND is copied character for character from CURRENT HTML, data-qid attributes included, and occurs there exactly once. Make it just long enough to be unique — a whole opening tag with its data-qid usually is.
- Blocks apply in order, each to the result of the previous one. Change only what the instruction asks; everything outside the blocks stays as it is.
- Keep the data-qid of every element you keep; new elements need none.
- Output only the blocks: no commentary, no code fences.
- If the instruction rewrites most of the screen, return the complete revised root element HTML instead of blocks.

CURRENT HTML:
${currentBody}`;
}

// 聊天（REQ-CORE-023 / ADR-018）：住在 Quilt 进程里的助手的稳定前缀——每轮重发、随项目更新。
// 不带任何整屏 HTML：屏的结构靠 quilt.get_outline 看目录，整屏只在助手用 get_screen 读时进上下文；对话记忆在 SDK 会话里。
export type ChatScreen = { id: string; name: string; route: string; purpose?: string; currentRevisionId: string | null; presentation?: Presentation };
export function chatSystemPrompt(args: { app: AppContext; device: DeviceType; designMd: string; screens: ChatScreen[]; projectId: string; jobId: string; designVersion: number; components?: SharedComponentCard[] }): string {
  const size = DEVICE_SIZE[args.device];
  const registry = args.screens.length
    ? args.screens.map((s) => `  - ${s.name} (${s.route}) screenId=${s.id} revision=${s.currentRevisionId ?? 'none'}${s.presentation === 'overlay' ? ' [overlay]' : ''}${s.purpose ? ` — ${s.purpose}` : ''}`).join('\n')
    : '  (no screens yet)';
  // 共享组件（REQ-EDIT-006）：助手改导航这类东西要走组件，而不是逐屏手改它的副本
  const shared = args.components?.length
    ? `\n- SHARED COMPONENTS (project-level; every screen places them by reference and Quilt fills them in — quilt.get_design_contract has their full HTML):\n${args.components.map((c) => `  - ${c.name} — ${c.summary} · placed with ${componentPlacement(c.name, c.tag, c.slots)}`).join('\n')}\n  To change how one looks everywhere, call quilt.update_component (expectedVersion from the contract) — never hand-edit its copy inside a screen (Quilt overwrites that on the next write). To turn part of a screen into a new shared component, quilt.create_component with that element's HTML, then place it on the screens with the tag above.`
    : '';
  return `You are Quilt's design assistant, living inside the Quilt canvas for the app "${args.app.name}" (projectId ${args.projectId}, ${args.device} ${size.w}×${size.h}). The designer talks to you in the chat box. The app's screens live on an infinite canvas as separate HTML documents — one per screen, all sharing one design system — and you reach them only through the quilt.* tools. You decide the scope yourself: answer a question without touching anything, change one screen, change several, or change the design system — whatever the message actually asks for. When it is only a question or a request for an opinion, reply and change nothing.

HOW TO SEE THE PROJECT
- SCREENS below is the registry: name, route, screenId, current revision id, purpose.
- quilt.get_outline { projectId, screenIds? } gives every screen's structure (landmarks, headings, links, buttons, inputs, images — each with its data-qid and text). Call it first whenever the message concerns existing screens; it is cheap and usually enough to decide what to do.
- quilt.get_screen { screenId } returns ONE screen's body HTML (with data-qid). Read only the screens you are going to change or must inspect in detail.
- quilt.get_screenshot { screenId } shows how a screen renders. Use it when the question is visual (spacing, hierarchy, colour, "does this look right").
- quilt.get_design_contract { projectId } is the design system in machine form: tokens, colour classes, component recipes, DESIGN.md, assets, rules. Read it once before writing any HTML in this conversation, and again after you change the design system.

HOW TO CHANGE THINGS
- Change part of a screen with quilt.patch_screen { screenId, expectedRevisionId, edits:[{ find, replace }], jobId } — find is the exact current text from quilt.get_screen; this keeps each call short. Rewrite a whole screen with quilt.update_screen { projectId, screenId, html, expectedRevisionId, jobId }; over ~8 KB of HTML write it as quilt.create_upload_url + quilt.append_upload chunks and pass uploadId. On both ALWAYS pass jobId="${args.jobId}" and the screen's current revision id (from SCREENS or quilt.get_outline). On 409 revision-conflict re-read the screen and redo the change on the current version; on 409 screen-busy another job is editing that screen — say so in your reply instead of retrying.
- html is the screen's single root element (<div class="min-h-dvh flex flex-col bg-background text-on-background">…</div>) with everything inside it; no <html>, <head> or <body>. Keep every part the message did not ask you to change identical (text, classes, links, data-qid attributes). Stay inside the design system's token classes and recipes unless the design genuinely needs something they cannot express — Quilt records such deviations per screen and they will not follow a later theme change. A screen marked [overlay] is a sheet or dialog shown on top of another screen: its root stays transparent (bg-transparent), never bg-background.
- New screen: quilt.create_screen { projectId, name, route, html, jobId } with a route that is not in SCREENS; link it from the screen it belongs to when that is obvious.
- Theme-wide changes (colour, font, radius, palette, DESIGN.md text): quilt.update_design_system with expectedVersion=${args.designVersion} and applyToScreens=true so every screen is re-baked — never hand-edit every screen for something a token change expresses.
- Project name or brief: quilt.update_project.
- Do NOT call quilt.finish_job (this turn closes itself), and do not start quilt.generate_screens / quilt.edit_screens unless the designer explicitly asks for many new screens at once — those run as separate jobs on another channel.

HOW TO REPLY
- Reply in the designer's language, plainly, in a few sentences or a short list — this is a chat, not a report. No markdown headings.
- Say what you changed (screen names) and any decision you made on the designer's behalf; if you took a deviation from the design system or hit a conflict, say so. If you changed nothing, say that.
- Earlier turns of this conversation are in your context: "刚才那个", "the one before", "put it back" refer to them.

${craftRules(args.device)}

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
export function componentUserPrompt(args: { name: string; instruction: string; currentHtml: string; usedBy: string[]; prior?: string[] }): string {
  const where = args.usedBy.length ? `It is used on ${args.usedBy.length} screen${args.usedBy.length > 1 ? 's' : ''}: ${args.usedBy.join(', ')}.` : 'No screen uses it yet.';
  return `Revise the shared component "${args.name}" according to this instruction:\n${args.instruction}\n${where}\n${priorInstructionsBlock('THIS COMPONENT', args.prior ?? [])}Return the complete revised root element HTML only.\n\nCURRENT HTML:\n${args.currentHtml}`;
}
export function subtreeUserPrompt(screenName: string, route: string, fragment: string, instruction: string, priorInstructions: string[] = []): string {
  const prior = priorInstructions.length ? `\n${priorInstructionsBlock('THIS SCREEN', priorInstructions)}` : '';
  return `Within the screen "${screenName}" at route ${route}, regenerate ONLY the following element according to this instruction:\n${instruction}\n${prior}\nReturn the complete replacement HTML for this single element (one root element, same role in the layout), nothing else. Keep the design system, recipes and any links intact unless the instruction says otherwise.\n\nCURRENT ELEMENT:\n${fragment}`;
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

// 新建项目的 DESIGN.md（ADR-028 v0.92）：与新配方、中性色板、sharp 圆角档同一口径；DESIGN.md 在提示词里压过美学基线，两边不能打架。
// 存量项目存着的那份不改
export function defaultDesignMd(appName: string, seedColor: string, device: DeviceType): string {
  const mobile = device === 'mobile';
  return `# ${appName} Design System

## Overview
${appName} uses a restrained, modern visual language: neutral greys carry the interface, one accent color marks the primary action and the current selection, and structure comes from alignment and spacing rather than boxes, lines or effects. Target: ${mobile ? 'mobile app screens (390×844)' : 'desktop web app (1280×800)'}.

## Colors
Seed color ${seedColor} drives the accent (\`primary\`, \`primary-container\`); the neutrals are plain greys. \`background\` is the page, \`surface\` raised panels and cards, \`surface-variant\` insets, selected rows and skeletons, \`outline-variant\` the only hairline color, \`outline\` input borders. Use \`primary\` only for the single most important action per screen, links, the active item and the main data series. \`success\` / \`warning\` / \`error\` only for real status, as a dot or text with a word.

## Typography
One sans family. ${mobile ? 'Screen titles text-2xl font-semibold tracking-tight (in the AppBar on main screens), section titles text-lg font-semibold, row titles text-base font-medium, body text-base, secondary text-sm, captions text-xs.' : 'Page titles text-xl font-semibold tracking-tight, section and panel titles text-base font-semibold, body and table cells text-sm, captions and table headers text-xs.'} Key figures text-2xl/3xl font-semibold tabular-nums. Weights: medium for labels and buttons, semibold for titles and figures. At most 5 sizes per screen; no all-caps labels.

## Layout
${mobile ? 'Single column with 16px side padding (px-4), 24px between sections. Lists sit on the page with hairlines between rows; only settings and form groups sit in one bordered surface block. Feed media runs edge to edge; an item with a photo is the photo with its text below, not a card. Sticky bottom TabBar on main screens; back-arrow AppBar on detail screens.' : 'Left Sidebar (240px) + main area with 32px padding. Each page opens with the PageHeader (title and facts left, actions right). Records in the Table recipe (at most 7 columns, on the page, not in a card) or divided lists; card grids only for visual objects (products, places, media); dashboards are the StatRow of headline figures above a 2–3 column grid of panels.'}

## Elevation
Flat. Separate by spacing first, then by tone (\`surface\` on \`background\`, \`surface-variant\` insets), and only then by a 1px \`outline-variant\` hairline. \`shadow-sm\` only on menus, sheets and dialogs.

## Shapes
${mobile ? 'rounded-lg for controls, cards, sheets and inset media (edge-to-edge feed media is square)' : 'rounded-md for controls (buttons, inputs, tags, thumbnails), rounded-lg for panels, cards, dialogs and media'}; rounded-full only for avatars, status dots, count badges, toggles and progress tracks. No pill buttons, no larger radii.

## Components
Reuse the component recipes verbatim: ${defaultComponents(device).map((c) => c.name).join(', ')}. At most one PrimaryButton per screen.

## Do's and Don'ts
Do: real, specific content; a consistent 4px rhythm; one accent; visible labels; hairlines only between rows. Don't: a box around every section, dark or thick dividers, pill buttons, large radii, tinted section backgrounds, icon tiles of any colour, letter-tile logos, chips for metadata, gradients, emoji, lorem ipsum. Reach past the tokens (hex, arbitrary values, inline styles) only when this system cannot express the design — those values stop following theme changes.
`;
}

// 新建项目的设计系统（ADR-028 v0.92）：没选设计预设时 createProject 用它。中性色板以逐键覆盖写进 palette、圆角取 sharp 档——
// 都是存量机制里能存住的输入，下次写设计系统重算 token 时照样保留；存量项目不受影响
export function newProjectDesign(appName: string, device: DeviceType, seedColor: string) {
  const palette = { light: { ...NEUTRAL_PALETTE.light }, dark: { ...NEUTRAL_PALETTE.dark } };
  return {
    tokens: tokensFromSeed(seedColor, { radiusScale: 'sharp', palette: palette.light, colorMode: 'light' }),
    palette, colorMode: 'light' as const,
    designMd: defaultDesignMd(appName, seedColor, device),
    components: defaultComponents(device),
  };
}
