// 把 harness 的 pairs-<a>-vs-<b>-<channel>.json 合成盲评工作流（judge.workflow.js）的 args，JSON 打到 stdout
// 用法：node judge-args.cjs <baseName> <candName> <candidateJsonPath>
const fs = require('fs');
const path = require('path');
const DIR = process.env.CRAFT_BENCH_OUT ?? path.resolve(__dirname, '../../../docs/test-runs/craft-bench');
const root = path.join(DIR, 'pairs') + '/';
const [base, cand, candFile] = process.argv.slice(2);
const pairs = [];
for (const ch of ['gemini', 'sonnet']) {
  const f = path.join(DIR, `pairs-${base}-vs-${cand}-${ch}.json`);
  if (!fs.existsSync(f)) continue;
  for (const p of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (p.skipped) continue;
    // 评审只看得到 dir 与题面；哪边是候选（o1L）只给工作流脚本用
    pairs.push({ id: p.id, dir: path.relative(root, p.dir), app: p.appName, brief: p.appPrompt, device: p.device, screen: p.screen.name, purpose: p.screen.purpose, o1L: p.o1.L, ch });
  }
}
process.stdout.write(JSON.stringify({ root, repo: path.resolve(__dirname, '../../..'), base, cand, candFile: path.resolve(candFile), pairs }));
