import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { imageHead, shotKeyVariant, keepsScreenshot, prunePlan, canReuseShot, slots, SHOT_KEEP_MS } from '../../../apps/api/src/lib/shots.ts';

// 截图存储瘦身（v1.27 ADR-037）的纯逻辑：WebP 头与无损块判定、screenshot.prune 的入选与处置、回到旧版沿用截图的三个条件；
// 再用 sharp 真编一张，确认存下去的是无损 WebP、逐像素不变。screenshot.ts 加载时读 config，先把 QUILT_DATA_DIR 指到临时目录
let dataDir: string;
let shots: typeof import('../../../apps/api/src/lib/screenshot.ts');
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'quilt-shots-'));
  process.env.QUILT_DATA_DIR = dataDir;
  shots = await import('../../../apps/api/src/lib/screenshot.ts');
});
after(() => rm(dataDir, { recursive: true, force: true }));

const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const head = Buffer.alloc(8); head.write('RIFF'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const chunk = (tag: string, data: Buffer) => {
  const h = Buffer.alloc(8); h.write(tag); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const vp8l = (w: number, h: number) => { const d = Buffer.alloc(5); d[0] = 0x2f; d.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1); return chunk('VP8L', d); };
const vp8 = (w: number, h: number) => { const d = Buffer.alloc(10); d.set([0x9d, 0x01, 0x2a], 3); d.writeUInt16LE(w, 6); d.writeUInt16LE(h, 8); return chunk('VP8 ', d); };
const vp8x = (w: number, h: number) => { const d = Buffer.alloc(10); d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3); return chunk('VP8X', d); };

test('imageHead：简单格式的 VP8L 是无损、VP8 是有损，宽高从图像块读', () => {
  assert.deepEqual(imageHead(riff(vp8l(780, 1688))), { format: 'webp', width: 780, height: 1688, lossless: true });
  assert.deepEqual(imageHead(riff(vp8(640, 400))), { format: 'webp', width: 640, height: 400, lossless: false });
});

test('imageHead：扩展格式按 VP8X 的画布尺寸，跳过 ICCP / ALPH 找到图像块', () => {
  assert.deepEqual(imageHead(riff(vp8x(2560, 1600), chunk('ICCP', Buffer.alloc(7)), vp8l(2560, 1600))), { format: 'webp', width: 2560, height: 1600, lossless: true });
  assert.deepEqual(imageHead(riff(vp8x(390, 844), chunk('ALPH', Buffer.alloc(3)), vp8(390, 844))), { format: 'webp', width: 390, height: 844, lossless: false });
});

test('imageHead：PNG 读 IHDR；别的格式、截断的文件返回 null', () => {
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(780, 16); png.writeUInt32BE(1688, 20);
  assert.deepEqual(imageHead(png), { format: 'png', width: 780, height: 1688, lossless: true });
  assert.equal(imageHead(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null);
  assert.equal(imageHead(riff(vp8l(10, 10)).subarray(0, 22)), null);
  assert.equal(imageHead(riff(chunk('VP8L', Buffer.from([0x00, 1, 2, 3, 4])))), null, 'VP8L 块的签名字节不是 0x2f');
});

test('shotKeyVariant：截图键里的呈现方式、画框与格式；缩略图键不算截图键', () => {
  const base = 'projects/p/screens/s/0b6c1f7e-1111-4222-8333-444455556666';
  assert.deepEqual(shotKeyVariant(`${base}.webp`), { overlay: false, frame: null, format: 'webp' });
  assert.deepEqual(shotKeyVariant(`${base}.overlay.webp`), { overlay: true, frame: null, format: 'webp' });
  assert.deepEqual(shotKeyVariant(`${base}.desktop.png`), { overlay: false, frame: 'desktop', format: 'png' });
  assert.equal(shotKeyVariant(`${base}.thumb.webp`), null);
  assert.equal(shotKeyVariant(`${base}.html`), null);
});

test('screenshot.prune 的入选：当前版、待采用候选、24 小时内建的留着，其余清', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const old = new Date(now - SHOT_KEEP_MS - 60_000); const fresh = new Date(now - SHOT_KEEP_MS + 60_000);
  const rev = (o: Partial<Parameters<typeof keepsScreenshot>[0]>) => ({ isCurrent: false, candidateIndex: null, candidateSettledAt: null, createdAt: old, ...o });
  assert.equal(keepsScreenshot(rev({}), now), false, '超过 24 小时的旧版');
  assert.equal(keepsScreenshot(rev({ isCurrent: true }), now), true, '当前版不管多老都留');
  assert.equal(keepsScreenshot(rev({ candidateIndex: 1 }), now), true, '没结清的候选留着');
  assert.equal(keepsScreenshot(rev({ candidateIndex: 1, candidateSettledAt: old }), now), false, '已结清、没被采用的候选清');
  assert.equal(keepsScreenshot(rev({ createdAt: fresh }), now), true, '24 小时内建的留着');
});

