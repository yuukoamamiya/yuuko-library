import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Book } from '../../src/lib/books.ts';
import { validateBookCore } from '../../src/lib/book.ts';
import { CliError } from './errors.ts';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export const SOURCE_PATHS = ['src', 'public', 'catalog', 'tools', 'astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json'];
const PLAN_ID = /^p-[a-f0-9-]{36}$/u;
export type Input = { id: string; epub: string; model?: string; kind?: 'ai-translation' | 'transcription'; update?: boolean; categories?: string[] };
export type Plan = {
  schemaVersion: 1;
  id: string;
  status: 'prepared';
  createdAt: string;
  baseFingerprint: string;
  reviewHash: string;
  inventory: Record<string, string>;
  books: Book[];
  changes: { id: string; operation: 'add' | 'update'; warnings: string[] }[];
};
export class PlanError extends CliError { constructor(message: string, exitCode = 3) { super(message, exitCode); } }
export function planDir(root: string, id: string) { if (!PLAN_ID.test(id)) throw new PlanError('计划编号格式无效', 2); return path.join(root, '.local/plans', id); }
export async function exists(file: string) { try { const info = await lstat(file); if (info.isSymbolicLink()) throw new PlanError('计划或源码目录包含符号链接'); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function inventory(root: string, paths?: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    const absolute = path.join(root, relative); if (!(await exists(absolute))) return;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new PlanError(`快照包含符号链接：${relative}`);
    if (info.isDirectory()) { for (const name of (await readdir(absolute)).sort()) if (!['.astro', 'node_modules'].includes(name)) await visit(path.posix.join(relative, name)); }
    else if (info.isFile()) result[relative] = sha256(await readFile(absolute));
    else throw new PlanError(`快照包含不支持的文件类型：${relative}`);
  }
  for (const name of paths ?? (await readdir(root)).sort()) await visit(name);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function sourceFingerprint(root: string) { return sha256(JSON.stringify(await inventory(root, SOURCE_PATHS))); }
export async function readPlan(root: string, id: string): Promise<Plan> {
  const value: unknown = JSON.parse(await readFile(path.join(planDir(root, id), 'plan.json'), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError('计划格式无效');
  const candidate = value as Partial<Plan>;
  if (candidate.id !== id || candidate.schemaVersion !== 1 || candidate.status !== 'prepared' || !Array.isArray(candidate.books) || candidate.books.length < 1 || candidate.books.length > 200 || !Array.isArray(candidate.changes) || !candidate.inventory || typeof candidate.inventory !== 'object' || !/^[a-f0-9]{64}$/u.test(candidate.baseFingerprint ?? '') || !/^[a-f0-9]{64}$/u.test(candidate.reviewHash ?? '')) throw new PlanError('计划格式无效');
  const ids = new Set<string>();
  for (const book of candidate.books) {
    try { validateBookCore(book); } catch { throw new PlanError('计划书目核心字段无效'); }
    if (ids.has(book.id)) throw new PlanError('计划包含重复书籍 ID');
    ids.add(book.id);
  }
  const changedIds = new Set<string>();
  if (candidate.changes.length !== ids.size || candidate.changes.some(change => {
    if (!change || !ids.has(change.id) || changedIds.has(change.id) || !['add', 'update'].includes(change.operation)
      || !Array.isArray(change.warnings) || !change.warnings.every(warning => typeof warning === 'string')) return true;
    changedIds.add(change.id);
    return false;
  })) throw new PlanError('计划变更清单无效');
  if (Object.entries(candidate.inventory).some(([name, hash]) => typeof name !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) throw new PlanError('计划快照清单无效');
  return candidate as Plan;
}
export async function inspectPlan(root: string, plan: Plan) {
  const errors: string[] = [];
  if (await sourceFingerprint(root) !== plan.baseFingerprint) errors.push('工作区源码、配置或正式书目已经变化');
  const files = await inventory(planDir(root, plan.id), ['inputs', 'site']);
  if (JSON.stringify(files) !== JSON.stringify(plan.inventory)) errors.push('审核快照被修改或文件缺失');
  const hash = sha256(JSON.stringify({ baseFingerprint: plan.baseFingerprint, inventory: plan.inventory, books: plan.books, changes: plan.changes }));
  if (hash !== plan.reviewHash) errors.push('计划清单的审核摘要不匹配'); return errors;
}
export async function requireCurrentPlan(root: string, id: string) { const plan = await readPlan(root, id); const errors = await inspectPlan(root, plan); if (errors.length) throw new PlanError(errors.join('；')); return plan; }

export type PlanStatus =
  | { kind: 'current'; plan: Plan; blockers: string[] }
  | { kind: 'legacy-stale'; id: string; bookCount: number; changes: Plan['changes']; reason: string };

async function legacyCategoriesStaleStatus(root: string, id: string): Promise<PlanStatus | null> {
  const raw: unknown = JSON.parse(await readFile(path.join(planDir(root, id), 'plan.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<Plan>;
  if (value.id !== id || value.schemaVersion !== 1 || value.status !== 'prepared'
    || !Array.isArray(value.books) || value.books.length < 1 || value.books.length > 200
    || !Array.isArray(value.changes) || !value.inventory || typeof value.inventory !== 'object'
    || !/^[a-f0-9]{64}$/u.test(value.baseFingerprint ?? '') || !/^[a-f0-9]{64}$/u.test(value.reviewHash ?? '')) return null;

  const ids = new Set<string>();
  for (const book of value.books) {
    if (!book || typeof book !== 'object' || typeof book.id !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(book.id) || ids.has(book.id)) return null;
    ids.add(book.id);
    if (Object.hasOwn(book, 'categories')) return null;
    try { validateBookCore({ ...book, categories: ['history'] }); }
    catch { return null; }
  }

  const changedIds = new Set<string>();
  if (value.changes.length !== ids.size || value.changes.some(change => {
    if (!change || !ids.has(change.id) || changedIds.has(change.id) || !['add', 'update'].includes(change.operation)
      || !Array.isArray(change.warnings) || !change.warnings.every(warning => typeof warning === 'string')) return true;
    changedIds.add(change.id);
    return false;
  })) return null;
  if (Object.entries(value.inventory).some(([name, hash]) => typeof name !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) return null;

  return {
    kind: 'legacy-stale',
    id,
    bookCount: value.books.length,
    changes: value.changes,
    reason: '旧审核计划缺少当前必需的 categories 字段，请重新 prepare',
  };
}

export async function readPlanStatus(root: string, id: string): Promise<PlanStatus> {
  try {
    const plan = await readPlan(root, id);
    return { kind: 'current', plan, blockers: await inspectPlan(root, plan) };
  } catch (error) {
    try {
      const legacy = await legacyCategoriesStaleStatus(root, id);
      if (legacy) return legacy;
    } catch { /* Keep the original plan error when the legacy envelope is not readable. */ }
    throw error;
  }
}
