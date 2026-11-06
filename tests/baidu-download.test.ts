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

const archive = { filename: '普兰查斯著作01.rar', sha256: 'c'.repeat(64), bytes: 12345, password: '114514' };

test('accepts a hidden-file-name RAR record with its own entity hash', () => {
  assert.doesNotThrow(() => validateBaiduDownload({ ...record, archive }, hash));
});

test('rejects unsafe or incomplete RAR metadata', () => {
  const invalid = [
    { ...archive, filename: '../普兰查斯著作01.rar' },
    { ...archive, filename: 'folder\\archive.rar' },
    { ...archive, filename: 'archive.zip' },
    { ...archive, sha256: 'bad-hash' },
    { ...archive, bytes: 0 },
    { ...archive, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...archive, password: '  ' },
    { ...archive, password: 'x'.repeat(257) },
  ];
  for (const badArchive of invalid) assert.throws(() => validateBaiduDownload({ ...record, archive: badArchive }, hash));
});
