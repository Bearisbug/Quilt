import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePolicy } from '../../../apps/api/src/lib/origin.ts';

// 来源校验（§15「本地服务」v0.75）：名单从画布 / API 地址推出，回环地址展开成 localhost / 127.0.0.1 / [::1] 三种写法、端口照抄
const dev = sourcePolicy(['http://localhost:6688', 'http://localhost:3100', 'http://localhost:3100']);

test('开发形态：Vite 代理送来的画布 Host / Origin、直连 API 的回环写法放行；不带 Origin 的客户端放行', () => {
  assert.ok(dev.allows('localhost:6688', 'http://localhost:6688'));
  assert.ok(dev.allows('127.0.0.1:6688', 'http://127.0.0.1:6688'));
  assert.ok(dev.allows('localhost:3100', undefined));
  assert.ok(dev.allows('127.0.0.1:3100', undefined));
  assert.ok(dev.allows('[::1]:3100', undefined));
  assert.ok(dev.allows('LOCALHOST:3100', undefined));
});

test('DNS 重绑：Host 是别人的域名，带不带 Origin 都拒；没有 Host 也拒', () => {
  assert.ok(!dev.allows('rebind.attacker.example:3100', undefined));
  assert.ok(!dev.allows('rebind.attacker.example:3100', 'http://rebind.attacker.example:3100'));
  assert.ok(!dev.allows(undefined, undefined));
});

test('跨站：别的站、预览域、null 的 Origin 都拒；Host 指向名单外的端口也拒', () => {
  assert.ok(!dev.allows('localhost:3100', 'http://evil.example'));
  assert.ok(!dev.allows('localhost:3100', 'null'));
  assert.ok(!dev.allows('localhost:3100', 'http://preview.localhost:3101'));
  assert.ok(!dev.allows('localhost:3100', 'http://127.0.0.1:3101'));
  assert.ok(!dev.allows('localhost:3101', undefined));
});

test('局域网地址默认拒；WEB_ORIGIN 设成它才放行，且只放行那一个地址', () => {
  assert.ok(!dev.allows('192.168.1.5:6688', 'http://192.168.1.5:6688'));
  const lan = sourcePolicy(['http://192.168.1.5:6688', 'http://localhost:3100', 'http://localhost:3100']);
  assert.ok(lan.allows('192.168.1.5:6688', 'http://192.168.1.5:6688'));
  assert.ok(!lan.allows('192.168.1.6:6688', 'http://192.168.1.6:6688'));
  assert.ok(!lan.allows('localhost:6688', undefined));
});

test('打包形态：画布与 API 同源；交给 MCP SDK 的 hosts / origins 与 allows 是同一份名单', () => {
  const pkg = sourcePolicy(['http://localhost:3100', 'http://localhost:3100', 'http://localhost:3100']);
  assert.ok(pkg.allows('localhost:3100', 'http://localhost:3100'));
  assert.ok(pkg.allows('127.0.0.1:3100', 'http://127.0.0.1:3100'));
  assert.ok(!pkg.allows('localhost:3100', 'http://127.0.0.1:3101'));
  assert.deepEqual(new Set(pkg.hosts), new Set(['localhost:3100', '127.0.0.1:3100', '[::1]:3100']));
  assert.deepEqual(new Set(pkg.origins), new Set(['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']));
});
