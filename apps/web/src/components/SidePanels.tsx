import { useEffect, useRef, useState } from 'react';
import { FONT_FAMILIES, fontFamilySchema, fontUrlSchema, parseConventions, type FontSource, type AssetDto, type RevisionDto, type ScreenDto, type DesignSystemDto, type Tokens, type AnnotationDto, type ProjectDto, type DesignProposalDto, type RunnerOptionDto, type AgentSessionDto, type Runner } from '@quilt/core';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { Button, EmptyState, Input, Panel, Spinner, Textarea } from './ui';
import { Select } from './Select';
import { RunnerSelect, SessionSelect } from './Composer';
import { Overlay, useModal } from './modal';
import { AssetsSection, PaletteSection } from './BrandSections';
import { PresetsSection } from './PresetsSection';

// Radix Select 不接受空字符串作为选项值（空串是「未选中」的内部语义），空态用哨兵值代替
const NO_LINK = '__none__';
export { EmptyState };

const SOURCE_LABEL: Record<string, string> = { generate: '生成', edit: '对话修改', subtree: '局部重生成', manual: '直改', restore: '回溯', apply_ds: '设计系统回刷', agent_ingest: 'agent 推入', component: '共享组件同步' };

// 修订面板（REQ-CORE-007 v0.31）：修订树——同批候选折成一组（未选用的可随时采用），其余按 seq 倒序并标出派生自哪一版。回溯仍是建新修订。
export function RevisionPanel({ screen, onClose, onRestored }: { screen: ScreenDto; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<RevisionDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.screens.revisions(screen.id).then((r) => setItems(r.items)).catch(() => toast('修订列表加载失败', 'error'));
  useEffect(() => { setItems(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [screen.id, screen.currentRevisionId]);

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast('屏幕已被更新，请刷新后重试', 'error');
    else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中，稍后再试', 'error');
    else toast(fallback, 'error');
  };
  const restore = async (rev: RevisionDto) => {
    if (!screen.currentRevisionId) return;
    setBusy(rev.id);
    try { await api.screens.restore(screen.id, rev.id, screen.currentRevisionId); toast(`已回溯到第 ${rev.seq} 版`); onRestored(); }
    catch (e) { fail(e, '回溯失败'); } finally { setBusy(null); }
  };
  const adopt = async (rev: RevisionDto) => {
    setBusy(rev.id);
    try { await api.screens.adopt(screen.id, rev.id); toast(`已采用候选第 ${(rev.candidateIndex ?? 0) + 1} 版`); onRestored(); }
    catch (e) { fail(e, '采用失败'); } finally { setBusy(null); }
  };

  // 分组：同 jobId 的候选折成一组，其余单独成项；按组内最大 seq 倒序排
  type Group = { key: string; jobId: string | null; revs: RevisionDto[] };
  const groups: Group[] = [];
  for (const r of items ?? []) {
    if (r.candidateIndex !== null && r.jobId) {
      const g = groups.find((x) => x.jobId === r.jobId);
      if (g) { g.revs.push(r); continue; }
      groups.push({ key: `job:${r.jobId}`, jobId: r.jobId, revs: [r] });
    } else groups.push({ key: r.id, jobId: null, revs: [r] });
  }
  const seqOf = (id: string | null) => items?.find((r) => r.id === id)?.seq;

  const row = (r: RevisionDto, inGroup: boolean) => {
    const current = r.id === screen.currentRevisionId;
    const settled = !!r.candidateSettledAt;
    const label = inGroup ? `第 ${(r.candidateIndex ?? 0) + 1} 版（seq ${r.seq}）` : `第 ${r.seq} 版`;
    const status = current ? (inGroup && settled ? '已采用' : '当前') : inGroup && !settled ? '未选用' : '';
    return (
      <li key={r.id} className={`flex gap-2 rounded-md border p-2 ${current ? 'border-accent bg-accent/10' : 'border-line'}`} data-testid="revision" data-seq={r.seq} data-candidate={inGroup ? r.candidateIndex ?? undefined : undefined}>
        {r.screenshotUrl ? <img src={r.screenshotUrl} alt={label} width={44} height={Math.round((44 * screen.height) / screen.width)} loading="lazy" className="w-11 shrink-0 rounded-sm bg-white object-cover object-top" /> : <div className="w-11 shrink-0 rounded-sm bg-panel-2" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{label}{status ? `（${status}）` : ''}</span>
            <span className="text-muted">{SOURCE_LABEL[r.sourceKind] ?? r.sourceKind}</span>
          </div>
          <div className="text-[11px] text-muted">{new Date(r.createdAt).toLocaleString()}{r.parentRevisionId && seqOf(r.parentRevisionId) ? ` · 派生自第 ${seqOf(r.parentRevisionId)} 版` : ''}</div>
          {!current && inGroup && !settled && <Button size="sm" className="mt-1.5" data-testid="adopt-revision" pending={busy === r.id} onClick={() => adopt(r)}>采用</Button>}
          {!current && (!inGroup || settled) && <Button size="sm" className="mt-1.5" pending={busy === r.id} onClick={() => restore(r)}>回溯到此版</Button>}
        </div>
      </li>
    );
  };

  return (
    <Panel title={`修订 · ${screen.name}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      {items === null ? <Spinner /> : items.length === 0 ? <EmptyState title="还没有修订" hint="生成完成后会出现在这里" /> : (
        <ul className="scroll flex flex-1 flex-col gap-2 p-2">
          {groups.map((g) => g.jobId ? (
            <li key={g.key} className="rounded-lg border border-dashed border-line p-1.5" data-testid="candidate-group" data-job={g.jobId}>
              <div className="px-1 pb-1.5 text-[11px] text-muted">候选 · 作业 {g.jobId.slice(0, 8)} · {g.revs.length} 版{g.revs.every((r) => r.candidateSettledAt) ? ' · 已采用' : ' · 待采用'}</div>
              <ul className="flex flex-col gap-1.5">{[...g.revs].sort((a, b) => (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0)).map((r) => row(r, true))}</ul>
            </li>
          ) : row(g.revs[0], false))}
        </ul>
      )}
    </Panel>
  );
}

const FONTS = FONT_FAMILIES;
// 字体来源（v0.44）：族名是自由文本，两份候选只是输入框的 datalist 提示
const SYSTEM_FONTS = ['-apple-system', 'PingFang SC', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei', 'system-ui'];
const FONT_SOURCE_OPTIONS: { key: FontSource; label: string; hint: string }[] = [
  { key: 'google', label: 'Google', hint: '任意 Google Fonts 族名，预览与导出自动加载' },
  { key: 'system', label: '本机字体', hint: '用这台电脑装的字体，不发外链；换机器观感可能不同' },
  { key: 'url', label: '自定义链接', hint: '自托管或 CDN 上带 @font-face 的样式表' },
];
const RADIUS: { key: 'sharp' | 'default' | 'round'; label: string; md: string }[] = [{ key: 'sharp', label: '锐利', md: '4px' }, { key: 'default', label: '默认', md: '12px' }, { key: 'round', label: '圆润', md: '18px' }];

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

// 设计系统提案预览（REQ-EDIT-003）：提炼出来的绝对规则逐条可取消、token 变更前后对比；确认才写入；
// 写入后按提案的 regenerate 问要不要按新约定重生成所有屏（只改 token 就直接回刷）。
export function ProposalDialog({ proposal, ds, busy, onConfirm, onClose }: {
  proposal: DesignProposalDto; ds: DesignSystemDto; busy: boolean;
  onConfirm: (choice: { conventions: string[]; tokens: DesignProposalDto['tokens']; regenerate: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useModal<HTMLDivElement>(onClose, undefined, undefined, { initialFocus: 'self' });
  const tokens = ds.tokens as Tokens;
  const existing = parseConventions(ds.designMd);
  const [keep, setKeep] = useState<boolean[]>(() => proposal.conventions.map(() => true));
  const [step, setStep] = useState<'preview' | 'regenerate'>('preview');
  const [pending, setPending] = useState(false);
  const chosen = proposal.conventions.filter((_, i) => keep[i]);
  const t = proposal.tokens ?? {};
  const tokenRows: { label: string; from: string; to: string }[] = [];
  if (t.seedColor) tokenRows.push({ label: '种子色', from: ds.seedColor, to: t.seedColor });
  if (t.fontFamily) tokenRows.push({ label: '字体', from: tokens.typography.fontFamily, to: t.fontFamily });
  if (t.radiusScale) tokenRows.push({ label: '圆角', from: RADIUS.find((r) => r.md === tokens.radius.md)?.label ?? '默认', to: RADIUS.find((r) => r.key === t.radiusScale)?.label ?? t.radiusScale });
  const conventionsChanged = JSON.stringify(chosen) !== JSON.stringify(existing);
  const nothing = !conventionsChanged && tokenRows.length === 0;
  const commit = async (regenerate: boolean) => {
    setPending(true);
    try { await onConfirm({ conventions: chosen, tokens: tokenRows.length ? t : undefined, regenerate }); } finally { setPending(false); }
  };
  const confirm = () => {
    // 改了约定才有「重生成」这一问；只改 token 走确定性回刷（onConfirm 里处理）
    if (proposal.regenerate && conventionsChanged) setStep('regenerate'); else commit(false);
  };
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dsp-title" data-testid="ds-proposal" tabIndex={-1} className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl fade-up outline-none">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 id="dsp-title" className="text-sm font-semibold">{step === 'preview' ? '写入设计系统？' : '按新约定重生成所有屏？'}</h2>
          {proposal.summary && step === 'preview' && <p className="mt-1 text-xs text-muted">{proposal.summary}</p>}
        </header>
        {step === 'preview' ? (
          <div className="scroll min-h-0 flex-1 space-y-4 p-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">约定（写入后的完整清单，取消勾选的不写）</div>
              {proposal.conventions.length === 0 ? <p className="text-xs text-muted">这条指令没有提炼出跨屏规则。</p> : (
                <ul className="flex flex-col gap-1">
                  {proposal.conventions.map((c, i) => {
                    const isNew = !existing.includes(c);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <input id={`dsp-c-${i}`} type="checkbox" checked={keep[i]} onChange={(e) => setKeep((k) => k.map((v, j) => (j === i ? e.target.checked : v)))} className="mt-0.5 size-3.5 accent-accent" />
                        <label htmlFor={`dsp-c-${i}`} className="min-w-0 flex-1 leading-cn [overflow-wrap:anywhere]">{c}{isNew && <span className="ml-1 rounded-full bg-accent/15 px-1.5 text-[10px] text-accent-strong">新</span>}</label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {existing.filter((c) => !proposal.conventions.includes(c)).length > 0 && (
                <p className="mt-1.5 text-[11px] text-muted">将移除：{existing.filter((c) => !proposal.conventions.includes(c)).join('；')}</p>
              )}
            </div>
            {tokenRows.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">token 变更</div>
                <ul className="flex flex-col gap-1 text-xs">
                  {tokenRows.map((r) => (
                    <li key={r.label} className="flex items-center gap-2">
                      <span className="w-12 text-muted">{r.label}</span>
                      {r.label === '种子色' ? <><span className="inline-block size-4 rounded-sm border border-line" style={{ background: r.from }} /><span>{r.from}</span><span className="text-muted">→</span><span className="inline-block size-4 rounded-sm border border-line" style={{ background: r.to }} /><span>{r.to}</span></> : <><span>{r.from}</span><span className="text-muted">→</span><span>{r.to}</span></>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-xs text-muted">约定已写入。现有屏还是老样子——重生成会对每一屏跑一次模型（按屏计费），不重生成则只对以后新造的屏生效。</div>
        )}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
          {step === 'preview' ? (
            <>
              <Button size="sm" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" data-testid="ds-proposal-confirm" pending={pending} disabled={nothing || busy} onClick={confirm}>确认写入</Button>
            </>
          ) : (
            <>
              <Button size="sm" data-testid="ds-proposal-write-only" pending={pending} onClick={() => commit(false)}>只写入</Button>
              <Button size="sm" variant="primary" data-testid="ds-proposal-regenerate" pending={pending} disabled={busy} onClick={() => commit(true)}>重生成所有屏</Button>
            </>
          )}
        </footer>
      </div>
    </Overlay>
  );
}

// 元素检查器（REQ-EDIT-001 / REQ-EDIT-002）：本地直改零 token；AI 只重生成选中子树。
// component（REQ-EDIT-006）：元素所在的共享组件名——在组件里的元素不直改，给「改组件 / 脱离共享」两个出口
export type ElementSel = { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; rect: { x: number; y: number; w: number; h: number } };
const SUBTREE_RUNNER_KEY = 'quilt:runner:subtree';
const SUBTREE_SESSION_KEY = 'quilt:agent-session:subtree';
// 「记为共享组件」的默认名：按元素标签给个常见叫法，用户可改
const COMPONENT_NAME_BY_TAG: Record<string, string> = { nav: 'TabBar', header: 'AppBar', aside: 'Sidebar', footer: 'Footer' };
export function InspectorPanel({ screen, sel, routes, busy, runners, composerRunnerId, sessions, onSessionsOpen, workingQids, onClose, onEdited, onRegenerate, onEditComponent }: { screen: ScreenDto; sel: ElementSel | null; routes: string[]; busy: boolean; runners: RunnerOptionDto[]; composerRunnerId: string; sessions: AgentSessionDto[] | null; onSessionsOpen: () => void; workingQids: string[]; onClose: () => void; onEdited: (qid: string) => void; onRegenerate: (qid: string, prompt: string, runner: Runner | undefined) => Promise<boolean>; onEditComponent: (name: string) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [classes, setClasses] = useState('');
  const [link, setLink] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  // 记为共享组件（REQ-EDIT-006）：内联表单，名字 + 要不要同步替换其他屏里对应的元素
  const [making, setMaking] = useState(false);
  const [compName, setCompName] = useState('');
  const [compApply, setCompApply] = useState(true);
  const [compError, setCompError] = useState<string | null>(null);
  const [compBusy, setCompBusy] = useState(false);
  // 子树重生成的通道（REQ-EDIT-002）：与输入框同一套选择器，但记忆独立——局部改动常只要更快的模型；第一次沿用输入框当前通道（INT-007 / INT-021）
  const [runnerPick, setRunnerPick] = useState(() => { try { return localStorage.getItem(SUBTREE_RUNNER_KEY) ?? ''; } catch { return ''; } });
  const [sessionId, setSessionId] = useState(() => { try { return localStorage.getItem(SUBTREE_SESSION_KEY) ?? ''; } catch { return ''; } });
  const runnerId = runners.some((r) => r.id === runnerPick && r.available) ? runnerPick : composerRunnerId;
  const runnerOpt = runners.find((r) => r.id === runnerId);
  const agent = runnerOpt?.runner.kind === 'agent';
  const sessionOk = !agent || !!sessions?.some((s) => s.sessionId === sessionId);
  const openRef = useRef(onSessionsOpen);
  openRef.current = onSessionsOpen;
  useEffect(() => { if (agent) openRef.current(); }, [agent]);
  const pickRunner = (id: string) => { setRunnerPick(id); try { localStorage.setItem(SUBTREE_RUNNER_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const pickSession = (id: string) => { setSessionId(id); try { localStorage.setItem(SUBTREE_SESSION_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const runner: Runner | undefined = runnerOpt?.runner.kind === 'agent' ? { ...runnerOpt.runner, sessionId } : runnerOpt?.runner;
  // 重生成：按钮或文本框里 Shift+Enter（这里是多行说明，Enter 留给换行，与输入框的 Enter 发送不同）。
  // 发出成功只清说明框，选中不动——面板留在这个元素上；建作业被拒（屏忙等）时说明保留
  // 这块已有作业在改（本机会话投递的作业不占 busy，靠这个挡重复发起；屏锁在服务端还有一道 409）
  const working = !!sel && workingQids.includes(sel.qid);
  const canRegenerate = !!sel && !!prompt.trim() && !busy && sessionOk && !working;
  const regenerate = async () => { if (sel && canRegenerate && (await onRegenerate(sel.qid, prompt.trim(), runner))) setPrompt(''); };
  useEffect(() => { setText(sel?.text ?? ''); setClasses(sel?.classes ?? ''); setLink(sel?.href ?? ''); setPrompt(''); setMaking(false); setCompError(null); }, [sel?.qid, sel?.text, sel?.classes, sel?.href]);
  // 当前指向的路由若不在项目里（断链）也要能显示出来
  const linkOptions = link && !routes.includes(link) ? [link, ...routes] : routes;

  const apply = async (ops: Parameters<typeof api.screens.editElement>[2], okText = '已更新，截图稍后刷新') => {
    if (!sel || !screen.currentRevisionId) return;
    setSaving(true);
    try { await api.screens.editElement(screen.id, sel.qid, ops, screen.currentRevisionId); toast(okText); onEdited(sel.qid); }
    catch (e) {
      if (e instanceof ApiError && e.type === '/errors/lint-failed') toast('改动违反设计契约（只能用 token 色与预设类）', 'error');
      else if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast('屏幕已被更新，请重新选择', 'error');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中', 'error');
      // 选中时还不在组件里、保存时已经在了（别处刚把它记成了组件）：服务端兜底 409
      else if (e instanceof ApiError && e.type === '/errors/component-locked') toast('这个元素属于共享组件，改组件或先脱离共享', 'error');
      else toast('保存失败', 'error');
    } finally { setSaving(false); }
  };
  const makeComponent = async () => {
    if (!sel) return;
    const name = compName.trim();
    if (!name) { setCompError('给组件起个名字'); return; }
    setCompBusy(true); setCompError(null);
    try {
      const r = await api.components.create(screen.projectId, { name, fromScreenId: screen.id, qid: sel.qid, applyToScreens: compApply });
      toast(`已记为组件「${name}」，同步 ${r.applied.length} 屏${r.skipped.length ? `；${r.skipped.length} 屏没找到对应元素` : ''}`);
      setMaking(false);
      onEdited(sel.qid);
    } catch (e) {
      if (e instanceof ApiError && e.type === '/errors/component-name-taken') setCompError('这个名字已被占用');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') setCompError('该屏正在生成中，等它完成再记');
      else if (e instanceof ApiError && e.status === 400) setCompError((e.problem.errors as { message?: string }[] | undefined)?.[0]?.message ?? e.problem.title);
      else setCompError(e instanceof ApiError ? e.problem.title : '记为组件失败');
    } finally { setCompBusy(false); }
  };

  return (
    <Panel title={`检查器 · ${screen.name}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      {!sel ? <EmptyState title="在屏幕里点选一个元素" hint="选择模式下移动鼠标会高亮元素，点击即选中；Esc 退出交互。" /> : sel.component ? (
        // 共享组件实例里的元素（REQ-EDIT-006）：直改会在下一次写入时被组件展开顶掉，所以不给字段，只给两个出口
        <div className="scroll flex-1 space-y-4 p-3">
          <div className="text-xs text-muted">&lt;{sel.tag}&gt; · {sel.qid}</div>
          <div className="space-y-2 rounded-md border border-line bg-panel-2 p-3 text-xs" data-testid="el-component-lock" data-component={sel.component}>
            <p className="leading-cn">这是共享组件「<b className="text-fg">{sel.component}</b>」的一部分——改它会同步到所有用它的屏。</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" data-testid="el-edit-component" onClick={() => onEditComponent(sel.component!)}>改组件</Button>
              <Button size="sm" data-testid="el-detach" pending={saving} disabled={busy} onClick={() => apply([{ type: 'detach' }], '已脱离共享，这一屏的这份归屏自己管')}>脱离共享</Button>
            </div>
            <p className="text-muted">脱离后这一屏里的这份不再跟着组件变，可以单独直改。</p>
          </div>
        </div>
      ) : (
        <div className="scroll flex-1 space-y-4 p-3">
          <div className="text-xs text-muted">&lt;{sel.tag}&gt; · {sel.qid}</div>
          <div className="space-y-1.5">
            <label htmlFor="el-text" className="block text-xs font-medium text-muted">文案</label>
            <input id="el-text" value={text} onChange={(e) => setText(e.target.value)} className="h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm" placeholder="（无直接文本）" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="el-classes" className="block text-xs font-medium text-muted">类名（Tailwind，只能用 token 色）</label>
            <textarea id="el-classes" value={classes} onChange={(e) => setClasses(e.target.value)} rows={4} className="w-full resize-y rounded-md border border-line bg-canvas p-2 font-mono text-xs [overflow-wrap:anywhere]" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="el-link" className="block text-xs font-medium text-muted">跳转到（{sel.tag === 'a' ? 'href' : sel.tag === 'form' ? '提交后 action' : 'data-href'}）</label>
            <Select id="el-link" data-testid="el-link" value={link || NO_LINK} onChange={(v) => setLink(v === NO_LINK ? '' : v)} aria-label="跳转目标"
              options={[{ value: NO_LINK, label: '不跳转' }, ...linkOptions.map((r) => ({ value: r, label: r, hint: routes.includes(r) ? undefined : '断链' }))]} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" pending={saving} onClick={() => { const ops: Parameters<typeof apply>[0] = []; if (text !== sel.text) ops.push({ type: 'text', value: text }); if (classes !== sel.classes) ops.push({ type: 'classes', value: classes }); if (link !== (sel.href ?? '')) ops.push({ type: 'link', value: link || null }); if (ops.length) apply(ops); else toast('没有改动'); }}>保存（零 token）</Button>
            <Button size="sm" variant="danger" pending={saving} onClick={() => apply([{ type: 'remove' }])}>删除元素</Button>
          </div>
          {/* 记为共享组件（REQ-EDIT-006）：把这个元素存成项目级组件，其他屏里对应的元素（同标签、同层级）可一并换成它 */}
          <div className="space-y-1.5 border-t border-line pt-3">
            <div className="text-xs font-medium text-muted">记为共享组件</div>
            {!making ? (
              <>
                <p className="text-[11px] text-muted">存成项目级组件后，别的屏引用它、改一次全部同步。适合导航栏、页头这类每屏都一样的块。</p>
                <Button size="sm" data-testid="el-make-component" disabled={busy} onClick={() => { setMaking(true); setCompName(COMPONENT_NAME_BY_TAG[sel.tag] ?? 'Component'); setCompError(null); }}>记为共享组件…</Button>
              </>
            ) : (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void makeComponent(); }}>
                <label htmlFor="comp-name" className="block text-xs text-muted">组件名</label>
                <Input id="comp-name" data-testid="comp-name" value={compName} onChange={(e) => { setCompName(e.target.value); setCompError(null); }} placeholder="例如 TabBar" autoFocus autoComplete="off" spellCheck={false} maxLength={40}
                  aria-invalid={!!compError} aria-describedby={compError ? 'comp-name-error' : undefined} />
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" data-testid="comp-apply" checked={compApply} onChange={(e) => setCompApply(e.target.checked)} className="mt-0.5 size-3.5 accent-accent" />
                  <span className="leading-cn">同时替换其他屏里对应的元素（同标签、同层级）</span>
                </label>
                {compError && <p id="comp-name-error" role="alert" className="text-xs text-danger">{compError}</p>}
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" type="submit" data-testid="comp-create" pending={compBusy} disabled={!compName.trim() || busy}>记为组件</Button>
                  <Button size="sm" onClick={() => setMaking(false)}>取消</Button>
                </div>
              </form>
            )}
          </div>
          <div className="space-y-1.5 border-t border-line pt-3">
            <label htmlFor="el-prompt" className="block text-xs font-medium text-muted">用 AI 重生成这块</label>
            <textarea id="el-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-sm" placeholder="例如：改成横向滑动的卡片列表" disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void regenerate(); } }} />
            {/* 通道单独选：与输入框同一套控件；本机 agent 时还要选投给哪个会话。面板 20rem 宽，两个下拉放不下时折行 */}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="el-runner">
              {runners.length > 0 && <RunnerSelect runners={runners} value={runnerId} onChange={pickRunner} disabled={busy} testId="el-runner-select" />}
              {agent && <SessionSelect sessions={sessions} value={sessionId} onChange={pickSession} onOpen={onSessionsOpen} disabled={busy} testId="el-session-select" />}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!canRegenerate} pending={busy} onClick={() => void regenerate()}>重生成选中区域</Button>
              <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-sans text-[10px] text-muted">Shift+Enter</kbd>
            </div>
            {working && <p className="text-[11px] text-accent-strong" data-testid="el-working">这块正在修改中，回写后会标「已更新」</p>}
            {agent && !sessionOk && !working && <p className="text-[11px] text-warn">先选要投递的会话</p>}
          </div>
        </div>
      )}
    </Panel>
  );
}

