import { and, asc, eq } from 'drizzle-orm';
import { VENDOR_PRESETS, type ChannelDto, type ChannelKind, type ChannelVendor, type ChannelStatus, type ProbeResultDto, type RunnerOptionDto } from '@quilt/core';
import { db, schema } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { decryptSecret, encryptSecret, secretHint, secretsConfigured } from '../lib/secrets.ts';
import { driverSupportsVision, llmFor, type LlmDriver, type LlmSpec } from '../lib/llm.ts';
import { SETUP_HINT, toolAvailable } from '../lib/agentCli.ts';
import type { UserRow } from './user.ts';

// 生成通道可配置（REQ-CORE-013 / API-CORE-020~023）。
// 两类来源合成一张目录：用户自己配的通道（本表，v0.34 起云端通道只有这一种来源——开源自用，没有「系统预置」）、
// 本机 agent（Claude Code，看 PATH，不入库）。密钥按 ADR-013 加密；任何出口都不带明文。

type Row = typeof schema.channels.$inferSelect;
const KIND_DRIVER: Record<ChannelKind, LlmDriver> = { anthropic: 'anthropic', gemini: 'gemini', openai: 'openai', 'agent-sdk': 'agent-sdk' };
const KIND_VENDOR: Record<ChannelKind, ChannelVendor> = { anthropic: 'anthropic', gemini: 'google', openai: 'custom', 'agent-sdk': 'claude-subscription' };
const PROBE = { system: 'Reply with exactly the word OK and nothing else.', prompt: 'ping', maxTokens: 8 };
// 探测超时按驱动分档：agent-sdk 每次都要拉起子进程、带约 14K token 的缓存前缀，实测冷启动 2.5~3.5 s、
// 抖动时能到十几秒；给它和 HTTP 驱动同一个 15 s 会把「慢但可用」误判成「不可用」（用户实测反馈）。
const PROBE_TIMEOUT_MS: Record<LlmDriver, number> = { 'agent-sdk': 60_000, anthropic: 20_000, gemini: 20_000, openai: 20_000, stub: 5_000 };

export const channelDto = (r: Row): ChannelDto => ({
  id: r.id, kind: r.kind as ChannelKind, vendor: r.vendor as ChannelVendor, label: r.label, endpoint: r.endpoint, model: r.model,
  apiKeyHint: r.apiKeyHint, status: r.status as ChannelStatus, lastProbeAt: r.lastProbeAt?.toISOString() ?? null, lastError: r.lastError, createdAt: r.createdAt.toISOString(),
});

const needSecrets = () => {
  if (!secretsConfigured()) throw problems.validation([{ path: 'apiKey', message: '服务端未配置 QUILT_SECRETS_KEY，无法加密保存密钥；请在 .env 设置后重启' }]);
};

async function owned(userId: string, id: string): Promise<Row> {
  const [row] = await db.select().from(schema.channels).where(and(eq(schema.channels.id, id), eq(schema.channels.userId, userId)));
  if (!row) throw problems.notFound();
  return row;
}

export async function listChannels(userId: string): Promise<Row[]> {
  return db.select().from(schema.channels).where(eq(schema.channels.userId, userId)).orderBy(asc(schema.channels.createdAt));
}

export async function createChannel(userId: string, input: { kind: ChannelKind; vendor?: ChannelVendor; label: string; endpoint?: string; model: string; apiKey?: string }): Promise<Row> {
  // 只有真要存密钥时才要求主密钥：本机订阅没有 Key，不该被 QUILT_SECRETS_KEY 挡住
  if (input.apiKey) needSecrets();
  const vendor = input.vendor ?? KIND_VENDOR[input.kind];
  const endpoint = input.endpoint ?? (VENDOR_PRESETS[vendor].endpoint || null);
  const [row] = await db.insert(schema.channels).values({
    userId, kind: input.kind, vendor, label: input.label, endpoint, model: input.model,
    apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : null,
    apiKeyHint: input.apiKey ? secretHint(input.apiKey) : null,
    status: 'unverified',
  }).returning();
  return row;
}

export async function updateChannel(userId: string, id: string, patch: { label?: string; endpoint?: string; model?: string; apiKey?: string }): Promise<Row> {
  const cur = await owned(userId, id);
  const set: Partial<typeof schema.channels.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label;
  let reverify = false;
  if (patch.endpoint !== undefined && patch.endpoint !== cur.endpoint) { set.endpoint = patch.endpoint; reverify = true; }
  if (patch.model !== undefined && patch.model !== cur.model) { set.model = patch.model; reverify = true; }
  if (patch.apiKey) { needSecrets(); set.apiKeyEnc = encryptSecret(patch.apiKey); set.apiKeyHint = secretHint(patch.apiKey); reverify = true; }
  // 端点 / 模型 / 密钥任一变了，上次的验证结论就不再成立
  if (reverify) { set.status = 'unverified'; set.lastError = null; }
  const [row] = await db.update(schema.channels).set(set).where(eq(schema.channels.id, id)).returning();
  return row;
}

