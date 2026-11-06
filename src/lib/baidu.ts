import type { BaiduDownload } from './books';

const sha256Pattern = /^[a-f\d]{64}$/iu;
const numericIdPattern = /^\d+$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export function validateBaiduDownload(value: unknown, expectedSha256: string): asserts value is BaiduDownload {
  if (!value || typeof value !== 'object') throw new Error('百度下载记录无效');
  const record = value as Partial<BaiduDownload>;
  let url: URL;
  try { url = new URL(record.url ?? ''); } catch { throw new Error('百度分享链接无效'); }
  if (url.protocol !== 'https:' || url.hostname !== 'pan.baidu.com' || url.username || url.password
    || url.port || url.search || url.hash || !/^\/s\/[A-Za-z\d_-]+\/?$/u.test(url.pathname)) {
    throw new Error('百度分享链接必须为安全的 pan.baidu.com 分享地址');
  }
  if (typeof record.code !== 'string' || !/^[A-Za-z\d]{4}$/u.test(record.code)) throw new Error('百度提取码无效');
  if (typeof record.fileSha256 !== 'string' || !sha256Pattern.test(record.fileSha256)
    || record.fileSha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('百度分享文件哈希与当前 EPUB 不匹配');
  if (typeof record.path !== 'string' || !record.path.startsWith('/') || record.path.includes('..') || /[\u0000-\u001f]/u.test(record.path)) throw new Error('百度网盘路径无效');
  if (typeof record.fsId !== 'string' || !numericIdPattern.test(record.fsId)
    || typeof record.shareId !== 'string' || !numericIdPattern.test(record.shareId)) throw new Error('百度分享标识无效');
  if (record.expiresAt !== null) throw new Error('百度分享必须为永久分享');
  if (typeof record.verifiedAt !== 'string' || !isoDatePattern.test(record.verifiedAt) || !Number.isFinite(Date.parse(record.verifiedAt))) throw new Error('百度验证时间无效');
}
