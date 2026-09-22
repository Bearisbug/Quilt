// 预览运行时：内联进每版修订的 prelude（ADR-003）。职责：链接劫持 → 父页；接收 swap 在同文档内换 DOM；
// 跨屏保留表单状态；把画布级快捷键转发给父页；隐藏桌面浏览器的滚动条；上报 ready/swapped。消息协议见 protocol.ts。
export const RUNTIME_JS = String.raw`(function () {
  var state = (window.__quiltState = window.__quiltState || {});
  // 卡片里是一台设备，桌面浏览器却会在它右缘画一条常驻滚动条——真机上没有这东西，它会被读成设计的一部分。
  // 只隐藏滚动条像素，滚动能力全留（屏内 overflow-y:auto 的区域同理，所以用 *）。
  var bars = document.createElement('style');
  bars.setAttribute('data-quilt-ui', '');
  bars.textContent = '*{scrollbar-width:none}*::-webkit-scrollbar{display:none}';
  document.head.appendChild(bars);
  function snapshotForms() {
    document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) {
      state[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
  }
  function restoreForms() {
    document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) {
      if (!(el.name in state)) return;
      if (el.type === 'checkbox') el.checked = !!state[el.name]; else el.value = state[el.name];
    });
  }
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }
  function send(msg) { parent.postMessage(msg, '*'); }

  document.addEventListener('input', snapshotForms, true);
  // 导航源三种（REQ-PROTO-001）：链接 / data-href 点击、表单提交，统一发 navigate；表单一律不真提交
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href],[data-href]');
    if (!a) return;
    // 组件预览（REQ-EDIT-006）：组件不是屏，没有路由也没有去处——链接一律惰性，点了什么都不发生，
    // 也不报「去处还没设计」。组件卡的交互态是拿来试组件自己的状态的（tab 切换、开关），不是试跳转。
    if (window.__quiltComponent) { e.preventDefault(); return; }
    var href = a.hasAttribute('href') ? (a.getAttribute('href') || '') : (a.getAttribute('data-href') || '');
    if (href.charAt(0) === '/') { e.preventDefault(); snapshotForms(); send({ type: 'quilt:navigate', href: href }); }
    else if (href === '#') { e.preventDefault(); send({ type: 'quilt:dead' }); }
  });
  // 触控板捏合（ctrl+wheel）落在 iframe 里时画布收不到，浏览器会把整页放大；截住并转发给父页做画布缩放
  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    send({ type: 'quilt:wheel', deltaY: e.deltaY, x: e.clientX, y: e.clientY });
  }, { passive: false });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (window.__quiltComponent) return;
    var action = e.target && e.target.getAttribute ? (e.target.getAttribute('action') || '') : '';
    if (action.charAt(0) === '/') { snapshotForms(); send({ type: 'quilt:navigate', href: action }); }
  }, true);
  // 画布级快捷键在预览文档里按下时转发给父页：Esc 退出、Alt+← 后退、⌘E 选择元素、⌘/ 输入框
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft') || (mod && (e.code === 'KeyE' || e.code === 'Slash'))) {
      e.preventDefault();
      send({ type: 'quilt:key', key: e.key, code: e.code, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
    }
  });
  // 选择元素模式（REQ-EDIT-001）：两层框都画在预览文档内——hover 框细虚线跟着鼠标走；选中框常驻（实线、界面蓝、左上角挂
  // 「tag · qid」标签，和检查器标题对得上），随滚动 / 缩放重算，换 body 后由父页 quilt:reselect 接回。点击上报 qid 与几何，父页画检查器。
  var mode = 'interact';
  var box = null;
  // 选择元素模式下让每个元素都可命中（v0.57）：设计里常给装饰层或被 <label> 包着的文字写 pointer-events:none，
  // 点击于是永远落在外层容器上，里面的文字元素根本选不中。选择态是检查器的取景器，不该受设计自己的命中规则限制；
  // 退出选择态时整条规则撤掉，交互态照旧按设计的命中规则走。
  var pierce = null;
  function setPierce(on) {
    if (on && !pierce) {
      pierce = document.createElement('style');
      pierce.setAttribute('data-quilt-ui', '');
      // 必须排除运行时自己画的那几层：选中框为了和检查器对号也带 data-qid（setSelection），
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
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:1px dashed rgba(53,111,214,0.9);background:rgba(53,111,214,0.06);border-radius:4px;display:none;transition:left 60ms ease-out,top 60ms ease-out,width 60ms ease-out,height 60ms ease-out';
    document.body.appendChild(box);
    return box;
  }
  function highlight(el) {
    var b = ensureBox();
    if (!el || el === selEl) { b.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    b.style.display = 'block'; b.style.left = r.left - 2 + 'px'; b.style.top = r.top - 2 + 'px'; b.style.width = r.width + 4 + 'px'; b.style.height = r.height + 4 + 'px';
  }
  var selBox = null, selTag = null, selEl = null;
  function ensureSel() {
    if (selBox) return selBox;
    selBox = document.createElement('div');
    selBox.setAttribute('data-quilt-ui', ''); selBox.setAttribute('data-quilt-selection', '');
    selBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #356FD6;background:rgba(53,111,214,0.05);border-radius:4px;display:none;box-shadow:0 0 0 1px rgba(255,255,255,0.75)';
    selTag = document.createElement('span');
    selTag.style.cssText = 'position:absolute;left:-2px;font:600 11px/16px system-ui,sans-serif;padding:1px 7px;border-radius:999px;background:#356FD6;color:#fff;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.25)';
    selBox.appendChild(selTag);
    document.body.appendChild(selBox);
    return selBox;
  }
  function placeSel() {
    if (!selEl || !selBox) return;
    if (!selEl.isConnected) { setSelection(null); return; }
    var r = selEl.getBoundingClientRect();
    selBox.style.display = 'block'; selBox.style.left = r.left - 2 + 'px'; selBox.style.top = r.top - 2 + 'px'; selBox.style.width = r.width + 4 + 'px'; selBox.style.height = r.height + 4 + 'px';
    selTag.style.top = r.top < 24 ? '2px' : '-20px';
  }
  function setSelection(el) {
    selEl = el;
    var b = ensureSel();
    if (!el) { b.style.display = 'none'; return; }
    selTag.textContent = el.tagName.toLowerCase() + ' · ' + (el.getAttribute('data-qid') || '');
    b.setAttribute('data-qid', el.getAttribute('data-qid') || '');
    placeSel();
  }
  // 修改中 / 已更新标记（REQ-EDIT-002）：父页按 qid 下发。元素本身描边（随滚动走），角标 fixed 定位、滚动 / 缩放时重算；
  // 换 body 时这些节点连同角标一起消失，父页换完会重发
  var marks = {};
  function placeBadge(m) { var r = m.el.getBoundingClientRect(); m.badge.style.left = Math.max(0, r.left) + 'px'; m.badge.style.top = Math.max(0, r.top - 18) + 'px'; }
  function unmark(qid) { var m = marks[qid]; if (!m) return; m.el.style.outline = m.prev.outline; m.el.style.outlineOffset = m.prev.offset; m.badge.remove(); if (m.timer) clearTimeout(m.timer); delete marks[qid]; }
  function mark(qid, kind) {
    var el = document.querySelector('[data-qid="' + qid + '"]');
    if (!el) { unmark(qid); return; }
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
      el.style.outline = '2px ' + (working ? 'dashed #6d8cff' : 'solid #22c55e'); el.style.outlineOffset = '2px';
      m.badge.textContent = working ? '修改中…' : '已更新';
      m.badge.setAttribute('data-kind', kind);
      m.badge.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;font:600 11px/16px system-ui,sans-serif;padding:1px 7px;border-radius:999px;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);background:' + (working ? '#6d8cff' : '#22c55e');
      placeBadge(m);
    }
    // 「已更新」每次都重新计时：父页可能收口时打一次、换完 DOM 再补一次
    if (!working) m.timer = setTimeout(function () { unmark(qid); }, 4000);
  }
  function applyMarks(msg) {
    var working = msg.working || [], done = msg.done || [];
    Object.keys(marks).forEach(function (q) { if (marks[q].kind === 'working' && working.indexOf(q) < 0 && done.indexOf(q) < 0) unmark(q); });
    working.forEach(function (q) { mark(q, 'working'); });
    done.forEach(function (q) { mark(q, 'done'); });
  }
  function replaceBadges() { Object.keys(marks).forEach(function (q) { placeBadge(marks[q]); }); placeSel(); }
  window.addEventListener('scroll', replaceBadges, true);
  window.addEventListener('resize', replaceBadges);
  function targetOf(e) { var t = e.target && e.target.closest && e.target.closest('[data-qid]'); return t && !t.hasAttribute('data-quilt-ui') ? t : null; }
  function selection(t) {
    var r = t.getBoundingClientRect();
    var text = Array.prototype.filter.call(t.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join('').trim();
    var comp = t.closest('[data-component]');
    return { type: 'quilt:select', qid: t.getAttribute('data-qid'), tag: t.tagName.toLowerCase(), text: text, classes: t.getAttribute('class') || '', href: t.getAttribute('href') || t.getAttribute('data-href') || t.getAttribute('action') || null, component: comp ? comp.getAttribute('data-component') : null, rect: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } };
  }
  document.addEventListener('mousemove', function (e) { if (mode !== 'inspect') return; highlight(targetOf(e)); }, true);
  document.addEventListener('click', function (e) {
    if (mode !== 'inspect') return;
    e.preventDefault(); e.stopPropagation();
    var t = targetOf(e); if (!t) return;
    setSelection(t); highlight(null);
    send(selection(t));
  }, true);

  // 设计系统落在 <head> 里的三样：token 变量块、字体链接、Tailwind 配置。Tailwind CDN 运行时追加的 <style> 排在它们之后，不参与比较
  function headKey(h) {
    var st = h.querySelector('style'); var ln = h.querySelector('link[href*="fonts.googleapis.com/css"]');
    var cfg = null; h.querySelectorAll('script:not([src])').forEach(function (s) { if (!cfg && s.textContent.indexOf('tailwind.config') === 0) cfg = s; });
    return (st ? st.textContent : '') + '|' + (ln ? ln.getAttribute('href') : '') + '|' + (cfg ? cfg.textContent : '');
  }
  function onMessage(e) {
    var msg = e.data || {};
    if (msg.type === 'quilt:mode') { mode = msg.mode === 'inspect' ? 'inspect' : 'interact'; if (mode !== 'inspect') { highlight(null); setSelection(null); } setPierce(mode === 'inspect'); document.body.style.cursor = mode === 'inspect' ? 'crosshair' : ''; return; }
    // 父页的选中状态是事实源：选中 / 清空都同步到常驻框
    if (msg.type === 'quilt:highlight') { setSelection(msg.qid ? document.querySelector('[data-qid="' + msg.qid + '"]') : null); return; }
    // 热更新后重选：同一 qid 还在就回一份新值（检查器字段跟着刷）并把常驻框接回去，不在了让父页清空
    if (msg.type === 'quilt:reselect') {
      var el = document.querySelector('[data-qid="' + msg.qid + '"]');
      if (el) { if (mode === 'inspect') setSelection(el); send(selection(el)); } else send({ type: 'quilt:deselect', qid: msg.qid });
      return;
    }
    if (msg.type === 'quilt:mark') { applyMarks(msg); return; }
    if (msg.type !== 'quilt:swap') return;
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
      document.body.replaceWith(doc.body);
      box = null; selBox = null; selTag = null; selEl = null; marks = {}; if (mode === 'inspect') document.body.style.cursor = 'crosshair';
      restoreForms(); icons(); window.scrollTo(0, y);
    };
    var done = function () { send({ type: 'quilt:swapped', route: msg.route, title: document.title }); };
    if (document.startViewTransition) document.startViewTransition(apply).finished.then(done, done);
    else { apply(); done(); }
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('DOMContentLoaded', function () {
    icons(); restoreForms();
    if (state.__scrollY) { window.scrollTo(0, state.__scrollY); delete state.__scrollY; }
    send({ type: 'quilt:ready', title: document.title });
  });
})();`;
