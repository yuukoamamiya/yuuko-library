import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { convert } from 'html-to-text';
import type { Book } from '../../src/lib/book.ts';
import { mirrorLabel } from '../../src/lib/mirrors.ts';
import { canonical, catalogDigest, digest } from '../catalog.ts';
import { MIRROR_HEALTH } from './mirror-health.ts';

type Failure = { check: string; target: string; reason: string };
type MirrorStats = { checked: number; passed: number; unavailable: number; unconfirmed: number; notConfigured: number };
type CheckResult = { status: 'passed' | 'failed'; checks: number; failures: Failure[]; warnings: string[]; mirrors?: Record<string, MirrorStats>; provenance?: unknown };
const safeReason = (e: unknown) => e instanceof Error && e.name === 'TimeoutError' ? '请求超时' : '请求失败或响应格式无效';
const parseAttrs = (html: string) => [...html.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)]
  .map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ''] as const);
const decodeHtml = (s: string) => convert(s, { wordwrap: false, selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim();
const strictPath = /^\/covers\/[a-z0-9][a-z0-9-]{0,79}\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u;
function dispositionFilename(value: string): string | null {
  if (!/^\s*attachment\s*;/iu.test(value)) return null;
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]*)/iu.exec(value)?.[1];
  if (!encoded) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}
function checkBookShape(book: any): string | null {
  if (!book || typeof book !== 'object' || typeof book.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(book.id)) return '书目结构或 ID 无效';
  if (typeof book.title !== 'string' || !book.file || !Number.isSafeInteger(book.file.bytes) || book.file.bytes < 0
    || !/^[a-f0-9]{64}$/u.test(book.file.sha256 ?? '') || typeof book.file.filename !== 'string'
    || !book.downloads || typeof book.downloads !== 'object'
    || !book.downloads.mirrors || typeof book.downloads.mirrors !== 'object' || Array.isArray(book.downloads.mirrors)) return '书目文件元数据无效';
  return null;
}

