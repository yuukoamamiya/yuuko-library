import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePagesConfig } from '../tools/pages/config.ts';
const base = { title: 'x', description: 'x', siteUrl: 'https://library.example.com', downloadsUrl: 'https://download.example.com', r2Bucket: 'books', r2Endpoint: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com', cloudflareAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pagesProject: 'library', cloudflareZone: 'example.com', productionBranch: 'main' };
test('Pages config reads an explicit Cloudflare account', () => assert.equal(validatePagesConfig(base).cloudflareAccountId, base.cloudflareAccountId));
test('Pages config has no R2 dependency', () => { const { siteUrl, cloudflareAccountId, pagesProject, cloudflareZone, productionBranch } = base; assert.equal(validatePagesConfig({ siteUrl, cloudflareAccountId, pagesProject, cloudflareZone, productionBranch }).pagesProject, 'library'); });
test('invalid Pages account config fails locally', () => assert.throws(() => validatePagesConfig({ ...base, cloudflareAccountId: '' }), /cloudflareAccountId/u));
test('site hostname must belong to configured zone', () => assert.throws(() => validatePagesConfig({ ...base, siteUrl: 'https://example.net' }), /siteUrl/u));

test('Cloudflare API adapter supports a mocked fetch without logging tokens', async () => { const { requestCloudflare } = await import('../tools/pages/cloudflare-api.ts'); let seen=''; const result = await requestCloudflare<{ ok: boolean }>('zones', 'secret-test', { fetcher: (async (_url, init) => { seen = String(init?.headers && (init.headers as Record<string,string>).Authorization); return new Response(JSON.stringify({ success: true, result: { ok: true } }), { status: 200 }); }) as typeof fetch }); assert.deepEqual(result, { ok: true }); assert.equal(seen, 'Bearer secret-test'); });

test('Pages config rejects non-string project fields before coercion', () => assert.throws(() => validatePagesConfig({ ...base, pagesProject: 123 }), /非空字符串/u));
