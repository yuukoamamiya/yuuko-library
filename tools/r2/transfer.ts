import { createHash } from 'node:crypto';
import type { Book } from '../../src/lib/books.ts';

export class TransferError extends Error {}
export interface ObjectHeaders {
  bytes: number;
  sha256: string;
  contentType: string;
  contentDisposition: string;
}
export interface ObjectStore {
  head(key: string): Promise<ObjectHeaders | null>;
  put(key: string, bytes: Buffer, headers: ObjectHeaders): Promise<void>;
}
export interface Verification {
  id: string; title: string; key: string; url: string; bytes: number; sha256: string;
  contentType: string; contentDisposition: string; dispositionFilename: string;
  action: 'uploaded' | 'reused'; verifiedAt: string;
}
export function downloadOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new TransferError('请先配置公开下载域名 downloadsUrl');
  let url: URL;
  try { url = new URL(value); } catch { throw new TransferError('公开下载域名格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new TransferError('downloadsUrl 必须为不带路径或凭据的 HTTPS 域名');
  }
  return url.origin;
}
export function disposition(id: string, filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${id}.epub"; filename*=UTF-8''${encoded}`;
}
export function assertHeaders(actual: ObjectHeaders, expected: ObjectHeaders) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256
    || actual.contentType !== expected.contentType || actual.contentDisposition !== expected.contentDisposition) {
    throw new TransferError('远端对象的大小、哈希元数据或下载响应头不匹配；未覆盖该对象');
  }
}
export async function transferBook(options: {
  book: Book; bytes: Buffer; origin: string; store: ObjectStore;
  readOnly?: boolean; fetcher?: typeof fetch;
}): Promise<Verification> {
  const { book, bytes, store } = options;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(book.id) || !/^[a-f0-9]{64}$/u.test(book.file.sha256)) {
    throw new TransferError('书籍 ID 或 SHA-256 无效');
  }
  const key = `books/${book.id}/${book.file.sha256}.epub`;
  if (book.downloads.r2Key !== key || bytes.length !== book.file.bytes
    || createHash('sha256').update(bytes).digest('hex') !== book.file.sha256) {
    throw new TransferError('输入快照与书目文件哈希、大小或对象键不一致');
  }
  const origin = downloadOrigin(options.origin); const url = `${origin}/${key}`;
  if (book.downloads.r2Url !== url) throw new TransferError('书目下载地址与当前配置不一致，请重新准备计划');
  const expected: ObjectHeaders = { bytes: bytes.length, sha256: book.file.sha256,
    contentType: 'application/epub+zip', contentDisposition: disposition(book.id, book.file.filename) };
  let remote = await store.head(key); let action: Verification['action'] = 'reused';
  if (remote) assertHeaders(remote, expected);
  else {
    if (options.readOnly) throw new TransferError('远端对象缺失');
    try { await store.put(key, bytes, expected); action = 'uploaded'; }
    catch {
      // A timed-out conditional write may still have succeeded; inspect before retrying.
      remote = await store.head(key);
      if (!remote) throw new TransferError('上传未完成，保留计划后可安全重试');
      assertHeaders(remote, expected);
    }
    remote = await store.head(key);
    if (!remote) throw new TransferError('上传后未找到对象');
    assertHeaders(remote, expected);
  }
  // Do not probe public URLs before upload: a cached 404 could mask a new object.
  const response = await (options.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(120000) });
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  const contentDisposition = response.headers.get('content-disposition') ?? '';
  let dispositionFilename: string;
  try { dispositionFilename = decodeURIComponent(/filename\*=UTF-8''([^;]+)/iu.exec(contentDisposition)?.[1] ?? ''); }
  catch { throw new TransferError('公开下载文件名编码错误'); }
  if (response.status !== 200 || !response.body || contentType !== expected.contentType
    || !/^attachment\s*;/iu.test(contentDisposition) || dispositionFilename !== book.file.filename
    || Number(response.headers.get('content-length')) !== bytes.length) {
    await response.body?.cancel(); throw new TransferError('公开下载状态、文件名、大小或响应头不匹配');
  }
  const hash = createHash('sha256'); let downloaded = 0;
  for await (const chunk of response.body) {
    downloaded += chunk.length;
    if (downloaded > bytes.length) throw new TransferError('公开下载大小超出预期');
    hash.update(chunk);
  }
  if (downloaded !== bytes.length || hash.digest('hex') !== book.file.sha256) throw new TransferError('公开下载的完整文件 SHA-256 校验失败');
  return { id: book.id, title: book.title, key, url, bytes: bytes.length, sha256: book.file.sha256,
    contentType, contentDisposition, dispositionFilename, action, verifiedAt: new Date().toISOString() };
}
