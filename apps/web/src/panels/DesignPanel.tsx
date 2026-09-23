import { useEffect, useRef, useState } from 'react';
import { fontFamilySchema, fontUrlSchema, parseConventions, type FontSource, type AssetDto, type ScreenDto, type DesignSystemDto, type Tokens, type ProjectDto } from '@quilt/core';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Input, Panel, Textarea } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { AssetsSection, PaletteSection } from '@/panels/BrandSections';
import { PresetsSection } from '@/panels/PresetsSection';
import { FONTS, SYSTEM_FONTS, FONT_SOURCE_OPTIONS, RADIUS } from './designOptions';

// 设计系统面板（REQ-CORE-010 只读展示 / REQ-EDIT-003 编辑与回刷 / REQ-CORE-016 应用简介与样板屏）。
// 设计系统是唯一的持久记忆且只显式改：约定条目只经「用一句话改设计系统」→ 提炼 → 预览确认写入，这里可删不可手写。
export function DesignPanel({ ds, project, screens, assets, busy, onClose, onSaved, onApplyAll, onPropose }: { ds: DesignSystemDto; project: ProjectDto; screens: ScreenDto[]; assets: AssetDto[]; busy: boolean; onClose: () => void; onSaved: () => void; onApplyAll: () => void; onPropose: (instruction: string) => void }) {
  const toast = useToast();
  const tokens = ds.tokens as Tokens;
  const [seed, setSeed] = useState(ds.seedColor);
  const [font, setFont] = useState<string>(tokens.typography.fontFamily);
  const [fontSource, setFontSource] = useState<FontSource>(tokens.typography.fontSource ?? 'google');
  const [fontUrl, setFontUrl] = useState<string>(tokens.typography.fontUrl ?? '');
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontUrlError, setFontUrlError] = useState<string | null>(null);
  const [radius, setRadius] = useState<'sharp' | 'default' | 'round'>(RADIUS.find((r) => r.md === tokens.radius.md)?.key ?? 'default');
  const [md, setMd] = useState(ds.designMd);
  // 品牌色板（REQ-EDIT-005）：和种子 / 字体 / 圆角同属「保存后回刷」这一组，不单独走接口
  const [palette, setPalette] = useState(ds.palette);
  const [colorMode, setColorMode] = useState(ds.colorMode);
  const [saving, setSaving] = useState(false);
  const [askApply, setAskApply] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const [brief, setBrief] = useState(project.brief);
  const [savingBrief, setSavingBrief] = useState(false);
  const [instruction, setInstruction] = useState('');
  useEffect(() => { setSeed(ds.seedColor); setFont(tokens.typography.fontFamily); setFontSource(tokens.typography.fontSource ?? 'google'); setFontUrl(tokens.typography.fontUrl ?? ''); setFontError(null); setFontUrlError(null); setRadius(RADIUS.find((r) => r.md === tokens.radius.md)?.key ?? 'default'); setMd(ds.designMd); setPalette(ds.palette); setColorMode(ds.colorMode); }, [ds.id, ds.version, ds.seedColor, ds.designMd, tokens.typography.fontFamily, tokens.typography.fontSource, tokens.typography.fontUrl, tokens.radius.md]);
  useEffect(() => { setBrief(project.brief); }, [project.id, project.brief]);
  // 只有这几项会改 tokens，进而改每屏 HTML 的 prelude；designMd 只进生成 prompt，回刷它产出的是逐字节相同的新修订
  const tokenDirty = seed !== ds.seedColor || font !== tokens.typography.fontFamily || radius !== (RADIUS.find((r) => r.md === tokens.radius.md)?.key ?? 'default')
    || fontSource !== (tokens.typography.fontSource ?? 'google') || (fontSource === 'url' && fontUrl.trim() !== (tokens.typography.fontUrl ?? ''))
    || JSON.stringify(palette ?? null) !== JSON.stringify(ds.palette ?? null) || colorMode !== ds.colorMode;
  const dirty = tokenDirty || md !== ds.designMd;
  const conventions = parseConventions(ds.designMd);
  const exemplar = screens.find((s) => s.id === project.exemplarScreenId) ?? null;

  const save = async () => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(seed)) { toast('种子色格式应为 #RRGGBB', 'error'); return; }
    const family = fontFamilySchema.safeParse(font);
    if (!family.success) { setFontError('族名只能是字母、数字、空格与连字符'); return; }
    const url = fontSource === 'url' ? fontUrlSchema.safeParse(fontUrl) : null;
    if (fontSource === 'url' && !url?.success) { setFontUrlError(fontUrl.trim() ? '必须是 https 链接' : '选了自定义链接就得给样式表地址'); return; }
    setSaving(true);
    try {
      await api.designSystem.update(ds.projectId, { seedColor: seed.toUpperCase(), fontFamily: family.data, fontSource, fontUrl: url?.success ? url.data : null, radiusScale: radius, palette, colorMode, designMd: md, expectedVersion: ds.version });
      toast('设计系统已保存'); setAskApply(tokenDirty && screens.length > 0); onSaved();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '保存失败', 'error');
    } finally { setSaving(false); }
  };
  const saveBrief = async () => {
    setSavingBrief(true);
    try { await api.projects.patch(project.id, { brief: brief.trim() }); toast('应用简介已保存'); onSaved(); }
    catch { toast('保存失败', 'error'); } finally { setSavingBrief(false); }
  };
  const removeConvention = async (i: number) => {
    try { await api.designSystem.update(ds.projectId, { conventions: conventions.filter((_, k) => k !== i), expectedVersion: ds.version }); toast('已删除这条约定'); onSaved(); }
    catch (e) { toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '删除失败', 'error'); }
  };

  return (
    <Panel title="设计系统" className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        {/* 持久记忆（REQ-CORE-016）：应用简介每次生成都带；样板屏在画布上选中后用工具栏更换 */}
        <div className="space-y-1.5">
          <label htmlFor="ds-brief" className="block text-xs font-medium text-muted">应用简介（每次生成都会带上）</label>
          <Textarea id="ds-brief" data-testid="ds-brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="首轮生成后会自动写一段：这是什么 APP、给谁用、调性。可以改。" className="resize-y font-normal" />
          <div className="flex justify-end"><Button size="sm" pending={savingBrief} disabled={brief.trim() === project.brief.trim()} onClick={saveBrief}>保存简介</Button></div>
        </div>
        <div className="rounded-md border border-line px-3 py-2 text-xs" data-testid="ds-exemplar">
          <span className="text-muted">样板屏：</span>{exemplar ? <><b className="text-fg">{exemplar.name}</b> <span className="text-muted">{exemplar.route}</span></> : <span className="text-muted">还没有（首轮生成后默认第 1 屏）</span>}
          <p className="mt-0.5 text-muted">生成和修改时都以它为风格参照；在画布上选中一屏后用工具栏「设为样板」更换。</p>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {Object.entries(tokens.colors).map(([k, v]) => <div key={k} title={`${k} ${v}`} className="h-6 rounded-sm border border-line" style={{ background: v }} />)}
        </div>
        <PaletteSection tokens={tokens} palette={palette} colorMode={colorMode} savedColorMode={ds.colorMode} onChange={(next) => { setPalette(next.palette); setColorMode(next.colorMode); }} />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="ds-seed" className="block text-xs font-medium text-muted">种子色</label>
            <div className="flex items-center gap-2">
              <input id="ds-seed" type="color" value={/^#[0-9A-Fa-f]{6}$/.test(seed) ? seed : '#000000'} onChange={(e) => setSeed(e.target.value.toUpperCase())} className="h-9 w-10 cursor-pointer rounded-md border border-line bg-canvas p-1" aria-label="选择种子色" />
              <input aria-label="种子色十六进制" value={seed} onChange={(e) => setSeed(e.target.value)} className="h-9 w-full rounded-md border border-line bg-canvas px-2 font-mono text-sm" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ds-font" className="block text-xs font-medium text-muted">字体</label>
            <Input id="ds-font" data-testid="ds-font" list="ds-font-options" value={font} onChange={(e) => { setFont(e.target.value); setFontError(null); }}
              placeholder={fontSource === 'system' ? '例如 PingFang SC' : '例如 Plus Jakarta Sans'} autoComplete="off" spellCheck={false}
              aria-invalid={!!fontError} aria-describedby={fontError ? 'ds-font-error' : undefined} />
            <datalist id="ds-font-options">{(fontSource === 'system' ? SYSTEM_FONTS : FONTS).map((f) => <option key={f} value={f} />)}</datalist>
            {fontError && <p id="ds-font-error" className="text-xs text-danger" role="alert">{fontError}</p>}
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-muted">字体来源</legend>
          <div className="grid grid-cols-3 gap-2" data-testid="ds-font-source" data-value={fontSource}>
            {FONT_SOURCE_OPTIONS.map((s) => (
              <label key={s.key} className={`flex h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border px-1 text-sm ${fontSource === s.key ? 'border-accent bg-accent/10' : 'border-line text-muted hover:border-line-strong'}`}>
                <input type="radio" name="font-source" value={s.key} className="sr-only" checked={fontSource === s.key} onChange={() => { setFontSource(s.key); setFontError(null); setFontUrlError(null); }} />{s.label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">{FONT_SOURCE_OPTIONS.find((s) => s.key === fontSource)?.hint}</p>
        </fieldset>
        {fontSource === 'url' && (
          <div className="space-y-1.5">
            <label htmlFor="ds-font-url" className="block text-xs font-medium text-muted">字体样式表地址（https，含 @font-face）</label>
            <Input id="ds-font-url" data-testid="ds-font-url" value={fontUrl} onChange={(e) => { setFontUrl(e.target.value); setFontUrlError(null); }}
              placeholder="https://fonts.bunny.net/css?family=manrope:400,600" inputMode="url" autoComplete="off" spellCheck={false} className="font-mono"
              aria-invalid={!!fontUrlError} aria-describedby={fontUrlError ? 'ds-font-url-error' : undefined} />
            {fontUrlError && <p id="ds-font-url-error" className="text-xs text-danger" role="alert">{fontUrlError}</p>}
          </div>
        )}
        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-muted">圆角</legend>
          <div className="grid grid-cols-3 gap-2">
            {RADIUS.map((r) => (
              <label key={r.key} className={`flex h-9 cursor-pointer items-center justify-center rounded-md border text-sm ${radius === r.key ? 'border-accent bg-accent/10' : 'border-line text-muted hover:border-line-strong'}`}>
                <input type="radio" name="radius" value={r.key} className="sr-only" checked={radius === r.key} onChange={() => setRadius(r.key)} />{r.label}
              </label>
            ))}
          </div>
        </fieldset>
        {/* 约定（REQ-EDIT-003）：DESIGN.md 里唯一由系统维护的一节，可删不可手写 */}
        <div className="space-y-1.5">
          <div className="block text-xs font-medium text-muted">约定（跨屏生效的规则，{conventions.length} 条）</div>
          {conventions.length === 0 ? <p className="text-xs text-muted">还没有。改屏后在回执上点「记为约定」，或在下面用一句话改设计系统。</p> : (
            <ul className="flex flex-col gap-1" data-testid="ds-conventions">
              {conventions.map((c, i) => (
                <li key={i} className="flex items-start justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 leading-cn [overflow-wrap:anywhere]">{c}</span>
                  <button type="button" aria-label={`删除约定：${c}`} disabled={busy} onClick={() => removeConvention(i)} className="shrink-0 rounded-md px-1 text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1.5 border-t border-line pt-3">
          <label htmlFor="ds-instruction" className="block text-xs font-medium text-muted">用一句话改设计系统</label>
          <Textarea id="ds-instruction" data-testid="ds-instruction" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="例如：所有列表项都带头像；正文字号整体大一档" disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && instruction.trim()) { e.preventDefault(); onPropose(instruction.trim()); setInstruction(''); } }} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">先提炼成绝对规则给你预览，确认后才写入</span>
            <Button size="sm" variant="primary" data-testid="ds-propose" disabled={!instruction.trim() || busy} onClick={() => { onPropose(instruction.trim()); setInstruction(''); }}>提炼并预览</Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ds-md" className="block text-xs font-medium text-muted">DESIGN.md（进入每次生成的上下文）</label>
          <textarea id="ds-md" value={md} onChange={(e) => setMd(e.target.value)} rows={18} className="w-full resize-y rounded-md border border-line bg-canvas p-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]" />
        </div>
        <PresetsSection projectId={ds.projectId} version={ds.version} busy={busy || dirty}
          onApplied={() => { onSaved(); setAskApply(screens.length > 0); }} />
        <AssetsSection projectId={ds.projectId} items={assets} onChanged={onSaved} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>版本 {ds.version}{dirty ? ' · 有未保存改动' : ''}</span>
          <div className="flex gap-2">
            <Button ref={saveRef} size="sm" variant="primary" pending={saving} disabled={!dirty} onClick={save} data-testid="ds-save">保存</Button>
            {/* 有未保存改动时不能回刷：作业只带 screenIds，worker 用的是库里那份 tokens，
                拿旧色板给每屏出一版一模一样的新修订，回执还写「已回刷 N 屏」，用户看到的是「颜色一点没变」 */}
            <Button ref={applyRef} size="sm" pending={busy} disabled={busy || dirty} onClick={onApplyAll}
              title={dirty ? '先保存——回刷用的是已保存的那份设计系统' : '把最新设计系统应用到所有屏幕'}>回刷所有屏</Button>
          </div>
        </div>
      </div>
      {askApply && <ApplyAllDialog count={screens.length} returnTo={saveRef} fallback={applyRef} onConfirm={onApplyAll} onClose={() => setAskApply(false)} />}
    </Panel>
  );
}

// 保存后问一次「回刷所有屏？」（REQ-EDIT-005）：库里的设计系统已经新了，但每屏的 HTML 还是旧 token 烤出来的，
// 不回刷就只有以后新造的屏会变。这一问必须是弹层：面板内插一条会把用户刚点的「保存」挤走（RESP-010），
// 面板滚到底时插在下方的那一问也可能不在视野里
function ApplyAllDialog({ count, returnTo, fallback, onConfirm, onClose }: { count: number; returnTo: React.RefObject<HTMLButtonElement | null>; fallback: React.RefObject<HTMLButtonElement | null>; onConfirm: () => void; onClose: () => void }) {
  // 关掉时焦点回「保存」；但保存成功后它已变成原生 disabled，focus 会静默失败、焦点掉到 body
  // （之后按 Esc 会被画布接走去取消作业），所以兜底给「回刷所有屏」——此刻它恰好可点
  const ref = useModal<HTMLDivElement>(onClose, returnTo, fallback);
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ds-apply-title" data-testid="ds-apply-ask" tabIndex={-1}
        className="w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="ds-apply-title" className="text-sm font-semibold">回刷所有屏？</h2>
        <p className="mt-1 text-xs text-muted">现有 {count} 屏的 HTML 还是旧 token 烤出来的。回刷按新设计系统给每屏重出一版——确定性改写，不调模型；不刷就只有以后新造的屏用新设计系统。</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>以后再说</Button>
          <Button size="sm" variant="primary" data-testid="ds-apply-confirm" onClick={() => { onConfirm(); onClose(); }}>回刷 {count} 屏</Button>
        </div>
      </div>
    </Overlay>
  );
}
