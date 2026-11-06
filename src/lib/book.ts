import { validateCategories } from './categories';

export interface BaiduDownload {
  url: string; code: string; fileSha256: string; fsId: string; shareId: string; path: string;
  expiresAt: null; verifiedAt: string;
  archive?: { filename: string; sha256: string; bytes: number; password: string };
}

export interface Book {
  schemaVersion: 1; id: string; title: string; authors: string[]; description: string;
  subjects: string[]; categories: string[]; cover: string | null;
  edition: { kind: 'ai-translation'; model: string } | { kind: 'transcription'; model: null };
  file: { sha256: string; bytes: number; filename: string };
  downloads: { r2Key: string; r2Url: string | null; baidu: BaiduDownload | null };
  publishedAt: string | null; updatedAt: string | null;
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown) => typeof v === 'string';
const nullableString = (v: unknown) => v === null || string(v);
const sha = /^[a-f\d]{64}$/iu;
function validDate(v: unknown) {
  if (v === undefined || v === null) return true;
  if (string(v) && /^\d{4}-\d{2}-\d{2}$/u.test(v)) {
    const date = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
  }
  if (!string(v) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(v)) return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString().replace(/\.000Z$/u, 'Z') === v.replace(/\.0+Z$/u, 'Z');
}

/** Validate the fields needed by the site; the optional Baidu payload is validated only at use/write boundaries. */
export function validateBookCore(value: unknown): asserts value is Book {
  if (!object(value) || value.schemaVersion !== 1 || !string(value.id) || value.id.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id)
    || !string(value.title) || !Array.isArray(value.authors) || !value.authors.every(string)
    || !string(value.description) || !Array.isArray(value.subjects) || !value.subjects.every(string)
    || !nullableString(value.cover) || !object(value.edition)
    || !((value.edition.kind === 'ai-translation' && string(value.edition.model) && value.edition.model.length > 0)
      || (value.edition.kind === 'transcription' && value.edition.model === null))
    || !object(value.file) || !string(value.file.sha256) || !sha.test(value.file.sha256)
    || !Number.isSafeInteger(value.file.bytes) || (value.file.bytes as number) <= 0 || !string(value.file.filename)
    || !object(value.downloads) || !string(value.downloads.r2Key) || !nullableString(value.downloads.r2Url)
    || !validDate(value.publishedAt) || !validDate(value.updatedAt)) throw new Error('书目核心字段无效');
  validateCategories(value.categories);
}
