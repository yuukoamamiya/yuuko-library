import test from 'node:test';
import assert from 'node:assert/strict';

test('R2 workflow exports callable services without running the CLI', async () => {
  const { executeR2, safeMessage } = await import('../tools/r2/workflow.ts');
  assert.equal(typeof executeR2, 'function');
  assert.equal(safeMessage(new Error('ignored')), 'R2 操作失败；请检查网络、权限和本地配置');
});
