import { colorVarsCss, isDarkPalette, type Tokens } from './tokens.ts';
import { fontFace } from './fonts.ts';
import { withSurfaceStates, type SurfaceStates } from './states.ts';

// 导出单文件原型（REQ-PROTO-004 / ADR-003）：全部屏放进 <template>，hash 路由在同一文档内换 DOM，
// 与预览态同构；Tailwind 生成 CSS 与 lucide 内联，离线可开（字体/图片仍需网络，可接受）。
export type ExportScreen = { route: string; name: string; body: string; presentation?: 'push' | 'overlay' };

const EXPORT_RUNTIME = String.raw`(function () {
  var tpls = {}; var names = {}; var pres = {};
  document.querySelectorAll('template[data-route]').forEach(function (t) { var r = t.getAttribute('data-route'); tpls[r] = t; names[r] = t.getAttribute('data-name'); pres[r] = t.getAttribute('data-presentation') || 'push'; });
  // 叠层屏（v0.63）：导出版自己记一条路由栈——前进压栈、回到栈里前一条就出栈，再按栈把画面摆出来：
  // 栈里最靠上的整屏换进 #quilt-root，它上面的叠层逐层压回去。只看 hashchange 的目标判断的话，
  // 从叠层跳到整屏再后退，叠层会压在错的那一屏上，层数也会越积越多
  var start = document.body.getAttribute('data-start');
  // 嵌在别的页面里（iframe）时不碰地址栏：iframe 与宿主页共用一条会话历史，写进去的每一屏都要读者在宿主页多按一次后退。
  // 这时跳转直接按路由换屏，点遮罩的后退走自己的路由栈
  var embedded = window.top !== window;
  function go(r) { if (embedded) render(r); else location.hash = '#' + r; }
  function back() { if (!embedded) history.back(); else if (stack.length > 1) render(stack[stack.length - 2]); }
  var state = {};
  function snapshot() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { state[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); }
  function restore() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { if (!(el.name in state)) return; if (el.type === 'checkbox') el.checked = !!state[el.name]; else el.value = state[el.name]; }); }
  var stack = []; var layers = []; var shown = null;
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }
  // 模板克隆出来的脚本插进文档就执行，每次进这一屏都跑一遍：内联脚本包一层块作用域，第二次执行顶层 const/let 才不报「已声明」
  function screen(r) {
    var f = tpls[r].content.cloneNode(true);
    f.querySelectorAll('script:not([src])').forEach(function (s) { if (s.type !== 'module' && s.type !== 'application/json') s.textContent = '{\n' + s.textContent + '\n}'; });
    return f;
  }
  // 状态维度（REQ-CORE-051）：导出里一律按缺省取值显示，不带切换。端上的维度在 head 的 JSON 块里，页内的在各屏的声明块里，
  // 页内与端上重名的不生效；data-when 成立的元素才显示，事件不播
  function readJson(el) { try { return el ? JSON.parse(el.textContent || '') : null; } catch (e) { return null; } }
  function states() {
    var cur = {}; var taken = {}; var html = document.documentElement;
    var surface = readJson(document.querySelector('script[data-quilt-surface-states]'));
    ((surface && surface.dims) || []).forEach(function (d) { cur[d.key] = d.default; taken[d.key] = 1; });
    ((surface && surface.events) || []).forEach(function (e) { taken[e.key] = 1; });
    document.querySelectorAll('script[data-quilt-states]').forEach(function (s) { var p = readJson(s); ((p && p.dims) || []).forEach(function (d) { if (!taken[d.key]) cur[d.key] = d.default; }); });
    Array.prototype.slice.call(html.attributes).forEach(function (a) { if (a.name.indexOf('data-s-') === 0 && !(a.name.slice(7) in cur)) html.removeAttribute(a.name); });
    Object.keys(cur).forEach(function (k) { html.setAttribute('data-s-' + k, cur[k]); });
    document.querySelectorAll('[data-when]').forEach(function (el) {
      var on = (el.getAttribute('data-when') || '').trim().split(/\s+/).filter(Boolean).every(function (part) {
        var at = part.indexOf(':'); return part.charAt(0) !== '@' && at > 0 && part.slice(at + 1).split('|').indexOf(cur[part.slice(0, at)]) >= 0;
      });
      if (on) el.setAttribute('data-quilt-on', ''); else el.removeAttribute('data-quilt-on');
    });
  }
  function addLayer(r) {
    var layer = document.createElement('div'); layer.setAttribute('data-quilt-overlay-layer', r);
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);overflow:auto;';
    layer.appendChild(screen(r));
    layer.addEventListener('click', function (e) { if (e.target === layer || e.target === layer.firstElementChild) back(); });
    document.body.appendChild(layer); layers.push({ route: r, el: layer });
  }
  function show() {
    var j = stack.length - 1; while (j > 0 && pres[stack[j]] === 'overlay') j--;
    var base = stack[j]; var want = stack.slice(j + 1);
    var sync = function () {
      var k = 0; while (k < layers.length && k < want.length && layers[k].route === want[k]) k++;
      while (layers.length > k) layers.pop().el.remove();
      for (; k < want.length; k++) addLayer(want[k]);
      states(); restore(); icons(); document.title = names[stack[stack.length - 1]] || document.title;
    };
    if (base === shown) { sync(); return; }
    var apply = function () { while (layers.length) layers.pop().el.remove(); document.getElementById('quilt-root').replaceChildren(screen(base)); shown = base; window.scrollTo(0, 0); sync(); };
    // 原型不在视口里时浏览器不给它出帧，转场排着等，下一次换屏把它挤掉，ready 以 AbortError 拒绝；屏照常换，接住它不当错误报
    if (document.startViewTransition) document.startViewTransition(apply).ready.catch(function () {}); else apply();
  }
  function render(route) {
    var r = tpls[route] ? route : start; if (!tpls[r]) return;
    // 直接打开叠层的链接（分享、叠层开着时刷新）：先把起始屏垫在底下，叠层照常压在它上面；
    // 历史里也补一条起始屏，点遮罩的 history.back() 才回到它而不是离开这个文件
    if (!stack.length && pres[r] === 'overlay' && r !== start) { stack.push(start); if (!embedded) { history.replaceState(null, '', '#' + start); history.pushState(null, '', '#' + r); } }
    if (stack.length >= 2 && stack[stack.length - 2] === r) stack.pop();
    else if (stack[stack.length - 1] !== r) stack.push(r);
    show();
  }
  document.addEventListener('input', snapshot, true);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href],[data-href]'); if (!a) return;
    var href = a.hasAttribute('href') ? (a.getAttribute('href') || '') : (a.getAttribute('data-href') || '');
    if (href.charAt(0) === '/') { e.preventDefault(); snapshot(); if (tpls[href]) go(href); }
    else if (href === '#') e.preventDefault();
  });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var action = e.target && e.target.getAttribute ? (e.target.getAttribute('action') || '') : '';
    if (action.charAt(0) === '/') { snapshot(); if (tpls[action]) go(action); }
  }, true);
  window.addEventListener('hashchange', function () { render(location.hash.slice(1) || start); });
  render(location.hash.slice(1) || start);
})();`;

