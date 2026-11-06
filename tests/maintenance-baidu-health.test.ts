import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBaiduShare } from '../tools/maintenance/baidu-health.ts';

const book = (id: string, extras: any = {}) => ({ id, file: { sha256: 'a'.repeat(64) }, downloads: { baidu: {
  url: `https://pan.baidu.com/s/abc${id}`, code: 'abcd', fileSha256: 'a'.repeat(64), ...extras,
} } }) as any;
const response = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
function successful(requestLog: { url: string; init: RequestInit }[]) {
  const shareGets = new Map<string, number>();
  return async (url: URL, init: RequestInit) => {
    requestLog.push({ url: url.href, init });
    if (url.pathname.startsWith('/s/')) {
      const n = (shareGets.get(url.pathname) ?? 0) + 1; shareGets.set(url.pathname, n);
      if (n > 1) return response('<div>文件下载</div>');
      return response('', 302, { location: '/share/init?surl=abc', 'set-cookie': 'anon=one; Path=/' });
    }
    if (url.pathname === '/share/init') return response('<div>请输入提取码</div>', 200, { 'set-cookie': 'init=one; Path=/' });
    if (url.pathname === '/share/verify') return response(JSON.stringify({ errno: 0 }));
    return response('', 404);
  };
}
test('anonymous challenge passes and sends the extract code only to verify endpoint', async () => {
  const log: { url: string; init: RequestInit }[] = [];
  const result = await checkBaiduShare(book('one'), successful(log));
  assert.equal(result.status, 'passed');
  const verify = log.find(x => new URL(x.url).pathname === '/share/verify')!;
  assert.match(String(verify.init.body), /pwd=abcd/u);
  assert.equal(new URLSearchParams(String(verify.init.body)).get('pwd'), 'abcd');
  assert.ok(!log[0].init.headers || !('Cookie' in (log[0].init.headers as any)));
  assert.match(String((verify.init.headers as any).Cookie), /anon=one/u);
});
test('wrong password, missing share, captcha, timeout and unsafe redirect never pass', async () => {
  const cases: Array<[string, (url: URL, init: RequestInit) => Promise<Response>]> = [
    ['wrong', async (url) => url.pathname === '/share/verify' ? response('{"errno":-9}') : successful([])(url, { method: 'GET' })],
    ['missing', async (url) => url.pathname.startsWith('/s/') ? response('链接不存在') : response('')],
    ['captcha', async (url) => url.pathname.startsWith('/s/') ? response('', 302, { location: '/share/init?surl=abc' }) : response('验证码')],
    ['unsafe', async (url) => url.pathname.startsWith('/s/') ? response('', 302, { location: 'https://evil.example/share/init' }) : response('')],
  ];
  for (const [name, request] of cases) {
    const result = await checkBaiduShare(book(name), request);
    assert.notEqual(result.status, 'passed', name);
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
  assert.equal(new URLSearchParams(String(verify.init.body)).get('pwd'), 'abcd');
  assert.notEqual(new URLSearchParams(String(verify.init.body)).get('pwd'), 'unzip-secret');
});

test('cookie jar is isolated per book and oversized responses stay unconfirmed', async () => {
  const seen: string[] = [];
  const request = async (url: URL, init: RequestInit) => {
    if (url.pathname.startsWith('/s/')) {
      const n = (seen.filter(x => x === url.pathname).length + 1); seen.push(url.pathname);
      return n === 1 ? response('', 302, { location: '/share/init?surl=abc', 'set-cookie': `${url.pathname.slice(3)}=private; Path=/` }) : response('<div>文件下载</div>');
    }
    if (url.pathname === '/share/init') return response('请输入提取码');
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
