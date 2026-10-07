import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toneColor } from '../../../apps/web/src/lib/assetTone.ts';

// 素材瓦片底色（REQ-CORE-019 v0.98）：暗标志衬项目 background、亮标志衬项目 primary，拉不开亮度就交回中性底
const ofcourt = { background: '#F4F2E9', primary: '#123C2E' };

test('暗标志衬项目的浅底，亮标志衬项目的主色', () => {
  assert.equal(toneColor('dark', ofcourt), '#F4F2E9');
  assert.equal(toneColor('light', ofcourt), '#123C2E');
});

test('读不出亮度时不给底色，留给棋盘格', () => {
  assert.equal(toneColor(null, ofcourt), undefined);
});

test('项目色与标志拉不开亮度时不用，回落中性底', () => {
  // 深色模式的 background 衬不了暗标志；浅色主色（如亮黄）衬不了白标志
  assert.equal(toneColor('dark', { background: '#1A1C1E', primary: '#123C2E' }), undefined);
  assert.equal(toneColor('light', { background: '#F4F2E9', primary: '#FFD23F' }), undefined);
});

test('门槛两侧：background 亮度 0.85、primary 亮度 0.3', () => {
  // #D9D9D9 亮度 0.851，#D8D8D8 亮度 0.847；#4C4C4C 亮度 0.298，#4D4D4D 亮度 0.302
  assert.equal(toneColor('dark', { background: '#D9D9D9', primary: '#000000' }), '#D9D9D9');
  assert.equal(toneColor('dark', { background: '#D8D8D8', primary: '#000000' }), undefined);
  assert.equal(toneColor('light', { background: '#FFFFFF', primary: '#4C4C4C' }), '#4C4C4C');
  assert.equal(toneColor('light', { background: '#FFFFFF', primary: '#4D4D4D' }), undefined);
});

test('不是 #RRGGBB 的值不用', () => {
  assert.equal(toneColor('dark', { background: 'white', primary: '#123C2E' }), undefined);
  assert.equal(toneColor('light', { background: '#fff', primary: 'rgb(0,0,0)' }), undefined);
});
