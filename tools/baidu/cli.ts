import { parseArgs } from 'node:util';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readCatalog } from '../catalog.ts';
import { createRunner, getJournalEntry, loadJournal, locateInputs, recoverUnknownShare, runPublish, BaiduError } from './transfer.ts';
import { createRarRunner, loadArchiveJournal, prepareArchive, publishArchive, recoverUnknownArchiveShare, type RarRunner } from './archive.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `百度网盘维护工具（无 WSL）
  npm run baidu -- status [--id ID|--all]       本地只读查看书目、源 EPUB 与 journal
  npm run baidu -- prepare [--id ID|--all]      本地只读完整 SHA-256 盘点
  npm run baidu -- publish --id ID|--all [--password CODE]  显式执行上传、回读、永久分享与书目更新
  npm run baidu -- recover --id ID [--share-id ID --code CODE]  显式认领已确认的未知分享，不创建新分享
  npm run baidu -- recover --manifest FILE --share-id ID --code CODE  恢复指定 RAR 版本的未知分享
  npm run baidu -- prepare-archive --id ID --name NAME.rar [--archive-password CODE]  本地生成并核验隐藏文件名的 RAR
  npm run baidu -- publish-archive --manifest FILE  显式核验、上传或导入指定 RAR 记录

publish --all 是显式批量云写；状态未知时停止，不盲目重复分享。RAR 命令完成不代替匿名链接可用性检查。
提取码随分享记录写入本地 journal 与公开书目；账号登录凭据始终留在仓库外。`;
function createBaiduRunner() {
  const app = process.env.LOCALAPPDATA;
  if (!app) throw new BaiduError('LOCALAPPDATA 未设置');
  return createRunner(path.join(app, 'YuukoLibrary/tools/BaiduPCS-Go-v4.0.2/BaiduPCS-Go.exe'),
    path.join(app, 'YuukoLibrary/credentials/baidupcs-config'));
}
async function createCheckedRarRunner(): Promise<RarRunner> {
  const rarPath = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'WinRAR/Rar.exe');
  try { await access(rarPath); } catch { throw new BaiduError(`未找到 WinRAR：${rarPath}`); }
  return createRarRunner(rarPath);
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, id: { type: 'string' }, all: { type: 'boolean' }, password: { type: 'string' },
    'share-id': { type: 'string' }, code: { type: 'string' }, 'source-sha': { type: 'string' },
    name: { type: 'string' }, 'archive-password': { type: 'string' }, manifest: { type: 'string' },
  } });
  const command = positionals[0];
  if (!command || values.help) { console.log(help); return; }
  if (positionals.length !== 1 || !['status', 'prepare', 'publish', 'recover', 'prepare-archive', 'publish-archive'].includes(command)) throw new Error('命令无效；运行 npm run baidu -- --help');
  if (command === 'prepare-archive') {
    if (!values.id || values.all || !values.name || values.manifest || values.password) throw new Error('prepare-archive 需要 --id 和 --name，不能指定 --all 或分享密码');
    const books = await readCatalog(root); const book = books.find(item => item.id === values.id);
    if (!book) throw new Error(`找不到正式书目 ID：${values.id}`);
    const result = await prepareArchive(root, book, values.name, values['archive-password'] ?? '114514', await createCheckedRarRunner());
    console.log(JSON.stringify({ status: 'prepared', manifest: result.manifestPath,
      bookId: result.manifest.bookId, sourceSha256: result.manifest.sourceSha256, archive: result.manifest.archive })); return;
  }
  if (command === 'publish-archive') {
    if (!values.manifest || values.id || values.all || values.name || values.password || values['archive-password']) throw new Error('publish-archive 仅接受 --manifest FILE');
    const result = await publishArchive(root, await readCatalog(root), values.manifest, createBaiduRunner(), await createCheckedRarRunner());
    console.log(JSON.stringify(result)); return;
  }
  if (command === 'recover') {
    if (values.all || values.password || values.name || values['archive-password'] || Boolean(values['share-id']) !== Boolean(values.code)) {
      throw new Error('recover 参数不匹配');
    }
    if (values.manifest) {
      if (values.id || !values['share-id'] || !values.code || values['source-sha']) throw new Error('RAR recover 需要 --manifest、--share-id 和 --code');
      const result = await recoverUnknownArchiveShare(root, await readCatalog(root), values.manifest, createBaiduRunner(),
        values['share-id'], values.code);
      console.log(JSON.stringify(result)); return;
    }
    if (!values.id) throw new Error('raw recover 需要 --id');
    const book = (await readCatalog(root)).find(item => item.id === values.id);
    if (!book) throw new Error(`找不到正式书目 ID：${values.id}`);
    const journal = await loadJournal(path.join(root, '.local/baidu/journal.json'));
    const sourceSha = values['source-sha'] ?? book.file.sha256;
    const entry = getJournalEntry(journal, book.id, sourceSha);
    if (!entry || entry.state !== 'uncertain') throw new BaiduError('当前版本没有待恢复的未知分享记录');
    if (!values['share-id']) {
      console.log(JSON.stringify({ mode: 'read-only', id: book.id, sha256: sourceSha,
        remotePath: entry.remotePath, fsId: entry.fsId ?? null, attemptedCodeSaved: Boolean(entry.sharePassword),
        next: '请在百度 share list 中人工核对后，以 --share-id 和 --code 精确认领；不会自动重新 share set' }, null, 2)); return;
    }
    const result = await recoverUnknownShare(root, book, createBaiduRunner(), values['share-id'], values.code!, { sourceSha256: sourceSha });
    console.log(JSON.stringify(result)); return;
  }
  if (values.id && values.all) throw new Error('--id 与 --all 不能同时使用');
  if (command === 'publish' && !values.id && !values.all) throw new Error('publish 必须显式指定 --id ID 或 --all');
  if (values.password && (command !== 'publish' || !/^[a-z\d]{4}$/iu.test(values.password))) throw new Error('--password 仅用于 publish，须为4位字母或数字');
  if (values.name || values['archive-password'] || values.manifest || values['share-id'] || values.code || values['source-sha']) throw new Error('archive/recover 参数仅用于对应命令');
  const books = await readCatalog(root);
  const selected = values.id ? books.filter(book => book.id === values.id) : (values.all || command !== 'publish' ? books : []);
  if (values.id && selected.length !== 1) throw new Error(`找不到正式书目 ID：${values.id}`);
  const journalFile = path.join(root, '.local/baidu/journal.json'); const journal = await loadJournal(journalFile);
  if (command === 'status') {
    const inputs = await locateInputs(root, selected);
    const archiveJournal = await loadArchiveJournal(path.join(root, '.local/baidu/archive-journal.json'));
    console.log(JSON.stringify({ mode: 'read-only', journals: { rawSchemaVersion: journal.schemaVersion, rawMigrationPending: journal.schemaVersion === 1,
      archiveSchemaVersion: archiveJournal.schemaVersion, archiveMigrationPending: archiveJournal.schemaVersion === 1 }, books: selected.map(book => ({ id: book.id, sha256: book.file.sha256,
      bytes: book.file.bytes, source: inputs.get(book.id)?.file ?? null, catalogBaidu: book.downloads.baidu,
      journal: getJournalEntry(journal, book.id, book.file.sha256), journalHistory: Object.values(journal.entries).filter(entry => entry.id === book.id),
      archiveJournal: Object.values(archiveJournal.entries).filter(entry => entry.id === book.id) })) }, null, 2)); return;
  }
  if (command === 'prepare') {
    const inputs = await locateInputs(root, selected);
    console.log(JSON.stringify({ mode: 'read-only', books: selected.map(book => ({ id: book.id, sha256: book.file.sha256,
      bytes: book.file.bytes, source: inputs.get(book.id)?.file, state: getJournalEntry(journal, book.id, book.file.sha256)?.state ?? 'ready' })) }, null, 2)); return;
  }
  const result = await runPublish(root, selected, createBaiduRunner(), { password: values.password });
  console.log(JSON.stringify({ status: result.unavailableCount ? 'partial' : 'complete', ...result }));
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
