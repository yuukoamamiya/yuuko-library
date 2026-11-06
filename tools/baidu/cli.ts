import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBooks } from '../../src/lib/books.ts';
import { createRunner, loadJournal, locateInputs, runPublish, BaiduError } from './transfer.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `百度网盘维护工具（无 WSL）
  npm run baidu -- status [--id ID|--all]       本地只读查看书目、源 EPUB 与 journal
  npm run baidu -- prepare [--id ID|--all]      本地只读完整 SHA-256 盘点
  npm run baidu -- publish --id ID|--all [--password CODE]  显式执行上传、回读、永久分享与书目更新

publish --all 是显式批量云写；状态未知时停止，不盲目重复分享。提取码随分享记录写入本地 journal 与公开书目；账号登录凭据始终留在仓库外。`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, id: { type: 'string' }, all: { type: 'boolean' }, password: { type: 'string' },
  } });
  const command = positionals[0];
  if (!command || values.help) { console.log(help); return; }
  if (positionals.length !== 1 || !['status', 'prepare', 'publish'].includes(command)) throw new Error('命令无效；运行 npm run baidu -- --help');
  if (values.id && values.all) throw new Error('--id 与 --all 不能同时使用');
  if (command === 'publish' && !values.id && !values.all) throw new Error('publish 必须显式指定 --id ID 或 --all');
  if (values.password && (command !== 'publish' || !/^[a-z\d]{4}$/iu.test(values.password))) throw new Error('--password 仅用于 publish，须为4位字母或数字');
  const books = await loadBooks();
  const selected = values.id ? books.filter(book => book.id === values.id) : (values.all || command !== 'publish' ? books : []);
  if (values.id && selected.length !== 1) throw new Error(`找不到正式书目 ID：${values.id}`);
  const journalFile = path.join(root, '.local/baidu/journal.json'); const journal = await loadJournal(journalFile);
  if (command === 'status') {
    const inputs = await locateInputs(root, selected);
    console.log(JSON.stringify({ mode: 'read-only', books: selected.map(book => ({ id: book.id, sha256: book.file.sha256,
      bytes: book.file.bytes, source: inputs.get(book.id)?.file ?? null, catalogBaidu: book.downloads.baidu,
      journal: journal.entries[book.id] ?? null })) }, null, 2)); return;
  }
  if (command === 'prepare') {
    const inputs = await locateInputs(root, selected);
    console.log(JSON.stringify({ mode: 'read-only', books: selected.map(book => ({ id: book.id, sha256: book.file.sha256,
      bytes: book.file.bytes, source: inputs.get(book.id)?.file, state: journal.entries[book.id]?.state ?? 'ready' })) }, null, 2)); return;
  }
  const app = process.env.LOCALAPPDATA;
  if (!app) throw new BaiduError('LOCALAPPDATA 未设置');
  const exe = path.join(app, 'YuukoLibrary/tools/BaiduPCS-Go-v4.0.2/BaiduPCS-Go.exe');
  const configDir = path.join(app, 'YuukoLibrary/credentials/baidupcs-config');
  const result = await runPublish(root, selected, createRunner(exe, configDir), { password: values.password });
  console.log(JSON.stringify({ status: result.unavailableCount ? 'partial' : 'complete', ...result }));
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
