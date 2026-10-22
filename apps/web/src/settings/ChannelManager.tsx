import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHANNEL_VENDORS, LOCAL_CHANNEL_KINDS, VENDOR_PRESETS, type ChannelDto, type ChannelKind, type ChannelVendor, type ProbeResultDto, type RunnerOptionDto } from '@quilt/core/browser';
import { api, ApiError, loadConfig } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { RefreshCw, Pencil, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Input, cn } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { VendorIcon } from '@/ui/VendorIcon';
import { ConfirmDialog, Overlay, useModal } from '@/ui/modal';
import { Trans } from 'react-i18next';
import { tOf, useT } from '@/i18n';
import settingsMessages from '@/i18n/locales/settings';
import commonMessages from '@/i18n/locales/common';

// 设置「模型」一节的管理器（REQ-CORE-013，§13「设置弹层的模型」；代码与接口里仍叫通道 / channel，界面上叫「模型」v1.24）。
// 两张表：我的模型（可增删改，云端模型只有这一种来源）、本机 agent（固定）。每行都能「验证」——真的发一次最小请求；只有验证通过的才会出现在画布输入框的下拉里。
// 数据：/v1/runners 给统一目录（含不可用项与原因），/v1/channels 给自建通道的明细（端点、状态、密钥末位）。

// 模型类型的显示名在 settings 命名空间的 drivers.<键>；键的顺序就是「类型」下拉的顺序
const KIND_KEY: Record<ChannelKind, 'anthropic' | 'gemini' | 'openai' | 'agentSdk' | 'codex'> = { anthropic: 'anthropic', gemini: 'gemini', openai: 'openai', 'agent-sdk': 'agentSdk', codex: 'codex' };
const DEFAULT_VENDOR: Record<ChannelKind, ChannelVendor> = { anthropic: 'anthropic', gemini: 'google', openai: 'openai', 'agent-sdk': 'claude-subscription', codex: 'codex-subscription' };
// 模型名不预填（型号更新太快），只给一个看得出格式的例子
const MODEL_HINT: Record<ChannelVendor, string> = {
  'claude-subscription': 'claude-sonnet-5', 'codex-subscription': 'gpt-6-astra',
  anthropic: 'claude-sonnet-5', google: 'gemini-3.8-flash', openai: 'gpt-5', deepseek: 'deepseek-chat', qwen: 'qwen-plus',
  moonshot: 'kimi-k2', zhipu: 'glm-4.6', openrouter: 'anthropic/claude-sonnet-5', ollama: 'llama3.1', siliconflow: 'Qwen/Qwen3-32B', custom: 'model-id',
};
const OPENAI_VENDORS = CHANNEL_VENDORS.filter((v) => VENDOR_PRESETS[v].kind === 'openai');
// 厂商预设里 label 带中文的几家，显示名换成 settings 命名空间的 channels.vendors.<vendor>
const VENDOR_KEY: Partial<Record<ChannelVendor, 'qwen' | 'zhipu' | 'ollama' | 'custom'>> = { qwen: 'qwen', zhipu: 'zhipu', ollama: 'ollama', custom: 'custom' };
const ts = tOf(settingsMessages);

const problemText = (e: unknown, fallback: string) => {
  if (!(e instanceof ApiError)) return fallback;
  const errs = (e.problem as { errors?: { message: string }[] }).errors ?? [];
  return [e.problem.title, ...errs.map((x) => x.message)].filter(Boolean).join(ts('channels.problemSep'));
};

