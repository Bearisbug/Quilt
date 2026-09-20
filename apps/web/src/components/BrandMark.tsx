import { cn } from './ui';

// Quilt 品牌标识（品牌包 Quilt-Brand-Design Q-F-v6）。
//
// 品牌对尺寸有硬下限：完整符号从 64 CSS px 起用，横向组合显示宽度至少 240 px（BRAND.md §5）。
// 工具的顶栏只有 48 px 高，两者都放不下，所以分成两个组件各司其职：
//   <Wordmark> 字标——Space Grotesk 500 / -0.03 em，是唯一能跟着 chrome 缩小的品牌元素；
//   <BrandSymbol> 完整符号——只用在放得下 64 px 的地方，低于下限直接报错而不是偷偷缩。
// 深色外壳上一律用反白版（BRAND.md §3「Ink 深底优先反白」）。

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('wordmark', className)}>Quilt</span>;
}

/** 符号边长下限，单位 CSS px（BRAND.md §5） */
const MIN_PX = 64;

export function BrandSymbol({ size = MIN_PX, label, className }: { size?: number; label?: string; className?: string }) {
  if (size < MIN_PX) throw new Error(`BrandSymbol: ${size}px 低于品牌下限 ${MIN_PX}px，请改用 <Wordmark>`);
  // 安全区 = 坐标框宽度的 1/8（BRAND.md §5）。补在外层而不是 img 的 padding 上——
  // preflight 的 box-sizing:border-box 会让 padding 从尺寸里扣，符号会缩到下限以下。
  // size 指符号本身的边长，不含安全区。
  const pad = size / 8;
  return (
    <span className={cn('block shrink-0', className)} style={{ padding: pad }}>
      {/* 固定 1:1 的矢量，源尺寸可控，不需要 object-fit（VIS-006）；
          显式宽高避免加载期跳动，alt 在加载失败时兜底出文字（PERF-003） */}
      <img src="/brand/symbol-reverse.svg" alt={label ?? ''} width={size} height={size} style={{ width: size, height: size }} className="block" />
    </span>
  );
}
