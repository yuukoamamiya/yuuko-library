export const CATEGORIES = [
  { id: 'philosophy', label: '哲学' },
  { id: 'politics-society', label: '政治与社会理论' },
  { id: 'political-economy', label: '政治经济学' },
  { id: 'history', label: '历史' },
  { id: 'culture-media', label: '文化与媒介' },
  { id: 'language-translation', label: '语言与翻译' },
] as const;
export const categoryLabel = (id: string) => CATEGORIES.find(category => category.id === id)?.label ?? '未分类';
export function validateCategories(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || new Set(value).size !== value.length
    || value.some(id => !CATEGORIES.some(category => category.id === id))) throw new Error('分类必须为 1–2 个不同的有效分类 ID');
}
