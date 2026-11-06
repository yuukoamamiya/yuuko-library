import test from 'node:test';
import assert from 'node:assert/strict';
import { commentIssueSearchUrl, commentIssueTerm, COMMENTS_REPOSITORY } from '../src/lib/comments';

test('comment issue identity is derived only from the stable book ID', () => {
  assert.equal(commentIssueTerm('stable-book-42'), 'book:stable-book-42');
  const url = new URL(commentIssueSearchUrl(commentIssueTerm('stable-book-42')));
  assert.equal(url.hostname, 'github.com');
  assert.match(url.searchParams.get('q') ?? '', new RegExp(`repo:${COMMENTS_REPOSITORY.replace('/', '\\/')}`));
  assert.match(url.searchParams.get('q') ?? '', /book:stable-book-42/);
});

test('SSR embed and GitHub search link share the configured repository', async () => {
  const { readFile } = await import('node:fs/promises');
  const component = await readFile(new URL('../src/components/BookComments.astro', import.meta.url), 'utf8');
  assert.match(component, /data-comments-repository=\{COMMENTS_REPOSITORY\}/u);
  assert.match(component, /setAttribute\('repo', root\.dataset\.commentsRepository/u);
  const url = new URL(commentIssueSearchUrl(commentIssueTerm('same-book')));
  assert.ok(url.searchParams.get('q')?.includes(`repo:${COMMENTS_REPOSITORY}`));
});
