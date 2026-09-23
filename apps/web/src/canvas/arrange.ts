// 多选排列的算位（REQ-CORE-018）。这个文件不依赖 React 与图标，单测直接跑（tests/unit/web/arrange.test.ts）；按钮表在 ArrangeBar.tsx
export type ArrangeKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hspace' | 'vspace' | 'hrow' | 'vcol';
export type ArrangeLabel = '对齐' | '等距' | '排列';
// 排成一行 / 一列的固定间距：与造屏落位（worker 的 layoutNewScreens）同一个数，一键摆出来的和生成出来的一样宽松
export const LAYOUT_GAP = 80;
type Box = { id: string; x: number; y: number; width: number; height: number };

// 多选排列（REQ-CORE-018）：对齐按选中集合的外接框算，等距保住首尾、中间按间隙均分；排成一行 / 一列按固定间距。
// 纯函数，只算每张屏该去哪（位置没变的也在 next 里）；落库、撤销栈与失败口径在 positions.ts 的 usePositionUndo
export function computeArrangement(kind: ArrangeKind, sel: Box[]): { next: Map<string, { x: number; y: number }>; label: ArrangeLabel } | null {
  if (sel.length < 2 || (kind.endsWith('space') && sel.length < 3)) return null;
  const minX = Math.min(...sel.map((s) => s.x)); const maxR = Math.max(...sel.map((s) => s.x + s.width));
  const minY = Math.min(...sel.map((s) => s.y)); const maxB = Math.max(...sel.map((s) => s.y + s.height));
  const next = new Map<string, { x: number; y: number }>();
  const layout = kind === 'hrow' || kind === 'vcol';
  if (layout) {
    // 排成一行 / 一列（v0.52）：顺序取当前位置（行按 x、列按 y，相同再按另一轴），起点取外接框左上角，间距固定
    const h = kind === 'hrow';
    const sorted = [...sel].sort((a, b) => (h ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    let cursor = h ? minX : minY;
    for (const s of sorted) { next.set(s.id, h ? { x: cursor, y: minY } : { x: minX, y: cursor }); cursor += (h ? s.width : s.height) + LAYOUT_GAP; }
  } else if (kind === 'hspace' || kind === 'vspace') {
    const h = kind === 'hspace';
    const sorted = [...sel].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
    const span = h ? maxR - minX : maxB - minY;
    const gap = (span - sorted.reduce((m, s) => m + (h ? s.width : s.height), 0)) / (sorted.length - 1);
    let cursor = h ? minX : minY;
    for (const s of sorted) { next.set(s.id, h ? { x: Math.round(cursor), y: s.y } : { x: s.x, y: Math.round(cursor) }); cursor += (h ? s.width : s.height) + gap; }
  } else {
    for (const s of sel) {
      const x = kind === 'left' ? minX : kind === 'right' ? maxR - s.width : kind === 'hcenter' ? Math.round((minX + maxR) / 2 - s.width / 2) : s.x;
      const y = kind === 'top' ? minY : kind === 'bottom' ? maxB - s.height : kind === 'vcenter' ? Math.round((minY + maxB) / 2 - s.height / 2) : s.y;
      next.set(s.id, { x, y });
    }
  }
  return { next, label: layout ? '排列' : kind.endsWith('space') ? '等距' : '对齐' };
}
