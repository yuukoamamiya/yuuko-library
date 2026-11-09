import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import type { Book } from '../src/lib/book.ts';
import { prepareBooks } from '../tools/book/workflow.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function makeEpub(title: string) {
  const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve());
    zip.outputStream.on('error', reject);
  });
  zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
  zip.addBuffer(Buffer.from(`<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title><dc:creator>作者</dc:creator><dc:description>简介</dc:description></metadata></package>`), 'book.opf');
  zip.end(); await done; return Buffer.concat(chunks);
}

test('prepare with an unchanged EPUB preserves existing download mirrors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mirror-prepare-'));
  const nodeModules = path.join(root, 'node_modules');
  try {
    for (const name of ['src', 'tools', 'astro.config.mjs', 'tsconfig.json', 'package.json', 'package-lock.json', 'site.config.json']) {
      await cp(path.join(ROOT, name), path.join(root, name), { recursive: true });
    }
    await mkdir(path.join(root, 'public'), { recursive: true });
    await mkdir(path.join(root, 'catalog/books'), { recursive: true });
    await writeFile(path.join(root, 'catalog/no-isbn.json'), '[]');

    const epub = await makeEpub('镜像保留测试');
    const sha = sha256(epub); const id = '9780000000002'; const filename = '镜像保留测试.epub';
    const mirror = {
      provider: 'baidu', url: 'https://pan.baidu.com/s/Abcde_12', code: 'a1b2', fileSha256: sha,
      verifiedAt: '2026-01-01T00:00:00Z',
      meta: { fsId: '1', shareId: '2', path: `/yuuko-library/books/${id}/${sha}/${filename}`, expiresAt: null },
    };
    const book: Book = {
      schemaVersion: 1, id, title: '镜像保留测试', authors: ['作者'], description: '简介', subjects: [], categories: ['history'],
      cover: null, edition: { kind: 'ai-translation', model: '模型' }, file: { sha256: sha, bytes: epub.length, filename },
      downloads: { r2Key: `books/${id}/${sha}.epub`, r2Url: null, mirrors: { baidu: mirror } },
      publishedAt: null, updatedAt: null,
    };
    await writeFile(path.join(root, 'catalog/books', `${id}.json`), JSON.stringify(book));
    const input = path.join(root, 'input.epub'); await writeFile(input, epub);
    await symlink(path.join(ROOT, 'node_modules'), nodeModules, 'junction');

    const plan = await prepareBooks(root, [{ id, epub: input, model: '模型', update: true }], () => {});
    assert.deepEqual(plan.books[0].downloads.mirrors, { baidu: mirror });
    assert.ok(!plan.changes[0].warnings.some(warning => /网盘/u.test(warning)));
    assert.ok(plan.changes[0].warnings.some(warning => /未包含 ISBN/u.test(warning)));
    const siteBook = JSON.parse(await readFile(path.join(root, '.local/plans', plan.id, 'site/catalog/books', `${id}.json`), 'utf8')) as Book;
    assert.deepEqual(siteBook.downloads.mirrors, { baidu: mirror });
  } finally {
    await unlink(nodeModules).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
