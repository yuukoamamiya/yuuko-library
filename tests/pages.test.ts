import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, cp } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifiedBooks, readRelease, inventory, digest, makeRelease, makeSiteRelease, catalogDigest, assertIndex, syncCatalog, sourceDigest, assertDeployable } from '../tools/pages/release.ts';
import { verifyRelease } from '../tools/pages/verify.ts';
import type { Book } from '../src/lib/books.ts';

const book: Book = { schemaVersion: 1, id: 'sample', title: '示例', authors: [], description: '', subjects: [], categories: ['philosophy'], cover: null,
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
    await mkdir(path.join(dir, 'site/catalog/books'), { recursive: true });
    await mkdir(path.join(dir, 'site/src'), { recursive: true }); await writeFile(path.join(dir, 'site/src/app.ts'), 'source');
    await writeFile(path.join(dist, 'search-index.json'), '[]');
    const complete = await inventory(dist);
    await mkdir(path.join(dir, 'site/public'), { recursive: true });
    const provenance = { commit: 'a'.repeat(40), dirty: true, sourceDigest: await sourceDigest(path.join(dir, 'site')), source: 'repository' };
    await writeFile(path.join(dir, 'site/public/release.json'), JSON.stringify({ schemaVersion: 2, releaseId: id, provenance, books: 0, changedBooks: 0, catalogDigest: catalogDigest([]) }));
    await writeFile(path.join(dir, 'release.json'), JSON.stringify({ schemaVersion: 2, id, provenance, files: complete, digest: digest(JSON.stringify(complete)), books: [], catalog: [], catalogDigest: catalogDigest([]), indexDigest: complete['search-index.json'] }));
    const savedRelease = await readRelease(root, id);
    assert.throws(() => assertDeployable(savedRelease), /clean 工作区/u);
    await writeFile(path.join(dir, 'site/public/release.json'), JSON.stringify({ schemaVersion: 2, releaseId: id, provenance: { ...provenance, sourceDigest: 'b'.repeat(64) }, books: 0, changedBooks: 0, catalogDigest: catalogDigest([]) }));
    await assert.rejects(readRelease(root, id), /溯源不一致/u);
    await writeFile(path.join(dir, 'site/public/release.json'), JSON.stringify({ schemaVersion: 2, releaseId: id, provenance, books: 0, changedBooks: 0, catalogDigest: catalogDigest([]) }));
    await writeFile(path.join(dist, 'index.html'), 'changed'); await assert.rejects(readRelease(root, id), /修改/u);
    await writeFile(path.join(dist, 'index.html'), 'original');
    await writeFile(path.join(dir, 'site/src/app.ts'), 'tampered'); await assert.rejects(readRelease(root, id), /源码已修改/u);
    await writeFile(path.join(dist, 'file.epub'), 'not public'); await assert.rejects(inventory(dist), /EPUB/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('同一内容重发保留时间，文件或书目变化才更新时间', () => {
  const old = { ...book, publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' };
  const same = verifiedBooks([old], report, '2026-11-06T00:00:00Z', [old])[0];
  assert.equal(same.updatedAt, old.updatedAt);
  const updated = verifiedBooks([{ ...old, title: '新书名' }], report, '2026-11-06T00:00:00Z', [old])[0];
  assert.equal(updated.publishedAt, old.publishedAt);
  assert.equal(updated.updatedAt, '2026-11-06T00:00:00Z');
  const changedFile = { ...old, file: { ...old.file, sha256: 'b'.repeat(64) } };
  const changedReport = { ...report, verified: [{ ...report.verified[0], sha256: changedFile.file.sha256 }] };
  assert.equal(verifiedBooks([changedFile], changedReport, 'new-time', [old])[0].updatedAt, 'new-time');
});

test('增量发布：65 本新增至 66 本、更新仍为 65 本；验证拒绝旧书缺失和损坏详情', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pages-incremental-'));
  const catalog = Array.from({ length: 65 }, (_, i) => ({ ...book, id: `existing-${i}`, publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
  const build = (site: string) => {
    const records: Book[] = readdirSync(path.join(site, 'catalog/books')).map(name => JSON.parse(readFileSync(path.join(site, 'catalog/books', name), 'utf8')));
    const dist = path.join(site, 'dist'); mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'release.json'), readFileSync(path.join(site, 'public/release.json')));
    writeFileSync(path.join(dist, 'index.html'), '雨宫优子图书馆');
    writeFileSync(path.join(dist, 'search-index.json'), JSON.stringify(records.map(({ id, title }) => ({ id, title }))));
    for (const record of records) {
      mkdirSync(path.join(dist, 'books', record.id), { recursive: true });
      writeFileSync(path.join(dist, 'books', record.id, 'index.html'), `<a class="download-button" href="${record.downloads.r2Url}">下载</a>`);
    }
  };
  try {
    await mkdir(path.join(root, 'catalog/books'), { recursive: true });
    const repoRoot = process.cwd();
    await cp(path.join(repoRoot, 'src'), path.join(root, 'src'), { recursive: true });
    await cp(path.join(repoRoot, 'public'), path.join(root, 'public'), { recursive: true });
    for (const name of ['astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json']) await cp(path.join(repoRoot, name), path.join(root, name));
    for (const record of catalog) await writeFile(path.join(root, 'catalog/books', `${record.id}.json`), JSON.stringify(record));
    for (const update of [false, true]) {
      const planId = update ? 'p-12345678-1234-1234-1234-123456789012' : 'p-22345678-1234-1234-1234-123456789012';
      const planRoot = path.join(root, '.local/plans', planId); const site = path.join(planRoot, 'site');
      await mkdir(path.join(site, 'public'), { recursive: true });
      await cp(path.join(root, 'src'), path.join(site, 'src'), { recursive: true });
      await cp(path.join(root, 'public'), path.join(site, 'public'), { recursive: true });
      for (const name of ['astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json']) await cp(path.join(root, name), path.join(site, name));
      await cp(path.join(root, 'catalog'), path.join(site, 'catalog'), { recursive: true });
      const change = update ? { ...catalog[0], title: '更新标题' } : book;
      await writeFile(path.join(site, 'catalog/books', `${change.id}.json`), JSON.stringify(change));
      await writeFile(path.join(site, 'catalog/preview.json'), '{}');
      await cp(path.join(root, 'site.config.json'), path.join(site, 'site.config.json'));
      await writeFile(path.join(planRoot, 'plan.json'), JSON.stringify({ id: planId, books: [change] }));
      const reportPath = path.join(root, 'report.json');
      await writeFile(reportPath, JSON.stringify({ ...report, verified: [{ ...report.verified[0], id: change.id }] }));
      const release = await makeRelease(root, planId, reportPath, build);
      assert.equal(release.catalog.length, update ? 65 : 66);
      assert.equal(release.books.length, 1);
      assert.equal(release.catalog.find(item => item.id === catalog[1].id)!.updatedAt, catalog[1].updatedAt);
      const dir = path.join(root, '.local/releases', release.id, 'site/dist');
      const marker = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8'));
      assert.equal(marker.books, update ? 65 : 66); assert.equal(marker.changedBooks, 1);
      assert.equal(marker.catalogDigest, catalogDigest(release.catalog));
      assert.equal(catalogDigest([...release.catalog].reverse()), marker.catalogDigest);
      const request = (async (input: URL | RequestInfo) => {
        const name = new URL(String(input)).pathname;
        const filename = name.endsWith('/') ? `${name}index.html` : name;
        return new Response(await readFile(path.join(dir, filename)));
      }) as typeof fetch;
      await verifyRelease(release, new URL('https://library.example/'), request);
      await syncCatalog(root, release);
      await syncCatalog(root, release);
      await writeFile(path.join(root, 'catalog/books', `${change.id}.json`), JSON.stringify({ ...change, title: '维护者的新修改' }));
      await assert.rejects(syncCatalog(root, release), /本地书目已被修改/u);
      if (update) await writeFile(path.join(root, 'catalog/books', `${change.id}.json`), JSON.stringify(catalog[0]));
      else await rm(path.join(root, 'catalog/books', `${change.id}.json`));
      assert.throws(() => assertIndex(release.catalog, release.catalog.slice(1)), /ID 集合/u);
      const indexPath = path.join(dir, 'search-index.json'); const original = await readFile(indexPath);
      await writeFile(indexPath, JSON.stringify(release.catalog.filter(item => item.id !== catalog[1].id)));
      await assert.rejects(verifyRelease(release, new URL('https://library.example/'), request), /ID 集合/u);
      await writeFile(indexPath, original);
      await writeFile(path.join(dir, 'books', catalog[1].id, 'index.html'), '损坏的旧书详情');
      await assert.rejects(verifyRelease(release, new URL('https://library.example/'), request), /详情/u);
    }
    for (const directory of ['src', 'public']) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of ['astro.config.mjs', 'package.json', 'package-lock.json', 'tsconfig.json']) await writeFile(path.join(root, file), '{}');
    await writeFile(path.join(root, 'site.config.json'), JSON.stringify({ pagesProject: 'test-library', productionBranch: 'main' }));
    const siteRelease = await makeSiteRelease(root, build);
    assert.equal(siteRelease.catalog.length, 65);
    assert.equal(siteRelease.books.length, 0);
    assert.equal(siteRelease.planId, null);
    assert.deepEqual(siteRelease.catalog.map(item => [item.id, item.publishedAt, item.updatedAt]),
      [...catalog].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(item => [item.id, item.publishedAt, item.updatedAt]));
    await readRelease(root, siteRelease.id);
    await syncCatalog(root, siteRelease);
  } finally { await rm(root, { recursive: true, force: true }); }
});
