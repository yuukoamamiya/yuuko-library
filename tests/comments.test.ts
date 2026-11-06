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
