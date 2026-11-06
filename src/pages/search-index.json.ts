import type { APIRoute } from 'astro';
import { loadBooks } from '../lib/books';

export const GET: APIRoute = async () => {
  const books = await loadBooks();
  return new Response(JSON.stringify(books.map(({ id, title, authors, description, subjects }) =>
    ({ id, title, authors, description, subjects }))), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
