import { and, asc, eq, sql } from 'drizzle-orm';
import { ASSET_MEDIA_TYPES, MAX_ASSET_BYTES, MAX_ASSETS_PER_PROJECT, type AssetDto } from '@quilt/core';
import { db, schema } from '../db/client.ts';
import { problems } from '../lib/errors.ts';
import { storage } from '../lib/storage.ts';
import { config } from '../config.ts';
import { ownedProject } from './projects.ts';

// 项目素材（REQ-CORE-019 / API-CORE-032）：正文进对象存储，行里只记元数据。
// URL 现拼不入库——预览域换了端口（本地版每次启动都可能换）时，存量素材不该跟着失效。
const EXT: Record<string, string> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// 素材校验按 422 回（API-CORE-032）：multipart 本身是合法请求，被拒的是内容语义（格式 / 大小 / 数量），
// 与 /errors/lint-failed 同档。problems.validation 是全局 400，借它会把所有端点一起改掉。
const invalid = (path: string, message: string) => problems.unprocessable([{ path, message }]);

export const assetKey = (projectId: string, id: string, mediaType: string) =>
  `projects/${projectId}/assets/${id}.${EXT[mediaType] ?? 'bin'}`;

export const assetUrl = (projectId: string, id: string) => `${config.previewOrigin}/a/${projectId}/${id}`;

export const assetDto = (a: typeof schema.assets.$inferSelect): AssetDto => ({
  id: a.id, name: a.name, mediaType: a.mediaType, bytes: a.bytes, width: a.width, height: a.height,
  url: assetUrl(a.projectId, a.id), createdAt: a.createdAt.toISOString(),
});

/** 不查归属的取法：调用方已经拿着这个项目（项目详情、生成 prompt 都属于这种） */
export async function assetsOf(projectId: string): Promise<AssetDto[]> {
  const rows = await db.select().from(schema.assets).where(eq(schema.assets.projectId, projectId)).orderBy(asc(schema.assets.createdAt));
  return rows.map(assetDto);
}

export async function listAssets(ownerId: string, projectId: string): Promise<AssetDto[]> {
  const project = await ownedProject(ownerId, projectId);
  return assetsOf(project.id);
}

export async function createAsset(ownerId: string, projectId: string, input: { name: string; body: Buffer }): Promise<AssetDto> {
  const project = await ownedProject(ownerId, projectId);
  if (!input.body.byteLength) throw invalid('file', '空文件');
  if (input.body.byteLength > MAX_ASSET_BYTES) throw invalid('file', `单个素材最大 ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  const mediaType = sniff(input.body);
  if (!mediaType) throw invalid('mediaType', `只支持 ${ASSET_MEDIA_TYPES.join(' / ')}`);

  const size = measure(input.body, mediaType);
  const row = await db.transaction(async (tx) => {
    // 数量上限（≤ 50）必须在锁里数：并发上传时两次 await 之间谁也看不见别人的行，60 个并发就落 60 条
    await tx.execute(sql`select 1 from ${schema.projects} where ${schema.projects.id} = ${project.id} for update`);
    const existing = await tx.$count(schema.assets, eq(schema.assets.projectId, project.id));
    if (existing >= MAX_ASSETS_PER_PROJECT) throw invalid('assets', `每个项目最多 ${MAX_ASSETS_PER_PROJECT} 个素材，先删掉些`);
    const [inserted] = await tx.insert(schema.assets).values({
      projectId: project.id,
      name: input.name.trim().slice(0, 80) || '素材',
      mediaType,
      bytes: input.body.byteLength,
      width: size.w, height: size.h,
    }).returning();
    return inserted;
  });
  await storage.put(assetKey(project.id, row.id, row.mediaType), input.body, row.mediaType);
  return assetDto(row);
}

export async function deleteAsset(ownerId: string, assetId: string): Promise<void> {
  const [row] = await db.select({ a: schema.assets, ownerId: schema.projects.ownerId }).from(schema.assets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.assets.projectId))
    .where(eq(schema.assets.id, assetId));
  if (!row || row.ownerId !== ownerId) throw problems.notFound();
  await db.delete(schema.assets).where(eq(schema.assets.id, assetId));
  await storage.delete(assetKey(row.a.projectId, row.a.id, row.a.mediaType)).catch(() => {});
}

/** 预览域按 id 取素材（ADR-017）：不签名，靠 UUID 不可猜；项目不符即 404 */
export async function readAsset(projectId: string, assetId: string): Promise<{ mediaType: string; body: Buffer } | null> {
  const [row] = await db.select().from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), eq(schema.assets.projectId, projectId)));
  if (!row) return null;
  const body = await storage.get(assetKey(projectId, row.id, row.mediaType)).catch(() => null);
  return body ? { mediaType: row.mediaType, body } : null;
}

/** 生成 prompt 用的素材清单（REQ-CORE-019） */
export async function assetsForPrompt(projectId: string): Promise<{ name: string; url: string; width: number; height: number }[]> {
  return (await assetsOf(projectId)).map((a) => ({ name: a.name, url: a.url, width: a.width, height: a.height }));
}

// 格式按正文认，不信客户端给的 Content-Type（浏览器是按扩展名给的）：改过名的文件会让度量按错格式读、
// 也会让预览域用错的 Content-Type 回，那张图在屏里永远渲染不出来
function sniff(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // 只认「XML 声明 / DOCTYPE / 注释 / 空白之后就是 <svg」的文件：否则任何内嵌一段 SVG 的 html、txt
  // 都会以 image/svg+xml 入库，预览域按 SVG 下发，面板与屏里都是裂图
  if (/^(?:\s|<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)*<svg[\s>]/i.test(buf.toString('utf8', 0, 4096))) return 'image/svg+xml';
  return null;
}

// width / height 是 int4：截断的位图、viewBox="0 0 1.2.3 60" 这类文件会读出越界数或 NaN，直接插进去是
// PG 报错 → 500。尺寸只给面板显示与 prompt 提示用，宁可记 0 也不让上传失败。
const MAX_DIM = 100_000;
const dim = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_DIM) : 0);

// 像素尺寸只用于面板显示与 prompt 提示，读不出就记 0——为它引一个图片库不划算
function measure(buf: Buffer, mediaType: string): { w: number; h: number } {
  try {
    const raw = mediaType === 'image/svg+xml' ? measureSvg(buf.toString('utf8').slice(0, 4096))
      : mediaType === 'image/png' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
      : mediaType === 'image/jpeg' ? measureJpeg(buf)
      : measureWebp(buf);
    return { w: dim(raw.w), h: dim(raw.h) };
  } catch { /* 读不出就按 0 记 */ }
  return { w: 0, h: 0 };
}

function measureSvg(head: string): { w: number; h: number } {
  const vb = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { w: Math.round(Number(vb[1])), h: Math.round(Number(vb[2])) };
  const w = head.match(/\swidth\s*=\s*["']([\d.]+)/i); const h = head.match(/\sheight\s*=\s*["']([\d.]+)/i);
  return w && h ? { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) } : { w: 0, h: 0 };
}

function measureJpeg(buf: Buffer): { w: number; h: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0–SOF3 / SOF5–SOF7 / SOF9–SOF11 / SOF13–SOF15 都带尺寸；DHT(c4) DAC(cc) RST 不带
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

function measureWebp(buf: Buffer): { w: number; h: number } {
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (fmt === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return { w: 0, h: 0 };
}
