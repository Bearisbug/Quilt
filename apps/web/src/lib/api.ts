import type { AssetDto, DesignPresetDto, Palette, ColorMode, ProblemDto, ConfigDto, ProjectDto, ProjectDetailDto, MessageDto, JobDto, RevisionDto, ScreenDto, UsageDto, DesignSystemDto, LinkDto, ElementOp, AnnotationDto, RunnerOptionDto, AgentSessionDto, ProjectEventDto, Runner, ChannelDto, ChannelKind, ChannelVendor, ProbeResultDto, CandidatesDto, ScreenCount, JobRunner, ComponentDto } from '@quilt/core';

// API 客户端：同源 /v1（开发时 Vite 代理 → API；打包后 API 进程自己托管前端），错误统一为 ApiError（RFC 9457 信封）。
// v0.32 本地版没有登录：所有请求都是默认用户。
export class ApiError extends Error {
  constructor(public status: number, public problem: ProblemDto) { super(problem.title); }
  get type() { return this.problem.type; }
}

async function call<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
  // FormData 的 Content-Type 必须由浏览器带 boundary 生成，手写会让服务端解不出分段（素材直传走这条）
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data ?? { type: '/errors/unknown', title: res.statusText, status: res.status, requestId: res.headers.get('x-request-id') ?? '' });
    return data as T;
  } finally { clearTimeout(timer); }
}

/** 组件建 / 改的返回：applied = 被同步（确定性回刷）的屏，skipped = 没找到对应元素或正忙而跳过的屏 */
export type ComponentSyncResult = { component: ComponentDto; applied: string[]; skipped: { screenId: string; name: string; reason: string }[] };

// 运行时配置（API-CORE-028）：启动时取一次，预览域地址随打包 / 开发环境变
let configPromise: Promise<ConfigDto> | null = null;
export const loadConfig = () => (configPromise ??= call<ConfigDto>('/v1/config'));

