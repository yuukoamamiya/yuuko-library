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
    downloads: { r2Key: `books/${id}/${sha}.epub`, r2Url: `https://download.example/books/${id}/${sha}.epub`, mirrors: {} },
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

test('health full download passes after streaming exact bytes and hash', async () => {
  const root = await setup(); try {
    const a = book('full-ok', '完整验证');
    const result = await runHealth(root, clean([a]), undefined, true, 20000, mock([a]) as any, clean([a]));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health full download rejects same-size wrong hash, truncation, and oversized streams', async () => {
  const root = await setup(); try {
    for (const scenario of ['wrong-hash', 'truncated', 'oversized'] as const) {
      const a = book(`stream-${scenario}`, '流式验证'), urlPath = new URL(a.downloads.r2Url).pathname;
      let canceled = false;
      const override = (_url: URL, init: RequestInit) => {
        if (init.method === 'HEAD') return response(null, 200, { 'content-length': String(a.file.bytes), 'content-type': 'application/epub+zip',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.file.filename)}` });
        const bytes = scenario === 'wrong-hash' ? Buffer.alloc(a.file.bytes, 0x41)
          : scenario === 'truncated' ? a._bytes.subarray(0, a.file.bytes - 1) : Buffer.concat([a._bytes, Buffer.from('too much')]);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(bytes); if (scenario !== 'oversized') controller.close(); },
          cancel() { canceled = true; },
        });
        return response(stream, 200, { 'content-length': String(a.file.bytes), 'content-type': 'application/epub+zip',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.file.filename)}` });
      };
      const result = await runHealth(root, clean([a]), undefined, true, 20000,
        mock([a], { [urlPath]: override }) as any, clean([a]));
      assert.equal(result.status, 'failed', scenario);
      assert.ok(result.failures.some(f => ['download-bytes', 'download-sha256', 'download'].includes(f.check)), scenario);
      if (scenario === 'oversized') assert.equal(canceled, true, 'oversized stream must be canceled');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health detects remote cover corruption even when the local cover matches its name', async () => {
  const root = await setup(); try {
    const a = book('cover-check', '封面校验'), local = Buffer.from('local cover'), remote = Buffer.from('corrupt cover');
    const coverHash = hash(local), coverPath = `/covers/${a.id}/${coverHash}.jpg`;
    a.cover = coverPath; await mkdir(path.join(root, 'public', 'covers', a.id), { recursive: true });
    await writeFile(path.join(root, 'public', coverPath.slice(1)), local);
    const result = await runHealth(root, clean([a]), undefined, false, 20000,
      mock([a], { [coverPath]: () => response(remote) }) as any, clean([a]));
    assert.equal(result.status, 'failed'); assert.ok(result.failures.some(f => f.check === 'cover-hash'));
    assert.ok(!result.failures.some(f => f.check === 'cover-local-hash'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health sends redirect:error and rejects an HTTP redirect response', async () => {
  const root = await setup(); try {
    const a = book('redirect-check', '重定向检查'), urlPath = new URL(a.downloads.r2Url).pathname; let redirectMode: RequestRedirect | undefined;
    const request = mock([a], { [urlPath]: (_url, init) => {
      redirectMode = init.redirect;
      return response(null, 302, { location: 'https://elsewhere.example/file.epub' });
    } });
    const result = await runHealth(root, clean([a]), undefined, false, 20000, request as any, clean([a]));
    assert.equal(redirectMode, 'error'); assert.equal(result.status, 'failed');
    assert.ok(result.failures.some(f => f.check === 'download' && f.reason === 'HTTP 302'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health rejects duplicate index IDs, metadata mismatch, and a bad homepage', async () => {
  const root = await setup(); try {
    const a = book('index-check', '索引检查');
    const duplicate = mock([a], {
      '/search-index.json': () => response(JSON.stringify([clean([a])[0], clean([a])[0]])),
      '/': () => response('<h1>错误的站点</h1>'),
    });
    const result = await runHealth(root, clean([a]), undefined, false, 20000, duplicate as any, clean([a]));
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.some(f => f.check === 'index-entry'));
    assert.ok(result.failures.some(f => f.check === 'homepage-content'));
    const mismatch = mock([a], { '/search-index.json': () => response(JSON.stringify([{ ...clean([a])[0], title: '错误书名' }])) });
    const metadata = await runHealth(root, clean([a]), undefined, false, 20000, mismatch as any, clean([a]));
    assert.ok(metadata.failures.some(f => f.check === 'metadata'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
