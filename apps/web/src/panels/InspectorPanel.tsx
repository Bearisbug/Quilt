import { useEffect, useRef, useState } from 'react';
import type { ScreenDto, ComponentDto, RunnerOptionDto, AgentSessionDto, Runner } from '@quilt/core';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, Input, Panel } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { RunnerSelect, SessionSelect } from '@/composer/Composer';

// Radix Select 不接受空字符串作为选项值（空串是「未选中」的内部语义），空态用哨兵值代替
const NO_LINK = '__none__';

// 元素检查器（REQ-EDIT-001 / REQ-EDIT-002）：本地直改零 token；AI 只重生成选中子树。
// component（REQ-EDIT-006）：元素所在的共享组件名——在组件里的元素不直改，给「改组件 / 脱离共享」两个出口
export type ElementSel = { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; rect: { x: number; y: number; w: number; h: number } };
const SUBTREE_RUNNER_KEY = 'quilt:runner:subtree';
const SUBTREE_SESSION_KEY = 'quilt:agent-session:subtree';
// 「记为共享组件」的默认名：按元素标签给个常见叫法，用户可改
const COMPONENT_NAME_BY_TAG: Record<string, string> = { nav: 'TabBar', header: 'AppBar', aside: 'Sidebar', footer: 'Footer' };
// 目标是一张屏，或一个共享组件（v0.57 `REQ-EDIT-006`）——组件也能选元素直改，op 与屏同一套，
// 只是落在组件自己的 HTML 上、乐观并发用版本号，改完由服务端回刷所有用它的屏。
// 组件没有 AI 子树重生成（整块重写走输入框的「改组件」）、没有批注、也不能再「记为共享组件」。
export function InspectorPanel({ screen, component, sel, routes = [], busy, runners = [], composerRunnerId = '', sessions = null, onSessionsOpen, workingQids = [], onClose, onEdited, onRegenerate, onEditComponent }: { screen?: ScreenDto; component?: ComponentDto; sel: ElementSel | null; routes?: string[]; busy: boolean; runners?: RunnerOptionDto[]; composerRunnerId?: string; sessions?: AgentSessionDto[] | null; onSessionsOpen?: () => void; workingQids?: string[]; onClose: () => void; onEdited: (qid: string) => void; onRegenerate?: (qid: string, prompt: string, runner: Runner | undefined) => Promise<boolean>; onEditComponent?: (name: string) => void }) {
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
  useEffect(() => { if (agent) openRef.current?.(); }, [agent]);
  const pickRunner = (id: string) => { setRunnerPick(id); try { localStorage.setItem(SUBTREE_RUNNER_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const pickSession = (id: string) => { setSessionId(id); try { localStorage.setItem(SUBTREE_SESSION_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const runner: Runner | undefined = runnerOpt?.runner.kind === 'agent' ? { ...runnerOpt.runner, sessionId } : runnerOpt?.runner;
  // 重生成：按钮或文本框里 Shift+Enter（这里是多行说明，Enter 留给换行，与输入框的 Enter 发送不同）。
  // 发出成功只清说明框，选中不动——面板留在这个元素上；建作业被拒（屏忙等）时说明保留
  // 这块已有作业在改（本机会话投递的作业不占 busy，靠这个挡重复发起；屏锁在服务端还有一道 409）
  const working = !!sel && workingQids.includes(sel.qid);
  const canRegenerate = !!sel && !!onRegenerate && !!prompt.trim() && !busy && sessionOk && !working;
  const regenerate = async () => { if (sel && canRegenerate && onRegenerate && (await onRegenerate(sel.qid, prompt.trim(), runner))) setPrompt(''); };
  useEffect(() => { setText(sel?.text ?? ''); setClasses(sel?.classes ?? ''); setLink(sel?.href ?? ''); setPrompt(''); setMaking(false); setCompError(null); }, [sel?.qid, sel?.text, sel?.classes, sel?.href]);
  // 当前指向的路由若不在项目里（断链）也要能显示出来
  const linkOptions = link && !routes.includes(link) ? [link, ...routes] : routes;

  const apply = async (ops: Parameters<typeof api.screens.editElement>[2], okText = '已更新，截图稍后刷新') => {
    if (!sel) return;
    if (component) {
      setSaving(true);
      try { const r = await api.components.editElement(component.id, sel.qid, ops, component.version); toast(`已更新组件「${component.name}」${r.applied.length ? `，同步 ${r.applied.length} 屏` : ''}`); onEdited(sel.qid); }
      catch (e) {
        if (e instanceof ApiError && e.type === '/errors/component-busy') toast(`组件「${component.name}」正在改，等这一轮完事`, 'error');
        else if (e instanceof ApiError && e.type === '/errors/version-conflict') toast('组件已被更新，重新选一次元素', 'error');
        else if (e instanceof ApiError && e.type === '/errors/element-not-found') toast('这个元素已经不在组件里了', 'error');
        else toast('保存失败', 'error');
      } finally { setSaving(false); }
      return;
    }
    if (!screen?.currentRevisionId) return;
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
      const r = await api.components.create(screen!.projectId, { name, fromScreenId: screen!.id, qid: sel.qid, applyToScreens: compApply });
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
    <Panel title={`检查器 · ${component ? component.name : screen?.name ?? ''}`} className="h-full" actions={<Button size="sm" onClick={onClose}>关闭</Button>}>
      {!sel ? <EmptyState title={component ? '在组件里点选一个元素' : '在屏幕里点选一个元素'} hint="选择模式下移动鼠标会高亮元素，点击即选中；Esc 退出交互。" /> : sel.component && !component ? (
        // 共享组件实例里的元素（REQ-EDIT-006）：直改会在下一次写入时被组件展开顶掉，所以不给字段，只给两个出口
        <div className="scroll flex-1 space-y-4 p-3">
          <div className="text-xs text-muted">&lt;{sel.tag}&gt; · {sel.qid}</div>
          <div className="space-y-2 rounded-md border border-line bg-panel-2 p-3 text-xs" data-testid="el-component-lock" data-component={sel.component}>
            <p className="leading-cn">这是共享组件「<b className="text-fg">{sel.component}</b>」的一部分——改它会同步到所有用它的屏。</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" data-testid="el-edit-component" onClick={() => onEditComponent?.(sel.component!)}>改组件</Button>
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
            <Button size="sm" variant="primary" pending={saving} disabled={busy} onClick={() => { const ops: Parameters<typeof apply>[0] = []; if (text !== sel.text) ops.push({ type: 'text', value: text }); if (classes !== sel.classes) ops.push({ type: 'classes', value: classes }); if (link !== (sel.href ?? '')) ops.push({ type: 'link', value: link || null }); if (ops.length) apply(ops); else toast('没有改动'); }}>保存（零 token）</Button>
            <Button size="sm" variant="danger" pending={saving} disabled={busy} onClick={() => apply([{ type: 'remove' }])}>删除元素</Button>
          </div>
          {/* 记为共享组件（REQ-EDIT-006）：把这个元素存成项目级组件，其他屏里对应的元素（同标签、同层级）可一并换成它。
              目标本身就是组件时不显示——组件里不能再套组件（validateComponentHtml 也会拒） */}
          <div className={`space-y-1.5 border-t border-line pt-3${component ? ' hidden' : ''}`}>
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
          {component ? (
            /* 组件没有子树重生成：整块重写是「改组件」那条路（输入框里以这个组件为目标发一句话），
               它会重写整个组件并回刷所有用它的屏。这里只给指路，不另起一个入口。 */
            <p className="border-t border-line pt-3 text-xs leading-cn text-muted" data-testid="el-component-hint">
              要整块重写这个组件，把它设为输入框的目标说一句话（「改组件」）——那条路会重写整个组件并同步到用它的屏。
            </p>
          ) : (
          <div className="space-y-1.5 border-t border-line pt-3">
            <label htmlFor="el-prompt" className="block text-xs font-medium text-muted">用 AI 重生成这块</label>
            <textarea id="el-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-sm" placeholder="例如：改成横向滑动的卡片列表" disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void regenerate(); } }} />
            {/* 通道单独选：与输入框同一套控件；本机 agent 时还要选投给哪个会话。面板 20rem 宽，两个下拉放不下时折行 */}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="el-runner">
              {runners.length > 0 && <RunnerSelect runners={runners} value={runnerId} onChange={pickRunner} disabled={busy} testId="el-runner-select" />}
              {agent && <SessionSelect sessions={sessions} value={sessionId} onChange={pickSession} onOpen={onSessionsOpen ?? (() => {})} disabled={busy} testId="el-session-select" />}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!canRegenerate} pending={busy} onClick={() => void regenerate()}>重生成选中区域</Button>
              <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-sans text-[10px] text-muted">Shift+Enter</kbd>
            </div>
            {working && <p className="text-[11px] text-accent-strong" data-testid="el-working">这块正在修改中，回写后会标「已更新」</p>}
            {agent && !sessionOk && !working && <p className="text-[11px] text-warn">先选要投递的会话</p>}
          </div>
          )}
        </div>
      )}
    </Panel>
  );
}
