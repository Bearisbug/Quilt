// 派生表按内容差量写（v1.29 §16「应用地图」）：现有行与这次算出来的按 key 逐条比，同 key 按条数配对。
// 配上的行原样留着，现有行里多出来的（含并发重派生插重了的）删掉，算出来的里多出来的插入
export function diffRows<T>(existing: (T & { id: string })[], wanted: T[], key: (row: T) => string): { drop: string[]; add: T[] } {
  const left = new Map<string, T[]>();
  for (const r of wanted) {
    const k = key(r);
    const list = left.get(k);
    if (list) list.push(r); else left.set(k, [r]);
  }
  const drop: string[] = [];
  for (const r of existing) {
    const list = left.get(key(r));
    if (list?.length) list.pop(); else drop.push(r.id);
  }
  return { drop, add: [...left.values()].flat() };
}
