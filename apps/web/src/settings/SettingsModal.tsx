import { useState } from 'react';
import { Tabs } from 'radix-ui';
import { Check, Cpu, Gauge, MonitorCog, X } from 'lucide-react';
import type { RunnerOptionDto } from '@quilt/core/browser';
import { useToast } from '@/lib/toast';
import { Button, IconButton, cn } from '@/ui/ui';
import { ChannelManager } from '@/settings/ChannelManager';
import { UsageSection, useUsageStats } from '@/settings/UsageSection';
import { RecordSection } from '@/settings/RecordSection';
import { Overlay, useModal } from '@/ui/modal';
import { SETTINGS_SECTIONS, type SettingsSection } from '@/settings/sections';
import { readThemePref, setThemePref, useResolvedMode, type ThemePref } from '@/lib/theme';
import { Trans } from 'react-i18next';
import { setLocale, useLocale, useT, type Locale } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import commonMessages from '@/i18n/locales/common';
import { copyText } from '@/lib/copy';
import { CollabSettings } from '@/collab/CollabSettings';
import collabMessages from '@/i18n/locales/collab';

// 设置弹层（§13 设置弹层，v1.24 用量 / 模型 / 系统三节）：左栏分节、右栏只放当前节。分节即视图标识（INT-020）——进 URL 的 ?settings=<id>，读写在 sections.ts。
const SECTION_ICONS = { usage: Gauge, models: Cpu, system: MonitorCog } as const;

export function SettingsModal({ section, onSection, onClose, returnTo, onCatalog }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void; returnTo?: React.RefObject<HTMLElement | null>; onCatalog?: (items: RunnerOptionDto[], defaultId: string) => void }) {
  const toast = useToast();
  const t = useT(settingsMessages);
  const tk = useT(collabMessages);
  const tc = useT(commonMessages);
  // 长内容弹层：初始焦点落容器（A11Y-004 ③），Tab 再进左栏当前节 → 右栏内容 → 关闭
  const ref = useModal<HTMLDivElement>(onClose, returnTo, undefined, { initialFocus: 'self' });
  // 用量的数据与范围放在弹层这一级：换节再回来不重取，读取失败的「重试」还在（FLOW-USAGE S2）
  const usage = useUsageStats();
  const copy = async (text: string) => { try { await copyText(text); toast(t('mcp.copied')); } catch { toast(t('mcp.copyFailed'), 'error'); } };
  // MCP 接入命令（API-AGENT-002）：本地版免鉴权，地址就是本机 API；Codex 一条另给（v0.68），接入后要新开线程才加载
  const mcpUrl = `${window.location.origin.replace(/:6688$/, ':3100')}/mcp`;
  const mcpAdd = `claude mcp add --transport http quilt ${mcpUrl}`;
  const codexMcpAdd = `codex mcp add quilt --url ${mcpUrl}`;
  // 换节时右栏内容淡入并上移 4 px（150 ms，.settings-in）；Radix 只挂当前节，换节即重新挂载、动画重放
  const pane = 'settings-in outline-none';

  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal" tabIndex={-1}
        className="settings-sheet sheet relative flex h-[min(42rem,calc(100dvh-2rem))] w-full max-w-4xl overflow-hidden fade-up outline-none">
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
            <Tabs.Content value="usage" className={pane} data-testid="usage">
              <UsageSection state={usage} />
            </Tabs.Content>

            <Tabs.Content value="models" className={pane} data-testid="models">
              <ChannelManager onCatalog={onCatalog} />
              {/* 反向接入（API-AGENT-002）：本机 agent 自己连 Quilt 的 MCP，本地版免鉴权 */}
              <h3 className="mt-10 type-heading3 font-semibold">{t('mcp.title')}</h3>
              <p className="mt-1 type-label leading-(--semantic-typography-body-line-height) text-text-secondary"><Trans ns={settingsMessages.ns} i18nKey="mcp.hint" components={{ code: <code className="font-mono" /> }} /></p>
              <div className="mt-3 flex items-center gap-2"><code className="fill flex-1 truncate rounded-md px-3 py-2 font-mono type-label" data-testid="mcp-add">{mcpAdd}</code><Button size="sm" aria-label={t('mcp.copyClaude')} onClick={() => copy(mcpAdd)}>{tc('copy')}</Button></div>
              <div className="mt-2 flex items-center gap-2"><code className="fill flex-1 truncate rounded-md px-3 py-2 font-mono type-label" data-testid="codex-mcp-add">{codexMcpAdd}</code><Button size="sm" aria-label={t('mcp.copyCodex')} onClick={() => copy(codexMcpAdd)}>{tc('copy')}</Button></div>
            </Tabs.Content>

            {/* 系统：外观、语言、协作、使用记录四组，各一个小标题，从上到下排；组间一道发丝线 */}
            <Tabs.Content value="system" className={pane} data-testid="system">
              <h3 className="type-heading3 font-semibold">{t('sections.system')}</h3>
              <Group id="system-appearance" title={t('system.appearance')} testId="appearance" first><Appearance legend={t('system.appearance')} /></Group>
              <Group id="system-language" title={t('system.language')} testId="language"><Language legend={t('system.language')} /></Group>
              <Group id="system-collab" title={tk('settings.title')} testId="collab"><CollabSettings /></Group>
              <Group id="system-record" title={t('system.record')} testId="record"><RecordSection titleId="system-record" /></Group>
            </Tabs.Content>
          </div>
        </Tabs.Root>
        <div className="absolute right-3 top-3"><IconButton label={tc('close')} hint="Esc" size="xs" onClick={onClose}><X size={16} /></IconButton></div>
      </div>
    </Overlay>
  );
}

function Group({ id, title, testId, first, children }: { id: string; title: string; testId: string; first?: boolean; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={cn(first ? 'mt-4' : 'mt-6 border-t border-border-subtle pt-6')}>
      <h4 id={id} className="type-body font-semibold">{title}</h4>
      {children}
    </section>
  );
}

// 外观（REQ-CORE-039）：三选一，选中即生效、不用保存；只换 Quilt 自己的界面。选项名在 settings 命名空间的 appearance.<id>
const THEME_OPTIONS: ThemePref[] = ['system', 'light', 'dark'];
function Appearance({ legend }: { legend: string }) {
  const t = useT(settingsMessages);
  const [pref, setPref] = useState(readThemePref);
  const mode = useResolvedMode();
  const pick = (next: ThemePref) => { setPref(next); setThemePref(next); };
  return (
    <>
      <p className="mt-1 type-label text-text-secondary">{t('appearance.hint')}</p>
      {/* iOS 单选列表：行间发丝线从文字起点内缩，选中项右侧一枚苹果蓝对勾；原生单选框只给读屏与方向键，不显形 */}
      <fieldset className="mt-3 max-w-sm" data-testid="theme-options">
        <legend className="sr-only">{legend}</legend>
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
function Language({ legend }: { legend: string }) {
  const t = useT(settingsMessages);
  const locale = useLocale();
  return (
    <>
      <p className="mt-1 type-label text-text-secondary">{t('language.hint')}</p>
      {/* 与「外观」同一种 iOS 单选列表 */}
      <fieldset className="mt-3 max-w-sm" data-testid="locale-options">
        <legend className="sr-only">{legend}</legend>
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
