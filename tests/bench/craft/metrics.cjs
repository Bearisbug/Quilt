// 汇总各变体 × 通道的客观指标：成功 / 首次失败、耗时、输出长度、输出 token、lint 偏离（按规则）
// 用法：node metrics.cjs <variant> [<variant> …]
const fs = require('fs');
const path = require('path');
const DIR = process.env.CRAFT_BENCH_OUT ?? path.resolve(__dirname, '../../../docs/test-runs/craft-bench');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
for (const v of process.argv.slice(2)) {
  for (const ch of ['gemini', 'sonnet']) {
    const f = path.join(DIR, 'out', v, ch, 'manifest.json');
    if (!fs.existsSync(f)) continue;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ok = m.filter((x) => x.ok);
    const failLog = path.join(DIR, 'out', v, ch, 'failures.log');
    const firstFails = fs.existsSync(failLog) ? fs.readFileSync(failLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const rules = {};
    for (const x of ok) for (const [r, n] of Object.entries(x.byRule || {})) rules[r] = (rules[r] || 0) + n;
    console.log(`${v}/${ch}: ok ${ok.length}/${m.length} · failed attempts ${firstFails.length}${firstFails.length ? ` (${firstFails.map((l) => l.slice(0, 70)).join('; ')})` : ''}`);
    console.log(`  mean ${Math.round(mean(ok.map((x) => x.ms)) / 1000)} s · ${Math.round(mean(ok.map((x) => x.chars)))} chars · out ${Math.round(mean(ok.map((x) => x.tokensOut)))} tok · in ${Math.round(mean(ok.map((x) => x.tokensIn)))} tok · system ${Math.round(mean(m.map((x) => x.systemChars)))} chars`);
    const au = ok.filter((x) => x.audit).map((x) => x.audit);
    if (au.length) console.log(`  AI-look audit (per screen, n=${au.length}): lines ${mean(au.map((a) => a.lines)).toFixed(1)} · heavy lines ${mean(au.map((a) => a.heavyLines)).toFixed(1)} · pills ${mean(au.map((a) => a.pills)).toFixed(1)} · radius ≥12px ${mean(au.map((a) => a.bigRadius)).toFixed(1)} · shadows ${mean(au.map((a) => a.shadows)).toFixed(1)} · gradients ${mean(au.map((a) => a.gradients)).toFixed(1)} · wrapped short text ${mean(au.map((a) => a.wrapped ?? NaN)).toFixed(1)}`);
    console.log(`  deviations/screen ${mean(ok.map((x) => x.violations)).toFixed(1)} · by rule ${JSON.stringify(rules)} · page errors ${ok.reduce((n, x) => n + (x.errors || []).length, 0)}`);
  }
}
