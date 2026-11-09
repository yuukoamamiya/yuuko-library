import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { extractEpub } from '../tools/book/epub.ts';

export async function fixture(entries: Record<string, string | Buffer>) {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  Object.entries(entries).forEach(([name, data]) => zip.addBuffer(Buffer.from(data), name));
  zip.end(); return done;
}
const container = '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const metadata = '<dc:title>测试书籍 &amp; 理论</dc:title><dc:creator>作者甲</dc:creator><dc:creator>作者乙</dc:creator><dc:description>&lt;p&gt;段落一&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;段落二&lt;/p&gt;</dc:description><dc:subject> 哲学 </dc:subject><dc:subject>哲学</dc:subject>';
export async function makeEpub(filename: string, options: { metadata?: string; manifest?: string; meta?: string; extra?: Record<string, Buffer>; container?: string } = {}) {
  await writeFile(filename, await fixture({
    'META-INF/container.xml': options.container ?? container,
    'OEBPS/book.opf': `<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>${options.metadata ?? metadata}${options.meta ?? ''}</metadata><manifest>${options.manifest ?? ''}</manifest></package>`,
    ...options.extra,
  }));
}
test('EPUB 提取保留作者顺序，分类仅去重，简介转为安全的分段纯文本', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-epub-'));
  try {
    const file = path.join(dir, '中文 & 书.epub'); await makeEpub(file);
    const book = await extractEpub(file);
    assert.equal(book.title, '测试书籍 & 理论'); assert.deepEqual(book.authors, ['作者甲', '作者乙']);
    assert.deepEqual(book.subjects, ['哲学']); assert.match(book.description, /段落一\s+段落二/u);
    assert.doesNotMatch(book.description, /script|alert|<p>/u); assert.equal(book.cover, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('提取 OPF 中的 ISBN-13 和 ISBN-10 标识', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-isbn-'));
  try {
    const file = path.join(dir, 'isbn.epub');
    await makeEpub(file, { metadata: '<dc:identifier opf:scheme="ISBN">978-3-16-152185-0</dc:identifier><dc:identifier>urn:isbn:9787300340173</dc:identifier>' + metadata });
    const book = await extractEpub(file);
    assert.deepEqual([...book.isbns].sort(), ['9783161521850', '9787300340173']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('兼容 EPUB 2 cover meta 和 EPUB 3 cover-image 属性及 URI 编码路径', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-cover-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X8AAAAASUVORK5CYII=', 'base64');
  try {
    for (const version of [2, 3]) {
      const file = path.join(dir, `${version}.epub`);
      await makeEpub(file, {
        manifest: `<item id="cover" href="images/cover%20image.png" media-type="image/png" ${version === 3 ? 'properties="cover-image"' : ''}/>`,
        meta: version === 2 ? '<meta name="cover" content="cover"/>' : '', extra: { 'OEBPS/images/cover image.png': png },
      });
      const book = await extractEpub(file);
      assert.equal(book.cover?.extension, 'png'); assert.deepEqual(book.cover?.bytes, png);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('拒绝 DTD、超出 ZIP 根的封面路径和缺少标题，不输出主动内容封面', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-invalid-'));
  try {
    const file = path.join(dir, 'invalid.epub');
    await makeEpub(file, { container: '<!DOCTYPE container [<!ENTITY external SYSTEM "file:///not-read">]>' + container.replace('<?xml version="1.0"?>', '') });
    await assert.rejects(extractEpub(file), /DTD/u);
    await makeEpub(file, { metadata: '<dc:creator>作者</dc:creator>' });
    await assert.rejects(extractEpub(file), /缺少书名/u);
    await makeEpub(file, { manifest: '<item properties="cover-image" href="../../outside.png"/>' });
    await assert.rejects(extractEpub(file), /超出根目录/u);
    await makeEpub(file, { manifest: '<item properties="cover-image" href="cover.svg"/>', extra: { 'OEBPS/cover.svg': Buffer.from('<svg onload="alert(1)"/>') } });
    assert.equal((await extractEpub(file)).cover, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