export const api = {
  projects: {
    list: () => call<{ items: ProjectDto[]; nextCursor: string | null }>('/v1/projects'),
    create: (input: { name: string; deviceType: 'mobile' | 'desktop'; seedColor?: string; presetId?: string }) => call<{ project: ProjectDto; designSystem: DesignSystemDto }>('/v1/projects', { method: 'POST', body: JSON.stringify(input) }),
    get: (id: string) => call<ProjectDetailDto>(`/v1/projects/${id}`),
    appMap: (id: string) => call<{ nodes: { screenId: string; route: string }[]; edges: LinkDto[] }>(`/v1/projects/${id}/app-map`),
    messages: (id: string) => call<{ items: MessageDto[]; nextCursor: string | null }>(`/v1/projects/${id}/messages?limit=100`),
    // 动词由目标决定（API-CORE-010）：有 targetScreenIds 是改，没有是造；count / versions / anchor 是造改共用的档位。
    // mode="chat"（REQ-CORE-023）：交给助手定范围，targetScreenIds 只是上下文提示
    // targetComponentIds（REQ-EDIT-006）：只有组件没有屏 = 改这个组件；与屏 / 锚点同发 = 它们的完整 HTML 进上下文
    send: (id: string, body: { content: string; mode?: 'chat'; targetScreenIds?: string[]; targetComponentIds?: string[]; count?: ScreenCount; versions?: number; anchor?: { x: number; y: number }; runner?: Runner; attachmentIds?: string[] }) =>
      call<{ userMessage: MessageDto; assistantMessage: MessageDto; job: JobDto }>(`/v1/projects/${id}/messages`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: crypto.randomUUID() }),
    // 删项目（API-CORE-031）：行级联 + 对象文件清理；有进行中作业时 409 /errors/project-busy
    remove: (id: string) => call<void>(`/v1/projects/${id}`, { method: 'DELETE' }),
    // 应用简介 / 样板屏（API-CORE-027）
    patch: (id: string, patch: { name?: string; brief?: string; exemplarScreenId?: string | null }) => call<{ project: ProjectDto }>(`/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    // 参考图两步走（REQ-CORE-012）：先要一个签名 PUT，再把正文直传对象存储，不经过 API 的 JSON 体
    uploadImage: async (projectId: string, file: File): Promise<string> => {
      const { attachmentId, putUrl } = await call<{ attachmentId: string; putUrl: string }>(`/v1/projects/${projectId}/attachments`, { method: 'POST', body: JSON.stringify({ mediaType: file.type, bytes: file.size }) });
      // 直传目标是 API 自己签的绝对地址，不走同源 /v1 代理，所以这里用裸 fetch
      const r = await fetch(putUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }, credentials: 'omit' });
      if (!r.ok) throw new Error(`上传失败 ${r.status}`);
      return attachmentId;
    },
    createJob: (id: string, body: unknown) => call<{ job: JobDto }>(`/v1/projects/${id}/jobs`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: crypto.randomUUID() }),
    // 作业列表（API-CORE-029）：本机 agent 面板
    jobs: (id: string, runner?: JobRunner) => call<{ items: JobDto[] }>(`/v1/projects/${id}/jobs${runner ? `?runner=${runner}` : ''}`),
  },
  jobs: {
    get: (id: string) => call<{ job: JobDto }>(`/v1/jobs/${id}`),
    cancel: (id: string) => call<{ job: JobDto }>(`/v1/jobs/${id}/cancel`, { method: 'POST' }),
    // 候选就地展开（API-CORE-026 / API-CORE-025 整组采用）
    candidates: (id: string) => call<CandidatesDto>(`/v1/jobs/${id}/candidates`),
    adoptGroup: (id: string, index: number) => call<{ adopted: string[]; skipped: string[] }>(`/v1/jobs/${id}/candidates/adopt`, { method: 'POST', body: JSON.stringify({ index }) }),
  },
  screens: {
    patch: (id: string, patch: { x?: number; y?: number; name?: string; route?: string }) => call<{ screen: ScreenDto }>(`/v1/screens/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => call<void>(`/v1/screens/${id}`, { method: 'DELETE' }),
    revisions: (id: string) => call<{ items: RevisionDto[] }>(`/v1/screens/${id}/revisions`),
    restore: (id: string, revisionId: string, expectedRevisionId: string) => call<{ revision: RevisionDto }>(`/v1/screens/${id}/revisions/${revisionId}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevisionId }) }),
    // 采用候选（API-CORE-025 单格）：只改 current 指针，不建新修订
    adopt: (id: string, revisionId: string) => call<{ screen: ScreenDto }>(`/v1/screens/${id}/revisions/${revisionId}/adopt`, { method: 'POST' }),
    editElement: (id: string, qid: string, ops: ElementOp[], expectedRevisionId: string) => call<{ revision: RevisionDto }>(`/v1/screens/${id}/elements/${qid}`, { method: 'POST', body: JSON.stringify({ ops, expectedRevisionId }) }),
  },
  // 项目素材（API-CORE-032）：multipart 直传，浏览器自己带 Content-Type
  assets: {
    list: (projectId: string) => call<{ items: AssetDto[] }>(`/v1/projects/${projectId}/assets`),
    upload: (projectId: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<{ asset: AssetDto }>(`/v1/projects/${projectId}/assets`, { method: 'POST', body: form });
    },
    remove: (assetId: string) => call<void>(`/v1/assets/${assetId}`, { method: 'DELETE' }),
  },
  // 设计预设（API-CORE-033）：账号级，跨项目复用一套视觉
  presets: {
    list: () => call<{ items: DesignPresetDto[] }>('/v1/design-presets'),
    create: (input: { projectId: string; name: string; includeAssets?: boolean }) => call<{ preset: DesignPresetDto }>('/v1/design-presets', { method: 'POST', body: JSON.stringify(input) }),
    remove: (presetId: string) => call<void>(`/v1/design-presets/${presetId}`, { method: 'DELETE' }),
    apply: (projectId: string, input: { presetId: string; expectedVersion: number }) =>
      call<{ designSystem: DesignSystemDto; assetsCopied: number; skipped: number }>(`/v1/projects/${projectId}/design-preset`, { method: 'POST', body: JSON.stringify(input) }),
  },
  // 共享组件（API-EDIT-004 / REQ-EDIT-006）：从屏里提取或直接给 HTML；改内容 / 改名带 expectedVersion，只挪位置不带
  components: {
    create: (projectId: string, body: { name: string; html: string } | { name: string; fromScreenId: string; qid: string; applyToScreens?: boolean }) =>
      call<ComponentSyncResult>(`/v1/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: { name?: string; html?: string; x?: number; y?: number; expectedVersion?: number }) =>
      call<ComponentSyncResult>(`/v1/components/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => call<void>(`/v1/components/${id}`, { method: 'DELETE' }),
  },
  designSystem: {
    update: (projectId: string, patch: { seedColor?: string; fontFamily?: string; fontSource?: 'google' | 'system' | 'url'; fontUrl?: string | null; radiusScale?: 'sharp' | 'default' | 'round'; palette?: Palette | null; colorMode?: ColorMode; designMd?: string; conventions?: string[]; expectedVersion: number }) => call<{ designSystem: DesignSystemDto }>(`/v1/projects/${projectId}/design-system`, { method: 'PUT', body: JSON.stringify(patch) }),
  },
  annotations: {
    listForScreen: (screenId: string) => call<{ items: AnnotationDto[] }>(`/v1/screens/${screenId}/annotations`),
    create: (screenId: string, input: { qid: string; note: string; anchorText: string; rect: AnnotationDto['rect'] }) =>
      call<{ annotation: AnnotationDto }>(`/v1/screens/${screenId}/annotations`, { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, patch: { note?: string; status?: AnnotationDto['status'] }) => call<{ annotation: AnnotationDto }>(`/v1/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => call<void>(`/v1/annotations/${id}`, { method: 'DELETE' }),
    send: (projectId: string, annotationIds: string[]) => call<{ jobs: JobDto[] }>(`/v1/projects/${projectId}/annotations/send`, { method: 'POST', body: JSON.stringify({ annotationIds }) }),
  },
  runners: () => call<{ items: RunnerOptionDto[]; default: string }>('/v1/runners'),
  // 本机正在运行的 Claude Code 会话（API-AGENT-010）：会话下拉打开时取
  agentSessions: () => call<{ items: AgentSessionDto[] }>('/v1/agent/sessions'),
  // 生成通道可配置（REQ-CORE-013）
  probeRunner: (runnerId: string) => call<ProbeResultDto>(`/v1/runners/${encodeURIComponent(runnerId)}/probe`, { method: 'POST' }),
  channels: {
    list: () => call<{ items: ChannelDto[] }>('/v1/channels'),
    create: (body: { kind: ChannelKind; vendor?: ChannelVendor; label: string; endpoint?: string; model: string; apiKey: string }) => call<{ channel: ChannelDto }>('/v1/channels', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { label?: string; endpoint?: string; model?: string; apiKey?: string }) => call<{ channel: ChannelDto }>(`/v1/channels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => call<void>(`/v1/channels/${id}`, { method: 'DELETE' }),
  },
  exportUrl: (jobId: string) => `/v1/jobs/${jobId}/export`,
  usage: () => call<UsageDto>('/v1/me/usage'),
};

// SSE：作业事件流（API-CORE-008），断线自动重连并按 Last-Event-ID 续传（EventSource 内建）。
// 项目级事件（API-CORE-030）：本机会话经 MCP 回写、别处建的作业、截图就绪——画布收到就刷新；EventSource 自带断线重连
export function subscribeProjectEvents(projectId: string, onEvent: (e: ProjectEventDto) => void): () => void {
  const es = new EventSource(`/v1/projects/${projectId}/events`);
  const handler = (ev: MessageEvent) => { try { onEvent(JSON.parse(ev.data) as ProjectEventDto); } catch { /* ignore */ } };
  for (const t of ['screen_changed', 'job_changed']) es.addEventListener(t, handler as EventListener);
  return () => es.close();
}
