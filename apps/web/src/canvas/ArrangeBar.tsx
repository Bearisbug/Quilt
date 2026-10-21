import { useRef, useState } from 'react';
import { IconButton } from '@/ui/ui';
import { useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, GalleryHorizontal, GalleryVertical } from 'lucide-react';
import { LAYOUT_GAP, type ArrangeKind } from './arrange';

// 排列条的按钮（REQ-CORE-018）：六个对齐 + 两个等距 + 两个排列（v0.52），数组顺序就是方向键在工具条里移动的顺序；名字在 canvas-parts 的 arrange.btn.<kind>
const ALIGN_BTNS = [['left', AlignStartVertical], ['hcenter', AlignCenterVertical], ['right', AlignEndVertical], ['top', AlignStartHorizontal], ['vcenter', AlignCenterHorizontal], ['bottom', AlignEndHorizontal]] as const;
const SPACE_BTNS = [['hspace', AlignHorizontalDistributeCenter], ['vspace', AlignVerticalDistributeCenter]] as const;
const LAYOUT_BTNS = [['hrow', GalleryHorizontal], ['vcol', GalleryVertical]] as const;
const ARRANGE_N = ALIGN_BTNS.length + SPACE_BTNS.length + LAYOUT_BTNS.length;

// 多选排列条（REQ-CORE-018）：选中 ≥ 2 屏且没聚焦时出现在画布顶部中央；等距要 ≥ 3 屏。
// 候选就地展开时让位：候选胶囊挂在每格上方、与这条争同一批像素，而这条在上面——点「收起」会点成对齐键并把新位置落库。
// 右端避让右侧浮层（--chrome-right 含工具栏与滑出面板，与输入框同一组变量）：面板层级更高且不避让，
// 写死视口居中时窄视口下右端的等距按钮会钻到面板底下。左侧这一条横带上只有小地图（左上角，与这条同在 top 4rem）：
// 这条层级高于它（z-20，DOM 在画布之后），窄视口下两者相交时盖在小地图的右上角上，而不是被它盖住屏数与前两个对齐键（v0.78）。
// 窄视口下面板改成叠在画布上、可用区不再为它让位（styles.css 的 48rem 断点），此时整条让位给面板。
// 出现条件由父组件判（选中 ≥ 2 屏、未聚焦、未在选元素、候选没展开）；这里只管排版与键盘。
// 排列条声明了 role=toolbar：整组在 Tab 序里只占一个停靠点，方向键在组内移动焦点（INT-002，与 CanvasToolbar 同一套做法）
export function ArrangeBar({ count, yieldToPanel, onArrange }: { count: number; yieldToPanel: boolean; onArrange: (kind: ArrangeKind) => void }) {
  const t = useT(canvasMessages);
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
      <div role="toolbar" aria-orientation="horizontal" aria-label={t('arrange.toolbar', { count })} data-testid="arrange-bar" onKeyDown={onKey}
        className={`absolute left-0 right-[var(--chrome-right)] top-16 z-20 mx-auto flex w-max items-center gap-0.5 chrome rounded-lg p-1${yieldToPanel ? ' [@media(max-width:48rem)]:hidden' : ''}`}>
        <span className="whitespace-nowrap px-2 type-label text-text-secondary tabular-nums">{t('screenCount', { count })}</span>
        {ALIGN_BTNS.map(([k, Icon], i) => (
          <IconButton key={k} ref={(el) => { refs.current[i] = el; }} tabIndex={i === cursor ? 0 : -1} size="xs" tip="bottom" label={t(`arrange.btn.${k}`)} data-testid={`arrange-${k}`} onFocus={() => setCursor(i)} onClick={() => { setCursor(i); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>
        ))}
        <span className="mx-1 h-5 w-px bg-border-subtle" aria-hidden="true" />
        {SPACE_BTNS.map(([k, Icon], i) => {
          const at = ALIGN_BTNS.length + i;
          return <IconButton key={k} ref={(el) => { refs.current[at] = el; }} tabIndex={at === cursor ? 0 : -1} size="xs" tip="bottom" label={t(`arrange.btn.${k}`)} desc={t('arrange.spaceDesc')} unavailable={count < 3 ? t('arrange.needThree') : false} data-testid={`arrange-${k}`} onFocus={() => setCursor(at)} onClick={() => { setCursor(at); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
        })}
        <span className="mx-1 h-5 w-px bg-border-subtle" aria-hidden="true" />
        {LAYOUT_BTNS.map(([k, Icon], i) => {
          const at = ALIGN_BTNS.length + SPACE_BTNS.length + i;
          return <IconButton key={k} ref={(el) => { refs.current[at] = el; }} tabIndex={at === cursor ? 0 : -1} size="xs" tip="bottom" label={t(`arrange.btn.${k}`)} desc={t(k === 'hrow' ? 'arrange.hrowDesc' : 'arrange.vcolDesc', { gap: LAYOUT_GAP })} data-testid={`arrange-${k}`} onFocus={() => setCursor(at)} onClick={() => { setCursor(at); onArrange(k); }}><Icon size={16} aria-hidden="true" /></IconButton>;
        })}
      </div>
  );
}
