import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book } from '../src/lib/book.ts';
import { buildRss, escapeXml } from '../src/lib/rss.ts';

const makeBook = (id: string, title: string, publishedAt: string | null, extra: Partial<Book> = {}): Book => ({
  schemaVersion: 1, id, title, authors: ['作者 & 合著'], description: `简介 <${title}>`, subjects: [], categories: ['history'],
  cover: null, edition: { kind: 'transcription', model: null }, file: { sha256: 'a'.repeat(64), bytes: 1, filename: `${id}.epub` },
  downloads: { r2Key: `books/${id}/a.epub`, r2Url: null, baidu: null }, publishedAt, updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

test('RSS escapes XML metacharacters', () => {
  assert.equal(escapeXml(`A & B < C > D "E" 'F'`), 'A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;');
});

test('RSS orders by upload date, skips unpublished books and uses absolute links', () => {
  const xml = buildRss([
    makeBook('older', '旧书 & 卷', '2024-01-01T00:00:00.000Z'),
    makeBook('newer', '新书', '2025-01-01T00:00:00.000Z'),
    makeBook('draft', '未发布', null),
  ], { siteUrl: 'https://example.com/', title: '书架 & 新书', description: '仅供学习' });

  assert.match(xml, /<title>书架 &amp; 新书<\/title>/u);
  assert.match(xml, /<link>https:\/\/example\.com\/<\/link>/u);
  assert.match(xml, /<atom:link href="https:\/\/example\.com\/rss\.xml"/u);
  assert.ok(xml.indexOf('新书</title>') < xml.indexOf('旧书 &amp; 卷</title>'));
  assert.match(xml, /<link>https:\/\/example\.com\/books\/newer\/<\/link>/u);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/example\.com\/books\/newer\/<\/guid>/u);
  assert.match(xml, /<dc:creator>作者 &amp; 合著<\/dc:creator>/u);
  assert.match(xml, /<description>简介 &lt;新书&gt;<\/description>/u);
  assert.doesNotMatch(xml, /draft/u);
  assert.match(xml, new RegExp(`<lastBuildDate>${new Date('2025-01-01T00:00:00.000Z').toUTCString()}</lastBuildDate>`, 'u'));
});
