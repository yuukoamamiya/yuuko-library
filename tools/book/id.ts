import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function isIsbn13(value: string): boolean {
  if (!/^\d{13}$/u.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(value[12]);
}

export async function readNoIsbnIds(root: string): Promise<Set<string>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(root, 'catalog/no-isbn.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error('catalog/no-isbn.json 格式无效');
  }
  if (!Array.isArray(value)) throw new Error('catalog/no-isbn.json 格式无效');
  return new Set(value.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.title !== 'string' || !entry.title.trim()) {
      throw new Error('catalog/no-isbn.json 格式无效');
    }
    return entry.id;
  }));
}

export function assertBookId(id: string, noIsbnIds: Set<string>): void {
  if (isIsbn13(id) || noIsbnIds.has(id)) return;
  throw new Error('书籍 ID 必须为 ISBN-13；无 ISBN 的条目需先登记到 catalog/no-isbn.json 并使用原文标题的 slug');
}