// 批注面板（REQ-EDIT-004）：选中元素后写一条改动说明，可单独发也可一起发。
// 发送按屏合并成一条整屏指令——N 屏计 N 次费，而不是 N 条批注计 N 次。
export function AnnotationPanel({ screen, sel, items, busy, onClose, onAdd, onUpdate, onRemove, onSend }: {
  screen: ScreenDto; sel: ElementSel | null; items: AnnotationDto[]; busy: boolean;
  onClose: () => void; onAdd: (note: string) => Promise<void>; onUpdate: (id: string, note: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>; onSend: (ids: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { setDraft(''); }, [sel?.qid]);
  const open = items.filter((a) => a.status === 'open');
  // 共享组件里的元素不批注（REQ-EDIT-006）：批注发出去是改屏，改屏动不了组件展开的那一块
  const locked = sel?.component ?? null;

  const run = async (fn: () => Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };

  return (
    <Panel title={`批注 · ${screen.name}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        <div className="space-y-1.5">
          <label htmlFor="anno-note" className="block text-xs font-medium text-muted" data-testid="anno-target" data-qid={sel?.qid ?? ''}>
            {sel ? <>给 <code className="text-fg">&lt;{sel.tag}&gt;{sel.text ? ` 「${sel.text.slice(0, 20)}」` : ''}</code> 写一条改动说明</> : '在屏幕里点选一个元素，再写改动说明'}
          </label>
          {locked && <p className="rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs leading-cn" data-testid="anno-component-lock">这个元素属于共享组件「<b className="text-fg">{locked}</b>」，批注请改组件本身（选中画布上的组件卡后在输入框里说）。</p>}
          <textarea id="anno-note" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} disabled={!sel || !!locked}
            className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-sm text-fg placeholder:text-muted disabled:opacity-50"
            placeholder={sel && !locked ? '例如：这个按钮改成次要样式，文案换成「稍后再说」' : ''} />
          <div className="flex gap-2">
            <Button size="sm" disabled={!sel || !!locked || !draft.trim() || pending} pending={pending}
              onClick={() => run(async () => { await onAdd(draft.trim()); setDraft(''); })}>记下（不发送）</Button>
            <Button size="sm" variant="primary" disabled={!sel || !!locked || !draft.trim() || pending || busy}
              onClick={() => run(async () => { await onAdd(draft.trim()); setDraft(''); await onSend([]); })}>记下并立刻发送</Button>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted">这一屏的批注（{open.length} 条未处理）</h3>
            <Button size="sm" variant="primary" disabled={open.length === 0 || pending || busy} data-testid="send-annotations"
              onClick={() => run(() => onSend(open.map((a) => a.id)))}>一起发送</Button>
          </div>
          {items.length === 0 ? <EmptyState title="还没有批注" hint="点选元素后写下改动说明，可以攒够一起发。" /> : (
            <ul className="space-y-2">
              {items.map((a, i) => (
                <li key={a.id} className="rounded-md border border-line p-2 text-xs" data-testid="anno-item" data-status={a.status}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-fg">#{i + 1} {a.anchorText ? `「${a.anchorText.slice(0, 16)}」` : a.qid}</span>
                    <span className={a.status === 'sent' ? 'text-warn' : a.status === 'resolved' ? 'text-success' : 'text-muted'}>
                      {a.status === 'sent' ? '已发送' : a.status === 'resolved' ? '已处理' : '未处理'}
                    </span>
                  </div>
                  {editing?.id === a.id ? (
                    <div className="mt-1.5 space-y-1.5">
                      <textarea value={editing.note} onChange={(e) => setEditing({ id: a.id, note: e.target.value })} rows={3}
                        className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-xs text-fg" />
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" disabled={!editing.note.trim() || pending}
                          onClick={() => run(async () => { await onUpdate(a.id, editing.note.trim()); setEditing(null); })}>保存</Button>
                        <Button size="sm" onClick={() => setEditing(null)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{a.note}</p>
                      {a.status === 'open' && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Button size="sm" onClick={() => setEditing({ id: a.id, note: a.note })}>改写</Button>
                          <Button size="sm" disabled={pending || busy} onClick={() => run(() => onSend([a.id]))}>只发这条</Button>
                          <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => onRemove(a.id))}>删除</Button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