// onCatalog：模型增删改与验证之后，把刚取到的清单交给上层——画布那份清单是挂载时取的，
// 不回传的话新加的模型要刷新页面才出现在输入框下拉里
export function ChannelManager({ onCatalog }: { onCatalog?: (items: RunnerOptionDto[], defaultId: string) => void }) {
  const toast = useToast();
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
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
  // 服务端没配 QUILT_SECRETS_KEY（API-CORE-028 v0.78）：含 API Key 的通道存不了，顶部先说，不等填完才报 400
  const [secretsOk, setSecretsOk] = useState(true);
  useEffect(() => { loadConfig().then((c) => setSecretsOk(c.secretsConfigured !== false)).catch(() => {}); }, []);

  const load = async () => {
    setLoadError(null);
    try {
      const [r, c] = await Promise.all([api.runners(), api.channels.list()]);
      setRunners(r.items); setChannels(c.items);
      onCatalog?.(r.items, r.default);
    } catch (e) { setLoadError(problemText(e, t('channels.loadFailed'))); setRunners([]); setChannels([]); }
  };
  // 打开时取一次：load 读 onCatalog，每次渲染换引用，列进依赖就成了每次渲染都重取
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const probe = async (id: string) => {
    setProbing((m) => ({ ...m, [id]: true }));
    try { const r = await api.probeRunner(id); setProbeResults((m) => ({ ...m, [id]: r })); await load(); }
    catch (e) { setProbeResults((m) => ({ ...m, [id]: { ok: false, error: problemText(e, t('channels.probe.requestFailed')) } })); }
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
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="type-heading3 font-semibold">{t('sections.models')}</h3>
          <p className="mt-1 type-label leading-(--semantic-typography-body-line-height) text-text-secondary"><Trans ns={settingsMessages.ns} i18nKey="channels.intro" components={{ b: <b className="font-medium text-text-primary" /> }} /></p>
        </div>
        <Button size="sm" variant="primary" data-testid="add-channel" className="shrink-0" onClick={(e) => openDialog(e, { mode: 'add' })}>{t('channels.add')}</Button>
      </div>

      {!secretsOk && (
        <p data-testid="secrets-missing" className="tint-warning mt-3 rounded-md px-3 py-2 type-label leading-(--semantic-typography-body-line-height)">
          <Trans ns={settingsMessages.ns} i18nKey="channels.secretsMissing" components={{ code: <code className="font-mono" /> }} />
        </p>
      )}

      {loadError && (
        <p role="alert" className="tint-error mt-3 flex items-center justify-between gap-2 rounded-md px-3 py-2 type-label">
          <span>{loadError}</span><Button size="sm" onClick={() => void load()}>{tc('retry')}</Button>
        </p>
      )}

      {loading ? <RowsSkeleton /> : (
        <>
          <Table id="models-mine" title={t('channels.mine')} empty={mine.length === 0 ? t('channels.mineEmpty') : undefined}>{mine.map(row)}</Table>
          {builtins.length > 0 && <Table id="models-local" title={t('channels.local')} hint={t('channels.localHint')}>{builtins.map(row)}</Table>}
        </>
      )}

      {dialog && <ChannelDialog channel={dialog.mode === 'edit' ? dialog.channel : undefined} secretsOk={secretsOk} onClose={closeDialog} onSaved={() => void load()} returnTo={returnFocus} fallback={rootRef} />}
      {deleting && (
        <ConfirmDialog
          title={t('channels.deleteTitle', { name: deleting.label })}
          body={t('channels.deleteBody')}
          confirmLabel={tc('delete')}
          returnTo={returnFocus}
          fallback={rootRef}
          onCancel={closeDialog}
          onConfirm={async () => { try { await api.channels.remove(deleting.id); toast(t('channels.deleted')); await load(); closeDialog(); } catch (e) { toast(problemText(e, t('channels.deleteFailed')), 'error'); } }}  // 先刷新再关：让那一行先卸掉，焦点归还才会落到回退目标而不是一个即将消失的按钮
        />
      )}
    </div>
  );
}

// 两张表同一套列：名字（logo · 显示名 · 小胶囊 / 等宽模型 ID）、状态（色点 + 文字 / 次行）、行尾的圆形图标按钮。
// 表头一行灰字（「我的模型 · 状态」），行间发丝线
const RCOLS = 'grid grid-cols-[minmax(0,1fr)_minmax(7rem,10rem)_6.5rem] items-center gap-x-4';

