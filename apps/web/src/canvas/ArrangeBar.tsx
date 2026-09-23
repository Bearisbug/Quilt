import { useRef, useState } from 'react';
import { IconButton } from '@/ui/ui';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, GalleryHorizontal, GalleryVertical } from 'lucide-react';
import { LAYOUT_GAP, type ArrangeKind } from './arrange';

// 排列条的按钮（REQ-CORE-018）：六个对齐 + 两个等距 + 两个排列（v0.52），数组顺序就是方向键在工具条里移动的顺序
const ALIGN_BTNS = [['left', '左对齐', AlignStartVertical], ['hcenter', '水平居中', AlignCenterVertical], ['right', '右对齐', AlignEndVertical], ['top', '上对齐', AlignStartHorizontal], ['vcenter', '垂直居中', AlignCenterHorizontal], ['bottom', '下对齐', AlignEndHorizontal]] as const;
const SPACE_BTNS = [['hspace', '横向等距', AlignHorizontalDistributeCenter], ['vspace', '纵向等距', AlignVerticalDistributeCenter]] as const;
const LAYOUT_BTNS = [['hrow', '排成一行', GalleryHorizontal], ['vcol', '排成一列', GalleryVertical]] as const;
const ARRANGE_N = ALIGN_BTNS.length + SPACE_BTNS.length + LAYOUT_BTNS.length;

// 多选排列条（REQ-CORE-018）：选中 ≥ 2 屏且没聚焦时出现在画布顶部中央；等距要 ≥ 3 屏。
// 候选就地展开时让位：候选胶囊挂在每格上方、与这条争同一批像素，而这条在上面——点「收起」会点成对齐键并把新位置落库。
// 右端避让右侧浮层（--chrome-right 含工具栏与滑出面板，与输入框同一组变量）：面板层级更高且不避让，
// 写死视口居中时窄视口下右端的等距按钮会钻到面板底下；左侧这一条横带上没有浮层（对话记录贴底、顶栏在其上方），所以只让右边。
// 窄视口下面板改成叠在画布上、可用区不再为它让位（styles.css 的 48rem 断点），此时整条让位给面板。
// 出现条件由父组件判（选中 ≥ 2 屏、未聚焦、未在选元素 / 批注、候选没展开）；这里只管排版与键盘。
// 排列条声明了 role=toolbar：整组在 Tab 序里只占一个停靠点，方向键在组内移动焦点（INT-002，与 CanvasToolbar 同一套做法）
export function ArrangeBar({ count, yieldToPanel, onArrange }: { count: number; yieldToPanel: boolean; onArrange: (kind: ArrangeKind) => void }) {
  const [cursor, setCursor] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number | undefined> = { ArrowRight: cursor + 1, ArrowLeft: cursor - 1, Home: 0, End: ARRANGE_N - 1 };
    const next = to[e.key];
    if (next == null) return;
    e.preventDefault();
    const at = (next + ARRANGE_N) % ARRANGE_N;
    setCursor(at);
    refs.current[at]?.focus();
  };
  return (
      <div role="toolbar" aria-orientation="horizontal" aria-label={`排列已选的 ${count} 屏`} data-testid="arrange-bar" onKeyDown={onKey}
        className={`absolute left-0 right-[var(--chrome-right)] top-16 z-10 mx-auto flex w-max items-center gap-0.5 rounded-full border border-line bg-panel/95 p-1 shadow-lg backdrop-blur${yieldToPanel ? ' [@media(max-width:48rem)]:hidden' : ''}`}>
        <span className="whitespace-nowrap px-2 text-xs text-muted tabular-nums">{count} 屏</span>
        {ALIGN_BTNS.map(([k, label, Icon], i) => (
          <IconButton key={k} ref={(el) => { refs.current[i] = el; }} tabIndex={i === cursor ? 0 : -1} size="xs" tip="bottom" label={label} data-testid={`arrange-${k}`} onFocus={() => setCursor(i)} onClick={() => { setCursor(i); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        {SPACE_BTNS.map(([k, label, Icon], i) => {
          const at = ALIGN_BTNS.length + i;
          return <IconButton key={k} ref={(el) => { refs.current[at] = el; }} tabIndex={at === cursor ? 0 : -1} size="xs" tip="bottom" label={label} desc="保住最左 / 最上和最右 / 最下两屏，中间按间隙均分" unavailable={count < 3 ? '至少选 3 屏' : false} data-testid={`arrange-${k}`} onFocus={() => setCursor(at)} onClick={() => { setCursor(at); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
        })}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        {LAYOUT_BTNS.map(([k, label, Icon], i) => {
          const at = ALIGN_BTNS.length + SPACE_BTNS.length + i;
          return <IconButton key={k} ref={(el) => { refs.current[at] = el; }} tabIndex={at === cursor ? 0 : -1} size="xs" tip="bottom" label={label} desc={k === 'hrow' ? `按当前左右顺序排成一行，间距 ${LAYOUT_GAP}` : `按当前上下顺序排成一列，间距 ${LAYOUT_GAP}`} data-testid={`arrange-${k}`} onFocus={() => setCursor(at)} onClick={() => { setCursor(at); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
        })}
      </div>
  );
}
