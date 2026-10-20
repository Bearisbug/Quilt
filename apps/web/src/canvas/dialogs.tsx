import { useState, type FormEvent } from 'react';
import { variantPrompt, type ScreenDto, type ComponentDto } from '@quilt/core/browser';
import { ApiError } from '@/lib/api';
import { Button, Input, Textarea } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { useLocale, useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';
import commonMessages from '@/i18n/locales/common';

// 画布上的弹层。焦点陷阱 / Esc / 背景 inert / 关闭归还焦点都由 useModal 管（A11Y-004 / A11Y-005），
// 与设置、通道、预设那几个弹层同一套——aria-modal 说了「背景已隐藏」，Tab 就不能再走进画布。

// 删屏 / 删组件确认：危险动作，初始焦点落「取消」（useModal 落第一个可聚焦项，DOM 里「取消」在前）
export function DeleteDialog({ screens, components, selected, variantCount, onConfirm, onClose }: { screens: ScreenDto[]; components: ComponentDto[]; selected: ScreenDto | null; variantCount: number; onConfirm: () => void; onClose: () => void }) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  // 说明是几句话拼起来的：中文句间不留空，英文句间一个空格
  const gap = useLocale() === 'en' ? ' ' : '';
  const ref = useModal<HTMLDivElement>(onClose);
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="del-title" tabIndex={-1} className="sheet outline-none w-full max-w-xs p-5 fade-up" data-testid="delete-dialog">
        <h2 id="del-title" className="type-heading3 font-semibold">
          {screens.length === 0
            ? (components.length === 1 ? t('dialogs.del.componentOne', { name: components[0].name }) : t('dialogs.del.componentsN', { count: components.length }))
            : components.length > 0 ? t('dialogs.del.mixed', { screens: t('screenCount', { count: screens.length }), components: t('dialogs.del.componentsPart', { count: components.length }) })
            : selected ? t('dialogs.del.screenOne', { name: selected.name }) : t('dialogs.del.screensN', { count: screens.length })}
        </h2>
        <p className="mt-1 type-label text-text-secondary">
          {[screens.length > 0 && t('dialogs.del.revisions'), variantCount > 0 && t('dialogs.del.variants', { count: variantCount }), components.length > 0 && t('dialogs.del.components')].filter(Boolean).join(gap)}
        </p>
        <div className="mt-4 flex justify-end gap-2"><Button onClick={() => onClose()}>{tc('cancel')}</Button><Button variant="danger" onClick={onConfirm}>{tc('delete')}</Button></div>
      </div>
    </Overlay>
  );
}

// 断链补屏：列表型弹层，初始焦点落容器本身、Tab 再进列表；补屏建的也是 generate，与在跑的那个抢同一个项目级名额（busyReason 说清为什么现在点不了，A11Y-007 / IA-009）
export function MissingDialog({ missing, busyReason, onGenerate, onClose }: { missing: { fromScreenId: string; hrefs: string[] }; busyReason: string | false; onGenerate: (fromScreenId: string, href: string) => void; onClose: () => void }) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLDivElement>(onClose, undefined, undefined, { initialFocus: 'self' });
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="miss-title" tabIndex={-1} className="sheet outline-none w-full max-w-sm p-5 fade-up" data-testid="missing-dialog">
        <h2 id="miss-title" className="type-heading3 font-semibold">{missing.hrefs.length === 1 ? t('dialogs.missing.one', { href: missing.hrefs[0] }) : t('dialogs.missing.many')}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('dialogs.missing.hint')}</p>
        <ul className="mt-3 space-y-1.5">
          {missing.hrefs.map((h) => (
            <li key={h} className="fill flex items-center justify-between gap-2 rounded-md px-3 py-2 type-body">
              <code className="text-error">{h}</code>
              <Button size="sm" variant="primary" disabled={!!busyReason} onClick={() => onGenerate(missing.fromScreenId, h)}>{t('dialogs.missing.generate')}</Button>
            </li>
          ))}
        </ul>
        {busyReason && <p className="mt-2 type-label text-warning">{busyReason}</p>}
        <div className="mt-4 flex justify-end"><Button onClick={() => onClose()}>{tc('close')}</Button></div>
      </div>
    </Overlay>
  );
}

