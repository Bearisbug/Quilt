import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

// 落库密钥的对称加密（ADR-013）：AES-256-GCM，密钥由 QUILT_SECRETS_KEY 经 sha256 派生——
// 接受任意长度口令，同时保证总是 32 字节。格式 enc:v1:<iv>:<tag>:<ct>（都是 base64url），
// 版本号留给将来换算法。主密钥缺失时加密直接抛错，绝不回落成明文存储。
const FORMAT = 'enc:v1';
export const secretsConfigured = (): boolean => config.secretsKey.length > 0;
const key = () => createHash('sha256').update(config.secretsKey).digest();

export function encryptSecret(plain: string): string {
  if (!secretsConfigured()) throw new Error('QUILT_SECRETS_KEY 未配置');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${FORMAT}:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function decryptSecret(enc: string): string {
  if (!secretsConfigured()) throw new Error('QUILT_SECRETS_KEY 未配置');
  const [e, v, iv, tag, ct] = enc.split(':');
  if (`${e}:${v}` !== FORMAT || !iv || !tag || !ct) throw new Error('密文格式不对');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** 给用户辨认用的末 4 位；短于 8 位的密钥不给提示，免得等于泄漏一半 */
export const secretHint = (plain: string): string | null => (plain.length >= 8 ? plain.slice(-4) : null);
