// 预览 iframe ↔ 画布父页的 postMessage 协议（§8 API-CORE-016 运行时；§24 共享类型）。
import { z } from 'zod';

// 预览文档发给父页的消息逐条校验（v1.06）：屏可以带自己的 <script>（REQ-CORE-022），父页按 origin / source 分不出消息出自运行时还是屏脚本，
// 形状不对的一律丢掉，免得缺字段的 quilt:wheel 把画布缩放算成 NaN。数值字段只收有限数（zod 的 number 不收 NaN / Infinity）
const elementPathItemSchema = z.object({ qid: z.string(), tag: z.string() });
export const previewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quilt:ready'), title: z.string() }),
  z.object({ type: z.literal('quilt:navigate'), href: z.string() }),
  z.object({ type: z.literal('quilt:swapped'), route: z.string(), title: z.string() }),
  // 焦点在预览文档里时画布快捷键收不到，由运行时转发：Esc / Alt+← / ⌘E / ⌘/ / ⌘K / ⌥ + 字母（code 用物理键，与父页的键位表一致）
  z.object({ type: z.literal('quilt:key'), key: z.string(), code: z.string().optional(), altKey: z.boolean(), metaKey: z.boolean().optional(), ctrlKey: z.boolean().optional() }),
  z.object({ type: z.literal('quilt:dead') }),
  // 叠层屏（v0.63 REQ-PROTO-005）：点了遮罩要关最上一层——由父页决定（它管导航栈），运行时只报
  z.object({ type: z.literal('quilt:overlay-dismiss') }),
  // 捏合（ctrl+wheel）；pan = 组件预览里落在没有可滚区域处的普通滚轮（v0.80），父页平移画布
  z.object({ type: z.literal('quilt:wheel'), deltaY: z.number(), x: z.number(), y: z.number(), deltaX: z.number().optional(), pan: z.boolean().optional() }),
  // rect 为屏文档坐标（含滚动偏移），与 fullPage:false 的截图同一坐标系，供画布层画批注气泡（REQ-EDIT-004 / ADR-003）
  // component：元素所在的共享组件名（自身或祖先带 data-component，REQ-EDIT-006），检查器据此挡住直改、给「改组件 / 脱离共享」
  // path（v1.00 逐级选）：从屏根到锚点（最近一次悬停 / 点中的最里层元素）的祖先链，当前选中是其中一级
  z.object({
    type: z.literal('quilt:select'), qid: z.string(), tag: z.string(), text: z.string(), classes: z.string(), href: z.string().nullable(), component: z.string().nullable(),
    rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), path: z.array(elementPathItemSchema).optional(),
  }),
  // 父页在热更新后要求按 qid 重选（quilt:reselect），元素已不在时回这个：检查器清空
  z.object({ type: z.literal('quilt:deselect'), qid: z.string() }),
  // 组件预览页（/c/，REQ-EDIT-006）量到的根元素框，由 componentPreviewDocument 里的测量脚本发出，不经运行时
  z.object({ type: z.literal('quilt:component-size'), componentId: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
]);
export type PreviewToParent = z.infer<typeof previewMessageSchema>;

export type MarkPalette = { line: string; onLine: string; halo: string; success: string };

export type ParentToPreview =
    // keepScroll：同一屏换新修订（聚焦态热更新）时保留滚动位置；跳转不传，回到顶部
  | { type: 'quilt:swap'; html: string; route: string; keepScroll?: boolean }
    // marks（v1.08）：画布标记的颜色，父页取当前外观的 tokens 变量（§13.1「画布标记」），运行时据此画选中框、悬停框与修改标记，不写死颜色
  | { type: 'quilt:mode'; mode: 'interact' | 'inspect'; marks: MarkPalette }
    // 叠层屏（v0.63）：把 html 的根元素压在当前文档上（45% 暗遮罩 + 根元素），不换 DOM；swap 会先清掉全部叠层
  | { type: 'quilt:overlay'; html: string; route: string }
  | { type: 'quilt:overlay-close' }
  | { type: 'quilt:highlight'; qid: string | null }
    // 热更新换了修订后按 qid 重新选中同一元素（回 quilt:select 带新值；元素没了回 quilt:deselect）
  | { type: 'quilt:reselect'; qid: string }
    // 屏内标记（REQ-EDIT-002）：working = 正在被作业改的元素（描边 + 「修改中…」角标），done = 刚回写完的（绿描边 + 「已更新」，运行时 4 s 后自撤）
  | { type: 'quilt:mark'; working: string[]; done?: string[] }
    // 逐级选（v1.00 REQ-EDIT-001）：climb = 焦点在父页时的 Shift+Enter（up）/ Enter（down）；pick = 检查器祖先路径点了某一级；
    // peek = 路径上悬停 / 聚焦某一级，在屏上画悬停框（null 撤掉）
  | { type: 'quilt:climb'; dir: 'up' | 'down' }
  | { type: 'quilt:pick'; qid: string }
  | { type: 'quilt:peek'; qid: string | null };

export type ElementPathItem = z.infer<typeof elementPathItemSchema>;

export function isPreviewMessage(data: unknown): data is PreviewToParent {
  return previewMessageSchema.safeParse(data).success;
}
