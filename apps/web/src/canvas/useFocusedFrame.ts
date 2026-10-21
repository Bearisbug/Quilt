import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParentToPreview, ScreenDto } from '@quilt/core/browser';
import type { CanvasProps } from '@/canvas/CanvasView';
import { markPalette, useResolvedMode } from '@/lib/theme';
import { useLocale } from '@/i18n';

// 卡片正显示的这张（原图或缩略图）是不是当前修订的：退出聚焦的交接按它判
const shotIsCurrent = (s: ScreenDto, src: string | undefined) => !!src && (src === s.screenshotUrl || src === s.thumbUrl);

/**
 * 聚焦屏的活 iframe（REQ-CORE-005 / REQ-PROTO-001，v1.07 从 CanvasView.tsx 抽出）：钉 src、就绪看门、屏内跳转与叠层、后退重摆、
 * 热更新、切变体、屏内标记，以及退出聚焦后留在卡片上等截图接班的那一份。p 是这一次渲染的 props，propsRef 指着最近一次的
 */
export function useFocusedFrame(p: CanvasProps, propsRef: { current: CanvasProps }, byId: Record<string, ScreenDto>) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeReady, setIframeReady] = useState(false);
  // 重挂 iframe 用：从交互态切到选择元素态时，要把屏内导航过的 DOM 丢掉、回到这张卡片自己的那一屏
  const [reloadKey, setReloadKey] = useState(0);
  // 聚焦期间钉住 iframe 的 src：previewUrl 是签名 URL，每次 refresh 都会换一串新签名，
  // src 一变 iframe 就静默重载、回到 interact 模式，选择元素态当场失效（且丢掉屏内滚动位置）。
  const [focusedSrc, setFocusedSrc] = useState<string | null>(null);
  // iframe 这一次实际加载的是哪一版（v0.76）：钉 src 时一并记下，就绪后作为热更新的基线——取「就绪那一刻的当前修订」的话，
  // 加载期间落地的新修订会被直接当成已显示，屏里停在旧版、检查器却按新版改
  const pinned = useRef<{ id: string; rev: string | null } | null>(null);
  // iframe 里显示的（或已发出 swap、正在换成的）是哪一屏的哪一版（v0.94）：取新 HTML 的途中作废。
  // 不等 quilt:swapped——运行时换 DOM 走 View Transition，过渡播完才回它，改完立刻退出时还没到；swap 一发出运行时就一定会换完
  const [frameShows, setFrameShows] = useState<{ id: string; rev: string | null } | null>(null);
  // 退出聚焦后留在卡片上的 iframe（v0.94 PAGE-CANVAS「退出聚焦的交接」）：等这一版的截图在卡片上解码完再撤
  const [linger, setLinger] = useState<{ id: string; rev: string; src: string } | null>(null);
  // 每张卡最近一张解码显示出来的截图地址（CardShot 接班时报上来）
  const shotShown = useRef(new Map<string, string>());
  useEffect(() => { if (!p.focusedId) { setIframeReady(false); setFocusedSrc(null); } }, [p.focusedId]);
  useEffect(() => {
    if (!p.focusedId || focusedSrc) return;
    const cur = p.screens.find((x) => x.id === p.focusedId);
    if (cur?.previewUrl) { pinned.current = { id: cur.id, rev: cur.currentRevisionId }; setFocusedSrc(cur.previewUrl); }
  }, [p.focusedId, p.screens, focusedSrc]);
  // 聚焦 iframe 的就绪看门（v0.76）：load 之后 2 s 还没收到 quilt:ready，多半是签名过期（里面是 403 JSON，父页读不到状态码）——
  // 静默重取签名、换新地址重载一次；仍不行就在角标上给「重试」
  const readyRef = useRef(false);
  readyRef.current = iframeReady;
  const frameRetried = useRef(false);
  const [frameFailed, setFrameFailed] = useState(false);
  const readyTimer = useRef<number | null>(null);
  useEffect(() => { frameRetried.current = false; setFrameFailed(false); return () => { if (readyTimer.current) clearTimeout(readyTimer.current); }; }, [p.focusedId]);

  const focused = p.focusedId ? byId[p.focusedId] : null;
  // 退出聚焦的那一次渲染里就定下要不要留（v0.94）：等 effect 再定，这次提交已经把 iframe 卸掉了，再挂回来就是重载
  const [prevFocusedId, setPrevFocusedId] = useState(p.focusedId);
  if (prevFocusedId !== p.focusedId) {
    setPrevFocusedId(p.focusedId);
    const left = !p.focusedId && prevFocusedId ? byId[prevFocusedId] : undefined;
    setLinger(left?.currentRevisionId && iframeReady && focusedSrc && frameShows?.id === left.id && frameShows.rev === left.currentRevisionId
      && !shotIsCurrent(left, shotShown.current.get(left.id))
      ? { id: left.id, rev: left.currentRevisionId, src: focusedSrc } : null);
    // 留着时又聚焦回这一屏：换 key 重挂——签名在 30 分钟窗口里不变，同一个 src 不会重载，等不到 quilt:ready
    if (p.focusedId && linger?.id === p.focusedId) setReloadKey((k) => k + 1);
  }
  // 当前修订又变了（它显示的已是旧版）或聚焦了任何一屏（同一时刻只有一个活 iframe）就不再留
  const lingerOn = linger && !p.focusedId && byId[linger.id]?.currentRevisionId === linger.rev ? linger : null;

  const postToPreview = useCallback((msg: ParentToPreview) => { iframeRef.current?.contentWindow?.postMessage(msg, propsRef.current.previewOrigin); }, [propsRef]);
  // 播放跳转只认默认屏（v0.62）：变体与默认屏同路由，路由找屏时排除变体
  const baseByRoute = useCallback((route: string) => propsRef.current.screens.find((s) => s.route === route && !s.variantOf), [propsRef]);
  // 此刻 iframe 里显示的是哪一屏（最上面那层）：聚焦时是卡片自己，之后随跳转、切变体、叠层变
  const [shownId, setShownId] = useState<string | null>(p.focusedId);
  useEffect(() => { setShownId(p.focusedId); }, [p.focusedId]);
  useEffect(() => { p.onShown?.(shownId); }, [shownId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 取目标屏的 HTML（屏内跳转、切变体、后退重摆、热更新）：检查响应状态——同源可读的错误体不能当屏 swap 进去；
  // 失败（签名过期时预览域的 403 不带 CORS 头，这里拿到的是网络错误）先静默重取签名再取一次，仍失败抛给调用方（v0.76）
  const htmlOf = useCallback(async (s: ScreenDto): Promise<string | null> => {
    if (!s.previewUrl) return null;
    const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`preview ${r.status}`); return r.text(); };
    try { return await get(s.previewUrl); }
    catch {
      const fresh = (await propsRef.current.onStale?.())?.screens.find((x) => x.id === s.id)?.previewUrl;
      if (!fresh) throw new Error('preview unavailable');
      return get(fresh);
    }
  }, [propsRef]);
  // 叠层屏（v0.63 REQ-PROTO-005）：跳到 overlay 屏压一层（quilt:overlay），不换 DOM；跳到 push 屏整份换（运行时先清叠层）
  const swapTo = useCallback(async (target: ScreenDto) => {
    let html: string | null;
    try { html = await htmlOf(target); } catch { propsRef.current.onPreviewError?.(target); return; }
    if (html === null) return;
    const msg: ParentToPreview = target.presentation === 'overlay' ? { type: 'quilt:overlay', html, route: target.route } : { type: 'quilt:swap', html, route: target.route };
    iframeRef.current?.contentWindow?.postMessage(msg, p.previewOrigin);
    setShownId(target.id);
    p.setNavStack((s) => [...s, target.route]);
  }, [p, propsRef, htmlOf]);
  // 按一条导航栈把 iframe 重新摆出来：栈里最靠上的整屏（没有就是卡片自己）换进去，它上面的叠层逐层压回去。
  // 后退穿过叠层、叠层关闭链接都走这里——只发一条 overlay-close 的话，底下那一屏若是后来才换进来的就对不上了。
  // 叠层要等整屏换完（quilt:swapped，整份重写时是新文档的 quilt:ready）再发：整份重写期间 iframe 里没有任何监听，发过去就丢了
  const landed = useRef<(() => void) | null>(null);
  const rebuild = useCallback(async (stack: string[]) => {
    if (!focused) return;
    let j = stack.length - 1;
    while (j >= 0 && baseByRoute(stack[j])?.presentation === 'overlay') j--;
    const base = j >= 0 ? baseByRoute(stack[j]) : focused;
    if (!base) return;
    let baseHtml: string | null;
    try { baseHtml = await htmlOf(base); } catch { propsRef.current.onPreviewError?.(base); return; }
    if (baseHtml === null) return;
    await new Promise<void>((done) => { landed.current = done; postToPreview({ type: 'quilt:swap', html: baseHtml, route: base.route }); });
    let top = base;
    // 某一层取不到就停在它下面那层：导航栈只留真的摆出来的
    let shownStack = stack;
    for (let k = j + 1; k < stack.length; k++) {
      const route = stack[k];
      const o = baseByRoute(route);
      let html: string | null = null;
      if (o) { try { html = await htmlOf(o); } catch { propsRef.current.onPreviewError?.(o); shownStack = stack.slice(0, k); break; } }
      if (!o || !html) continue;
      postToPreview({ type: 'quilt:overlay', html, route });
      top = o;
    }
    setShownId(top.id);
    p.setNavStack(() => shownStack);
  }, [focused, p, baseByRoute, htmlOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = useCallback(() => {
    if (!focused || p.navStack.length === 0) return;
    const stack = p.navStack.slice(0, -1);
    // 栈顶是叠层屏：只关它这一层，底下那一屏原样留着（滚动位置都在）
    const top = baseByRoute(p.navStack[p.navStack.length - 1]);
    if (top?.presentation === 'overlay') {
      const under = stack.length ? baseByRoute(stack[stack.length - 1]) : focused;
      // 叠层开着时底下那一屏出了新修订（热更新只跟最上面那层走）：按栈重摆一遍，露出来的是它的新版本
      if (under && shownRevs.current.has(under.id) && shownRevs.current.get(under.id) !== under.currentRevisionId) { void rebuild(stack); return; }
      iframeRef.current?.contentWindow?.postMessage({ type: 'quilt:overlay-close' } as ParentToPreview, p.previewOrigin);
      setShownId(under?.id ?? focused.id);
      p.setNavStack(() => stack);
      return;
    }
    void rebuild(stack);
  }, [focused, p, baseByRoute, rebuild]);

  const highlight = useCallback((qid: string | null) => postToPreview({ type: 'quilt:highlight', qid }), [postToPreview]);
  // 回到这张卡片自己的屏：重挂 iframe（src 不变时 React 不会重新加载，只能靠换 key）并清空导航栈
  // 清空后由上面的 effect 用「当前这一轮的 props」重新钉住——这里直接读 propsRef 会拿到上一轮的
  // previewUrl（调用方常常是 await refresh() 之后紧接着调，state 还没落到下一次渲染），于是重载出旧修订
  const resetToOwn = useCallback(() => { setIframeReady(false); landed.current = null; setFocusedSrc(null); setReloadKey((k) => k + 1); propsRef.current.setNavStack(() => []); setShownId(propsRef.current.focusedId); }, [propsRef]);
  // 签名过期导致 iframe 等不到就绪：重取详情，用新签名的地址重挂（钉住的修订随之换成详情里的当前版）
  const reloadFresh = useCallback(async () => {
    const id = propsRef.current.focusedId;
    if (!id) return;
    const d = await propsRef.current.onStale?.();
    const fresh = (d?.screens ?? propsRef.current.screens).find((x) => x.id === id);
    if (!fresh?.previewUrl || propsRef.current.focusedId !== id) return;
    pinned.current = { id, rev: fresh.currentRevisionId };
    landed.current = null;
    setIframeReady(false); setFocusedSrc(fresh.previewUrl); setReloadKey((k) => k + 1);
    propsRef.current.setNavStack(() => []); setShownId(id);
  }, [propsRef]);
  const onFrameLoad = () => {
    if (readyTimer.current) clearTimeout(readyTimer.current);
    readyTimer.current = window.setTimeout(() => {
      readyTimer.current = null;
      if (readyRef.current) return;
      if (frameRetried.current) { setFrameFailed(true); return; }
      frameRetried.current = true;
      void reloadFresh();
    }, 2000);
  };
  const retryFrame = () => { setFrameFailed(false); frameRetried.current = true; void reloadFresh(); };
  // 聚焦一屏（镜头由调用方推）：撤掉就绪、钉住这一版的地址
  const beginFocus = useCallback((s: ScreenDto) => {
    setIframeReady(false);
    landed.current = null;  // 换屏或重挂之后，还在等上一份文档换完的重摆作废
    pinned.current = { id: s.id, rev: s.currentRevisionId };
    setFocusedSrc(s.previewUrl);
  }, []);

  // 选择元素模式随 props 与 iframe 就绪同步到运行时；换外观时重发一次，屏内的标记跟着换色（§13.1）；换界面语言时同样重发，标记文字跟着换
  const themeMode = useResolvedMode();
  const locale = useLocale();
  useEffect(() => { if (iframeReady) postToPreview({ type: 'quilt:mode', mode: p.inspectMode ? 'inspect' : 'interact', marks: markPalette() }); }, [p.inspectMode, iframeReady, postToPreview, themeMode, locale]);

  // 聚焦态热更新（REQ-CORE-005 v0.33）：src 钉住后新修订不会自己进来，由这里显式送——iframe 里正显示的那一屏
  //（导航栈顶，没跳转过就是卡片自己）换了 currentRevisionId，就取新 HTML swap 进同一个文档：不重挂、不丢导航栈，
  // 模式与滚动位置由运行时保住。基线按「屏 id + 修订 id」记：跳转换屏只更新基线不 swap，同屏换修订才 swap。
  // previewUrl 是签名 URL、每次 refresh 都换，所以不进依赖，只在真要 swap 时从 ref 读当前值。
  const shown = shownId ? byId[shownId] : undefined;
  const shownRev = shown?.currentRevisionId ?? null;
  // 正显示那一屏所在的家族（v0.62）：默认屏在前，变体按位置排——跳到别的屏之后胶囊跟着换成那一屏的
  const family = useMemo(() => {
    if (!shown) return [] as ScreenDto[];
    const base = shown.variantOf ? byId[shown.variantOf] : shown;
    if (!base) return [shown];
    return [base, ...p.screens.filter((s) => s.variantOf === base.id).sort((a, b) => a.x - b.x || a.y - b.y)];
  }, [shown, byId, p.screens]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const baseline = useRef<{ id: string; rev: string | null } | null>(null);
  // 每屏最近一次显示在 iframe 里的修订：叠层关掉时拿它判断底下那一屏在被盖住期间有没有更新
  const shownRevs = useRef(new Map<string, string | null>());
  // 热更新换完 DOM（quilt:swapped，或整份重写后的 quilt:ready）再按这个 qid 重选；跳转的 swap 不重选——同一 qid 在别的屏上是另一个元素
  const pendingReselect = useRef<string | null>(null);
  useEffect(() => {
    if (!p.focusedId || !iframeReady || !shownId) { baseline.current = null; setFrameShows(null); return; }
    const base = baseline.current ?? pinned.current;
    pinned.current = null;
    baseline.current = { id: shownId, rev: shownRev };
    shownRevs.current.set(shownId, shownRev);
    const cur = shownRef.current;
    if (base && (base.id !== shownId || base.rev === shownRev)) { setFrameShows({ id: shownId, rev: shownRev }); return; }
    setFrameShows(null);
    if (!base || !cur?.previewUrl) return;
    let stale = false;
    // 正显示的是一层叠层：只换这一层，底下那一屏不动（swap 会把叠层全清掉、让它独占整页）
    const asLayer = cur.presentation === 'overlay' && propsRef.current.navStack.length > 0;
    htmlOf(cur).then((html) => {
      if (stale || html === null) return;
      pendingReselect.current = propsRef.current.selectedQid;
      if (asLayer) { postToPreview({ type: 'quilt:overlay-close' }); postToPreview({ type: 'quilt:overlay', html, route: cur.route }); }
      else { postToPreview({ type: 'quilt:swap', html, route: cur.route, keepScroll: true }); setFrameShows({ id: shownId, rev: shownRev }); }
    }).catch(() => { if (!stale) propsRef.current.onPreviewError?.(cur); });
    return () => { stale = true; };
  }, [p.focusedId, iframeReady, shownId, shownRev, postToPreview, htmlOf, propsRef]);
  useEffect(() => { if (linger && !lingerOn) setLinger(null); }, [linger, lingerOn]);
  useEffect(() => {
    if (!lingerOn) return;
    postToPreview({ type: 'quilt:mode', mode: 'interact', marks: markPalette() });
    // inert 之后焦点若还停在 iframe 上，父页收不到键盘（Esc、快捷键成了死键）
    if (document.activeElement === iframeRef.current) iframeRef.current?.blur();
    const cur = propsRef.current.screens.find((x) => x.id === lingerOn.id);
    if (cur && shotIsCurrent(cur, shotShown.current.get(lingerOn.id))) setLinger(null);
  }, [lingerOn, postToPreview, propsRef]);
  // 卡片截图解码完成：这一版的截图接班，留下的 iframe 在同一次提交里撤掉
  const onShotShown = useCallback((id: string, src: string) => {
    shotShown.current.set(id, src);
    const s = propsRef.current.screens.find((x) => x.id === id);
    setLinger((l) => (l && l.id === id && s?.currentRevisionId === l.rev && shotIsCurrent(s, src) ? null : l));
  }, [propsRef]);
  // 屏内标记：正显示的屏上有哪些 qid 在被改。作业结束 qid 离开集合 → 记为待「已更新」，等紧随其后的热更新换完 DOM 再打上；
  // 1.5 s 内没等到热更新（失败 / 取消）就作罢，只把「修改中」撤掉
  const workingQids = useMemo(() => p.workingSubtrees.filter((w) => w.screenId === shownId).map((w) => w.qid), [p.workingSubtrees, shownId]);
  const workingKey = workingQids.join(',');
  const workingRef = useRef(workingQids);
  workingRef.current = workingQids;
  const prevWorking = useRef<string[]>([]);
  const pendingDone = useRef<string[]>([]);
  useEffect(() => {
    if (!iframeReady) { prevWorking.current = []; return; }
    const left = prevWorking.current.filter((q) => !workingQids.includes(q));
    prevWorking.current = workingQids;
    // 作业一收口就打「已更新」（作业先出屏后收口时 DOM 早换过了，此刻不打就没机会）；同时留一份给紧随其后的热更新换完 DOM 再补
    if (left.length) pendingDone.current = [...new Set([...pendingDone.current, ...left])];
    postToPreview({ type: 'quilt:mark', working: workingQids, done: left });
    const t = setTimeout(() => { pendingDone.current = []; }, 1500);
    return () => clearTimeout(t);
  }, [workingKey, iframeReady, postToPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  // 直改保存后：父页知道改的是哪个 qid，当场打一次「已更新」，再留一份给热更新换完 DOM 后补打（没等到热更新就算了）。
  // 当场打这一次不能省：落修订的推送可能比保存的响应先到，那样 DOM 在登记之前就换完了，之后不会再有热更新来补。直改不改 qid，新旧 DOM 上都打得中
  const markDone = useCallback((qids: string[]) => {
    pendingDone.current = [...new Set([...pendingDone.current, ...qids])];
    postToPreview({ type: 'quilt:mark', working: workingRef.current, done: qids });
    setTimeout(() => { pendingDone.current = pendingDone.current.filter((q) => !qids.includes(q)); }, 3000);
  }, [postToPreview]);
  const reselectAfterSwap = useCallback(() => {
    const qid = pendingReselect.current;
    pendingReselect.current = null;
    if (qid) postToPreview({ type: 'quilt:reselect', qid });
    const done = pendingDone.current;
    pendingDone.current = [];
    postToPreview({ type: 'quilt:mark', working: workingRef.current, done });
  }, [postToPreview]);
  // 切状态变体（v0.62）：同一 iframe 换成该变体的当前修订，镜头不动、导航栈不动；选中的元素属于换掉的那份 DOM，清空。
  // 正显示的是一层叠层时只换这一层，底下那一屏留着（与热更新的叠层分支同理）
  const swapVariant = useCallback(async (id: string) => {
    const target = byId[id];
    if (!target) return;
    let html: string | null;
    try { html = await htmlOf(target); } catch { propsRef.current.onPreviewError?.(target); return; }
    if (html === null) return;
    pendingReselect.current = null;
    propsRef.current.onElementSelect(null);
    if (target.presentation === 'overlay' && propsRef.current.navStack.length > 0) { postToPreview({ type: 'quilt:overlay-close' }); postToPreview({ type: 'quilt:overlay', html, route: target.route }); }
    else postToPreview({ type: 'quilt:swap', html, route: target.route, keepScroll: true });
    setShownId(target.id);
  }, [byId, postToPreview, htmlOf, propsRef]);

  // 运行时的回报：新文档就绪（首次加载，或整份重写之后）、同一文档里换完 DOM。等着它们的重摆这时接着往下走
  const markReady = useCallback(() => {
    landed.current?.(); landed.current = null;
    readyRef.current = true; frameRetried.current = false; setFrameFailed(false); setIframeReady(true);
    postToPreview({ type: 'quilt:mode', mode: propsRef.current.inspectMode ? 'inspect' : 'interact', marks: markPalette() }); reselectAfterSwap();
  }, [postToPreview, reselectAfterSwap, propsRef]);
  const markSwapped = useCallback(() => { landed.current?.(); landed.current = null; reselectAfterSwap(); }, [reselectAfterSwap]);
  // 屏里点了站内链接 / 提交了表单（REQ-PROTO-001）
  const navigate = (href: string) => {
    if (!focused) return;
    // 叠层里指回它底下那一屏的链接（契约要求叠层带这样一个关闭动作）是关闭，不是再跳一次
    const stack = p.navStack;
    const topIsOverlay = stack.length > 0 && baseByRoute(stack[stack.length - 1])?.presentation === 'overlay';
    const under = stack.length >= 2 ? stack[stack.length - 2] : focused.route;
    if (topIsOverlay && href === under) { goBack(); return; }
    const t = baseByRoute(href);
    if (t) void swapTo(t); else p.onNavigateMissing(focused.id, href);
  };

  return {
    iframeRef, iframeReady, reloadKey, focusedSrc, frameFailed, lingerOn, shownId, family, focused,
    beginFocus, onFrameLoad, retryFrame, markReady, markSwapped, navigate, goBack, resetToOwn,
    highlight, markDone, swapVariant, onShotShown,
  };
}
