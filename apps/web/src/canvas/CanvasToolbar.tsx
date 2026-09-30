import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from '@/ui/ui';

export type Tool = {
  id: string;
  label: string;
  hint?: string;
  /** 这个工具是干什么的——图标按钮没有可见文字，说明必须进提示 */
  desc?: string;
  icon: ReactNode;
  /** 有值即渲染为可切换按钮（aria-pressed）；纯动作按钮不传 */
  active?: boolean;
  /** 不可用的原因；给了就阻止激活并在提示里说明为什么（A11Y-007 / INT-013） */
  unavailable?: string | false;
  testId?: string;
  onSelect: () => void;
};

// 右侧竖排工具栏（INT-002）：整组在 Tab 序里只占一个停靠点，方向键在组内移动焦点。
// 分组之间用分隔线：画布工具 ｜ 发起作业 ｜ 随选中/聚焦态出现的上下文工具。
export function CanvasToolbar({ groups }: { groups: Tool[][] }) {
  const items = groups.flat();
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 提示必须渲染在滚动容器之外：.rail 的 overflow-y:auto 会把 overflow-x 一并变成 auto，
  // 贴左边展开的提示整块落在容器盒子外，会被无声裁掉（实测宽 208px 全部不可见）。
  const [tip, setTip] = useState<{ tool: Tool; top: number } | null>(null);
  const showTip = (tool: Tool, el: HTMLElement | null) => {
    const wrap = wrapRef.current;
    if (!wrap || !el) return;
    const wr = wrap.getBoundingClientRect(); const br = el.getBoundingClientRect();
    setTip({ tool, top: br.top - wr.top + br.height / 2 });
  };
  // 上下文工具随选中/聚焦态增删，停靠点可能落到已消失的项上
  const idx = Math.min(active, items.length - 1);
  // 窗口矮到放不下全部工具时在列内滚动（滚动条隐藏，RESP-016）；哪一侧还有被遮住的工具，那一侧边缘渐隐提示——
  // 常驻渐隐会把没溢出时的首尾按钮也淡掉一截，所以按滚动位置算
  const railRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState('');
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      const top = rail.scrollTop > 1; const bottom = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1;
      setFade([top && 'top', bottom && 'bottom'].filter(Boolean).join(' '));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(rail);
    for (const child of Array.from(rail.children)) ro.observe(child);
    rail.addEventListener('scroll', update, { passive: true });
    return () => { ro.disconnect(); rail.removeEventListener('scroll', update); };
  }, [items.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number | undefined> = { ArrowDown: idx + 1, ArrowUp: idx - 1, Home: 0, End: items.length - 1 };
    const next = to[e.key];
    if (next == null) return;
    e.preventDefault();
    const wrapped = (next + items.length) % items.length;
    setActive(wrapped);
    refs.current[wrapped]?.focus();
  };

  let cursor = -1;
  return (
    // 外层是纵向 flex：按钮列才能在最大高度内收缩并滚动。只给 max-height 的话列的 max-height:100% 没有确定高度可算，
    // 约束落空，放不下的工具直接溢出到药丸外面（实测窗口高 ~900 px 时最后一个工具掉到外面）
    // 内边距放在滚动列里而不是药丸上：滚动容器会裁掉越界的绘制，首尾按钮的焦点环（外扩 4 px）在边上被切掉一截；
    // scroll-padding 同值，键盘移到首尾时滚动也把焦点环留在可见区里。
    // z-30 高于右侧滑出面板（z-20）：提示画在工具栏这一层里、向左展开正好落在面板上，同层的话被后渲染的面板整块盖住
    <div ref={wrapRef} className="chrome absolute right-3 top-1/2 z-30 flex max-h-[calc(100%-7rem)] -translate-y-1/2 flex-col rounded-full p-0.5">
      <div ref={railRef} data-fade={fade || undefined} className="rail flex min-h-0 scroll-py-1 flex-col items-center gap-0.5 p-1" role="toolbar" aria-orientation="vertical" aria-label="画布工具" onKeyDown={onKeyDown}>
        {groups.map((group, gi) => (
          <Fragment key={gi}>
            {gi > 0 && <span className="my-1 h-px w-6 shrink-0 bg-line" aria-hidden="true" />}
            {group.map((t) => {
              cursor += 1;
              const at = cursor;
              return (
                <IconButton
                  key={t.id}
                  ref={(el) => { refs.current[at] = el; }}
                  tabIndex={at === idx ? 0 : -1}
                  label={t.label}
                  active={t.active}
                  unavailable={t.unavailable}
                  tip="none"
                  aria-pressed={t.active}
                  data-testid={t.testId}
                  data-tool={t.id}
                  onPointerEnter={(e) => showTip(t, e.currentTarget)}
                  onPointerLeave={() => setTip(null)}
                  // 只在键盘焦点时出提示：关面板后焦点被程序归还到这里（Canvas），鼠标用户不该因此冒出一个提示
                  onFocus={(e) => { setActive(at); if (e.currentTarget.matches(':focus-visible')) showTip(t, e.currentTarget); }}
                  onBlur={() => setTip(null)}
                  onClick={() => { setActive(at); t.onSelect(); }}
                >
                  {t.icon}
                </IconButton>
              );
            })}
          </Fragment>
        ))}
      </div>
      {tip && (
        <div
          aria-hidden="true" data-testid="tool-tip" style={{ top: tip.top }}
          className="tip-in pointer-events-none absolute right-full mr-2 w-56 -translate-y-1/2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-fg shadow-lg"
        >
          <span className="flex items-baseline gap-1.5 whitespace-nowrap font-medium">
            {tip.tool.label}
            {tip.tool.hint && <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-sans text-[10px] text-muted">{tip.tool.hint}</kbd>}
          </span>
          {(tip.tool.unavailable || tip.tool.desc) && <span className="mt-1 block leading-relaxed text-muted">{tip.tool.unavailable || tip.tool.desc}</span>}
        </div>
      )}
    </div>
  );
}
