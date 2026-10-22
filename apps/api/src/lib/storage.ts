import { mkdir, readFile, writeFile, unlink, rm, readdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { signObject, stableExpiry } from './signing.ts';

// 对象存储（§6/§17）：修订 HTML、截图、导出。fs 驱动用于本地开发/测试，s3 用于生产。
export interface Storage {
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** 删掉某前缀下的全部对象（删项目时清它的修订 HTML / 截图 / 导出） */
  deletePrefix(prefix: string): Promise<void>;
  /** 列出某前缀下的对象与最后写入时间（upload.gc 按它判闲置） */
  list(prefix: string): Promise<{ key: string; modifiedAt: Date }[]>;
  /** 递归列出某前缀下的全部对象与字节数（使用记录的占用统计与归档拷贝用，REQ-CORE-047） */
  listDeep(prefix: string): Promise<{ key: string; bytes: number }[]>;
  copy(from: string, to: string): Promise<void>;
  /** 对象在本机的绝对路径；对象存储不是本地 fs 时为 null */
  localPath(key: string): string | null;
  signedUrl(key: string, minutes?: number): Promise<string>;
}

class FsStorage implements Storage {
  private root = path.join(config.dataDir, 'objects');
  private p(key: string) {
    if (key.includes('..')) throw new Error('bad key');
    return path.join(this.root, key);
  }
  async put(key: string, body: Buffer | string) {
    const file = this.p(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  get(key: string) { return readFile(this.p(key)); }
  async delete(key: string) { await unlink(this.p(key)).catch(() => {}); }
  async deletePrefix(prefix: string) { await rm(this.p(prefix), { recursive: true, force: true }); }
  async list(prefix: string) {
    const dir = this.p(prefix);
    const names = await readdir(dir).catch(() => [] as string[]);
    const found = await Promise.all(names.map((n) => stat(path.join(dir, n)).then((s) => ({ key: `${prefix}${n}`, modifiedAt: s.mtime }), () => null)));
    return found.filter((o) => o !== null);
  }
  async listDeep(prefix: string) {
    const entries = await readdir(this.p(prefix), { recursive: true, withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((e) => e.isFile()).map(async (e) => {
      const file = path.join(e.parentPath, e.name);
      return { key: path.relative(this.root, file).split(path.sep).join('/'), bytes: (await stat(file)).size };
    }));
  }
  async copy(from: string, to: string) {
    const file = this.p(to);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(this.p(from), file);
  }
  localPath(key: string) { return this.p(key); }
  async signedUrl(key: string, minutes = config.objectUrlMinutes) {
    const exp = stableExpiry(minutes);
    return `${config.apiOrigin}/v1/objects/${encodeURIComponent(key)}?exp=${exp}&sig=${signObject(key, exp)}`;
  }
}

class S3Storage implements Storage {
  private client: import('@aws-sdk/client-s3').S3Client | null = null;
  private async c() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: config.s3.region, endpoint: config.s3.endpoint || undefined, forcePathStyle: !!config.s3.endpoint, credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } });
    }
    return this.client;
  }
  async put(key: string, body: Buffer | string, contentType: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.c()).send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await (await this.c()).send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.c()).send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  }
  async deletePrefix(prefix: string) {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const client = await this.c();
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: config.s3.bucket, Delete: { Objects: keys } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  async list(prefix: string) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.c();
    const out: { key: string; modifiedAt: Date }[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) out.push({ key: o.Key!, modifiedAt: o.LastModified ?? new Date(0) });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async listDeep(prefix: string) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.c();
    const out: { key: string; bytes: number }[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) out.push({ key: o.Key!, bytes: o.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async copy(from: string, to: string) {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.c()).send(new CopyObjectCommand({ Bucket: config.s3.bucket, CopySource: `${config.s3.bucket}/${encodeURIComponent(from)}`, Key: to }));
  }
  localPath() { return null; }
  async signedUrl(key: string, minutes = config.objectUrlMinutes) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(await this.c(), new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn: minutes * 60 });
  }
}

export const storage: Storage = config.storageDriver === 's3' ? new S3Storage() : new FsStorage();

const shotVariant = (presentation: 'push' | 'overlay', frame: string | null) => `${presentation === 'overlay' ? '.overlay' : ''}${frame ? `.${frame}` : ''}`;

export const objectKeys = {
  revisionHtml: (projectId: string, screenId: string, revisionId: string) => `projects/${projectId}/screens/${screenId}/${revisionId}.html`,
  // 叠层与整屏拍出来的图不同，键带上呈现方式（§16 v1.03）：切换后重拍的图换了地址，浏览器不会拿内存里的旧图顶替。
  // 草稿按画框拍（REQ-CORE-040），键再带上画框；普通屏的 frame 恒为 null，键与之前相同。v1.27 起存无损 WebP（ADR-037），之前是 .png
  revisionShot: (projectId: string, screenId: string, revisionId: string, presentation: 'push' | 'overlay' = 'push', frame: string | null = null) => `projects/${projectId}/screens/${screenId}/${revisionId}${shotVariant(presentation, frame)}.webp`,
  revisionThumb: (projectId: string, screenId: string, revisionId: string, presentation: 'push' | 'overlay' = 'push', frame: string | null = null) => `projects/${projectId}/screens/${screenId}/${revisionId}${shotVariant(presentation, frame)}.thumb.webp`,
  exportHtml: (projectId: string, jobId: string) => `projects/${projectId}/exports/${jobId}.html`,
};

// 本机使用记录（REQ-CORE-047 / ADR-035）：模型调用正文与归档都在 records/ 下，storage.gc 不扫这里。
// 日期按本机时区的自然日（YYYY-MM-DD）；归档项 = 一份屏或项目的清单，或一张移进来的参考图
const pad = (n: number) => String(n).padStart(2, '0');
export const recordDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const recordKeys = {
  root: 'records',
  modelCall: (at: Date, id: string) => `records/model-calls/${recordDay(at)}/${id}.json`,
  /** name 是 screen-<id> 或 project-<id> */
  archive: (at: Date, name: string) => `records/archive/${recordDay(at)}/${name}`,
  archivedAttachment: (at: Date, key: string) => `records/archive/${recordDay(at)}/attachments/${key.split('/').pop()}`,
  isArchiveEntry: (key: string) => /^records\/archive\/[^/]+\/(?:(?:screen|project)-[^/]+\/manifest\.json|attachments\/[^/]+)$/.test(key),
};
