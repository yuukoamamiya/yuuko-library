import type { APIRoute } from 'astro';
import { loadBooks } from '../lib/books';

export const GET: APIRoute = async () => {
  const books = await loadBooks();
  return new Response(JSON.stringify(books.map(({ id, title, authors, description, subjects, categories, publishedAt }) =>
    ({ id, title, authors, description, subjects, categories, publishedAt }))), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
