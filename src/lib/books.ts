import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBookCore, type Book } from './book';
import { validateBaiduDownload } from './baidu';

export { type Book, type BaiduDownload } from './book';
export const editionLabel = (book: Book) => book.edition.kind === 'transcription' ? '中文出版物转录' : book.edition.model;
export const subjectsOf = (book: Book) => book.subjects;
export const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Read validated core catalog rows while preserving their on-disk bytes for tooling callers. */
export async function readBookFiles(root: string): Promise<{ name: string; value: unknown }[]> {
  const dir = path.join(root, 'catalog/books');
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(entries.filter(name => name.endsWith('.json')).sort().map(async name => ({ name,
    value: JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown })));
}

export async function loadBooks(): Promise<Book[]> {
  const root = process.env.BOOK_SITE_ROOT ?? process.cwd();
  const entries = await readBookFiles(root);
  const books = entries.map(({ value }) => {
    validateBookCore(value);
    const rendered = structuredClone(value);
    if (rendered.downloads.baidu !== null) {
      try { validateBaiduDownload(rendered.downloads.baidu, rendered.file.sha256); }
      catch (error) {
        console.warn(`书目 ${rendered.id} 的百度下载记录无效，页面暂不显示该下载链接：${(error as Error).message}`);
        rendered.downloads.baidu = null;
      }
    }
    return rendered;
  });
  return books.sort((a, b) => (b.updatedAt ?? b.publishedAt ?? '').localeCompare(a.updatedAt ?? a.publishedAt ?? '')
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
}