test('screenshot.prune 的处置：共用的键还被要保留截图的修订引用时只置空、不删对象', () => {
  const plan = prunePlan([
    { id: 'v2', key: 'k2', keep: false, hasThumb: true },
    { id: 'v7', key: 'k2', keep: true, hasThumb: true },
    { id: 'v1', key: 'k1', keep: false, hasThumb: true },
  ]);
  assert.deepEqual(plan.clear.sort(), ['v1', 'v2']);
  assert.deepEqual(plan.deleteKeys, ['k1']);
});

test('screenshot.prune 的处置：引用一个键的修订都清掉时才删对象；还没有缩略图的不清，它的键也不删', () => {
  assert.deepEqual(prunePlan([{ id: 'a', key: 'k', keep: false, hasThumb: true }, { id: 'b', key: 'k', keep: false, hasThumb: true }]), { clear: ['a', 'b'], deleteKeys: ['k'] });
  assert.deepEqual(prunePlan([{ id: 'a', key: 'k', keep: false, hasThumb: true }, { id: 'b', key: 'k', keep: false, hasThumb: false }]), { clear: ['a'], deleteKeys: [] });
});

test('回到旧版沿用截图：源截图还在、呈现方式一致、尺寸是现在应拍的，三条都成立才沿用', () => {
  const key = 'projects/p/screens/s/r.webp';
  const mobile = { w: 390, h: 844, rootOnly: false };
  const head = { format: 'webp' as const, width: 780, height: 1688, lossless: true };
  assert.equal(canReuseShot({ key, head }, 'push', mobile), true);
  assert.equal(canReuseShot(null, 'push', mobile), false, '源截图已被清掉');
  assert.equal(canReuseShot({ key, head: null }, 'push', mobile), false, '键还在、对象读不到');
  assert.equal(canReuseShot({ key, head }, 'overlay', mobile), false, '这一屏现在是叠层，源截图是整屏拍的');
  assert.equal(canReuseShot({ key: 'projects/p/screens/s/r.overlay.webp', head }, 'overlay', mobile), true);
  assert.equal(canReuseShot({ key, head }, 'push', { w: 1280, h: 800, rootOnly: false }), false, '尺寸与现在的设备或画框不符');
  assert.equal(canReuseShot({ key: 'projects/p/screens/s/r.component.webp', head: { ...head, width: 333, height: 120 } }, 'push', { w: 1280, h: 800, rootOnly: true }), true, '组件画框不限尺寸');
});

test('编码限并发：同时最多 2 件，按排队顺序交接；调用方放弃了也要等那件了结才让出名额', async () => {
  const slot = slots(2);
  const started: number[] = [];
  const finish: (() => void)[] = [];
  const fail: (() => void)[] = [];
  const job = (i: number) => slot(() => { started.push(i); return new Promise<number>((res, rej) => { finish[i] = () => res(i); fail[i] = () => rej(new Error(`第 ${i} 件失败`)); }); });
  const tick = () => new Promise((r) => setImmediate(r));
  const queued = [0, 1, 2, 3, 4].map(job);
  await tick();
  assert.deepEqual(started, [0, 1], '前两件开始，其余排队');
  const first = await queued[0];
  // 调用方不再等第 0 件（超时放弃），它还没了结，名额不让出
  await tick();
  assert.deepEqual(started, [0, 1]);
  finish[0](); await first.work; await tick();
  assert.deepEqual(started, [0, 1, 2], '第 0 件了结后第 2 件接上');
  const second = await queued[1];
  fail[1](); await assert.rejects(second.work); await tick();
  assert.deepEqual(started, [0, 1, 2, 3], '失败的那件同样让出名额');
  finish[2](); finish[3](); await tick(); await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  finish[4]();
  assert.equal(await (await queued[4]).work, 4);
});

test('losslessWebp：存下去的是 VP8L 无损 WebP，逐像素与 PNG 相同（含透明像素的颜色）', async () => {
  const w = 37; const h = 23;
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) raw.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, i % 5 === 0 ? 0 : (i * 3) & 255], i * 4);
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const webp = await shots.losslessWebp(png);
  assert.deepEqual(imageHead(webp), { format: 'webp', width: w, height: h, lossless: true });
  const decode = (b: Buffer) => sharp(b).ensureAlpha().raw().toBuffer();
  assert.ok((await decode(webp)).equals(await decode(png)), 'WebP 解出来的像素与 PNG 不同');
});
