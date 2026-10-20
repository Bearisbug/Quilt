import { useEffect, useRef, useState } from 'react';
import { parseConventions, type DesignSystemDto, type Tokens, type DesignProposalDto } from '@quilt/core/browser';
import { Button } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { RADIUS, SWATCH_EDGE } from './designOptions';

// 设计系统提案预览（REQ-EDIT-003）：提炼出来的绝对规则逐条可取消、token 变更前后对比；「确认写入」即落库，
// 写成之后才按提案的 regenerate 问要不要按新约定重生成所有屏（只改 token 就直接回刷）。
// 第二步已经写入：Esc / 点遮罩 = 不重生成（照样收尾回刷 token），初始焦点落「不重生成」——另一个按钮按屏计费
export function ProposalDialog({ proposal, ds, busyReason, screenCount, batches, onWrite, onFinish, onClose }: {
  proposal: DesignProposalDto; ds: DesignSystemDto; busyReason: string | false;
  /** 重生成要发几屏、拆成几个作业（每个作业至多 20 屏） */
  screenCount: number; batches: number;
  /** 写入设计系统；返回是否写成，写不成弹层留着 */
  onWrite: (choice: { conventions: string[]; tokens: DesignProposalDto['tokens'] }) => Promise<boolean>;
  /** 写入之后的收尾并关闭弹层：重生成全部屏，或只改了 token 时确定性回刷 */
  onFinish: (regenerate: boolean, tokensChanged: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const tokens = ds.tokens as Tokens;
  const existing = parseConventions(ds.designMd);
  const [keep, setKeep] = useState<boolean[]>(() => proposal.conventions.map(() => true));
  const [step, setStep] = useState<'preview' | 'regenerate'>('preview');
  const [pending, setPending] = useState<'write' | 'skip' | 'regenerate' | null>(null);
  const chosen = proposal.conventions.filter((_, i) => keep[i]);
  const t = proposal.tokens ?? {};
  const tokenRows: { label: string; from: string; to: string }[] = [];
  if (t.seedColor) tokenRows.push({ label: '种子色', from: ds.seedColor, to: t.seedColor });
  if (t.fontFamily) tokenRows.push({ label: '字体', from: tokens.typography.fontFamily, to: t.fontFamily });
  if (t.radiusScale) tokenRows.push({ label: '圆角', from: RADIUS.find((r) => r.md === tokens.radius.md)?.label ?? '默认', to: RADIUS.find((r) => r.key === t.radiusScale)?.label ?? t.radiusScale });
  const conventionsChanged = JSON.stringify(chosen) !== JSON.stringify(existing);
  const tokensChanged = tokenRows.length > 0;
  const nothing = !conventionsChanged && !tokensChanged;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  // 收尾只做一次：「重生成」在途时再按 Esc / 点遮罩不能再发一遍
  const finishing = useRef(false);
  const finish = async (regenerate: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    setPending(regenerate ? 'regenerate' : 'skip');
    try { await onFinish(regenerate, tokensChanged); } finally { setPending(null); }
  };
  const confirm = async () => {
    setPending('write');
    const ok = await onWrite({ conventions: chosen, tokens: tokensChanged ? t : undefined });
    setPending(null);
    // 写入期间按钮是原生 disabled、焦点已掉到 body：写不成就还给它（A11Y-013），等它重新可用的那一帧
    if (!ok) { requestAnimationFrame(() => confirmRef.current?.focus()); return; }
    // 改了约定才有「重生成」这一问；只改 token 走确定性回刷
    if (proposal.regenerate && conventionsChanged && screenCount > 0) setStep('regenerate'); else await finish(false);
  };
  useEffect(() => { if (step === 'regenerate') skipRef.current?.focus(); }, [step]);
  const dismiss = step === 'regenerate' ? () => { void finish(false); } : onClose;
  const ref = useModal<HTMLDivElement>(dismiss, undefined, undefined, { initialFocus: 'self' });
  return (
    <Overlay onClose={dismiss}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dsp-title" data-testid="ds-proposal" tabIndex={-1} className="sheet flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden fade-up outline-none">
        <header className="shrink-0 border-b border-border-subtle px-4 py-3">
          <h2 id="dsp-title" className="type-heading3 font-semibold">{step === 'preview' ? '写入设计系统？' : '按新约定重生成所有屏？'}</h2>
          {proposal.summary && step === 'preview' && <p className="mt-1 type-label text-text-secondary">{proposal.summary}</p>}
        </header>
        {step === 'preview' ? (
          <div className="scroll min-h-0 flex-1 space-y-4 p-4">
            <div>
              <div className="mb-1.5 type-label font-semibold text-text-secondary">约定（写入后的完整清单，取消勾选的不写）</div>
              {proposal.conventions.length === 0 ? <p className="type-label text-text-secondary">这条指令没有提炼出跨屏规则。</p> : (
                <ul className="flex flex-col gap-1">
                  {proposal.conventions.map((c, i) => {
                    const isNew = !existing.includes(c);
                    return (
                      <li key={i} className="flex items-start gap-2 type-label">
                        <input id={`dsp-c-${i}`} type="checkbox" checked={keep[i]} onChange={(e) => setKeep((k) => k.map((v, j) => (j === i ? e.target.checked : v)))} className="mt-0.5 size-3.5 accent-(--semantic-color-action-link)" />
                        <label htmlFor={`dsp-c-${i}`} className="min-w-0 flex-1 leading-(--semantic-typography-body-line-height) [overflow-wrap:anywhere]">{c}{isNew && <span className="tint-link ml-1 rounded-sm px-1.5 type-caption">新</span>}</label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {existing.filter((c) => !proposal.conventions.includes(c)).length > 0 && (
                <p className="mt-1.5 type-caption text-text-secondary">将移除：{existing.filter((c) => !proposal.conventions.includes(c)).join('；')}</p>
              )}
            </div>
            {tokenRows.length > 0 && (
              <div>
                <div className="mb-1.5 type-label font-semibold text-text-secondary">token 变更</div>
                <ul className="flex flex-col gap-1 type-label">
                  {tokenRows.map((r) => (
                    <li key={r.label} className="flex items-center gap-2">
                      <span className="w-12 text-text-secondary">{r.label}</span>
                      {r.label === '种子色' ? <><span className={`inline-block size-4 rounded-sm ${SWATCH_EDGE}`} style={{ background: r.from }} /><span>{r.from}</span><span className="text-text-secondary">→</span><span className={`inline-block size-4 rounded-sm ${SWATCH_EDGE}`} style={{ background: r.to }} /><span>{r.to}</span></> : <><span>{r.from}</span><span className="text-text-secondary">→</span><span>{r.to}</span></>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 type-label leading-(--semantic-typography-body-line-height) text-text-secondary">
            约定已写入。现有 {screenCount} 屏还是老样子——重生成会对每一屏跑一次模型（按屏计费{batches > 1 ? `，分 ${batches} 个作业发出` : ''}），不重生成则只对以后新造的屏生效。
            {/* 重生成要改全部屏，与在跑作业冲突：就地写原因（PAGE-CANVAS「作业进行中时的面板」） */}
            {busyReason && <p className="mt-2 text-warning" data-testid="ds-proposal-blocked">{busyReason}，等它结束再重生成</p>}
          </div>
        )}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-4 py-3">
          {step === 'preview' ? (
            <>
              <Button key="cancel" size="sm" onClick={onClose}>取消</Button>
              <Button key="confirm" ref={confirmRef} size="sm" variant="primary" data-testid="ds-proposal-confirm" pending={pending === 'write'} disabled={nothing} onClick={() => void confirm()}>确认写入</Button>
            </>
          ) : (
            <>
              <Button key="skip" ref={skipRef} size="sm" data-testid="ds-proposal-write-only" pending={pending === 'skip'} disabled={!!pending} onClick={() => void finish(false)}>不重生成</Button>
              <Button key="regenerate" size="sm" variant="primary" data-testid="ds-proposal-regenerate" pending={pending === 'regenerate'} disabled={!!busyReason || !!pending} onClick={() => void finish(true)}>重生成 {screenCount} 屏</Button>
            </>
          )}
        </footer>
      </div>
    </Overlay>
  );
}
