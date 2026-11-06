export interface SearchEntry {
  id: string;
  title: string;
  authors: string[];
  description: string;
  subjects: string[];
  categories: string[];
  publishedAt?: string | null;
}

export function compareByUploadDate(a: Pick<SearchEntry, 'id' | 'title' | 'publishedAt'>,
  b: Pick<SearchEntry, 'id' | 'title' | 'publishedAt'>): number {
  return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
}

export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
export function matches(entry: SearchEntry, query: string, subject = '', category = ''): boolean {
  const subjects = entry.subjects;
  if (category && !entry.categories.includes(category)) return false;
  if (subject && !subjects.includes(subject)) return false;
  const haystack = normalize([entry.title, ...entry.authors, entry.description, ...subjects].join(' '));
  return normalize(query).trim().split(/\s+/u).filter(Boolean).every(word => haystack.includes(word));
}
