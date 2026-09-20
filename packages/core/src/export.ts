import { kebab, type Tokens } from './tokens.ts';
import { fontFace } from './fonts.ts';

// 导出单文件原型（REQ-PROTO-004 / ADR-003）：全部屏放进 <template>，hash 路由在同一文档内换 DOM，
// 与预览态同构；Tailwind 生成 CSS 与 lucide 内联，离线可开（字体/图片仍需网络，可接受）。
export type ExportScreen = { route: string; name: string; body: string };

const EXPORT_RUNTIME = String.raw`(function () {
  var tpls = {}; var names = {};
  document.querySelectorAll('template[data-route]').forEach(function (t) { tpls[t.getAttribute('data-route')] = t; names[t.getAttribute('data-route')] = t.getAttribute('data-name'); });
  var start = document.body.getAttribute('data-start');
  var state = {};
  function snapshot() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { state[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); }
  function restore() { document.querySelectorAll('input[name],textarea[name],select[name]').forEach(function (el) { if (!(el.name in state)) return; if (el.type === 'checkbox') el.checked = !!state[el.name]; else el.value = state[el.name]; }); }
  function render(route) {
    var t = tpls[route] || tpls[start]; if (!t) return;
    var root = document.getElementById('quilt-root');
    var apply = function () { root.replaceChildren(t.content.cloneNode(true)); restore(); if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); window.scrollTo(0, 0); document.title = names[route] || document.title; };
    if (document.startViewTransition) document.startViewTransition(apply); else apply();
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
  const colorVars = Object.entries(tokens.colors).map(([k, v]) => `--color-${kebab(k)}:${v}`).join(';');
  const radiusVars = Object.entries(tokens.radius).map(([k, v]) => `--radius-${k}:${v}`).join(';');
  const font = fontFace(tokens.typography);
  const start = args.startRoute ?? args.screens[0]?.route ?? '/';
  const templates = args.screens.map((s) => `<template data-route="${escapeAttr(s.route)}" data-name="${escapeAttr(s.name)}">${s.body}</template>`).join('\n');
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
