import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './epub.ts';
import type { Book } from '../../src/lib/books.ts';

export const SOURCE_PATHS = ['src', 'public', 'catalog', 'tools', 'astro.config.mjs', 'site.config.json', 'package.json', 'package-lock.json', 'tsconfig.json'];
const PLAN_ID = /^p-[a-f0-9-]{36}$/u;
export type Input = { id: string; epub: string; model?: string; kind?: 'ai-translation' | 'transcription'; update?: boolean; categories?: string[] };
export type Plan = { schemaVersion: 1; id: string; status: 'prepared'; createdAt: string; baseFingerprint: string; reviewHash: string; inventory: Record<string, string>; books: Book[]; changes: { id: string; operation: 'add' | 'update'; warnings: string[] }[] };
export class PlanError extends Error { constructor(message: string, readonly exitCode = 3) { super(message); } }
export function planDir(root: string, id: string) { if (!PLAN_ID.test(id)) throw new PlanError('计划编号格式无效'); return path.join(root, '.local/plans', id); }
export async function exists(file: string) { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function inventory(root: string, paths?: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    const absolute = path.join(root, relative); if (!(await exists(absolute))) return;
    const info = await stat(absolute);
    if (info.isDirectory()) { for (const name of (await readdir(absolute)).sort()) if (!['.astro', 'node_modules'].includes(name)) await visit(path.posix.join(relative, name)); }
    else if (info.isFile()) result[relative] = sha256(await readFile(absolute));
  }
  for (const name of paths ?? (await readdir(root)).sort()) await visit(name);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function sourceFingerprint(root: string) { return sha256(JSON.stringify(await inventory(root, SOURCE_PATHS))); }
export async function readPlan(root: string, id: string): Promise<Plan> {
  const plan: Plan = JSON.parse(await readFile(path.join(planDir(root, id), 'plan.json'), 'utf8'));
  if (plan.id !== id || plan.schemaVersion !== 1) throw new PlanError('计划格式无效'); return plan;
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
