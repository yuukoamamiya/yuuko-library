import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function cli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'tools/maintenance/cli.ts', ...args], { cwd: root, encoding: 'utf8' });
}

test('maintenance help documents default mirror checking and the explicit skip flags', () => {
  const result = cli('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--skip-provider/u);
  assert.match(result.stdout, /--skip-baidu/u);
  assert.match(result.stdout, /默认也检查网盘镜像/u);
});

test('skip flags are accepted only for health and validated before any network request', () => {
  for (const flag of ['--skip-baidu', ['--skip-provider', 'baidu']]) {
    const accepted = cli('health', ...(Array.isArray(flag) ? flag : [flag]), '--book', 'not-a-real-book');
    assert.notEqual(accepted.status, 0);
    assert.match(accepted.stderr, /--book 未匹配/u);
    assert.doesNotMatch(accepted.stderr, /未知选项|Unknown option/u);
    const misplaced = cli('cleanup-preview', ...(Array.isArray(flag) ? flag : [flag]));
    assert.notEqual(misplaced.status, 0);
    assert.match(misplaced.stderr, /仅用于 health/u);
  }
});
