import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRROR_PROVIDERS, mirrorLabel, mirrorList, validateMirror } from '../src/lib/mirrors.ts';
import type { DownloadMirror } from '../src/lib/book.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha = 'a'.repeat(64);
const baidu = (overrides: Partial<DownloadMirror> = {}): DownloadMirror => ({
  provider: 'baidu', url: 'https://pan.baidu.com/s/Abcde_12', code: 'a1b2', fileSha256: sha,
  verifiedAt: '2026-01-01T00:00:00Z',
  meta: { fsId: '1', shareId: '2', path: '/yuuko-library/file.epub', expiresAt: null }, ...overrides,
});

test('generic mirror validation accepts registered providers and rejects unknown ones', () => {
  assert.deepEqual(Object.keys(MIRROR_PROVIDERS), ['baidu']);
  assert.doesNotThrow(() => validateMirror(baidu(), sha));
  assert.throws(() => validateMirror({ ...baidu(), provider: 'unknown' }, sha), /未知下载镜像 provider/u);
  assert.throws(() => validateMirror(baidu({ fileSha256: 'b'.repeat(64) }), sha), /哈希/u);
  assert.throws(() => validateMirror(baidu({ url: 'https://evil.example/s/1' }), sha), /百度分享链接/u);
});

test('mirror labels fall back to the provider id and listing is stable by id', () => {
  assert.equal(mirrorLabel('baidu'), '百度网盘');
  assert.equal(mirrorLabel('unknown'), 'unknown');
  const mirrors = { zebra: baidu({ provider: 'zebra' }), baidu: baidu() };
  assert.deepEqual(mirrorList(mirrors).map(mirror => mirror.provider), ['baidu', 'zebra']);
});

test('mirror CLI rejects unregistered providers before forwarding', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/mirrors/cli.ts', 'status', '--provider', 'other'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知镜像 provider/u);
  assert.match(result.stderr, /baidu/u);
});