export async function runHealth(root: string, selectedBooks: Book[], suppliedUrl?: string, full = false, timeout = 20000,
  request: typeof fetch = fetch, allBooks: Book[] = selectedBooks, options: { mirrors?: boolean; skipProviders?: string[] } = {}): Promise<CheckResult> {
  const failures: Failure[] = [], warnings: string[] = []; let checks = 0; let provenance: unknown;
  const mirrorsEnabled = options.mirrors ?? false;
  const skipProviders = new Set(options.skipProviders ?? []);
  const mirrors: Record<string, MirrorStats> = {};
  const statsFor = (provider: string) => mirrors[provider] ??= { checked: 0, passed: 0, unavailable: 0, unconfirmed: 0, notConfigured: 0 };
  const fail = (check: string, target: string, reason: string) => failures.push({ check, target, reason });
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8')) as { siteUrl: string; downloadsUrl: string; title: string };
  const site = new URL(suppliedUrl ?? config.siteUrl);
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) throw new Error('站点 URL 必须为安全的 HTTPS URL');
  const origin = new URL(config.downloadsUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('downloadsUrl 必须为不带路径或凭据的 HTTPS 域名');
  const fetcher = async (url: URL, method: 'GET' | 'HEAD' = 'GET') => { checks++; return request(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout) }); };
  const home = await fetcher(site).catch(e => { fail('homepage', site.origin, safeReason(e)); return null; });
  if (home) try {
    if (home.status !== 200) fail('homepage', site.origin, `HTTP ${home.status}`);
    const html = await home.text();
    if (html.includes('noindex') || !decodeHtml(html).includes(config.title)) fail('homepage-content', '/', '首页缺少站名或为预览页面');
  } catch { fail('homepage', site.origin, '响应正文无法读取'); }
  const markerResponse = await fetcher(new URL('/release.json', site)).catch(e => { fail('release', '/release.json', safeReason(e)); return null; });
  let marker: any = null;
  if (markerResponse) try {
    if (markerResponse.status !== 200) throw new Error(`HTTP ${markerResponse.status}`);
    marker = await markerResponse.json();
    if (!marker || typeof marker !== 'object' || marker.schemaVersion !== 2 || !Number.isInteger(marker.books) || marker.books !== allBooks.length
      || !/^[a-f0-9]{64}$/u.test(marker.catalogDigest ?? '') || marker.catalogDigest !== catalogDigest(allBooks)) fail('release', '/release.json', '发布标记书目数量或摘要不匹配');
    if (marker.provenance === undefined) warnings.push('现网发布标记未提供 provenance，无法核对源码来源');
    else {
      provenance = marker.provenance;
      const p = marker.provenance;
      if (!p || typeof p !== 'object' || typeof p.dirty !== 'boolean' || !/^[a-f0-9]{64}$/u.test(p.sourceDigest ?? '')
        || !['repository', 'plan-overlay'].includes(p.source) || (p.commit !== null && !/^[a-f0-9]{40}$/u.test(p.commit))) fail('release-provenance', '/release.json', 'provenance 字段格式无效');
    }
  } catch { fail('release', '/release.json', '发布标记不是有效的预期 JSON'); }
  const indexResponse = await fetcher(new URL('/search-index.json', site)).catch(e => { fail('index', '/search-index.json', safeReason(e)); return null; });
  let index: any = null;
  if (indexResponse) try { if (indexResponse.status !== 200) throw new Error(); index = await indexResponse.json(); if (!Array.isArray(index)) throw new Error(); }
    catch { fail('index', '/search-index.json', '索引不是有效数组或 HTTP 不是 200'); }
  const expected = new Map<string, Book>();
  for (const b of allBooks as any[]) { const reason = checkBookShape(b); if (reason) { fail('catalog', String(b?.id ?? 'unknown'), reason); continue; } if (expected.has(b.id)) fail('catalog-duplicate', b.id, '书目 ID 重复'); else expected.set(b.id, b); }
  if (index) {
    const seen = new Set<string>();
    for (const item of index) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id)) { fail('index-entry', '/search-index.json', '索引条目无效或 ID 重复'); continue; }
      seen.add(item.id); const book = expected.get(item.id); if (!book) { fail('index-id-set', item.id, '线上索引包含未知 ID'); continue; }
      for (const key of ['title', 'authors', 'description', 'subjects', 'categories']) if (canonical(item[key]) !== canonical((book as any)[key])) fail('metadata', item.id, `索引字段 ${key} 不匹配`);
    }
    for (const id of expected.keys()) if (!seen.has(id)) fail('index-id-set', id, '线上索引缺少书目 ID');
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, selectedBooks.length) }, async () => {
    while (cursor < selectedBooks.length) {
      const book = selectedBooks[cursor++] as any; console.error(`health: ${book?.id ?? 'unknown'}`);
      const shape = checkBookShape(book); if (shape) { fail('catalog', String(book?.id ?? 'unknown'), shape); continue; }
      const id = book.id, target = `/books/${encodeURIComponent(id)}/`;
      const page = await fetcher(new URL(target, site)).catch(e => { fail('detail', id, safeReason(e)); return null; });
      if (page) try {
        if (page.status !== 200) throw new Error(`HTTP ${page.status}`); const html = await page.text();
        if (/noindex/iu.test(html)) fail('detail-preview', id, '详情页包含 noindex');
        const titleText = decodeHtml((/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(html)?.[1] ?? '').replace(/<[^>]*>/gu, ''));
        if (titleText !== book.title) fail('detail-title', id, '详情页标题与书目不匹配');
        const anchors = [...html.matchAll(/<a\b([^>]*)>/giu)].map(m => Object.fromEntries(parseAttrs(m[1])));
        const expectedUrl = book.downloads.r2Url;
        if (!anchors.some(a => a.href === expectedUrl && /(?:^|\s)download-button(?:\s|$)/u.test(a.class ?? ''))) fail('detail-download', id, '缺少匹配 URL 的 download-button 链接');
        if (mirrorsEnabled) {
          const inputs = [...html.matchAll(/<input\b([^>]*)>/giu)].map(m => Object.fromEntries(parseAttrs(m[1])));
          for (const [provider, mirror] of Object.entries(book.downloads.mirrors ?? {}) as Array<[string, any]>) {
            if (skipProviders.has(provider) || !mirror || typeof mirror !== 'object') continue;
            const label = mirrorLabel(provider);
            if (!anchors.some(a => a.href === mirror.url) || !inputs.some(a => a.value === mirror.code && 'data-mirror-code' in a)) fail('detail-mirror', id, `详情页缺少匹配的${label}链接或提取码`);
            if (mirror.archive && (!html.includes(mirror.archive.filename) || !inputs.some(a => a.value === mirror.archive.password && 'data-mirror-password' in a))) fail('detail-mirror-archive', id, `详情页缺少匹配的${label}RAR 文件名或解压密码引用`);
          }
        }
        if (book.cover && !html.includes(book.cover)) fail('detail-cover-reference', id, '详情页封面引用不匹配');
      } catch (e) { fail('detail', id, e instanceof Error ? e.message : '详情页响应无效'); }
      if (book.cover) {
        if (typeof book.cover !== 'string' || !strictPath.test(book.cover) || !book.cover.startsWith(`/covers/${id}/`)) fail('cover-path', id, '封面路径不安全或不属于该书');
        else {
          const response = await fetcher(new URL(book.cover, site)).catch(e => { fail('cover', id, safeReason(e)); return null; });
          if (response) try {
            if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
            const hash = createHash('sha256'); for await (const chunk of response.body) hash.update(Buffer.from(chunk));
            if (hash.digest('hex') !== path.basename(book.cover).split('.')[0]) fail('cover-hash', id, '远端封面 SHA-256 与路径摘要不符');
          } catch { fail('cover', id, '远端封面无法完整读取'); }
          try { const local = await readFile(path.join(root, 'public', book.cover.slice(1))); if (digest(local) !== path.basename(book.cover).split('.')[0]) fail('cover-local-hash', id, '本地封面 SHA-256 与路径摘要不符'); }
          catch { fail('cover-local', id, '本地封面文件不可读'); }
        }
      }
      // Public-share checking is independent of the configured R2 URL.
      if (mirrorsEnabled) {
        for (const [provider, mirror] of Object.entries(book.downloads.mirrors ?? {}) as Array<[string, any]>) {
          if (skipProviders.has(provider)) continue;
          const label = mirrorLabel(provider);
          const stats = statsFor(provider);
          const check = MIRROR_HEALTH[provider];
          if (!check) {
            checks++; stats.checked++; stats.notConfigured++;
            warnings.push(`${id}: ${label} 缺少健康检查实现，未检查`);
            continue;
          }
          checks++; stats.checked++;
          const result = await check(book, mirror, request as any, timeout);
          stats[result.status === 'not-configured' ? 'notConfigured' : result.status]++;
          if (result.status === 'unavailable') fail('mirror-unavailable', `${id}:${provider}`, result.reason ?? `${label}分享不可用`);
          else if (result.status === 'unconfirmed') { fail('mirror-unconfirmed', `${id}:${provider}`, result.reason ?? `${label}分享状态未能确认`); warnings.push(`${id}: ${label}公开访问未能确认`); }
          else if (result.status === 'not-configured') warnings.push(`${id}: ${label}分享未配置`);
        }
      }
      let download: URL;
      try {
        download = new URL(book.downloads.r2Url);
        if (download.origin !== origin.origin || download.protocol !== 'https:' || download.username || download.password || download.search || download.hash
          || download.pathname !== `/books/${id}/${book.file.sha256}.epub` || book.downloads.r2Key !== `books/${id}/${book.file.sha256}.epub`) throw new Error();
      } catch { fail('download-url', id, '下载 URL 或对象键不符合配置 origin 和预期对象路径'); continue; }
      const response = await fetcher(download, full ? 'GET' : 'HEAD').catch(e => { fail('download', id, safeReason(e)); return null; }); if (!response) continue;
      try {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/epub+zip') fail('download-mime', id, 'Content-Type 必须为 application/epub+zip');
        if (Number(response.headers.get('content-length')) !== book.file.bytes) fail('download-length', id, 'Content-Length 与书目大小不匹配');
        if (dispositionFilename(response.headers.get('content-disposition') ?? '') !== book.file.filename) fail('download-filename', id, 'Content-Disposition 文件名与书目不完全一致');
        if (full) {
          if (!response.body) throw new Error('响应体为空'); const hash = createHash('sha256'); let bytes = 0;
          const reader = response.body.getReader();
          try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > book.file.bytes) { await reader.cancel(); throw new Error('响应体超过预期大小'); } hash.update(value); } }
          finally { reader.releaseLock(); }
          if (bytes !== book.file.bytes) fail('download-bytes', id, '完整响应字节数与书目大小不匹配');
          if (hash.digest('hex') !== book.file.sha256) fail('download-sha256', id, '完整下载 SHA-256 不匹配');
        }
      } catch (e) { fail('download', id, e instanceof Error ? e.message : '下载响应无效'); }
    }
  }));
  return { status: failures.length ? 'failed' : 'passed', checks, failures, warnings, ...(mirrorsEnabled ? { mirrors } : {}), ...(provenance === undefined ? {} : { provenance }) };
}
