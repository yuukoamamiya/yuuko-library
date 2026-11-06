import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBookCore, type Book } from '../src/lib/book.ts';
import { validateBaiduDownload } from '../src/lib/baidu.ts';
import { replaceFileAtomically } from './atomic.ts';

export const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sortedCatalog = (books: Book[]) => [...books].sort((a, b) => a.id.localeCompare(b.id, 'en'));
export const catalogDigest = (books: Book[]) => digest(canonical(sortedCatalog(books)));
const fileFor = (root: string, id: string) => path.join(root, 'catalog/books', `${id}.json`);
async function requireDirectoryOrMissing(directory: string) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`书目路径不能是链接或非目录：${directory}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function requireRegularFileOrMissing(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`书目目标不能是链接或非普通文件：${file}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function prepareCatalogDirectory(root: string, create: boolean) {
  const catalogDir = path.join(root, 'catalog'); const booksDir = path.join(catalogDir, 'books');
  await requireDirectoryOrMissing(catalogDir);
  if (create) await mkdir(catalogDir, { recursive: true });
  await requireDirectoryOrMissing(catalogDir);
  await requireDirectoryOrMissing(booksDir);
  if (create) await mkdir(booksDir, { recursive: true });
  await requireDirectoryOrMissing(booksDir);
  return booksDir;
}

export async function readCatalogBook(root: string, id: string): Promise<{ book: Book; hash: string } | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(id)) throw new Error('书籍 ID 格式无效');
  await prepareCatalogDirectory(root, false);
  await requireRegularFileOrMissing(fileFor(root, id));
  try {
    const bytes = await readFile(fileFor(root, id));
    const book: unknown = JSON.parse(bytes.toString('utf8'));
    validateBookCore(book);
    if (book.id !== id) throw new Error(`书目文件名与 ID 不一致：${id}`);
    return { book, hash: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readCatalog(root: string): Promise<Book[]> {
  const dir = await prepareCatalogDirectory(root, false);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const books: Book[] = [];
  for (const name of names.filter(value => value.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    const result = await readCatalogBook(root, id);
    if (!result) continue;
    books.push(result.book);
  }
  return books;
}

export async function writeCatalogBook(root: string, book: Book, expectedHash: string | null): Promise<string> {
  const snapshot = structuredClone(book);
  validateBookCore(snapshot);
  if (snapshot.downloads.baidu !== null) validateBaiduDownload(snapshot.downloads.baidu, snapshot.file.sha256);
  const target = fileFor(root, snapshot.id);
  await prepareCatalogDirectory(root, true);
  await requireRegularFileOrMissing(target);
  const lockPath = path.join(root, '.local/catalog', `${snapshot.id}.lock`);
  await requireDirectoryOrMissing(path.join(root, '.local'));
  await mkdir(path.join(root, '.local'), { recursive: true });
  await requireDirectoryOrMissing(path.join(root, '.local'));
  await requireDirectoryOrMissing(path.dirname(lockPath));
  await mkdir(path.dirname(lockPath), { recursive: true });
  await requireDirectoryOrMissing(path.dirname(lockPath));
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error(`${book.id}: 书目正在被更新，CAS 写入锁已存在`); }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const current = await readFile(target).then(bytes => ({ exists: true as const, bytes, hash: digest(bytes) }))
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? { exists: false as const } : Promise.reject(error));
    if ((expectedHash === null && current.exists) || (expectedHash !== null && (!current.exists || current.hash !== expectedHash))) {
      throw new Error(`${book.id}: 书目在读取后已变化，拒绝覆盖（CAS 冲突）`);
    }
    const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await requireRegularFileOrMissing(target);
    const latest = await readFile(target).then(value => ({ exists: true as const, hash: digest(value) }))
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? { exists: false as const } : Promise.reject(error));
    if ((expectedHash === null && latest.exists) || (expectedHash !== null && (!latest.exists || latest.hash !== expectedHash))) {
      throw new Error(`${book.id}: 书目在写入前已变化，拒绝覆盖（CAS 冲突）`);
    }
    await replaceFileAtomically(temp, target);
    return digest(bytes);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
