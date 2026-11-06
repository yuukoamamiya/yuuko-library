import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runHealth } from '../tools/maintenance/health.ts';

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const book = (id: string, title: string) => {
  const data = Buffer.from(`epub-${id}`), sha = hash(data), filename = `${title}.epub`;
  return { schemaVersion: 1, id, title, authors: ['作者'], description: '说明', subjects: ['主题'], categories: ['politics'], cover: null,
    edition: { kind: 'transcription', model: null }, file: { sha256: sha, bytes: data.length, filename },
    downloads: { r2Key: `books/${id}/${sha}.epub`, r2Url: `https://download.example/books/${id}/${sha}.epub`, baidu: null },
    publishedAt: null, updatedAt: null, _bytes: data } as any;
};
const clean = (books: any[]) => books.map(({ _bytes, ...b }) => b);
const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'health-'));
  await writeFile(path.join(root, 'site.config.json'), JSON.stringify({ title: '雨宫优子图书馆', siteUrl: 'https://site.example', downloadsUrl: 'https://download.example' }));
  await mkdir(path.join(root, 'public'), { recursive: true });
  return root;
};
const response = (body: any, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
function mock(books: any[], overrides: Record<string, (url: URL, init: RequestInit) => Response | Promise<Response>> = {}) {
  return async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const u = new URL(input.toString()), route = u.pathname, override = overrides[route]; if (override) return override(u, init);
    if (route === '/') return response('<h1>雨宫优子图书馆</h1>');
    if (route === '/release.json') return response(JSON.stringify({ schemaVersion: 2, books: books.length, catalogDigest: hash(canonical([...books].sort((a,b) => a.id.localeCompare(b.id, 'en')).map(({ _bytes, ...b }) => b))) }));
    if (route === '/search-index.json') return response(JSON.stringify(books.map(({ _bytes, ...b }) => b)));
    const detail = /^\/books\/([^/]+)\/$/u.exec(route);
    if (detail) { const b = books.find(x => x.id === detail[1]); return response(`<h1>${b.title.replaceAll('&','&amp;')}</h1><a class="download-button" href="${b.downloads.r2Url}">下载</a>`); }
    const b = books.find(x => x.downloads.r2Url && route === new URL(x.downloads.r2Url).pathname);
    if (b) return response(init.method === 'HEAD' ? null : b._bytes, 200, { 'content-length': String(b.file.bytes), 'content-type': 'application/epub+zip', 'content-disposition': `attachment; filename="${b.id}.epub"; filename*=UTF-8''${encodeURIComponent(b.file.filename)}` });
    return response('', 404);
  };
}
test('health validates entire index while checking selected sample details', async () => {
  const root = await setup(); try {
    const a = book('sample', '马克思 & 恩格斯'), b = book('other', '另一书');
    // Stub release digest to match production canonical digest as an opaque valid marker.
    const request = mock([a,b]);
    const result = await runHealth(root, clean([a]), undefined, false, 20000, request as any, clean([a,b]));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures)); assert.equal(result.warnings.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('health continues after malformed index and checks subsequent books', async () => {
  const root = await setup(); try {
    const a = book('one', '一本'), b = book('two', '第二本'); let detailRequests = 0;
    const request = mock([a,b], { '/release.json': () => response('{}'), '/search-index.json': () => response('null'), '/books/one/': () => { detailRequests++; return response('',404); }, '/books/two/': () => { detailRequests++; return response('<h1>第二本</h1>'); } });
    const result = await runHealth(root, [a,b], undefined, false, 20000, request as any, [a,b]);
    assert.equal(result.status, 'failed'); assert.equal(detailRequests, 2); assert.ok(result.failures.some(f => f.check === 'index'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('health rejects unsafe download URLs and does not accept a redirect', async () => {
  const root = await setup(); try {
    const a = book('one', '一本'); a.downloads.r2Url = 'https://evil.example/books/one/x.epub';
    const result = await runHealth(root, [a], undefined, false, 20000, mock([a]) as any, [a]);
    assert.ok(result.failures.some(f => f.check === 'download-url'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('health full download requires exact MIME and RFC 5987 filename', async () => {
  const root = await setup(); try {
    const a = book('one', '马克思 & 恩格斯');
    const request = mock([a], { '/release.json': () => response('{}'), [new URL(a.downloads.r2Url).pathname]: (_u, init) => response(init.method === 'HEAD' ? null : a._bytes, 200,
      { 'content-length': String(a.file.bytes), 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''wrong.epub" }) });
    const result = await runHealth(root, [a], undefined, true, 20000, request as any, [a]);
    assert.ok(result.failures.some(f => f.check === 'download-mime')); assert.ok(result.failures.some(f => f.check === 'download-filename'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
