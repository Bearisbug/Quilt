import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHANNEL_VENDORS, VENDOR_PRESETS, type ChannelDto, type ChannelKind, type ChannelVendor, type ProbeResultDto, type RunnerOptionDto } from '@quilt/core';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { Button, Field, Input, cn } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { VendorIcon } from '@/ui/VendorIcon';
import { ConfirmDialog, Overlay, useModal } from '@/ui/modal';

// 生成通道管理器（REQ-CORE-013 / PAGE-SETTINGS）。两组：我的通道（可增删改，云端通道只有这一种来源）、本机 agent（固定一行）。
// 每行都能「验证」——真的发一次最小请求；只有验证通过的才会出现在画布输入框的下拉里。
// 数据：/v1/runners 给统一目录（含不可用项与原因），/v1/channels 给自建通道的明细（端点、状态、密钥末位）。

const KIND_LABEL: Record<ChannelKind, string> = { anthropic: 'Anthropic', gemini: 'Gemini', openai: 'OpenAI 兼容', 'agent-sdk': '本机 Claude 订阅' };
const DEFAULT_VENDOR: Record<ChannelKind, ChannelVendor> = { anthropic: 'anthropic', gemini: 'google', openai: 'openai', 'agent-sdk': 'claude-subscription' };
// 模型名不预填（型号更新太快），只给一个看得出格式的例子
const MODEL_HINT: Record<ChannelVendor, string> = {
  'claude-subscription': 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5', google: 'gemini-3.8-flash', openai: 'gpt-5', deepseek: 'deepseek-chat', qwen: 'qwen-plus',
  moonshot: 'kimi-k2', zhipu: 'glm-4.6', openrouter: 'anthropic/claude-sonnet-5', ollama: 'llama3.1', siliconflow: 'Qwen/Qwen3-32B', custom: 'model-id',
};
const OPENAI_VENDORS = CHANNEL_VENDORS.filter((v) => VENDOR_PRESETS[v].kind === 'openai');

const hostOf = (endpoint: string | null) => { if (!endpoint) return ''; try { return new URL(endpoint).host; } catch { return endpoint; } };
const problemText = (e: unknown, fallback: string) => {
  if (!(e instanceof ApiError)) return fallback;
  const errs = (e.problem as { errors?: { message: string }[] }).errors ?? [];
  return [e.problem.title, ...errs.map((x) => x.message)].filter(Boolean).join('：');
};

