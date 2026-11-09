import { readCatalogRecords } from './catalog.server';
import type { Book } from './book';
import { mirrorLabel, validateMirror } from './mirrors';

export { type Book, type DownloadMirror, type MirrorArchive } from './book';
export const editionLabel = (book: Book) => book.edition.kind === 'transcription' ? '中文出版物转录' : book.edition.model;
export const subjectsOf = (book: Book) => book.subjects;
export const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function loadBooks(): Promise<Book[]> {
  const root = process.env.BOOK_SITE_ROOT ?? process.cwd();
  const entries = await readCatalogRecords(root);
  const books = entries.map(({ book }) => {
    const rendered = structuredClone(book);
    for (const [provider, mirror] of Object.entries(rendered.downloads.mirrors)) {
      try { validateMirror(mirror, rendered.file.sha256); }
      catch (error) {
        console.warn(`书目 ${rendered.id} 的${mirrorLabel(provider)}下载记录无效，页面暂不显示该下载链接：${(error as Error).message}`);
        delete rendered.downloads.mirrors[provider];
      }
    }
    return rendered;
  });
  return books.sort((a, b) => (b.updatedAt ?? b.publishedAt ?? '').localeCompare(a.updatedAt ?? a.publishedAt ?? '')
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
}
