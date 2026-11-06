export interface SearchEntry {
  id: string;
  title: string;
  authors: string[];
  description: string;
  subjects: string[];
}

export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
export function matches(entry: SearchEntry, query: string, subject = ''): boolean {
  const subjects = entry.subjects.length ? entry.subjects : ['未分类'];
  if (subject && !subjects.includes(subject)) return false;
  const haystack = normalize([entry.title, ...entry.authors, entry.description, ...subjects].join(' '));
  return normalize(query).trim().split(/\s+/u).filter(Boolean).every(word => haystack.includes(word));
}
