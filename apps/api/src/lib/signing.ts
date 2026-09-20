import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

// 过期时间对齐到 30 分钟窗口（v0.34）：同一窗口内同一对象的签名 URL 字符串完全一致。画布每次刷新都重取项目，
// URL 一变卡片 <img> 就整批重新请求、全屏闪一下（有了项目级事件流后每次回写都刷，尤其明显）；对齐后 React 看到
// 同一字符串不动 DOM。有效期 = 至少 minutes，至多 minutes + 30 分钟；本地单用户版可接受
export function stableExpiry(minutes: number, windowSec = 1800): number {
  const now = Math.floor(Date.now() / 1000);
  return (Math.floor(now / windowSec) + 1) * windowSec + minutes * 60;
}

// 预览 URL 签名（API-CORE-016）：t = base64url(projectId.exp).sig
export function signPreview(projectId: string, expiresAtSec: number): string {
  const payload = `${projectId}.${expiresAtSec}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmac(config.previewSigningSecret, payload)}`;
}

export function verifyPreview(token: string, projectId: string): boolean {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return false;
  const payload = Buffer.from(b64, 'base64url').toString();
  const [pid, expStr] = payload.split('.');
  if (pid !== projectId) return false;
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return false;
  const expected = hmac(config.previewSigningSecret, payload);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// 对象签名 URL（fs 存储驱动用；s3 驱动走 presigner）
export function signObject(key: string, expiresAtSec: number): string {
  return hmac(config.previewSigningSecret, `obj:${key}:${expiresAtSec}`);
}
export function verifyObject(key: string, expiresAtSec: number, sig: string): boolean {
  if (expiresAtSec < Math.floor(Date.now() / 1000)) return false;
  const expected = signObject(key, expiresAtSec);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
