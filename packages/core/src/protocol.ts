// 预览 iframe ↔ 画布父页的 postMessage 协议（§8 API-CORE-016 运行时；§24 共享类型）。
export type PreviewToParent =
  | { type: 'quilt:ready'; title: string }
  | { type: 'quilt:navigate'; href: string }
  | { type: 'quilt:swapped'; route: string; title: string }
    // 焦点在预览文档里时画布快捷键收不到，由运行时转发：Esc / Alt+← / ⌘E / ⌘/（code 用物理键，与父页的键位表一致）
  | { type: 'quilt:key'; key: string; code?: string; altKey: boolean; metaKey?: boolean; ctrlKey?: boolean }
  | { type: 'quilt:dead' }
  | { type: 'quilt:wheel'; deltaY: number; x: number; y: number }
    // rect 为屏文档坐标（含滚动偏移），与 fullPage:false 的截图同一坐标系，供画布层画批注气泡（REQ-EDIT-004 / ADR-003）
  | { type: 'quilt:select'; qid: string; tag: string; text: string; classes: string; href: string | null; rect: { x: number; y: number; w: number; h: number } }
    // 父页在热更新后要求按 qid 重选（quilt:reselect），元素已不在时回这个：检查器清空
  | { type: 'quilt:deselect'; qid: string };

export type ParentToPreview =
    // keepScroll：同一屏换新修订（聚焦态热更新）时保留滚动位置；跳转不传，回到顶部
  | { type: 'quilt:swap'; html: string; route: string; keepScroll?: boolean }
  | { type: 'quilt:mode'; mode: 'interact' | 'inspect' }
  | { type: 'quilt:highlight'; qid: string | null }
    // 热更新换了修订后按 qid 重新选中同一元素（回 quilt:select 带新值；元素没了回 quilt:deselect）
  | { type: 'quilt:reselect'; qid: string }
    // 屏内标记（REQ-EDIT-002）：working = 正在被作业改的元素（描边 + 「修改中…」角标），done = 刚回写完的（绿描边 + 「已更新」，运行时 4 s 后自撤）
  | { type: 'quilt:mark'; working: string[]; done?: string[] };

export function isPreviewMessage(data: unknown): data is PreviewToParent {
  return !!data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string' && (data as { type: string }).type.startsWith('quilt:');
}
