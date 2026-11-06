import test from 'node:test';
import assert from 'node:assert/strict';
import { r2Settings } from '../tools/r2/config.ts';

const endpoint = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
const env = { R2_ACCESS_KEY_ID: 'local-test-id', R2_SECRET_ACCESS_KEY: 'local-test-value' };
test('R2 终结点使用账号根地址，桶名独立配置，缺失凭据时不泄漏值', () => {
  const settings = r2Settings({ r2Endpoint: endpoint, r2Bucket: 'test-books' }, env);
  assert.equal(settings.endpoint, endpoint); assert.equal(settings.bucket, 'test-books');
  for (const invalid of [endpoint + '/test-books', endpoint.replace('https:', 'http:'), 'https://example.com', endpoint + '?credential=test']) {
    assert.throws(() => r2Settings({ r2Endpoint: invalid, r2Bucket: 'test-books' }, env), /r2Endpoint/u);
  }
  assert.throws(() => r2Settings({ r2Endpoint: endpoint, r2Bucket: 'test-books' }, { R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID }),
    error => error instanceof Error && error.message.includes('R2_SECRET_ACCESS_KEY') && !error.message.includes(env.R2_ACCESS_KEY_ID));
});
