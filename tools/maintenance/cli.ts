import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBooks } from '../../src/lib/books.ts';
import { runHealth } from './health.ts';
import { makeCleanupPreview } from './cleanup.ts';
import { runChecks, verificationSteps } from './check.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
function runNpm(args: string[]) {
  const cli = process.env.npm_execpath; const command = cli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const r = spawnSync(command, cli ? [cli, ...args] : args, { cwd: root, stdio: 'inherit', shell: !cli && process.platform === 'win32' });
  return { code: r.error ? 1 : (r.status ?? 1), signal: r.signal ?? null, error: r.error?.message };
}
async function verify(docOnly: boolean) {
  const steps = verificationSteps(docOnly);
  const checked = await runChecks(steps, async (name, args) => { console.error(`verify: ${name}`); const r = runNpm(args); return { code: r.code, signal: r.signal }; });
  if (checked.status !== 'passed') { console.log(JSON.stringify(checked)); return 1; }
  if (docOnly) {
    const bad: string[] = [];
    const docFiles = ['README.md', 'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', ...(await readdir(path.join(root, 'docs'))).filter(n => n.endsWith('.md')).map(n => `docs/${n}`)];
    for (const file of docFiles) {
      const text = await readFile(path.join(root, file), 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z]+:/iu.test(target) || target.startsWith('#')) continue;
        try { await lstat(path.resolve(root, path.dirname(file), target)); } catch { bad.push(`${file}: ${target}`); }
      }
    }
    if (bad.length) { console.log(JSON.stringify({ status: 'failed', results: [{ step: 'docs-links', exitCode: 1, signal: null }], failures: bad })); return 1; }
  }
  console.error('verify: git diff --check');
  const diff = spawnSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
  if (diff.error || diff.status !== 0) { console.log(JSON.stringify({ status: 'failed', results: [{ step: 'git diff --check', exitCode: diff.status ?? 1, signal: diff.signal ?? null }] })); return 1; }
  const staged = spawnSync('git', ['diff', '--cached', '--check'], { cwd: root, stdio: 'inherit' });
  if (staged.error || staged.status !== 0) { console.log(JSON.stringify({ status: 'failed', results: [{ step: 'git diff --cached --check', exitCode: staged.status ?? 1, signal: staged.signal ?? null }] })); return 1; }
  console.log(JSON.stringify({ status: 'passed', mode: docOnly ? 'docs' : 'full', steps: [...steps.map(([n]) => n), ...(docOnly ? ['docs-links'] : []), 'git diff --check', 'git diff --cached --check'] })); return 0;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { help: { type: 'boolean' }, docs: { type: 'boolean' }, 'full-download': { type: 'boolean' }, book: { type: 'string' }, url: { type: 'string' }, timeout: { type: 'string' } } });
  const cmd = positionals[0];
  if (positionals.length > 1) throw new Error('只接受一个子命令');
  if (values.help || !cmd) { console.log('维护入口：\n  npm run verify [-- --docs]\n  npm run maintenance -- health [--url HTTPS_URL] [--book ID] [--full-download] [--timeout MS]\n  npm run maintenance -- cleanup-preview\nverify 默认依次运行 check、test、build、git diff --check；--docs 仅检查 Markdown 本地链接与 diff，不运行测试、构建或云服务。health 对正式网站执行只读检查，不修改书目。默认下载检查为 HEAD，不等同完整内容校验；--full-download 流式核对大小及 SHA-256。cleanup-preview 仅生成只读清单，不提供删除操作。'); return; }
  if (cmd !== 'verify' && values.docs) throw new Error('--docs 仅用于 verify');
  if (cmd !== 'health' && (values.book || values.url || values['full-download'] || values.timeout)) throw new Error('--book、--url、--full-download、--timeout 仅用于 health');
  if (cmd === 'verify') { process.exitCode = await verify(values.docs ?? false); return; }
  if (cmd === 'cleanup-preview') { const result = await makeCleanupPreview(root); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.unknown.length ? 1 : 0; return; }
  if (cmd === 'health') {
    const timeout = Number(values.timeout ?? 20000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('--timeout 必须是 1000–120000 的整数毫秒');
    const books = await loadBooks(); const picked = values.book ? books.filter(book => book.id === values.book) : books;
    if (!picked.length) throw new Error('--book 未匹配正式书目 ID');
    const summary = await runHealth(root, picked, values.url, values['full-download'] ?? false, timeout, fetch, books);
    console.log(JSON.stringify({ ...summary, scope: values.book ? 'sample' : 'catalog', checkedBooks: picked.length, catalogBooks: books.length, fullDownload: values['full-download'] ?? false }, null, 2));
    process.exitCode = summary.failures.length ? 1 : 0; return;
  }
  throw new Error('命令无效；运行 --help 查看帮助');
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
