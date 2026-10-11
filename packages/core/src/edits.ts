// 按锚点改屏（v0.64 quilt.patch_screen；v1.05 改屏作业同用，ADR-007）：每条 edit 在当前 body 上依次把字面文本 find 换成 replace，
// find 必须恰好出现一次（all=true 时全部替换）。任一条找不到或有歧义就整批作废——调用方拿到 errors 后不落半截
export type TextEdit = { find: string; replace: string; all?: boolean };
export type EditError = { index: number; matches: number };

export function applyEdits(body: string, edits: TextEdit[]): { body: string; errors: EditError[] } {
  const errors: EditError[] = [];
  let out = body;
  edits.forEach((e, index) => {
    const matches = e.find ? out.split(e.find).length - 1 : 0;
    if (matches === 0 || (matches > 1 && !e.all)) { errors.push({ index, matches }); return; }
    out = e.all ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace);
  });
  return { body: out, errors };
}

// 改屏作业的模型产出（ADR-007 v1.05）：一个或多个补丁块
//   <<<<<<< FIND
//   …CURRENT HTML 里的原文…
//   =======
//   …换成什么（可为空 = 删掉）…
//   >>>>>>> REPLACE
// 产出里一个补丁块都没有时返回 null，调用方按整屏处理
export const EDIT_BLOCK = { find: '<<<<<<< FIND', sep: '=======', replace: '>>>>>>> REPLACE' } as const;
const BLOCK_RE = /<<<<<<< FIND\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;
export function parseEditBlocks(text: string): TextEdit[] | null {
  const edits = [...text.matchAll(BLOCK_RE)].map((m) => ({ find: m[1], replace: m[2] }));
  return edits.length ? edits : null;
}
