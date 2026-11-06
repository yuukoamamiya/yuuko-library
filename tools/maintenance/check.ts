export type StepRunner = (name: string, args: string[]) => Promise<{ code: number; signal?: string | null }>;
export const verificationSteps = (docOnly: boolean): [string, string[]][] => docOnly ? [] : [['check', ['run', 'check']], ['test', ['test']], ['build', ['run', 'build']]];
export async function runChecks(steps: [string, string[]][], runner: StepRunner) {
  const results: { step: string; exitCode: number; signal: string | null }[] = [];
  for (const [step, args] of steps) {
    let result: { code: number; signal?: string | null };
    try { result = await runner(step, args); } catch { result = { code: 1 }; }
    results.push({ step, exitCode: result.code, signal: result.signal ?? null });
    if (result.code !== 0 || result.signal) return { status: 'failed', results, failure: results.at(-1) };
  }
  return { status: 'passed', results };
}