export function buildPrototypeDocument(args: { title: string; tokens: Tokens; screens: ExportScreen[]; tailwindCss: string; lucideJs: string; startRoute?: string; states?: SurfaceStates | null }): string {
  const { tokens } = args;
  const colorVars = colorVarsCss(tokens.colors);
  const radiusVars = Object.entries(tokens.radius).map(([k, v]) => `--radius-${k}:${v}`).join(';');
  const font = fontFace(tokens.typography);
  const start = args.startRoute ?? (args.screens.find((s) => s.presentation !== 'overlay') ?? args.screens[0])?.route ?? '/';
  const templates = args.screens.map((s) => `<template data-route="${escapeAttr(s.route)}" data-name="${escapeAttr(s.name)}" data-presentation="${s.presentation ?? 'push'}">${s.body}</template>`).join('\n');
  // dark: 变体按配色判（v0.89 ADR-005）：抽出来的 Tailwind CSS 是 .dark 祖先写法，暗色配色给 <html> 挂上 dark
  return withSurfaceStates(`<!doctype html>
<html lang="en"${isDarkPalette(tokens.colors) ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(args.title)}</title>
${font.lazyLink}
<style>:root{${colorVars};${radiusVars}}html,body{margin:0;min-height:100%;background:var(--color-background);color:var(--color-on-background);font-family:${font.stack};-webkit-font-smoothing:antialiased}::view-transition-old(root),::view-transition-new(root){animation-duration:220ms}[data-when]:not([data-quilt-on]){display:none!important}</style>
<style data-quilt="tailwind">${args.tailwindCss}</style>
<script>${args.lucideJs}</script>
</head>
<body data-start="${escapeAttr(start)}">
<div id="quilt-root"></div>
${templates}
<script>${EXPORT_RUNTIME}</script>
</body>
</html>
`, args.states);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const escapeAttr = escapeHtml;
