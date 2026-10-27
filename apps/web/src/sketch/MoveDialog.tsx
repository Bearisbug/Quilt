import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { draftComponentName, draftRoute, type ComponentDto, type MoveDraftsInput, type ProjectDto, type Runner, type ScreenDto, type SurfaceDto } from '@quilt/core/browser';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { lastProjectId } from '@/lib/lastProject';
import { Button, cn, Field, IconButton, Input } from '@/ui/ui';
import { Select } from '@/ui/Select';
import { Overlay, useModal } from '@/ui/modal';
import { useT } from '@/i18n';
import sketchMessages from '@/i18n/locales/sketch';
import commonMessages from '@/i18n/locales/common';

// 分组下拉里「未分组」「新建分组…」两项的值：Radix Select 不收空串，分组名本身不会以控制字符开头
const NO_GROUP = '\u0001none';
const NEW_GROUP = '\u0001new';
type Problem = { title: string; errors?: { path?: string; message: string }[] };
type Detail = { projectId: string; surfaces: SurfaceDto[]; screens: ScreenDto[]; components: ComponentDto[] };

// 「搬进项目…」弹层（REQ-CORE-052，FLOW-SKETCH-MOVE S3–S8，API-CORE-055）：勾选的几张草稿一次搬进某个项目的某一端——页面草稿成屏、组件草稿成共享组件，
// 每张只带当前这一版，搬完草稿本里不再有它们。依次选项目、端与分组，下面逐张写出会成为什么（路由与组件名按服务端同一套规则预先算好）。
// 带脚本或样式表的组件草稿由服务端查出（400 按 draftIds.<序号> 点名）：那几行标红、挡住确认，移出这一批才能再搬。
// 焦点陷阱、背景 inert、Esc 与焦点归还走 useModal（A11Y-004 / A11Y-005）
export function MoveDialog({ drafts, runner, onClose, onMoved }: { drafts: ScreenDto[]; runner: Runner | undefined; onClose: () => void; onMoved: (ids: string[]) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT(sketchMessages);
  const tc = useT(commonMessages);
  const ref = useModal<HTMLFormElement>(onClose);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo(() => drafts.filter((d) => !removed.has(d.id)), [drafts, removed]);

  // 项目缺省（S3）：勾选的都参照同一个项目时选它，否则上次在画布里打开的项目，再没有就取最近更新的
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const loadProjects = () => {
    setListFailed(false);
    api.projects.list().then(({ items: list }) => setProjects([...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)))).catch(() => setListFailed(true));
  };
  useEffect(loadProjects, []);
  const preferred = useRef(new Set(drafts.map((d) => d.refProjectId)).size === 1 ? drafts[0].refProjectId : null);
  const projectId = projectChoice && projects?.some((p) => p.id === projectChoice) ? projectChoice
    : ([preferred.current, lastProjectId()].map((id) => projects?.find((p) => p.id === id)).find(Boolean) ?? projects?.[0])?.id ?? '';
  const target = projects?.find((p) => p.id === projectId);

  // 目标项目的端、屏与组件（API-CORE-004）：切项目时只认最后一次请求的回包（DATA-006）
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const wanted = useRef('');
  const loadDetail = useCallback(async (id: string) => {
    wanted.current = id;
    setDetailFailed(false);
    try {
      const d = await api.projects.get(id);
      if (wanted.current === id) setDetail({ projectId: id, surfaces: d.surfaces, screens: d.screens, components: d.components });
    } catch { if (wanted.current === id) setDetailFailed(true); }
  }, []);
  const loadedFor = detail?.projectId;
  useEffect(() => { if (projectId && loadedFor !== projectId) void loadDetail(projectId); }, [projectId, loadedFor, loadDetail]);
  const here = detail?.projectId === projectId ? detail : null;

  // 端缺省：第一个设备与草稿画框相符的端（看第一张页面草稿；全是组件就取第一端）
  const [surfaceChoice, setSurfaceChoice] = useState<string | null>(null);
  const pageFrame = items.find((d) => d.frame === 'mobile' || d.frame === 'desktop')?.frame;
  const surface = here ? here.surfaces.find((s) => s.id === surfaceChoice) ?? here.surfaces.find((s) => s.deviceType === pageFrame) ?? here.surfaces[0] ?? null : null;
  const groups = useMemo(() => [...new Set((here?.screens ?? []).filter((s) => s.surfaceId === surface?.id && s.group).map((s) => s.group!))], [here, surface?.id]);
  const [groupSel, setGroupSel] = useState(NO_GROUP);
  const [newGroup, setNewGroup] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);

  // 改写缺省同写回（ADR-031）：草稿本来就参照目标项目的不改写，其余改写；勾选框没动过时不带 restyle，由服务端逐张按这条定
  const [restyleChoice, setRestyleChoice] = useState<boolean | null>(null);
  const restyled = items.filter((d) => restyleChoice ?? d.refProjectId !== projectId).length;
  const mixed = restyleChoice === null && restyled > 0 && restyled < items.length;
  const restyleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (restyleRef.current) restyleRef.current.indeterminate = mixed; }, [mixed]);

  // 逐张会成为什么：路由在这一端里去重、组件名在项目里去重，与服务端按同一顺序算（API-CORE-055）
  const plan = useMemo(() => {
    const taken = (here?.screens ?? []).filter((s) => s.surfaceId === surface?.id).map((s) => s.route);
    const names = (here?.components ?? []).map((c) => c.name);
    return items.map((d) => {
      if (d.frame === 'component') { const name = draftComponentName(d.name, names); names.push(name); return { draft: d, kind: 'component' as const, name }; }
      const route = draftRoute(d.name, taken); taken.push(route);
      return { draft: d, kind: 'screen' as const, name: route };
    });
  }, [items, here, surface?.id]);

  const [flagged, setFlagged] = useState<Record<string, string>>({});
  const blockedRows = items.filter((d) => flagged[d.id]).length;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeProject = (v: string) => {
    if (!v || v === projectId) return;
    setProjectChoice(v); setSurfaceChoice(null); setGroupSel(NO_GROUP); setNewGroup(''); setGroupError(null); setError(null);
  };
  const changeSurface = (v: string) => {
    if (!v || v === surface?.id) return;
    setSurfaceChoice(v); setGroupSel(NO_GROUP); setGroupError(null); setError(null);
  };
  const removeItem = (id: string) => {
    setRemoved((s) => new Set([...s, id]));
    setFlagged(({ [id]: _, ...rest }) => rest);
    setError(null);
  };

  // 服务端拒绝的原因就地写出（FLOW-SKETCH-MOVE S6 的分支表），弹层不关
  const explain = (err: unknown, sent: ScreenDto[]) => {
    if (!(err instanceof ApiError)) { setError(t('move.error.offline')); return; }
    const p = err.problem as Problem;
    if (err.type === '/errors/screen-busy') { setError(t('move.error.busy')); return; }
    if (err.type === '/errors/rate-limited') { setError(t('move.error.rateLimited')); return; }
    if (err.type === '/errors/not-found') { setError(t('move.error.notFound')); loadProjects(); if (projectId) void loadDetail(projectId); return; }
    // 400 validation：按 draftIds.<序号> 点名的几张标红；分组名不合规落到分组框；其余用服务端的原话
    const rows = (p.errors ?? []).map((x) => ({ m: /^draftIds\.(\d+)$/.exec(x.path ?? ''), message: x.message })).filter((x) => x.m && sent[Number(x.m[1])]);
    if (rows.length) { setFlagged(Object.fromEntries(rows.map((x) => [sent[Number(x.m![1])].id, x.message]))); setError(t('move.flagged')); return; }
    const group = p.errors?.find((x) => x.path === 'group');
    if (group) { setGroupError(group.message); document.getElementById('move-new-group')?.focus(); return; }
    setError(p.errors?.[0]?.message ?? t('move.error.title', { reason: p.title }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || !surface || !items.length || blockedRows || pending) return;
    const group = groupSel === NEW_GROUP ? newGroup.trim() : groupSel === NO_GROUP ? undefined : groupSel;
    if (groupSel === NEW_GROUP && !group) { setGroupError(t('move.groupRequired')); document.getElementById('move-new-group')?.focus(); return; }
    setError(null);
    const sent = items;
    const body: MoveDraftsInput = { draftIds: sent.map((d) => d.id), projectId: target.id, surfaceId: surface.id, group, restyle: restyleChoice ?? undefined, runner: restyled ? runner : undefined };
    setPending(true);
    try {
      const r = await api.sketchbook.moveDrafts(body);
      onMoved(sent.map((d) => d.id));
      onClose();
      // 去看看（S8）：打开那个项目的全屏视图、停在搬进去的第一屏；只搬了组件就回它的画布
      const first = r.screens[0];
      const to = first ? `/p/${target.id}/view?surface=${surface.id}&screen=${first.id}` : `/p/${target.id}?surface=${surface.id}`;
      toast(t('move.moved', { count: sent.length, project: target.name, surface: surface.name }), 'info', { action: { label: t('move.view'), run: () => navigate(to) } });
      if (r.restyleError) toast(t('move.restyleFailed', { reason: r.restyleError }), 'error');
    } catch (err) {
      explain(err, sent);
      setPending(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="move-title" tabIndex={-1} data-testid="move-dialog" onSubmit={submit} noValidate
        className="sheet flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col fade-up outline-none">
        <div className="shrink-0 px-5 pt-5">
          <h2 id="move-title" className="type-heading3 font-semibold">{t('move.title')}</h2>
          <p className="mt-1 type-label text-text-secondary">{t('move.intro', { count: drafts.length })}</p>
        </div>
        {/* 内容超过视口时只这一段滚，标题与确认键常驻 */}
        <div className="scroll min-h-0 flex-1 space-y-4 px-5 pb-1 pt-4">
          <div className="space-y-1.5">
            <label htmlFor="move-project" className="block type-label font-medium text-text-secondary">{t('move.projectLabel')}</label>
            {listFailed ? (
              <p role="alert" className="flex items-center justify-between gap-2 type-label text-error"><span>{t('move.listFailed')}</span><Button size="sm" onClick={loadProjects}>{tc('retry')}</Button></p>
            ) : projects && projects.length === 0 ? (
              <p className="type-label text-text-secondary">{t('move.noProjects')}</p>
            ) : (
              <Select id="move-project" data-testid="move-project" aria-label={t('move.projectAria')} value={projectId} onChange={changeProject} placeholder={projects ? t('move.chooseProject') : t('move.loadingProjects')} disabled={!projects}
                options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            )}
          </div>
          {target && (
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="move-surface" className="block type-label font-medium text-text-secondary">{t('move.surfaceLabel')}</label>
                {detailFailed && !here ? (
                  <p role="alert" className="flex flex-wrap items-center gap-2 type-label text-error"><span>{t('move.detailFailed', { name: target.name })}</span><Button size="sm" onClick={() => void loadDetail(target.id)}>{tc('retry')}</Button></p>
                ) : (
                  <Select id="move-surface" data-testid="move-surface" aria-label={t('move.surfaceAria')} value={surface?.id ?? ''} onChange={changeSurface} placeholder={t('move.loadingSurfaces')} disabled={!here}
                    options={(here?.surfaces ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.deviceType === 'mobile' ? t('device.mobile') : t('device.desktop') }))} />
                )}
              </div>
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="move-group" className="block type-label font-medium text-text-secondary">{t('move.groupLabel')}</label>
                <Select id="move-group" data-testid="move-group" aria-label={t('move.groupAria')} value={groupSel} disabled={!surface}
                  onChange={(v) => { if (!v) return; setGroupSel(v); setGroupError(null); if (v === NEW_GROUP) requestAnimationFrame(() => document.getElementById('move-new-group')?.focus()); }}
                  options={[{ value: NO_GROUP, label: t('move.ungrouped') }, ...groups.map((g) => ({ value: g, label: g })), { value: NEW_GROUP, label: t('move.newGroup') }]} />
              </div>
            </div>
          )}
          {groupSel === NEW_GROUP && (
            <Field label={t('move.groupName')} htmlFor="move-new-group" error={groupError ?? undefined}>
              <Input id="move-new-group" data-testid="move-new-group" value={newGroup} maxLength={20} autoComplete="off" placeholder={t('move.groupPlaceholder')}
                aria-invalid={groupError ? true : undefined} aria-describedby={groupError ? 'move-new-group-error' : undefined}
                onChange={(e) => { setNewGroup(e.target.value); if (e.target.value.trim()) setGroupError(null); }} />
            </Field>
          )}
          <label className="flex cursor-pointer items-start gap-2.5">
            <input ref={restyleRef} type="checkbox" data-testid="move-restyle" checked={restyleChoice ?? restyled === items.length} onChange={(e) => setRestyleChoice(e.target.checked)} className="focus-ring mt-0.5 size-4 shrink-0 accent-(--semantic-color-action-link)" />
            <span>
              <span className="block type-body text-text-primary">{t('move.restyle')}</span>
              {restyled > 0 && <span className="block type-label text-text-secondary">{t('move.restyleHint', { count: restyled })}</span>}
            </span>
          </label>

          <section aria-labelledby="move-list-label" className="space-y-1.5">
            <h3 id="move-list-label" className="type-label font-medium text-text-secondary">{t('move.listLabel')}</h3>
            <p className="type-caption text-text-secondary">{t('move.onlyCurrent')}</p>
            <ul data-testid="move-list" className="flex flex-col gap-1">
              {plan.map(({ draft: d, kind, name }) => {
                const thumb = d.thumbUrl ?? d.screenshotUrl;
                const problem = flagged[d.id];
                const mismatch = kind === 'screen' && surface && (d.frame === 'mobile' || d.frame === 'desktop') && d.frame !== surface.deviceType ? t(`move.mismatch.${d.frame}`) : null;
                return (
                  <li key={d.id} data-testid="move-item" data-kind={kind} data-flagged={problem ? 'true' : undefined} className={cn('flex items-start gap-2.5 rounded-md p-1.5', problem && 'tint-error')}>
                    <span className={cn('grid size-10 shrink-0 place-items-center overflow-hidden rounded-sm border border-border-subtle', d.frame === 'component' ? 'bg-(--semantic-color-surface-canvas)' : 'bg-neutral-0')}>
                      {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} className={cn('size-full', d.frame === 'component' ? 'object-contain' : 'object-cover object-top')} /> : <span className="size-full bg-(--semantic-color-surface-sunken)" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate type-body text-text-primary">{d.name}</span>
                      <span className="block truncate type-caption text-text-secondary" data-testid="move-item-as">{kind === 'screen' ? t('move.asScreen', { route: name }) : t('move.asComponent', { name })}</span>
                      {mismatch && <span className="block type-caption text-text-secondary">{mismatch}</span>}
                      {d.target && <span className="block type-caption text-text-secondary">{t('move.fromProject', { project: d.target.projectName })}</span>}
                      {problem && <span className="block type-caption text-error" data-testid="move-item-problem">{problem}</span>}
                    </span>
                    {problem && <IconButton size="xs" tip="left" label={t('move.remove', { name: d.name })} data-testid="move-item-remove" onClick={() => removeItem(d.id)}><X size={14} aria-hidden="true" /></IconButton>}
                  </li>
                );
              })}
            </ul>
          </section>
          {error && <p role="alert" data-testid="move-error" className="type-label text-error">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 pb-5 pt-4">
          <Button onClick={onClose}>{tc('cancel')}</Button>
          <Button type="submit" variant="primary" data-testid="move-submit" pending={pending} disabled={!target || !surface || !items.length || blockedRows > 0}>{t('move.submit', { count: items.length })}</Button>
        </div>
      </form>
    </Overlay>
  );
}
