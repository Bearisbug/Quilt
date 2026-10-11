// 改屏的补丁 / 整屏重写对照（ADR-007 v1.05）：回放一批改屏指令，比较耗时、输出 token、补丁一次套上的比例，并渲染结果供逐张核对。
// 输入取自开发库（只读会话）：项目设计系统、注册表、样板屏、目标屏当前修订的 HTML，冻结成快照后回放不再碰库。
// 与 pipeline.ts 的 runEditScreens 相比少了三样：素材清单、共享组件卡、历史指令——两种做法同样少，不影响对照。
// 用法（在 tests/ 下）：
//   EDIT_BENCH_DB=postgres://…/quilt npx tsx bench/edit/replay.mts snapshot <cases.json>
//       cases.json：[{ id, project, route, instruction, revisionId? }]，按项目名与路由取屏；revisionId 指定基线修订（回放历史改屏时用它当时的那一版），
//       instruction 写 LINK_REPAIR_PROMPT 即用「接上跳转」的固定指令；打印每屏的结构摘要，便于写贴合内容的指令
//   npx tsx bench/edit/replay.mts run <patch|rewrite> [id …]   调本机 Claude 订阅；EDIT_BENCH_MODEL（缺省 claude-sonnet-5-5）、
//       EDIT_BENCH_EFFORT（low | medium | high，缺省不传 = 驱动缺省）、EDIT_BENCH_CONC（并发，缺省 3）、EDIT_BENCH_LABEL（结果目录名，缺省 = 做法名）
//   npx tsx bench/edit/replay.mts shots <label> [id …]          按基线文档的 head 渲染结果，存 <label>/<id>.jpg（基线存 base/<id>.jpg）
//   npx tsx bench/edit/replay.mts report <label> …               汇总表
// 产物在 EDIT_BENCH_OUT（缺省 docs/test-runs/edit-bench，已 gitignore）。本机 Claude 订阅的调用由驱动放进空临时目录、不落会话。
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../../..');
const core = await import(path.join(REPO, 'packages/core/src/index.ts'));
const { completeWithRetry } = await import(path.join(REPO, 'apps/api/src/lib/llm.ts'));
const OUT = process.env.EDIT_BENCH_OUT ?? path.join(REPO, 'docs/test-runs/edit-bench');
const OBJECTS = process.env.EDIT_BENCH_OBJECTS ?? path.join(REPO, '.data/objects');
const MODEL = process.env.EDIT_BENCH_MODEL ?? 'claude-sonnet-5-5';
const EFFORT = process.env.EDIT_BENCH_EFFORT as 'low' | 'medium' | 'high' | undefined;
fs.mkdirSync(path.join(OUT, 'snap'), { recursive: true });

type Case = { id: string; project: string; route: string; instruction: string; revisionId?: string };
type Snap = Case & { name: string; device: string; system: string; body: string; document: string };
type Result = { id: string; mode: string; ms: number; tokensOut: number; outChars: number; blocks: number; applied: boolean; fallback: boolean; error?: string };

