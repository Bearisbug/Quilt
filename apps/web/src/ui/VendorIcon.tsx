import { Cpu } from 'lucide-react';
import type { ChannelVendor } from '@quilt/core/browser';
import { VENDOR_SVGS } from './vendorIcons';

// 通道前面的厂商图标（REQ-CORE-013）。彩色版优先；OpenAI 与 Ollama 的品牌本身就是单色，用单色版；本机订阅也是 Claude，凭据来自机器上的登录态。
// 图标只是辨认辅助，可访问名由旁边的文字承担，所以一律 aria-hidden
export function VendorIcon({ vendor, size = 16, className }: { vendor: ChannelVendor; size?: number; className?: string }) {
  const svg = VENDOR_SVGS[vendor === 'claude-subscription' ? 'anthropic' : vendor];
  if (!svg) return <Cpu size={size} className={className} aria-hidden="true" />;
  // 静态 SVG 来自仓库里的常量，不含用户输入
  return <span className={className} aria-hidden="true" style={{ display: 'inline-flex', width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
