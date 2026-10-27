import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import type { SurfaceDto } from '@quilt/core/browser';

// 当前端（REQ-CORE-049，PAGE-CANVAS「端」）：记在地址 ?surface= 与本机（每个项目一份），都没有或指向已删的端时取第一端。
// 画布与全屏视图共用：两个视图之间切换时地址带着它走
const storeKey = (projectId: string) => `quilt:surface:${projectId}`;
const remembered = (projectId: string) => { try { return localStorage.getItem(storeKey(projectId)); } catch { return null; } };

export function useSurface(projectId: string, surfaces: SurfaceDto[] | undefined) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('surface');
  const wanted = fromUrl ?? remembered(projectId);
  const surface = surfaces ? surfaces.find((s) => s.id === wanted) ?? surfaces[0] ?? null : null;
  // 换端时全屏视图正看的屏与取值属于上一端，一并换掉：screen 给了就打开那一屏（⌘K 选了别的端的屏、跟随到别的端）
  const setSurface = useCallback((id: string, screen?: string) => {
    try { localStorage.setItem(storeKey(projectId), id); } catch { /* 无痕模式写不了：只记在地址里 */ }
    setParams((q) => { q.set('surface', id); q.delete('state'); if (screen) q.set('screen', screen); else q.delete('screen'); return q; }, { replace: true });
  }, [projectId, setParams]);
  // 地址里的端已被删（自己删的、别处删的）：换成此刻生效的那一端，免得刷新后又落空
  useEffect(() => {
    if (surface && fromUrl && fromUrl !== surface.id) setParams((q) => { q.set('surface', surface.id); return q; }, { replace: true });
  }, [surface, fromUrl, setParams]);
  return { surface, setSurface };
}
