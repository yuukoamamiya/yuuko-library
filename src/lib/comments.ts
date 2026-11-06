export const COMMENTS_REPOSITORY = 'yuukoamamiya/yuuko-library-comments';

export function commentIssueTerm(bookId: string): string {
  return `book:${bookId}`;
}

export function commentIssueSearchUrl(issueTerm: string): string {
  const query = `repo:${COMMENTS_REPOSITORY} ${issueTerm} in:title`;
  return `https://github.com/issues?q=${encodeURIComponent(query)}`;
}
