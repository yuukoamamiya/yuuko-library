import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, cp, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Book } from '../../src/lib/books.ts';
import { digest, canonical, catalogDigest, readCatalog, readCatalogBook, writeCatalogBook } from '../catalog.ts';
export { digest, canonical, sortedCatalog, catalogDigest, readCatalog } from '../catalog.ts';
import { requireCurrentPlan } from '../book/plan.ts';
import type { UploadReport } from '../r2/report.ts';

export interface UploadRecord { id: string; sha256: string; bytes: number; key: string; url: string }
export interface Release {
  schemaVersion: 2; id: string; planId: string | null; project: string; branch: string; createdAt: string;
  books: Book[]; catalog: Book[]; catalogDigest: string; indexDigest: string;
  files: Record<string, string>; digest: string;
  baseCatalogDigest: string; previousBooks: Record<string, Book | null>;
  provenance: { commit: string | null; dirty: boolean; sourceDigest: string; source: 'repository' | 'plan-overlay' };
}
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
      else if (entry.isSymbolicLink()) throw new Error(`网站输入不能包含符号链接：${name}`);
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

const SOURCE_FILES = ['astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json'];
export async function sourceDigest(directory: string): Promise<string> {
  const result: Record<string, unknown> = {};
  for (const name of ['src', 'public', 'catalog']) {
    let files: Record<string, string>;
    try { files = await inventory(path.join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = {}; else throw error; }
    if (name === 'public') delete files['release.json'];
    result[name] = files;
  }
  for (const name of SOURCE_FILES) {
    try { result[name] = digest(await readFile(path.join(directory, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') result[name] = null; else throw error; }
  }
  return digest(canonical(result));
}
async function buildInputDigest(directory: string) {
  const files: Record<string, string> = await inventory(path.join(directory, 'public')).catch((error: NodeJS.ErrnoException): Record<string, string> => { if (error.code === 'ENOENT') return {}; throw error; });
  for (const name of Object.keys(files)) if (name.startsWith('covers/') || name === 'release.json') delete files[name];
  const src = await inventory(path.join(directory, 'src')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {}; throw error; });
  const configs: Record<string, string | null> = {};
  for (const name of SOURCE_FILES) {
    try { configs[name] = digest(await readFile(path.join(directory, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') configs[name] = null; else throw error; }
  }
  return digest(canonical({ src, public: files, configs }));
}
function repositoryState(root: string) {
  let commit: string | null = null; let dirty = true;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { /* Non-Git fixtures are explicitly marked as such. */ }
  return { commit, dirty };
}
function repositoryProvenance(root: string, snapshotDigest: string, source: 'repository' | 'plan-overlay', state = repositoryState(root)) {
  return { ...state, sourceDigest: snapshotDigest, source };
}

export async function makeRelease(root: string, planId: string, reportPath: string, build: (site: string) => void): Promise<Release> {
  const startingState = repositoryState(root);
  if (!/^p-[a-f0-9-]{36}$/u.test(planId)) throw new Error('计划编号格式无效');
  const planRoot = path.join(root, '.local/plans', planId);
  const plan = await requireCurrentPlan(root, planId);
  const config = JSON.parse(await readFile(path.join(planRoot, 'site/site.config.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject ?? '') || !config.productionBranch) throw new Error('请配置 Pages 项目名和生产分支');
  const timestamp = new Date().toISOString();
  const baseline = await readCatalog(root);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as UploadReport;
  if (report.planId !== plan.id || report.reviewHash !== plan.reviewHash) throw new Error('上传报告与审核计划不匹配，请重新校验');
  const books = verifiedBooks(plan.books, report, timestamp, baseline);
  const id = `r-${randomUUID()}`; const dir = releaseDir(root, id); const site = path.join(dir, 'site');
  const frozenCode = await buildInputDigest(path.join(planRoot, 'site'));
  if (frozenCode !== await buildInputDigest(root)) throw new Error('审核计划源码或站点配置已过期，请重新 prepare');
  await mkdir(dir, { recursive: true });
  await cp(path.join(planRoot, 'site'), site, { recursive: true, filter: file => !['dist', '.astro', 'node_modules'].includes(path.basename(file)) });
  if (frozenCode !== await buildInputDigest(site)) throw new Error('复制计划时站点输入发生变化，请重新 prepare');
  await unlink(path.join(site, 'catalog/preview.json'));
  for (const book of books) await writeFile(path.join(site, 'catalog/books', `${book.id}.json`), JSON.stringify(book, null, 2) + '\n');
  return finishRelease(root, site, id, planId, config, timestamp, books, baseline, build, 'plan-overlay', startingState);
}
export async function makeSiteRelease(root: string, build: (site: string) => void): Promise<Release> {
  const startingState = repositoryState(root);
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject ?? '') || !config.productionBranch) throw new Error('请配置 Pages 项目名和生产分支');
  const before = await readCatalog(root);
  const sourceFiles = SOURCE_FILES;
  const sourceFingerprint = await sourceDigest(root);
  if (before.some(book => !book.publishedAt || !book.downloads.r2Url?.startsWith('https://'))) throw new Error('仅站点构建需要已发布的正式书目');
  const id = `r-${randomUUID()}`; const site = path.join(releaseDir(root, id), 'site');
  await mkdir(site, { recursive: true });
  for (const name of ['src', 'public', 'catalog', ...sourceFiles]) {
    await cp(path.join(root, name), path.join(site, name), { recursive: true });
  }
  if (sourceFingerprint !== await sourceDigest(root) || sourceFingerprint !== await sourceDigest(site)) throw new Error('准备期间源码或书目发生变化，请重新准备');
  await unlink(path.join(site, 'catalog/preview.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (catalogDigest(before) !== catalogDigest(await readCatalog(site)) || catalogDigest(before) !== catalogDigest(await readCatalog(root))) throw new Error('准备期间书目发生变化，请重新准备');
  return finishRelease(root, site, id, null, config, new Date().toISOString(), [], before, build, 'repository', startingState);
}
async function finishRelease(root: string, site: string, id: string, planId: string | null,
  config: { pagesProject: string; productionBranch: string }, timestamp: string, books: Book[], baseline: Book[], build: (site: string) => void, source: 'repository' | 'plan-overlay', startingState = repositoryState(root)): Promise<Release> {
  const catalog = await readCatalog(site);
  const snapshotDigest = await sourceDigest(site);
  if (JSON.stringify(repositoryState(root)) !== JSON.stringify(startingState)) throw new Error('准备期间 Git 提交或工作区状态改变，请重新准备');
  const provenance = repositoryProvenance(root, snapshotDigest, source, startingState);
  const marker = { schemaVersion: 2, releaseId: id, planId, createdAt: timestamp, provenance,
    books: catalog.length, changedBooks: books.length, catalogDigest: catalogDigest(catalog) };
  await writeFile(path.join(site, 'public/release.json'), JSON.stringify(marker, null, 2) + '\n');
  build(site);
  if (snapshotDigest !== await sourceDigest(site) || JSON.stringify(repositoryState(root)) !== JSON.stringify(startingState)) throw new Error('构建期间冻结源码或 Git 状态发生变化，发布快照无效');
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
    provenance, baseCatalogDigest: catalogDigest(baseline), previousBooks: Object.fromEntries(books.map(book => [book.id, baseline.find(old => old.id === book.id) ?? null])) };
  await writeFile(path.join(releaseDir(root, id), 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
export async function readRelease(root: string, id: string): Promise<Release> {
  const dir = releaseDir(root, id);
  const release: Release = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8'));
  const files = await inventory(path.join(dir, 'site/dist'));
  const provenance = release.provenance;
  if (!provenance || (provenance.commit !== null && !/^[a-f0-9]{40}$/u.test(provenance.commit)) || typeof provenance.dirty !== 'boolean'
    || !/^[a-f0-9]{64}$/u.test(provenance.sourceDigest ?? '') || !['repository', 'plan-overlay'].includes(provenance.source)) throw new Error('发布缺少有效源码溯源信息，请重新 prepare');
  if (await sourceDigest(path.join(dir, 'site')) !== provenance.sourceDigest) throw new Error('冻结源码已修改，停止部署');
  let marker: any;
  try { marker = JSON.parse(await readFile(path.join(dir, 'site/public/release.json'), 'utf8')); }
  catch { throw new Error('发布缺少线上 release.json 标记，请重新 prepare'); }
  if (marker.schemaVersion !== 2 || marker.releaseId !== release.id || marker.books !== release.catalog.length
    || marker.changedBooks !== release.books.length || marker.catalogDigest !== release.catalogDigest
    || canonical(marker.provenance) !== canonical(provenance)) throw new Error('本地发布标记与快照内容或源码溯源不一致');
  if (release.id !== id || release.schemaVersion !== 2 || JSON.stringify(files) !== JSON.stringify(release.files)
    || digest(JSON.stringify(files)) !== release.digest) throw new Error('发布产物被修改或缺失，停止部署');
  if (catalogDigest(await readCatalog(path.join(dir, 'site'))) !== release.catalogDigest
    || catalogDigest(release.catalog) !== release.catalogDigest
    || files['search-index.json'] !== release.indexDigest) throw new Error('全站书目快照不一致');
  if (!Array.isArray(release.books) || release.books.some(book => !release.catalog.some(item => canonical(book) === canonical(item)))) throw new Error('变更书目与全站快照不一致');
  return release;
}
export function assertDeployable(release: Release) {
  if (!release.provenance.commit || release.provenance.dirty) throw new Error('部署要求来自有效 Git 提交的 clean 工作区；当前发布标记为 dirty 或无提交号，请清理/提交后重新 prepare');
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
  const writes: { book: Book; expectedHash: string | null }[] = [];

  // Validate the complete release snapshot and every current row before copying covers or writing catalog files.
  for (const book of release.books) {
    const record: Book = JSON.parse(await readFile(path.join(site, 'catalog/books', `${book.id}.json`), 'utf8'));
    if (JSON.stringify(record) !== JSON.stringify(book)) throw new Error('发布书目快照不一致');
    const previousBooks = release.previousBooks;
    if (!previousBooks || !Object.hasOwn(previousBooks, book.id)) throw new Error(`发布缺少书目基线：${book.id}`);
    const previous = previousBooks[book.id];
    const current = await readCatalogBook(root, book.id);
    const currentBook = current?.book ?? null;
    if (canonical(currentBook) !== canonical(previous) && canonical(currentBook) !== canonical(book)) {
      throw new Error(`本地书目已被修改，停止覆盖：${book.id}`);
    }
    writes.push({ book, expectedHash: current?.hash ?? null });
    if (book.cover) {
      if (!/^\/covers\/[a-z0-9-]+\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(book.cover)) throw new Error('封面路径无效');
      const relative = `covers/${book.cover.slice('/covers/'.length)}`;
      const cover = await readFile(path.join(site, 'public', relative));
      if (digest(cover) !== release.files[relative] || digest(cover) !== path.basename(book.cover).split('.')[0]) throw new Error('封面快照不一致');
    }
  }

  // Copy and verify covers before any book can reference them.
  for (const { book } of writes) {
    if (!book.cover) continue;
    const relative = book.cover.slice(1);
    const destination = path.join(root, 'public', relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(site, 'public', relative), destination);
    if (digest(await readFile(destination)) !== path.basename(book.cover).split('.')[0]) throw new Error('正式封面复制后校验失败');
  }

  for (const { book, expectedHash } of writes) await writeCatalogBook(root, book, expectedHash);
}
