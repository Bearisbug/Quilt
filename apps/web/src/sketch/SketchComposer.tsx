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

const FRAME_KEY = 'quilt:sketch-frame';
const FRAME_CHOICES = [{ value: 'auto', label: '自动' }, { value: 'component', label: '组件' }, { value: 'mobile', label: '手机页' }, { value: 'desktop', label: '桌面页' }] as const;
const isChoice = (v: string | null): v is DraftFrameChoice => FRAME_CHOICES.some((o) => o.value === v);
const readFrame = (): DraftFrameChoice => { try { const v = localStorage.getItem(FRAME_KEY); return isChoice(v) ? v : 'auto'; } catch { return 'auto'; } };
const NEW_PHRASES = ['写一句话，出一张组件或页面', '例如：一个登录卡片，左边插画、右边表单', '例如：手机上的订单详情页，顶部是物流时间线'];
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
  const [frame, setFrame] = useState<DraftFrameChoice>(readFrame);
  const pickFrame = (v: DraftFrameChoice) => { setFrame(v); try { localStorage.setItem(FRAME_KEY, v); } catch { /* 无痕模式写不了 */ } };
  const [refProjectId, setRefProjectId] = useState<string | null>(null);
  const agent = prefs.sendRunner?.kind === 'agent';
  const verb = `${draft ? (pick ? '改这一块' : `改「${draft.name}」`) : '新草稿'}${agent ? ' · 交给本机会话' : ''}`;
  const phrases = !draft ? NEW_PHRASES
    : pick ? ['说说这一块要怎么改：例如 换成两列卡片，标题加粗']
    : tool === 'pick' ? [`点草稿里的一块只改它；不点就是改「${draft.name}」整张`]
    : tool === 'annotate' ? ['点草稿里的元素写批注，攒几条一起发；也可以在这里说整张怎么改']
    : [`说说「${draft.name}」要怎么改：例如 按钮换成圆形，加一个音量滑块`];
  const chip = draft && pick ? { label: `「${draft.name}」里的 ${pick.tag}${pick.text ? `「${short(pick.text, 16)}」` : ''}`, onRemove: onClearPick } : undefined;
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
        {openAnnotations} 条批注 · 发送
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
            <ChoiceGroup label="新草稿的画框" testId="frame-choice" value={frame} options={FRAME_CHOICES} onChange={pickFrame} />
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
