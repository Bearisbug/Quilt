import { useState, type FormEvent } from 'react';
import type { ScreenDto, ComponentDto } from '@quilt/core';
import { ApiError } from '@/lib/api';
import { Button, Input, Textarea } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';

// 画布上的三个弹层。焦点陷阱 / Esc / 背景 inert / 关闭归还焦点都由 useModal 管（A11Y-004 / A11Y-005），
// 与设置、通道、预设那几个弹层同一套——aria-modal 说了「背景已隐藏」，Tab 就不能再走进画布。

// 删屏 / 删组件确认：危险动作，初始焦点落「取消」（useModal 落第一个可聚焦项，DOM 里「取消」在前）
export function DeleteDialog({ screens, components, selected, variantCount = 0, onConfirm, onClose }: { screens: ScreenDto[]; components: ComponentDto[]; selected: ScreenDto | null; variantCount?: number; onConfirm: () => void; onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose);
  return (
    <Overlay onClose={onClose}>
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="del-title" tabIndex={-1} className="outline-none w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up" data-testid="delete-dialog">
        <h2 id="del-title" className="text-sm font-semibold">
          {screens.length === 0
            ? (components.length === 1 ? `删除组件「${components[0].name}」？` : `删除 ${components.length} 个组件？`)
            : components.length > 0 ? `删除 ${screens.length} 屏与 ${components.length} 个组件？`
            : selected ? `删除「${selected.name}」？` : `删除选中的 ${screens.length} 屏？`}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {screens.length > 0 ? '屏的修订历史一并删除，指向它的链接会变成断链。' : ''}{variantCount > 0 ? `它的 ${variantCount} 个变体一起删除。` : ''}
          {components.length > 0 ? '组件在屏里已经展开的那份留着，只是不再跟着改。' : ''}
        </p>
        <div className="mt-4 flex justify-end gap-2"><Button onClick={() => onClose()}>取消</Button><Button variant="danger" onClick={onConfirm}>删除</Button></div>
      </div>
    </div>
    </Overlay>
  );
}

// 断链补屏：列表型弹层，初始焦点落容器本身、Tab 再进列表；补屏建的也是 generate，与在跑的那个抢同一个项目级名额（busyReason 说清为什么现在点不了，A11Y-007 / IA-009）
export function MissingDialog({ missing, busyReason, onGenerate, onClose }: { missing: { fromScreenId: string; hrefs: string[] }; busyReason: string | false; onGenerate: (fromScreenId: string, href: string) => void; onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose, undefined, undefined, { initialFocus: 'self' });
  return (
    <Overlay onClose={onClose}>
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="miss-title" tabIndex={-1} className="outline-none w-full max-w-sm rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up" data-testid="missing-dialog">
        <h2 id="miss-title" className="text-sm font-semibold">{missing.hrefs.length === 1 ? `「${missing.hrefs[0]}」尚不存在，生成它？` : '这些路由尚不存在，生成哪一个？'}</h2>
        <p className="mt-1 text-xs text-muted">会按当前设计系统生成新屏幕并接上链接（消耗额度）。</p>
        <ul className="mt-3 space-y-1.5">
          {missing.hrefs.map((h) => (
            <li key={h} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <code className="text-danger">{h}</code>
              <Button size="sm" variant="primary" disabled={!!busyReason} onClick={() => onGenerate(missing.fromScreenId, h)}>生成</Button>
            </li>
          ))}
        </ul>
        {/* 补屏建的也是 generate，与在跑的那个抢同一个项目级名额：说清为什么现在点不了（A11Y-007 / IA-009） */}
        {busyReason && <p className="mt-2 text-xs text-warn">{busyReason}</p>}
        <div className="mt-4 flex justify-end"><Button onClick={() => onClose()}>关闭</Button></div>
      </div>
    </div>
    </Overlay>
  );
}

// 新建组件（REQ-EDIT-006）：只问名字。焦点陷阱 / Esc / 背景 inert 由 useModal 管（A11Y-004 / A11Y-005）；
// 名字被占用时就地报错、不关框，让用户改一个字再试
export function NewComponentDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const ref = useModal<HTMLFormElement>(onClose);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) { setError('给组件起个名字'); return; }
    setPending(true);
    try { await onCreate(n); }
    catch (err) {
      if (err instanceof ApiError && err.type === '/errors/component-name-taken') setError('这个名字已被占用');
      else if (err instanceof ApiError && err.status === 400) setError((err.problem.errors as { message?: string }[] | undefined)?.[0]?.message ?? err.problem.title);
      else setError(err instanceof ApiError ? err.problem.title : '创建失败');
    } finally { setPending(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="nc-title" data-testid="new-component-dialog" tabIndex={-1} onSubmit={submit}
        className="w-full max-w-xs rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="nc-title" className="text-sm font-semibold">新建组件</h2>
        <p className="mt-1 text-xs text-muted">先起个名字；建好后在输入框里描述它。改组件一次，用它的屏全部同步。</p>
        <label htmlFor="nc-name" className="mt-3 block text-xs font-medium text-muted">组件名</label>
        <Input id="nc-name" data-testid="new-component-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="例如 TabBar" autoComplete="off" spellCheck={false} maxLength={40} className="mt-1.5"
          aria-invalid={!!error} aria-describedby={error ? 'nc-error' : undefined} />
        {error && <p id="nc-error" role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" type="submit" data-testid="new-component-create" pending={pending} disabled={!name.trim()}>创建</Button>
        </div>
      </form>
    </Overlay>
  );
}

// 出变体（REQ-CORE-025 v0.62）：给默认屏起一个状态名、一句话说明；建的是钉死路由的 generate 作业，默认屏作参考屏
const VARIANT_NAMES = ['空态', '加载中', '出错', '未登录', '已完成'];
export function VariantDialog({ base, onCreate, onClose }: { base: ScreenDto; onCreate: (name: string, prompt: string) => Promise<void>; onClose: () => void }) {
  const ref = useModal<HTMLFormElement>(onClose);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) { setError('给这个状态起个名字'); return; }
    if (n.length > 20) { setError('状态名最多 20 个字符'); return; }
    setPending(true);
    try { await onCreate(n, prompt.trim() || `The ${n} state`); }
    catch (err) { setError(err instanceof ApiError ? err.problem.title : '创建失败'); }
    finally { setPending(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="vd-title" data-testid="variant-dialog" tabIndex={-1} onSubmit={submit} noValidate
        className="w-full max-w-sm rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="vd-title" className="text-sm font-semibold">给「{base.name}」出一个状态变体</h2>
        <p className="mt-1 text-xs text-muted">同一路由、同一布局，只改状态所指的那部分；造好后是普通屏，播放时可切换。</p>
        <label htmlFor="vd-name" className="mt-3 block text-xs font-medium text-muted">状态名</label>
        <Input id="vd-name" data-testid="variant-name" list="variant-names" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="例如 空态" autoComplete="off" spellCheck={false} maxLength={20}
          aria-invalid={!!error} aria-describedby={error ? 'vd-error' : undefined} />
        <datalist id="variant-names">{VARIANT_NAMES.map((v) => <option key={v} value={v} />)}</datalist>
        <label htmlFor="vd-prompt" className="mt-3 block text-xs font-medium text-muted">这个状态长什么样（可空）</label>
        <Textarea id="vd-prompt" data-testid="variant-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：列表为空时显示插画、一句说明和「去逛逛」按钮" className="resize-y font-normal" />
        {error && <p id="vd-error" role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" type="submit" data-testid="variant-create" pending={pending} disabled={!name.trim()}>出变体</Button>
        </div>
      </form>
    </Overlay>
  );
}
