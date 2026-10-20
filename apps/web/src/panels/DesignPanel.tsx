import { useEffect, useRef, useState } from 'react';
import { fontFamilySchema, fontUrlSchema, parseConventions, type AssetDto, type ScreenDto, type DesignSystemDto, type Tokens, type ProjectDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Input, Panel, Textarea } from '@/ui/ui';
import { ConfirmDialog, Overlay, useModal } from '@/ui/modal';
import { AssetsSection, PaletteSection } from '@/panels/BrandSections';
import { PresetsSection } from '@/panels/PresetsSection';
import { FONTS, SYSTEM_FONTS, FONT_SOURCE_OPTIONS, RADIUS, SWATCH_EDGE } from './designOptions';
import { SAVE_KEYS, drafts, normalized, rebase, same, sameFields, savedFields, type Fields } from './designDraft';

// 设计系统面板（REQ-CORE-010 只读展示 / REQ-EDIT-003 编辑与回刷 / REQ-CORE-016 应用简介与样板屏）。
// 设计系统是唯一的持久记忆且只显式改：约定条目只经「用一句话改设计系统」→ 提炼 → 预览确认写入，这里可删不可手写。
export function DesignPanel({ ds, project, screens, assets, busyReason, onClose, onSaved, onApplyAll, onPropose }: { ds: DesignSystemDto; project: ProjectDto; screens: ScreenDto[]; assets: AssetDto[]; busyReason: string | false; onClose: () => void; onSaved: () => void; onApplyAll: () => Promise<unknown>; onPropose: (instruction: string) => void }) {
  const toast = useToast();
  const tokens = ds.tokens as Tokens;
  const saved = savedFields(ds, project);
  // 品牌色板（REQ-EDIT-005）：和种子 / 字体 / 圆角同属「保存后回刷」这一组，不单独走接口
  const [form, setForm] = useState<Fields>(() => { const d = drafts.get(ds.projectId); return d ? rebase(d.form, d.base, saved, []) : saved; });
  const set = (patch: Partial<Fields>) => setForm((f) => ({ ...f, ...patch }));
  const { seed, font, fontSource, fontUrl, radius, md, palette, colorMode, brief } = form;
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontUrlError, setFontUrlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askApply, setAskApply] = useState(false);
  // 回刷按钮只在它自己发出的请求进行中时转圈；有别的作业在跑时不可点、就地写原因（PAGE-CANVAS「作业进行中时的面板」）
  const [applying, setApplying] = useState(false);
  const applyAll = async () => { setApplying(true); try { await onApplyAll(); } finally { setApplying(false); } };
  const saveRef = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [savingBrief, setSavingBrief] = useState(false);
  const [instruction, setInstruction] = useState(() => drafts.get(ds.projectId)?.instruction ?? '');
  // 已保存的那份变了：按格同步（rebase）；刚由这里保存的那几格强制取服务端的值。
  // 版本号也算「变了」：保存的值被服务端规范化回原值（种子色只改了大小写、字体名多打了空格）时各格都没变，只有版本 +1
  const baseRef = useRef(saved);
  const forceRef = useRef<(keyof Fields)[]>([]);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    const prev = baseRef.current;
    baseRef.current = saved;
    const force = forceRef.current;
    forceRef.current = [];
    if (same(prev, saved) && !force.length) return;
    setForm((f) => rebase(f, prev, saved, force));
    setFontError(null); setFontUrlError(null);
  }, [savedKey, ds.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // 卸载（关面板 / 切面板 / 切项目）时把草稿留给下一次打开
  const formRef = useRef(form); formRef.current = form;
  const instructionRef = useRef(instruction); instructionRef.current = instruction;
  useEffect(() => {
    const id = ds.projectId;
    return () => {
      if (sameFields(formRef.current, baseRef.current) && !instructionRef.current) drafts.delete(id);
      else drafts.set(id, { form: formRef.current, base: baseRef.current, instruction: instructionRef.current });
    };
  }, [ds.projectId]);
  // 只有这几项会改 tokens，进而改每屏 HTML 的 prelude；designMd 只进生成 prompt，回刷它产出的是逐字节相同的新修订。
  // 两边都先规范化（v0.83）：种子色只差大小写、字体名只多空格，保存出去也是同一份，不算改动、也不因它问回刷
  const [n, sv] = [normalized(form), normalized(saved)];
  const tokenDirty = n.seed !== sv.seed || n.font !== sv.font || n.radius !== sv.radius
    || n.fontSource !== sv.fontSource || (n.fontSource === 'url' && n.fontUrl !== sv.fontUrl)
    || !same(n.palette, sv.palette) || n.colorMode !== sv.colorMode;
  const dirty = tokenDirty || n.md !== sv.md;
  // 放弃改动：「保存」管的那几格回到已保存的值（简介有自己的保存键，不动）。按钮随之消失，焦点交给面板的「关闭」，
  // 不让它掉到 body——那时按 Esc 会被画布接走去取消在跑作业
  const discard = () => {
    setForm((f) => ({ ...saved, brief: f.brief }));
    setFontError(null); setFontUrlError(null);
    requestAnimationFrame(() => closeRef.current?.focus());
  };
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
      forceRef.current = [...forceRef.current, ...SAVE_KEYS];
      toast('设计系统已保存'); setAskApply(tokenDirty && screens.length > 0); onSaved();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '保存失败', 'error');
    } finally { setSaving(false); }
  };
  const saveBrief = async () => {
    setSavingBrief(true);
    try { await api.projects.patch(project.id, { brief: brief.trim() }); forceRef.current = [...forceRef.current, 'brief']; toast('应用简介已保存'); onSaved(); }
    catch { toast('保存失败', 'error'); } finally { setSavingBrief(false); }
  };
  // 删约定直接写库、撤销不了（v1.03）：先确认
  const [pendingConvention, setPendingConvention] = useState<number | null>(null);
  const removeConvention = async (i: number) => {
    try { await api.designSystem.update(ds.projectId, { conventions: conventions.filter((_, k) => k !== i), expectedVersion: ds.version }); toast('已删除这条约定'); onSaved(); }
    catch (e) { toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? '设计系统已被更新，请刷新后重试' : '删除失败', 'error'); }
  };

  return (
    <Panel title="设计系统" className="h-full" actions={<Button ref={closeRef} size="sm" onClick={onClose}>关闭</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        {/* 持久记忆（REQ-CORE-016）：应用简介每次生成都带；样板屏在画布上选中后用工具栏更换 */}
        <div className="space-y-1.5">
          <label htmlFor="ds-brief" className="block type-label font-semibold text-text-secondary">应用简介（每次生成都会带上）</label>
          <Textarea id="ds-brief" data-testid="ds-brief" rows={3} value={brief} onChange={(e) => set({ brief: e.target.value })} placeholder="首轮生成后会自动写一段：这是什么 APP、给谁用、调性。可以改。" className="resize-y font-normal" />
          <div className="flex justify-end"><Button size="sm" pending={savingBrief} disabled={brief.trim() === project.brief.trim()} onClick={saveBrief}>保存简介</Button></div>
        </div>
        <div className="fill rounded-md px-3 py-2 type-label" data-testid="ds-exemplar">
          <span className="text-text-secondary">样板屏：</span>{exemplar ? <><b className="text-text-primary">{exemplar.name}</b> <span className="text-text-secondary">{exemplar.route}</span></> : <span className="text-text-secondary">还没有（首轮生成后默认第 1 屏）</span>}
          <p className="mt-0.5 text-text-secondary">生成和修改时都以它为风格参照；在画布上选中一屏后用工具栏「设为样板」更换。</p>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {Object.entries(tokens.colors).map(([k, v]) => <div key={k} title={`${k} ${v}`} className={`h-6 rounded-sm ${SWATCH_EDGE}`} style={{ background: v }} />)}
        </div>
        <PaletteSection tokens={tokens} palette={palette} colorMode={colorMode} savedColorMode={ds.colorMode} onChange={(next) => set({ palette: next.palette, colorMode: next.colorMode })} />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="ds-seed" className="block type-label font-semibold text-text-secondary">种子色</label>
            <div className="flex items-center gap-2">
              {/* 浏览器自绘的色块默认带一圈灰框：去掉框、内圆角取小件档，外面是填充底 */}
              <input id="ds-seed" type="color" value={/^#[0-9A-Fa-f]{6}$/.test(seed) ? seed : '#000000'} onChange={(e) => set({ seed: e.target.value.toUpperCase() })} aria-label="选择种子色"
                className="fill h-9 w-10 shrink-0 cursor-pointer focus-ring rounded-md p-1 [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0" />
              <Input aria-label="种子色十六进制" value={seed} onChange={(e) => set({ seed: e.target.value })} className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ds-font" className="block type-label font-semibold text-text-secondary">字体</label>
            <Input id="ds-font" data-testid="ds-font" list="ds-font-options" value={font} onChange={(e) => { set({ font: e.target.value }); setFontError(null); }}
              placeholder={fontSource === 'system' ? '例如 PingFang SC' : '例如 Plus Jakarta Sans'} autoComplete="off" spellCheck={false}
              aria-invalid={!!fontError} aria-describedby={fontError ? 'ds-font-error' : undefined} />
            <datalist id="ds-font-options">{(fontSource === 'system' ? SYSTEM_FONTS : FONTS).map((f) => <option key={f} value={f} />)}</datalist>
            {fontError && <p id="ds-font-error" className="type-label text-error" role="alert">{fontError}</p>}
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 block type-label font-semibold text-text-secondary">字体来源</legend>
          {/* 分段控件（brand/DESIGN.md「控件形态」）：当前项靠 data-state 浮起滑块；焦点在藏起来的 radio 上，环画在整格（is-field） */}
          <div className="seg h-9 w-full" data-testid="ds-font-source" data-value={fontSource}>
            {FONT_SOURCE_OPTIONS.map((s) => (
              <label key={s.key} data-state={fontSource === s.key ? 'checked' : undefined} className={`flex flex-1 basis-0 cursor-pointer items-center justify-center whitespace-nowrap px-1 type-body focus-ring is-field ${fontSource === s.key ? '' : 'state-layer'}`}>
                <input type="radio" name="font-source" value={s.key} className="sr-only" checked={fontSource === s.key} onChange={() => { set({ fontSource: s.key }); setFontError(null); setFontUrlError(null); }} />{s.label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 type-label text-text-secondary">{FONT_SOURCE_OPTIONS.find((s) => s.key === fontSource)?.hint}</p>
        </fieldset>
        {fontSource === 'url' && (
          <div className="space-y-1.5">
            <label htmlFor="ds-font-url" className="block type-label font-semibold text-text-secondary">字体样式表地址（https，含 @font-face）</label>
            <Input id="ds-font-url" data-testid="ds-font-url" value={fontUrl} onChange={(e) => { set({ fontUrl: e.target.value }); setFontUrlError(null); }}
              placeholder="https://fonts.bunny.net/css?family=manrope:400,600" inputMode="url" autoComplete="off" spellCheck={false} className="font-mono"
              aria-invalid={!!fontUrlError} aria-describedby={fontUrlError ? 'ds-font-url-error' : undefined} />
            {fontUrlError && <p id="ds-font-url-error" className="type-label text-error" role="alert">{fontUrlError}</p>}
          </div>
        )}
        <fieldset>
          <legend className="mb-1.5 block type-label font-semibold text-text-secondary">圆角</legend>
          <div className="seg h-9 w-full">
            {RADIUS.map((r) => (
              <label key={r.key} data-state={radius === r.key ? 'checked' : undefined} className={`flex flex-1 basis-0 cursor-pointer items-center justify-center type-body focus-ring is-field ${radius === r.key ? '' : 'state-layer'}`}>
                <input type="radio" name="radius" value={r.key} className="sr-only" checked={radius === r.key} onChange={() => set({ radius: r.key })} />{r.label}
              </label>
            ))}
          </div>
        </fieldset>
        {/* 约定（REQ-EDIT-003）：DESIGN.md 里唯一由系统维护的一节，可删不可手写 */}
        <div className="space-y-1.5">
          <div className="block type-label font-semibold text-text-secondary">约定（跨屏生效的规则，{conventions.length} 条）</div>
          {conventions.length === 0 ? <p className="type-label text-text-secondary">还没有。在下面用一句话改设计系统，确认写入的规则会列在这里。</p> : (
            <ul className="flex flex-col gap-1" data-testid="ds-conventions">
              {conventions.map((c, i) => (
                <li key={i} className="fill flex items-start justify-between gap-2 rounded-md px-2 py-1.5 type-label">
                  <span className="min-w-0 flex-1 leading-(--semantic-typography-body-line-height) [overflow-wrap:anywhere]">{c}</span>
                  <button type="button" aria-label={`删除约定：${c}`} onClick={() => setPendingConvention(i)} className="shrink-0 rounded-md px-1 text-text-secondary state-layer focus-ring">删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1.5 border-t border-border-subtle pt-3">
          <label htmlFor="ds-instruction" className="block type-label font-semibold text-text-secondary">用一句话改设计系统</label>
          <Textarea id="ds-instruction" data-testid="ds-instruction" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="例如：所有列表项都带头像；正文字号整体大一档"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && instruction.trim()) { e.preventDefault(); onPropose(instruction.trim()); setInstruction(''); } }} />
          <div className="flex items-center justify-between gap-2">
            <span className="type-caption text-text-secondary">先提炼成绝对规则给你预览，确认后才写入</span>
            <Button size="sm" variant="primary" data-testid="ds-propose" disabled={!instruction.trim()} onClick={() => { onPropose(instruction.trim()); setInstruction(''); }}>提炼并预览</Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ds-md" className="block type-label font-semibold text-text-secondary">DESIGN.md（进入每次生成的上下文）</label>
          <textarea id="ds-md" value={md} onChange={(e) => set({ md: e.target.value })} rows={18} className="fill w-full resize-y focus-ring rounded-md border border-transparent p-2 font-mono type-label leading-relaxed text-text-primary [overflow-wrap:anywhere]" />
        </div>
        <PresetsSection projectId={ds.projectId} version={ds.version} busy={dirty}
          onApplied={() => { onSaved(); setAskApply(screens.length > 0); }} />
        <AssetsSection projectId={ds.projectId} items={assets} colors={tokens.colors} onChanged={onSaved} />
        <div className="flex flex-wrap items-center justify-between gap-2 type-label text-text-secondary">
          <span>版本 {ds.version}{dirty ? ' · 有未保存改动' : ''}</span>
          <div className="flex gap-2">
            {dirty && <Button size="sm" onClick={discard} data-testid="ds-discard">放弃改动</Button>}
            <Button ref={saveRef} size="sm" variant="primary" pending={saving} disabled={!dirty} onClick={save} data-testid="ds-save">保存</Button>
            {/* 有未保存改动时不能回刷：作业只带 screenIds，worker 用的是库里那份 tokens，
                拿旧色板给每屏出一版一模一样的新修订，回执还写「已回刷 N 屏」，用户看到的是「颜色一点没变」 */}
            <Button ref={applyRef} size="sm" pending={applying} disabled={!!busyReason || dirty || applying} onClick={() => void applyAll()}
              title={dirty ? '先保存——回刷用的是已保存的那份设计系统' : '把最新设计系统应用到所有屏幕'}>回刷所有屏</Button>
          </div>
        </div>
        {busyReason && <p className="text-right type-caption text-warning" data-testid="ds-apply-blocked">{busyReason}，等它结束再回刷</p>}
      </div>
      {askApply && <ApplyAllDialog count={screens.length} blocked={busyReason} returnTo={saveRef} fallback={applyRef} onConfirm={() => void applyAll()} onClose={() => setAskApply(false)} />}
      {pendingConvention !== null && conventions[pendingConvention] !== undefined && (
        <ConfirmDialog title="删除这条约定？" body={`「${conventions[pendingConvention]}」之后生成与改屏都不再带它，撤销不了。`} confirmLabel="删除"
          onCancel={() => setPendingConvention(null)} onConfirm={async () => { const i = pendingConvention; setPendingConvention(null); await removeConvention(i); }} />
      )}
    </Panel>
  );
}

// 保存后问一次「回刷所有屏？」（REQ-EDIT-005）：库里的设计系统已经新了，但每屏的 HTML 还是旧 token 烤出来的，
// 不回刷就只有以后新造的屏会变。这一问必须是弹层：面板内插一条会把用户刚点的「保存」挤走（RESP-010），
// 面板滚到底时插在下方的那一问也可能不在视野里
function ApplyAllDialog({ count, blocked, returnTo, fallback, onConfirm, onClose }: { count: number; blocked: string | false; returnTo: React.RefObject<HTMLButtonElement | null>; fallback: React.RefObject<HTMLButtonElement | null>; onConfirm: () => void; onClose: () => void }) {
  // 关掉时焦点回「保存」；但保存成功后它已变成原生 disabled，focus 会静默失败、焦点掉到 body，
  // 所以兜底给「回刷所有屏」——此刻它恰好可点
  const ref = useModal<HTMLDivElement>(onClose, returnTo, fallback);
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ds-apply-title" data-testid="ds-apply-ask" tabIndex={-1}
        className="sheet w-full max-w-xs p-5 fade-up outline-none">
        <h2 id="ds-apply-title" className="type-heading3 font-semibold">回刷所有屏？</h2>
        <p className="mt-1 type-label text-text-secondary">现有 {count} 屏的 HTML 还是旧 token 烤出来的。回刷按新设计系统给每屏重出一版——确定性改写，不调模型；不刷就只有以后新造的屏用新设计系统。</p>
        {blocked && <p className="mt-2 type-label text-warning" data-testid="ds-apply-ask-blocked">{blocked}，等它结束再回刷</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>以后再说</Button>
          <Button size="sm" variant="primary" data-testid="ds-apply-confirm" disabled={!!blocked} onClick={() => { onConfirm(); onClose(); }}>回刷 {count} 屏</Button>
        </div>
      </div>
    </Overlay>
  );
}
