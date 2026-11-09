import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCatalog } from '../catalog.ts';
import { runHealth } from './health.ts';
import { makeCleanupPreview } from './cleanup.ts';
import { verify as runVerify } from './verify.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
function runNpm(args: string[]) {
  const cli = process.env.npm_execpath; const command = cli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const r = spawnSync(command, cli ? [cli, ...args] : args, { cwd: root, stdio: 'inherit', shell: !cli && process.platform === 'win32' });
  return { code: r.error ? 1 : (r.status ?? 1), signal: r.signal ?? null, error: r.error?.message };
}
function runGit(args: string[]) {
  const r = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  return { code: r.error ? 1 : (r.status ?? 1), signal: r.signal ?? null };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { help: { type: 'boolean' }, docs: { type: 'boolean' }, 'full-download': { type: 'boolean' }, 'skip-baidu': { type: 'boolean' }, 'skip-provider': { type: 'string', multiple: true }, book: { type: 'string' }, url: { type: 'string' }, timeout: { type: 'string' } } });
  const cmd = positionals[0];
  if (positionals.length > 1) throw new Error('只接受一个子命令');
  if (values.help || !cmd) { console.log('维护入口：\n  npm run verify [-- --docs]\n  npm run maintenance -- health [--url HTTPS_URL] [--book ID] [--full-download] [--skip-provider PROVIDER] [--skip-baidu] [--timeout MS]\n  npm run maintenance -- cleanup-preview\nverify 默认依次运行 check、test、build、git diff --check；--docs 仅检查 Markdown 本地链接与 diff，不运行测试、构建或云服务。health 对正式网站执行只读检查，不修改书目。默认下载检查为 HEAD，不等同完整内容校验；--full-download 流式核对大小及 SHA-256。health 默认也检查网盘镜像；--skip-provider 可跳过指定 provider，--skip-baidu 等同于 --skip-provider baidu。cleanup-preview 仅生成只读清单，不提供删除操作。'); return; }
  if (cmd !== 'verify' && values.docs) throw new Error('--docs 仅用于 verify');
  if (cmd !== 'health' && (values.book || values.url || values['full-download'] || values['skip-baidu'] || values['skip-provider'] || values.timeout)) throw new Error('--book、--url、--full-download、--skip-provider、--skip-baidu、--timeout 仅用于 health');
  if (cmd === 'verify') {
    const result = await runVerify(root, values.docs ?? false, async (name, args) => { console.error(`verify: ${name}`); return runNpm(args); }, async args => { console.error(`verify: git ${args.join(' ')}`); return runGit(args); });
    console.log(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : 1; return;
  }
  if (cmd === 'cleanup-preview') { const result = await makeCleanupPreview(root); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.unknown.length ? 1 : 0; return; }
  if (cmd === 'health') {
    const timeout = Number(values.timeout ?? 20000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('--timeout 必须是 1000–120000 的整数毫秒');
    const books = await readCatalog(root); const picked = values.book ? books.filter(book => book.id === values.book) : books;
    if (!picked.length) throw new Error('--book 未匹配正式书目 ID');
    const skipProviders = [...(values['skip-provider'] ?? [])];
    if (values['skip-baidu'] && !skipProviders.includes('baidu')) skipProviders.push('baidu');
    const summary = await runHealth(root, picked, values.url, values['full-download'] ?? false, timeout, fetch, books, { mirrors: true, skipProviders });
    console.log(JSON.stringify({ ...summary, scope: values.book ? 'sample' : 'catalog', checkedBooks: picked.length, catalogBooks: books.length, fullDownload: values['full-download'] ?? false, mirrorsSkipped: skipProviders }, null, 2));
    process.exitCode = summary.failures.length ? 1 : 0; return;
  }
  throw new Error('命令无效；运行 --help 查看帮助');
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
