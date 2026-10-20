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
import { useT } from '@/i18n';
import panelsMessages from '@/i18n/locales/panels-design';
import commonMessages from '@/i18n/locales/common';

// 设计系统面板（REQ-CORE-010 只读展示 / REQ-EDIT-003 编辑与回刷 / REQ-CORE-016 应用简介与样板屏）。
// 设计系统是唯一的持久记忆且只显式改：约定条目只经「用一句话改设计系统」→ 提炼 → 预览确认写入，这里可删不可手写。
export function DesignPanel({ ds, project, screens, assets, busyReason, onClose, onSaved, onApplyAll, onPropose }: { ds: DesignSystemDto; project: ProjectDto; screens: ScreenDto[]; assets: AssetDto[]; busyReason: string | false; onClose: () => void; onSaved: () => void; onApplyAll: () => Promise<unknown>; onPropose: (instruction: string) => void }) {
  const toast = useToast();
  const t = useT(panelsMessages);
  const tc = useT(commonMessages);
  const tokens = ds.tokens as Tokens;
  const saved = savedFields(ds, project);
  // 品牌色板（REQ-EDIT-005）：和种子 / 字体 / 圆角同属「保存后回刷」这一组，不单独走接口
  const [form, setForm] = useState<Fields>(() => { const d = drafts.get(ds.projectId); return d ? rebase(d.form, d.base, saved, []) : saved; });
  const set = (patch: Partial<Fields>) => setForm((f) => ({ ...f, ...patch }));
  const { seed, font, fontSource, fontUrl, radius, md, palette, colorMode, brief } = form;
  // 存错误的种类而不是现成文案：切语言后提示跟着换
  const [fontError, setFontError] = useState<'invalid' | null>(null);
  const [fontUrlError, setFontUrlError] = useState<'notHttps' | 'missing' | null>(null);
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
    if (!/^#[0-9A-Fa-f]{6}$/.test(seed)) { toast(t('design.seedInvalid'), 'error'); return; }
    const family = fontFamilySchema.safeParse(font);
    if (!family.success) { setFontError('invalid'); return; }
    const url = fontSource === 'url' ? fontUrlSchema.safeParse(fontUrl) : null;
    if (fontSource === 'url' && !url?.success) { setFontUrlError(fontUrl.trim() ? 'notHttps' : 'missing'); return; }
    setSaving(true);
    try {
      await api.designSystem.update(ds.projectId, { seedColor: seed.toUpperCase(), fontFamily: family.data, fontSource, fontUrl: url?.success ? url.data : null, radiusScale: radius, palette, colorMode, designMd: md, expectedVersion: ds.version });
      forceRef.current = [...forceRef.current, ...SAVE_KEYS];
      toast(t('design.saved')); setAskApply(tokenDirty && screens.length > 0); onSaved();
    } catch (e) {
      toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? t('design.versionConflict') : t('saveFailed'), 'error');
    } finally { setSaving(false); }
  };
  const saveBrief = async () => {
    setSavingBrief(true);
    try { await api.projects.patch(project.id, { brief: brief.trim() }); forceRef.current = [...forceRef.current, 'brief']; toast(t('design.briefSaved')); onSaved(); }
    catch { toast(t('saveFailed'), 'error'); } finally { setSavingBrief(false); }
  };
  // 删约定直接写库、撤销不了（v1.03）：先确认
  const [pendingConvention, setPendingConvention] = useState<number | null>(null);
  const removeConvention = async (i: number) => {
    try { await api.designSystem.update(ds.projectId, { conventions: conventions.filter((_, k) => k !== i), expectedVersion: ds.version }); toast(t('design.conventionDeleted')); onSaved(); }
    catch (e) { toast(e instanceof ApiError && e.type === '/errors/version-conflict' ? t('design.versionConflict') : t('deleteFailed'), 'error'); }
  };

  return (
    <Panel title={t('design.title')} className="h-full" actions={<Button ref={closeRef} size="sm" onClick={onClose}>{tc('close')}</Button>}>
      <div className="scroll flex-1 space-y-4 p-3">
        {/* 持久记忆（REQ-CORE-016）：应用简介每次生成都带；样板屏在画布上选中后用工具栏更换 */}
        <div className="space-y-1.5">
          <label htmlFor="ds-brief" className="block type-label font-semibold text-text-secondary">{t('design.brief.label')}</label>
          <Textarea id="ds-brief" data-testid="ds-brief" rows={3} value={brief} onChange={(e) => set({ brief: e.target.value })} placeholder={t('design.brief.placeholder')} className="resize-y font-normal" />
          <div className="flex justify-end"><Button size="sm" pending={savingBrief} disabled={brief.trim() === project.brief.trim()} onClick={saveBrief}>{t('design.brief.save')}</Button></div>
        </div>
        <div className="fill rounded-md px-3 py-2 type-label" data-testid="ds-exemplar">
          <span className="text-text-secondary">{t('design.exemplar.label')}</span>{exemplar ? <><b className="text-text-primary">{exemplar.name}</b> <span className="text-text-secondary">{exemplar.route}</span></> : <span className="text-text-secondary">{t('design.exemplar.none')}</span>}
          <p className="mt-0.5 text-text-secondary">{t('design.exemplar.hint')}</p>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {Object.entries(tokens.colors).map(([k, v]) => <div key={k} title={`${k} ${v}`} className={`h-6 rounded-sm ${SWATCH_EDGE}`} style={{ background: v }} />)}
        </div>
        <PaletteSection tokens={tokens} palette={palette} colorMode={colorMode} savedColorMode={ds.colorMode} onChange={(next) => set({ palette: next.palette, colorMode: next.colorMode })} />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="ds-seed" className="block type-label font-semibold text-text-secondary">{t('design.seed.label')}</label>
            <div className="flex items-center gap-2">
              {/* 浏览器自绘的色块默认带一圈灰框：去掉框、内圆角取小件档，外面是填充底 */}
              <input id="ds-seed" type="color" value={/^#[0-9A-Fa-f]{6}$/.test(seed) ? seed : '#000000'} onChange={(e) => set({ seed: e.target.value.toUpperCase() })} aria-label={t('design.seed.pick')}
                className="fill h-9 w-10 shrink-0 cursor-pointer focus-ring rounded-md p-1 [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0" />
              <Input aria-label={t('design.seed.hex')} value={seed} onChange={(e) => set({ seed: e.target.value })} className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ds-font" className="block type-label font-semibold text-text-secondary">{t('design.font.label')}</label>
            <Input id="ds-font" data-testid="ds-font" list="ds-font-options" value={font} onChange={(e) => { set({ font: e.target.value }); setFontError(null); }}
              placeholder={fontSource === 'system' ? t('design.font.placeholderSystem') : t('design.font.placeholderGoogle')} autoComplete="off" spellCheck={false}
              aria-invalid={!!fontError} aria-describedby={fontError ? 'ds-font-error' : undefined} />
            <datalist id="ds-font-options">{(fontSource === 'system' ? SYSTEM_FONTS : FONTS).map((f) => <option key={f} value={f} />)}</datalist>
            {fontError && <p id="ds-font-error" className="type-label text-error" role="alert">{t(`design.fontError.${fontError}`)}</p>}
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 block type-label font-semibold text-text-secondary">{t('design.fontSource')}</legend>
          {/* 分段控件（brand/DESIGN.md「控件形态」）：当前项靠 data-state 浮起滑块；焦点在藏起来的 radio 上，环画在整格（is-field） */}
          <div className="seg h-9 w-full" data-testid="ds-font-source" data-value={fontSource}>
            {FONT_SOURCE_OPTIONS.map((s) => (
              <label key={s} data-state={fontSource === s ? 'checked' : undefined} className={`flex flex-1 basis-0 cursor-pointer items-center justify-center whitespace-nowrap px-1 type-body focus-ring is-field ${fontSource === s ? '' : 'state-layer'}`}>
                <input type="radio" name="font-source" value={s} className="sr-only" checked={fontSource === s} onChange={() => { set({ fontSource: s }); setFontError(null); setFontUrlError(null); }} />{t(`options.fontSource.${s}.label`)}
              </label>
            ))}
          </div>
          <p className="mt-1.5 type-label text-text-secondary">{t(`options.fontSource.${fontSource}.hint`)}</p>
        </fieldset>
        {fontSource === 'url' && (
          <div className="space-y-1.5">
            <label htmlFor="ds-font-url" className="block type-label font-semibold text-text-secondary">{t('design.fontUrl')}</label>
            <Input id="ds-font-url" data-testid="ds-font-url" value={fontUrl} onChange={(e) => { set({ fontUrl: e.target.value }); setFontUrlError(null); }}
              placeholder="https://fonts.bunny.net/css?family=manrope:400,600" inputMode="url" autoComplete="off" spellCheck={false} className="font-mono"
              aria-invalid={!!fontUrlError} aria-describedby={fontUrlError ? 'ds-font-url-error' : undefined} />
            {fontUrlError && <p id="ds-font-url-error" className="type-label text-error" role="alert">{t(`design.fontUrlError.${fontUrlError}`)}</p>}
          </div>
        )}
        <fieldset>
          <legend className="mb-1.5 block type-label font-semibold text-text-secondary">{t('design.radius')}</legend>
          <div className="seg h-9 w-full">
            {RADIUS.map((r) => (
              <label key={r.key} data-state={radius === r.key ? 'checked' : undefined} className={`flex flex-1 basis-0 cursor-pointer items-center justify-center type-body focus-ring is-field ${radius === r.key ? '' : 'state-layer'}`}>
                <input type="radio" name="radius" value={r.key} className="sr-only" checked={radius === r.key} onChange={() => set({ radius: r.key })} />{t(`options.radius.${r.key}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {/* 约定（REQ-EDIT-003）：DESIGN.md 里唯一由系统维护的一节，可删不可手写 */}
        <div className="space-y-1.5">
          <div className="block type-label font-semibold text-text-secondary">{t('design.conventions.title', { count: conventions.length })}</div>
          {conventions.length === 0 ? <p className="type-label text-text-secondary">{t('design.conventions.empty')}</p> : (
            <ul className="flex flex-col gap-1" data-testid="ds-conventions">
              {conventions.map((c, i) => (
                <li key={i} className="fill flex items-start justify-between gap-2 rounded-md px-2 py-1.5 type-label">
                  <span className="min-w-0 flex-1 leading-(--semantic-typography-body-line-height) [overflow-wrap:anywhere]">{c}</span>
                  <button type="button" aria-label={t('design.conventions.deleteLabel', { text: c })} onClick={() => setPendingConvention(i)} className="shrink-0 rounded-md px-1 text-text-secondary state-layer focus-ring">{tc('delete')}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1.5 border-t border-border-subtle pt-3">
          <label htmlFor="ds-instruction" className="block type-label font-semibold text-text-secondary">{t('design.instruction.label')}</label>
          <Textarea id="ds-instruction" data-testid="ds-instruction" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t('design.instruction.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && instruction.trim()) { e.preventDefault(); onPropose(instruction.trim()); setInstruction(''); } }} />
          <div className="flex items-center justify-between gap-2">
            <span className="type-caption text-text-secondary">{t('design.instruction.hint')}</span>
            <Button size="sm" variant="primary" data-testid="ds-propose" disabled={!instruction.trim()} onClick={() => { onPropose(instruction.trim()); setInstruction(''); }}>{t('design.instruction.propose')}</Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ds-md" className="block type-label font-semibold text-text-secondary">{t('design.md')}</label>
          <textarea id="ds-md" value={md} onChange={(e) => set({ md: e.target.value })} rows={18} className="fill w-full resize-y focus-ring rounded-md border border-transparent p-2 font-mono type-label leading-relaxed text-text-primary [overflow-wrap:anywhere]" />
        </div>
        <PresetsSection projectId={ds.projectId} version={ds.version} busy={dirty}
          onApplied={() => { onSaved(); setAskApply(screens.length > 0); }} />
        <AssetsSection projectId={ds.projectId} items={assets} colors={tokens.colors} onChanged={onSaved} />
        <div className="flex flex-wrap items-center justify-between gap-2 type-label text-text-secondary">
          <span>{t(dirty ? 'design.versionDirty' : 'design.version', { version: ds.version })}</span>
          {/* 英文按钮更长：三颗同时出现时一行放不下就换行，不撑出面板 */}
          <div className="flex flex-wrap gap-2">
            {dirty && <Button size="sm" onClick={discard} data-testid="ds-discard">{t('design.discard')}</Button>}
            <Button ref={saveRef} size="sm" variant="primary" pending={saving} disabled={!dirty} onClick={save} data-testid="ds-save">{t('design.save')}</Button>
            {/* 有未保存改动时不能回刷：作业只带 screenIds，worker 用的是库里那份 tokens，
                拿旧色板给每屏出一版一模一样的新修订，回执还写「已回刷 N 屏」，用户看到的是「颜色一点没变」 */}
            <Button ref={applyRef} size="sm" pending={applying} disabled={!!busyReason || dirty || applying} onClick={() => void applyAll()}
              title={dirty ? t('design.applyAllSaveFirst') : t('design.applyAllTitle')}>{t('design.applyAll')}</Button>
          </div>
        </div>
        {busyReason && <p className="text-right type-caption text-warning" data-testid="ds-apply-blocked">{t('design.applyBlocked', { reason: busyReason })}</p>}
      </div>
      {askApply && <ApplyAllDialog count={screens.length} blocked={busyReason} returnTo={saveRef} fallback={applyRef} onConfirm={() => void applyAll()} onClose={() => setAskApply(false)} />}
      {pendingConvention !== null && conventions[pendingConvention] !== undefined && (
        <ConfirmDialog title={t('design.deleteConvention.title')} body={t('design.deleteConvention.body', { text: conventions[pendingConvention] })} confirmLabel={tc('delete')}
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
  const t = useT(panelsMessages);
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ds-apply-title" data-testid="ds-apply-ask" tabIndex={-1}
        className="sheet w-full max-w-xs p-5 fade-up outline-none">
        <h2 id="ds-apply-title" className="type-heading3 font-semibold">{t('design.applyAsk.title')}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('design.applyAsk.body', { count })}</p>
        {blocked && <p className="mt-2 type-label text-warning" data-testid="ds-apply-ask-blocked">{t('design.applyBlocked', { reason: blocked })}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>{t('design.applyAsk.later')}</Button>
          <Button size="sm" variant="primary" data-testid="ds-apply-confirm" disabled={!!blocked} onClick={() => { onConfirm(); onClose(); }}>{t('design.applyAsk.confirm', { count })}</Button>
        </div>
      </div>
    </Overlay>
  );
}
