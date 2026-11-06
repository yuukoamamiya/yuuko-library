export interface SearchEntry {
  id: string;
  title: string;
  authors: string[];
  description: string;
  subjects: string[];
  categories: string[];
}

export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
export function matches(entry: SearchEntry, query: string, subject = '', category = ''): boolean {
  const subjects = entry.subjects;
  if (category && !entry.categories.includes(category)) return false;
  if (subject && !subjects.includes(subject)) return false;
  const haystack = normalize([entry.title, ...entry.authors, entry.description, ...subjects].join(' '));
  return normalize(query).trim().split(/\s+/u).filter(Boolean).every(word => haystack.includes(word));
}
