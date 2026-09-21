import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { useNavigate } from 'react-router';
import { Select } from 'radix-ui';
import { ArrowUp, Check, ChevronDown, ChevronUp, ImagePlus, MapPin, Settings2, Square, X } from 'lucide-react';
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_VERSIONS, SCREEN_COUNT_OPTIONS, estimateJob, type ScreenDto, type ComponentDto, type RunnerOptionDto, type AgentSessionDto, type ScreenCount } from '@quilt/core';
import { IconButton } from './ui';
import { VendorIcon } from './VendorIcon';

export type ComposerHandle = { focus: () => void };
/** 一行在跑作业（REQ-CORE-020）：label = 它在做什么，progress = 当前阶段 */
export type RunningJob = { id: string; label: string; progress: string | null };
/** 输入框的动词模式（REQ-CORE-023）：design = 造 / 改（动词由目标决定）；chat = 交给助手定范围 */
export type ComposerMode = 'design' | 'chat';
export type ComposerProps = {
  mode: ComposerMode;
  onMode: (m: ComposerMode) => void;
  /** 在跑的作业，按创建时间倒序（最新在最前）；只含非 agent 的，agent 作业在本机 agent 面板 */
  running: RunningJob[];
  /** 这一轮与在跑作业冲突时的理由；非 null 就挡住发送，但不锁输入（REQ-CORE-020） */
  blockedReason: string | null;
  /** 目标屏 = 改；为空 = 造（REQ-CORE-006 三条原则之一） */
  targets: ScreenDto[];
  /** 共享组件目标（REQ-EDIT-006）：只有组件、没有屏也没有锚点 = 改这个组件；与屏 / 锚点同在 = 它们的完整 HTML 进上下文 */
  componentTargets: ComponentDto[];
  onRemoveComponentTarget: (id: string) => void;
  /** 项目总屏数：目标等于全部时动词行写「改全部」 */
  totalScreens: number;
  /** 双击空白处放下的锚点（REQ-CORE-014）；有它就是「造 · 此处」 */
  anchor: { x: number; y: number } | null;
  maxTargets: number;
  count: ScreenCount;
  versions: number;
  onCount: (c: ScreenCount) => void;
  onVersions: (v: number) => void;
  /** 返回是否发出去了：false 时草稿与参考图留着（REQ-CORE-020） */
  onSend: (content: string, attachmentIds: string[]) => Promise<boolean>;
  /** 参考图上传（REQ-CORE-012）：返回 attachmentId */
  onUploadImage: (file: File) => Promise<string>;
  onCancelJob: (jobId: string) => void;
  onError: (msg: string) => void;
  onRemoveTarget: (id: string) => void;
  onRemoveAnchor: () => void;
  onClearTargets: () => void;
  /** 生成通道（REQ-CORE-011）：这一轮由谁来做；聊天模式下父组件只传 agent-sdk 通道（REQ-CORE-023） */
  runners: RunnerOptionDto[];
  runnerId: string;
  onRunnerChange: (id: string) => void;
  /** 本机 agent（REQ-AGENT-003 v0.34）：通道是「交给本机 Claude Code」时还要选投给哪个会话；列表打开时由父组件刷新，null = 还没取到 */
  sessions: AgentSessionDto[] | null;
  sessionId: string;
  onSessionChange: (id: string) => void;
  onSessionsOpen: () => void;
  /** 收起（⌘/ / 聚焦某屏时自动）：只是不显示，草稿与参考图都留着，所以不卸载 */
  hidden: boolean;
  /** 实际高度（px）：外壳用它算画布安全区的底部占位与对话记录的落点——输入框随内容增高、窄视口下工具条折行，写死一个数会压住别的浮层 */
  onResize?: (heightPx: number) => void;
  handle?: Ref<ComposerHandle>;
};

// 空闲且没有目标时轮播的示例：让第一次进来的人知道能说什么
const IDLE_PHRASES = [
  '描述要造的屏，或选中一屏后说怎么改',
  '例如：一个记账 APP，首页、记一笔、统计三屏',
  '例如：结账流程：购物车、填地址、支付、完成',
  '例如：给列表页加下拉刷新和空态',
];
// 聊天模式的示例（REQ-CORE-023）：说清楚既能问也能改，范围由助手定
const CHAT_PHRASES = [
  '问点什么，或直接说要改什么：例如 整体更活泼一点',
  '例如：导航放底部还是顶部更合适？',
  '例如：把刚才那个改回去',
];
const ROTATE_MS = 3200;
/** 在跑作业最多摆几行，其余折成一条「+N」（REQ-CORE-020）：最新那行永不被折进去 */
const MAX_ROWS = 3;

