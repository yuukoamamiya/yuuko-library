import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, cp, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Book } from '../../src/lib/books.ts';
import { validateCategories } from '../../src/lib/categories.ts';

export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export interface UploadRecord { id: string; sha256: string; bytes: number; key: string; url: string }
export interface Release {
  schemaVersion: 2; id: string; planId: string | null; project: string; branch: string; createdAt: string;
  books: Book[]; catalog: Book[]; catalogDigest: string; indexDigest: string;
  files: Record<string, string>; digest: string;
  baseCatalogDigest: string; previousBooks: Record<string, Book | null>;
}
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sortedCatalog = (books: Book[]) => [...books].sort((a, b) => a.id.localeCompare(b.id, 'en'));
export const catalogDigest = (books: Book[]) => digest(canonical(sortedCatalog(books)));
export function contentDigest(book: Book) {
  const { publishedAt: _published, updatedAt: _updated, ...content } = book;
  return digest(canonical(content));
}
export function verifiedBooks(books: Book[], report: { status: string; expected: number; verified: UploadRecord[]; failures: unknown[] }, timestamp: string, previous: Book[] = []): Book[] {
  if (report.status !== 'verified' || report.failures.length || report.expected !== report.verified.length) throw new Error('上传报告未全部校验通过');
  const verified = new Map(report.verified.map(item => [item.id, item]));
  if (verified.size !== report.verified.length) throw new Error('上传报告包含重复书籍');
  return books.map(book => {
    const record = verified.get(book.id);
    if (!record || record.sha256 !== book.file.sha256 || record.bytes !== book.file.bytes || record.key !== book.downloads.r2Key
      || record.url !== book.downloads.r2Url || !record.url.startsWith('https://')) throw new Error(`上传校验不匹配：${book.id}`);
    const old = previous.find(item => item.id === book.id);
    return { ...book, publishedAt: old?.publishedAt ?? book.publishedAt ?? timestamp,
      updatedAt: old && contentDigest(old) === contentDigest(book) ? old.updatedAt : timestamp };
  });
}
export async function readCatalog(site: string): Promise<Book[]> {
  const directory = path.join(site, 'catalog/books');
  const books: Book[] = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
    .map(async name => {
      const book: Book = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(book.id) || name !== `${book.id}.json`) throw new Error('书籍 ID 或文件名无效');
      validateCategories(book.categories);
      return book;
    }));
  return sortedCatalog(books);
}
export function assertIndex(catalog: Book[], index: { id: string }[]) {
  if (!Array.isArray(index) || index.length !== catalog.length || new Set(index.map(item => item.id)).size !== index.length
    || catalog.some(book => !index.some(item => item.id === book.id))) throw new Error('全站书目与索引 ID 集合不一致');
}
export async function inventory(directory: string): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        if (/\.epub$/iu.test(name) || /(^|\/)\.env/iu.test(name)) throw new Error('网站产物不能包含 EPUB 或凭据文件');
        entries.push([name, digest(await readFile(path.join(directory, name)))]);
      }
    }
  }
  await walk('');
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
export function releaseDir(root: string, id: string) {
  if (!/^r-[a-f0-9-]{36}$/u.test(id)) throw new Error('发布编号格式无效');
  return path.join(root, '.local/releases', id);
}
export async function makeRelease(root: string, planId: string, reportPath: string, build: (site: string) => void): Promise<Release> {
  if (!/^p-[a-f0-9-]{36}$/u.test(planId)) throw new Error('计划编号格式无效');
  const planRoot = path.join(root, '.local/plans', planId);
  const plan = JSON.parse(await readFile(path.join(planRoot, 'plan.json'), 'utf8')) as { id: string; books: Book[] };
  const config = JSON.parse(await readFile(path.join(planRoot, 'site/site.config.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject ?? '') || !config.productionBranch) throw new Error('请配置 Pages 项目名和生产分支');
  const timestamp = new Date().toISOString();
  const baseline = await readCatalog(root);
  const books = verifiedBooks(plan.books, JSON.parse(await readFile(reportPath, 'utf8')), timestamp, baseline);
  const id = `r-${randomUUID()}`; const dir = releaseDir(root, id); const site = path.join(dir, 'site');
  await mkdir(dir, { recursive: true });
  await cp(path.join(planRoot, 'site'), site, { recursive: true, filter: file => !['dist', '.astro', 'node_modules'].includes(path.basename(file)) });
  await unlink(path.join(site, 'catalog/preview.json'));
  for (const book of books) await writeFile(path.join(site, 'catalog/books', `${book.id}.json`), JSON.stringify(book, null, 2) + '\n');
  return finishRelease(root, site, id, planId, config, timestamp, books, baseline, build);
}
export async function makeSiteRelease(root: string, build: (site: string) => void): Promise<Release> {
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject ?? '') || !config.productionBranch) throw new Error('请配置 Pages 项目名和生产分支');
  const before = await readCatalog(root);
  const sourceFiles = ['astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json'];
  async function fingerprint(directory: string) {
    const result: Record<string, unknown> = {};
    for (const name of ['src', 'public', 'catalog']) result[name] = await inventory(path.join(directory, name));
    for (const name of sourceFiles) result[name] = digest(await readFile(path.join(directory, name)));
    return digest(canonical(result));
  }
  const sourceDigest = await fingerprint(root);
  if (before.some(book => !book.publishedAt || !book.downloads.r2Url?.startsWith('https://'))) throw new Error('仅站点构建需要已发布的正式书目');
  const id = `r-${randomUUID()}`; const site = path.join(releaseDir(root, id), 'site');
  await mkdir(site, { recursive: true });
  for (const name of ['src', 'public', 'catalog', ...sourceFiles]) {
    await cp(path.join(root, name), path.join(site, name), { recursive: true });
  }
  if (sourceDigest !== await fingerprint(root) || sourceDigest !== await fingerprint(site)) throw new Error('准备期间源码或书目发生变化，请重新准备');
  await unlink(path.join(site, 'catalog/preview.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (catalogDigest(before) !== catalogDigest(await readCatalog(site)) || catalogDigest(before) !== catalogDigest(await readCatalog(root))) throw new Error('准备期间书目发生变化，请重新准备');
  return finishRelease(root, site, id, null, config, new Date().toISOString(), [], before, build);
}
async function finishRelease(root: string, site: string, id: string, planId: string | null,
  config: { pagesProject: string; productionBranch: string }, timestamp: string, books: Book[], baseline: Book[], build: (site: string) => void): Promise<Release> {
  const catalog = await readCatalog(site);
  const marker = { schemaVersion: 2, releaseId: id, planId, createdAt: timestamp,
    books: catalog.length, changedBooks: books.length, catalogDigest: catalogDigest(catalog) };
  await writeFile(path.join(site, 'public/release.json'), JSON.stringify(marker, null, 2) + '\n');
  build(site);
  const files = await inventory(path.join(site, 'dist'));
  const indexBytes = await readFile(path.join(site, 'dist/search-index.json'));
  const index = JSON.parse(indexBytes.toString('utf8')) as { id: string }[];
  assertIndex(catalog, index);
  for (const book of catalog) {
    const html = await readFile(path.join(site, 'dist/books', book.id, 'index.html'), 'utf8');
    if (!index.some(item => item.id === book.id) || !html.includes('class="download-button"') || !html.includes(book.downloads.r2Url!)
      || html.includes('下载将在发布后开放') || html.includes('noindex, nofollow')) throw new Error(`正式页面校验失败：${book.id}`);
  }
  const release: Release = { schemaVersion: 2, id, planId, project: config.pagesProject, branch: config.productionBranch,
    createdAt: timestamp, books, catalog, catalogDigest: marker.catalogDigest, indexDigest: digest(indexBytes), files, digest: digest(JSON.stringify(files)),
    baseCatalogDigest: catalogDigest(baseline), previousBooks: Object.fromEntries(books.map(book => [book.id, baseline.find(old => old.id === book.id) ?? null])) };
  await writeFile(path.join(releaseDir(root, id), 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
export async function readRelease(root: string, id: string): Promise<Release> {
  const dir = releaseDir(root, id);
  const release: Release = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8'));
  const files = await inventory(path.join(dir, 'site/dist'));
  if (release.id !== id || release.schemaVersion !== 2 || JSON.stringify(files) !== JSON.stringify(release.files)
    || digest(JSON.stringify(files)) !== release.digest) throw new Error('发布产物被修改或缺失，停止部署');
  if (catalogDigest(await readCatalog(path.join(dir, 'site'))) !== release.catalogDigest
    || catalogDigest(release.catalog) !== release.catalogDigest
    || files['search-index.json'] !== release.indexDigest) throw new Error('全站书目快照不一致');
  if (!Array.isArray(release.books) || release.books.some(book => !release.catalog.some(item => canonical(book) === canonical(item)))) throw new Error('变更书目与全站快照不一致');
  return release;
}
export async function assertCatalogSyncable(root: string, release: Release) {
  const current = await readCatalog(root);
  const projected = new Map(current.map(book => [book.id, book]));
  for (const book of release.books) {
    const old = release.previousBooks[book.id];
    const now = projected.get(book.id) ?? null;
    if (canonical(now) !== canonical(old) && canonical(now) !== canonical(book)) throw new Error(`本地书目已被修改，停止覆盖：${book.id}`);
    if (old) projected.set(book.id, old); else projected.delete(book.id);
  }
  if (catalogDigest([...projected.values()]) !== release.baseCatalogDigest) throw new Error('本地全站书目已变化；停止发布或同步，请重新准备或核对冲突');
}
export async function syncCatalog(root: string, release: Release) {
  const site = path.join(releaseDir(root, release.id), 'site');
  await assertCatalogSyncable(root, release);
  // Check every source before the first write, so a bad later book cannot cause partial replacement.
  for (const book of release.books) {
    const record: Book = JSON.parse(await readFile(path.join(site, 'catalog/books', `${book.id}.json`), 'utf8'));
    if (JSON.stringify(record) !== JSON.stringify(book)) throw new Error('发布书目快照不一致');
    if (book.cover) {
      if (!/^\/covers\/[a-z0-9-]+\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(book.cover)) throw new Error('封面路径无效');
      const relative = `covers/${book.cover.slice('/covers/'.length)}`;
      if (digest(await readFile(path.join(site, 'public', relative))) !== release.files[relative]) throw new Error('封面快照不一致');
    }
  }
  for (const book of release.books) {
    const target = path.join(root, 'catalog/books', `${book.id}.json`);
    await writeFile(target + '.tmp', JSON.stringify(book, null, 2) + '\n'); await rename(target + '.tmp', target);
    if (book.cover) {
      if (!/^\/covers\/[a-z0-9-]+\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(book.cover)) throw new Error('封面路径无效');
      const destination = path.join(root, 'public', book.cover.slice(1));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(site, 'public', book.cover.slice(1)), destination);
    }
  }
}