// onCatalog：通道增删改与验证之后，把刚取到的通道清单交给上层——画布那份清单是挂载时取的，
// 不回传的话新加的通道要刷新页面才出现在输入框下拉里
export function ChannelManager({ onCatalog }: { onCatalog?: (items: RunnerOptionDto[], defaultId: string) => void } = {}) {
  const toast = useToast();
  const [runners, setRunners] = useState<RunnerOptionDto[] | null>(null);
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResultDto>>({});
  const [hintOpen, setHintOpen] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'edit'; channel: ChannelDto } | null>(null);
  const [deleting, setDeleting] = useState<ChannelDto | null>(null);
  // 弹层关闭后焦点要回到打开它的那个按钮（A11Y-004）
  const returnFocus = useRef<HTMLElement | null>(null);
  // 归还目标消失时的回退落点：管理器容器（tabIndex=-1 可被脚本聚焦、不进 Tab 序）
  const rootRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const [r, c] = await Promise.all([api.runners(), api.channels.list()]);
      setRunners(r.items); setChannels(c.items);
      onCatalog?.(r.items, r.default);
    } catch (e) { setLoadError(problemText(e, '通道清单加载失败')); setRunners([]); setChannels([]); }
  };
  useEffect(() => { void load(); }, []);

  const probe = async (id: string) => {
    setProbing((m) => ({ ...m, [id]: true }));
    try { const r = await api.probeRunner(id); setProbeResults((m) => ({ ...m, [id]: r })); await load(); }
    catch (e) { setProbeResults((m) => ({ ...m, [id]: { ok: false, error: problemText(e, '验证请求失败') } })); }
    finally { setProbing((m) => ({ ...m, [id]: false })); }
  };
  const openDialog = (e: React.MouseEvent<HTMLElement>, d: NonNullable<typeof dialog>) => { returnFocus.current = e.currentTarget; setDialog(d); };
  const closeDialog = () => { setDialog(null); setDeleting(null); };  // 焦点归还由 useModal 的清理函数负责

  const byChannelId = new Map((channels ?? []).map((c) => [c.id, c]));
  const builtins = (runners ?? []).filter((r) => r.source === 'builtin');
  const mine = (runners ?? []).filter((r) => r.source === 'channel');
  const loading = runners === null || channels === null;

  const row = (r: RunnerOptionDto) => (
    <RunnerRow
      key={r.id} r={r} channel={r.channelId ? byChannelId.get(r.channelId) : undefined}
      probing={!!probing[r.id]} probeResult={probeResults[r.id]} onProbe={() => probe(r.id)}
      hintOpen={!!hintOpen[r.id]} onToggleHint={() => setHintOpen((m) => ({ ...m, [r.id]: !m[r.id] }))}
      onEdit={(e) => { const c = r.channelId ? byChannelId.get(r.channelId) : undefined; if (c) openDialog(e, { mode: 'edit', channel: c }); }}
      onDelete={(e) => { const c = r.channelId ? byChannelId.get(r.channelId) : undefined; if (c) { returnFocus.current = e.currentTarget; setDeleting(c); } }}
    />
  );

  return (
    <div data-testid="channel-manager" ref={rootRef} tabIndex={-1} className="outline-none">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">生成通道</h2>
          <p className="mt-1 text-xs text-muted">画布输入框的下拉只列<b className="font-medium text-fg">验证通过</b>的通道。在这里添加、验证、修改或删除；密钥加密保存，只回显末 4 位。</p>
        </div>
        <Button size="sm" variant="primary" data-testid="add-channel" aria-label="添加通道" onClick={(e) => openDialog(e, { mode: 'add' })}>添加通道</Button>
      </div>

      {loadError && (
        <p role="alert" className="mt-3 flex items-center justify-between gap-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span>{loadError}</span><Button size="sm" onClick={() => void load()}>重试</Button>
        </p>
      )}

      {loading ? <RowsSkeleton /> : (
        <div className="mt-4 space-y-5">
          <Group title="我的通道" hint={mine.length === 0 ? '还没有自建通道。点右上角「添加通道」，填端点与密钥，保存时会自动验证。' : undefined}>{mine.map(row)}</Group>
          {builtins.length > 0 && <Group title="本机 agent" hint="Quilt 会把画布派的活投递到本机正在运行的 Claude Code 会话，投给谁在输入框旁的会话下拉里选；可用与否只看 claude 命令是否在 PATH 上，展开「如何配置」看安装与接入步骤。">{builtins.map(row)}</Group>}
        </div>
      )}

      {dialog && <ChannelDialog mode={dialog.mode} channel={dialog.mode === 'edit' ? dialog.channel : undefined} onClose={closeDialog} onSaved={() => void load()} returnTo={returnFocus} fallback={rootRef} />}
      {deleting && (
        <ConfirmDialog
          title={`删除「${deleting.label}」？`}
          body="已在排队或运行中、引用它的作业会失败。删除不可撤销。"
          confirmLabel="删除"
          returnTo={returnFocus}
          fallback={rootRef}
          onCancel={closeDialog}
          onConfirm={async () => { try { await api.channels.remove(deleting.id); toast('已删除'); await load(); closeDialog(); } catch (e) { toast(problemText(e, '删除失败'), 'error'); } }}  // 先刷新再关：让那一行先卸掉，焦点归还才会落到回退目标而不是一个即将消失的按钮
        />
      )}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="text-[11px] font-semibold tracking-wide text-muted">{title}</h3>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
      {Array.isArray(children) && children.length > 0 && <ul className="mt-1 divide-y divide-line">{children}</ul>}
    </section>
  );
}

// 加载骨架按真实行结构占位：图标圆、两行文本、状态药丸（IA-006）；reduced-motion 下不闪
function RowsSkeleton() {
  const bar = 'rounded bg-panel-2 animate-pulse motion-reduce:animate-none';
  return (
    <ul aria-hidden="true" className="mt-4 divide-y divide-line">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 py-3">
          <span className={cn('size-5 rounded-full', bar)} />
          <span className="flex-1 space-y-1.5"><span className={cn('block h-3 w-40', bar)} /><span className={cn('block h-2.5 w-56 max-w-full', bar)} /></span>
          <span className={cn('h-5 w-12 rounded-full', bar)} />
        </li>
      ))}
    </ul>
  );
}