/** 待发的参考图：key 是本地身份，id 是上传完成后服务端给的；id 为 null 表示还在传 */
type Shot = { key: string; url: string; name: string; id: string | null };

// 底部输入框（REQ-CORE-003 / REQ-CORE-006）：动词由目标决定——有目标标签是改、没有是造；额度耗尽引导设置页。
// 有作业在跑不锁输入（REQ-CORE-020）：只有这一轮与在跑作业真冲突时才挡住发送键并就地写出理由。
// 不自动聚焦——焦点默认留在画布上，单键快捷键（F/L…）才可用；放锚点时由父组件显式聚焦。
// 结构：在跑作业行 → 目标区（标签 + 动词行 + 清空）→ 输入区 → 工具条（通道 ｜ 参考图 ｜ 屏数 · 版数 ｜ 发送）。外壳的材质与投影在 styles.css 的 .composer。
export function Composer(p: ComposerProps) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dropping, setDropping] = useState(false);
  // 参考图：本地先用 objectURL 立刻显示缩略图，上传在后台跑；id 到了再回填
  const [shots, setShots] = useState<Shot[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useImperativeHandle(p.handle, () => ({ focus: () => taRef.current?.focus() }), []);
  // 把实际高度报给外壳（收起时 display:none 量到 0，不报）
  const onResize = p.onResize;
  useEffect(() => {
    const el = formRef.current;
    if (!el || !onResize) return;
    const ro = new ResizeObserver(() => { const h = el.getBoundingClientRect().height; if (h > 0) onResize(h); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);
  const visionOk = p.runners.find((r) => r.id === p.runnerId)?.vision !== false;
  // 投给谁：通道是本机 agent 时必须选一个还活着的会话；记住的会话不在活列表里就当没选，不自动换人
  const agentRunner = p.runners.find((r) => r.id === p.runnerId)?.runner.kind === 'agent';
  const sessionOk = !agentRunner || !!p.sessions?.some((s) => s.sessionId === p.sessionId);
  // 聊天（REQ-CORE-023）：动词不由目标决定，目标标签只是上下文提示；通道清单已由父组件收窄到 agent-sdk，一条都没有就挡住发送
  const chat = p.mode === 'chat';
  const chatChannelOk = !chat || p.runners.some((r) => r.available);
  // 有作业在跑只影响两件事：工具条的亮度（data-busy）与在跑作业行的显示，不作为任何禁用条件（REQ-CORE-020）
  const busy = p.running.length > 0;
  const creating = p.targets.length === 0;
  const one = p.targets.length === 1 ? p.targets[0] : null;
  const over = p.targets.length > p.maxTargets;
  const all = !creating && p.totalScreens > 0 && p.targets.length >= p.totalScreens;
  // 共享组件目标（REQ-EDIT-006）：只有组件、没有屏也没有锚点 = 改组件（一次一个，多选由父组件的 blockedReason 挡）；否则只是上下文
  const comps = p.componentTargets;
  const compNames = comps.map((c) => c.name).join('、');
  const compOnly = !chat && comps.length > 0 && creating && !p.anchor;
  const compSuffix = comps.length && !compOnly ? ` · ${creating ? '用' : '带'}组件 ${compNames}` : '';

  // 随内容增高；上限只有一个来源——styles.css 里 .composer textarea 的 max-height，到顶后内部滚动（INT-010）
  // 收起期间 display:none 量不到高度，叫回时要重量一次
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el || p.hidden) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, p.hidden]);

  // 卸载时回收 objectURL，否则贴一次图泄一块内存
  useEffect(() => () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); }, [shots]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    // 通道不支持视觉时在这里就拦住。护栏必须落在贴图这一刻——贴图、拖入、点按钮三条路都经过这里；
    // 只在发送时拦的话，用户已经传完了才被告知白传（服务端那道校验仍在，防绕过）
    if (!visionOk) { p.onError('当前通道不支持参考图，先在左下角换一个支持的通道'); return; }
    const imgs = files.filter((f) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(f.type));
    const rejected = files.length - imgs.length;
    if (rejected) p.onError(`有 ${rejected} 个文件不是 PNG / JPEG / WebP，已跳过`);
    const room = MAX_ATTACHMENTS_PER_MESSAGE - shots.length;
    if (imgs.length > room) p.onError(`一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张参考图`);
    for (const file of imgs.slice(0, Math.max(0, room))) {
      if (file.size > MAX_ATTACHMENT_BYTES) { p.onError(`「${file.name}」超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`); continue; }
      const key = crypto.randomUUID();
      setShots((prev) => [...prev, { key, url: URL.createObjectURL(file), name: file.name, id: null }]);
      try {
        const id = await p.onUploadImage(file);
        setShots((prev) => prev.map((s) => (s.key === key ? { ...s, id } : s)));
      } catch {
        setShots((prev) => prev.filter((s) => s.key !== key));
        p.onError(`「${file.name}」上传失败`);
      }
    }
  };
  const removeShot = (key: string) => setShots((prev) => { prev.filter((s) => s.key === key).forEach((s) => URL.revokeObjectURL(s.url)); return prev.filter((s) => s.key !== key); });

  const uploading = shots.some((s) => !s.id);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const content = text.trim();
    if (!content || sending || p.blockedReason || uploading || !sessionOk || !chatChannelOk) return;
    setSending(true);
    try {
      // 没发出去（撞上 409 / 限流 / 会话失效）就留着草稿与参考图，不把用户的输入吞掉（REQ-CORE-020）
      const sent = await p.onSend(content, shots.map((s) => s.id!).filter(Boolean));
      if (sent) {
        setText('');
        shots.forEach((s) => URL.revokeObjectURL(s.url));
        setShots([]);
      }
    } finally { setSending(false); }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDropping(false);
    addFiles([...e.dataTransfer.files]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); return; }
    // 输入框内 Esc：有草稿清草稿、无草稿失焦；都不清目标标签（REQ-CORE-006）
    if (e.key === 'Escape') { e.stopPropagation(); if (text) setText(''); else taRef.current?.blur(); }
  };

  // 动词行（REQ-CORE-006）：屏数 × 版数写全；任一档位 > 1 时追加预计调用数，取值与服务端同一个 estimateJob
  const n = creating ? (p.count === 'auto' ? 5 : p.count) : Math.min(p.targets.length, p.maxTargets);
  const estimate = creating
    ? estimateJob({ kind: 'generate', input: { prompt: 'x', count: p.count, versions: p.versions } }, p.totalScreens)
    : estimateJob({ kind: 'edit_screens', input: { prompt: 'x', screenIds: p.targets.slice(0, p.maxTargets).map((t) => t.id), versions: p.versions } }, p.totalScreens);
  const many = p.versions > 1 || (creating && (p.count === 'auto' || p.count > 1));
  // 本机 agent 通道固定 1 版、屏数由会话自定：动词行只说去向，档位控件也不显示
  // 聊天：范围由助手定，动词行只说这句话「关于」什么（选中的屏是上下文提示，不是目标锁）
  const verb = chat
    ? `聊 · ${one ? `关于「${one.name}」` : p.targets.length ? `关于 ${p.targets.length} 屏` : '整个项目'}`
    : compOnly
    ? (comps.length === 1 ? `改组件「${comps[0].name}」 · 同步 ${comps[0].usedBy.length} 屏` : `改组件 · ${comps.length} 个`)
    : agentRunner
    ? `${creating ? `造屏 · 交给本机会话${p.anchor ? ' · 此处' : ''}` : `改${all ? '全部' : ''} ${n} 屏 · 交给本机会话`}${compSuffix}`
    : creating
      ? `造${p.count === 'auto' ? '一组屏' : ` ${n} 屏`}${p.versions > 1 ? ` × ${p.versions} 版` : ''} · ${p.anchor ? '此处' : '自动摆放'}${many ? ` = ${estimate.calls} 次调用` : ''}${compSuffix}`
      : `改${all ? '全部' : ''} ${n} 屏${p.versions > 1 ? ` × ${p.versions} 版` : ''}${many ? ` = ${estimate.calls} 次调用` : ''}${compSuffix}`;

  const phrases = chat
    ? (p.targets.length ? [`关于${one ? `「${one.name}」` : `选中的 ${p.targets.length} 屏`}问点什么，或说要怎么改`] : CHAT_PHRASES)
    : compOnly && comps.length === 1 ? [`修改组件「${comps[0].name}」：例如 tab 改成 3 个、图标换成描边`]
    : one ? [`修改「${one.name}」：例如 改成分组列表`]
    : p.targets.length ? [`修改选中的 ${p.targets.length} 屏：例如 统一把顶部导航改成标签栏`]
    : p.anchor ? ['描述要在这里造的屏：例如 订单详情页，顶部是状态时间线，下面是商品清单']
    : IDLE_PHRASES;

  return (
    <form
      ref={formRef} className="composer absolute bottom-4 z-20 p-3.5" onSubmit={submit} hidden={p.hidden}
      data-has-text={text ? '' : undefined} data-busy={busy ? '' : undefined} data-dropping={dropping ? '' : undefined} data-verb={chat ? 'chat' : compOnly ? 'component' : creating ? 'create' : 'edit'}
      onPaste={onPaste} onDrop={onDrop}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
    >
      <label htmlFor="chat-input" className="sr-only">对话输入</label>
      {/* 在跑作业行（REQ-CORE-020）：每行 = 在做什么 + 进度 + 取消键，最新的在最上（Esc 取消的就是它）。
          必须渲染在 form 内部——外壳的 --chrome-bottom 只量这个 form，另起一层浮层会压住画布底边与对话记录横条。
          不挂 aria-live：N 个作业各自每几秒一次进度会把读屏刷爆，播报归对话记录的 role=log */}
      {busy && (
        <ul className="mb-2.5 space-y-1 px-0.5" aria-label="进行中的作业" data-testid="running-jobs">
          {p.running.slice(0, MAX_ROWS).map((j, i) => (
            <li key={j.id} data-testid="running-job" data-job-id={j.id} className="fade-up flex items-center gap-2 rounded-lg bg-panel-2 py-1 pl-2.5 pr-1 text-xs">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-fg">{j.label}</span>
                {/* 进度必须有兜底：progress 只来自实时事件流，首次加载认领来的作业（本机会话 / 另一个标签页建的）
                    在下一个事件到达前是空的，只写标签的行看起来是卡住的。口径与对话气泡的空回执一致 */}
                <span className="text-muted"> · {j.progress ?? '排队中…'}</span>
              </span>
              {/* 最新那行的取消键标出 Esc：优先级链里 Esc 取消的正是这一个 */}
              <IconButton
                size="xs" tip="top-end" label={`取消${j.label}`} hint={i === 0 ? 'Esc' : undefined}
                data-testid="cancel-job" onClick={() => p.onCancelJob(j.id)}
              ><Square size={11} fill="currentColor" /></IconButton>
            </li>
          ))}
          {p.running.length > MAX_ROWS && (
            <li className="px-2.5 text-xs text-muted">+{p.running.length - MAX_ROWS} 个作业在跑</li>
          )}
        </ul>
      )}
      {/* 目标区始终存在：标签（屏 / 锚点，可逐个移除）+ 动词行 + 清空。标签只被点屏 / × / 清空改变，点画布空白不动它 */}
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-label="本次的目标">
          {p.anchor && (
            <li className="inline-flex items-center gap-1 rounded-full bg-panel-2 py-1 pl-2.5 pr-1 text-xs font-medium text-fg" data-testid="anchor-chip">
              <MapPin size={12} aria-hidden="true" /><span>新屏 · 此处</span>
              <button type="button" aria-label="取消锚点" onClick={p.onRemoveAnchor} className="grid size-5 place-items-center rounded-full text-muted transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><X size={12} /></button>
            </li>
          )}
          {p.targets.map((t, i) => (
            <li key={t.id} className={`inline-flex items-center gap-1.5 rounded-full bg-panel-2 py-1 pl-2.5 pr-1 text-xs font-medium ${i < p.maxTargets ? 'text-fg' : 'text-warn'}`} data-testid="target-chip">
              <span className="max-w-32 truncate">{t.name}</span>
              <button type="button" aria-label={`不再以「${t.name}」为目标`} onClick={() => p.onRemoveTarget(t.id)} className="grid size-5 place-items-center rounded-full text-muted transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                <X size={12} />
              </button>
            </li>
          ))}
          {/* 共享组件目标（REQ-EDIT-006）：与屏标签同一排、同一形状，前缀「组件 ·」区分 */}
          {p.componentTargets.map((c) => (
            <li key={c.id} className="inline-flex items-center gap-1.5 rounded-full bg-panel-2 py-1 pl-2.5 pr-1 text-xs font-medium text-fg" data-testid="component-chip" data-name={c.name}>
              <span className="max-w-40 truncate">组件 · {c.name}</span>
              <button type="button" aria-label={`不再以组件「${c.name}」为目标`} onClick={() => p.onRemoveComponentTarget(c.id)} className="grid size-5 place-items-center rounded-full text-muted transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                <X size={12} />
              </button>
            </li>
          ))}
          {/* 动词行是变长文本：放在可截断的 flex 项里，改字不挤动旁边的按钮（RESP-010） */}
          <li className={`min-w-0 truncate text-xs ${over && !chat ? 'text-warn' : 'text-muted'}`} data-testid="verb-line" aria-live="polite">
            {over && !chat ? `已选 ${p.targets.length} 屏，一次最多改 ${p.maxTargets} 屏，只会发送前 ${p.maxTargets} 屏` : verb}
          </li>
        </ul>
        {(p.targets.length > 0 || p.anchor || p.componentTargets.length > 0) && (
          <button type="button" data-testid="clear-targets" onClick={p.onClearTargets} className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">清空</button>
        )}
      </div>
      {shots.length > 0 && (
        <ul className="mb-2.5 flex flex-wrap gap-2 px-0.5" aria-label="本次参考图">
          {shots.map((sh) => (
            <li key={sh.key} className="group relative">
              <img src={sh.url} alt={sh.name} className="size-16 rounded-lg border border-line object-cover" />
              {!sh.id && <span className="absolute inset-0 grid place-items-center rounded-lg bg-ink/60 text-[10px] text-fg">上传中…</span>}
              <button
                type="button" aria-label={`移除参考图「${sh.name}」`} onClick={() => removeShot(sh.key)}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line bg-panel text-muted transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              ><X size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative min-h-7">
        {/* 可见的占位文案是这层叠在上面的 span：能轮播、能带动效；原生 placeholder 仍在（透明），给读屏与测试用。聚焦后隐去，输入区只剩光标 */}
        <Placeholder phrases={phrases} active={text.length === 0 && !focused} />
        <textarea
          id="chat-input" ref={taRef} name="content" rows={1} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          className="scroll relative z-10 block w-full resize-none bg-transparent px-1 text-[15px] leading-7 text-fg caret-fg placeholder:text-transparent focus-visible:outline-none"
          placeholder={phrases[0]}
        />
      </div>
      {/* 冲突理由就地写在发送键上方：发送键只是 aria-disabled，输入照旧可改——换个目标或等这一轮完事就能发（A11Y-007 / IA-009） */}
      {p.blockedReason && <p data-testid="send-blocked-reason" role="status" className="mt-2 px-1 text-right text-xs text-warn">{p.blockedReason}</p>}
      {/* 工具条允许换行：390px 视口放不下「通道 + 参考图 + 屏数 + 版数 + 发送」一整行，右侧档位组折到下一行而不是撑破外框 */}
      <div className="composer-bar mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* 动词段控（REQ-CORE-023）：造 / 改（动词由目标决定）与聊天（范围由助手定）并列；选择是个人偏好，父组件跨会话记忆 */}
          <Segmented label="动词：造 / 改，或聊天" testId="mode" value={p.mode} options={[{ value: 'design', label: '造 / 改' }, { value: 'chat', label: '聊天' }]} onChange={p.onMode} />
          {/* 通道选择（REQ-CORE-011）。清单来自服务端，只含标识与显示名；聊天模式只列 agent-sdk 通道，一条都没有就就地写明去哪加（INT-013） */}
          {p.runners.length > 0 && <RunnerSelect runners={p.runners} value={p.runnerId} onChange={p.onRunnerChange} />}
          {chat && !chatChannelOk && (
            <button type="button" data-testid="chat-no-channel" onClick={() => navigate('?settings=runners')} className="min-w-0 truncate rounded-md px-1.5 py-1 text-xs text-warn transition-colors duration-[var(--duration-fast)] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
              聊天需要「本机 Claude 订阅」通道，去设置页添加
            </button>
          )}
          {/* 投递会话（REQ-AGENT-003 v0.34）：只在通道是本机 agent 时出现，与通道选择一样跨会话记忆 */}
          {agentRunner && <SessionSelect sessions={p.sessions} value={p.sessionId} onChange={p.onSessionChange} onOpen={p.onSessionsOpen} />}
          {/* 参考图入口（REQ-CORE-012）。贴图与拖入同样可用，这个按钮是给不知道能贴的人看的 */}
          <input
            ref={fileRef} type="file" accept={IMAGE_MEDIA_TYPES.join(',')} multiple className="sr-only" tabIndex={-1}
            onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
          />
          <IconButton
            size="sm" label="加参考图" desc="贴图、拖进来或点这里选；至多 4 张，发给模型作为风格参照" tip="top"
            data-testid="add-image" onClick={() => fileRef.current?.click()}
            unavailable={!visionOk && '当前通道不支持参考图，先换一个通道'}
          ><ImagePlus size={16} /></IconButton>
        </div>
        {/* 档位（REQ-CORE-003 / REQ-CORE-006）：屏数只在造时出现（几张不同的屏）；版数造改都有（同一屏的几种画法）；两者以分隔线隔开，不做同形并排 */}
        {/* 档位组自身也能换行：≤ 48rem 视口里输入框只有约 240px 宽，屏数 + 版数 + 发送一行放不下时各自折行、靠右 */}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/* 本机 agent 通道没有档位（固定 1 版、屏数由会话自定），腾出的位置给会话下拉；聊天由助手定范围，同样没有档位；改组件一次一个也没有档位 */}
          {!chat && creating && !agentRunner && !compOnly && (
            <Segmented label="屏数（几张不同的屏）" testId="count" value={p.count} options={SCREEN_COUNT_OPTIONS.map((o) => ({ value: o, label: o === 'auto' ? '自动' : String(o) }))} onChange={p.onCount} />
          )}
          {!chat && creating && !agentRunner && !compOnly && <span className="h-5 w-px bg-line" aria-hidden="true" />}
          {!chat && !agentRunner && !compOnly && <Segmented label="版数（同一屏的几种画法）" testId="versions" value={p.versions} options={Array.from({ length: MAX_VERSIONS }, (_, i) => ({ value: i + 1, label: `${i + 1} 版` }))} onChange={p.onVersions} compact />}
          {/* 这个 40px 插槽永远是发送键（停止归在跑作业行上的取消键）；反色实心只给此刻唯一的主动作 */}
          <IconButton
            type="submit" size="sm" tone={text.trim() ? 'invert' : 'default'} label={chat ? '发送（聊）' : compOnly ? '发送（改组件）' : creating ? '发送（造）' : '发送（改）'} hint="Enter" tip="top-end"
            className={text.trim() ? undefined : 'bg-panel-2'}
            unavailable={p.blockedReason ? p.blockedReason : uploading ? '参考图还在上传' : !sessionOk ? '先选要投递的会话' : !chatChannelOk ? '先添加「本机 Claude 订阅」通道' : !text.trim() && (chat ? '先说点什么' : compOnly ? '先说要怎么改组件' : creating ? '先描述要造的屏' : '先说要怎么改')}
          >
            {sending ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : <ArrowUp size={16} />}
          </IconButton>
        </div>
      </div>
    </form>
  );
}

// 分段控件（屏数 / 版数）：radiogroup 语义，方向键换档；内外圆角同心（内层半径 = 外框 14px − 内边距 2px）
function Segmented<T extends string | number>({ label, testId, value, options, onChange, compact }: { label: string; testId: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (idx + delta + options.length) % options.length;
    onChange(options[next].value);
    (ref.current?.querySelector(`[data-testid="${testId}-${String(options[next].value)}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} title={label} data-testid={`${testId}-group`} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line p-0.5">
      {options.map((o, i) => (
        <button
          key={String(o.value)} type="button" role="radio" aria-checked={i === idx} tabIndex={i === idx ? 0 : -1} data-testid={`${testId}-${String(o.value)}`}
          onClick={() => onChange(o.value)} onKeyDown={onKey}
          className={`h-7 ${compact ? 'min-w-9 px-1' : 'min-w-7 px-1.5'} rounded-[calc(var(--radius-lg)-2px)] text-xs tabular-nums transition-colors duration-[var(--duration-fast)] ${i === idx ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg'} focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1`}
        >{o.label}</button>
      ))}
    </div>
  );
}

// 占位文案：多条时轮播（尊重 reduced-motion 则停在第一条），换词时新词从下方浮现
function Placeholder({ phrases, active }: { phrases: string[]; active: boolean }) {
  const [i, setI] = useState(0);
  const key = phrases.join('\n');
  useEffect(() => { setI(0); }, [key]);
  useEffect(() => {
    if (!active || phrases.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % phrases.length), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [active, phrases.length]);
  if (!active) return null;
  const text = phrases[i % phrases.length];
  return (
    <span key={text} aria-hidden="true" className="phrase-in pointer-events-none absolute inset-x-0 top-0 block truncate px-1 text-[15px] leading-7 text-muted">
      {text}
    </span>
  );
}

// 通道下拉：Radix Select 承担键盘导航、焦点归还与定位；外观在 styles.css 的 .menu。
// 云端模型与本机 agent 分两组；缺凭据的通道照样列出但不可选，并就地写明原因（INT-013 / A11Y-007）。
export function RunnerSelect({ runners, value, onChange, disabled, testId = 'runner-select' }: { runners: RunnerOptionDto[]; value: string; onChange: (id: string) => void; disabled?: boolean; testId?: string }) {
  const navigate = useNavigate();
  // 只列可用项（REQ-CORE-013）：不可用的去设置页看原因，这里不灰化陈列
  const usable = runners.filter((r) => r.available);
  const cloud = usable.filter((r) => r.runner.kind !== 'agent');
  const agents = usable.filter((r) => r.runner.kind === 'agent');
  const current = usable.some((r) => r.id === value) ? value : undefined;
  return (
    <Select.Root value={current} onValueChange={(v) => { if (v === MANAGE_ID) navigate('?settings=runners'); else onChange(v); }} disabled={disabled}>
      <Select.Trigger
        aria-label="生成通道" data-testid={testId} data-value={value}
        className="group flex h-9 max-w-44 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-muted transition-[color,background-color] duration-[var(--duration-fast)] hover:bg-panel-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 data-[state=open]:bg-panel-2 data-[state=open]:text-fg disabled:pointer-events-none disabled:opacity-50 sm:max-w-56"
      >
        <span className="min-w-0 truncate"><Select.Value placeholder={usable.length ? '选择通道' : '没有可用通道'} /></span>
        <Select.Icon className="flex shrink-0 opacity-60 transition-transform duration-[var(--duration-base)] ease-out group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" side="top" align="start" sideOffset={8} collisionPadding={12}
          // 下拉开着时的 Esc / 方向键 / 字母键归它自己，不漏给画布快捷键（画布的 Esc 会顺手清掉选中）
          onKeyDown={(e) => e.stopPropagation()}
          className="menu z-50 min-w-64 max-w-[min(22rem,calc(100vw-1.5rem))] p-1.5"
        >
          <Select.Viewport>
            <RunnerGroup label="云端模型" items={cloud} />
            {cloud.length > 0 && agents.length > 0 && <Select.Separator className="my-1.5 h-px bg-line" />}
            <RunnerGroup label="本机 agent" items={agents} />
            {usable.length === 0 && <p className="px-2.5 py-2 text-xs text-muted">没有验证通过的通道，先去设置页添加一个。</p>}
            <Select.Separator className="my-1.5 h-px bg-line" />
            {/* 做成选项而不是普通按钮：Radix Select 的内容区只让方向键在选项间走，普通按钮键盘够不着；
                选中它不改通道、只跳设置页 */}
            <Select.Item value={MANAGE_ID} textValue="管理通道" data-testid="manage-channels" className={ITEM_CLS}>
              <Select.ItemText><span className="inline-flex items-center gap-2"><Settings2 size={14} aria-hidden="true" />管理通道…</span></Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

const MANAGE_ID = '__manage_channels__';
const ITEM_CLS = 'relative flex cursor-pointer select-none items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-muted outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=checked]:text-fg';

// 投递会话下拉（REQ-AGENT-003 v0.34）：本机正在运行的 Claude Code 交互式会话。起过名的显示名字，派生名（目录 + 后缀）显示会话 UUID；
// 每项带目录名与 idle / busy。打开即让父组件重取列表；当前值不在列表里时显示占位「选择会话」（记住的会话已关闭）。
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
export function SessionSelect({ sessions, value, onChange, onOpen, disabled, testId = 'session-select' }: { sessions: AgentSessionDto[] | null; value: string; onChange: (id: string) => void; onOpen: () => void; disabled?: boolean; testId?: string }) {
  const items = sessions ?? [];
  const current = items.some((s) => s.sessionId === value) ? value : undefined;
  const label = (s: AgentSessionDto) => (s.named ? s.name : s.sessionId);
  return (
    <Select.Root value={current} onValueChange={onChange} disabled={disabled} onOpenChange={(open) => { if (open) onOpen(); }}>
      <Select.Trigger
        aria-label="投递到哪个会话" data-testid={testId} data-value={current ?? ''}
        className="group flex h-9 min-w-0 max-w-44 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-muted transition-[color,background-color] duration-[var(--duration-fast)] hover:bg-panel-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 data-[state=open]:bg-panel-2 data-[state=open]:text-fg disabled:pointer-events-none disabled:opacity-50 sm:max-w-56"
      >
        <span className="min-w-0 truncate"><Select.Value placeholder="选择会话" /></span>
        <Select.Icon className="flex shrink-0 opacity-60 transition-transform duration-[var(--duration-base)] ease-out group-data-[state=open]:rotate-180">
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        {/* 会话可能有几十个：内容高度封顶在触发器上方的可用空间，Radix 的 Viewport 自己滚（滚动条隐藏，上下端给箭头提示，RESP-016） */}
        <Select.Content position="popper" side="top" align="start" sideOffset={8} collisionPadding={12} onKeyDown={(e) => e.stopPropagation()} className="menu z-50 flex max-h-[var(--radix-select-content-available-height)] min-w-72 max-w-[min(26rem,calc(100vw-1.5rem))] flex-col p-1.5">
          <Select.ScrollUpButton className="flex h-6 shrink-0 items-center justify-center text-muted"><ChevronUp size={14} aria-hidden="true" /></Select.ScrollUpButton>
          <Select.Viewport className="min-h-0 flex-1">
            <Select.Group>
              <Select.Label className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold tracking-wide text-muted">本机正在运行的 Claude Code 会话</Select.Label>
              {sessions === null && <p className="px-2.5 py-2 text-xs text-muted">正在找会话…</p>}
              {sessions?.length === 0 && <p className="px-2.5 py-2 text-xs text-muted" data-testid="session-empty">没有正在运行的 Claude Code 会话——在终端开着 claude 再来。</p>}
              {items.map((s) => (
                <Select.Item key={s.sessionId} value={s.sessionId} textValue={label(s)} data-testid="session-option" data-named={s.named ? '' : undefined} className={ITEM_CLS}>
                  <span className="min-w-0 flex-1">
                    <Select.ItemText><span className={s.named ? '' : 'font-mono text-xs'}>{label(s)}</span></Select.ItemText>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <span className="truncate">{basename(s.cwd)}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 ${s.status === 'busy' ? 'border-warn/60 text-warn' : 'border-line'}`}>{s.status === 'busy' ? '忙' : s.status === 'idle' ? '空闲' : '未知'}</span>
                    </span>
                  </span>
                  <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Viewport>
          <Select.ScrollDownButton className="flex h-6 shrink-0 items-center justify-center text-muted"><ChevronDown size={14} aria-hidden="true" /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function RunnerGroup({ label, items }: { label: string; items: RunnerOptionDto[] }) {
  if (!items.length) return null;
  return (
    <Select.Group>
      <Select.Label className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold tracking-wide text-muted">{label}</Select.Label>
      {items.map((r) => (
        <Select.Item key={r.id} value={r.id} textValue={r.label} className={ITEM_CLS}>
          <span className="min-w-0 flex-1 truncate">
            {/* 图标放在 ItemText 里，触发器上显示当前项时也带图标。
                这里只给图标 + 显示名：选通道时认的是名字，模型 id 是配置细节，在设置弹层的通道管理器里看 */}
            <Select.ItemText><span className="inline-flex items-center gap-2"><VendorIcon vendor={r.vendor} size={14} />{r.label}</span></Select.ItemText>
          </span>
          <Select.ItemIndicator className="flex shrink-0"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
        </Select.Item>
      ))}
    </Select.Group>
  );
}
