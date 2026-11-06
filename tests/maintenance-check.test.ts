import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, verificationSteps } from '../tools/maintenance/check.ts';

test('统一验收在首个失败时停止并返回步骤、退出码', async () => {
  const visited: string[] = [];
  const result = await runChecks([['check', []], ['test', []], ['build', []]], async name => {
    visited.push(name); return { code: name === 'test' ? 23 : 0 };
  });
  assert.deepEqual(visited, ['check', 'test']);
  assert.equal(result.status, 'failed');
  assert.deepEqual((result as any).failure, { step: 'test', exitCode: 23, signal: null });
});

test('空步骤文档模式不调用 runner', async () => {
  assert.deepEqual(verificationSteps(true), []);
  const result = await runChecks(verificationSteps(true), async () => { throw new Error('must not run'); });
  assert.equal(result.status, 'passed'); assert.deepEqual((result as any).results, []);
});

test('进程信号即使未提供非零退出码也使步骤失败', async () => {
  const result = await runChecks([['build', []]], async () => ({ code: 0, signal: 'SIGTERM' }));
  assert.equal(result.status, 'failed');
  assert.equal((result as any).failure.signal, 'SIGTERM');
});
