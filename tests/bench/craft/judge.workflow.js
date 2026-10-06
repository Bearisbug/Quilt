export const meta = {
  name: 'quilt-aesthetic-blind-judge',
  description: 'Blind pairwise judging of baseline vs candidate Quilt screens (3 judges per pair, alternating left/right order), aggregate against pre-registered criteria, analyse defects and propose a revision',
  phases: [
    { title: 'Judge', detail: '3 lenses per pair, blind' },
    { title: 'Analyze', detail: 'aggregate + defect analysis + revision proposal' },
  ],
}

// 做工规则盲评（TEST.md TC-CORE-084）：用 Claude Code 的 Workflow 工具运行本脚本，args 由 judge-args.cjs 生成。
// 每对 3 位评审（结构 / 视觉 / 整体），左右顺序按对与评审轮换；按事先登记的标准判通过；args.judgeOnly 时只评不析。

const ROOT = args.root
const BASE = args.base
const CAND = args.cand
const PAIRS = args.pairs

const DIM = { type: 'number', description: '1-10' }
const DIMS = {
  type: 'object',
  properties: { hierarchy: DIM, typography: DIM, spacing: DIM, layout: DIM, color: DIM, components: DIM, content: DIM, aiLook: DIM, overall: DIM },
  required: ['hierarchy', 'typography', 'spacing', 'layout', 'color', 'components', 'content', 'aiLook', 'overall'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    L: DIMS,
    R: DIMS,
    preferred: { type: 'string', enum: ['L', 'R', 'tie'] },
    margin: { type: 'string', enum: ['slight', 'clear', 'strong'] },
    defectsL: { type: 'array', items: { type: 'string' } },
    defectsR: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['L', 'R', 'preferred', 'margin', 'defectsL', 'defectsR', 'reason'],
}

const LENSES = [
  { key: 'structure', text: 'Your lens: information architecture and layout — hierarchy, grouping, alignment, spacing rhythm, and density appropriate to the screen\'s job (data-dense admin consoles should be dense but organised; consumer screens calmer). Is the most important thing obvious in the first viewport?' },
  { key: 'visual', text: 'Your lens: visual design — type scale and weights, colour restraint within the theme, surfaces/borders/shadows, component polish and consistency, icons and imagery, and anything that looks generic or "AI-made" (card soup, gratuitous pills and icon tiles, decorative gradients, everything boxed, fake-looking data).' },
  { key: 'holistic', text: 'Your lens: overall product quality, as a design director reviewing for launch — which one would you ship, which feels more premium, intentional and trustworthy, which would a real user find clearer to use?' },
]

const judgePrompt = (p, order, lens) => `You are judging the VISUAL CRAFT of two independent renderings, L and R, of the same app screen. Both were generated from the same plan by an AI design tool; they differ only in how they were generated.

App: ${p.app} — ${p.brief}
Device: ${p.device === 'mobile' ? 'mobile, 390x844 viewport' : 'desktop web app, 1280x800 viewport'}
Screen: ${p.screen} — ${p.purpose}

Read exactly these four images with the Read tool, and do not open, list or read any other file or directory:
- ${ROOT}${p.dir}/${order}/L-top.jpg  (L, first viewport — this is what the canvas card shows)
- ${ROOT}${p.dir}/${order}/L-scroll.jpg  (L, the main scroll area scrolled down about one viewport; identical to top if nothing scrolls)
- ${ROOT}${p.dir}/${order}/R-top.jpg
- ${ROOT}${p.dir}/${order}/R-scroll.jpg

Rules for judging:
- Judge craft and quality, not which content you happen to prefer. The two may show different sample data and different section choices.
- Placeholder photos come from a random-photo service in BOTH versions, so their subject never matches the content; do not reward or punish the subject itself. Do judge how photos are used: a photo used as a person's avatar or a logo, a large unrelated photo carrying meaning it cannot carry, text placed over photos, or photos where initials/icons would fit.
- Ignore the language of the copy (some screens are Chinese, some English) unless it is mixed carelessly within one screen.
- ${lens.text}

Score each side 1-10 on every dimension (hierarchy, typography, spacing = rhythm and whitespace, layout = alignment and structure, color = colour restraint and surfaces/elevation, components = polish and consistency, content = realism and specificity of data and copy, aiLook = how far it is from a generic AI-made template: 10 = could pass as a hand-crafted product by a top design team, 1 = obvious template tells such as a box or border around everything, heavy or numerous divider lines, pill-shaped buttons and chips, large rounded corners, coloured icon tiles and decorative colour; overall = how premium and professional; would a senior designer ship it). Then give preferred (L, R or tie — tie only if genuinely indistinguishable in quality), margin, up to 5 concrete observable defects for each side (e.g. "every section wrapped in a bordered card", "section titles same size as body", "stat numbers not aligned", "decorative icon tile on every card"), and a two-sentence reason.`

phase('Judge')
const judged = await pipeline(PAIRS, (p, _orig, i) => parallel(LENSES.map((lens, k) => () => {
  const order = (i + k) % 2 === 0 ? 'o1' : 'o2'
  return agent(judgePrompt(p, order, lens), { label: `judge:${p.id}:${lens.key}`, phase: 'Judge', schema: JUDGE_SCHEMA })
    .then((v) => (v ? { ...v, order, lens: lens.key } : null))
})).then((votes) => ({ pair: p, votes: votes.filter(Boolean) })))

// 把 L/R 还原成变体：o1 的 L 是 o1L，o2 反过来
const sideOf = (p, order, variant) => {
  const o1Cand = p.o1L === variant ? 'L' : 'R'
  return order === 'o1' ? o1Cand : (o1Cand === 'L' ? 'R' : 'L')
}
const DIMKEYS = ['hierarchy', 'typography', 'spacing', 'layout', 'color', 'components', 'content', 'aiLook', 'overall']
const rows = judged.filter(Boolean).map(({ pair: p, votes }) => {
  let cand = 0, base = 0, tie = 0
  const delta = Object.fromEntries(DIMKEYS.map((d) => [d, 0]))
  const candDefects = [], baseDefects = [], reasons = []
  for (const v of votes) {
    const cs = sideOf(p, v.order, CAND), bs = cs === 'L' ? 'R' : 'L'
    if (v.preferred === 'tie') tie++; else if (v.preferred === cs) cand++; else base++
    for (const d of DIMKEYS) delta[d] += (v[cs][d] - v[bs][d]) / votes.length
    candDefects.push(...(cs === 'L' ? v.defectsL : v.defectsR))
    baseDefects.push(...(bs === 'L' ? v.defectsL : v.defectsR))
    reasons.push(`[${v.lens}] prefers ${v.preferred === 'tie' ? 'tie' : v.preferred === cs ? 'CAND' : 'BASE'} (${v.margin}): ${v.reason}`)
  }
  const outcome = cand > base ? 'cand' : base > cand ? 'base' : 'tie'
  return { id: p.id, ch: p.ch, app: p.app, device: p.device, screen: p.screen, votes: votes.length, cand, base, tie, outcome, delta, candDefects, baseDefects, reasons }
})

const summarize = (rs) => {
  const won = rs.filter((r) => r.outcome === 'cand').length, lost = rs.filter((r) => r.outcome === 'base').length, tied = rs.filter((r) => r.outcome === 'tie').length
  const meanDelta = Object.fromEntries(DIMKEYS.map((d) => [d, rs.length ? +(rs.reduce((n, r) => n + r.delta[d], 0) / rs.length).toFixed(2) : 0]))
  const votes = rs.reduce((a, r) => ({ cand: a.cand + r.cand, base: a.base + r.base, tie: a.tie + r.tie }), { cand: 0, base: 0, tie: 0 })
  return { pairs: rs.length, won, lost, tied, winRate: won + lost ? +(won / (won + lost)).toFixed(3) : null, votes, meanDelta }
}
const all = summarize(rows)
const byCh = { gemini: summarize(rows.filter((r) => r.ch === 'gemini')), sonnet: summarize(rows.filter((r) => r.ch === 'sonnet')) }
const byDevice = { mobile: summarize(rows.filter((r) => r.device === 'mobile')), desktop: summarize(rows.filter((r) => r.device === 'desktop')) }
// 事先登记的通过标准：总胜率 ≥ 0.70；各通道胜率 ≥ 0.60；各通道 overall 均差 > 0。两版候选直接对比时另行登记，经 args.minWin / args.minChannelWin 传入
const MIN_WIN = args.minWin ?? 0.7
const MIN_CHANNEL_WIN = args.minChannelWin ?? 0.6
const pass = (all.winRate ?? 0) >= MIN_WIN && ['gemini', 'sonnet'].every((c) => (byCh[c].winRate ?? 0) >= MIN_CHANNEL_WIN && byCh[c].meanDelta.overall > 0)
log(`overall win rate ${all.winRate} (${all.won}W/${all.lost}L/${all.tied}T), gemini ${byCh.gemini.winRate}, sonnet ${byCh.sonnet.winRate}; pre-registered pass = ${pass}`)
if (rows.some((r) => r.votes < 3)) log(`WARNING: ${rows.filter((r) => r.votes < 3).length} pair(s) have fewer than 3 votes`)

// 只评不析：重评一部分对时用，汇总与分析在合并全部对之后另做
if (args.judgeOnly) return { all, byCh, byDevice, pass, rows }

phase('Analyze')
// args.context：被比的两版是什么、各自的提示词在哪（缺省是 v0.91 那一轮的说法：候选是 JSON 块）
const CONTEXT = args.context ?? `a "CRAFT DEFAULTS" section added to Quilt's screen-generation system prompt (an AI design tool that generates one HTML screen per call with Tailwind + design-token classes). BASE = current prompt, CAND = prompt with the craft section. Read the candidate prompt text at ${args.candFile} (fields: block, mobile, desktop, edits, designMdEdits) and the current prompt at ${args.repo}/packages/core/src/contract.ts (screenSystemPrompt, defaultDesignMd, craftRules).`
const analysis = await agent(`You analyse a blind A/B evaluation of ${CONTEXT} You may look at screenshots under ${ROOT} (each pair dir has o1/L-*.jpg = the variant named in that pair's o1L) to verify claims.

AGGREGATE (pairs judged by 3 blind judges each; outcome = majority preference; delta = CAND minus BASE score, 1-10 scale, averaged over judges):
${JSON.stringify({ all, byCh, byDevice, preRegisteredPass: pass })}

PER PAIR (votes, outcome, deltas, judge reasons, defects judges listed for CAND and for BASE):
${JSON.stringify(rows.map((r) => ({ id: r.id, ch: r.ch, app: r.app, device: r.device, screen: r.screen, cand: r.cand, base: r.base, tie: r.tie, outcome: r.outcome, delta: r.delta, reasons: r.reasons, candDefects: r.candDefects, baseDefects: r.baseDefects })))}

Tasks:
1. Summarise where CAND wins and where it loses (by channel, device, screen type), with evidence from the judges.
2. Cluster the defects judges still list for CAND into recurring problems (count how many pairs mention each), and separately list problems CAND introduced that BASE did not have (regressions).
3. Recommend: "ship" if the pre-registered criteria passed and there is no serious regression, otherwise "revise".
4. Propose a revised candidate that fixes the recurring CAND defects and regressions without losing what wins. Keep the same JSON shape as the candidate file (block, mobile, desktop, edits with find/replace verbatim in contract.ts, designMdEdits with optional device), stay style-neutral, keep block + longer device line <= ${args.budget ?? 4800} characters, and list every change with its evidence. If the recommendation is "ship", the revised candidate may equal the current one or carry only low-risk tweaks; say which.`, {
  label: 'analyze', phase: 'Analyze',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      recurring: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, pairs: { type: 'number' }, examples: { type: 'string' } }, required: ['problem', 'pairs', 'examples'] } },
      regressions: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string', enum: ['ship', 'revise'] },
      revised: {
        type: 'object',
        properties: {
          block: { type: 'string' }, mobile: { type: 'string' }, desktop: { type: 'string' },
          edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } },
          designMdEdits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, device: { type: 'string' } }, required: ['find', 'replace'] } },
        },
        required: ['block', 'mobile', 'desktop', 'edits', 'designMdEdits'],
      },
      changes: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'recurring', 'regressions', 'recommendation', 'revised', 'changes'],
  },
})

return { all, byCh, byDevice, pass, rows: rows.map((r) => ({ id: r.id, ch: r.ch, app: r.app, device: r.device, screen: r.screen, cand: r.cand, base: r.base, tie: r.tie, outcome: r.outcome, overallDelta: +r.delta.overall.toFixed(2) })), analysis }
