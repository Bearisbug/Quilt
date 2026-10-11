import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VENDOR, vendorFileFor, withLocalVendor, buildPrelude, tokensFromSeed } from '@quilt/core';

// 屏文档的外网脚本钉死版本、用仓库里的副本（§17 v1.06）：存量修订里没钉版本的写法也要认出来，屏自己引的别的库不动
test('vendorFileFor：钉死版本与存量写法都认，带查询参数与别的库不认', () => {
  assert.equal(vendorFileFor('https://cdn.tailwindcss.com/3.4.17'), 'tailwind-play-3.4.17.js');
  assert.equal(vendorFileFor('https://cdn.tailwindcss.com'), 'tailwind-play-3.4.17.js');
  assert.equal(vendorFileFor('https://unpkg.com/lucide@latest/dist/umd/lucide.min.js'), 'lucide-1.55.0.min.js');
  assert.equal(vendorFileFor('https://unpkg.com/lucide@1.55.0/dist/umd/lucide.min.js'), 'lucide-1.55.0.min.js');
  assert.equal(vendorFileFor('https://cdn.tailwindcss.com?plugins=forms'), null);
  assert.equal(vendorFileFor('https://cdn.jsdelivr.net/npm/chart.js'), null);
});

test('prelude 写钉死版本的地址；withLocalVendor 只换这两个 <script src>', () => {
  const prelude = buildPrelude(tokensFromSeed('#3B5BDB'));
  for (const v of VENDOR) assert.ok(prelude.includes(`<script src="${v.url}"></script>`), v.url);
  const html = `<head>${prelude}<script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>`;
  const local = withLocalVendor(html);
  for (const v of VENDOR) assert.ok(local.includes(`<script src="/vendor/${v.file}"></script>`) && !local.includes(v.url), v.file);
  assert.ok(local.includes('https://cdn.jsdelivr.net/npm/chart.js'));
  const legacy = '<script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>';
  assert.equal(withLocalVendor(legacy), '<script src="/vendor/tailwind-play-3.4.17.js"></script><script src="/vendor/lucide-1.55.0.min.js"></script>');
});

test('仓库里的副本与 vendor/README.md 登记的 sha256 一致', () => {
  const dir = path.resolve(import.meta.dirname, '../../../packages/core/vendor');
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const v of VENDOR) {
    const sum = createHash('sha256').update(readFileSync(path.join(dir, v.file))).digest('hex');
    assert.ok(readme.includes(`\`${v.file}\``) && readme.includes(sum), `${v.file} ${sum}`);
  }
});
