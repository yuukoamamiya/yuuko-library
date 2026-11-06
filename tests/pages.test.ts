import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifiedBooks, readRelease, inventory, digest } from '../tools/pages/release.ts';
import type { Book } from '../src/lib/books.ts';

const book: Book = { schemaVersion: 1, id: 'sample', title: '示例', authors: [], description: '', subjects: [], cover: null,
  edition: { kind: 'transcription', model: null }, file: { sha256: 'a'.repeat(64), bytes: 100, filename: 'sample.epub' },
  downloads: { r2Key: 'books/sample/file.epub', r2Url: 'https://books.example.com/file.epub', baidu: null }, publishedAt: null, updatedAt: null };
const report = { status: 'verified', expected: 1, failures: [], verified: [{ id: book.id, sha256: book.file.sha256, bytes: 100, key: book.downloads.r2Key, url: book.downloads.r2Url! }] };
test('正式书目只接受完整且一致的上传验证；保留转录本类型', () => {
  const books = verifiedBooks([book], report, '2026-11-06T00:00:00.000Z');
  assert.equal(books[0].edition.model, null); assert.equal(books[0].publishedAt, books[0].updatedAt);
  assert.throws(() => verifiedBooks([book], { ...report, status: 'failed' }, ''), /未全部/u);
  assert.throws(() => verifiedBooks([{ ...book, file: { ...book.file, bytes: 101 } }], report, ''), /不匹配/u);
});
test('发布产物被改动或含 EPUB、凭据文件时拒绝部署', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pages-release-'));
  try {
    const id = 'r-12345678-1234-1234-1234-123456789012'; const dir = path.join(root, '.local/releases', id);
    const dist = path.join(dir, 'site/dist'); await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), 'original');
    const files = await inventory(dist);
    await writeFile(path.join(dir, 'release.json'), JSON.stringify({ schemaVersion: 1, id, files, digest: digest(JSON.stringify(files)) }));
    await readRelease(root, id);
    await writeFile(path.join(dist, 'index.html'), 'changed'); await assert.rejects(readRelease(root, id), /修改/u);
    await writeFile(path.join(dist, 'file.epub'), 'not public'); await assert.rejects(inventory(dist), /EPUB/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
