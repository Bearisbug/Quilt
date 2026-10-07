import { useEffect, useState } from 'react';

// 素材瓦片的底色（REQ-CORE-019）：品牌包里白色版与深墨版是同一个标志的两份文件，
// 固定一种底色必然有一半看不见。这里把图画进 16×16 离屏画布，取不透明像素的平均亮度：
// 亮的标志衬深底、深的标志衬浅底（底色优先取项目色板，见 toneColor）；跨域读像素失败时回落到透明棋盘格（.asset-thumb）。
export type AssetTone = 'light' | 'dark' | null;

const cache = new Map<string, AssetTone>();

export function useAssetTone(url: string): AssetTone {
  const [tone, setTone] = useState<AssetTone>(() => cache.get(url) ?? null);
  useEffect(() => {
    if (cache.has(url)) { setTone(cache.get(url)!); return; }
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let result: AssetTone = null;
      try {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, 16, 16);
          const { data } = ctx.getImageData(0, 0, 16, 16);
          let sum = 0; let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 24) continue; // 透明像素不算
            sum += brightness(data[i], data[i + 1], data[i + 2]);
            n += 1;
          }
          if (n) result = sum / n > 0.62 ? 'light' : 'dark';
        }
      } catch { result = null; } // 画布被跨域污染
      cache.set(url, result);
      if (alive) setTone(result);
    };
    img.onerror = () => { cache.set(url, null); if (alive) setTone(null); };
    img.src = url;
    return () => { alive = false; };
  }, [url]);
  return tone;
}

/** 亮标志衬深底、暗标志衬浅底，读不出就棋盘格 */
export const toneClass = (tone: AssetTone) => (tone === 'light' ? 'asset-on-dark' : tone === 'dark' ? 'asset-on-light' : 'asset-thumb');

// 判图与判底色用同一个亮度：sRGB 通道直接加权，不做线性化
function brightness(r: number, g: number, b: number) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

function hexBrightness(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? brightness(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)) : Number.NaN;
}

/**
 * 瓦片底色取项目色板（v0.98）：暗标志衬 background、亮标志衬 primary——品牌的浅底与深底本来就是这两个色，
 * 衬中性灰 / 近黑看不出标志在自家页面上的样子。该色与标志拉不开亮度时返回 undefined，交给 toneClass 的中性底。
 */
export function toneColor(tone: AssetTone, colors: { background: string; primary: string }): string | undefined {
  if (tone === 'dark') return hexBrightness(colors.background) >= 0.85 ? colors.background : undefined;
  if (tone === 'light') return hexBrightness(colors.primary) <= 0.3 ? colors.primary : undefined;
  return undefined;
}
