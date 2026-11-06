import { type Book } from '../../src/lib/books.ts';
import { assertIndex, digest, type Release } from './release.ts';

export function siteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('需要 HTTPS 站点根地址');
  return url;
}
export async function verifyRelease(release: Release, url: URL, request: typeof fetch = fetch) {
  async function get(relative: string) {
    const target = new URL(relative, url);
    target.searchParams.set('verify', release.id);
    const response = await request(target, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error(`线上资源读取失败：${relative}`);
    return response;
  }
  const marker = await (await get('/release.json')).json();
  if (marker.schemaVersion !== 2 || marker.releaseId !== release.id || marker.books !== release.catalog.length
    || marker.changedBooks !== release.books.length || marker.catalogDigest !== release.catalogDigest) throw new Error('线上发布标识不匹配');
  const html = await (await get('/')).text();
  if (!html.includes('雨宫优子图书馆') || html.includes('本地预览 · 尚未发布')) throw new Error('线上首页校验失败');
  const bytes = Buffer.from(await (await get('/search-index.json')).arrayBuffer());
  const index = JSON.parse(bytes.toString('utf8')) as Pick<Book, 'id'>[];
  assertIndex(release.catalog, index);
  if (digest(bytes) !== release.indexDigest) throw new Error('线上检索索引摘要不匹配');
  for (const book of release.catalog) {
    const page = await (await get(`/books/${book.id}/`)).text();
    if (!book.downloads.r2Url || !page.includes(book.downloads.r2Url) || page.includes('noindex, nofollow')
      || !page.includes('class="download-button"')) throw new Error(`线上详情或下载链接不匹配：${book.id}`);
  }
}
