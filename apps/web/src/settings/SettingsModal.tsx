import { useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';
import { Cable, Check, Gauge, Languages, SunMoon, X } from 'lucide-react';
import type { RunnerOptionDto, UsageDto } from '@quilt/core/browser';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, IconButton, Spinner, cn } from '@/ui/ui';
import { ChannelManager } from '@/settings/ChannelManager';
import { Overlay, useModal } from '@/ui/modal';
import { SETTINGS_SECTIONS, type SettingsSection } from '@/settings/sections';
import { readThemePref, setThemePref, useResolvedMode, type ThemePref } from '@/lib/theme';
import { Trans } from 'react-i18next';
import { intlLocale, setLocale, useLocale, useT, type Locale } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import commonMessages from '@/i18n/locales/common';

// 设置弹层（§13 导航 v0.29 / v0.32 本地版，v1.08 加「外观」、v1.20 加「语言」共四节）：左栏分节、右栏只放当前节。分节即视图标识（INT-020）——进 URL 的 ?settings=<id>，由画布页读写。
// 分节表在 sections.ts：画布页要在首屏判断 URL，而本弹层按需加载
const SECTION_ICONS = { usage: Gauge, runners: Cable, appearance: SunMoon, language: Languages } as const;

// 用量表的 driver → settings 命名空间 drivers.<键>；不在表里的原样显示 driver
const DRIVER_KEY: Record<string, 'agentSdk' | 'codex' | 'anthropic' | 'gemini' | 'openai' | 'stub'> = { 'agent-sdk': 'agentSdk', codex: 'codex', anthropic: 'anthropic', gemini: 'gemini', openai: 'openai', stub: 'stub' };
const fmt = (n: number) => n.toLocaleString(intlLocale());

