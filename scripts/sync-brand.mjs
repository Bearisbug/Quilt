// 把 brand/ 里产品运行要用的几份文件复制进 apps/web/src/brand/（DESIGN §13.1「接线」）。
// brand/ 只在本机、不进仓库；产品构建只认这份副本，所以副本进仓库、不手改，改值回 brand/tokens.json 重新生成后再跑本脚本。
// 用法（仓库根目录）：node scripts/sync-brand.mjs        复制
//                    node scripts/sync-brand.mjs --check 只比对：副本与 brand/ 不一致时非零退出；本机没有 brand/ 时跳过
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'brand');
const DST = path.join(ROOT, 'apps/web/src/brand');
const FILES = ['tokens.css', 'tokens.tailwind.css', 'state-layer.css', 'fonts/fonts.css', 'fonts/SpaceGrotesk-VF.woff2'];

const check = process.argv.includes('--check');
if (!existsSync(SRC)) { console.log('本机没有 brand/，跳过（副本以仓库里的为准）'); process.exit(0); }
const drift = [];
for (const f of FILES) {
  const from = path.join(SRC, f); const to = path.join(DST, f);
  if (check) { if (!existsSync(to) || !readFileSync(from).equals(readFileSync(to))) drift.push(f); continue; }
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}
if (check && drift.length) { console.error(`apps/web/src/brand/ 与 brand/ 不一致：${drift.join('、')}；跑 node scripts/sync-brand.mjs`); process.exit(1); }
console.log(check ? `副本与 brand/ 一致（${FILES.length} 个文件）` : `已复制 ${FILES.length} 个文件到 apps/web/src/brand/`);
