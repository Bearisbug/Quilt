import { parseHTML } from 'linkedom';
import { stripFences } from './inject.ts';
import type { QuiltBlock } from './contract.ts';

// 一次改几块（REQ-EDIT-002 v1.26，API-CORE-006 regenerate_subtree.qids）的服务端一侧：收模型回包里的 <quilt-block>（块的写法见 contract.ts quiltBlock），
// 建作业时查选中的几块。用到 linkedom，只从主入口 @quilt/core 出，不进 @quilt/core/browser

// qid 的值先宽松地取（模型可能写成 "3" 或带单引号），对不对由 parseQuiltBlocks 判；块里的代码围栏去掉
const BLOCK_RE = /<quilt-block\s+qid\s*=\s*["']?([^"'\s>]*)["']?\s*>([\s\S]*?)<\/quilt-block>/gi;
export function quiltBlocks(text: string): QuiltBlock[] {
  return [...text.matchAll(BLOCK_RE)].map((m) => ({ qid: m[1], html: stripFences(m[2]) }));
}

/**
 * 模型回包按选中的几块收：每个 qid 恰好一段、不多不少、不为空，块外的文字与包在外面的代码围栏不管；
 * 对上了按 qids 的顺序返回，对不上返回一句英文原因（补问那一轮的提示词里原样告诉模型哪里不对）。
 */
export function parseQuiltBlocks(text: string, qids: readonly string[]): { blocks: QuiltBlock[] } | { error: string } {
  const got = quiltBlocks(text);
  const problems: string[] = [];
  const seen = new Map<string, QuiltBlock>();
  for (const b of got) {
    if (!qids.includes(b.qid)) problems.push(`block qid="${b.qid}" is not one of the selected elements`);
    else if (seen.has(b.qid)) problems.push(`${b.qid} appears more than once`);
    else seen.set(b.qid, b);
  }
  const missing = qids.filter((q) => !seen.has(q));
  if (missing.length) problems.push(`no block for ${missing.join(', ')}`);
  const empty = [...seen.values()].filter((b) => !b.html).map((b) => b.qid);
  if (empty.length) problems.push(`empty block for ${empty.join(', ')}`);
  if (problems.length) return { error: `expected ${qids.length} blocks (${qids.join(', ')}), got ${got.length}: ${problems.join('; ')}` };
  return { blocks: qids.map((q) => seen.get(q)!) };
}

/** 建作业时查选中的几块（API-CORE-006）：哪些不在这一版里、哪两块是一块包着另一块（[外, 里]） */
export function subtreeBlockIssues(bodyHtml: string, qids: readonly string[]): { missing: string[]; nested: [string, string][] } {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const els = qids.map((q) => [q, document.querySelector(`[data-qid="${q}"]`)] as const);
  const missing = els.filter(([, el]) => !el).map(([q]) => q);
  const nested: [string, string][] = [];
  for (const [a, ea] of els) for (const [b, eb] of els) if (ea && eb && a !== b && ea.contains(eb)) nested.push([a, b]);
  return { missing, nested };
}
