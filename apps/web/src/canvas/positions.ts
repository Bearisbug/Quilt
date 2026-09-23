import { useRef, type Dispatch, type SetStateAction } from 'react';
import type { ProjectDetailDto, ComponentDto, ScreenDto } from '@quilt/core';
import { api } from '@/lib/api';
import type { useToast } from '@/lib/toast';
import { computeArrangement, type ArrangeKind } from './arrange';

// 画布上一张卡（屏或组件）的位置，位置写回与撤销栈都用它
export type PosEntry = { id: string; x: number; y: number };

// 刚写出去、服务端还没回声的坐标（拖动与排列，REQ-CORE-018）：项目级事件流每来一条事件就刷新，
// 那次 GET 可能早于排列发出、晚于它落地才回来，这份旧快照整份写进 detail 就把排好的位置顶回去，
// 而此后没有任何路径再纠正它（PATCH 已经 200）。所以坐标在服务端跟上之前归本地，跟上即出栈。
export function usePositionDrafts() {
  const dirtyPos = useRef(new Map<string, { x: number; y: number }>());
  // 组件卡的坐标同一套竞态、同一套处理（REQ-EDIT-006）
  const dirtyCompPos = useRef(new Map<string, { x: number; y: number }>());
  // 每次 GET 回来先对账：服务端跟上的出栈，没跟上的用本地坐标盖回快照
  const reconcile = (d: ProjectDetailDto): ProjectDetailDto => {
    for (const [id, p] of dirtyPos.current) { const s = d.screens.find((x) => x.id === id); if (!s || (s.x === p.x && s.y === p.y)) dirtyPos.current.delete(id); }
    for (const [id, p] of dirtyCompPos.current) { const c = d.components.find((x) => x.id === id); if (!c || (c.x === p.x && c.y === p.y)) dirtyCompPos.current.delete(id); }
    return {
      ...d,
      screens: dirtyPos.current.size ? d.screens.map((s) => ({ ...s, ...dirtyPos.current.get(s.id) })) : d.screens,
      components: dirtyCompPos.current.size ? d.components.map((c) => ({ ...c, ...dirtyCompPos.current.get(c.id) })) : d.components,
    };
  };
  return { dirtyPos, dirtyCompPos, reconcile };
}
export type PositionDrafts = ReturnType<typeof usePositionDrafts>;

export function usePositionUndo(args: {
  drafts: PositionDrafts; screensRef: { current: ScreenDto[] }; components: ComponentDto[];
  setDetail: Dispatch<SetStateAction<ProjectDetailDto | null>>; refresh: () => unknown; toast: ReturnType<typeof useToast>;
}) {
  const { drafts: { dirtyPos, dirtyCompPos }, screensRef, components, setDetail, refresh, toast } = args;
  // 位置撤销栈（v0.41）：拖动与对齐都是一步把屏挪走的动作，错了没有退路——每次动之前把「这几张原来在哪」压栈，⌘Z 逐步还原。
  // 只管位置：屏内容的历史在修订树里，删屏有确认框，都不进这个栈。一步同时记屏与组件（v0.47 整组一起拖、整组一起还原）
  const posUndo = useRef<{ label: string; screens: PosEntry[]; components: PosEntry[] }[]>([]);
  const pushUndo = (label: string, screenIds: string[], componentIds: string[] = []) => {
    const pick = (list: PosEntry[], ids: string[]) => list.filter((x) => ids.includes(x.id)).map(({ id, x, y }) => ({ id, x, y }));
    const entry = { label, screens: pick(screensRef.current, screenIds), components: pick(components, componentIds) };
    if (entry.screens.length || entry.components.length) posUndo.current = [...posUndo.current.slice(-19), entry];
  };
  // 位置写回（INT-019 文档级几何）：本地先行 + 在途坐标，屏与组件各走自己的 PATCH；等全部有结果再决定，
  // 失败的坐标交还服务端、成功的不回滚（口径同排列）。返回没写上的那几张的名字
  const writePositions = async (moved: PosEntry[], movedComps: PosEntry[]) => {
    for (const e of moved) dirtyPos.current.set(e.id, { x: e.x, y: e.y });
    for (const e of movedComps) dirtyCompPos.current.set(e.id, { x: e.x, y: e.y });
    const apply = <T extends PosEntry>(list: T[], entries: PosEntry[]) => (entries.length ? list.map((x) => { const e = entries.find((q) => q.id === x.id); return e ? { ...x, x: e.x, y: e.y } : x; }) : list);
    setDetail((d) => d && { ...d, screens: apply(d.screens, moved), components: apply(d.components, movedComps) });
    const done = await Promise.allSettled([...moved.map((e) => api.screens.patch(e.id, { x: e.x, y: e.y })), ...movedComps.map((e) => api.components.patch(e.id, { x: e.x, y: e.y }))]);
    const failed: string[] = [];
    moved.forEach((e, i) => { if (done[i].status === 'rejected') { dirtyPos.current.delete(e.id); failed.push(screensRef.current.find((s) => s.id === e.id)?.name ?? e.id); } });
    movedComps.forEach((e, i) => { if (done[moved.length + i].status === 'rejected') { dirtyCompPos.current.delete(e.id); failed.push(components.find((c) => c.id === e.id)?.name ?? e.id); } });
    return failed;
  };
  const undoPos = async () => {
    const last = posUndo.current.pop();
    if (!last) { toast('没有可撤销的移动'); return; }
    const failed = await writePositions(last.screens, last.components);
    if (failed.length) { toast('撤销没能全部写回，已重取', 'error'); refresh(); return; }
    toast(`已撤销${last.label}`);
  };
  // 松手落库：单张与整组同一条路（v0.47 多选批量移动）
  const onMove = async (moved: PosEntry[], movedComps: PosEntry[]) => {
    pushUndo('移动', moved.map((e) => e.id), movedComps.map((e) => e.id));
    const failed = await writePositions(moved, movedComps);
    if (!failed.length) return;
    toast(moved.length + movedComps.length > 1 ? `位置保存失败：${failed.join('、')} 没挪过去，再拖一次` : '位置保存失败', 'error');
    refresh();
  };
  // 多选排列（REQ-CORE-018）：算位在 computeArrangement；只动位置变了的屏，落库走同一条 PATCH
  const arrange = async (kind: ArrangeKind, sel: ScreenDto[]) => {
    const r = computeArrangement(kind, sel);
    if (!r) return;
    const { next, label } = r;
    const moved = sel.filter((s) => { const n = next.get(s.id)!; return n.x !== s.x || n.y !== s.y; });
    if (!moved.length) return;
    pushUndo(label, moved.map((s) => s.id));
    for (const s of moved) dirtyPos.current.set(s.id, next.get(s.id)!);
    setDetail((d) => d && { ...d, screens: d.screens.map((s) => (next.has(s.id) ? { ...s, ...next.get(s.id)! } : s)) });
    // 等每条 PATCH 都有结果再重取：先回来的旧快照会盖掉后落地的那几条写入。
    // 失败的屏把坐标交还服务端（口径是重取、不回滚已落库的那几屏），成功的仍归本地直到刷新里对上
    const done = await Promise.allSettled(moved.map((s) => api.screens.patch(s.id, next.get(s.id)!)));
    const failed = moved.filter((_, i) => done[i].status === 'rejected');
    if (!failed.length) return;
    for (const s of failed) dirtyPos.current.delete(s.id);
    toast(`位置保存失败：${failed.map((s) => s.name).join('、')} 没排上，再点一次对齐`, 'error');
    refresh();
  };
  return { pushUndo, writePositions, undoPos, onMove, arrange };
}
