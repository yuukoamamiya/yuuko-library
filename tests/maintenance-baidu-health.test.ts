import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkBaiduShare } from '../tools/maintenance/baidu-health.ts';
import { runHealth } from '../tools/maintenance/health.ts';

const book = (id: string, extras: any = {}) => ({ id, file: { sha256: 'a'.repeat(64), filename: `file-${id}.epub` }, downloads: { baidu: {
  url: `https://pan.baidu.com/s/abc${id}`, code: 'ysqx', fileSha256: 'a'.repeat(64), ...extras,
} } }) as any;
const response = (body: string, status = 200, headers: HeadersInit = {}) => new Response(body, { status, headers });
function successful(requestLog: { url: string; init: RequestInit }[]) {
  const shareGets = new Map<string, number>();
  return async (url: URL, init: RequestInit) => {
    requestLog.push({ url: url.href, init });
    if (url.pathname.startsWith('/s/')) {
      const n = (shareGets.get(url.pathname) ?? 0) + 1; shareGets.set(url.pathname, n);
      if (n > 1) return response(`<div>${url.pathname.endsWith('rar') ? 'bundle.rar' : `file-${url.pathname.slice(6)}.epub`} 下载</div>`);
      return response('', 302, new Headers([['location', '/share/init?surl=abc'], ['set-cookie', 'anon=one; Path=/'], ['set-cookie', 'BDUSS=private-account-cookie; Path=/']]));
    }
    if (url.pathname === '/share/init') return response('<div><input readonly value="ysqx" aria-label="提取码" data-baidu-code></div>', 200, { 'set-cookie': 'init=one; Path=/' });
    if (url.pathname === '/share/verify') return response(JSON.stringify({ errno: 0 }));
    return response('', 404);
  };
}
test('anonymous challenge passes and sends the extract code only to verify endpoint', async () => {
  const log: { url: string; init: RequestInit }[] = [];
  const result = await checkBaiduShare(book('one'), successful(log));
  assert.equal(result.status, 'passed');
  const verify = log.find(x => new URL(x.url).pathname === '/share/verify')!;
  assert.equal(new URL(verify.url).searchParams.get('surl'), 'abcone');
  assert.equal(new URLSearchParams(String(verify.init.body)).get('pwd'), 'ysqx');
  assert.equal(new URLSearchParams(String(verify.init.body)).has('surl'), false);
  assert.ok(!log[0].init.headers || !('Cookie' in (log[0].init.headers as any)));
  assert.match(String((verify.init.headers as any).Cookie), /anon=one/u);
  assert.doesNotMatch(String((verify.init.headers as any).Cookie), /BDUSS/u);
});
test('wrong password, missing share, captcha, timeout and unsafe redirect never pass', async () => {
  const cases: Array<[string, (url: URL, init: RequestInit) => Promise<Response>]> = [
    ['wrong', async (url) => url.pathname === '/share/verify' ? response('{"errno":-9}') : successful([])(url, { method: 'GET' })],
    ['protocol-error', async (url) => url.pathname === '/share/verify' ? response('{"errno":-12,"err_msg":""}') : successful([])(url, { method: 'GET' })],
    ['missing', async (url) => url.pathname.startsWith('/s/') ? response('链接不存在') : response('')],
    ['captcha', async (url) => url.pathname.startsWith('/s/') ? response('', 302, { location: '/share/init?surl=abc' }) : response('验证码')],
    ['unsafe', async (url) => url.pathname.startsWith('/s/') ? response('', 302, { location: 'https://evil.example/share/init' }) : response('')],
  ];
  for (const [name, request] of cases) {
    const result = await checkBaiduShare(book(name), request);
    if (name === 'protocol-error') assert.equal(result.status, 'unconfirmed');
    else assert.notEqual(result.status, 'passed', name);
  }
  const timeout = await checkBaiduShare(book('timeout'), async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); });
  assert.equal(timeout.status, 'unconfirmed');
});
test('RAR uses share extract code challenge and requires public archive filename', async () => {
  const log: { url: string; init: RequestInit }[] = [];
  let shareGets = 0;
  const result = await checkBaiduShare(book('rar', { archive: { filename: 'bundle.rar', password: 'unzip-secret' } }), async (url, init) => {
    if (url.pathname.startsWith('/s/') && ++shareGets > 1) return response('<div>bundle.rar 文件下载</div>');
    return successful(log)(url, init);
  });
  assert.equal(result.status, 'passed');
  const verify = log.find(x => new URL(x.url).pathname === '/share/verify')!;
  assert.equal(new URL(verify.url).searchParams.get('surl'), 'abcrar');
  assert.equal(new URLSearchParams(String(verify.init.body)).get('pwd'), 'ysqx');
  assert.notEqual(new URLSearchParams(String(verify.init.body)).get('pwd'), 'unzip-secret');
});