function Table({ id, title, hint, empty, children }: { id: string; title: string; hint?: string; empty?: string; children: ReactNode }) {
  const t = useT(settingsMessages);
  return (
    <section aria-labelledby={id} className="mt-7">
      <div className={cn(RCOLS, 'pb-2')}>
        <h4 id={id} className="type-label font-normal text-text-secondary">{title}</h4>
        <span aria-hidden="true" className="type-label text-text-secondary">{t('channels.colStatus')}</span>
      </div>
      {empty ? <p className="border-t border-border-subtle py-4 type-label text-text-secondary">{empty}</p> : <ul>{children}</ul>}
      {hint && <p className="border-t border-border-subtle pt-2 type-caption leading-(--semantic-typography-body-line-height) text-text-secondary">{hint}</p>}
    </section>
  );
}

// 加载骨架按真实行结构占位：logo、两行文本、状态、行尾按钮（IA-006）；reduced-motion 下不闪
function RowsSkeleton() {
  const bar = 'rounded-sm bg-(--semantic-color-surface-sunken) animate-pulse motion-reduce:animate-none';
  return (
    <ul aria-hidden="true" className="mt-10">
      {[0, 1, 2].map((i) => (
        <li key={i} className={cn(RCOLS, 'border-t border-border-subtle py-3.5')}>
          <span className="flex items-center gap-3"><span className={cn('size-8 rounded-full', bar)} /><span className="flex-1 space-y-1.5"><span className={cn('block h-3 w-36', bar)} /><span className={cn('block h-2.5 w-28', bar)} /></span></span>
          <span className="space-y-1.5"><span className={cn('block h-3 w-16', bar)} /><span className={cn('block h-2.5 w-24', bar)} /></span>
          <span className="flex justify-end gap-1">{[0, 1, 2].map((j) => <span key={j} className={cn('size-7 rounded-full', bar)} />)}</span>
        </li>
      ))}
    </ul>
  );
}

type Tone = 'success' | 'muted' | 'danger';
// 状态只说「这一行现在能不能用」。自建模型的可用性就是验证结论，两者同一件事；
// 本机 agent 的可用性来自命令是否在 PATH 上，跟某一次探测成功与否是两个维度——
// 一次探测超时不代表它不可用（用户实测：本机订阅显示「可用 + 验证失败」自相矛盾）。
function statusOf(r: RunnerOptionDto, c: ChannelDto | undefined): { tone: Tone; text: string } {
  if (r.source === 'channel') {
    if (c?.status === 'verified') return { tone: 'success', text: ts('channels.status.verified') };
    if (c?.status === 'failed') return { tone: 'danger', text: ts('channels.status.failed') };
    return { tone: 'muted', text: ts('channels.status.unverified') };
  }
  if (r.available) return { tone: 'success', text: ts('channels.status.available') };
  return { tone: 'danger', text: ts('channels.status.notConfigured') };
}
const TONE: Record<Tone, string> = { success: 'text-success', muted: 'text-text-secondary', danger: 'text-error' };

