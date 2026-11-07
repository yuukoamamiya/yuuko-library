import type { APIRoute } from 'astro';
import config from '../../site.config.json';
import { loadBooks } from '../lib/books';
import { buildRss } from '../lib/rss';
import { SITE_NOTICE, SITE_TITLE } from '../lib/site';

export const GET: APIRoute = async () => {
  const books = await loadBooks();
  const xml = buildRss(books, { siteUrl: config.siteUrl, title: SITE_TITLE, description: SITE_NOTICE });
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
