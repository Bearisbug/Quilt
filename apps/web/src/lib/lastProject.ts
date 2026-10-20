// 上次打开的项目（REQ-CORE-041）：画布每载入一个普通项目就记下它，草稿本「写回项目…」的目标项目在没有写回目标与参照项目时缺省选它。
// 只是本机的视图偏好（INT-007）；记的项目后来被删了，读的一方按「不在列表里」回落
const KEY = 'quilt:last-project';
export const rememberLastProject = (id: string) => { try { localStorage.setItem(KEY, id); } catch { /* 无痕模式写不了 */ } };
export const lastProjectId = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