test('cookie jar is isolated per book and oversized responses stay unconfirmed', async () => {
  const seen: string[] = [];
  const request = async (url: URL, init: RequestInit) => {
    if (url.pathname.startsWith('/s/')) {
      const n = (seen.filter(x => x === url.pathname).length + 1); seen.push(url.pathname);
      return n === 1 ? response('', 302, { location: `/share/init?surl=${url.pathname.slice(6)}`, 'set-cookie': `${url.pathname.slice(6)}=private; Path=/` }) : response(`<div>file-${url.pathname.slice(6)}.epub 下载</div>`);
    }
    if (url.pathname === '/share/init') return response('<input readonly value="ysqx" aria-label="提取码" data-baidu-code>');
    if (url.pathname === '/share/verify') {
      const cookie = String((init.headers as any).Cookie ?? '');
      assert.ok(cookie.includes('=private'));
      return response('{"errno":0}');
    }
    return response('');
  };
  assert.equal((await checkBaiduShare(book('alpha'), request)).status, 'passed');
  assert.equal((await checkBaiduShare(book('beta'), request)).status, 'passed');
  const large = await checkBaiduShare(book('large'), async () => response('x'.repeat(1024 * 1024 + 1)));
  assert.equal(large.status, 'unconfirmed');
});

test('health recognizes boolean data attributes and checks Baidu despite invalid R2 URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'health-baidu-'));
  try {
    await writeFile(path.join(root, 'site.config.json'), JSON.stringify({ title: '图书馆', siteUrl: 'https://site.example', downloadsUrl: 'https://download.example' }));
    await mkdir(path.join(root, 'public'));
    const b = book('health', { url: 'https://pan.baidu.com/s/abchealth', archive: { filename: 'bundle.rar', password: 'unzip-pass', sha256: 'b'.repeat(64), bytes: 55 } });
    b.title = '书目标题'; b.file.bytes = 100; b.authors = []; b.description = ''; b.subjects = []; b.categories = []; b.cover = null;
    b.downloads.r2Url = 'https://evil.example/wrong'; b.downloads.r2Key = 'wrong';
    let shareGets = 0;
    const request = async (url: URL) => {
      if (url.hostname === 'pan.baidu.com') {
        if (url.pathname.startsWith('/s/')) return ++shareGets === 1
          ? response('', 302, { location: '/share/init?surl=health' }) : response('<div>bundle.rar 下载</div>');
        if (url.pathname === '/share/init') return response('<input readonly value="ysqx" aria-label="提取码" data-baidu-code>');
        if (url.pathname === '/share/verify') return response('{"errno":0}');
      }
      if (url.pathname === '/') return response('<h1>图书馆</h1>');
      if (url.pathname === '/release.json') return response('{}');
      if (url.pathname === '/search-index.json') return response('[]');
      if (url.pathname === '/books/health/') return response('<h1>书目标题</h1><a class="download-button" href="https://evil.example/wrong">下载</a><input readonly value="ysqx" aria-label="提取码" data-baidu-code data-astro-cid-ohmbw32d><p>RAR 压缩包 · bundle.rar</p><input readonly value="unzip-pass" aria-label="解压密码" data-baidu-password><a href="https://pan.baidu.com/s/abchealth">网盘</a>');
      return response('', 404);
    };
    const result = await runHealth(root, [b], undefined, false, 1000, request as any, [b], { baidu: true });
    assert.ok(result.failures.some(f => f.check === 'download-url'));
    assert.ok(!result.failures.some(f => f.check === 'detail-baidu'));
    assert.ok(!result.failures.some(f => f.check === 'detail-baidu-archive'));
    assert.equal(result.baidu?.passed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
