import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Book } from '../src/lib/book.ts';
import { loadBooks } from '../src/lib/books.ts';
import { readCatalog, readCatalogBook, writeCatalogBook } from '../tools/catalog.ts';

const sha = 'a'.repeat(64);
function book(id = 'sample'): Book {
  return { schemaVersion: 1, id, title: '书', authors: [], description: '', subjects: [], categories: ['history'], cover: null,
    edition: { kind: 'transcription', model: null }, file: { sha256: sha, bytes: 1, filename: 'book.epub' },
    downloads: { r2Key: `books/${id}/${sha}.epub`, r2Url: null, baidu: null }, publishedAt: null, updatedAt: null };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'catalog-'));
  await mkdir(path.join(root, 'catalog/books'), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('rendering drops malformed Baidu data while raw catalog retains it', async () => {
  const t = await setup(); const pathBook = path.join(t.root, 'catalog/books/sample.json');
  try {
    const malformed = { ...book(), downloads: { ...book().downloads, baidu: { url: 'http://example.invalid' } } };
    await writeFile(pathBook, JSON.stringify(malformed));
    const raw = await readCatalog(t.root);
    assert.deepEqual(raw[0].downloads.baidu, malformed.downloads.baidu);
    const prior = process.env.BOOK_SITE_ROOT; process.env.BOOK_SITE_ROOT = t.root;
    try { assert.equal((await loadBooks())[0].downloads.baidu, null); }
    finally { if (prior === undefined) delete process.env.BOOK_SITE_ROOT; else process.env.BOOK_SITE_ROOT = prior; }
    assert.deepEqual(JSON.parse(await readFile(pathBook, 'utf8')).downloads.baidu, malformed.downloads.baidu);
  } finally { await t.cleanup(); }
});

test('catalog book reads enforce filename ID and return exact source hash', async () => {
  const t = await setup();
  try {
    const source = JSON.stringify(book()); await writeFile(path.join(t.root, 'catalog/books/sample.json'), source);
    assert.equal((await readCatalogBook(t.root, 'sample'))?.hash, (await import('node:crypto')).createHash('sha256').update(source).digest('hex'));
    await assert.rejects(readCatalogBook(t.root, '../secrets'), /ID/);
  } finally { await t.cleanup(); }
});

test('render reader rejects filename identity mismatches and linked catalog directories', async () => {
  const t = await setup(); const prior = process.env.BOOK_SITE_ROOT; process.env.BOOK_SITE_ROOT = t.root;
  try {
    await writeFile(path.join(t.root, 'catalog/books/named.json'), JSON.stringify(book('different')));
    await assert.rejects(loadBooks(), /文件名与 ID 不一致/);
    await rm(path.join(t.root, 'catalog/books'), { recursive: true });
    const outside = path.join(t.root, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(t.root, 'catalog/books'), 'junction');
    await assert.rejects(loadBooks(), /链接或非目录/);
  } finally {
    if (prior === undefined) delete process.env.BOOK_SITE_ROOT; else process.env.BOOK_SITE_ROOT = prior;
    await t.cleanup();
  }
});

test('catalog writes enforce expected hash, strict Baidu shape, and exclusive new-book creation', async () => {
  const t = await setup();
  try {
    const initial = book(); const firstHash = await writeCatalogBook(t.root, initial, null);
    await assert.rejects(writeCatalogBook(t.root, { ...initial, title: 'overwrite' }, null), /冲突/);
    await assert.rejects(writeCatalogBook(t.root, { ...initial, title: 'stale' }, 'b'.repeat(64)), /冲突/);
    const invalid = { ...initial, downloads: { ...initial.downloads, baidu: { url: 'https://example.invalid' } } } as unknown as Book;
    await assert.rejects(writeCatalogBook(t.root, invalid, firstHash), /百度/);
    const nextHash = await writeCatalogBook(t.root, { ...initial, title: '更新' }, firstHash);
    assert.notEqual(nextHash, firstHash);
    assert.equal((await readCatalogBook(t.root, 'sample'))?.book.title, '更新');
  } finally { await t.cleanup(); }
});

test('canonical same-data write preserves raw bytes and hash after checking expectedHash', async () => {
  const t = await setup();
  try {
    const target = path.join(t.root, 'catalog/books/sample.json');
    const original = JSON.stringify(book(), null, 4);
    await writeFile(target, original);
    const initial = await readCatalogBook(t.root, 'sample'); assert.ok(initial);
    const returned = await writeCatalogBook(t.root, initial.book, initial.hash);
    assert.equal(returned, initial.hash);
    assert.equal(await readFile(target, 'utf8'), original);
    await assert.rejects(writeCatalogBook(t.root, initial.book, 'f'.repeat(64)), /CAS 冲突/);
    assert.equal(await readFile(target, 'utf8'), original);
  } finally { await t.cleanup(); }
});

test('concurrent catalog CAS allows one writer and rejects the stale one', async () => {
  const t = await setup();
  try {
    const initial = book(); const hash = await writeCatalogBook(t.root, initial, null);
    const results = await Promise.allSettled([
      writeCatalogBook(t.root, { ...initial, title: 'one' }, hash),
      writeCatalogBook(t.root, { ...initial, title: 'two' }, hash),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  } finally { await t.cleanup(); }
});

test('catalog writes reject redirected directories and snapshot payloads before awaiting IO', async () => {
  const t = await setup();
  try {
    const redirected = path.join(t.root, 'outside'); await mkdir(redirected);
    await rm(path.join(t.root, 'catalog/books'), { recursive: true });
    await symlink(redirected, path.join(t.root, 'catalog/books'), 'junction');
    await assert.rejects(writeCatalogBook(t.root, book(), null), /链接或非目录/);
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(redirected)), []);
  } finally { await t.cleanup(); }
});
