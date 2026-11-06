import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runChecks, verificationSteps, type StepRunner } from './check.ts';

export type GitCheckRunner = (args: string[]) => Promise<{ code: number; signal?: string | null }>;

async function checkDocumentLinks(root: string): Promise<string[]> {
  const bad: string[] = [];
  const docFiles = ['README.md', 'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', ...(await readdir(path.join(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  for (const file of docFiles) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/iu.test(target) || target.startsWith('#')) continue;
      try { await lstat(path.resolve(root, path.dirname(file), target)); } catch { bad.push(`${file}: ${target}`); }
    }
  }
  return bad;
}

/** Run local verification using injected command runners; importing this service does no work. */
export async function verify(root: string, docOnly: boolean, runner: StepRunner, gitRunner: GitCheckRunner) {
  const steps = verificationSteps(docOnly);
  const checked = await runChecks(steps, runner);
  if (checked.status !== 'passed') return { ...checked, status: 'failed' as const };
  if (docOnly) {
    const bad = await checkDocumentLinks(root);
    if (bad.length) return { status: 'failed' as const, results: [{ step: 'docs-links', exitCode: 1, signal: null }], failures: bad };
  }
  const results = [];
  for (const [step, args] of [['git diff --check', ['diff', '--check']], ['git diff --cached --check', ['diff', '--cached', '--check']]] as const) {
    let result: { code: number; signal?: string | null };
    try { result = await gitRunner([...args]); } catch { result = { code: 1 }; }
    const item = { step, exitCode: result.code, signal: result.signal ?? null };
    results.push(item);
    if (item.exitCode !== 0 || item.signal) return { status: 'failed' as const, results, failure: item };
  }
  return { status: 'passed' as const, mode: docOnly ? 'docs' as const : 'full' as const,
    steps: [...steps.map(([name]) => name), ...(docOnly ? ['docs-links'] : []), 'git diff --check', 'git diff --cached --check'] };
}
