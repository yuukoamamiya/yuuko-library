import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadBooks, type Book } from '../src/lib/books.ts';
import { matches } from '../src/lib/search.ts';
import { validateCategories } from '../src/lib/categories.ts';

const entry = { id: 'example', title: '资本主义的起源：长远视角', authors: ['Ellen Meiksins Wood'], description: '历史与社会关系。', subjects: ['政治经济学'], categories: ['political-economy', 'history'] };
test('中文、作者、多词交集和分类组合搜索', () => {
  assert.equal(matches(entry, '资本 起源'), true);
  assert.equal(matches(entry, 'ＥＬＬＥＮ wood'), true);
  assert.equal(matches(entry, '社会', '政治经济学'), true);
  assert.equal(matches(entry, '社会', '哲学'), false);
  assert.equal(matches(entry, 'wood 不存在'), false);
  assert.equal(matches(entry, 'gemini'), false);
  assert.equal(matches({ ...entry, subjects: [] }, '', '未分类'), false);
});
test('分类与原始标签独立，关键词、分类、标签取交集', () => {
  assert.equal(matches(entry, 'wood', '政治经济学', 'history'), true);
  assert.equal(matches(entry, 'wood', '政治经济学', 'philosophy'), false);
  assert.equal(matches(entry, 'wood', '不存在', 'history'), false);
  assert.equal(matches(entry, '', '', 'political-economy'), true);
  assert.equal(matches({ ...entry, subjects: [] }, '', '', 'history'), true);
  assert.equal(matches(entry, 'history'), false);
  assert.doesNotThrow(() => validateCategories(['history', 'political-economy']));
  for (const categories of [[], ['unknown'], ['history', 'history'], ['history', 'political-economy', 'philosophy'], 'history']) {
    assert.throws(() => validateCategories(categories), /分类/u);
  }
});

test('loadBooks orders by updatedAt, falls back to publishedAt, then title and ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-sort-'));
  const previousRoot = process.env.BOOK_SITE_ROOT;
  const dir = path.join(root, 'catalog/books');
  const makeBook = (id: string, title: string, publishedAt: string | null, updatedAt?: string): Book => ({
    schemaVersion: 1, id, title, authors: [], description: '', subjects: [], categories: ['history'], cover: null,
    edition: { kind: 'transcription', model: null }, file: { sha256: 'a'.repeat(64), bytes: 1, filename: `${id}.epub` },
    downloads: { r2Key: `books/${id}/a.epub`, r2Url: null, baidu: null }, publishedAt, updatedAt: updatedAt ?? null,
  });
  try {
    await mkdir(dir, { recursive: true });
    const books = [
      makeBook('old-book', 'Zeta', '2018-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      makeBook('tie-title', 'Alpha', '2020-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      makeBook('tie-id-z', 'Same', '2020-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      makeBook('tie-id-a', 'Same', '2020-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      makeBook('new-book', 'New', '2024-01-01T00:00:00.000Z'),
      makeBook('no-time', 'No time', null),
    ];
    for (const book of books) {
      const record: Partial<Book> = { ...book };
      if (book.id === 'new-book') delete record.updatedAt;
      await writeFile(path.join(dir, `${book.id}.json`), JSON.stringify(record));
    }
    process.env.BOOK_SITE_ROOT = root;
    assert.deepEqual((await loadBooks()).map(book => book.id), ['tie-title', 'tie-id-a', 'tie-id-z', 'old-book', 'new-book', 'no-time']);
  } finally {
    if (previousRoot === undefined) delete process.env.BOOK_SITE_ROOT;
    else process.env.BOOK_SITE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
