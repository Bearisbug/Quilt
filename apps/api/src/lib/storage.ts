import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
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
  async signedUrl(key: string, minutes = config.objectUrlMinutes) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(await this.c(), new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn: minutes * 60 });
  }
}

export const storage: Storage = config.storageDriver === 's3' ? new S3Storage() : new FsStorage();

export const objectKeys = {
  revisionHtml: (projectId: string, screenId: string, revisionId: string) => `projects/${projectId}/screens/${screenId}/${revisionId}.html`,
  revisionShot: (projectId: string, screenId: string, revisionId: string) => `projects/${projectId}/screens/${screenId}/${revisionId}.png`,
  exportHtml: (projectId: string, jobId: string) => `projects/${projectId}/exports/${jobId}.html`,
};
