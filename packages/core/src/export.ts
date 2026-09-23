import { colorVarsCss, type Tokens } from './tokens.ts';
import { fontFace } from './fonts.ts';

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
  var state = {};
  function snapshot() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { state[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); }
  function restore() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { if (!(el.name in state)) return; if (el.type === 'checkbox') el.checked = !!state[el.name]; else el.value = state[el.name]; }); }
  var stack = []; var layers = []; var shown = null;
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }
  function addLayer(r) {
    var layer = document.createElement('div'); layer.setAttribute('data-quilt-overlay-layer', r);
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);overflow:auto;';
    layer.appendChild(tpls[r].content.cloneNode(true));
    layer.addEventListener('click', function (e) { if (e.target === layer || e.target === layer.firstElementChild) history.back(); });
    document.body.appendChild(layer); layers.push({ route: r, el: layer });
  }
  function show() {
    var j = stack.length - 1; while (j > 0 && pres[stack[j]] === 'overlay') j--;
    var base = stack[j]; var want = stack.slice(j + 1);
    var sync = function () {
      var k = 0; while (k < layers.length && k < want.length && layers[k].route === want[k]) k++;
      while (layers.length > k) layers.pop().el.remove();
      for (; k < want.length; k++) addLayer(want[k]);
      restore(); icons(); document.title = names[stack[stack.length - 1]] || document.title;
    };
    if (base === shown) { sync(); return; }
    var apply = function () { while (layers.length) layers.pop().el.remove(); document.getElementById('quilt-root').replaceChildren(tpls[base].content.cloneNode(true)); shown = base; window.scrollTo(0, 0); sync(); };
    if (document.startViewTransition) document.startViewTransition(apply); else apply();
  }
  function render(route) {
    var r = tpls[route] ? route : start; if (!tpls[r]) return;
    if (stack.length >= 2 && stack[stack.length - 2] === r) stack.pop();
    else if (stack[stack.length - 1] !== r) stack.push(r);
    show();
  }
  document.addEventListener('input', snapshot, true);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href],[data-href]'); if (!a) return;
    var href = a.hasAttribute('href') ? (a.getAttribute('href') || '') : (a.getAttribute('data-href') || '');
    if (href.charAt(0) === '/') { e.preventDefault(); snapshot(); if (tpls[href]) location.hash = '#' + href; }
    else if (href === '#') e.preventDefault();
  });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var action = e.target && e.target.getAttribute ? (e.target.getAttribute('action') || '') : '';
    if (action.charAt(0) === '/') { snapshot(); if (tpls[action]) location.hash = '#' + action; }
  }, true);
  window.addEventListener('hashchange', function () { render(location.hash.slice(1) || start); });
  render(location.hash.slice(1) || start);
})();`;

export function buildPrototypeDocument(args: { title: string; tokens: Tokens; screens: ExportScreen[]; tailwindCss: string; lucideJs: string; startRoute?: string }): string {
  const { tokens } = args;
  const colorVars = colorVarsCss(tokens.colors);
  const radiusVars = Object.entries(tokens.radius).map(([k, v]) => `--radius-${k}:${v}`).join(';');
  const font = fontFace(tokens.typography);
  const start = args.startRoute ?? args.screens[0]?.route ?? '/';
  const templates = args.screens.map((s) => `<template data-route="${escapeAttr(s.route)}" data-name="${escapeAttr(s.name)}" data-presentation="${s.presentation ?? 'push'}">${s.body}</template>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(args.title)}</title>
${font.link}
<style>:root{${colorVars};${radiusVars}}html,body{margin:0;min-height:100%;background:var(--color-background);color:var(--color-on-background);font-family:${font.stack};-webkit-font-smoothing:antialiased}::view-transition-old(root),::view-transition-new(root){animation-duration:220ms}</style>
<style data-quilt="tailwind">${args.tailwindCss}</style>
<script>${args.lucideJs}</script>
</head>
<body data-start="${escapeAttr(start)}">
<div id="quilt-root"></div>
${templates}
<script>${EXPORT_RUNTIME}</script>
</body>
</html>
`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const escapeAttr = escapeHtml;
