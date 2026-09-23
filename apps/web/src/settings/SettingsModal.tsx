import { useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';
import { Cable, Gauge, X } from 'lucide-react';
import type { RunnerOptionDto, UsageDto } from '@quilt/core';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, IconButton, Spinner } from '@/ui/ui';
import { ChannelManager } from '@/settings/ChannelManager';
import { Overlay, useModal } from '@/ui/modal';

// 设置弹层（§13 导航 v0.29 / v0.32 本地版两节）：左栏分节、右栏只放当前节。分节即视图标识（INT-020）——进 URL 的 ?settings=<id>，由画布页读写。
export const SETTINGS_SECTIONS = [
  { id: 'usage', label: '本月用量', icon: Gauge },
  { id: 'runners', label: '生成通道', icon: Cable },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export const isSettingsSection = (v: string | null): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);

const DRIVER_LABEL: Record<string, string> = { 'agent-sdk': '本机 Claude 订阅', anthropic: 'Anthropic', gemini: 'Gemini', openai: 'OpenAI 兼容', stub: '桩' };
const fmt = (n: number) => n.toLocaleString();

export function SettingsModal({ section, onSection, onClose, returnTo, onCatalog }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void; returnTo?: React.RefObject<HTMLElement | null>; onCatalog?: (items: RunnerOptionDto[], defaultId: string) => void }) {
  const toast = useToast();
  // 长内容弹层：初始焦点落容器（A11Y-004 ③），Tab 再进左栏当前节 → 右栏内容 → 关闭
  const ref = useModal<HTMLDivElement>(onClose, returnTo, undefined, { initialFocus: 'self' });
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const [usageError, setUsageError] = useState(false);
  const load = () => { setUsageError(false); api.usage().then(setUsage).catch(() => setUsageError(true)); };
  useEffect(load, []);
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择', 'error'); } };
  // MCP 接入命令（API-AGENT-002）：本地版免鉴权，地址就是本机 API
  const mcpAdd = `claude mcp add --transport http quilt ${window.location.origin.replace(/:5173$/, ':3100')}/mcp`;

  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal" tabIndex={-1}
        className="relative flex h-[min(42rem,calc(100dvh-2rem))] w-full max-w-4xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl fade-up outline-none">
        {/* Radix Tabs 垂直方向（INT-002）：左栏整组只占一个 Tab 停靠点，上下方向键换节并立即切换 */}
        <Tabs.Root value={section} onValueChange={(v) => onSection(v as SettingsSection)} orientation="vertical" className="flex min-h-0 flex-1">
          <div className="flex w-48 shrink-0 flex-col border-r border-line p-3">
            <h2 id="settings-title" className="px-2.5 pb-3 pt-1.5 text-base font-semibold">设置</h2>
            <Tabs.List aria-label="设置分节" className="scroll-nav flex min-h-0 flex-1 flex-col gap-0.5">
              {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
                <Tabs.Trigger key={id} value={id} data-testid={`settings-tab-${id}`}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted transition-colors duration-[var(--duration-fast)] hover:bg-panel-2 hover:text-fg data-[state=active]:bg-panel-2 data-[state=active]:font-medium data-[state=active]:text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]">
                  <Icon size={15} aria-hidden="true" className="shrink-0" /><span className="truncate">{label}</span>
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>
          <div className="scroll min-w-0 flex-1 p-6 pr-14">
            <Tabs.Content value="usage" className="outline-none" data-testid="usage">
              <h3 className="text-sm font-semibold">本月用量</h3>
              <p className="mt-1 text-xs text-muted">只作记录，没有上限——花的是你自己的 Key 或订阅。交给本机 agent 的作业不计入。</p>
              {usageError ? (
                <p role="alert" className="mt-3 flex items-center justify-between gap-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger"><span>用量加载失败</span><Button size="sm" onClick={load}>重试</Button></p>
              ) : !usage ? <div className="h-20"><Spinner /></div> : (
                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-3 gap-3" data-testid="usage-totals">
                    <Stat label="生成屏数" value={fmt(usage.screens)} />
                    <Stat label="输入 token" value={fmt(usage.tokensIn)} />
                    <Stat label="输出 token" value={fmt(usage.tokensOut)} />
                  </dl>
                  {usage.inflight.calls > 0 && <p className="text-xs text-muted">进行中：预计 {usage.inflight.calls} 次调用 · {usage.inflight.screens} 屏（完成后计入）</p>}
                  {usage.byDriver.length > 0 && (
                    <table className="w-full text-xs" data-testid="usage-by-driver">
                      <caption className="sr-only">按通道分列的用量</caption>
                      <thead><tr className="text-left text-muted"><th className="py-1 font-normal">通道</th><th className="py-1 text-right font-normal">屏</th><th className="py-1 text-right font-normal">输入</th><th className="py-1 text-right font-normal">输出</th></tr></thead>
                      <tbody className="divide-y divide-line">
                        {usage.byDriver.map((d) => (
                          <tr key={`${d.driver}:${d.model}`}>
                            <td className="py-1.5"><span className="font-medium">{DRIVER_LABEL[d.driver] ?? d.driver}</span> <span className="text-muted">{d.model}</span></td>
                            <td className="py-1.5 text-right tabular-nums">{fmt(d.screens)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensIn)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensOut)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="text-xs text-muted">{usage.month} 月，UTC 月初清零重新计。</p>
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content value="runners" className="outline-none" data-testid="runners">
              <ChannelManager onCatalog={onCatalog} />
              {/* 反向接入（API-AGENT-002）：本机 agent 自己连 Quilt 的 MCP，本地版免鉴权 */}
              <h3 className="mt-8 text-sm font-semibold">让本机 agent 接入 Quilt（MCP）</h3>
              <p className="mt-1 text-xs text-muted">在 Claude Code / Codex / Cursor 里接入 Quilt，本地版不需要授权：</p>
              <div className="mt-2 flex items-center gap-2"><code className="flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-xs" data-testid="mcp-add">{mcpAdd}</code><Button size="sm" onClick={() => copy(mcpAdd)}>复制</Button></div>
            </Tabs.Content>
          </div>
        </Tabs.Root>
        <div className="absolute right-3 top-3"><IconButton label="关闭" hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton></div>
      </div>
    </Overlay>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
