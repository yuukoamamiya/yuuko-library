import type { Book } from '../../src/lib/books.ts';

export type BaiduHealthResult = { status: 'passed' | 'unavailable' | 'unconfirmed' | 'not-configured'; reason?: string };
type AnonymousRequest = (url: URL, init: RequestInit) => Promise<Response>;
const safe = (e: unknown) => e instanceof Error && e.name === 'TimeoutError' ? '请求超时' : '网络或响应格式未能确认';

/** Read-only, anonymous check of a public Baidu share. Cookies are confined to this call. */
export async function checkBaiduShare(book: Book, request: AnonymousRequest = fetch as AnonymousRequest, timeout = 20000): Promise<BaiduHealthResult> {
  const b = book as any, share = b?.downloads?.baidu;
  if (!share) return { status: 'not-configured' };
  if (share.fileSha256 !== b.file?.sha256) return { status: 'unconfirmed', reason: '分享记录与当前文件 SHA-256 不匹配' };
  let url: URL;
  try {
    url = new URL(share.url);
    if (url.protocol !== 'https:' || url.hostname !== 'pan.baidu.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/s\/[\w-]+\/?$/u.test(url.pathname)) throw Error();
  } catch { return { status: 'unconfirmed', reason: '百度分享链接不符合安全格式' }; }
  const jar = new Map<string, string>();
  const call = async (target: URL, method: string, body?: string, referer?: string, redirects = 0) => {
    if (redirects > 5) throw Error('redirect limit');
    if (target.protocol !== 'https:' || target.hostname !== 'pan.baidu.com' || target.port || !/^\/(?:s\/|share\/)/u.test(target.pathname)) throw Error('unsafe redirect');
    const cookie = [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
    const headers: Record<string,string> = { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await request(target, { method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    for (const raw of res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])) {
      const m = /^([^=;]+)=([^;]*)/u.exec(raw); if (m) jar.set(m[1], m[2]);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location'); if (!loc) throw Error('redirect missing location');
      return call(new URL(loc, target), 'GET', undefined, target.href, redirects + 1);
    }
    if (res.status !== 200) throw Error('unexpected status');
    const len = Number(res.headers.get('content-length')); if (Number.isFinite(len) && len > 1024 * 1024) throw Error('oversize');
    const text = await res.text(); if (text.length > 1024 * 1024) throw Error('oversize');
    return text;
  };
  try {
    const first = await call(url, 'GET');
    if (/链接不存在|分享已取消|分享已失效|文件已被删除/u.test(first)) return { status: 'unavailable', reason: '百度公开页确认分享不存在或已取消' };
    const init = [...first.matchAll(/(?:https?:)?\/\/pan\.baidu\.com\/share\/init\?[^"'\s<>]+|\/share\/init\?[^"'\s<>]+/gu)][0]?.[0];
    const initUrl = init ? new URL(init.startsWith('//') ? `https:${init}` : init.startsWith('http') ? init : `https://pan.baidu.com${init}`) : new URL(`/share/init?surl=${encodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)!.replace(/^1/u,''))}`, 'https://pan.baidu.com');
    const initHtml = await call(initUrl, 'GET');
    if (/验证码|captcha|请输入验证码|安全验证|登录后/u.test(initHtml) && !/请输入提取码/u.test(initHtml)) return { status: 'unconfirmed', reason: '百度要求验证码、登录或额外验证' };
    if (!/提取码|pwd|share\/verify/u.test(initHtml + first)) return { status: 'unconfirmed', reason: '无法确认百度提取码挑战' };
    const surl = initUrl.searchParams.get('surl') ?? url.pathname.split('/').filter(Boolean).at(-1)!.replace(/^1/u, '');
    const raw = await call(new URL('/share/verify', 'https://pan.baidu.com'), 'POST', new URLSearchParams({ surl, pwd: String(share.code), vcode: '', vcode_str: '' }).toString(), initUrl.href);
    let json: any; try { json = JSON.parse(raw); } catch { return { status: 'unconfirmed', reason: '提取码挑战返回非预期响应或验证码' }; }
    if (json.errno === -9 || json.errno === 2 || json.errno === -12) return { status: 'unavailable', reason: '百度确认分享不存在或提取码无效' };
    if (json.errno !== 0) return { status: 'unconfirmed', reason: '百度未确认提取码挑战' };
    const page = await call(url, 'GET');
    if (/链接不存在|分享已取消|分享已失效/u.test(page)) return { status: 'unavailable', reason: '百度公开页确认分享不存在或已取消' };
    if (/验证码|captcha|安全验证|登录后/u.test(page)) return { status: 'unconfirmed', reason: '通过挑战后仍要求额外验证' };
    const archiveName = share.archive?.filename;
    if (archiveName && !page.includes(archiveName)) return { status: 'unconfirmed', reason: '公开页未显示书目中的 RAR 文件名' };
    if (!/文件|下载|分享/u.test(page)) return { status: 'unconfirmed', reason: '挑战成功但公开文件页无法确认' };
    return { status: 'passed' };
  } catch (e) { return { status: 'unconfirmed', reason: safe(e) }; }
}
