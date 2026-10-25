// 整屏截图存储的纯逻辑（v1.27 ADR-037）：图片头、截图键里的呈现方式、哪些修订要留整屏截图、screenshot.prune 的处置、
// 回到旧版时那一版的截图能不能直接用。不碰库与对象存储，单测直接引

/** 截图按 2 倍设备像素拍（screenshotHtml 的 deviceScaleFactor） */
export const SHOT_SCALE = 2;
/** 建出来这么久之内的修订留着整屏截图，超过且不是当前版、不是待采用候选的由 screenshot.prune 清掉 */
export const SHOT_KEEP_MS = 24 * 3600_000;

export type ImageHead = { format: 'png' | 'webp'; width: number; height: number; lossless: boolean };

/** 读 PNG / WebP 的头：格式、像素尺寸、是不是无损（WebP 看图像块是 VP8L 还是 VP8）；别的格式或读不出返回 null */
export function imageHead(buf: Buffer): ImageHead | null {
  if (buf.length >= 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a' && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), lossless: true };
  }
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  // 逐块走：简单格式第一块就是 VP8L / VP8；扩展格式先是 VP8X（画布尺寸），图像块排在 ICCP / ALPH 之后
  let width = 0; let height = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const tag = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const data = at + 8;
    if (tag === 'VP8X' && data + 10 <= buf.length) {
      width = 1 + buf.readUIntLE(data + 4, 3); height = 1 + buf.readUIntLE(data + 7, 3);
    } else if (tag === 'VP8L' && data + 5 <= buf.length && buf[data] === 0x2f) {
      const bits = buf.readUInt32LE(data + 1);
      return { format: 'webp', width: width || (bits & 0x3fff) + 1, height: height || ((bits >>> 14) & 0x3fff) + 1, lossless: true };
    } else if (tag === 'VP8 ' && data + 10 <= buf.length) {
      return { format: 'webp', width: width || buf.readUInt16LE(data + 6) & 0x3fff, height: height || buf.readUInt16LE(data + 8) & 0x3fff, lossless: false };
    }
    at = data + size + (size & 1);
  }
  return null;
}

/** 截图键里的呈现方式与画框（§16 v1.03、REQ-CORE-040）：<修订 id>[.overlay][.<画框>].webp，v1.27 前是 .png */
export function shotKeyVariant(key: string): { overlay: boolean; frame: 'component' | 'mobile' | 'desktop' | null; format: 'png' | 'webp' } | null {
  const m = /(\.overlay)?(?:\.(component|mobile|desktop))?\.(png|webp)$/.exec(key);
  if (!m || key.endsWith('.thumb.webp')) return null;
  return { overlay: !!m[1], frame: (m[2] as 'component' | 'mobile' | 'desktop' | undefined) ?? null, format: m[3] as 'png' | 'webp' };
}

export const shotMediaType = (key: string): string => (key.endsWith('.png') ? 'image/png' : 'image/webp');

/** 要留整屏截图的修订：当前版、待采用候选（有版号、还没结清）、建出来 24 小时内的 */
export function keepsScreenshot(r: { isCurrent: boolean; candidateIndex: number | null; candidateSettledAt: Date | null; createdAt: Date }, now: number): boolean {
  return r.isCurrent || (r.candidateIndex !== null && r.candidateSettledAt === null) || r.createdAt.getTime() > now - SHOT_KEEP_MS;
}

/**
 * screenshot.prune 的处置：refs 是这一轮要清的键被哪些修订引用（全部引用，不只这一轮挑中的）。
 * 不用留截图、已有缩略图的置空；一个键只有在引用它的修订全被置空时才删对象——v1.43 之前回到旧版建的修订共用源修订的键，
 * 还被要保留截图的修订引用时只置空、不删
 */
export type ShotRef = { id: string; key: string; keep: boolean; hasThumb: boolean };
export function prunePlan(refs: ShotRef[]): { clear: string[]; deleteKeys: string[] } {
  const clear = new Set(refs.filter((r) => !r.keep && r.hasThumb).map((r) => r.id));
  const keys = [...new Set(refs.map((r) => r.key))];
  return { clear: [...clear], deleteKeys: keys.filter((k) => refs.every((r) => r.key !== k || clear.has(r.id))) };
}

/**
 * 回到旧版时那一版的截图能直接用（API-CORE-015）要三条都成立：截图还在（head 读得出）、键里的呈现方式与这一屏现在的一致、
 * 像素尺寸是这一屏现在的设备或画框应拍的尺寸（组件画框按根元素的框拍，不限尺寸）
 */
export function canReuseShot(source: { key: string; head: ImageHead | null } | null, presentation: string, expected: { w: number; h: number; rootOnly: boolean }): boolean {
  if (!source?.head) return false;
  const v = shotKeyVariant(source.key);
  if (!v || v.overlay !== (presentation === 'overlay')) return false;
  return expected.rootOnly || (source.head.width === expected.w * SHOT_SCALE && source.head.height === expected.h * SHOT_SCALE);
}

/**
 * 同时最多 n 件在跑：排到名额才调 start，返回已经开始的那件（不等它跑完，调用方自己给它计时）；
 * 它了结才让出名额，调用方先因超时放弃了也照样占着——sharp 编码取消不了，重试不能和还没编完的那张叠在一起占线程。名额按排队顺序交接
 */
export function slots(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
  return async <T>(start: () => Promise<T>): Promise<{ work: Promise<T> }> => {
    if (running < n) running++;
    else await new Promise<void>((r) => waiting.push(r));
    const work = Promise.resolve().then(start);
    work.then(release, release);
    return { work };
  };
}
