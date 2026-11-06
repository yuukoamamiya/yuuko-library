import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateBookCore, type Book } from './book';

/** Node-only catalog IO shared by the site renderer and maintenance tools. */
export type CatalogRecord = { book: Book; bytes: Buffer };
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/u;

async function requireDirectory(directory: string) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`书目路径不能是链接或非目录：${directory}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function requireRegularFile(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`书目目标不能是链接或非普通文件：${file}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function ensureCatalogDirectory(root: string, create = false) {
  const catalog = path.join(root, 'catalog'); const books = path.join(catalog, 'books');
  await requireDirectory(root);
  await requireDirectory(catalog);
  if (create) {
    await mkdir(catalog, { recursive: true });
  }
  await requireDirectory(catalog);
  await requireDirectory(books);
  if (create) {
    await mkdir(books, { recursive: true });
  }
  await requireDirectory(books);
  return books;
}
export async function assertCatalogTarget(root: string, id: string) {
  if (!idPattern.test(id)) throw new Error('书籍 ID 格式无效');
  const directory = await ensureCatalogDirectory(root, true);
  const file = path.join(directory, `${id}.json`);
  await requireRegularFile(file);
  return file;
}

async function readRecord(file: string, expectedId: string): Promise<CatalogRecord | null> {
  if (!idPattern.test(expectedId)) throw new Error('书籍 ID 格式无效');
  await requireRegularFile(file);
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  validateBookCore(value);
  if (value.id !== expectedId) throw new Error(`书目文件名与 ID 不一致：${expectedId}`);
  return { book: value, bytes };
}

export async function readCatalogRecord(root: string, id: string): Promise<CatalogRecord | null> {
  if (!idPattern.test(id)) throw new Error('书籍 ID 格式无效');
  const directory = await ensureCatalogDirectory(root);
  return readRecord(path.join(directory, `${id}.json`), id);
}

export async function readCatalogRecords(root: string): Promise<CatalogRecord[]> {
  const directory = await ensureCatalogDirectory(root);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const records: CatalogRecord[] = [];
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    if (!idPattern.test(id)) throw new Error(`书目文件名无效：${name}`);
    const record = await readRecord(path.join(directory, name), id);
    if (record) records.push(record);
  }
  return records;
}