// 新建组件（REQ-EDIT-006）：只问名字；名字被占用时就地报错、不关框，让用户改一个字再试
export function NewComponentDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError(t('dialogs.newComponent.nameRequired')); return; }
    setPending(true);
    try { await onCreate(n); }
    catch (err) {
      if (err instanceof ApiError && err.type === '/errors/component-name-taken') setError(t('dialogs.newComponent.taken'));
      else if (err instanceof ApiError && err.status === 400) setError((err.problem.errors as { message?: string }[] | undefined)?.[0]?.message ?? err.problem.title);
      else setError(err instanceof ApiError ? err.problem.title : t('dialogs.createFailed'));
    } finally { setPending(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="nc-title" data-testid="new-component-dialog" tabIndex={-1} onSubmit={submit}
        className="sheet w-full max-w-xs p-5 fade-up outline-none">
        <h2 id="nc-title" className="type-heading3 font-semibold">{t('dialogs.newComponent.title')}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('dialogs.newComponent.hint')}</p>
        <label htmlFor="nc-name" className="mt-3 block type-label font-medium text-text-secondary">{t('dialogs.newComponent.name')}</label>
        <Input id="nc-name" data-testid="new-component-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder={t('dialogs.newComponent.placeholder')} autoComplete="off" spellCheck={false} maxLength={40} className="mt-1.5"
          aria-invalid={!!error} aria-describedby={error ? 'nc-error' : undefined} />
        {error && <p id="nc-error" role="alert" className="mt-1.5 type-label text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>{tc('cancel')}</Button>
          <Button size="sm" variant="primary" type="submit" data-testid="new-component-create" pending={pending} disabled={!name.trim()}>{t('dialogs.newComponent.create')}</Button>
        </div>
      </form>
    </Overlay>
  );
}

// 出变体（REQ-CORE-025 v0.62）：给默认屏起一个状态名、一句话说明；建的是钉死路由的 generate 作业，默认屏作参考屏。
// 候选状态名按界面语言给（canvas-parts 的 dialogs.variant.names.<id>）
const VARIANT_NAMES = ['empty', 'loading', 'error', 'signedOut', 'done'] as const;
export function VariantDialog({ base, onCreate, onClose }: { base: ScreenDto; onCreate: (name: string, prompt: string) => Promise<void>; onClose: () => void }) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError(t('dialogs.variant.nameRequired')); return; }
    if (n.length > 20) { setError(t('dialogs.variant.tooLong')); return; }
    setPending(true);
    try { await onCreate(n, prompt.trim() || variantPrompt(n)); }
    catch (err) { setError(err instanceof ApiError ? err.problem.title : t('dialogs.createFailed')); }
    finally { setPending(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="vd-title" data-testid="variant-dialog" tabIndex={-1} onSubmit={submit} noValidate
        className="sheet w-full max-w-sm p-5 fade-up outline-none">
        <h2 id="vd-title" className="type-heading3 font-semibold">{t('dialogs.variant.title', { name: base.name })}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('dialogs.variant.hint')}</p>
        <label htmlFor="vd-name" className="mt-3 block type-label font-medium text-text-secondary">{t('dialogs.variant.name')}</label>
        <Input id="vd-name" data-testid="variant-name" list="variant-names" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder={t('dialogs.variant.placeholder')} autoComplete="off" spellCheck={false} maxLength={20}
          aria-invalid={!!error} aria-describedby={error ? 'vd-error' : undefined} />
        <datalist id="variant-names">{VARIANT_NAMES.map((v) => <option key={v} value={t(`dialogs.variant.names.${v}`)} />)}</datalist>
        <label htmlFor="vd-prompt" className="mt-3 block type-label font-medium text-text-secondary">{t('dialogs.variant.prompt')}</label>
        <Textarea id="vd-prompt" data-testid="variant-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('dialogs.variant.promptPlaceholder')} className="resize-y font-normal" />
        {error && <p id="vd-error" role="alert" className="mt-1.5 type-label text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>{tc('cancel')}</Button>
          <Button size="sm" variant="primary" type="submit" data-testid="variant-create" pending={pending} disabled={!name.trim()}>{t('dialogs.variant.create')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
