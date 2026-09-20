import { useEffect, useState } from 'react';
import { Check, Layers, X } from 'lucide-react';
import type { CandidatesDto, ScreenDto } from '@quilt/core';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/toast';
import { IconButton } from './ui';

// 候选就地展开（REQ-CORE-015 v0.34）：画在世界层、盖在卡片原位——第 1 版留在卡片位置，其余版横向排成一行铺到右边，
// 每格与卡片同尺寸、随画布缩放，里面是该版的活 iframe（可滚动、悬停、填表；屏内链接不跳转——它们的消息 CanvasView 不认），
// 截图垫在 iframe 底下，就绪前先看到静态样子。动作收进每格上方右缘对齐的浮层胶囊（按 1/zoom 反向缩放保持屏幕尺寸）：
// 「第 k 版 · 当前」标签 + 图标按钮「就用这一版」/「采用这一组」/ 第 1 格的「收起」。
// 采用后由父组件刷新并收起；多屏作业的「采用这一组」把同批每屏的 current 都指到同一版。
const GAP = 24;

export function CandidateStack({ jobId, screen, onClose, onAdopted }: { jobId: string; screen: ScreenDto; onClose: () => void; onAdopted: () => Promise<void> | void }) {
  const toast = useToast();
  const [data, setData] = useState<CandidatesDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { api.jobs.candidates(jobId).then(setData).catch(() => toast('候选加载失败', 'error')); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobId]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); await onAdopted(); }
    catch (e) {
      if (e instanceof ApiError && e.type === '/errors/revision-conflict') toast('这一屏已在某一版上继续改过，不能再整批采用', 'error');
      else if (e instanceof ApiError && e.type === '/errors/screen-busy') toast('该屏正在生成中，稍后再试', 'error');
      else toast('采用失败', 'error');
    } finally { setBusy(null); }
  };

  // 整组采用按屏独立成败（API-CORE-025 返回 200 {adopted, skipped}）：current 漂出该批或屏上有作业的屏被服务端跳过，
  // 所以报数只能按 adopted 来；一屏都没采用时不刷新也不收起，把展开层留给用户重试或逐屏采用。
  const adoptGroup = async (index: number) => {
    setBusy(`g${index}`);
    try {
      const { adopted, skipped } = await api.jobs.adoptGroup(jobId, index);
      if (!skipped.length) toast(`已为 ${adopted.length} 屏采用第 ${index + 1} 版`);
      else if (adopted.length) toast(`已采用 ${adopted.length} 屏，${skipped.length} 屏跳过（已在某一版上改过或正在生成）`, 'error');
      else toast(`${skipped.length} 屏都跳过了（已在某一版上改过或正在生成），稍后再试或逐屏采用`, 'error');
      if (adopted.length) await onAdopted();
    }
    catch { toast('采用失败', 'error'); }
    finally { setBusy(null); }
  };

  const row = data?.screens.find((s) => s.screenId === screen.id);
  const versions = data?.versions ?? 1;
  const w = screen.width; const h = screen.height;
  const cellStyle = (i: number) => ({ width: w, height: h, left: i * (w + GAP), top: 0 });
  const collapse = <IconButton size="xs" label="收起" hint="Esc" data-testid="candidate-collapse" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>;

  return (
    <div data-testid="candidate-stack" data-screen={screen.id} role="group" aria-label={`「${screen.name}」的候选`} style={{ position: 'absolute', left: 0, top: 0, width: versions * w + (versions - 1) * GAP, height: h }}>
      {!data || !row ? (
        <div className="cand-cell" style={cellStyle(0)}>
          <div className="cand-actions"><span className="cand-tag">{data ? '这个作业没有这一屏的候选' : '加载候选…'}</span><span className="cand-btns">{collapse}</span></div>
        </div>
      ) : Array.from({ length: versions }, (_, i) => {
        const r = row.revisions.find((x) => x.index === i);
        const isCurrent = !!r && r.id === row.currentRevisionId;
        return (
          <div key={i} className="cand-cell" data-testid="candidate-cell" data-current={isCurrent ? '' : undefined} style={cellStyle(i)}>
            {/* 截图垫底、活 iframe 盖上（与卡片同尺寸）；没产出时占位不跳版（VIS-006 / PERF-003） */}
            {r?.screenshotUrl && <img src={r.screenshotUrl} alt="" width={w} height={h} decoding="async" draggable={false} />}
            {r ? <iframe className="nowheel nopan" src={r.previewUrl} title={`${screen.name} 第 ${i + 1} 版`} sandbox="allow-scripts allow-same-origin allow-forms" /> : <div className="grid size-full place-items-center text-sm text-ink/60">这一版没有产出</div>}
            <div className="cand-actions">
              <span className="cand-tag">第 {i + 1} 版{isCurrent && <> · {row.settled ? '已采用' : '当前'}</>}</span>
              {/* 图标成组：胶囊放不下时整组折到第二行，不会把最后一个图标单独甩下去 */}
              <span className="cand-btns">
              {r && !row.settled && <IconButton size="xs" tone={isCurrent ? 'default' : 'invert'} label={isCurrent ? '就用这版（当前）' : '就用这一版'} desc={isCurrent ? '按当前这版结清这批候选' : undefined} data-testid={`adopt-one-${i}`} unavailable={busy ? '处理中…' : false} onClick={() => run(r.id, () => api.screens.adopt(screen.id, r.id), `已采用第 ${i + 1} 版`)}><Check size={16} aria-hidden="true" /></IconButton>}
              {data.screens.length > 1 && !row.settled && <IconButton size="xs" label={`采用这一组（${data.screens.length} 屏）`} desc={`同批 ${data.screens.length} 屏都用第 ${i + 1} 版`} data-testid={`adopt-group-${i}`} unavailable={busy ? '处理中…' : false} onClick={() => adoptGroup(i)}><Layers size={16} aria-hidden="true" /></IconButton>}
              {i === 0 && collapse}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
