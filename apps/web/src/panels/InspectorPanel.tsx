import { useEffect, useRef, useState } from 'react';
import type { ScreenDto, ComponentDto, RunnerOptionDto, AgentTool, Runner, Tokens, ElementPathItem } from '@quilt/core';
import type { SessionList } from '@/composer/useRunnerPrefs';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, EmptyState, Input, Panel } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { RunnerSelect, SessionSelect } from '@/composer/Composer';
import { ClassList } from './ClassList';
import { sameClasses, splitClasses } from '@/lib/twClass';

// Radix Select 不接受空字符串作为选项值（空串是「未选中」的内部语义），空态用哨兵值代替
const NO_LINK = '__none__';
// 按钮提示里的修饰键写法，与画布工具栏一致
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

// 元素检查器（REQ-EDIT-001 / REQ-EDIT-002）：本地直改零 token；AI 只重生成选中子树。
// component（REQ-EDIT-006）：元素所在的共享组件名——在组件里的元素不直改，给「改组件 / 脱离共享」两个出口
export type ElementSel = { qid: string; tag: string; text: string; classes: string; href: string | null; component: string | null; rect: { x: number; y: number; w: number; h: number }; path?: ElementPathItem[] };
// classes 按行存（v0.96 一行一个）：打到一半的空行、带空格的行要能留着，保存时才规范化
type ElementDraft = { base: string; text?: string; classes?: string[]; link?: string; prompt?: string };
// 直改落库后报给画布的撤销栈（v0.95）：屏的直改记下改前改后两版，⌘Z 回溯到改前那一版；组件的直改撤不了，只报一声占住这一步
export type DirectEdit = { screenId: string; before: string; after: string; label: string } | { componentName: string };
// 检查器的键盘等价物（v0.95）：⌘S、Delete / Backspace 由画布的键位表调这两个；没有可直改的选中元素时为 null
export type InspectorKeys = { save: () => void; remove: () => void };
const SUBTREE_RUNNER_KEY = 'quilt:runner:subtree';
// 子树重生成的投递会话按工具分开记（v0.68）：Claude Code 会话 id 与 Codex 线程 id 互不相干
const SUBTREE_SESSION_KEY: Record<AgentTool, string> = { 'claude-code': 'quilt:agent-session:subtree', codex: 'quilt:agent-session:subtree:codex' };
const readKey = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
// 「记为共享组件」的默认名：按元素标签给个常见叫法，用户可改
const COMPONENT_NAME_BY_TAG: Record<string, string> = { nav: 'TabBar', header: 'AppBar', aside: 'Sidebar', footer: 'Footer' };
// 逐级选（v1.00 REQ-EDIT-001）：从屏根到锚点（最近一次点中的最里层元素）的祖先路径。当前层加粗、带 aria-current；
// 当前层以下（回锚点的那几级）淡色仍可点。点一级选中它，悬停一级在屏上画悬停框。
// 按钮不进 Tab 序：键盘走层级用 Shift+Enter / Enter，Tab 要从检查器直接进文案框
function ElementPath({ sel, onPick, onPeek }: { sel: ElementSel; onPick?: (qid: string) => void; onPeek?: (qid: string | null) => void }) {
  const path = sel.path?.length ? sel.path : [{ qid: sel.qid, tag: sel.tag }];
  const at = path.findIndex((p) => p.qid === sel.qid);
  return (
    <div className="space-y-1">
      <nav aria-label="元素层级" data-testid="el-path">
        <ol className="flex flex-wrap items-center gap-y-0.5 text-xs">
          {path.map((p, i) => (
            <li key={p.qid} className="flex items-center">
              {i > 0 && <span aria-hidden className="px-0.5 text-muted">›</span>}
              <button type="button" tabIndex={-1} data-qid={p.qid} aria-current={i === at ? 'location' : undefined} title={`${p.tag} · ${p.qid}`}
                className={`inline-flex h-6 items-center rounded-md px-1.5 font-mono hover:bg-panel-2 ${i === at ? 'font-semibold text-fg' : i > at ? 'text-muted opacity-60' : 'text-muted'}`}
                onClick={() => onPick?.(p.qid)} onMouseEnter={() => onPeek?.(p.qid)} onMouseLeave={() => onPeek?.(null)}>
                {p.tag}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <p className="text-xs text-muted">Shift+Enter 选父级 · Enter 回到子级</p>
    </div>
  );
}

// 目标是一张屏，或一个共享组件（v0.57 `REQ-EDIT-006`）——组件也能选元素直改，op 与屏同一套，
// 只是落在组件自己的 HTML 上、乐观并发用版本号，改完由服务端回刷所有用它的屏。
// 组件没有 AI 子树重生成（整块重写走输入框的「改组件」）、没有批注、也不能再「记为共享组件」。
export function InspectorPanel({ screen, component, sel, routes = [], busy, runners = [], composerRunnerId = '', sessionLists, onSessionsOpen, workingQids = [], onClose, onEdited, onRegenerate, onEditComponent, keysRef, onDirectEdit, tokens, onPathPick, onPathPeek }: { screen?: ScreenDto; component?: ComponentDto; sel: ElementSel | null; routes?: string[]; busy: boolean; runners?: RunnerOptionDto[]; composerRunnerId?: string; sessionLists?: Record<AgentTool, SessionList>; onSessionsOpen?: (tool: AgentTool) => void; workingQids?: string[]; onClose: () => void; onEdited: (qid: string) => void; onRegenerate?: (qid: string, prompt: string, runner: Runner | undefined) => Promise<boolean>; onEditComponent?: (name: string) => void; keysRef?: { current: InspectorKeys | null }; onDirectEdit?: (e: DirectEdit) => void; tokens?: Tokens; onPathPick?: (qid: string) => void; onPathPeek?: (qid: string | null) => void }) {
  const toast = useToast();
  // 改了没存的文案 / 类名 / 跳转与重生成说明按元素暂存（v0.78）：点别的元素再点回来还在。
  // 直改三格记着起草时元素的原值：元素本身变了（保存后热更新重选、别处改了它）就作废、回到新值；说明不随元素内容作废
  const [drafts, setDrafts] = useState<Record<string, ElementDraft>>({});
  const draftKey = sel ? `${component?.id ?? screen?.id}:${sel.qid}` : '';
  const base = sel ? JSON.stringify([sel.text, sel.classes, sel.href ?? '']) : '';
  const draft = drafts[draftKey];
  const fresh = draft?.base === base ? draft : undefined;
  const text = fresh?.text ?? sel?.text ?? '';
  const classRows = fresh?.classes ?? splitClasses(sel?.classes ?? '');
  const link = fresh?.link ?? sel?.href ?? '';
  const prompt = draft?.prompt ?? '';
  const edit = (patch: Omit<ElementDraft, 'base'>) => setDrafts((m) => ({ ...m, [draftKey]: { ...(m[draftKey]?.base === base ? m[draftKey] : { prompt: m[draftKey]?.prompt }), ...patch, base } }));
  const [saving, setSaving] = useState(false);
  // 记为共享组件（REQ-EDIT-006）：内联表单，名字 + 要不要同步替换其他屏里对应的元素
  const [making, setMaking] = useState(false);
  const [compName, setCompName] = useState('');
  const [compApply, setCompApply] = useState(true);
  const [compError, setCompError] = useState<string | null>(null);
  const [compBusy, setCompBusy] = useState(false);
  // 子树重生成的通道（REQ-EDIT-002）：与输入框同一套选择器，但记忆独立——局部改动常只要更快的模型；第一次沿用输入框当前通道（INT-007 / INT-021）
  const [runnerPick, setRunnerPick] = useState(() => { try { return localStorage.getItem(SUBTREE_RUNNER_KEY) ?? ''; } catch { return ''; } });
  const [sessionIds, setSessionIds] = useState<Record<AgentTool, string>>(() => ({ 'claude-code': readKey(SUBTREE_SESSION_KEY['claude-code']), codex: readKey(SUBTREE_SESSION_KEY.codex) }));
  const runnerId = runners.some((r) => r.id === runnerPick && r.available) ? runnerPick : composerRunnerId;
  const runnerOpt = runners.find((r) => r.id === runnerId);
  const tool: AgentTool | null = runnerOpt?.runner.kind === 'agent' ? runnerOpt.runner.tool : null;
  const agent = !!tool;
  const list = tool ? sessionLists?.[tool] : undefined;
  const sessions = list?.items ?? null;
  const sessionId = tool ? sessionIds[tool] : '';
  const sessionOk = !agent || !!sessions?.some((s) => s.sessionId === sessionId);
  const openRef = useRef(onSessionsOpen);
  openRef.current = onSessionsOpen;
  useEffect(() => { if (tool) openRef.current?.(tool); }, [tool]);
  const pickRunner = (id: string) => { setRunnerPick(id); try { localStorage.setItem(SUBTREE_RUNNER_KEY, id); } catch { /* 无痕模式写不了 */ } };
  const pickSession = (id: string) => {
    if (!tool || !id) return; // 空串来自 Radix 隐藏原生 <select> 的回报，不是用户的选择（见 useRunnerPrefs）
    setSessionIds((m) => ({ ...m, [tool]: id }));
    try { localStorage.setItem(SUBTREE_SESSION_KEY[tool], id); } catch { /* 无痕模式写不了 */ }
  };
  const runner: Runner | undefined = runnerOpt?.runner.kind === 'agent' ? { ...runnerOpt.runner, sessionId } : runnerOpt?.runner;
  // 重生成：按钮或文本框里 Shift+Enter（这里是多行说明，Enter 留给换行，与输入框的 Enter 发送不同）。
  // 发出成功只清说明框，选中不动——面板留在这个元素上；建作业被拒（屏忙等）时说明保留
  // 这块已有作业在改（本机会话投递的作业不占 busy，靠这个挡重复发起；屏锁在服务端还有一道 409）
  const working = !!sel && workingQids.includes(sel.qid);
  const canRegenerate = !!sel && !!onRegenerate && !!prompt.trim() && !busy && sessionOk && !working;
  const regenerate = async () => { if (sel && canRegenerate && onRegenerate && (await onRegenerate(sel.qid, prompt.trim(), runner))) edit({ prompt: '' }); };
  useEffect(() => { setMaking(false); setCompError(null); }, [sel?.qid, sel?.text, sel?.classes, sel?.href]);
  // 当前指向的路由若不在项目里（断链）也要能显示出来
  const linkOptions = link && !routes.includes(link) ? [link, ...routes] : routes;

  const apply = async (ops: Parameters<typeof api.screens.editElement>[2], okText = '已更新，截图稍后刷新') => {
    if (!sel) return;
    if (component) {
      setSaving(true);
      try { const r = await api.components.editElement(component.id, sel.qid, ops, component.version); toast(`已更新组件「${component.name}」${r.applied.length ? `，同步 ${r.applied.length} 屏` : ''}`); onDirectEdit?.({ componentName: component.name }); onEdited(sel.qid); }
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
    try {
      const { revision } = await api.screens.editElement(screen.id, sel.qid, ops, screen.currentRevisionId);
      toast(okText);
      onDirectEdit?.({ screenId: screen.id, before: screen.currentRevisionId, after: revision.id, label: ops.some((o) => o.type === 'remove') ? '删除元素' : ops.some((o) => o.type === 'detach') ? '脱离共享' : '修改元素' });
      onEdited(sel.qid);
    }
    catch (e) {
      if (e instanceof ApiError && e.type === '/errors/lint-failed') toast('改动违反设计契约（只能用 token 色与预设类）', 'error');
      else if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast('屏幕已被更新，请重新选择', 'error');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中', 'error');
      // 选中时还不在组件里、保存时已经在了（别处刚把它记成了组件）：服务端兜底 409
      else if (e instanceof ApiError && e.type === '/errors/component-locked') toast('这个元素属于共享组件，改组件或先脱离共享', 'error');
      else toast('保存失败', 'error');
    } finally { setSaving(false); }
  };
  const save = () => {
    if (!sel) return;
    const ops: Parameters<typeof apply>[0] = [];
    if (text !== sel.text) ops.push({ type: 'text', value: text });
    if (!sameClasses(classRows.join(' '), sel.classes)) ops.push({ type: 'classes', value: splitClasses(classRows.join(' ')).join(' ') });
    if (link !== (sel.href ?? '')) ops.push({ type: 'link', value: link || null });
    if (ops.length) void apply(ops); else toast('没有改动');
  };
  const remove = () => void apply([{ type: 'remove' }]);
  // 点屏里的元素之后焦点停在 iframe 里（v0.95）：父页收不到 ⌘S / Delete，Tab 也进不了检查器，得先点一下面板。挪到检查器的内容区——
  // 只在焦点确实在画布的 iframe 上（刚点过元素）时挪；保存后的重选、别处回写这类被动更新发生时焦点在别处，不抢（INT-008）。
  // 不直接落进「文案」框：那样 Delete 就成了删字
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (sel && document.activeElement instanceof HTMLIFrameElement) bodyRef.current?.focus({ preventScroll: true }); }, [sel]);
  // 键盘等价物（v0.95）：与按钮同样的可用条件——共享组件实例里的元素没有这两个操作，保存中或屏忙时不响应
  const keyable = !!sel && !(sel.component && !component);
  useEffect(() => {
    if (!keysRef) return;
    keysRef.current = keyable ? { save: () => { if (!busy && !saving) save(); }, remove: () => { if (!busy && !saving) remove(); } } : null;
    return () => { keysRef.current = null; };
  });
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
        <div ref={bodyRef} tabIndex={-1} className="scroll flex-1 space-y-4 p-3 focus:outline-none">
          <ElementPath sel={sel} onPick={onPathPick} onPeek={onPathPeek} />
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
        <div ref={bodyRef} tabIndex={-1} className="scroll flex-1 space-y-4 p-3 focus:outline-none" data-testid="inspector-body">
          <ElementPath sel={sel} onPick={onPathPick} onPeek={onPathPeek} />
          <div className="text-xs text-muted">&lt;{sel.tag}&gt; · {sel.qid}</div>
          <div className="space-y-1.5">
            <label htmlFor="el-text" className="block text-xs font-medium text-muted">文案</label>
            <input id="el-text" value={text} onChange={(e) => edit({ text: e.target.value })} className="h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm" placeholder="（无直接文本）" />
          </div>
          <div className="space-y-1.5">
            <div id="el-classes-label" className="text-xs font-medium text-muted">类名（Tailwind，一行一个，只能用 token 色）</div>
            <ClassList rows={classRows} onChange={(rows) => edit({ classes: rows })} tokens={tokens} labelledBy="el-classes-label" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="el-link" className="block text-xs font-medium text-muted">跳转到（{sel.tag === 'a' ? 'href' : sel.tag === 'form' ? '提交后 action' : 'data-href'}）</label>
            <Select id="el-link" data-testid="el-link" value={link || NO_LINK} onChange={(v) => edit({ link: v === NO_LINK ? '' : v })} aria-label="跳转目标"
              options={[{ value: NO_LINK, label: '不跳转' }, ...linkOptions.map((r) => ({ value: r, label: r, hint: routes.includes(r) ? undefined : '断链' }))]} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" pending={saving} disabled={busy} onClick={save} title={`保存（${MOD}S）`} aria-keyshortcuts="Meta+S Control+S">保存（零 token）</Button>
            <Button size="sm" variant="danger" pending={saving} disabled={busy} onClick={remove} title="删除元素（Delete）" aria-keyshortcuts="Delete Backspace">删除元素</Button>
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
            <textarea id="el-prompt" value={prompt} onChange={(e) => edit({ prompt: e.target.value })} rows={3} className="w-full resize-none rounded-md border border-line bg-canvas p-2 text-sm" placeholder="例如：改成横向滑动的卡片列表" disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void regenerate(); } }} />
            {/* 通道单独选：与输入框同一套控件；本机 agent 时还要选投给哪个会话。面板 20rem 宽，两个下拉放不下时折行 */}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="el-runner">
              {runners.length > 0 && <RunnerSelect runners={runners} value={runnerId} onChange={pickRunner} disabled={busy} testId="el-runner-select" />}
              {tool && <SessionSelect tool={tool} sessions={sessions} reason={list?.reason} value={sessionId} onChange={pickSession} onOpen={() => onSessionsOpen?.(tool)} disabled={busy} testId="el-session-select" />}
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
