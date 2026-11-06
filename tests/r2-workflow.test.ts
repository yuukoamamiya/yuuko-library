import test from 'node:test';
import assert from 'node:assert/strict';

test('R2 workflow exports callable services without running the CLI', async () => {
  const { executeR2, safeMessage } = await import('../tools/r2/workflow.ts');
  assert.equal(typeof executeR2, 'function');
  assert.equal(safeMessage(new Error('ignored')), 'R2 操作失败；请检查网络、权限和本地配置');
  await assert.rejects(executeR2('D:/missing-workspace', 'nonsense'), /命令无效/u);
});

test('shared upload report contract rejects invalid schema, command, status, counts, and IDs', async () => {
  const { validateUploadReport } = await import('../tools/r2/report.ts');
  const expected = { planId: 'p-id', reviewHash: 'a'.repeat(64), bookIds: ['one'] };
  const good = { schemaVersion: 1, command: 'upload', planId: expected.planId, reviewHash: expected.reviewHash,
    bucket: 'books', origin: 'https://books.example', startedAt: 'now', finishedAt: 'now', status: 'verified',
    expected: 1, verified: [{ id: 'one' }], failures: [] };
  assert.equal(validateUploadReport(good, expected).status, 'verified');
  for (const value of [
    { ...good, schemaVersion: 2 },
    { ...good, command: 'check' },
    { ...good, status: 'running' },
    { ...good, expected: 2 },
    { ...good, verified: [{ id: 'other' }] },
    { ...good, verified: [{ id: 'one' }, { id: 'one' }], expected: 2 },
    { ...good, failures: [{ id: 'one', message: 'failed' }] },
  ]) assert.throws(() => validateUploadReport(value, expected));
});