const snapPath = (id: string) => path.join(OUT, 'snap', `${id}.json`);
const loadSnap = (id: string): Snap => JSON.parse(fs.readFileSync(snapPath(id), 'utf8'));
const allIds = () => fs.readdirSync(path.join(OUT, 'snap')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

async function snapshot(casesFile: string) {
  const url = process.env.EDIT_BENCH_DB;
  if (!url) throw new Error('EDIT_BENCH_DB 未设（开发库连接串，只读会话）');
  const { default: pg } = await import(path.join(REPO, 'apps/api/node_modules/pg/lib/index.js'));
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query('set session characteristics as transaction read only');
  const q = async <T,>(sql: string, args: unknown[]) => (await db.query(sql, args)).rows as T[];
  const read = (key: string) => fs.readFileSync(path.join(OBJECTS, key), 'utf8');
  const cases: Case[] = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  for (const c of cases) {
    const [p] = await q<{ id: string; name: string; device_type: string; brief: string; exemplar_screen_id: string | null }>('select id, name, device_type, brief, exemplar_screen_id from projects where name = $1 order by updated_at desc limit 1', [c.project]);
    const [ds] = await q<{ tokens: unknown; design_md: string; components: unknown[] }>('select tokens, design_md, components from design_systems where project_id = $1', [p.id]);
    const screens = await q<{ id: string; name: string; route: string; purpose: string; variant_of: string | null; html_key: string | null }>(
      'select s.id, s.name, s.route, s.purpose, s.variant_of, r.html_key from screens s left join screen_revisions r on r.id = s.current_revision_id where s.project_id = $1 order by s.created_at', [p.id]);
    const target = screens.find((s) => s.route === c.route);
    if (!target?.html_key) throw new Error(`${c.id}：${c.project} 没有路由 ${c.route} 的屏`);
    const [base] = c.revisionId ? await q<{ html_key: string }>('select html_key from screen_revisions where id = $1 and screen_id = $2', [c.revisionId, target.id]) : [{ html_key: target.html_key }];
    if (!base) throw new Error(`${c.id}：修订 ${c.revisionId} 不属于这一屏`);
    const document = read(base.html_key);
    const body = core.extractBody(document);
    // 样板屏：钦定的那张，没有就取第一张有修订的默认屏（同 services/screens.ts exemplarBody）
    const ex = screens.find((s) => s.id === p.exemplar_screen_id && s.html_key) ?? screens.find((s) => !s.variant_of && s.html_key);
    const refs = ex ? [{ label: 'exemplar screen (the project\'s style anchor)', body: core.extractBody(read(ex.html_key!)) }] : [];
    const registry = screens.filter((s) => !s.variant_of).map((s) => ({ route: s.route, name: s.name, purpose: s.purpose || undefined }));
    const system = core.screenSystemPrompt({ name: p.name, description: 'existing app being revised', brief: p.brief }, p.device_type, ds.tokens, ds.design_md, ds.components, registry, refs);
    const instruction = c.instruction === 'LINK_REPAIR_PROMPT' ? core.LINK_REPAIR_PROMPT : c.instruction;
    const snap: Snap = { ...c, instruction, name: target.name, device: p.device_type, system, body, document };
    fs.writeFileSync(snapPath(c.id), JSON.stringify(snap));
    console.log(`${c.id} ${c.project} ${c.route}：body ${body.length} 字符，系统提示 ${system.length} 字符，样板屏${ex?.id === target.id ? '就是目标屏' : ex ? ` ${ex.route}` : '无'}`);
    if (process.env.EDIT_BENCH_OUTLINE) console.log(core.outlineBody(body, 25).split('\n').map((l: string) => `    ${l.slice(0, 110)}`).join('\n'));
  }
  await db.end();
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

async function run(mode: string, ids: string[]) {
  if (mode !== 'patch' && mode !== 'rewrite') throw new Error('mode = patch | rewrite');
  const label = process.env.EDIT_BENCH_LABEL ?? mode;
  const dir = path.join(OUT, label);
  fs.mkdirSync(dir, { recursive: true });
  const call = (s: Snap, prompt: string) => completeWithRetry({ system: s.system, prompt, model: MODEL, effort: EFFORT, spec: { driver: 'agent-sdk' } });
  await pool(ids, Number(process.env.EDIT_BENCH_CONC ?? 3), async (id) => {
    const s = loadSnap(id);
    const t0 = Date.now();
    const r: Result = { id, mode: label, ms: 0, tokensOut: 0, outChars: 0, blocks: 0, applied: false, fallback: false };
    let body = '';
    try {
      if (mode === 'rewrite') {
        const out = await call(s, core.editUserPrompt(s.name, s.route, s.body, s.instruction));
        r.tokensOut = out.tokensOut; r.outChars = out.text.length; body = core.stripFences(out.text);
      } else {
        const out = await call(s, core.editPatchUserPrompt(s.name, s.route, s.body, s.instruction));
        r.tokensOut = out.tokensOut; r.outChars = out.text.length;
        fs.writeFileSync(path.join(dir, `${id}.raw.txt`), out.text);
        const edits = core.parseEditBlocks(out.text);
        if (!edits) body = core.stripFences(out.text);
        else {
          r.blocks = edits.length;
          const applied = core.applyEdits(s.body, edits);
          if (!applied.errors.length) { body = applied.body; r.applied = true; }
          else {
            r.error = applied.errors.map((e: { index: number; matches: number }) => `#${e.index}:${e.matches}`).join(' ');
            r.fallback = true;
            const again = await call(s, core.editUserPrompt(s.name, s.route, s.body, s.instruction));
            r.tokensOut += again.tokensOut; r.outChars += again.text.length; body = core.stripFences(again.text);
          }
        }
      }
    } catch (e) { r.error = (e as Error).message.slice(0, 200); }
    r.ms = Date.now() - t0;
    if (body) fs.writeFileSync(path.join(dir, `${id}.html`), core.reconcileQids(body));
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(r));
    console.log(`${id} ${label}：${Math.round(r.ms / 1000)} s，输出 ${r.tokensOut} token / ${r.outChars} 字符${r.blocks ? `，${r.blocks} 块${r.applied ? '一次套上' : ''}` : mode === 'patch' ? '，回了整屏' : ''}${r.fallback ? '，退回整屏重写' : ''}${r.error ? `（${r.error}）` : ''}`);
  });
}

async function shots(label: string, ids: string[]) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const id of ids) {
      const s = loadSnap(id);
      const size = core.DEVICE_SIZE[s.device];
      const page = await browser.newPage({ viewport: { width: size.w, height: size.h } });
      const render = async (body: string, file: string) => {
        const doc = s.document.replace(/<body([^>]*)>[\s\S]*<\/body>/, (_m, attrs) => `<body${attrs}>\n${body}\n</body>`);
        await page.setContent(doc, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(800);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage: true });
      };
      if (!fs.existsSync(path.join(OUT, 'base', `${id}.jpg`))) await render(s.body, path.join(OUT, 'base', `${id}.jpg`));
      const html = path.join(OUT, label, `${id}.html`);
      if (fs.existsSync(html)) await render(fs.readFileSync(html, 'utf8'), path.join(OUT, label, `${id}.jpg`));
      await page.close();
    }
  } finally { await browser.close(); }
}