export function SettingsModal({ section, onSection, onClose, returnTo, onCatalog }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void; returnTo?: React.RefObject<HTMLElement | null>; onCatalog?: (items: RunnerOptionDto[], defaultId: string) => void }) {
  const toast = useToast();
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
  // 长内容弹层：初始焦点落容器（A11Y-004 ③），Tab 再进左栏当前节 → 右栏内容 → 关闭
  const ref = useModal<HTMLDivElement>(onClose, returnTo, undefined, { initialFocus: 'self' });
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const [usageError, setUsageError] = useState(false);
  const load = () => { setUsageError(false); api.usage().then(setUsage).catch(() => setUsageError(true)); };
  useEffect(load, []);
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast(t('mcp.copied')); } catch { toast(t('mcp.copyFailed'), 'error'); } };
  // MCP 接入命令（API-AGENT-002）：本地版免鉴权，地址就是本机 API；Codex 一条另给（v0.68），接入后要新开线程才加载
  const mcpUrl = `${window.location.origin.replace(/:6688$/, ':3100')}/mcp`;
  const mcpAdd = `claude mcp add --transport http quilt ${mcpUrl}`;
  const codexMcpAdd = `codex mcp add quilt --url ${mcpUrl}`;

  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal" tabIndex={-1}
        className="sheet relative flex h-[min(42rem,calc(100dvh-2rem))] w-full max-w-4xl overflow-hidden fade-up outline-none">
        {/* Radix Tabs 垂直方向（INT-002）：左栏整组只占一个 Tab 停靠点，上下方向键换节并立即切换 */}
        <Tabs.Root value={section} onValueChange={(v) => onSection(v as SettingsSection)} orientation="vertical" className="flex min-h-0 flex-1">
          <div className="flex w-48 shrink-0 flex-col border-r border-border-subtle p-3">
            <h2 id="settings-title" className="px-2.5 pb-3 pt-1.5 type-heading2 font-semibold">{t('title')}</h2>
            <Tabs.List aria-label={t('sectionsLabel')} className="scroll-nav flex min-h-0 flex-1 flex-col gap-0.5">
              {SETTINGS_SECTIONS.map((id) => { const Icon = SECTION_ICONS[id]; return (
                <Tabs.Trigger key={id} value={id} data-testid={`settings-tab-${id}`}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left type-body text-text-secondary transition-colors duration-(--semantic-motion-duration-fast) data-[state=active]:bg-(--semantic-color-surface-selected) data-[state=active]:font-medium data-[state=active]:text-text-primary state-layer focus-ring">
                  <Icon size={15} aria-hidden="true" className="shrink-0" /><span className="truncate">{t(`sections.${id}`)}</span>
                </Tabs.Trigger>
              ); })}
            </Tabs.List>
          </div>
          <div className="scroll min-w-0 flex-1 p-6 pr-14">
            <Tabs.Content value="usage" className="outline-none" data-testid="usage">
              <h3 className="type-heading3 font-semibold">{t('sections.usage')}</h3>
              <p className="mt-1 type-label text-text-secondary">{t('usage.hint')}</p>
              {usageError ? (
                <p role="alert" className="tint-error mt-3 flex items-center justify-between gap-2 rounded-md px-3 py-2 type-label"><span>{t('usage.loadFailed')}</span><Button size="sm" onClick={load}>{tc('retry')}</Button></p>
              ) : !usage ? <div className="h-20"><Spinner /></div> : (
                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-3 gap-3" data-testid="usage-totals">
                    <Stat label={t('usage.screens')} value={fmt(usage.screens)} />
                    <Stat label={t('usage.tokensIn')} value={fmt(usage.tokensIn)} />
                    <Stat label={t('usage.tokensOut')} value={fmt(usage.tokensOut)} />
                  </dl>
                  {usage.inflight.calls > 0 && <p className="type-label text-text-secondary">{t('usage.inflight', { calls: usage.inflight.calls, screens: usage.inflight.screens })}</p>}
                  {usage.byDriver.length > 0 && (
                    <table className="w-full type-label" data-testid="usage-by-driver">
                      <caption className="sr-only">{t('usage.byDriverCaption')}</caption>
                      <thead><tr className="text-left text-text-secondary"><th className="py-1 font-normal">{t('usage.colChannel')}</th><th className="py-1 text-right font-normal">{t('usage.colScreens')}</th><th className="py-1 text-right font-normal">{t('usage.colIn')}</th><th className="py-1 text-right font-normal">{t('usage.colOut')}</th></tr></thead>
                      <tbody className="divide-y divide-border-subtle">
                        {usage.byDriver.map((d) => (
                          <tr key={`${d.driver}:${d.model}`}>
                            <td className="py-1.5"><span className="font-medium">{DRIVER_KEY[d.driver] ? t(`drivers.${DRIVER_KEY[d.driver]}`) : d.driver}</span> <span className="text-text-secondary">{d.model}</span></td>
                            <td className="py-1.5 text-right tabular-nums">{fmt(d.screens)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensIn)}</td><td className="py-1.5 text-right tabular-nums">{fmt(d.tokensOut)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="type-label text-text-secondary">{t('usage.month', { month: usage.month })}</p>
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content value="runners" className="outline-none" data-testid="runners">
              <ChannelManager onCatalog={onCatalog} />
              {/* 反向接入（API-AGENT-002）：本机 agent 自己连 Quilt 的 MCP，本地版免鉴权 */}
              <h3 className="mt-8 type-heading3 font-semibold">{t('mcp.title')}</h3>
              <p className="mt-1 type-label text-text-secondary"><Trans ns={settingsMessages.ns} i18nKey="mcp.hint" components={{ code: <code className="font-mono" /> }} /></p>
              <div className="mt-2 flex items-center gap-2"><code className="fill flex-1 truncate rounded-md px-3 py-2 font-mono type-label" data-testid="mcp-add">{mcpAdd}</code><Button size="sm" aria-label={t('mcp.copyClaude')} onClick={() => copy(mcpAdd)}>{tc('copy')}</Button></div>
              <div className="mt-2 flex items-center gap-2"><code className="fill flex-1 truncate rounded-md px-3 py-2 font-mono type-label" data-testid="codex-mcp-add">{codexMcpAdd}</code><Button size="sm" aria-label={t('mcp.copyCodex')} onClick={() => copy(codexMcpAdd)}>{tc('copy')}</Button></div>
            </Tabs.Content>

            <Tabs.Content value="appearance" className="outline-none" data-testid="appearance">
              <Appearance />
            </Tabs.Content>

            <Tabs.Content value="language" className="outline-none" data-testid="language">
              <Language />
            </Tabs.Content>
          </div>
        </Tabs.Root>
        <div className="absolute right-3 top-3"><IconButton label={tc('close')} hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton></div>
      </div>
    </Overlay>
  );
}

// 外观（REQ-CORE-039）：三选一，选中即生效、不用保存；只换 Quilt 自己的界面。选项名在 settings 命名空间的 appearance.<id>
const THEME_OPTIONS: ThemePref[] = ['system', 'light', 'dark'];
function Appearance() {
  const t = useT(settingsMessages);
  const [pref, setPref] = useState(readThemePref);
  const mode = useResolvedMode();
  const pick = (next: ThemePref) => { setPref(next); setThemePref(next); };
  return (
    <>
      <h3 className="type-heading3 font-semibold">{t('sections.appearance')}</h3>
      <p className="mt-1 type-label text-text-secondary">{t('appearance.hint')}</p>
      {/* iOS 单选列表：行间发丝线从文字起点内缩，选中项右侧一枚苹果蓝对勾；原生单选框只给读屏与方向键，不显形 */}
      <fieldset className="mt-4 max-w-sm" data-testid="theme-options">
        <legend className="sr-only">{t('sections.appearance')}</legend>
        {THEME_OPTIONS.map((id, i) => (
          <label key={id} data-testid={`theme-${id}`} className="state-layer is-field focus-ring flex cursor-pointer rounded-md px-3 type-body text-text-primary">
            <input type="radio" name="theme" value={id} checked={pref === id} onChange={() => pick(id)} className="sr-only" />
            <span className={cn('flex min-h-11 flex-1 items-center gap-3', i > 0 && 'border-t border-border-subtle')}>
              <span className="flex-1">{t(`appearance.${id}`)}</span>
              {id === 'system' && <span className="type-label text-text-secondary">{t(mode === 'dark' ? 'appearance.nowDark' : 'appearance.nowLight')}</span>}
              <Check size={16} aria-hidden="true" className={cn('shrink-0 text-(--semantic-color-action-link)', pref !== id && 'invisible')} />
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

// 语言（REQ-CORE-046）：二选一，选中即生效、不刷新页面；语言名各用自己的文字写（lang 标出来，读屏按对应语言念）
const LOCALE_OPTIONS: { id: Locale; label: string; lang: string }[] = [
  { id: 'zh', label: '中文', lang: 'zh-CN' },
  { id: 'en', label: 'English', lang: 'en' },
];
function Language() {
  const t = useT(settingsMessages);
  const locale = useLocale();
  return (
    <>
      <h3 className="type-heading3 font-semibold">{t('language.title')}</h3>
      <p className="mt-1 type-label text-text-secondary">{t('language.hint')}</p>
      {/* 与「外观」同一种 iOS 单选列表 */}
      <fieldset className="mt-4 max-w-sm" data-testid="locale-options">
        <legend className="sr-only">{t('language.title')}</legend>
        {LOCALE_OPTIONS.map((o, i) => (
          <label key={o.id} data-testid={`locale-${o.id}`} className="state-layer is-field focus-ring flex cursor-pointer rounded-md px-3 type-body text-text-primary">
            <input type="radio" name="locale" value={o.id} checked={locale === o.id} onChange={() => setLocale(o.id)} className="sr-only" />
            <span className={cn('flex min-h-11 flex-1 items-center gap-3', i > 0 && 'border-t border-border-subtle')}>
              <span lang={o.lang} className="flex-1">{o.label}</span>
              <Check size={16} aria-hidden="true" className={cn('shrink-0 text-(--semantic-color-action-link)', locale !== o.id && 'invisible')} />
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="fill rounded-md px-3 py-2">
      <dt className="type-caption text-text-secondary">{label}</dt>
      <dd className="mt-0.5 type-heading2 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
