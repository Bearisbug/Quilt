import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENT_BYTES, type AttachmentDto } from '@quilt/core';
import { storage } from '../lib/storage.ts';
import { problems } from '../lib/errors.ts';

// 参考图附件（REQ-CORE-012 / API-CORE-019）。
// 附件不进数据库自己的表：它只在「被某条消息引用」时才有意义，引用关系存在 messages.attachments 里。
// 没被引用的就是孤儿，由对象存储的生命周期清理——为一次性上传建一张表、再写一套回收，不划算。

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type StoredAttachment = { id: string; key: string; mediaType: string; bytes: number };

export const attachmentKey = (projectId: string, id: string, mediaType: string) =>
  `projects/${projectId}/attachments/${id}.${EXT[mediaType] ?? 'bin'}`;

/** 签发直传 URL。签名沿用对象存储那一套，10 分钟有效 */
export async function createUpload(projectId: string, input: { mediaType: string; bytes: number }) {
  const { signObject } = await import('../lib/signing.ts');
  const id = crypto.randomUUID();
  const key = attachmentKey(projectId, id, input.mediaType);
  const exp = Math.floor(Date.now() / 1000) + 600;
  return {
    attachmentId: id,
    // 相对路径：正文直传走与其余 API 调用同一个同源通道，不必为一次 PUT 开 CORS。
    // 路径前缀 /v1/attachments/ 在鉴权中间件里豁免——这条靠签名认证，不靠会话。
    putUrl: `/v1/attachments/${projectId}/${id}?exp=${exp}&sig=${signObject(key, exp)}&mt=${encodeURIComponent(input.mediaType)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** 直传落库。类型与大小在这里复核一次——签发时报的 bytes 只是声明，真正到货的才算数 */
export async function storeUpload(key: string, mediaType: string, body: Buffer): Promise<void> {
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw problems.validation([{ path: 'mediaType', message: `只支持 ${IMAGE_MEDIA_TYPES.join(' / ')}` }]);
  }
  if (body.byteLength > MAX_ATTACHMENT_BYTES) {
    throw problems.validation([{ path: 'body', message: `单张最大 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }]);
  }
  if (!body.byteLength) throw problems.validation([{ path: 'body', message: '空文件' }]);
  await storage.put(key, body, mediaType);
}

/** 按 id 找附件：扩展名由类型决定、类型又只有三种，逐个试比另建一张索引表便宜 */
export async function locateAttachment(projectId: string, id: string): Promise<(StoredAttachment & { buf: Buffer }) | null> {
  for (const mediaType of IMAGE_MEDIA_TYPES) {
    const key = attachmentKey(projectId, id, mediaType);
    const buf = await storage.get(key).catch(() => null);
    if (buf) return { id, key, mediaType, bytes: buf.byteLength, buf };
  }
  return null;
}

/** 把前端给的 attachmentIds 收成可落库的引用；取不到正文的（没传完 / 过期）直接判非法，不静默丢 */
export async function resolveForMessage(projectId: string, ids: string[] | undefined): Promise<StoredAttachment[]> {
  if (!ids?.length) return [];
  const out: StoredAttachment[] = [];
  for (const id of ids) {
    const found = await locateAttachment(projectId, id);
    if (!found) throw problems.validation([{ path: 'attachmentIds', message: `附件 ${id} 未上传完成或已过期` }]);
    out.push({ id: found.id, key: found.key, mediaType: found.mediaType, bytes: found.bytes });
  }
  return out;
}

export async function dtos(items: StoredAttachment[]): Promise<AttachmentDto[]> {
  return Promise.all(items.map(async (a) => ({ id: a.id, mediaType: a.mediaType, bytes: a.bytes, url: await storage.signedUrl(a.key) })));
}

/** worker 侧：按 key 取正文转 base64 交给模型 */
export async function loadForModel(keys: string[] | undefined): Promise<{ mediaType: string; dataBase64: string }[]> {
  if (!keys?.length) return [];
  const out: { mediaType: string; dataBase64: string }[] = [];
  for (const key of keys) {
    const buf = await storage.get(key).catch(() => null);
    if (!buf) continue; // 图没了不该让整轮生成失败，提示词里本来就把它写成「参考」
    const ext = key.split('.').pop() ?? '';
    const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    out.push({ mediaType, dataBase64: buf.toString('base64') });
  }
  return out;
}
