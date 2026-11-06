import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentDecision, withProjectLock, matchingDeployments, type RemoteDeployment } from '../tools/pages/deployment.ts';
import type { Release } from '../tools/pages/release.ts';

test('同一项目互斥发布，失败后释放锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pages-lock-'));
  try {
    await withProjectLock(root, 'library', async () => {
      await assert.rejects(withProjectLock(root, 'library', async () => {}), /锁定/u);
      await withProjectLock(root, 'another-library', async () => {});
    });
    await assert.rejects(withProjectLock(root, 'library', async () => { throw new Error('模拟失败'); }), /模拟失败/u);
    await withProjectLock(root, 'library', async () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('成功部署不重复提交；进行中和未知状态停止；确认失败才允许显式重试', () => {
  const remote: RemoteDeployment = { id: 'deployment', branch: 'main', message: 'Publish release', status: 'success', url: 'https://example.com' };
  assert.equal(deploymentDecision(null, [], false), 'deploy');
  assert.equal(deploymentDecision(null, [remote], true), 'verify');
  assert.equal(deploymentDecision({ status: 'published' }, [], false), 'verify');
  for (const status of ['active', 'queued', 'unknown']) {
    assert.throws(() => deploymentDecision(null, [{ ...remote, status }], true), /进行或状态未知/u);
  }
  assert.throws(() => deploymentDecision({ status: 'uncertain' }, [], true), /禁止盲目重试/u);
  assert.throws(() => deploymentDecision(null, [{ ...remote, status: 'failure' }], false), /显式重试/u);
  assert.equal(deploymentDecision({ status: 'uncertain' }, [{ ...remote, status: 'failure' }], true), 'deploy');
  assert.equal(matchingDeployments({ id: 'release', branch: 'main' } as Release,
    [remote, { ...remote, branch: 'other' }, { ...remote, message: 'Other release' }]).length, 1);
});
