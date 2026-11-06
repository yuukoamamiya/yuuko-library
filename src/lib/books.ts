import { readCatalogRecords } from './catalog.server';
import type { Book } from './book';
import { validateBaiduDownload } from './baidu';

export { type Book, type BaiduDownload } from './book';
export const editionLabel = (book: Book) => book.edition.kind === 'transcription' ? '中文出版物转录' : book.edition.model;
export const subjectsOf = (book: Book) => book.subjects;
export const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function loadBooks(): Promise<Book[]> {
  const root = process.env.BOOK_SITE_ROOT ?? process.cwd();
  const entries = await readCatalogRecords(root);
  const books = entries.map(({ book }) => {
    const rendered = structuredClone(book);
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
