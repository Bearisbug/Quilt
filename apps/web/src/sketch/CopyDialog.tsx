import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { DEVICE_SIZE, type CopyDraftInput, type DeviceType, type ProjectDto, type Runner, type ScreenDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { lastProjectId } from '@/lib/lastProject';
import { Button, cn, Field, Input } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { Overlay, useModal } from '@/ui/modal';
import { ChoiceGroup } from '@/sketch/ChoiceGroup';
import { TargetPicker, type PickedElement } from '@/sketch/TargetPicker';
import { tOf, useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';
import commonMessages from '@/i18n/locales/common';

// 方式（FLOW-SKETCH-COPY S3）：「换一块」在请求里也是 as="overwrite"，多带点中元素的 qid（API-CORE-047）
// 各方式的显示名与确认键文案在 sketch 命名空间的 copy.mode.<方式>、copy.submit.<方式>，渲染时再取
type Mode = 'screen' | 'component' | 'overwrite' | 'replace';
const MODES = ['screen', 'component', 'overwrite', 'replace'] as const satisfies readonly Mode[];
const tm = tOf(sketchMessages);
type Problem = { title: string; errors?: { path?: string; message: string }[]; component?: string; retryAfter?: number };

// 画框与目标对不上时就地说清写进去会怎样（FLOW-SKETCH-COPY S4）：屏的视口取项目的设备形态，换进去的一块按原来那一块的宽度排（API-CORE-047）
function mismatch(frame: ScreenDto['frame'], project: ProjectDto | undefined, mode: Mode): string | null {
  if (!project || !frame || mode === 'component') return null;
  if (mode === 'replace') return frame === 'component' ? null : tm(`copy.mismatch.replace.${frame}`);
  if (frame === 'component') return tm(mode === 'screen' ? `copy.mismatch.componentScreen.${project.deviceType}` : `copy.mismatch.componentOverwrite.${project.deviceType}`);
  if (frame !== project.deviceType) return tm(`copy.mismatch.page.${frame}`);
  return null;
}

// 「写回项目…」弹层（REQ-CORE-041 / REQ-CORE-044，FLOW-SKETCH-COPY S1–S5）：把草稿当前这一版一次性写进目标项目——新屏、共享组件，
// 或原样覆盖已有的一屏（覆盖整屏）、屏里的一块（换一块，在目标屏的活预览上点选）。新屏与组件可勾选按该项目设计系统改写（服务端再建一个作业，
// 通道取输入框当前选的那条）；覆盖不改写，确认时带上加载到的目标屏当前修订，别处先改过就 409、刷新后重新确认。
// 服务端拒绝时原因写在弹层里、不关框。焦点陷阱、背景 inert、Esc 与焦点归还走 useModal（A11Y-004 / A11Y-005）
export function CopyDialog({ draft, runner, onClose, onCopied }: { draft: ScreenDto; runner: Runner | undefined; onClose: () => void; onCopied?: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose);
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [projectId, setProjectId] = useState('');
  // 缺省值（S2）：有写回目标 → 那个项目、覆盖那一屏（有元素就换那一块并预选它）；目标那一屏已被删 → 按下面两条退回并说明；
  // 只有参照项目 → 它、新屏；都没有 → 上次在画布里打开的项目、新屏
  const gone = !!draft.targetScreenId && !draft.target;
  const [mode, setMode] = useState<Mode>(draft.target ? (draft.targetQid ? 'replace' : 'overwrite') : 'screen');
  const [screenId, setScreenId] = useState(draft.target ? draft.targetScreenId ?? '' : '');
  // 预选的那一块：撞上「元素已不在」或修订冲突后作废，让用户重新点
  const [preselect, setPreselect] = useState(draft.targetQid);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [name, setName] = useState(draft.name);
  // 改写勾选：没动过时按目标项目定缺省——参照项目就是它时不勾，否则勾（ADR-031）
  const [restyleChoice, setRestyleChoice] = useState<boolean | null>(null);
  const restyle = restyleChoice ?? draft.refProjectId !== projectId;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  // 缺省项目按打开那一刻的草稿定，之后草稿再变（写回目标刚改）也不改弹层里已选的
  const preferred = useRef([draft.target?.projectId, draft.refProjectId]);
  // 缺省项目不在列表里（被删了、从没开过）就取最近更新的。下拉回报的空值不落：选项挂上之前 Radix Select 隐藏的原生 <select> 会回报 ''，
  // 照写就把刚选好的缺省冲掉（同 useRunnerPrefs）
  const loadProjects = () => {
    setListFailed(false);
    api.projects.list().then(({ items }) => {
      const list = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const fallback = [...preferred.current, lastProjectId()].map((id) => list.find((p) => p.id === id)).find(Boolean) ?? list[0];
      setProjects(list);
      setProjectId((cur) => (cur && list.some((p) => p.id === cur) ? cur : fallback?.id ?? ''));
    }).catch(() => setListFailed(true));
  };
  useEffect(loadProjects, []);
  const target = projects?.find((p) => p.id === projectId);
  const hint = mismatch(draft.frame, target, mode);

  // 覆盖与换一块要目标项目的屏（API-CORE-004）：切项目时只认最后一次请求的回包（DATA-006）；重取时旧的一份留着，不闪空
  const needsScreens = mode === 'overwrite' || mode === 'replace';
  const [detail, setDetail] = useState<{ projectId: string; screens: ScreenDto[] } | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const wanted = useRef('');
  const loadDetail = useCallback(async (id: string): Promise<ScreenDto[] | null> => {
    wanted.current = id;
    setDetailFailed(false);
    try {
      const d = await api.projects.get(id);
      if (wanted.current !== id) return null;
      setDetail({ projectId: id, screens: d.screens });
      return d.screens;
    } catch {
      if (wanted.current === id) setDetailFailed(true);
      return null;
    }
  }, []);
  const loadedFor = detail?.projectId;
  useEffect(() => { if (needsScreens && projectId && loadedFor !== projectId) void loadDetail(projectId); }, [needsScreens, projectId, loadedFor, loadDetail]);
  // 只列有内容的屏：没有当前修订的屏无从覆盖，也拿不到确认用的修订
  const screens = detail?.projectId === projectId ? detail.screens.filter((s) => s.currentRevisionId) : null;
  const targetScreen = screens?.find((s) => s.id === screenId);
  const device = target?.deviceType ?? 'mobile';

  const changeProject = (v: string) => {
    if (!v || v === projectId) return;
    setProjectId(v);
    setScreenId(v === draft.target?.projectId ? draft.targetScreenId ?? '' : '');
    setPicked(null); setError(null); setScreenError(null);
  };
  const changeScreen = (v: string) => {
    if (!v || v === screenId) return;
    setScreenId(v);
    setPicked(null); setError(null); setScreenError(null);
  };
  const focusField = (id: string) => document.getElementById(id)?.focus();

  // 服务端拒绝的原因就地写出（FLOW-SKETCH-COPY S3 / S6 的分支表），弹层不关
  const explain = async (err: unknown) => {
    if (!(err instanceof ApiError)) { setError(t('copy.error.offline')); return; }
    const p = err.problem as Problem;
    const first = p.errors?.[0];
    switch (err.type) {
      case '/errors/screen-busy':
        setError(targetScreen ? t('copy.error.busyName', { name: targetScreen.name }) : t('copy.error.busy')); return;
      case '/errors/revision-conflict': {
        // 刷新目标屏：预览按新修订重挂（key 带修订 id）、并排缩略图与「回到第 n 版」跟着换；已点中的那一块作废
        setPicked(null); setPreselect(null);
        const fresh = await loadDetail(projectId);
        setError(fresh ? t('copy.error.conflict') : t('copy.error.conflictStale'));
        return;
      }
      case '/errors/element-not-found':
        setPicked(null); setPreselect(null); setError(t('blockGone')); return;
      case '/errors/component-locked':
        setPicked(null); setPreselect(null); setError(p.component ? t('lockedName', { name: p.component }) : t('locked')); return;
      case '/errors/component-name-taken':
        setNameError(t('copy.error.nameTaken')); focusField('copy-name'); return;
      case '/errors/rate-limited':
        setError(p.retryAfter ? t('copy.error.rateLimitedIn', { count: p.retryAfter }) : t('copy.error.rateLimited')); return;
      case '/errors/not-found':
        // 目标项目或那一屏刚被删：重取列表与屏，用户重新选
        setError(t('copy.error.notFound'));
        loadProjects();
        if (needsScreens) void loadDetail(projectId);
        return;
    }
    // 400 validation：名字不合规落到名字框；其余（组件放不下脚本或样式表……）用服务端的原话
    if (first?.path === 'name') { setNameError(first.message); focusField('copy-name'); return; }
    setError(first?.message ?? t('copy.error.title', { reason: p.title }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || pending) return;
    setError(null);
    let body: CopyDraftInput;
    if (mode === 'overwrite' || mode === 'replace') {
      if (!targetScreen?.currentRevisionId) { setScreenError(mode === 'replace' ? t('copy.need.replaceScreen') : t('copy.need.overwriteScreen')); focusField('copy-target-screen'); return; }
      if (mode === 'replace' && !picked) { setError(t('copy.need.block')); return; }
      // 确认那一刻的当前修订 = 弹层加载到、预览与缩略图显示的那一版
      body = { projectId: target.id, as: 'overwrite', screenId: targetScreen.id, expectedRevisionId: targetScreen.currentRevisionId, ...(mode === 'replace' && picked ? { qid: picked.qid } : {}) };
    } else {
      const trimmed = name.trim();
      if (!trimmed) { setNameError(t('copy.need.name')); focusField('copy-name'); return; }
      body = { projectId: target.id, as: mode, name: trimmed, restyle, runner: restyle ? runner : undefined };
    }
    setPending(true);
    try {
      await api.sketchbook.copyDraft(draft.id, body);
      onCopied?.();
      onClose();
      toast(t('copy.copied', { name: target.name }), 'info', { action: { label: t('copy.view'), run: () => navigate(`/p/${target.id}`) } });
    } catch (err) {
      await explain(err);
      setPending(false);
    }
  };

  const screenOptions = (screens ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.variantName ? `${s.route} · ${s.variantName}` : s.route, icon: <ScreenThumb src={s.thumbUrl ?? s.screenshotUrl} device={device} /> }));
  const seq = targetScreen?.currentRevisionSeq;

  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="copy-title" tabIndex={-1} data-testid="copy-dialog" data-mode={mode} onSubmit={submit} noValidate
        className="sheet flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col fade-up outline-none">
        <div className="shrink-0 px-5 pt-5">
          <h2 id="copy-title" className="type-heading3 font-semibold">{t('copy.title')}</h2>
          <p className="mt-1 type-label text-text-secondary">{t('copy.intro', { name: draft.name })}</p>
        </div>
        {/* 内容超过视口时只这一段滚，标题与确认键常驻 */}
        <div className="scroll min-h-0 flex-1 space-y-4 px-5 pb-1 pt-4">
          {gone && <p data-testid="copy-target-gone" className="fill rounded-md px-3 py-2 type-label text-text-secondary">{t('copy.gone')}</p>}
          <div className="space-y-1.5">
            <label htmlFor="copy-project" className="block type-label font-medium text-text-secondary">{t('copy.projectLabel')}</label>
            {listFailed ? (
              <p role="alert" className="flex items-center justify-between gap-2 type-label text-error"><span>{t('copy.listFailed')}</span><Button size="sm" onClick={loadProjects}>{tc('retry')}</Button></p>
            ) : projects && projects.length === 0 ? (
              <p className="type-label text-text-secondary">{t('copy.noProjects')}</p>
            ) : (
              <Select id="copy-project" data-testid="copy-project" aria-label={t('copy.projectAria')} value={projectId} onChange={changeProject} placeholder={projects ? t('copy.chooseProject') : t('copy.loadingProjects')} disabled={!projects}
                options={(projects ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.deviceType === 'mobile' ? t('device.mobile') : t('device.desktop') }))} />
            )}
          </div>
          <div className="space-y-1.5">
            <span className="block type-label font-medium text-text-secondary">{t('copy.modeLabel')}</span>
            <ChoiceGroup label={t('copy.modeAria')} testId="copy-as" value={mode} options={MODES.map((value) => ({ value, label: t(`copy.mode.${value}`) }))} wrap onChange={(v) => { setMode(v); setError(null); setScreenError(null); }} />
          </div>

          {needsScreens ? (
            <div className="space-y-1.5">
              <label htmlFor="copy-target-screen" className="block type-label font-medium text-text-secondary">{mode === 'replace' ? t('copy.screenLabel.replace') : t('copy.screenLabel.overwrite')}</label>
              {detailFailed && !screens ? (
                <p role="alert" className="flex items-center justify-between gap-2 type-label text-error"><span>{t('copy.screensFailed', { name: target?.name ?? '' })}</span><Button size="sm" onClick={() => void loadDetail(projectId)}>{tc('retry')}</Button></p>
              ) : screens && screens.length === 0 ? (
                <p className="flex items-center justify-between gap-2 type-label text-text-secondary"><span>{t('copy.noScreens', { name: target?.name ?? '' })}</span><Button size="sm" onClick={() => setMode('screen')}>{t('copy.asScreen')}</Button></p>
              ) : (
                <Select id="copy-target-screen" data-testid="copy-target-screen" aria-label={t('copy.screenAria')} value={targetScreen ? screenId : ''} onChange={changeScreen}
                  placeholder={screens ? t('copy.chooseScreen') : t('copy.loadingScreens')} disabled={!screens} options={screenOptions} />
              )}
              {screenError && <p role="alert" className="type-label text-error">{screenError}</p>}
            </div>
          ) : (
            <>
              <Field label={t('copy.name')} htmlFor="copy-name" error={nameError ?? undefined}>
                <Input id="copy-name" data-testid="copy-name" value={name} maxLength={80} autoComplete="off" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? 'copy-name-error' : undefined}
                  onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameError(null); setError(null); }} />
              </Field>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" data-testid="copy-restyle" checked={restyle} onChange={(e) => setRestyleChoice(e.target.checked)} className="focus-ring mt-0.5 size-4 shrink-0 accent-(--semantic-color-action-link)" />
                <span>
                  <span className="block type-body text-text-primary">{t('copy.restyle')}</span>
                  <span className="block type-label text-text-secondary">{t('copy.restyleHint')}</span>
                </span>
              </label>
            </>
          )}

          {/* 覆盖整屏：左边目标屏现在的样子，右边要写进去的草稿 */}
          {mode === 'overwrite' && targetScreen && (
            <div data-testid="copy-compare" className="grid grid-cols-2 gap-3">
              <figure className="min-w-0 space-y-1.5">
                <Shot src={targetScreen.thumbUrl ?? targetScreen.screenshotUrl} device={device} alt={t('copy.nowAlt', { name: targetScreen.name })} />
                <figcaption className="truncate text-center type-caption text-text-secondary">{t('copy.nowCaption', { seq })}</figcaption>
              </figure>
              <figure className="min-w-0 space-y-1.5">
                <Shot src={draft.thumbUrl ?? draft.screenshotUrl} device={device} alt={t('copy.draftAlt', { name: draft.name })} component={draft.frame === 'component'} />
                <figcaption className="truncate text-center type-caption text-text-secondary">{t('copy.draftCaption')}</figcaption>
              </figure>
            </div>
          )}
          {mode === 'replace' && targetScreen && target && (
            <TargetPicker
              key={`${targetScreen.id}|${targetScreen.currentRevisionId}`} screen={targetScreen} deviceType={target.deviceType} picked={picked}
              initialQid={targetScreen.id === draft.targetScreenId ? preselect : null}
              onPick={(el) => { setPicked(el); setError(null); }} onEscape={onClose}
              onStale={async () => (await loadDetail(target.id))?.find((s) => s.id === targetScreen.id) ?? null}
            />
          )}

          {hint && <p data-testid="copy-hint" className="fill rounded-md px-3 py-2 type-label text-text-secondary">{hint}</p>}
          {error && <p role="alert" data-testid="copy-error" className="type-label text-error">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 px-5 pb-5 pt-4">
          {needsScreens && targetScreen && seq != null && (
            <p data-testid="copy-restore-hint" className="mr-auto min-w-0 flex-1 basis-56 type-label text-text-secondary">{t('copy.restoreHint', { name: targetScreen.name, seq })}</p>
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" variant="primary" data-testid="copy-submit" pending={pending} disabled={!target}>{t(`copy.submit.${mode}`)}</Button>
          </div>
        </div>
      </form>
    </Overlay>
  );
}

// 并排缩略图：框按目标项目的设备比例，手机屏定高、桌面屏占满列宽。截图的底是用户设计稿的白；组件画框的草稿截图是透明底，垫看板底色（同记录栏）。
// 取图失败按地址记：换了一屏、地址变了就重新取
function Shot({ src, device, alt, component }: { src: string | null; device: DeviceType; alt: string; component?: boolean }) {
  const t = useT(sketchMessages);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const view = DEVICE_SIZE[device];
  return (
    <div className={cn('mx-auto grid max-w-full place-items-center overflow-hidden rounded-md border border-border-subtle', device === 'mobile' ? 'h-[min(17rem,38dvh)]' : 'w-full', component ? 'bg-(--semantic-color-surface-canvas)' : 'bg-neutral-0')}
      style={{ aspectRatio: `${view.w} / ${view.h}` }}>
      {src && brokenSrc !== src
        ? <img src={src} alt={alt} draggable={false} onError={() => setBrokenSrc(src)} className={cn('size-full object-contain', !component && 'object-top')} />
        : <span className="px-2 text-center type-caption text-text-secondary">{src ? t('copy.shotFailed') : t('copy.noShot')}</span>}
    </div>
  );
}

// 目标屏下拉里每项前面的小缩略图：按设备比例裁顶部
function ScreenThumb({ src, device }: { src: string | null; device: DeviceType }) {
  const size = device === 'mobile' ? 'h-7 w-3.5' : 'h-5 w-8';
  return src
    ? <img src={src} alt="" loading="lazy" draggable={false} className={cn('shrink-0 rounded-sm border border-border-subtle bg-neutral-0 object-cover object-top', size)} />
    : <span className={cn('shrink-0 rounded-sm bg-(--semantic-color-surface-sunken)', size)} aria-hidden="true" />;
}
