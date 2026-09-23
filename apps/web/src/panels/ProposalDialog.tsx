import { useState } from 'react';
import { parseConventions, type DesignSystemDto, type Tokens, type DesignProposalDto } from '@quilt/core';
import { Button } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { RADIUS } from './designOptions';

// 设计系统提案预览（REQ-EDIT-003）：提炼出来的绝对规则逐条可取消、token 变更前后对比；确认才写入；
// 写入后按提案的 regenerate 问要不要按新约定重生成所有屏（只改 token 就直接回刷）。
export function ProposalDialog({ proposal, ds, busy, onConfirm, onClose }: {
  proposal: DesignProposalDto; ds: DesignSystemDto; busy: boolean;
  onConfirm: (choice: { conventions: string[]; tokens: DesignProposalDto['tokens']; regenerate: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useModal<HTMLDivElement>(onClose, undefined, undefined, { initialFocus: 'self' });
  const tokens = ds.tokens as Tokens;
  const existing = parseConventions(ds.designMd);
  const [keep, setKeep] = useState<boolean[]>(() => proposal.conventions.map(() => true));
  const [step, setStep] = useState<'preview' | 'regenerate'>('preview');
  const [pending, setPending] = useState(false);
  const chosen = proposal.conventions.filter((_, i) => keep[i]);
  const t = proposal.tokens ?? {};
  const tokenRows: { label: string; from: string; to: string }[] = [];
  if (t.seedColor) tokenRows.push({ label: '种子色', from: ds.seedColor, to: t.seedColor });
  if (t.fontFamily) tokenRows.push({ label: '字体', from: tokens.typography.fontFamily, to: t.fontFamily });
  if (t.radiusScale) tokenRows.push({ label: '圆角', from: RADIUS.find((r) => r.md === tokens.radius.md)?.label ?? '默认', to: RADIUS.find((r) => r.key === t.radiusScale)?.label ?? t.radiusScale });
  const conventionsChanged = JSON.stringify(chosen) !== JSON.stringify(existing);
  const nothing = !conventionsChanged && tokenRows.length === 0;
  const commit = async (regenerate: boolean) => {
    setPending(true);
    try { await onConfirm({ conventions: chosen, tokens: tokenRows.length ? t : undefined, regenerate }); } finally { setPending(false); }
  };
  const confirm = () => {
    // 改了约定才有「重生成」这一问；只改 token 走确定性回刷（onConfirm 里处理）
    if (proposal.regenerate && conventionsChanged) setStep('regenerate'); else commit(false);
  };
  return (
    <Overlay onClose={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dsp-title" data-testid="ds-proposal" tabIndex={-1} className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl fade-up outline-none">
        <header className="shrink-0 border-b border-line px-4 py-3">
          <h2 id="dsp-title" className="text-sm font-semibold">{step === 'preview' ? '写入设计系统？' : '按新约定重生成所有屏？'}</h2>
          {proposal.summary && step === 'preview' && <p className="mt-1 text-xs text-muted">{proposal.summary}</p>}
        </header>
        {step === 'preview' ? (
          <div className="scroll min-h-0 flex-1 space-y-4 p-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">约定（写入后的完整清单，取消勾选的不写）</div>
              {proposal.conventions.length === 0 ? <p className="text-xs text-muted">这条指令没有提炼出跨屏规则。</p> : (
                <ul className="flex flex-col gap-1">
                  {proposal.conventions.map((c, i) => {
                    const isNew = !existing.includes(c);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <input id={`dsp-c-${i}`} type="checkbox" checked={keep[i]} onChange={(e) => setKeep((k) => k.map((v, j) => (j === i ? e.target.checked : v)))} className="mt-0.5 size-3.5 accent-accent" />
                        <label htmlFor={`dsp-c-${i}`} className="min-w-0 flex-1 leading-cn [overflow-wrap:anywhere]">{c}{isNew && <span className="ml-1 rounded-full bg-accent/15 px-1.5 text-[10px] text-accent-strong">新</span>}</label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {existing.filter((c) => !proposal.conventions.includes(c)).length > 0 && (
                <p className="mt-1.5 text-[11px] text-muted">将移除：{existing.filter((c) => !proposal.conventions.includes(c)).join('；')}</p>
              )}
            </div>
            {tokenRows.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">token 变更</div>
                <ul className="flex flex-col gap-1 text-xs">
                  {tokenRows.map((r) => (
                    <li key={r.label} className="flex items-center gap-2">
                      <span className="w-12 text-muted">{r.label}</span>
                      {r.label === '种子色' ? <><span className="inline-block size-4 rounded-sm border border-line" style={{ background: r.from }} /><span>{r.from}</span><span className="text-muted">→</span><span className="inline-block size-4 rounded-sm border border-line" style={{ background: r.to }} /><span>{r.to}</span></> : <><span>{r.from}</span><span className="text-muted">→</span><span>{r.to}</span></>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-xs text-muted">约定已写入。现有屏还是老样子——重生成会对每一屏跑一次模型（按屏计费），不重生成则只对以后新造的屏生效。</div>
        )}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
          {step === 'preview' ? (
            <>
              <Button size="sm" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" data-testid="ds-proposal-confirm" pending={pending} disabled={nothing || busy} onClick={confirm}>确认写入</Button>
            </>
          ) : (
            <>
              <Button size="sm" data-testid="ds-proposal-write-only" pending={pending} onClick={() => commit(false)}>只写入</Button>
              <Button size="sm" variant="primary" data-testid="ds-proposal-regenerate" pending={pending} disabled={busy} onClick={() => commit(true)}>重生成所有屏</Button>
            </>
          )}
        </footer>
      </div>
    </Overlay>
  );
}
