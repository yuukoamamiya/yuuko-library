import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, cp, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Book } from '../../src/lib/books.ts';

export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export interface UploadRecord { id: string; sha256: string; bytes: number; key: string; url: string }
export interface Release {
  schemaVersion: 1; id: string; planId: string; project: string; branch: string; createdAt: string;
  books: Book[]; files: Record<string, string>; digest: string;
}
export function verifiedBooks(books: Book[], report: { status: string; expected: number; verified: UploadRecord[]; failures: unknown[] }, timestamp: string): Book[] {
  if (report.status !== 'verified' || report.failures.length || report.expected !== report.verified.length) throw new Error('上传报告未全部校验通过');
  const verified = new Map(report.verified.map(item => [item.id, item]));
  if (verified.size !== report.verified.length) throw new Error('上传报告包含重复书籍');
  return books.map(book => {
    const record = verified.get(book.id);
    if (!record || record.sha256 !== book.file.sha256 || record.bytes !== book.file.bytes || record.key !== book.downloads.r2Key
      || record.url !== book.downloads.r2Url || !record.url.startsWith('https://')) throw new Error(`上传校验不匹配：${book.id}`);
    return { ...book, publishedAt: book.publishedAt ?? timestamp, updatedAt: timestamp };
  });
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
  const books = verifiedBooks(plan.books, JSON.parse(await readFile(reportPath, 'utf8')), timestamp);
  const id = `r-${randomUUID()}`; const dir = releaseDir(root, id); const site = path.join(dir, 'site');
  await mkdir(dir, { recursive: true });
  await cp(path.join(planRoot, 'site'), site, { recursive: true, filter: file => !['dist', '.astro', 'node_modules'].includes(path.basename(file)) });
  await unlink(path.join(site, 'catalog/preview.json'));
  for (const book of books) await writeFile(path.join(site, 'catalog/books', `${book.id}.json`), JSON.stringify(book, null, 2) + '\n');
  const marker = { releaseId: id, planId, books: books.length, catalogDigest: digest(JSON.stringify(books)) };
  await writeFile(path.join(site, 'public/release.json'), JSON.stringify(marker, null, 2) + '\n');
  build(site);
  const files = await inventory(path.join(site, 'dist'));
  const index = JSON.parse(await readFile(path.join(site, 'dist/search-index.json'), 'utf8')) as { id: string }[];
  if (index.length !== (await readdir(path.join(site, 'catalog/books'))).filter(name => name.endsWith('.json')).length) throw new Error('书目与索引数量不一致');
  for (const book of books) {
    const html = await readFile(path.join(site, 'dist/books', book.id, 'index.html'), 'utf8');
    if (!index.some(item => item.id === book.id) || !html.includes('class="download-button"') || !html.includes(book.downloads.r2Url!)
      || html.includes('下载将在发布后开放') || html.includes('noindex, nofollow')) throw new Error(`正式页面校验失败：${book.id}`);
  }
  const release: Release = { schemaVersion: 1, id, planId, project: config.pagesProject, branch: config.productionBranch,
    createdAt: timestamp, books, files, digest: digest(JSON.stringify(files)) };
  await writeFile(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
export async function readRelease(root: string, id: string): Promise<Release> {
  const dir = releaseDir(root, id);
  const release: Release = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8'));
  const files = await inventory(path.join(dir, 'site/dist'));
  if (release.id !== id || release.schemaVersion !== 1 || JSON.stringify(files) !== JSON.stringify(release.files)
    || digest(JSON.stringify(files)) !== release.digest) throw new Error('发布产物被修改或缺失，停止部署');
  return release;
}
export async function syncCatalog(root: string, release: Release) {
  const site = path.join(releaseDir(root, release.id), 'site');
  for (const book of release.books) {
    const target = path.join(root, 'catalog/books', `${book.id}.json`);
    const record: Book = JSON.parse(await readFile(path.join(site, 'catalog/books', `${book.id}.json`), 'utf8'));
    if (JSON.stringify(record) !== JSON.stringify(book)) throw new Error('发布书目快照不一致');
    await writeFile(target + '.tmp', JSON.stringify(book, null, 2) + '\n'); await rename(target + '.tmp', target);
    if (book.cover) {
      if (!/^\/covers\/[a-z0-9-]+\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(book.cover)) throw new Error('封面路径无效');
      const destination = path.join(root, 'public', book.cover.slice(1));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(site, 'public', book.cover.slice(1)), destination);
    }
  }
}
