import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBookId, isIsbn13 } from '../tools/book/id.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('书籍 ID 只接受 ISBN-13 或已登记的原文标题 slug', () => {
  assert.equal(isIsbn13('9787305231148'), true);
  assert.equal(isIsbn13('9787305231149'), false);
  assert.equal(isIsbn13('978730523114'), false);
  assert.equal(isIsbn13('agrarian-class-structure'), false);
  assert.doesNotThrow(() => assertBookId('9787305231148', new Set()));
  assert.doesNotThrow(() => assertBookId('agrarian-class-structure', new Set(['agrarian-class-structure'])));
  assert.throws(() => assertBookId('book-a47f76440942', new Set()), /ISBN-13/u);
  assert.throws(() => assertBookId('invented-chinese-title', new Set()), /ISBN-13/u);
});

test('正式书目 ID 全部为 ISBN-13，例外均已登记', async () => {
  const noIsbn = new Set<string>();
  for (const entry of JSON.parse(await readFile(path.join(ROOT, 'catalog/no-isbn.json'), 'utf8'))) noIsbn.add(entry.id);
  const files = (await readdir(path.join(ROOT, 'catalog/books'))).filter(name => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const book = JSON.parse(await readFile(path.join(ROOT, 'catalog/books', file), 'utf8'));
    assert.doesNotMatch(book.id, /^book-[a-f0-9]{12}$/u, `${book.id}: 旧 hash ID`);
    assert.ok(isIsbn13(book.id) || noIsbn.has(book.id), `${book.id}: 不是 ISBN-13 且未登记`);
  }
});
