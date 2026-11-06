import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transferBook, disposition, type ObjectStore, type ObjectHeaders } from '../tools/r2/transfer.ts';
import type { Book } from '../src/lib/books.ts';

const bytes = Buffer.from('sample EPUB bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const origin = 'https://books.example.com'; const key = `books/test-book/${hash}.epub`;
const book: Book = { schemaVersion: 1, id: 'test-book', title: '测试书籍', authors: ['作者'], subjects: [], categories: ['philosophy'], description: '', cover: null,
  edition: { kind: 'ai-translation', model: 'test model' }, file: { sha256: hash, bytes: bytes.length, filename: '中文书 (1).epub' },
  downloads: { r2Key: key, r2Url: `${origin}/${key}`, baidu: null }, publishedAt: null, updatedAt: null };
function setup(options: { remote?: ObjectHeaders; corruptPublic?: boolean; missingPublic?: boolean; ambiguousPut?: boolean } = {}) {
  let remote = options.remote ?? null; let writes = 0; let reads = 0;
  const store: ObjectStore = { async head() { return remote; }, async put(_key, _bytes, headers) {
    writes++; remote = headers; if (options.ambiguousPut) throw new Error('timeout');
  } };
  const fetcher: typeof fetch = async () => {
    reads++; assert.ok(remote, '公开 GET 必须在上传后发生');
    return new Response(options.corruptPublic ? Buffer.alloc(bytes.length) : bytes, { status: options.missingPublic ? 404 : 200,
      headers: { 'content-type': 'application/epub+zip', 'content-disposition': disposition(book.id, book.file.filename), 'content-length': String(bytes.length) } });
  };
  return { store, fetcher, counts: () => ({ writes, reads }) };
}
test('先上传再公开 GET，核验完整哈希及中文下载文件名；重试复用对象不重复上传', async () => {
  const mock = setup(); const result = await transferBook({ book, bytes, origin, ...mock });
  assert.equal(result.action, 'uploaded'); assert.equal(result.dispositionFilename, book.file.filename);
  const repeated = await transferBook({ book, bytes, origin, ...mock });
  assert.equal(repeated.action, 'reused'); assert.deepEqual(mock.counts(), { writes: 1, reads: 2 });
});
test('公开下载损坏或 404 不算验证成功；输入哈希错误时不执行远程操作', async () => {
  for (const options of [{ corruptPublic: true }, { missingPublic: true }]) {
    const mock = setup(options); await assert.rejects(transferBook({ book, bytes, origin, ...mock }), /公开下载/u);
  }
  const mock = setup(); await assert.rejects(transferBook({ book, bytes: Buffer.from('wrong'), origin, ...mock }), /快照/u);
  assert.deepEqual(mock.counts(), { writes: 0, reads: 0 });
});
test('verify 不写入，已有对象冲突不覆盖，上传响应不确定时先复查对象', async () => {
  const absent = setup(); await assert.rejects(transferBook({ book, bytes, origin, ...absent, readOnly: true }), /缺失/u);
  assert.equal(absent.counts().writes, 0);
  const conflict = setup({ remote: { bytes: bytes.length, sha256: 'wrong', contentType: 'application/epub+zip', contentDisposition: 'attachment' } });
  await assert.rejects(transferBook({ book, bytes, origin, ...conflict }), /未覆盖/u); assert.equal(conflict.counts().writes, 0);
  const ambiguous = setup({ ambiguousPut: true }); const result = await transferBook({ book, bytes, origin, ...ambiguous });
  assert.equal(result.sha256, hash); assert.equal(ambiguous.counts().writes, 1);
});