function report(labels: string[]) {
  const rows: string[] = ['| 用例 | ' + labels.map((l) => `${l} 耗时 / 输出 token / 结果`).join(' | ') + ' |', '| --- | ' + labels.map(() => '---').join(' | ') + ' |'];
  for (const id of allIds()) {
    const cells = labels.map((l) => {
      const f = path.join(OUT, l, `${id}.json`);
      if (!fs.existsSync(f)) return '—';
      const r: Result = JSON.parse(fs.readFileSync(f, 'utf8'));
      const how = r.error && !r.fallback ? `失败：${r.error}` : r.fallback ? `补丁对不上（${r.error}），退回整屏` : r.blocks ? `${r.blocks} 块一次套上` : r.mode.startsWith('patch') ? '回了整屏' : '整屏';
      return `${Math.round(r.ms / 1000)} s / ${r.tokensOut} / ${how}`;
    });
    rows.push(`| ${id} | ${cells.join(' | ')} |`);
  }
  console.log(rows.join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'snapshot') await snapshot(rest[0]);
else if (cmd === 'run') await run(rest[0], rest.length > 1 ? rest.slice(1) : allIds());
else if (cmd === 'shots') await shots(rest[0], rest.length > 1 ? rest.slice(1) : allIds());
else if (cmd === 'report') report(rest);
else console.log('用法见文件头注释');
