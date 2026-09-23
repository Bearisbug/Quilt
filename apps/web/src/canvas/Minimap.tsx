import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// 小地图（REQ-CORE-024 v0.61）：按全部卡片的外接框等比缩放，画屏（实心）、组件（描边）、风格指南卡（虚线）与当前视口框。
// 视图变换每帧都在变，所以不经父组件 props 走：自己订阅 CanvasView 的视图流、rAF 合帧后只重画这一块。
export type MiniRect = { id: string; kind: 'screen' | 'component' | 'guide'; x: number; y: number; w: number; h: number };
export type ViewInfo = { x: number; y: number; zoom: number; w: number; h: number };

const W = 176; const H = 112; const PAD = 8;

export function Minimap({ rects, onView, onPanTo }: { rects: MiniRect[]; onView: (cb: (v: ViewInfo) => void) => () => void; onPanTo: (x: number, y: number) => void }) {
  const [view, setView] = useState<ViewInfo | null>(null);
  useEffect(() => {
    let raf = 0; let last: ViewInfo | null = null;
    const off = onView((v) => { last = v; if (!raf) raf = requestAnimationFrame(() => { raf = 0; setView(last); }); });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [onView]);
  // 视口在世界坐标里的框：世界层 transform 是 translate(x, y) scale(zoom)，屏幕点 (0,0) 对应世界 (−x/zoom, −y/zoom)
  const vw = view ? { x: -view.x / view.zoom, y: -view.y / view.zoom, w: view.w / view.zoom, h: view.h / view.zoom } : null;
  const box = useMemo(() => {
    const all = [...rects, ...(vw ? [{ ...vw }] : [])];
    if (!all.length) return { x0: 0, y0: 0, scale: 1, ox: 0, oy: 0 };
    const x0 = Math.min(...all.map((r) => r.x)); const y0 = Math.min(...all.map((r) => r.y));
    const x1 = Math.max(...all.map((r) => r.x + r.w)); const y1 = Math.max(...all.map((r) => r.y + r.h));
    const scale = Math.min((W - 2 * PAD) / Math.max(1, x1 - x0), (H - 2 * PAD) / Math.max(1, y1 - y0));
    // 短边居中
    return { x0, y0, scale, ox: (W - 2 * PAD - (x1 - x0) * scale) / 2, oy: (H - 2 * PAD - (y1 - y0) * scale) / 2 };
  }, [rects, vw?.x, vw?.y, vw?.w, vw?.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const toMini = (x: number, y: number) => [PAD + box.ox + (x - box.x0) * box.scale, PAD + box.oy + (y - box.y0) * box.scale] as const;
  const svgRef = useRef<SVGSVGElement>(null);
  const down = useRef(false);
  // 点哪儿镜头就平移到哪儿（缩放不变），按住拖动连续平移；指针事件截在这里，不让画布把它当成框选 / 平移
  const jump = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    onPanTo(box.x0 + (mx - PAD - box.ox) / box.scale, box.y0 + (my - PAD - box.oy) / box.scale);
  };
  const screens = rects.filter((r) => r.kind === 'screen').length;
  return (
    <svg ref={svgRef} className="minimap chrome nopan nowheel" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`小地图：${screens} 屏，点击平移画布`} data-testid="minimap"
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); down.current = true; svgRef.current?.setPointerCapture(e.pointerId); jump(e); }}
      onPointerMove={(e) => { if (down.current) jump(e); }}
      onPointerUp={(e) => { down.current = false; svgRef.current?.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { down.current = false; }}
      onDoubleClick={(e) => e.stopPropagation()}>
      {rects.map((r) => {
        const [x, y] = toMini(r.x, r.y);
        return <rect key={r.id} className={`mm-${r.kind}`} x={x} y={y} width={Math.max(2, r.w * box.scale)} height={Math.max(2, r.h * box.scale)} rx={1.5} data-testid={`minimap-${r.kind}`} />;
      })}
      {vw && (() => { const [x, y] = toMini(vw.x, vw.y); return <rect className="mm-view" x={x} y={y} width={Math.max(4, vw.w * box.scale)} height={Math.max(4, vw.h * box.scale)} rx={2} data-testid="minimap-view" />; })()}
    </svg>
  );
}
