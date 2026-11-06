import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBaiduDownload } from '../src/lib/baidu.ts';

const hash = 'a'.repeat(64);
const record = {
  url: 'https://pan.baidu.com/s/1Abc_XyZ', code: 'a1B2', fileSha256: hash,
  fsId: '123456789', shareId: '987654321', path: '/ebook/example.epub',
  expiresAt: null, verifiedAt: '2026-11-06T12:00:00.000Z',
};

test('accepts a permanent verified share bound to the current EPUB hash', () => {
  assert.doesNotThrow(() => validateBaiduDownload(record, hash));
});

test('rejects a share record after the EPUB hash changes', () => {
  assert.throws(() => validateBaiduDownload(record, 'b'.repeat(64)), /不匹配/u);
});

test('rejects account tokens, arbitrary domains, and non-HTTPS URLs', () => {
  for (const url of [
    'https://evil.example/s/1Abc_XyZ',
    'http://pan.baidu.com/s/1Abc_XyZ',
    'https://pan.baidu.com/s/1Abc_XyZ?access_token=secret',
    'https://pan.baidu.com.evil.example/s/1Abc_XyZ',
  ]) assert.throws(() => validateBaiduDownload({ ...record, url }, hash), /百度分享链接/u);
});

test('rejects invalid extraction codes and expiring shares', () => {
  assert.throws(() => validateBaiduDownload({ ...record, code: '１２３４' }, hash), /提取码/u);
  assert.throws(() => validateBaiduDownload({ ...record, expiresAt: '2026-11-13T12:00:00Z' }, hash), /永久/u);
});
