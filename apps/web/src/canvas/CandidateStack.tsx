import { useEffect, useState } from 'react';
import { Check, Layers, RotateCw, X } from 'lucide-react';
import type { CandidatesDto, ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { IconButton } from '@/ui/ui';
import { useT } from '@/i18n';
import canvasMessages from '@/i18n/locales/canvas-parts';
import commonMessages from '@/i18n/locales/common';

// 候选就地展开（REQ-CORE-015 v0.34）：画在世界层、盖在卡片原位——第 1 版留在卡片位置，其余版横向排成一行铺到右边，
// 每格与卡片同尺寸、随画布缩放，里面是该版的活 iframe（可滚动、悬停、填表；屏内链接不跳转——它们的消息 CanvasView 不认），
// 截图垫在 iframe 底下，就绪前先看到静态样子。动作收进每格上方右缘对齐的浮层胶囊（按 1/zoom 反向缩放保持屏幕尺寸）：
// 「第 k 版 · 当前」标签 + 图标按钮「就用这一版」/「采用这一组」/ 第 1 格的「收起」。
// 采用后由父组件刷新并收起；多屏作业的「采用这一组」把同批每屏的 current 都指到同一版。
const GAP = 24;

export function CandidateStack({ jobId, screen, onClose, onAdopted }: { jobId: string; screen: ScreenDto; onClose: () => void; onAdopted: () => Promise<void> | void }) {
  const t = useT(canvasMessages);
  const tc = useT(commonMessages);
  const toast = useToast();
  const [data, setData] = useState<CandidatesDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 取数失败就地给重试（v1.03），不停在「加载候选…」
  const load = () => { setLoadError(false); api.jobs.candidates(jobId).then(setData).catch(() => setLoadError(true)); };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobId]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); await onAdopted(); }
    catch (e) {
      if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast(t('candidates.conflict'), 'error');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast(t('candidates.busy'), 'error');
      else toast(t('candidates.failed'), 'error');
    } finally { setBusy(null); }
  };

  // 整组采用按屏独立成败（API-CORE-025 返回 200 {adopted, skipped}）：current 漂出该批或屏上有作业的屏被服务端跳过，
  // 所以报数只能按 adopted 来；一屏都没采用时不刷新也不收起，把展开层留给用户重试或逐屏采用。
  const adoptGroup = async (index: number) => {
    setBusy(`g${index}`);
    try {
      const { adopted, skipped } = await api.jobs.adoptGroup(jobId, index);
      if (!skipped.length) toast(t('candidates.groupAdopted', { count: adopted.length, version: index + 1 }));
      else if (adopted.length) toast(t('candidates.groupPartial', { count: adopted.length, skipped: skipped.length }), 'error');
      else toast(t('candidates.groupSkipped', { count: skipped.length }), 'error');
      if (adopted.length) await onAdopted();
    }
    catch { toast(t('candidates.failed'), 'error'); }
    finally { setBusy(null); }
  };

  const row = data?.screens.find((s) => s.screenId === screen.id);
  const versions = data?.versions ?? 1;
  const w = screen.width; const h = screen.height;
  const cellStyle = (i: number) => ({ width: w, height: h, left: i * (w + GAP), top: 0 });
  // 格子与卡片同一档圆角：桌面屏比手机屏小一档（styles.css 的 .card.desktop）
  const cellCls = w > 600 ? 'cand-cell desktop' : 'cand-cell';
  const collapse = <IconButton size="xs" label={t('candidates.collapse')} hint="Esc" data-testid="candidate-collapse" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>;

  return (
    <div data-testid="candidate-stack" data-screen={screen.id} role="group" aria-label={t('candidates.label', { name: screen.name })} style={{ position: 'absolute', left: 0, top: 0, width: versions * w + (versions - 1) * GAP, height: h }}>
      {!data || !row ? (
        <div className={cellCls} style={cellStyle(0)}>
          <div className="cand-actions chrome"><span className="cand-tag" role={loadError ? 'alert' : undefined}>{data ? t('candidates.none') : loadError ? t('candidates.loadFailed') : t('candidates.loading')}</span><span className="cand-btns">{loadError && <IconButton size="xs" label={tc('retry')} data-testid="candidate-retry" onClick={load}><RotateCw size={16} aria-hidden="true" /></IconButton>}{collapse}</span></div>
        </div>
      ) : Array.from({ length: versions }, (_, i) => {
        const r = row.revisions.find((x) => x.index === i);
        const isCurrent = !!r && r.id === row.currentRevisionId; const shot = r?.thumbUrl ?? r?.screenshotUrl;
        return (
          <div key={i} className={cellCls} data-testid="candidate-cell" data-current={isCurrent ? '' : undefined} style={cellStyle(i)}>
            {/* 截图垫底、活 iframe 盖上（与卡片同尺寸）；没产出时占位不跳版（VIS-006 / PERF-003） */}
            {/* 垫底图只在 iframe 就绪前露出，用缩略图就够（v1.03） */}
            {shot && <img src={shot} alt="" width={w} height={h} decoding="async" draggable={false} />}
            {r ? <iframe className="nowheel nopan" src={r.previewUrl} title={t('candidates.frameTitle', { name: screen.name, n: i + 1 })} sandbox="allow-scripts allow-same-origin allow-forms" /> : <div className="grid size-full place-items-center type-body text-neutral-600">{t('candidates.noOutput')}</div>}
            <div className="cand-actions chrome">
              <span className="cand-tag">{t('candidates.version', { n: i + 1 })}{isCurrent && <> · {row.settled ? t('candidates.adopted') : t('candidates.current')}</>}</span>
              {/* 图标成组：胶囊放不下时整组折到第二行，不会把最后一个图标单独甩下去 */}
              <span className="cand-btns">
              {r && !row.settled && <IconButton size="xs" tone={isCurrent ? 'default' : 'invert'} label={isCurrent ? t('candidates.adoptCurrent') : t('candidates.adopt')} desc={isCurrent ? t('candidates.adoptCurrentDesc') : undefined} data-testid={`adopt-one-${i}`} unavailable={busy ? t('candidates.pending') : false} onClick={() => run(r.id, () => api.screens.adopt(screen.id, r.id), t('candidates.adoptedOne', { n: i + 1 }))}><Check size={16} aria-hidden="true" /></IconButton>}
              {data.screens.length > 1 && !row.settled && <IconButton size="xs" label={t('candidates.adoptGroup', { n: data.screens.length })} desc={t('candidates.adoptGroupDesc', { n: data.screens.length, version: i + 1 })} data-testid={`adopt-group-${i}`} unavailable={busy ? t('candidates.pending') : false} onClick={() => adoptGroup(i)}><Layers size={16} aria-hidden="true" /></IconButton>}
              {i === 0 && collapse}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
