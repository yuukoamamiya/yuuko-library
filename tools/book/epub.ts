import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { convert } from 'html-to-text';

const XML_LIMIT = 4 * 1024 * 1024;
const COVER_LIMIT = 20 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
  parseTagValue: false, parseAttributeValue: false, trimValues: false });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' ? value.trim()
  : typeof value === 'object' && value !== null ? text((value as Record<string, unknown>)['#text']) : '';
const xml = (buffer: Buffer) => {
  const value = buffer.toString('utf8');
  if (/<!\s*(DOCTYPE|ENTITY)\b/iu.test(value)) throw new Error('EPUB XML 不允许 DTD 或外部实体');
  SyntaxValidator.validate(value);
  return parser.parse(value);
};

export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer,
    { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip!)));
}
function entriesOf(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    zip.on('error', reject);
    zip.on('entry', (entry: Entry) => {
      if (entries.size > 30000) { reject(new Error('EPUB 条目过多')); zip.close(); return; }
      if (entries.has(entry.fileName)) { reject(new Error('EPUB 包含重复路径')); zip.close(); return; }
      entries.set(entry.fileName, entry); zip.readEntry();
    });
    zip.on('end', () => resolve(entries)); zip.readEntry();
  });
}
function readEntry(zip: ZipFile, entries: Map<string, Entry>, name: string, limit = XML_LIMIT): Promise<Buffer> {
  const entry = entries.get(name);
  if (!entry || entry.uncompressedSize > limit) throw new Error(`EPUB 条目缺失或过大：${name}`);
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error('无法读取 EPUB')); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { stream.destroy(new Error('EPUB 条目超过读取上限')); return; }
      chunks.push(chunk);
    });
    stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks)));
  }));
}
function zipPath(base: string, href: string) {
  const decoded = decodeURIComponent(href);
  if (/[\\\0]/u.test(decoded) || /^[a-z]+:/iu.test(decoded) || decoded.startsWith('/')) throw new Error('EPUB 路径不合法');
  const joined = path.posix.normalize(path.posix.join(base, decoded));
  if (joined === '..' || joined.startsWith('../')) throw new Error('EPUB 路径超出根目录');
  return joined;
}
function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

export async function extractEpub(filename: string) {
  if ((await stat(filename)).size > 256 * 1024 * 1024) throw new Error('EPUB 超过 256 MB 上限');
  const bytes = await readFile(filename);
  if (bytes.length > 256 * 1024 * 1024) throw new Error('EPUB 超过 256 MB 上限');
  const zip = await openZip(bytes);
  try {
    const entries = await entriesOf(zip);
    const container = xml(await readEntry(zip, entries, 'META-INF/container.xml'));
    const roots = array<Record<string, string>>(container.container?.rootfiles?.rootfile);
    const rootfile = roots.find(root => root['@_media-type'] === 'application/oebps-package+xml') ?? roots[0];
    if (!rootfile?.['@_full-path']) throw new Error('EPUB 没有 OPF 入口');
    const opfPath = zipPath('', rootfile['@_full-path']);
    const opf = xml(await readEntry(zip, entries, opfPath)).package;
    if (!opf?.metadata) throw new Error('EPUB 没有 metadata');
    const metadata = opf.metadata;
    const values = (key: string) => array(metadata[key]).map(text).filter(Boolean);
    const title = values('title')[0];
    if (!title) throw new Error('EPUB 缺少书名');
    const authors = values('creator');
    const description = values('description').map(value => convert(value, { wordwrap: false,
      selectors: [{ selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] })).join('\n\n');
    const subjects = [...new Set(values('subject'))];
    const warnings: string[] = [];
    if (!authors.length) warnings.push('作者未提供');
    if (!description) warnings.push('简介未提供');
    if (!subjects.length) warnings.push('分类未提供，将显示“未分类”');
    const items = array<Record<string, string>>(opf.manifest?.item);
    const coverId = array<Record<string, string>>(metadata.meta).find(m => m['@_name'] === 'cover')?.['@_content'];
    const coverItem = items.find(item => item['@_properties']?.split(/\s+/u).includes('cover-image'))
      ?? items.find(item => coverId && item['@_id'] === coverId);
    let cover: { bytes: Buffer; extension: string } | null = null;
    if (coverItem?.['@_href']) {
      const image = await readEntry(zip, entries, zipPath(path.posix.dirname(opfPath), coverItem['@_href']), COVER_LIMIT);
      const extension = imageExtension(image);
      if (extension) cover = { bytes: image, extension };
      else warnings.push('封面不是支持的位图格式，使用占位封面');
    } else warnings.push('封面未提供');
    return { title, authors, description, subjects, cover, warnings, bytes: bytes.length, sha256: sha256(bytes) };
  } finally { zip.close(); }
}
