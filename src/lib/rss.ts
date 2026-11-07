import type { Book } from './book';
import { compareByUploadDate } from './search';

export interface FeedOptions {
  siteUrl: string;
  title: string;
  description: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export const escapeXml = (value: string) => value.replace(/[&<>"']/gu, character => ESCAPES[character]);

export function buildRss(books: Book[], options: FeedOptions): string {
  const published = books
    .filter((book): book is Book & { publishedAt: string } => Boolean(book.publishedAt))
    .sort(compareByUploadDate);
  const base = options.siteUrl.replace(/\/+$/u, '');
  const lastBuildDate = published[0] ? new Date(published[0].publishedAt).toUTCString() : new Date(0).toUTCString();
  const items = published.map(book => {
    const link = `${base}/books/${book.id}/`;
    return [
      '    <item>',
      `      <title>${escapeXml(book.title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
      `      <pubDate>${new Date(book.publishedAt).toUTCString()}</pubDate>`,
      `      <dc:creator>${escapeXml(book.authors.join(' / '))}</dc:creator>`,
      `      <description>${escapeXml(book.description || book.title)}</description>`,
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeXml(options.title)}</title>`,
    `    <link>${escapeXml(`${base}/`)}</link>`,
    `    <description>${escapeXml(options.description)}</description>`,
    '    <language>zh-CN</language>',
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(`${base}/rss.xml`)}" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
