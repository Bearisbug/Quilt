import { Claude, Gemini, OpenAI, DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, Ollama, SiliconCloud } from '@lobehub/icons';
import { Cpu } from 'lucide-react';
import type { ChannelVendor } from '@quilt/core';

// 通道前面的厂商图标（REQ-CORE-013）。彩色版优先；OpenAI 与 Ollama 的品牌本身就是单色，用单色版。
// 图标只是辨认辅助，可访问名由旁边的文字承担，所以一律 aria-hidden。
type IconComponent = React.ComponentType<{ size?: number; className?: string }>;
const ICONS: Record<Exclude<ChannelVendor, 'custom'>, IconComponent> = {
  anthropic: Claude.Color,
  // 本机订阅也是 Claude，只是凭据来自机器上的登录态
  'claude-subscription': Claude.Color,
  google: Gemini.Color,
  openai: OpenAI,
  deepseek: DeepSeek.Color,
  qwen: Qwen.Color,
  moonshot: Kimi.Color,
  zhipu: Zhipu.Color,
  openrouter: OpenRouter.Color,
  ollama: Ollama,
  siliconflow: SiliconCloud.Color,
};

export function VendorIcon({ vendor, size = 16, className }: { vendor: ChannelVendor; size?: number; className?: string }) {
  const Icon = vendor === 'custom' ? null : ICONS[vendor];
  if (!Icon) return <Cpu size={size} className={className} aria-hidden="true" />;
  return <span className={className} aria-hidden="true" style={{ display: 'inline-flex', width: size, height: size }}><Icon size={size} /></span>;
}
