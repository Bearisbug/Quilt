// 用 zoom 缩小显示的 iframe（画布聚焦屏、草稿看板）：里面的视口按整设备像素取，n × 倍率 × DPR 不是整数时会被取整，
// 设备宽 390 的屏里视口可能成了 389.96，正好 390 宽的元素就多出 1 px 的横向滚动。把边长取到刚好不少于 n 的整设备像素，
// 多出的不到 1 个设备像素由外层裁掉（倍率 × DPR ≥ 1 时里面的 innerWidth 仍是 n）
export function frameSide(n: number, zoom: number): number {
  const k = zoom * (window.devicePixelRatio || 1);
  return Math.ceil(n * k - 1e-6) / k;
}