function RunnerRow(p: {
  r: RunnerOptionDto; channel?: ChannelDto; probing: boolean; probeResult?: ProbeResultDto; onProbe: () => void;
  hintOpen: boolean; onToggleHint: () => void; onEdit: (e: React.MouseEvent<HTMLElement>) => void; onDelete: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
  const { r, channel: c } = p;
  const st = statusOf(r, c);
  const agentTool = r.runner.kind === 'agent' ? r.runner.tool : null;
  // 本机 agent 的行名只写产品名（接口给的「交给本机 …」是输入框下拉里的说法）
  const name = agentTool ? (agentTool === 'codex' ? 'Codex' : 'Claude Code') : r.label;
  const subscription = !!c && LOCAL_CHANNEL_KINDS.includes(c.kind);
  const mono = c ? c.model : r.hint ?? '';
  const failed = (c?.status === 'failed') || (!c && !r.available);
  // 状态次行：密钥末 4 位 / 用哪个 CLI 的登录态 / 失败原因；本机 agent 写「找到 claude 命令」，用不了时给「如何配置」
  const detail = c
    ? c.status === 'failed' ? (c.lastError ?? '') : c.apiKeyHint ? t('channels.detail.key', { hint: c.apiKeyHint }) : c.kind === 'agent-sdk' ? t('channels.detail.claudeLogin') : c.kind === 'codex' ? t('channels.detail.codexLogin') : ''
    : r.available ? t('channels.detail.found', { bin: agentTool === 'codex' ? 'codex' : 'claude' }) : '';
  return (
    <li data-testid="runner-row" data-runner-id={r.id} className="border-t border-border-subtle py-3.5">
      <div className={RCOLS}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center"><VendorIcon vendor={r.vendor} size={24} /></span>
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5">
              <span className="truncate type-body font-medium text-text-primary">{name}</span>
              {c && <span className="fill inline-flex h-[1.125rem] shrink-0 items-center rounded-pill px-1.5 type-caption font-semibold text-text-primary">{t(subscription ? 'channels.tagSubscription' : 'channels.tagApi')}</span>}
            </p>
            {mono && <p className="truncate font-mono type-caption text-text-secondary">{mono}</p>}
          </div>
        </div>
        <div className={cn('grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5', TONE[st.tone])}>
          <span aria-hidden="true" className="size-2 rounded-full bg-current" />
          <p data-testid="runner-status" className="type-body font-medium">{st.text}</p>
          <div className="col-span-2 min-w-0 type-label text-text-secondary">
            {/* 原因写在状态下面而不是 tooltip 里——触屏没有 hover，且这是决定「为什么用不了」的关键信息 */}
            {detail && <p className={cn('[overflow-wrap:anywhere]', c?.status === 'failed' ? 'text-error' : 'truncate')}>{detail}</p>}
            {failed && r.setupHint && (
              <button type="button" data-testid="setup-hint" aria-expanded={p.hintOpen} aria-label={t(p.hintOpen ? 'channels.row.setupCollapse' : 'channels.row.setupExpand', { name })} onClick={p.onToggleHint}
                className="focus-ring rounded-sm text-(--semantic-color-action-link)">{t('channels.row.setup')}</button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-0.5">
          {/* 验证中不禁用按钮：原生 disabled 会立刻把焦点甩到 body（A11Y-013），只用 aria-busy + 转圈 */}
          <IconButton round size="xs" tip="top" label={t('channels.row.verify')} aria-label={t('channels.row.verifyLabel', { name })} data-testid="probe-runner" aria-busy={p.probing || undefined} onClick={() => { if (!p.probing) p.onProbe(); }}>
            <RefreshCw size={16} aria-hidden="true" className={cn(p.probing && 'animate-spin motion-reduce:animate-none')} />
          </IconButton>
          {c && <IconButton round size="xs" tip="top" label={t('channels.row.edit')} aria-label={t('channels.row.editLabel', { name })} data-testid="edit-channel" onClick={p.onEdit}><Pencil size={16} aria-hidden="true" /></IconButton>}
          {c && <IconButton round size="xs" tip="top-end" label={tc('delete')} aria-label={t('channels.row.deleteLabel', { name })} data-testid="delete-channel" onClick={p.onDelete}><Trash2 size={16} aria-hidden="true" /></IconButton>}
        </div>
      </div>
      {p.probeResult && (
        <p role="status" className={cn('mt-2 pl-11 type-label [overflow-wrap:anywhere]', p.probeResult.ok ? 'text-success' : 'text-error')}>
          {p.probeResult.ok
            ? [t('channels.probe.ok'), p.probeResult.latencyMs != null && `${p.probeResult.latencyMs} ms`, p.probeResult.detail].filter(Boolean).join(' · ')
            /* 自建模型的失败即结论（状态已落库）；本机 agent 只是「这一次没通」，可用性另有来源 */
            : t(r.source === 'channel' ? 'channels.probe.failed' : 'channels.probe.failedOnce', { error: p.probeResult.error ?? t('channels.probe.unknown') })}
        </p>
      )}
      {/* 收起时整块卸载，不留看不见的可聚焦内容（A11Y-011） */}
      {p.hintOpen && r.setupHint && <div className="fill ml-11 mt-2 whitespace-pre-wrap rounded-md p-3 type-label leading-(--semantic-typography-body-line-height) text-text-primary">{r.setupHint}</div>}
    </li>
  );
}

// ---- 添加 / 编辑面板 ----
// 出错字段按 DOM 顺序：提交失败时焦点落到第一个（INT-003）
const FIELD_ORDER = ['ch-label', 'ch-endpoint', 'ch-model', 'ch-key'];
function ChannelDialog(p: { channel?: ChannelDto; secretsOk: boolean; onClose: () => void; onSaved: () => void; returnTo?: React.RefObject<HTMLElement | null>; fallback?: React.RefObject<HTMLElement | null> }) {
  const toast = useToast();
  const t = useT(settingsMessages);
  const tc = useT(commonMessages);
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

  // 本机订阅两类不填端点、不存密钥：隐藏的端点不校验也不提交（v0.78）——隐藏字段上的错误用户看不见，会静默挡住保存
  const local = LOCAL_CHANNEL_KINDS.includes(kind);
  // 没配主密钥时存不了 Key：添加 Key 类通道、或编辑时填了新 Key，都不让提交
  const keyBlocked = !p.secretsOk && !local && (!editing || !!apiKey);
  // 填过内容后点遮罩不关（v0.78）：已填的 API Key 不能被一次误点丢掉，关闭走「取消」或 Esc
  const dirty = label !== (p.channel?.label ?? '') || model !== (p.channel?.model ?? '') || !!apiKey || (endpointTouched && endpoint !== (p.channel?.endpoint ?? ''));

  const fieldErrors = (v: { kind: ChannelKind; label: string; endpoint: string; model: string; apiKey: string }) => {
    const e: Record<string, string> = {};
    if (!v.label.trim()) e['ch-label'] = t('channels.dialog.errors.label');
    if (!v.model.trim()) e['ch-model'] = t('channels.dialog.errors.model');
    if (!LOCAL_CHANNEL_KINDS.includes(v.kind)) {
      if (v.kind === 'openai' && !v.endpoint.trim()) e['ch-endpoint'] = t('channels.dialog.errors.endpointRequired');
      else if (v.endpoint.trim()) { try { new URL(v.endpoint.trim()); } catch { e['ch-endpoint'] = t('channels.dialog.errors.endpointUrl'); } }
      if (!editing && !v.apiKey) e['ch-key'] = t('channels.dialog.errors.key');
    }
    return e;
  };
  const values = { kind, label, endpoint, model, apiKey };
  // 首次校验在提交时；报过错的字段此后每次输入即时重验，改对就清掉它那一条（INT-003）
  const recheck = (patch: Partial<typeof values>) => setErrors((e) => {
    const now = fieldErrors({ ...values, ...patch });
    const next: Record<string, string> = {};
    for (const id of Object.keys(e)) if (now[id]) next[id] = now[id];
    return next;
  });

  const pickKind = (k: ChannelKind) => {
    setKind(k); const v = DEFAULT_VENDOR[k]; setVendor(v);
    const ep = endpointTouched ? endpoint : k === 'openai' ? VENDOR_PRESETS[v].endpoint : '';
    if (!endpointTouched) setEndpoint(ep);
    recheck({ kind: k, endpoint: ep });
  };
  const pickVendor = (v: ChannelVendor) => { setVendor(v); if (!endpointTouched) { setEndpoint(VENDOR_PRESETS[v].endpoint); recheck({ endpoint: VENDOR_PRESETS[v].endpoint }); } };

  const validate = () => {
    const e = fieldErrors(values);
    setErrors(e);
    const first = FIELD_ORDER.find((id) => e[id]);
    if (first) document.getElementById(first)?.focus();
    return !first;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (keyBlocked) return;
    setServerError(null); setProbe(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const body = { label: label.trim(), endpoint: local ? undefined : endpoint.trim() || undefined, model: model.trim() };
      const ch = saved
        ? (await api.channels.update(saved.id, { ...body, ...(apiKey ? { apiKey } : {}) })).channel
        : (await api.channels.create({ kind, vendor, ...body, apiKey })).channel;
      setSaved(ch); setApiKey(''); p.onSaved();
      const r = await api.probeRunner(`channel:${ch.id}`);
      setProbe(r); p.onSaved();
      if (r.ok) { toast(r.latencyMs != null ? t('channels.dialog.verifiedLatency', { name: ch.label, ms: r.latencyMs }) : t('channels.dialog.verified', { name: ch.label })); p.onClose(); return; }
    } catch (e) {
      setServerError(problemText(e, t('channels.dialog.saveFailed')));
    } finally { setSaving(false); }
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const err = (id: string) => errors[id] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
  // 普通函数而不是内嵌组件：内嵌组件每次渲染都是新类型，会整段重挂、role=alert 反复播报
  const errorLine = (id: string) => (errors[id] ? <p id={`${id}-error`} role="alert" className="mt-1 type-label text-error">{errors[id]}</p> : null);
  const endpointPlaceholder = kind === 'openai' ? (VENDOR_PRESETS[vendor].endpoint || 'https://…/v1') : t('channels.dialog.endpointDefault', { endpoint: VENDOR_PRESETS[DEFAULT_VENDOR[kind]].endpoint });

  return (
    <Overlay onClose={dirty ? () => {} : p.onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="ch-title" data-testid="channel-dialog" tabIndex={-1} noValidate onSubmit={submit}
        className="sheet scroll max-h-[calc(100dvh-2rem)] w-full max-w-md p-5 fade-up outline-none">
        <h2 id="ch-title" className="type-heading3 font-semibold">{editing ? t('channels.dialog.editTitle', { name: saved!.label }) : t('channels.add')}</h2>
        <p className="mt-1 type-label text-text-secondary">{t('channels.dialog.intro')}</p>
        {(serverError || (probe && !probe.ok)) && (
          <p ref={alertRef} tabIndex={-1} role="alert" className="tint-error mt-3 rounded-md px-3 py-2 type-label outline-none [overflow-wrap:anywhere]">
            {serverError ?? t('channels.dialog.savedButFailed', { error: probe?.error ?? t('channels.probe.unknown') })}
          </p>
        )}
        <div className="mt-4 space-y-4">
          <Field label={t('channels.dialog.kind')} htmlFor="ch-kind">
            <Select id="ch-kind" value={kind} onChange={(v) => pickKind(v as ChannelKind)} disabled={editing} aria-label={t('channels.dialog.kindLabel')}
              options={(Object.keys(KIND_KEY) as ChannelKind[]).map((k) => ({ value: k, label: t(`drivers.${KIND_KEY[k]}`), icon: <VendorIcon vendor={DEFAULT_VENDOR[k]} size={14} /> }))} />
          </Field>
          {kind === 'openai' && !editing && (
            <Field label={t('channels.dialog.vendor')} htmlFor="ch-vendor" hint={t('channels.dialog.vendorHint')}>
              <Select id="ch-vendor" value={vendor} onChange={(v) => pickVendor(v as ChannelVendor)} aria-label={t('channels.dialog.vendor')}
                options={OPENAI_VENDORS.map((v) => { const key = VENDOR_KEY[v]; return { value: v, label: key ? t(`channels.vendors.${key}`) : VENDOR_PRESETS[v].label, icon: <VendorIcon vendor={v} size={14} /> }; })} />
            </Field>
          )}
          <Field label={t('channels.dialog.label')} htmlFor="ch-label">
            <Input id="ch-label" name="label" value={label} onChange={(e) => { setLabel(e.target.value); recheck({ label: e.target.value }); }} placeholder={t('channels.dialog.labelPlaceholder')} maxLength={60} autoComplete="off" data-1p-ignore data-lpignore="true" {...err('ch-label')} />
            {errorLine('ch-label')}
          </Field>
          {!local && (
          <Field label={t(kind === 'openai' ? 'channels.dialog.endpointRequired' : 'channels.dialog.endpointOptional')} htmlFor="ch-endpoint">
            <Input id="ch-endpoint" name="endpoint" type="url" inputMode="url" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setEndpointTouched(true); recheck({ endpoint: e.target.value }); }} placeholder={endpointPlaceholder} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-endpoint')} />
            {errorLine('ch-endpoint')}
          </Field>
          )}
          <Field label={t('channels.dialog.model')} htmlFor="ch-model">
            {/* autoComplete="off" 在 Chromium 上常被忽略：实测这个框被密码管理器自动填成了邮箱。
                给一个语义不相干的具体值（浏览器只会拿它匹配同类字段），再加两家密码管理器的忽略属性 */}
            <Input id="ch-model" name="model" value={model} onChange={(e) => { setModel(e.target.value); recheck({ model: e.target.value }); }} placeholder={t('channels.dialog.modelPlaceholder', { model: MODEL_HINT[vendor] })} maxLength={80} autoComplete="one-time-code" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-model')} />
            {errorLine('ch-model')}
          </Field>
          {/* 密钥框的容器标 data-record="off"：本机使用记录的浏览器采集据此跳过它（INV-CORE-006） */}
          {!local && (
          <div data-record="off">
          <Field label="API Key" htmlFor="ch-key" hint={t(editing ? 'channels.dialog.keyHintEdit' : 'channels.dialog.keyHintNew')}>
            <Input id="ch-key" name="apiKey" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); recheck({ apiKey: e.target.value }); }} placeholder={editing && saved?.apiKeyHint ? `••••${saved.apiKeyHint}` : 'sk-…'} autoComplete="new-password" data-1p-ignore data-lpignore="true" spellCheck={false} className="font-mono" {...err('ch-key')} />
            {errorLine('ch-key')}
          </Field>
          </div>
          )}
          {kind === 'agent-sdk' && (
            <p className="fill rounded-md p-3 type-label leading-(--semantic-typography-body-line-height) text-text-secondary">
              <Trans ns={settingsMessages.ns} i18nKey="channels.dialog.agentSdkNote" components={{ code: <code className="font-mono text-text-primary" /> }} />
            </p>
          )}
          {kind === 'codex' && (
            <p className="fill rounded-md p-3 type-label leading-(--semantic-typography-body-line-height) text-text-secondary">
              <Trans ns={settingsMessages.ns} i18nKey="channels.dialog.codexNote" components={{ code: <code className="font-mono text-text-primary" /> }} />
            </p>
          )}
        </div>
        {keyBlocked && <p className="mt-4 type-label leading-(--semantic-typography-body-line-height) text-warning"><Trans ns={settingsMessages.ns} i18nKey="channels.dialog.keyBlocked" components={{ code: <code className="font-mono" /> }} /></p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={p.onClose}>{tc('cancel')}</Button>
          <Button type="submit" variant="primary" data-testid="ch-save" pending={saving} disabled={keyBlocked}>{t('channels.dialog.save')}</Button>
        </div>
      </form>
    </Overlay>
  );
}
