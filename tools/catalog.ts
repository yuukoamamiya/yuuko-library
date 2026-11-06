import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBookCore, type Book } from '../src/lib/book.ts';
import { validateBaiduDownload } from '../src/lib/baidu.ts';
import { replaceFileAtomically } from './atomic.ts';
import { assertCatalogTarget, readCatalogRecord, readCatalogRecords } from '../src/lib/catalog.server.ts';

export const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sortedCatalog = (books: Book[]) => [...books].sort((a, b) => a.id.localeCompare(b.id, 'en'));
export const catalogDigest = (books: Book[]) => digest(canonical(sortedCatalog(books)));
export const isCatalogCasConflict = (error: unknown) => error instanceof Error && /CAS 冲突/u.test(error.message);
export async function readCatalogBook(root: string, id: string): Promise<{ book: Book; hash: string } | null> {
  const record = await readCatalogRecord(root, id);
  return record ? { book: record.book, hash: digest(record.bytes) } : null;
}

export async function readCatalog(root: string): Promise<Book[]> {
  return sortedCatalog((await readCatalogRecords(root)).map(record => record.book));
}

export async function writeCatalogBook(root: string, book: Book, expectedHash: string | null): Promise<string> {
  const snapshot = structuredClone(book);
  validateBookCore(snapshot);
  if (snapshot.downloads.baidu !== null) validateBaiduDownload(snapshot.downloads.baidu, snapshot.file.sha256);
  const target = await assertCatalogTarget(root, snapshot.id);
  const lockPath = path.join(root, '.local/catalog', `${snapshot.id}.lock`);
  await mkdir(path.join(root, '.local'), { recursive: true });
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error(`${book.id}: 书目正在被更新，CAS 写入锁已存在`); }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const current = await readCatalogRecord(root, snapshot.id);
    if ((expectedHash === null && current) || (expectedHash !== null && (!current || digest(current.bytes) !== expectedHash))) {
      throw new Error(`${book.id}: 书目在读取后已变化，拒绝覆盖（CAS 冲突）`);
    }
    if (current && canonical(current.book) === canonical(snapshot)) return digest(current.bytes);
    const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await replaceFileAtomically(temp, target, async (source, destination) => {
      await assertCatalogTarget(root, snapshot.id);
      const latest = await readCatalogRecord(root, snapshot.id);
      if ((expectedHash === null && latest) || (expectedHash !== null && (!latest || digest(latest.bytes) !== expectedHash))) {
        throw new Error(`${book.id}: 书目在写入前已变化，拒绝覆盖（CAS 冲突）`);
      }
      await rename(source, destination);
    });
    return digest(bytes);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
