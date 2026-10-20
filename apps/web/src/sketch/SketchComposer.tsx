import { useState, type Ref } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { DraftFrameChoice, ScreenDto } from '@quilt/core/browser';
import { Composer, type ComposerHandle } from '@/composer/Composer';
import type { useRunnerPrefs } from '@/composer/useRunnerPrefs';
import type { ComposerDock } from '@/composer/useComposerDock';
import type { JobChip } from '@/composer/JobChips';
import { ChoiceGroup } from '@/sketch/ChoiceGroup';
import { RefSelect, type RefProjects } from '@/sketch/RefSelect';
import type { SketchTool } from '@/sketch/DraftStage';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';

const FRAME_KEY = 'quilt:sketch-frame';
// 画框的显示名在 sketch 命名空间的 frames.<取值>，渲染时再取
const FRAME_CHOICES = ['auto', 'component', 'mobile', 'desktop'] as const;
const isChoice = (v: string | null): v is DraftFrameChoice => FRAME_CHOICES.some((o) => o === v);
const readFrame = (): DraftFrameChoice => { try { const v = localStorage.getItem(FRAME_KEY); return isChoice(v) ? v : 'auto'; } catch { return 'auto'; } };
const noop = () => {};
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 选元素点中的那一块（REQ-CORE-045）：输入框目标区里的胶囊 */
export type DraftPick = { draftId: string; revisionId: string; qid: string; tag: string; text: string };

// 草稿本的输入框（PAGE-SKETCH，REQ-CORE-040）：与画布同一个 Composer——通道 / 会话选择、参考图、上方的作业 chip 都一样，
// 只是没有屏数与版数。看板空着时动词行写「新草稿」并多一个画框选择（缺省自动，记在本机）与「参照」下拉（缺省自由风格、不记忆）；
// 看板上有草稿时写「改「<草稿名>」」，画框选择与参照收起（这张草稿的参照在工具条上改）。
// 选元素点中了一块（REQ-CORE-045）：目标区多一枚胶囊、动词行写「改这一块」，× 或输入框空着时 Esc 去掉它回到改整张；
// 这张草稿有没发的批注时，目标区上方是「N 条批注 · 发送」。发送被挡的原因由页面按 REQ-CORE-020 的规则给
export function SketchComposer({ handle, laneRef, draft, jobs, blockedReason, prefs, refs, tool, pick, onClearPick, openAnnotations, sendingAnnotations, onSendAnnotations, onSend, onCancelJob, onRetryJob, onDismissJob, onUploadImage, onError, onEscape, hidden, dock }: {
  handle: Ref<ComposerHandle>;
  laneRef: { current: HTMLElement | null };
  /** 看板上打开的草稿：有 = 改它，没有 = 新草稿 */
  draft: ScreenDto | null;
  jobs: JobChip[];
  blockedReason: string | null;
  prefs: ReturnType<typeof useRunnerPrefs>;
  refs: RefProjects;
  tool: SketchTool;
  pick: DraftPick | null;
  onClearPick: () => void;
  /** 这张草稿上还没发的批注条数 */
  openAnnotations: number;
  sendingAnnotations: boolean;
  onSendAnnotations: () => void;
  onSend: (content: string, attachmentIds: string[], frame: DraftFrameChoice, refProjectId: string | null) => Promise<boolean>;
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => Promise<void>;
  onDismissJob: (jobId: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  onError: (msg: string) => void;
  /** 输入框空着时按 Esc：先去胶囊、再收起看板，由页面定 */
  onEscape: () => void;
  /** 停靠与收起：与画布同一套（PAGE-CANVAS「停靠与收起」），记忆单独一份 */
  hidden: boolean;
  dock: ComposerDock;
}) {
  const t = useT(sketchMessages);
  const [frame, setFrame] = useState<DraftFrameChoice>(readFrame);
  const pickFrame = (v: DraftFrameChoice) => { setFrame(v); try { localStorage.setItem(FRAME_KEY, v); } catch { /* 无痕模式写不了 */ } };
  const [refProjectId, setRefProjectId] = useState<string | null>(null);
  const agent = prefs.sendRunner?.kind === 'agent';
  const action = draft ? (pick ? t('composer.verb.editBlock') : t('composer.verb.edit', { name: draft.name })) : t('composer.verb.newDraft');
  const verb = agent ? t('composer.verb.withAgent', { verb: action }) : action;
  const phrases = !draft ? [t('composer.phrases.intro'), t('composer.phrases.card'), t('composer.phrases.order')]
    : pick ? [t('composer.pickPhrase')]
    : tool === 'pick' ? [t('composer.pickTool', { name: draft.name })]
    : tool === 'annotate' ? [t('composer.annotateTool')]
    : [t('composer.editPhrase', { name: draft.name })];
  const chip = draft && pick ? { label: pick.text ? t('composer.chipText', { name: draft.name, tag: pick.tag, text: short(pick.text, 16) }) : t('composer.chip', { name: draft.name, tag: pick.tag }), onRemove: onClearPick } : undefined;
  const blocked = !!blockedReason || sendingAnnotations;
  const top = draft && openAnnotations > 0 && (
    // 批注攒着一起发（API-EDIT-003）：一张草稿的几条合成一轮改稿；被挡的原因就是输入框上方那一句（同一张草稿上一轮没改完）
    <div className="mb-2.5 flex px-0.5">
      <button
        type="button" data-testid="draft-annotations-send" aria-disabled={blocked || undefined} aria-busy={sendingAnnotations || undefined}
        onClick={() => { if (!blocked) onSendAnnotations(); }}
        className="fill state-layer focus-ring inline-flex h-8 items-center gap-1.5 rounded-pill px-3 type-label font-medium text-text-primary aria-disabled:cursor-not-allowed"
      >
        {sendingAnnotations ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" /> : <MessageSquarePlus size={14} aria-hidden="true" />}
        {t('composer.sendAnnotations', { count: openAnnotations })}
      </button>
    </div>
  );
  return (
    <Composer
      handle={handle} laneRef={laneRef} jobs={jobs} blockedReason={blockedReason}
      sketch={{
        verb, phrases, onEmptyEscape: onEscape, chip, top,
        extra: !draft && (
          <>
            <ChoiceGroup label={t('composer.frameLabel')} testId="frame-choice" value={frame} options={FRAME_CHOICES.map((value) => ({ value, label: t(`frames.${value}`) }))} onChange={pickFrame} />
            <RefSelect refs={refs} value={refProjectId} onChange={setRefProjectId} testId="sketch-ref" side="top" className="fill text-text-primary" />
          </>
        ),
      }}
      targets={draft ? [draft] : []} componentTargets={[]} onRemoveComponentTarget={noop} totalScreens={0} anchor={null} maxTargets={1}
      count={1} versions={1} onCount={noop} onVersions={noop}
      onSend={(content, ids) => onSend(content, ids, frame, refProjectId)} onCancelJob={onCancelJob} onRetryJob={onRetryJob} onDismissJob={onDismissJob} onUploadImage={onUploadImage} onError={onError}
      onRemoveTarget={noop} onRemoveAnchor={noop} onClearTargets={noop}
      runners={prefs.runners} runnersFailed={prefs.runnersFailed} onReloadRunners={() => void prefs.loadRunners()} runnerId={prefs.runnerId} onRunnerChange={prefs.onRunnerChange}
      sessions={prefs.sessionList.items} sessionsReason={prefs.sessionList.reason} sessionTool={prefs.agentTool} sessionId={prefs.sessionId} onSessionChange={prefs.onSessionChange} onSessionsOpen={prefs.loadSessions}
      hidden={hidden} dock={dock}
    />
  );
}
