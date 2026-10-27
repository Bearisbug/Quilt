// @ts-check
// 预览运行时：内联进每版修订的 prelude（ADR-003）。职责：链接劫持 → 父页；接收 swap 在同文档内换 DOM；
// 跨屏保留表单状态；把画布级快捷键转发给父页；隐藏桌面浏览器的滚动条；上报 ready/swapped。消息协议见 protocol.ts。
(function () {
  /** @typedef {import('./protocol.ts').PreviewToParent} Outgoing */
  /** @typedef {import('./protocol.ts').ParentToPreview} Incoming */
  /** @typedef {{ el: HTMLElement, kind: string, prev: { outline: string, offset: string }, badge: HTMLElement, timer: ReturnType<typeof setTimeout> | null }} Mark */
  // 运行时在预览文档的 window 上读写的几样：跨屏保留的表单状态、组件预览标记（componentPreviewDocument 写入）、lucide 图标库
  var win = /** @type {Window & { __quiltState?: Record<string, any>, __quiltComponent?: boolean, lucide?: { createIcons?: () => void } }} */ (window);
  var state = (win.__quiltState = win.__quiltState || {});
  // 卡片里是一台设备，桌面浏览器却会在它右缘画一条常驻滚动条——真机上没有这东西，它会被读成设计的一部分。
  // 只隐藏滚动条像素，滚动能力全留（屏内 overflow-y:auto 的区域同理，所以用 *）。
  // 要带 !important：页面自己写的滚动条样式（如 html{scrollbar-width:thin}）选择器都比 * 具体，不加会把这条压过去
  var bars = document.createElement('style');
  bars.setAttribute('data-quilt-ui', '');
  bars.textContent = '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}';
  document.head.appendChild(bars);
  function fields() { return /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name],textarea[name],select[name]')); }
  function snapshotForms() {
    fields().forEach(function (el) {
      state[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
  }
  function restoreForms() {
    fields().forEach(function (el) {
      if (!(el.name in state)) return;
      if (el.type === 'checkbox') el.checked = !!state[el.name]; else el.value = state[el.name];
    });
  }
  function icons() { if (win.lucide && win.lucide.createIcons) win.lucide.createIcons(); }
  // 状态（REQ-CORE-051 / ADR-041，API-CORE-016 状态条目）：每个维度的当前取值写在 <html> 的 data-s-<键> 上，带 data-when 的元素条件成立才显示。
  // 维度来自两处：预览域下发时放进 head 的端上维度（data-quilt-surface-states），与屏里的声明块（data-quilt-states，键与端上重名的不生效）。
  // 取值由父页发 quilt:states 给，记在 __quiltState 上（整份重写时留得住）；没收到时一律用缺省。条件判定之前 data-when 元素先隐藏，免得闪一下
  var whenCss = document.createElement('style');
  whenCss.setAttribute('data-quilt-ui', '');
  whenCss.textContent = '[data-when]:not([data-quilt-on]){display:none!important}';
  document.head.appendChild(whenCss);
  /** @type {Record<string, ReturnType<typeof setTimeout>>} */
  var playing = {};
  /** @param {string} sel */
  function readJson(sel) { var el = document.querySelector(sel); if (!el) return null; try { return JSON.parse(el.textContent || ''); } catch (e) { return null; } }
  /** @returns {Record<string, { default: string, values: { key: string }[] }>} */
  function stateDims() {
    /** @type {Record<string, { default: string, values: { key: string }[] }>} */
    var dims = {};
    var surface = readJson('script[data-quilt-surface-states]'); var page = readJson('script[data-quilt-states]');
    ((surface && surface.dims) || []).forEach(function (/** @type {any} */ d) { dims[d.key] = d; });
    ((page && page.dims) || []).forEach(function (/** @type {any} */ d) { if (!dims[d.key] && !((surface && surface.events) || []).some(function (/** @type {any} */ e) { return e.key === d.key; })) dims[d.key] = d; });
    return dims;
  }
  /** @param {string} expr @param {Record<string, string>} cur */
  function holds(expr, cur) {
    return expr.trim().split(/\s+/).filter(Boolean).every(function (part) {
      if (part.charAt(0) === '@') return !!playing[part.slice(1)];
      var at = part.indexOf(':'); if (at < 1) return false;
      var v = cur[part.slice(0, at)];
      return v !== undefined && part.slice(at + 1).split('|').indexOf(v) >= 0;
    });
  }
  function applyStates() {
    var dims = stateDims(); var sent = state.__quiltStates || {}; var html = document.documentElement;
    /** @type {Record<string, string>} */
    var cur = {};
    Array.prototype.slice.call(html.attributes).forEach(function (/** @type {Attr} */ a) { if (a.name.indexOf('data-s-') === 0 && !dims[a.name.slice(7)]) html.removeAttribute(a.name); });
    Object.keys(dims).forEach(function (k) {
      var d = dims[k]; var v = sent[k];
      cur[k] = v && (d.values || []).some(function (x) { return x.key === v; }) ? v : d.default;
      html.setAttribute('data-s-' + k, cur[k]);
    });
    document.querySelectorAll('[data-when]').forEach(function (el) { if (holds(el.getAttribute('data-when') || '', cur)) el.setAttribute('data-quilt-on', ''); else el.removeAttribute('data-quilt-on'); });
    return cur;
  }
  /** @param {string} key @param {number} ms */
  function playEvent(key, ms) {
    // 从头再播：先把它的元素收起来、强制一次排版，CSS 动画才会重新开始
    if (playing[key]) { clearTimeout(playing[key]); delete playing[key]; applyStates(); void document.body.offsetWidth; }
    playing[key] = setTimeout(function () { delete playing[key]; applyStates(); }, ms);
    applyStates();
    window.dispatchEvent(new CustomEvent('quilt:event', { detail: { key: key, ms: ms } }));
  }
  // 换进来的 DOM 里的 <script> 不会执行（DOMParser 解析出的脚本是惰性的）：屏里的图表库、自写脚本（v0.43 允许）都要按原顺序重建一遍，
  // 带 src 的等它加载完再跑下一个。不做的话图表屏只有首次打开能画出来，跳转、热更新、切变体、叠层打开后都是空白。
  // 重跑的内联脚本包一层块作用域：同一个 window 里第二次执行顶层 const/let 会报「已声明」，整段脚本不跑
  /** @param {ParentNode} root */
  function runScripts(root) {
    var list = Array.prototype.slice.call(root.querySelectorAll('script'));
    (function next(i) {
      if (i >= list.length) return;
      var old = list[i];
      // JSON 数据块（页内状态的声明块）不是脚本：原样留着，包了块作用域就不是合法 JSON 了
      if (old.type === 'application/json') { next(i + 1); return; }
      var s = document.createElement('script');
      for (var k = 0; k < old.attributes.length; k++) s.setAttribute(old.attributes[k].name, old.attributes[k].value);
      if (old.src) { s.onload = s.onerror = function () { next(i + 1); }; old.replaceWith(s); }
      else { s.textContent = old.type === 'module' ? old.textContent : '{\n' + old.textContent + '\n}'; old.replaceWith(s); next(i + 1); }
    })(0);
  }
  /** @param {Outgoing} msg */
  function send(msg) { parent.postMessage(msg, '*'); }
  // 叠层屏（v0.63 REQ-PROTO-005）：把另一屏的根元素压在当前文档上——固定层 + 45% 暗遮罩，不换 DOM，底下那一屏与它的
  // 滚动位置都留着。层带 data-quilt-ui：选元素态的穿透规则不会把遮罩当成可命中元素。点遮罩（或叠层根元素本身
  // 露出来的透明区域）只上报 dismiss，关不关由父页定——导航栈在父页。
  /** @type {HTMLElement[]} */
  var overlays = [];
  // 换 body 还没落地时（view transition 的回调是异步的）收到的压层请求先排队，换完再压——否则叠层挂在即将被换掉的旧 body 上，
  // 跟着一起消失。整份重写（document.open）会连 window 上的监听一起抹掉，那段时间到的消息无处可排，所以父页要先等
  // quilt:swapped / quilt:ready 再发压层
  var swapping = false;
  /** @type {{ html: string, route: string }[]} */
  var queued = [];
  // 叠层打开时按 qid 找元素只在最上面那层里找：每屏的 qid 都从 q1 编起，底下那一屏排在文档前面，全文档找会先命中它
  function scope() { return overlays.length ? overlays[overlays.length - 1] : document; }
  function flushOverlays() { swapping = false; var q = queued; queued = []; q.forEach(function (o) { openOverlay(o.html, o.route); }); }
  function clearOverlays() { overlays.forEach(function (l) { l.remove(); }); overlays = []; }
  function closeOverlay() { var l = overlays.pop(); if (l) l.remove(); }
  /** @param {string} html @param {string} route */
  function openOverlay(html, route) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var root = doc.body.firstElementChild; if (!root) return;
    var layer = document.createElement('div');
    layer.setAttribute('data-quilt-ui', ''); layer.setAttribute('data-quilt-overlay-layer', route);
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);overflow:auto;';
    root = document.adoptNode(root);
    layer.addEventListener('click', function (e) { if (mode === 'inspect') return; if (e.target === layer || e.target === root) { e.preventDefault(); send({ type: 'quilt:overlay-dismiss' }); } });
    layer.appendChild(root);
    document.body.appendChild(layer); overlays.push(layer); runScripts(layer); icons(); restoreForms(); applyStates();
  }

  document.addEventListener('input', snapshotForms, true);
  // 导航源三种（REQ-PROTO-001）：链接 / data-href 点击、表单提交，统一发 navigate；表单一律不真提交
  document.addEventListener('click', function (e) {
    var t = /** @type {Element | null} */ (e.target);
    var a = t && t.closest && t.closest('a[href],[data-href]');
    if (!a) return;
    // 组件预览（REQ-EDIT-006）：组件不是屏，没有路由也没有去处——链接一律惰性，点了什么都不发生，
    // 也不报「去处还没设计」。组件卡的交互态是拿来试组件自己的状态的（tab 切换、开关），不是试跳转。
    if (win.__quiltComponent) { e.preventDefault(); return; }
    var href = a.hasAttribute('href') ? (a.getAttribute('href') || '') : (a.getAttribute('data-href') || '');
    if (href.charAt(0) === '/') { e.preventDefault(); snapshotForms(); send({ type: 'quilt:navigate', href: href }); }
    else if (href === '#') { e.preventDefault(); send({ type: 'quilt:dead' }); }
  });
  // 指针下有没有能朝这个方向滚的区域（元素或文档本身）
  /** @param {Node | null} el @param {number} dx @param {number} dy */
  function canScroll(el, dx, dy) {
    for (var n = /** @type {Element | null} */ (el && el.nodeType === 1 ? el : el && el.parentElement); n; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (dy && /(auto|scroll)/.test(cs.overflowY) && (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return true;
      if (dx && /(auto|scroll)/.test(cs.overflowX) && (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0)) return true;
    }
    var d = document.scrollingElement;
    return !!d && ((dy > 0 && d.scrollTop + innerHeight < d.scrollHeight - 1) || (dy < 0 && d.scrollTop > 0) || (dx > 0 && d.scrollLeft + innerWidth < d.scrollWidth - 1) || (dx < 0 && d.scrollLeft > 0));
  }
  // 触控板捏合（ctrl+wheel）落在 iframe 里时画布收不到，浏览器会把整页放大；截住并转发给父页做画布缩放。
  // 组件预览（v0.80）：普通滚轮落在没有可滚区域的地方时同样转发（pan），父页平移画布——组件卡按内容定高，交互态下卡片区域原本是死区
  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) {
      if (!win.__quiltComponent || canScroll(/** @type {Node | null} */ (e.target), e.deltaX, e.deltaY)) return;
      e.preventDefault();
      send({ type: 'quilt:wheel', pan: true, deltaX: e.deltaX, deltaY: e.deltaY, x: e.clientX, y: e.clientY });
      return;
    }
    e.preventDefault();
    send({ type: 'quilt:wheel', deltaY: e.deltaY, x: e.clientX, y: e.clientY });
  }, { passive: false });
  // 协作显示（v1.32 REQ-CORE-048）：指针在文档里移动时按帧节流把视口坐标发给父页，父页换算成世界坐标当作自己的光标；指针离开文档发 left
  /** @type {{ x: number, y: number } | null} */
  var pointerAt = null;
  document.addEventListener('pointermove', function (e) {
    var queued = !!pointerAt;
    pointerAt = { x: e.clientX, y: e.clientY };
    if (queued) return;
    requestAnimationFrame(function () { if (pointerAt) send({ type: 'quilt:pointer', x: pointerAt.x, y: pointerAt.y }); pointerAt = null; });
  }, { passive: true });
  document.addEventListener('pointerout', function (e) { if (e.relatedTarget) return; pointerAt = null; pointer = null; send({ type: 'quilt:pointer', left: true }); });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (win.__quiltComponent) return;
    var f = /** @type {Element | null} */ (e.target);
    var action = f && f.getAttribute ? (f.getAttribute('action') || '') : '';
    if (action.charAt(0) === '/') { snapshotForms(); send({ type: 'quilt:navigate', href: action }); }
  }, true);
  // 画布级快捷键在预览文档里按下时转发给父页：Esc 退出、Alt+← 后退、⌘E 选择元素、⌘/ 输入框、⌘K 找屏，
  // ⌥ + 字母（⌥D 设计系统、⌥G 新建屏幕……，v0.80）只在焦点不在可编辑元素上时——macOS 下它们在输入框里是打特殊字符的。
  // v0.95：⌘S 保存检查器（一律拦掉浏览器的保存网页）；⌘Z 撤销、选择元素态下的 Delete / Backspace 删除元素，焦点在可编辑元素上时留给它自己
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    var t = /** @type {Element | null} */ (e.target);
    var editable = t && t.closest && t.closest('input, textarea, select, [contenteditable]');
    var del = (e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey && mode === 'inspect' && !editable;
    // 逐级选（v1.00；v1.28 起 Shift+↑ 选父级、Shift+↓ 回到子级）：层级状态在这里，就地处理、不转发；拦掉浏览器扩选文字、滚动的默认动作
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && mode === 'inspect' && !mod && !e.altKey && !editable) { e.preventDefault(); climb(e.key === 'ArrowUp' ? 'up' : 'down'); return; }
    if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft') || (mod && (e.code === 'KeyE' || e.code === 'Slash' || e.code === 'KeyK' || e.code === 'KeyS')) || (mod && e.code === 'KeyZ' && !e.shiftKey && !editable) || (e.altKey && !mod && /^Key[A-Z]$/.test(e.code) && !editable) || del) {
      e.preventDefault();
      send({ type: 'quilt:key', key: e.key, code: e.code, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
    }
  });
  // 选择元素模式（REQ-EDIT-001）：两层框都画在预览文档内——hover 框细虚线跟着鼠标走；选中框常驻（实线、左上角挂
  // 「tag · qid」标签，和检查器标题对得上），随滚动 / 缩放重算，换 body 后由父页 quilt:reselect 接回。点击上报所选元素，父页画检查器。
  var mode = 'interact';
  // 画布标记的颜色（§13.1）：父页按当前外观经 quilt:mode 给（标记色、标记上的字、halo、成功色），运行时不写颜色；
  // 外观切换时父页重发，已画出来的框与标记当场换色。收到之前沿用 currentColor
  // 修改标记角标上的字同样由父页按界面语言给（labels，REQ-CORE-046），没给时用中文
  /** @type {{ line: string, onLine: string, halo: string, success: string, labels?: { working: string, done: string } } | null} */
  var pal = null;
  /** @param {'line' | 'onLine' | 'halo' | 'success'} k */
  function color(k) { return pal ? pal[k] : 'currentColor'; }
  /** @param {'working' | 'done'} kind */
  function markLabel(kind) { var l = pal && pal.labels; return kind === 'working' ? (l ? l.working : '修改中…') : (l ? l.done : '已更新'); }
  /** @type {HTMLElement | null} */
  var box = null;
  // 选择元素模式下让每个元素都可命中（v0.57）：设计里常给装饰层或被 <label> 包着的文字写 pointer-events:none，
  // 点击于是永远落在外层容器上，里面的文字元素根本选不中。选择态是检查器的取景器，不该受设计自己的命中规则限制；
  // 退出选择态时整条规则撤掉，交互态照旧按设计的命中规则走。
  /** @type {HTMLStyleElement | null} */
  var pierce = null;
  /** @param {boolean} on */
  function setPierce(on) {
    if (on && !pierce) {
      pierce = document.createElement('style');
      pierce.setAttribute('data-quilt-ui', '');
      // 必须排除运行时自己画的那几层：选中框为了和检查器对号也带 data-qid（addSel），
      // 它是 fixed、z-index 顶格、罩住选中元素外扩 4px 的一块板子。被这条规则强制成可命中之后，
      // 它盖住的一切都点不动了——targetOf 遇到 data-quilt-ui 返回 null，于是 hover 不亮、点击不上报；
      // 选中的要是根元素，整屏都选不动。带 !important 的作者样式压得过它行内那句普通的 pointer-events:none。
      pierce.textContent = '[data-qid]:not([data-quilt-ui]){pointer-events:auto !important}';
      document.head.appendChild(pierce);
    } else if (!on && pierce) { pierce.remove(); pierce = null; }
  }
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-quilt-ui', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:1px dashed;border-radius:4px;display:none';
    paintBox();
    document.body.appendChild(box);
    return box;
  }
  // 压在设计稿上的标记外面套一圈 halo，橙红色的设计稿上也看得见
  function paintBox() { if (box) { box.style.borderColor = color('line'); box.style.boxShadow = '0 0 0 1px ' + color('halo'); } }
  // instant：键盘引起的移动（逐级选、路径预览）不带过渡，跟手的只有指针。
  // 指针停在选中的元素上不再叠一层悬停框；选中两块以上时检查器里悬停某一块（peek）照样框出它，往外多让 3px、套在它的选中框外面
  /** @param {Element | null} el @param {boolean} [instant] @param {boolean} [peek] */
  function highlight(el, instant, peek) {
    var b = ensureBox();
    b.style.transition = instant ? 'none' : 'left 60ms ease-out,top 60ms ease-out,width 60ms ease-out,height 60ms ease-out';
    var on = !!selOf(el);
    if (!el || (on && !(peek && sels.length > 1))) { b.style.display = 'none'; return; }
    var pad = on ? 5 : 2;
    var r = el.getBoundingClientRect();
    b.style.display = 'block'; b.style.left = r.left - pad + 'px'; b.style.top = r.top - pad + 'px'; b.style.width = r.width + 2 * pad + 'px'; b.style.height = r.height + 2 * pad + 'px';
  }
  // 选中框（v1.26 多选）：每个选中的元素一个常驻框，左上角挂「tag · qid」标签；selEl 是最后点中的那一块，逐级选只移动它
  /** @typedef {{ el: Element, box: HTMLElement, tag: HTMLElement }} Sel */
  /** @type {Sel[]} */
  var sels = [];
  /** @type {Element | null} */
  var selEl = null;
  /** @param {Element | null} el */
  function selOf(el) { for (var i = 0; i < sels.length; i++) if (sels[i].el === el) return sels[i]; return null; }
  /** @param {Sel} s */
  function paintSel(s) {
    s.box.style.borderColor = color('line'); s.box.style.boxShadow = '0 0 0 1px ' + color('halo') + ',inset 0 0 0 1px ' + color('halo');
    s.tag.style.background = color('line'); s.tag.style.color = color('onLine'); s.tag.style.boxShadow = '0 0 0 1px ' + color('halo');
  }
  /** @param {Sel} s */
  function placeSel(s) {
    var r = s.el.getBoundingClientRect();
    s.box.style.left = r.left - 2 + 'px'; s.box.style.top = r.top - 2 + 'px'; s.box.style.width = r.width + 4 + 'px'; s.box.style.height = r.height + 4 + 'px';
    s.tag.style.top = r.top < 24 ? '2px' : '-20px';
  }
  /** @param {Element} el */
  function addSel(el) {
    if (selOf(el)) return;
    var q = el.getAttribute('data-qid') || '';
    var box = document.createElement('div');
    box.setAttribute('data-quilt-ui', ''); box.setAttribute('data-quilt-selection', ''); box.setAttribute('data-qid', q);
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid;border-radius:4px';
    var tag = document.createElement('span');
    tag.style.cssText = 'position:absolute;left:-2px;font:600 11px/16px system-ui,sans-serif;padding:1px 7px;border-radius:999px;white-space:nowrap';
    tag.textContent = el.tagName.toLowerCase() + ' · ' + q;
    box.appendChild(tag);
    /** @type {Sel} */
    var s = { el: el, box: box, tag: tag };
    sels.push(s); paintSel(s); placeSel(s);
    document.body.appendChild(box);
  }
  /** @param {Element} el */
  function dropSel(el) { var s = selOf(el); if (!s) return; s.box.remove(); sels.splice(sels.indexOf(s), 1); if (selEl === el) selEl = null; }
  // 选中这几块（父页的 quilt:highlight），primary 是最后点中的那一块
  /** @param {Element[]} els @param {Element | null} primary */
  function setSelections(els, primary) {
    sels.slice().forEach(function (s) { if (els.indexOf(s.el) < 0) dropSel(s.el); });
    els.forEach(addSel);
    selEl = primary;
  }
  // 只选这一个（不按 Shift 点）；null 全部清空
  /** @param {Element | null} el */
  function setSelection(el) { setSelections(el ? [el] : [], el); }
  // 逐级选换掉最后点中的那一块，其余的框原样
  /** @param {Element} el */
  function movePrimary(el) { if (selEl && selEl !== el) dropSel(selEl); addSel(el); selEl = el; }
  function placeSels() { sels.slice().forEach(function (s) { if (s.el.isConnected) placeSel(s); else dropSel(s.el); }); }
  // 修改中 / 已更新标记（REQ-EDIT-002）：父页按 qid 下发。元素本身描边（随滚动走），角标 fixed 定位、滚动 / 缩放时重算；
  // 换 body 时这些节点连同角标一起消失，父页换完会重发
  /** @type {Record<string, Mark>} */
  var marks = {};
  /** @param {Mark} m */
  function placeBadge(m) { var r = m.el.getBoundingClientRect(); m.badge.style.left = Math.max(0, r.left) + 'px'; m.badge.style.top = Math.max(0, r.top - 18) + 'px'; }
  /** @param {string} qid */
  function unmark(qid) { var m = marks[qid]; if (!m) return; m.el.style.outline = m.prev.outline; m.el.style.outlineOffset = m.prev.offset; m.badge.remove(); if (m.timer) clearTimeout(m.timer); delete marks[qid]; }
  /** @param {string} qid @param {'working' | 'done'} kind */
  function mark(qid, kind) {
    var el = /** @type {HTMLElement | null} */ (scope().querySelector('[data-qid="' + qid + '"]'));
    if (!el) { unmark(qid); return; }
    /** @type {Mark | null} */
    var m = marks[qid];
    if (m && m.el !== el) { unmark(qid); m = null; }
    if (!m) {
      m = marks[qid] = { el: el, kind: '', prev: { outline: el.style.outline, offset: el.style.outlineOffset }, badge: document.createElement('span'), timer: null };
      m.badge.setAttribute('data-quilt-ui', ''); m.badge.setAttribute('data-quilt-mark', '');
      document.body.appendChild(m.badge);
    }
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    var working = kind === 'working';
    if (m.kind !== kind) {
      m.kind = kind;
      el.style.outlineOffset = '2px';
      m.badge.setAttribute('data-kind', kind);
      m.badge.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;font:600 11px/16px system-ui,sans-serif;padding:1px 7px;border-radius:999px';
      paintMark(m);
      placeBadge(m);
    }
    // 「已更新」每次都重新计时：父页可能收口时打一次、换完 DOM 再补一次
    if (!working) m.timer = setTimeout(function () { unmark(qid); }, 4000);
  }
  // 修改中用标记色虚线，已更新用成功色实线；角标的字用标记上的字色（深浅两套里它与 halo 同值，压在两种底上都读得出）。
  // 角标文字也在这里写：父页换外观或界面语言时重发 quilt:mode，已画出来的角标当场换色、换字
  /** @param {Mark} m */
  function paintMark(m) {
    m.badge.textContent = markLabel(m.kind === 'working' ? 'working' : 'done');
    var hue = m.kind === 'working' ? color('line') : color('success');
    m.el.style.outline = '2px ' + (m.kind === 'working' ? 'dashed ' : 'solid ') + hue;
    m.badge.style.background = hue; m.badge.style.color = color('onLine'); m.badge.style.boxShadow = '0 0 0 1px ' + color('halo');
  }
  /** @param {{ working: string[], done?: string[] }} msg */
  function applyMarks(msg) {
    var working = msg.working || [], done = msg.done || [];
    Object.keys(marks).forEach(function (q) { if (marks[q].kind === 'working' && working.indexOf(q) < 0 && done.indexOf(q) < 0) unmark(q); });
    working.forEach(function (q) { mark(q, 'working'); });
    done.forEach(function (q) { mark(q, 'done'); });
  }
  // 协作者选中的块（v1.32 REQ-CORE-048）：与选中框同一种画法，颜色与名字由父页给；比选中框再往外让 4px，同一块被自己也选中时两层分得开
  /** @type {{ el: Element, box: HTMLElement }[]} */
  var peerBoxes = [];
  /** @param {{ el: Element, box: HTMLElement }} p */
  function placePeer(p) {
    var r = p.el.getBoundingClientRect();
    p.box.style.left = r.left - 6 + 'px'; p.box.style.top = r.top - 6 + 'px'; p.box.style.width = r.width + 12 + 'px'; p.box.style.height = r.height + 12 + 'px';
    // 名字标签挂在框的右上角外侧；框顶上不够放（贴着页面顶）就收进框里，免得被画框裁掉
    var tag = /** @type {HTMLElement} */ (p.box.firstChild);
    var inside = r.top - 6 < 20;
    tag.style.top = inside ? '2px' : '-20px'; tag.style.right = inside ? '2px' : '-2px';
  }
  /** @param {{ qid: string, name: string, color: string, on: string }[]} blocks */
  function setPeers(blocks) {
    peerBoxes.forEach(function (p) { p.box.remove(); });
    peerBoxes = [];
    blocks.forEach(function (b) {
      var el = byQid(b.qid);
      if (!el) return;
      var box = document.createElement('div');
      box.setAttribute('data-quilt-ui', ''); box.setAttribute('data-quilt-peer', b.name);
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid ' + b.color + ';border-radius:6px';
      var tag = document.createElement('span');
      tag.style.cssText = 'position:absolute;font:600 11px/16px system-ui,sans-serif;padding:1px 7px;border-radius:999px;white-space:nowrap;background:' + b.color + ';color:' + b.on;
      tag.textContent = b.name;
      box.appendChild(tag);
      document.body.appendChild(box);
      var p = { el: el, box: box };
      peerBoxes.push(p); placePeer(p);
    });
  }
  function placePeers() { peerBoxes.forEach(function (p) { if (p.el.isConnected) placePeer(p); else p.box.remove(); }); peerBoxes = peerBoxes.filter(function (p) { return p.el.isConnected; }); }
  function replaceBadges() { Object.keys(marks).forEach(function (q) { placeBadge(marks[q]); }); placeSels(); placePeers(); rehover(); }
  window.addEventListener('scroll', replaceBadges, true);
  window.addEventListener('resize', replaceBadges);
  // 选元素态下每个元素都可命中（setPierce），连设计里本来不可点的透明层也是：常见的是收起时全透明的全屏遮罩（底部抽屉、弹窗的底板）
  // 和装它的 fixed inset-0 空容器，它们叠在最上面，点哪都落在它们身上。所以按指针位置自上而下取：看不见的（自身或祖先全透明、
  // visibility:hidden）跳过；本来不可点（关掉穿透规则时 pointer-events 为 none）又什么都不画的也跳过，取到的第一个就是目标。
  // 本来不可点、但画了东西的（装饰层、label 里的字）照样选得中，这是穿透规则要的
  /** @param {Element} el */
  function seen(el) { for (var n = /** @type {Element | null} */ (el); n; n = n.parentElement) { var cs = getComputedStyle(n); if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false; } return true; }
  /** @param {string} c */
  function clear(c) { return !c || c === 'transparent' || /(,|\/)\s*0(\.0+)?\s*\)$/.test(c); }
  /** @param {string} v */
  function none(v) { return !v || v === 'none'; }
  /** 这个元素自己画了东西：字、背景、边框、阴影，或本身是图片、控件 @param {Element} el */
  function paints(el) {
    if (!(el instanceof HTMLElement) || /^(IMG|VIDEO|CANVAS|PICTURE|INPUT|TEXTAREA|SELECT|BUTTON|IFRAME)$/.test(el.tagName)) return true;
    var cs = getComputedStyle(el);
    if (!none(cs.backgroundImage) || !none(cs.boxShadow) || !clear(cs.backgroundColor)) return true;
    var sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (var i = 0; i < 4; i++) { var k = /** @type {'borderTopWidth'} */ ('border' + sides[i] + 'Width'); if (parseFloat(cs[k]) > 0 && !clear(cs.getPropertyValue('border-' + sides[i].toLowerCase() + '-color'))) return true; }
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue || '')) return true;
    return false;
  }
  /** @param {number} x @param {number} y @param {Element | null} [fallback] 没有 elementsFromPoint 时用事件目标 */
  function targetAt(x, y, fallback) {
    var hits = document.elementsFromPoint ? document.elementsFromPoint(x, y) : fallback ? [fallback] : [];
    // 关掉穿透规则读一次各层本来的 pointer-events，再打开
    var inert = hits.map(function () { return false; });
    if (pierce) { var on = pierce; on.remove(); inert = hits.map(function (h) { return getComputedStyle(h).pointerEvents === 'none'; }); document.head.appendChild(on); }
    for (var i = 0; i < hits.length; i++) {
      var t = hits[i].closest('[data-qid]');
      if (!t) continue;
      if (t.hasAttribute('data-quilt-ui')) return null;
      if (!seen(hits[i]) || (inert[i] && !paints(hits[i]))) continue;
      return t;
    }
    return null;
  }
  // 逐级选（v1.00 REQ-EDIT-001）：指针下取到的是最里层元素。锚点 = 最近一次悬停 / 点中的最里层元素，当前层 = 锚点自身或它的某个
  // 带 data-qid 的祖先（最高到屏根）。上一级 = 最近的带 data-qid 的祖先；下一级 = 沿锚点那条链往下一步。选中与悬停各记一份
  /** @type {{ anchor: Element | null, cur: Element | null }} */
  var hov = { anchor: null, cur: null };
  // 选中的每一块各记自己的锚点（qid → 锚点 qid，v1.26 多选）：逐级选与检查器路径只看最后点中的那一块的
  /** @type {Record<string, string>} */
  var anchors = {};
  /** @param {string | null} q */
  function byQid(q) { return q ? scope().querySelector('[data-qid="' + q + '"]') : null; }
  /** @param {Element} el @returns {Element | null} */
  function up(el) { var p = el.parentElement && el.parentElement.closest('[data-qid]'); return p && !p.hasAttribute('data-quilt-ui') && scope().contains(p) ? p : null; }
  /** @param {Element} el @param {Element | null} anchor */
  function down(el, anchor) { if (!anchor || anchor === el || !el.contains(anchor)) return null; /** @type {Element} */ var c = anchor; while (up(c) && up(c) !== el) c = /** @type {Element} */ (up(c)); return up(c) === el ? c : null; }
  // 选中的锚点：还在、且仍在当前层之内就沿用，否则当前层自己就是锚点
  /** @param {Element} el */
  function selAnchor(el) { var q = qidOf(el); var a = byQid(anchors[q] || null); if (!a || !el.contains(a)) { a = el; anchors[q] = q; } return a; }
  // 点选：不按 Shift 是只选这一个，当场框上（父页随后的 quilt:highlight 再对一次）；按着 Shift 是加选或减选，由父页定、经 quilt:highlight 画出来
  /** @param {Element} el @param {boolean} additive */
  function clickSelect(el, additive) { if (!additive) setSelection(el); highlight(null); send(selection(el, selAnchor(el), additive ? { additive: true } : null)); }
  // 逐级选、路径点选：换掉最后点中的那一块，锚点跟着它走；select 带 replace 说清换掉的是哪一块
  /** @param {Element} el */
  function stepSelect(el) {
    var old = selEl && selEl.isConnected ? selEl : null;
    if (old) anchors[qidOf(el)] = qidOf(selAnchor(old));
    movePrimary(el); highlight(null);
    send(selection(el, selAnchor(el), old ? { replace: qidOf(old) } : null));
  }
  /** @param {'up' | 'down'} dir */
  function climb(dir) {
    if (selEl && selEl.isConnected) {
      var a = selAnchor(selEl);
      var next = dir === 'up' ? up(selEl) : down(selEl, a);
      if (next) stepSelect(next);
      return;
    }
    if (!hov.cur || !hov.cur.isConnected) return;
    var n = dir === 'up' ? up(hov.cur) : down(hov.cur, hov.anchor);
    if (n) { hov.cur = n; highlight(n, true); }
  }
  // 调用方只传带 data-qid 的元素（targetOf / up / byQid 都按 [data-qid] 取）
  /** @param {Element} el */
  function qidOf(el) { return /** @type {string} */ (el.getAttribute('data-qid')); }
  /** @param {Element} t @param {Element | null} anchor @param {{ additive?: boolean, replace?: string } | null} [how] @returns {Outgoing} */
  function selection(t, anchor, how) {
    var text = Array.prototype.filter.call(t.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join('').trim();
    var comp = t.closest('[data-component]');
    // path：从屏根到锚点，检查器据此画祖先路径
    /** @type {{ qid: string, tag: string }[]} */
    var path = [];
    for (var p = /** @type {Element | null} */ (anchor || t); p; p = up(p)) path.unshift({ qid: qidOf(p), tag: p.tagName.toLowerCase() });
    /** @type {Extract<Outgoing, { type: 'quilt:select' }>} */
    var m = { type: 'quilt:select', qid: qidOf(t), tag: t.tagName.toLowerCase(), text: text, classes: t.getAttribute('class') || '', href: t.getAttribute('href') || t.getAttribute('data-href') || t.getAttribute('action') || null, component: comp ? comp.getAttribute('data-component') : null, path: path };
    if (how && how.additive) m.additive = true;
    if (how && how.replace) m.replace = how.replace;
    return m;
  }
  // 没有指针位置的点击（脚本调 click()、键盘在聚焦元素上触发，detail 为 0，坐标是 0, 0）按事件目标取，不按坐标找
  /** @param {MouseEvent} e */
  function targetOf(e) {
    if (e.type === 'click' && e.detail === 0) { var el = /** @type {Element | null} */ (e.target); var t = el && el.closest && el.closest('[data-qid]'); return t && !t.hasAttribute('data-quilt-ui') ? t : null; }
    return targetAt(e.clientX, e.clientY, /** @type {Element | null} */ (e.target));
  }
  // 指针换到另一个最里层元素时悬停的层级重置；还在同一个元素上时保留按键走到的那一层
  /** @type {{ x: number, y: number } | null} */
  var pointer = null;
  /** @param {Element | null} t */
  function hoverTo(t) { if (t !== hov.anchor) { hov.anchor = t; hov.cur = t; } }
  document.addEventListener('mousemove', function (e) {
    if (mode !== 'inspect') return;
    pointer = { x: e.clientX, y: e.clientY };
    hoverTo(targetOf(e));
    highlight(hov.cur);
  }, true);
  // 滚动时指针没动、底下的元素换了，浏览器不发 mousemove：按上次的指针位置重新取一次，悬停框不带过渡跟上去（v1.37）
  function rehover() {
    if (mode !== 'inspect' || !pointer) return;
    hoverTo(targetAt(pointer.x, pointer.y, null));
    highlight(hov.cur, true);
  }
  document.addEventListener('click', function (e) {
    if (mode !== 'inspect') return;
    e.preventDefault(); e.stopPropagation();
    var t = targetOf(e); if (!t) return;
    // 点中的是悬停框所在的那层（按键往上走过就是祖先），锚点仍是指针下的最里层元素
    var el = t === hov.anchor && hov.cur && hov.cur.isConnected ? hov.cur : t;
    anchors[qidOf(el)] = qidOf(t);
    clickSelect(el, e.shiftKey);
  }, true);
  // 按着 Shift 点会把上一次点击处到这里的文字整段划选（选择元素态里设计稿上一片蓝底）：按下时拦掉默认动作
  document.addEventListener('mousedown', function (e) { if (mode === 'inspect' && e.shiftKey) e.preventDefault(); }, true);

  // 设计系统落在 <head> 里的三样：token 变量块、字体链接、Tailwind 配置。Tailwind CDN 运行时追加的 <style> 排在它们之后，不参与比较
  /** @param {HTMLHeadElement} h */
  function headKey(h) {
    var st = h.querySelector('style'); var ln = h.querySelector('link[href*="fonts.googleapis.com/css"]');
    /** @type {Element | null} */
    var cfg = null; h.querySelectorAll('script:not([src])').forEach(function (s) { if (!cfg && s.textContent.indexOf('tailwind.config') === 0) cfg = s; });
    return (st ? st.textContent : '') + '|' + (ln ? ln.getAttribute('href') : '') + '|' + (cfg ? /** @type {Element} */ (cfg).textContent : '');
  }
  /** @param {MessageEvent} e */
  function onMessage(e) {
    var msg = /** @type {Incoming} */ (e.data || {});
    if (msg.type === 'quilt:mode') { if (msg.marks) { pal = msg.marks; paintBox(); sels.forEach(paintSel); Object.keys(marks).forEach(function (q) { paintMark(marks[q]); }); } mode = msg.mode === 'inspect' ? 'inspect' : 'interact'; if (mode !== 'inspect') { highlight(null); setSelection(null); hov = { anchor: null, cur: null }; anchors = {}; pointer = null; } setPierce(mode === 'inspect'); document.body.style.cursor = mode === 'inspect' ? 'crosshair' : ''; return; }
    // 父页的选中状态是事实源：选中 / 清空都同步到常驻框。qids（v1.26 多选）是选中的全部几块，qid 是其中最后点中的那一块；不带 qids 就只有 qid 这一块
    if (msg.type === 'quilt:peers') { setPeers(msg.blocks || []); return; }
    if (msg.type === 'quilt:highlight') {
      var qs = msg.qids && msg.qids.length ? msg.qids : msg.qid ? [msg.qid] : [];
      /** @type {Element[]} */
      var els = [];
      qs.forEach(function (q) { var x = byQid(q); if (x) els.push(x); });
      setSelections(els, byQid(msg.qid));
      return;
    }
    // 热更新后重选：同一 qid 还在就回一份新值（replace 是它自己，检查器原地刷新）并把常驻框接回去，不在了让父页去掉它。
    // 选中几块时父页逐块发、最后点中的那块排最后，框一块块接回，不清掉已接回的
    if (msg.type === 'quilt:reselect') {
      var el = byQid(msg.qid);
      if (el) { if (mode === 'inspect') { addSel(el); selEl = el; } send(selection(el, selAnchor(el), { replace: msg.qid })); } else send({ type: 'quilt:deselect', qid: msg.qid });
      return;
    }
    // 逐级选（v1.00）：焦点在父页时的 Shift+↑ / Shift+↓、检查器祖先路径的点选与悬停预览
    if (msg.type === 'quilt:climb') { if (mode === 'inspect') climb(msg.dir === 'up' ? 'up' : 'down'); return; }
    if (msg.type === 'quilt:pick') { var picked = byQid(msg.qid); if (picked && mode === 'inspect') stepSelect(picked); return; }
    if (msg.type === 'quilt:peek') { if (mode === 'inspect') highlight(byQid(msg.qid), true, true); return; }
    if (msg.type === 'quilt:mark') { applyMarks(msg); return; }
    if (msg.type === 'quilt:overlay') { if (swapping) queued.push({ html: msg.html, route: msg.route }); else openOverlay(msg.html, msg.route); return; }
    if (msg.type === 'quilt:overlay-close') { closeOverlay(); return; }
    if (msg.type === 'quilt:states') {
      state.__quiltStates = msg.values || {};
      if (document.body) window.dispatchEvent(new CustomEvent('quilt:states', { detail: { values: applyStates() } }));
      return;
    }
    if (msg.type === 'quilt:event') { if (document.body && msg.key) playEvent(msg.key, Math.min(10000, Math.max(500, msg.ms || 2500))); return; }
    if (msg.type !== 'quilt:swap') return;
    var route = msg.route;
    clearOverlays(); queued = []; swapping = true;
    var doc = new DOMParser().parseFromString(msg.html, 'text/html');
    // 跳转回到顶部；同一屏换新修订（热更新）留在原处
    var y = msg.keepScroll ? window.scrollY : 0;
    if (headKey(doc.head) !== headKey(document.head)) {
      // 新修订的设计系统和当前文档不同（回刷改了色 / 圆角 / 字体）：只换 body 不够，整份重写。
      // document.open 不换 window——__quiltState 与要恢复的滚动位置都留得住；先摘掉本份监听，否则重写后的新运行时与这一份会各收一次消息
      window.removeEventListener('message', onMessage);
      state.__scrollY = y;
      document.open(); document.write(msg.html); document.close();
      return;
    }
    var apply = function () {
      document.title = doc.title;
      // 端上的维度在 head 里，下发时按端上当前的给：存过维度之后父页会把这一屏原地再送一次，这里跟着换
      var dimsNow = document.head.querySelector('script[data-quilt-surface-states]'); var dimsNew = doc.head.querySelector('script[data-quilt-surface-states]');
      if (dimsNow) dimsNow.remove();
      if (dimsNew) document.head.appendChild(dimsNew);
      document.body.replaceWith(doc.body);
      runScripts(document.body);
      box = null; sels = []; selEl = null; marks = {}; if (mode === 'inspect') document.body.style.cursor = 'crosshair';
      restoreForms(); icons(); applyStates(); window.scrollTo(0, y);
      flushOverlays();
    };
    var done = function () { send({ type: 'quilt:swapped', route: route, title: document.title }); };
    if (document.startViewTransition) document.startViewTransition(apply).finished.then(done, done);
    else { apply(); done(); }
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('DOMContentLoaded', function () {
    icons(); restoreForms(); applyStates();
    if (state.__scrollY) { window.scrollTo(0, state.__scrollY); delete state.__scrollY; }
    send({ type: 'quilt:ready', title: document.title });
    flushOverlays();
  });
})();
