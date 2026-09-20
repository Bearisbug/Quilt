import { useEffect, useState } from 'react';

// 素材瓦片的底色（REQ-CORE-019）：品牌包里白色版与深墨版是同一个标志的两份文件，
// 固定一种底色必然有一半看不见。这里把图画进 16×16 离屏画布，取不透明像素的平均亮度：
// 亮的标志衬深底、深的标志衬浅底；跨域读像素失败时回落到透明棋盘格（.asset-thumb）。
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
            sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
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
