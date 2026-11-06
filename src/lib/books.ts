import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateCategories } from './categories';

export interface Book {
  schemaVersion: 1;
  id: string;
  title: string;
  authors: string[];
  description: string;
  subjects: string[];
  categories: string[];
  cover: string | null;
  edition: { kind: 'ai-translation'; model: string } | { kind: 'transcription'; model: null };
  file: { sha256: string; bytes: number; filename: string };
  downloads: { r2Key: string; r2Url: string | null; baidu: null };
  publishedAt: string | null;
  updatedAt: string | null;
}

export const editionLabel = (book: Book) => book.edition.kind === 'transcription'
  ? '中文出版物转录' : book.edition.model;
export const subjectsOf = (book: Book) => book.subjects;
export const sizeLabel = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function loadBooks(): Promise<Book[]> {
  const dir = path.resolve(process.env.BOOK_SITE_ROOT ?? process.cwd(), 'catalog/books');
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const books: Book[] = await Promise.all(entries.filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as Book));
  books.forEach(book => validateCategories(book.categories));
  return books.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
}
