import test from 'node:test';
import assert from 'node:assert/strict';
import { commentIssueSearchUrl, commentIssueTerm, COMMENTS_REPOSITORY } from '../src/lib/comments';
import { readFile } from 'node:fs/promises';

test('comment issue identity is derived only from the stable book ID', () => {
  assert.equal(commentIssueTerm('stable-book-42'), 'book:stable-book-42');
  const url = new URL(commentIssueSearchUrl(commentIssueTerm('stable-book-42')));
  assert.equal(url.hostname, 'github.com');
  assert.match(url.searchParams.get('q') ?? '', new RegExp(`repo:${COMMENTS_REPOSITORY.replace('/', '\\/')}`));
  assert.match(url.searchParams.get('q') ?? '', /book:stable-book-42/);
});

test('preview markup cannot initialize the third-party comments script', async () => {
  const component = await readFile(new URL('../src/components/BookComments.astro', import.meta.url), 'utf8');
  assert.match(component, /data-comments\]\[data-preview="false"\]/);
  assert.match(component, /preview \? <p>本地预览不加载评论/);
  assert.match(component, /script\.src = 'https:\/\/utteranc\.es\/client\.js'/);
});