type Tone = 'success' | 'muted' | 'danger';
// 药丸只说「这条通道现在能不能用」。自建通道的可用性就是验证结论，两者同一件事；
// 预置与本机通道的可用性来自凭据 / 设备是否就位，跟某一次探测成功与否是两个维度——
// 一次探测超时不代表它不可用（用户实测：本机订阅显示「可用 + 验证失败」自相矛盾）。
function statusOf(r: RunnerOptionDto, c: ChannelDto | undefined): { tone: Tone; text: string; detail?: string } {
  if (r.source === 'channel') {
    if (c?.status === 'verified') return { tone: 'success', text: '已验证' };
    if (c?.status === 'failed') return { tone: 'danger', text: '验证失败', detail: c.lastError ?? undefined };
    return { tone: 'muted', text: '未验证' };
  }
  if (r.available) return { tone: 'success', text: '可用' };
  return { tone: 'danger', text: '未配置', detail: r.unavailableReason };
}

function RunnerRow(p: {
  r: RunnerOptionDto; channel?: ChannelDto; probing: boolean; probeResult?: ProbeResultDto; onProbe: () => void;
  hintOpen: boolean; onToggleHint: () => void; onEdit: (e: React.MouseEvent<HTMLElement>) => void; onDelete: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const { r, channel: c } = p;
  const st = statusOf(r, c);
  const sub = r.source === 'channel' && c ? [KIND_LABEL[c.kind], c.model, hostOf(c.endpoint)].filter(Boolean).join(' · ') : r.hint ?? '';
  const pill = st.tone === 'success' ? 'border-success/60 text-success' : st.tone === 'danger' ? 'border-danger/60 text-danger' : 'border-line text-muted';
  return (
    <li data-testid="runner-row" data-runner-id={r.id} className="py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <VendorIcon vendor={r.vendor} size={20} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-sm font-medium">{r.label}</span>
            <span data-testid="runner-status" className={cn('shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]', pill)}>{st.text}</span>
            {/* 原因写在药丸旁边而不是 tooltip 里——触屏没有 hover，且这是决定「为什么用不了」的关键信息 */}
            {st.detail && <span className="text-[11px] text-danger [overflow-wrap:anywhere]">{st.detail}</span>}
          </div>
          {sub && <div className="mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
          {p.probeResult && (
            <p role="status" className={cn('mt-1 text-[11px] [overflow-wrap:anywhere]', p.probeResult.ok ? 'text-success' : 'text-danger')}>
              {p.probeResult.ok
                ? `验证通过${p.probeResult.latencyMs != null ? ` · ${p.probeResult.latencyMs} ms` : ''}${p.probeResult.detail ? ` · ${p.probeResult.detail}` : ''}`
                /* 自建通道的失败即结论（状态已落库）；预置 / 本机通道只是「这一次没通」，可用性另有来源 */
                : `${r.source === 'channel' ? '验证失败' : '这次没验证通过'}：${p.probeResult.error ?? '未知原因'}`}
            </p>
          )}
          {/* 收起时整块卸载，不留看不见的可聚焦内容（A11Y-011） */}
          {p.hintOpen && r.setupHint && <div className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-canvas p-3 text-xs leading-cn text-fg">{r.setupHint}</div>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {r.setupHint && (
            <Button size="sm" data-testid="setup-hint" aria-expanded={p.hintOpen} aria-label={`${p.hintOpen ? '收起' : '展开'}「${r.label}」的配置说明`} onClick={p.onToggleHint}>如何配置</Button>
          )}
          {/* 验证中不禁用按钮：原生 disabled 会立刻把焦点甩到 body（A11Y-013），只用 aria-busy + 转圈 */}
          <Button size="sm" data-testid="probe-runner" aria-busy={p.probing || undefined} aria-label={`验证「${r.label}」`} onClick={() => { if (!p.probing) p.onProbe(); }}>
            {p.probing && <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />}验证
          </Button>
          {c && <Button size="sm" data-testid="edit-channel" aria-label={`编辑「${r.label}」`} onClick={p.onEdit}>编辑</Button>}
          {c && <Button size="sm" variant="danger" data-testid="delete-channel" aria-label={`删除「${r.label}」`} onClick={p.onDelete}>删除</Button>}
        </div>
      </div>
    </li>
  );
}

// ---- 添加 / 编辑面板 ----
function ChannelDialog(p: { mode: 'add' | 'edit'; channel?: ChannelDto; onClose: () => void; onSaved: () => void; returnTo?: React.RefObject<HTMLElement | null>; fallback?: React.RefObject<HTMLElement | null> }) {
  const toast = useToast();
  const ref = useModal<HTMLFormElement>(p.onClose, p.returnTo, p.fallback);
  // 「添加」成功但验证失败时留在面板里：此后再提交走更新，不能再建第二条
  const [saved, setSaved] = useState<ChannelDto | undefined>(p.channel);
  const editing = !!saved;
  const [kind, setKind] = useState<ChannelKind>(p.channel?.kind ?? 'anthropic');
  const [vendor, setVendor] = useState<ChannelVendor>(p.channel?.vendor ?? DEFAULT_VENDOR[p.channel?.kind ?? 'anthropic']);
  const [label, setLabel] = useState(p.channel?.label ?? '');
  const [endpoint, setEndpoint] = useState(p.channel?.endpoint ?? '');
  const [endpointTouched, setEndpointTouched] = useState(!!p.channel?.endpoint);
  const [model, setModel] = useState(p.channel?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResultDto | null>(null);
  const [saving, setSaving] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  const pickKind = (k: ChannelKind) => {
    setKind(k); const v = DEFAULT_VENDOR[k]; setVendor(v);
    if (!endpointTouched) setEndpoint(k === 'openai' ? VENDOR_PRESETS[v].endpoint : '');
  };
  const pickVendor = (v: ChannelVendor) => { setVendor(v); if (!endpointTouched) setEndpoint(VENDOR_PRESETS[v].endpoint); };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!label.trim()) e['ch-label'] = '给这个通道起个名字，例如「DeepSeek 主力」';
    if (!model.trim()) e['ch-model'] = '填模型名，供应商文档里的模型 id';
    if (kind === 'openai' && !endpoint.trim()) e['ch-endpoint'] = 'OpenAI 兼容通道必须填端点';
    if (kind === 'agent-sdk') { delete e['ch-endpoint']; delete e['ch-key']; }
    if (endpoint.trim()) { try { new URL(endpoint.trim()); } catch { e['ch-endpoint'] = '端点要是完整 URL，例如 https://api.deepseek.com/v1'; } }
    if (!editing && !apiKey && kind !== 'agent-sdk') e['ch-key'] = '填 API Key';
    setErrors(e); return Object.keys(e).length === 0;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setServerError(null); setProbe(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const body = { label: label.trim(), endpoint: endpoint.trim() || undefined, model: model.trim() };
      const ch = saved
        ? (await api.channels.update(saved.id, { ...body, ...(apiKey ? { apiKey } : {}) })).channel
        : (await api.channels.create({ kind, vendor, ...body, apiKey })).channel;
      setSaved(ch); setApiKey(''); p.onSaved();
      const r = await api.probeRunner(`channel:${ch.id}`);
      setProbe(r); p.onSaved();
      if (r.ok) { toast(`「${ch.label}」已验证${r.latencyMs != null ? `，${r.latencyMs} ms` : ''}`); p.onClose(); return; }
      requestAnimationFrame(() => alertRef.current?.focus());
    } catch (e) {
      setServerError(problemText(e, '保存失败'));
      requestAnimationFrame(() => alertRef.current?.focus());
    } finally { setSaving(false); }
  };

  const err = (id: string) => errors[id] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
  // 普通函数而不是内嵌组件：内嵌组件每次渲染都是新类型，会整段重挂、role=alert 反复播报
  const errorLine = (id: string) => (errors[id] ? <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">{errors[id]}</p> : null);
  const endpointPlaceholder = kind === 'openai' ? (VENDOR_PRESETS[vendor].endpoint || 'https://…/v1') : `留空用官方端点 ${VENDOR_PRESETS[DEFAULT_VENDOR[kind]].endpoint}`;

  return (
    <Overlay onClose={p.onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="ch-title" data-testid="channel-dialog" tabIndex={-1} noValidate onSubmit={submit}
        className="scroll max-h-[calc(100dvh-2rem)] w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-2xl fade-up outline-none">
        <h2 id="ch-title" className="text-sm font-semibold">{editing ? `编辑「${saved!.label}」` : '添加通道'}</h2>
        <p className="mt-1 text-xs text-muted">保存后会立刻发一次最小请求验证；验证通过的通道才会出现在画布输入框的下拉里。</p>
        {(serverError || (probe && !probe.ok)) && (
          <p ref={alertRef} tabIndex={-1} role="alert" className="mt-3 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger outline-none [overflow-wrap:anywhere]">
            {serverError ?? `已保存，但验证失败：${probe?.error ?? '未知原因'}。改好后再点「保存并验证」。`}
          </p>
        )}
        <div className="mt-4 space-y-4">
          <Field label="类型" htmlFor="ch-kind">
            <Select id="ch-kind" value={kind} onChange={(v) => pickKind(v as ChannelKind)} disabled={editing} aria-label="通道类型"
              options={(Object.keys(KIND_LABEL) as ChannelKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], icon: <VendorIcon vendor={DEFAULT_VENDOR[k] === 'custom' ? 'openai' : DEFAULT_VENDOR[k]} size={14} /> }))} />
          </Field>
          {kind === 'openai' && !editing && (
            <Field label="厂商预设" htmlFor="ch-vendor" hint="只决定默认端点与图标，模型名仍要自己填">
              <Select id="ch-vendor" value={vendor} onChange={(v) => pickVendor(v as ChannelVendor)} aria-label="厂商预设"
                options={OPENAI_VENDORS.map((v) => ({ value: v, label: VENDOR_PRESETS[v].label, icon: <VendorIcon vendor={v} size={14} /> }))} />
            </Field>
          )}
          <Field label="显示名" htmlFor="ch-label">
            <Input id="ch-label" name="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 DeepSeek 主力" maxLength={60} autoComplete="off" data-1p-ignore data-lpignore="true" {...err('ch-label')} />
            {errorLine('ch-label')}
          </Field>
          {kind !== 'agent-sdk' && (
          <Field label={kind === 'openai' ? '端点（Base URL）' : '端点（可选）'} htmlFor="ch-endpoint">
            <Input id="ch-endpoint" name="endpoint" type="url" inputMode="url" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setEndpointTouched(true); }} placeholder={endpointPlaceholder} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-endpoint')} />
            {errorLine('ch-endpoint')}
          </Field>
          )}
          <Field label="模型名" htmlFor="ch-model">
            {/* autoComplete="off" 在 Chromium 上常被忽略：实测这个框被密码管理器自动填成了邮箱。
                给一个语义不相干的具体值（浏览器只会拿它匹配同类字段），再加两家密码管理器的忽略属性 */}
            <Input id="ch-model" name="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={`例如 ${MODEL_HINT[vendor]}`} maxLength={80} autoComplete="one-time-code" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-model')} />
            {errorLine('ch-model')}
          </Field>
          {kind !== 'agent-sdk' && (
          <Field label="API Key" htmlFor="ch-key" hint={editing ? '留空表示不改；密钥加密保存，不会再回显' : '加密保存，只回显末 4 位'}>
            <Input id="ch-key" name="apiKey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing && saved?.apiKeyHint ? `••••${saved.apiKeyHint}` : 'sk-…'} autoComplete="new-password" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-key')} />
            {errorLine('ch-key')}
          </Field>
          )}
          {kind === 'agent-sdk' && (
            <p className="rounded-md border border-line bg-canvas p-3 text-xs leading-cn text-muted">
              用运行 Quilt 服务端那台机器上的 <code className="font-mono text-fg">claude</code> 登录态，不需要 API Key。只要填一个这个订阅能用的模型名。
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={p.onClose}>取消</Button>
          <Button type="submit" variant="primary" data-testid="ch-save" pending={saving}>保存并验证</Button>
        </div>
      </form>
    </Overlay>
  );
}
