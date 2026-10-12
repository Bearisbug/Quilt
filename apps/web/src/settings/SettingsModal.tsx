import { useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';
import { Cable, Gauge, SunMoon, X } from 'lucide-react';
import type { RunnerOptionDto, UsageDto } from '@quilt/core/browser';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, IconButton, Spinner } from '@/ui/ui';
import { ChannelManager } from '@/settings/ChannelManager';
import { Overlay, useModal } from '@/ui/modal';
import { SETTINGS_SECTIONS, type SettingsSection } from '@/settings/sections';
import { readThemePref, setThemePref, useResolvedMode, type ThemePref } from '@/lib/theme';

// 设置弹层（§13 导航 v0.29 / v0.32 本地版，v1.08 加「外观」共三节）：左栏分节、右栏只放当前节。分节即视图标识（INT-020）——进 URL 的 ?settings=<id>，由画布页读写。
// 分节表在 sections.ts：画布页要在首屏判断 URL，而本弹层按需加载
const SECTION_ICONS = { usage: Gauge, runners: Cable, appearance: SunMoon } as const;

const DRIVER_LABEL: Record<string, string> = { 'agent-sdk': '本机 Claude 订阅', codex: '本机 Codex 订阅', anthropic: 'Anthropic', gemini: 'Gemini', openai: 'OpenAI 兼容', stub: '桩' };
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
  // MCP 接入命令（API-AGENT-002）：本地版免鉴权，地址就是本机 API；Codex 一条另给（v0.68），接入后要新开线程才加载
  const mcpUrl = `${window.location.origin.replace(/:6688$/, ':3100')}/mcp`;
  const mcpAdd = `claude mcp add --transport http quilt ${mcpUrl}`;
  const codexMcpAdd = `codex mcp add quilt --url ${mcpUrl}`;

  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal" tabIndex={-1}
        className="relative flex h-[min(42rem,calc(100dvh-2rem))] w-full max-w-4xl overflow-hidden rounded-lg border border-border-subtle bg-surface-overlay shadow-(--semantic-elevation-overlay) fade-up outline-none">
        {/* Radix Tabs 垂直方向（INT-002）：左栏整组只占一个 Tab 停靠点，上下方向键换节并立即切换 */}
        <Tabs.Root value={section} onValueChange={(v) => onSection(v as SettingsSection)} orientation="vertical" className="flex min-h-0 flex-1">
          <div className="flex w-48 shrink-0 flex-col border-r border-border-subtle p-3">
            <h2 id="settings-title" className="px-2.5 pb-3 pt-1.5 type-heading2 font-medium">设置</h2>
            <Tabs.List aria-label="设置分节" className="scroll-nav flex min-h-0 flex-1 flex-col gap-0.5">
              {SETTINGS_SECTIONS.map(({ id, label }) => { const Icon = SECTION_ICONS[id]; return (
                <Tabs.Trigger key={id} value={id} data-testid={`settings-tab-${id}`}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left type-body text-text-secondary transition-colors duration-(--semantic-motion-duration-fast) data-[state=active]:bg-(--semantic-color-surface-selected) data-[state=active]:font-medium data-[state=active]:text-text-primary state-layer focus-ring">
                  <Icon size={15} aria-hidden="true" className="shrink-0" /><span className="truncate">{label}</span>
                </Tabs.Trigger>
              ); })}
            </Tabs.List>
          </div>
          <div className="scroll min-w-0 flex-1 p-6 pr-14">
            <Tabs.Content value="usage" className="outline-none" data-testid="usage">
              <h3 className="type-heading3 font-medium">本月用量</h3>
              <p className="mt-1 type-label text-text-secondary">只作记录，没有上限——花的是你自己的 Key 或订阅。交给本机 agent 的作业不计入。</p>
              {usageError ? (
                <p role="alert" className="mt-3 flex items-center justify-between gap-2 rounded-md border border-error/60 bg-error/10 px-3 py-2 type-label text-error"><span>用量加载失败</span><Button size="sm" onClick={load}>重试</Button></p>
              ) : !usage ? <div className="h-20"><Spinner /></div> : (
                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-3 gap-3" data-testid="usage-totals">
                    <Stat label="生成屏数" value={fmt(usage.screens)} />
                    <Stat label="输入 token" value={fmt(usage.tokensIn)} />
                    <Stat label="输出 token" value={fmt(usage.tokensOut)} />
                  </dl>
                  {usage.inflight.calls > 0 && <p className="type-label text-text-secondary">进行中：预计 {usage.inflight.calls} 次调用 · {usage.inflight.screens} 屏（完成后计入）</p>}
                  {usage.byDriver.length > 0 && (
                    <table className="w-full type-label" data-testid="usage-by-driver">
                      <caption className="sr-only">按通道分列的用量</caption>
                      <thead><tr className="text-left text-text-secondary"><th className="py-1 font-normal">通道</th><th className="py-1 text-right font-normal">屏</th><th className="py-1 text-right font-normal">输入</th><th className="py-1 text-right font-normal">输出</th></tr></thead>
                      <tbody className="divide-y divide-border-subtle">
                        {usage.byDriver.map((d) => (
                          <tr key={`${d.driver}:${d.model}`}>
                            <td className="py-1.5"><span className="font-medium">{DRIVER_LABEL[d.driver] ?? d.driver}</span> <span className="text-text-secondary">{d.model}</span></td>
                            <td className="py-1.5 text-right tabular-nums">{fmt(d.screens)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensIn)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensOut)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="type-label text-text-secondary">{usage.month} 月，UTC 月初清零重新计。</p>
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content value="runners" className="outline-none" data-testid="runners">
              <ChannelManager onCatalog={onCatalog} />
              {/* 反向接入（API-AGENT-002）：本机 agent 自己连 Quilt 的 MCP，本地版免鉴权 */}
              <h3 className="mt-8 type-heading3 font-medium">让本机 agent 接入 Quilt（MCP）</h3>
              <p className="mt-1 type-label text-text-secondary">在 Claude Code / Codex / Cursor 里接入 Quilt，本地版不需要授权。Codex 接入后要新开或重开线程才会加载；想让画布投来的作业不用逐个批准，在 <code className="font-mono">~/.codex/config.toml</code> 的 <code className="font-mono">[mcp_servers.quilt]</code> 下加 <code className="font-mono">default_tools_approval_mode = "approve"</code>：</p>
              <div className="mt-2 flex items-center gap-2"><code className="flex-1 truncate rounded-md border border-border-subtle bg-(--semantic-color-surface-sunken) px-2 py-1.5 font-mono type-label" data-testid="mcp-add">{mcpAdd}</code><Button size="sm" aria-label="复制 Claude Code 接入命令" onClick={() => copy(mcpAdd)}>复制</Button></div>
              <div className="mt-2 flex items-center gap-2"><code className="flex-1 truncate rounded-md border border-border-subtle bg-(--semantic-color-surface-sunken) px-2 py-1.5 font-mono type-label" data-testid="codex-mcp-add">{codexMcpAdd}</code><Button size="sm" aria-label="复制 Codex 接入命令" onClick={() => copy(codexMcpAdd)}>复制</Button></div>
            </Tabs.Content>

            <Tabs.Content value="appearance" className="outline-none" data-testid="appearance">
              <Appearance />
            </Tabs.Content>
          </div>
        </Tabs.Root>
        <div className="absolute right-3 top-3"><IconButton label="关闭" hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton></div>
      </div>
    </Overlay>
  );
}

// 外观（REQ-CORE-039）：三选一，选中即生效、不用保存；只换 Quilt 自己的界面
const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];
function Appearance() {
  const [pref, setPref] = useState(readThemePref);
  const mode = useResolvedMode();
  const pick = (next: ThemePref) => { setPref(next); setThemePref(next); };
  return (
    <>
      <h3 className="type-heading3 font-medium">外观</h3>
      <p className="mt-1 type-label text-text-secondary">只换 Quilt 自己的界面；画布上的屏和卡片的白底不变。选择记在这台电脑的浏览器里，对所有项目生效。</p>
      <fieldset className="mt-4 grid max-w-sm gap-1.5" data-testid="theme-options">
        <legend className="sr-only">外观</legend>
        {THEME_OPTIONS.map((o) => (
          <label key={o.id} data-testid={`theme-${o.id}`}
            className={`state-layer is-field focus-ring flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 type-body ${pref === o.id ? 'border-primary bg-(--semantic-color-surface-selected) text-text-primary' : 'border-border-subtle text-text-secondary'}`}>
            <input type="radio" name="theme" value={o.id} checked={pref === o.id} onChange={() => pick(o.id)} className="size-4 accent-primary outline-none" />
            <span className="flex-1">{o.label}</span>
            {o.id === 'system' && <span className="type-label text-text-secondary">现在是{mode === 'dark' ? '深色' : '浅色'}</span>}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle px-3 py-2">
      <dt className="type-caption text-text-secondary">{label}</dt>
      <dd className="mt-0.5 type-heading2 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
