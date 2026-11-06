import type { BaiduDownload } from './book';

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
  if (record.archive !== undefined) {
    const archive = record.archive;
    if (!archive || typeof archive !== 'object') throw new Error('RAR 压缩包记录无效');
    if (typeof archive.filename !== 'string' || archive.filename.trim() !== archive.filename
      || /[\\/:*?"<>|\u0000-\u001f]/u.test(archive.filename) || /[. ]$/u.test(archive.filename)
      || archive.filename === '.' || archive.filename === '..' || !/\.rar$/iu.test(archive.filename)) {
      throw new Error('RAR 文件名必须是安全的单级 .rar 文件名');
    }
    if (typeof archive.sha256 !== 'string' || !sha256Pattern.test(archive.sha256)) throw new Error('RAR 文件 SHA-256 无效');
    if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) throw new Error('RAR 文件大小无效');
    if (typeof archive.password !== 'string' || archive.password.trim().length === 0
      || archive.password.length > 256 || /[\u0000-\u001f\u007f]/u.test(archive.password)) throw new Error('RAR 解压密码无效');
  }
}
