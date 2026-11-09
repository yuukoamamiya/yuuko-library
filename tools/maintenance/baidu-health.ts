import type { Book, DownloadMirror } from '../../src/lib/book.ts';
import { validateBaiduMirror } from '../../src/lib/baidu.ts';

export type BaiduHealthResult = { status: 'passed' | 'unavailable' | 'unconfirmed' | 'not-configured'; reason?: string };
type AnonymousRequest = (url: URL, init: RequestInit) => Promise<Response>;
const safe = (e: unknown) => e instanceof Error && e.name === 'TimeoutError' ? '请求超时' : '网络或响应格式未能确认';
const maxBytes = 1024 * 1024;
const htmlText = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '')
  .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/giu, '')
  .replace(/<([a-z][\w:-]*)\b(?=[^>]*(?:\shidden\b|\saria-hidden\s*=\s*["']true["']|\sstyle\s*=\s*["'][^"']*display\s*:\s*none))[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
  .replace(/<[^>]*>/gu, ' ').replace(/&(?:nbsp|#160);/giu, ' ').replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/&lt;/giu, '<').replace(/&gt;/giu, '>');

/** Anonymous, read-only check. The cookie jar exists only for this one book. */
export async function checkBaiduShare(book: Book, mirror: DownloadMirror, request: AnonymousRequest = fetch as AnonymousRequest, timeout = 20000): Promise<BaiduHealthResult> {
  if (mirror === null || mirror === undefined) return { status: 'not-configured' };
  if (typeof mirror !== 'object' || Array.isArray(mirror)) return { status: 'unconfirmed', reason: '百度分享记录格式无效' };
  if (mirror.fileSha256 !== book.file?.sha256) return { status: 'unconfirmed', reason: '分享记录与当前文件 SHA-256 不匹配' };
  let shareUrl: URL;
  try {
    shareUrl = new URL(mirror.url);
    if (shareUrl.protocol !== 'https:' || shareUrl.hostname !== 'pan.baidu.com' || shareUrl.username || shareUrl.password || shareUrl.port || shareUrl.search || shareUrl.hash || !/^\/s\/[\w-]+\/?$/u.test(shareUrl.pathname)) throw Error();
  } catch { return { status: 'unconfirmed', reason: '百度分享链接不符合安全格式' }; }
  try { validateBaiduMirror(mirror, book.file.sha256); }
  catch (error) { return { status: 'unconfirmed', reason: (error as Error).message }; }

  const jar = new Map<string, string>();
  const call = async (target: URL, method: string, body?: string, referer?: string, redirects = 0): Promise<{ text: string; finalUrl: URL }> => {
    if (redirects > 5 || target.protocol !== 'https:' || target.hostname !== 'pan.baidu.com' || target.username || target.password || target.port || !/^\/(?:s\/|share\/)/u.test(target.pathname)) throw Error('unsafe target');
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}), ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await request(target, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    for (const raw of res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])) {
      const m = /^([^=;]+)=([^;]*)/u.exec(raw);
      if (m && !/^(?:BDUSS|STOKEN|PTOKEN|BDUSS_BFESS)$/iu.test(m[1])) jar.set(m[1], m[2]);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location'); if (!location) throw Error('redirect without location');
      return call(new URL(location, target), 'GET', undefined, target.href, redirects + 1);
    }
    if (res.status !== 200) throw Error('unexpected status');
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { await res.body?.cancel(); throw Error('oversize'); }
    if (!res.body) return { text: '', finalUrl: target };
    const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw Error('oversize'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return { text: new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c)))), finalUrl: target };
  };

  try {
    const shareId = shareUrl.pathname.split('/').filter(Boolean).at(-1)!;
    const surl = shareId.replace(/^1/u, '');
    const initial = await call(shareUrl, 'GET');
    let challenge = initial;
    if (!/提取码|pwd|share\/verify/iu.test(initial.text)) {
      const initRef = /(?:https?:)?\/\/pan\.baidu\.com\/share\/init\?[^"'\s<>]+|\/share\/init\?[^"'\s<>]+/u.exec(initial.text)?.[0];
      const initUrl = initRef ? new URL(initRef.startsWith('//') ? `https:${initRef}` : initRef.startsWith('http') ? initRef : `https://pan.baidu.com${initRef}`) : initial.finalUrl.pathname === '/share/init' ? initial.finalUrl : null;
      if (!initUrl) {
        const visible = htmlText(initial.text);
        if (/链接不存在|分享已取消|分享已失效|文件已被删除/u.test(visible)) return { status: 'unavailable', reason: '百度公开页确认分享不存在或已取消' };
        return { status: 'unconfirmed', reason: '无法识别百度提取码挑战页面' };
      }
      challenge = await call(initUrl, 'GET', undefined, initial.finalUrl.href);
    }
    const visibleChallenge = htmlText(challenge.text);
    if (/请输入验证码|安全验证|请完成验证|验证码输入|登录后继续/iu.test(visibleChallenge)) return { status: 'unconfirmed', reason: '百度要求验证码、登录或额外验证' };
    if (!/提取码|pwd|share\/verify/iu.test(challenge.text)) return { status: 'unconfirmed', reason: '无法确认百度提取码挑战' };

    // Baidu expects surl in the endpoint query; the form contains only challenge fields.
    const verifyUrl = new URL('/share/verify', 'https://pan.baidu.com'); verifyUrl.searchParams.set('surl', surl);
    const raw = await call(verifyUrl, 'POST', new URLSearchParams({ pwd: String(mirror.code), vcode: '', vcode_str: '' }).toString(), challenge.finalUrl.href);
    let json: any; try { json = JSON.parse(raw.text); } catch { return { status: 'unconfirmed', reason: '提取码挑战返回非预期响应或验证码' }; }
    if (json.errno === -9) return { status: 'unavailable', reason: '百度确认提取码无效或分享不可用' };
    if (json.errno !== 0) return { status: 'unconfirmed', reason: '百度未确认提取码挑战' };

    const finalPage = await call(shareUrl, 'GET');
    const visiblePage = htmlText(finalPage.text);
    if (/链接不存在|分享已取消|分享已失效|文件已被删除/u.test(visiblePage)) return { status: 'unavailable', reason: '百度公开页确认分享不存在或已取消' };
    if (/请输入提取码|提取码输入|请输入验证码|安全验证|登录后继续/iu.test(visiblePage) || /\/share\/init(?:\?|$)/u.test(finalPage.finalUrl.pathname + finalPage.finalUrl.search)) return { status: 'unconfirmed', reason: '挑战后仍停留在验证页' };
    const expectedFilename = mirror.archive?.filename ?? book.file.filename;
    if (typeof expectedFilename !== 'string' || !visiblePage.includes(expectedFilename)) return { status: 'unconfirmed', reason: '公开文件页未显示与书目一致的文件名' };
    return { status: 'passed' };
  } catch (e) { return { status: 'unconfirmed', reason: safe(e) }; }
}
