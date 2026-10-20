import { useEffect, useRef, useState } from 'react';
import { parseConventions, type DesignSystemDto, type Tokens, type DesignProposalDto } from '@quilt/core/browser';
import { Button } from '@/ui/ui';
import { Overlay, useModal } from '@/ui/modal';
import { RADIUS, SWATCH_EDGE } from './designOptions';
import { useT } from '@/i18n';
import panelsMessages from '@/i18n/locales/panels-design';
import commonMessages from '@/i18n/locales/common';

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
  const tr = useT(panelsMessages);
  const tc = useT(commonMessages);
  const tokens = ds.tokens as Tokens;
  const existing = parseConventions(ds.designMd);
  const [keep, setKeep] = useState<boolean[]>(() => proposal.conventions.map(() => true));
  const [step, setStep] = useState<'preview' | 'regenerate'>('preview');
  const [pending, setPending] = useState<'write' | 'skip' | 'regenerate' | null>(null);
  const chosen = proposal.conventions.filter((_, i) => keep[i]);
  const t = proposal.tokens ?? {};
  // 行名按 key 取（proposal.token.<key>）：判断哪一行是种子色也认 key，不认显示出来的字
  const tokenRows: { key: 'seed' | 'font' | 'radius'; from: string; to: string }[] = [];
  if (t.seedColor) tokenRows.push({ key: 'seed', from: ds.seedColor, to: t.seedColor });
  if (t.fontFamily) tokenRows.push({ key: 'font', from: tokens.typography.fontFamily, to: t.fontFamily });
  if (t.radiusScale) {
    const to = RADIUS.find((r) => r.key === t.radiusScale);
    tokenRows.push({ key: 'radius', from: tr(`options.radius.${RADIUS.find((r) => r.md === tokens.radius.md)?.key ?? 'default'}`), to: to ? tr(`options.radius.${to.key}`) : t.radiusScale });
  }
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
          <h2 id="dsp-title" className="type-heading3 font-semibold">{step === 'preview' ? tr('proposal.writeTitle') : tr('proposal.regenerateTitle')}</h2>
          {proposal.summary && step === 'preview' && <p className="mt-1 type-label text-text-secondary">{proposal.summary}</p>}
        </header>
        {step === 'preview' ? (
          <div className="scroll min-h-0 flex-1 space-y-4 p-4">
            <div>
              <div className="mb-1.5 type-label font-semibold text-text-secondary">{tr('proposal.conventions')}</div>
              {proposal.conventions.length === 0 ? <p className="type-label text-text-secondary">{tr('proposal.none')}</p> : (
                <ul className="flex flex-col gap-1">
                  {proposal.conventions.map((c, i) => {
                    const isNew = !existing.includes(c);
                    return (
                      <li key={i} className="flex items-start gap-2 type-label">
                        <input id={`dsp-c-${i}`} type="checkbox" checked={keep[i]} onChange={(e) => setKeep((k) => k.map((v, j) => (j === i ? e.target.checked : v)))} className="mt-0.5 size-3.5 accent-(--semantic-color-action-link)" />
                        <label htmlFor={`dsp-c-${i}`} className="min-w-0 flex-1 leading-(--semantic-typography-body-line-height) [overflow-wrap:anywhere]">{c}{isNew && <span className="tint-link ml-1 rounded-sm px-1.5 type-caption">{tr('proposal.isNew')}</span>}</label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {existing.filter((c) => !proposal.conventions.includes(c)).length > 0 && (
                <p className="mt-1.5 type-caption text-text-secondary">{tr('proposal.removing', { list: existing.filter((c) => !proposal.conventions.includes(c)).join(tr('proposal.listSeparator')) })}</p>
              )}
            </div>
            {tokenRows.length > 0 && (
              <div>
                <div className="mb-1.5 type-label font-semibold text-text-secondary">{tr('proposal.tokens')}</div>
                {/* 行名一列（至少 3rem）按最长的那个名字定宽、各行对齐：英文行名比中文长，固定 3rem 会折行 */}
                <ul className="grid grid-cols-[minmax(3rem,max-content)_1fr] gap-x-2 gap-y-1 type-label">
                  {tokenRows.map((r) => (
                    <li key={r.key} className="col-span-2 grid grid-cols-subgrid items-center">
                      <span className="text-text-secondary">{tr(`proposal.token.${r.key}`)}</span>
                      <span className="flex items-center gap-2">
                        {r.key === 'seed' ? <><span className={`inline-block size-4 rounded-sm ${SWATCH_EDGE}`} style={{ background: r.from }} /><span>{r.from}</span><span className="text-text-secondary">→</span><span className={`inline-block size-4 rounded-sm ${SWATCH_EDGE}`} style={{ background: r.to }} /><span>{r.to}</span></> : <><span>{r.from}</span><span className="text-text-secondary">→</span><span>{r.to}</span></>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 type-label leading-(--semantic-typography-body-line-height) text-text-secondary">
            {batches > 1 ? tr('proposal.regenerateBodyBatches', { count: screenCount, batches }) : tr('proposal.regenerateBody', { count: screenCount })}
            {/* 重生成要改全部屏，与在跑作业冲突：就地写原因（PAGE-CANVAS「作业进行中时的面板」） */}
            {busyReason && <p className="mt-2 text-warning" data-testid="ds-proposal-blocked">{tr('proposal.regenerateBlocked', { reason: busyReason })}</p>}
          </div>
        )}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-4 py-3">
          {step === 'preview' ? (
            <>
              <Button key="cancel" size="sm" onClick={onClose}>{tc('cancel')}</Button>
              <Button key="confirm" ref={confirmRef} size="sm" variant="primary" data-testid="ds-proposal-confirm" pending={pending === 'write'} disabled={nothing} onClick={() => void confirm()}>{tr('proposal.confirm')}</Button>
            </>
          ) : (
            <>
              <Button key="skip" ref={skipRef} size="sm" data-testid="ds-proposal-write-only" pending={pending === 'skip'} disabled={!!pending} onClick={() => void finish(false)}>{tr('proposal.skip')}</Button>
              <Button key="regenerate" size="sm" variant="primary" data-testid="ds-proposal-regenerate" pending={pending === 'regenerate'} disabled={!!busyReason || !!pending} onClick={() => void finish(true)}>{tr('proposal.regenerate', { count: screenCount })}</Button>
            </>
          )}
        </footer>
      </div>
    </Overlay>
  );
}