export async function deleteChannel(userId: string, id: string): Promise<void> {
  await owned(userId, id);
  await db.delete(schema.channels).where(eq(schema.channels.id, id));
}

/** worker 用：把作业里的 channelId 还原成可调用的驱动规格（此时才解密） */
export async function resolveChannelSpec(userId: string, channelId: string): Promise<LlmSpec & { model: string }> {
  const [row] = await db.select().from(schema.channels).where(and(eq(schema.channels.id, channelId), eq(schema.channels.userId, userId)));
  if (!row) throw new Error('通道已删除或不属于该账号');
  const driver = KIND_DRIVER[row.kind as ChannelKind];
  // 本机订阅没有密钥，凭据是机器上的 claude 登录态
  if (driver === 'agent-sdk') return { driver, model: row.model };
  if (!row.apiKeyEnc) throw new Error('通道没有密钥');
  let apiKey: string;
  try { apiKey = decryptSecret(row.apiKeyEnc); }
  catch { throw new Error('通道密钥无法解密：QUILT_SECRETS_KEY 已更换，请到设置页重新填写'); }
  return { driver, model: row.model, apiKey, baseUrl: row.endpoint ?? undefined };
}

const AGENT_SDK_HINT = '在本机终端执行 `claude` 并完成登录；Quilt 进程会复用这份登录态。';

/** 统一目录（API-CORE-023）：输入框只渲染 available 的，设置页渲染全部 */
export async function runnerCatalog(user: UserRow): Promise<{ items: RunnerOptionDto[]; default: string }> {
  const mine: RunnerOptionDto[] = (await listChannels(user.id)).map((r) => ({
    id: `channel:${r.id}`, label: r.label, hint: r.model, runner: { kind: 'channel' as const, channelId: r.id },
    available: r.status === 'verified',
    unavailableReason: r.status === 'failed' ? `验证失败：${r.lastError ?? '未知原因'}` : r.status === 'unverified' ? '尚未验证：在设置页点「验证」' : undefined,
    vision: driverSupportsVision(KIND_DRIVER[r.kind as ChannelKind]), source: 'channel' as const, vendor: r.vendor as ChannelVendor, status: r.status as ChannelStatus, channelId: r.id, channelKind: r.kind as ChannelKind,
    ...(r.kind === 'agent-sdk' ? { setupHint: AGENT_SDK_HINT } : {}),
  }));
  // 本机 agent（REQ-AGENT-003 v0.34）：PATH 上有 claude 就算装了；投给哪个会话由输入框旁的会话下拉决定，
  // 这里的 runner 只是模板（sessionId 留空），前端发送时填上选中的会话
  const claude = toolAvailable('claude-code');
  const agents: RunnerOptionDto[] = [{
    id: 'agent:claude-code', label: '交给本机 Claude Code', hint: claude.version ?? '本机 CLI',
    runner: { kind: 'agent' as const, tool: 'claude-code' as const, sessionId: '' }, available: claude.ok, unavailableReason: claude.ok ? undefined : claude.hint,
    vision: true, source: 'builtin' as const, vendor: 'anthropic' as const, setupHint: SETUP_HINT['claude-code'],
  }];
  const items = [...mine, ...agents];
  const pick = (pred: (i: RunnerOptionDto) => boolean) => items.find(pred)?.id;
  return { items, default: pick((i) => i.available && i.runner.kind !== 'agent') ?? pick((i) => i.available) ?? items[0]?.id ?? '' };
}

/** 验证（API-CORE-022）：通道实际发一次最小请求、结论落库；agent 类看 PATH 上有没有 CLI */
export async function probeRunner(user: UserRow, runnerId: string): Promise<ProbeResultDto> {
  const t0 = Date.now();
  const ping = async (spec: LlmSpec, model: string) => { await llmFor(spec).complete({ ...PROBE, model, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS[spec.driver]) }); };
  const errorText = (e: unknown) => String((e as Error).message ?? e).replace(/\s+/g, ' ').slice(0, 200);

  if (runnerId.startsWith('channel:')) {
    const row = await owned(user.id, runnerId.slice('channel:'.length));
    let result: ProbeResultDto;
    try { const spec = await resolveChannelSpec(user.id, row.id); await ping(spec, spec.model); result = { ok: true, latencyMs: Date.now() - t0 }; }
    catch (e) { result = { ok: false, error: errorText(e) }; }
    await db.update(schema.channels).set({ status: result.ok ? 'verified' : 'failed', lastProbeAt: new Date(), lastError: result.ok ? null : result.error, updatedAt: new Date() }).where(eq(schema.channels.id, row.id));
    return result;
  }
  if (runnerId.startsWith('agent:')) {
    const tool = runnerId.slice('agent:'.length);
    const a = toolAvailable(tool);
    return a.ok ? { ok: true, detail: `已找到 ${a.version ?? tool}；画布派的活会投递到你在输入框旁选中的会话` } : { ok: false, error: a.hint };
  }
  throw problems.notFound();
}
