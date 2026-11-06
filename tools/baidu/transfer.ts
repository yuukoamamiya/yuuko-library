import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile, open, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import type { Book, BaiduDownload } from '../../src/lib/books.ts';
import { validateBaiduDownload } from '../../src/lib/baidu.ts';
import { replaceFileAtomically } from './atomic.ts';

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type JournalEntry = { id: string; sha256: string; bytes: number; source: string; catalogHash: string; remotePath: string;
  state: 'ready' | 'uploaded' | 'verified' | 'shared' | 'complete' | 'uncertain' | 'unavailable'; fsId?: string; shareId?: string; sharePassword?: string;
  catalogGuard?: { file: Book['file']; downloads: Book['downloads'] }; baidu?: BaiduDownload; error?: string };
export type Journal = { schemaVersion: 1 | 2; updatedAt: string; entries: Record<string, JournalEntry> };
const versionKey = (id: string, sha256: string) => `${id}@${sha256}`;
export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export class BaiduError extends Error {}

export function createRunner(exe: string, configDir: string): Runner {
  return async args => {
    const timeoutMs = args[0] === 'download' ? 90 * 60 * 1000 : 10 * 60 * 1000;
    return await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, BAIDUPCS_GO_CONFIG_DIR: configDir } });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr }); });
    });
  };
}
export async function call(run: Runner, args: string[], semantic?: (out: string) => boolean) {
  const result = await run(args); const out = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || /(?:遇到错误|远端服务器返回错误|以下文件上传失败|操作失败)/u.test(out) || (semantic && !semantic(out))) {
    throw new BaiduError(`BaiduPCS-Go ${args[0]} 结果未确认（退出码 ${result.code}）；检查远端与 journal 后恢复，禁止盲目重试`);
  }
  return out;
}
export function parseMeta(out: string, filename: string) {
  const size = out.match(/^\s*文件大小\s+([\d,]+)(?:\s|$)/imu)?.[1]?.replaceAll(',', '');
  const fsId = out.match(/^\s*fs_id\s+(\d+)\s*$/imu)?.[1];
  const remotePath = out.match(/^\s*文件路径\s+(.+?)\s*$/imu)?.[1]?.trim();
  if (!size || !fsId || !/^\s*类型\s+文件\s*$/imu.test(out) || remotePath !== filename) throw new BaiduError('meta 输出缺少匹配完整路径、文件类型、字节数或 fs_id');
  return { bytes: Number(size), fsId };
}
export async function ensureRemoteDirectory(run: Runner, dir: string) {
  const result = await run(['mkdir', dir]); const out = `${result.stdout}\n${result.stderr}`;
  if (/代码\s*[:：]?\s*31061/u.test(out)) {
    const meta = await call(run, ['meta', dir]);
    const actualPath = meta.match(/^\s*目录路径\s+(.+?)\s*$/imu)?.[1]?.trim();
    if (/^\s*类型\s+目录\s*$/imu.test(meta) && actualPath === dir) return;
  }
  if (result.code === 0 && /创建目录成功|创建目录完成|mkdir.*success/iu.test(out)) return;
  throw new BaiduError('远端目录状态未确认；检查 journal 与远端后人工恢复');
}
export async function probeRemoteFile(run: Runner, remotePath: string): Promise<{ bytes: number; fsId: string } | null> {
  const result = await run(['meta', remotePath]); const out = `${result.stdout}\n${result.stderr}`;
  if (/代码\s*[:：]?\s*31066/u.test(out) && /文件或目录不存在|文件不存在|没有这个文件/u.test(out)) return null;
  if (result.code === 0) return parseMeta(out, remotePath);
  throw new BaiduError('远端文件 meta 状态未知，停止避免覆盖');
}
export function parseShare(out: string): { url: string; code: string; shareId: string } {
  const url = out.match(/https:\/\/pan\.baidu\.com\/s\/[A-Za-z\d_-]+/u)?.[0];
  const code = out.match(/(?:提取码|密码)\s*[:：]\s*([A-Za-z\d]{4})/iu)?.[1];
  const shareId = out.match(/(?:分享ID|share_id|shareId)\s*[:：]\s*(\d+)/iu)?.[1];
  if (!url || !code || !shareId) throw new BaiduError('share set 输出不完整，分享状态未知');
  return { url, code, shareId };
}
export function confirmShareList(out: string, record: { shareId: string; url: string; code: string; path: string }) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const row = out.split(/\r?\n/u).find(line => line.trim().split(/\s+/u).includes(record.shareId)
    && line.trim().split(/\s+/u).includes(record.url));
  if (!row || !row.trim().split(/\s+/u).includes(record.code)
    || !new RegExp(`(?:^|\\s)${escape(record.path)}(?=\\s|$)`, 'u').test(row) || !/永久/iu.test(row)) {
    throw new BaiduError('share list 未在同一记录中确认分享ID、链接、提取码、完整网盘路径与永久期限');
  }
}
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(file)); else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) found.push(file);
  }
  return found;
}
export async function locateInputs(root: string, books: Book[]) {
  const files = await walk(path.join(root, '.local/plans'));
  const byHash = new Map<string, string[]>();
  for (const file of files) { const h = digest(await readFile(file)); byHash.set(h, [...(byHash.get(h) ?? []), file]); }
  const result = new Map<string, { file: string; bytes: number }>();
  for (const book of books) {
    const matches = (byHash.get(book.file.sha256) ?? []).sort();
    if (!matches.length) throw new BaiduError(`${book.id}: .local/plans 中没有完整 SHA-256 匹配的 EPUB，停止`);
    const bytes = (await stat(matches[0])).size;
    if (bytes !== book.file.bytes) throw new BaiduError(`${book.id}: EPUB 字节数与书目不符`);
    result.set(book.id, { file: matches[0], bytes });
  }
  return result;
}
export async function loadJournal(file: string): Promise<Journal> {
  try { const value = JSON.parse(await readFile(file, 'utf8')) as Journal;
    if (![1, 2].includes(value.schemaVersion) || !value.entries || typeof value.entries !== 'object') throw new Error();
    if (value.schemaVersion === 1) {
      const entries: Record<string, JournalEntry> = {};
      for (const [id, entry] of Object.entries(value.entries)) entries[versionKey(id, entry.sha256)] = entry;
      return { ...value, entries };
    }
    return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, updatedAt: new Date().toISOString(), entries: {} }; throw new BaiduError('journal 格式无效'); }
}
async function persistJournalMigration(file: string, journal: Journal) {
  let raw: { schemaVersion?: number };
  try { raw = JSON.parse(await readFile(file, 'utf8')) as typeof raw; } catch { return; }
  if (raw.schemaVersion !== 1) return;
  const backup = `${file}.schema1.bak`;
  try { await copyFile(file, backup, fsConstants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  journal.schemaVersion = 2; await saveJournal(file, journal);
  await writeFile(`${file}.migration.json`, JSON.stringify({ from: 1, to: 2, backup, migratedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}
async function saveJournal(file: string, journal: Journal) {
  await mkdir(path.dirname(file), { recursive: true }); journal.schemaVersion = 2; journal.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 }); await replaceFileAtomically(tmp, file);
}
export function getJournalEntry(journal: Journal, id: string, sha256: string) {
  return journal.entries[versionKey(id, sha256)] ?? Object.values(journal.entries).find(entry => entry.id === id && entry.sha256 === sha256) ?? null;
}
async function readBook(file: string): Promise<Book> { return JSON.parse(await readFile(file, 'utf8')) as Book; }
async function catalogHash(file: string) { return digest(await readFile(file)); }
async function archiveJournalConfirms(root: string, book: Book, current: Book, currentCatalogHash: string) {
  const download = current.downloads.baidu;
  if (!download?.archive) return false;
  validateBaiduDownload(download, book.file.sha256);
  let journal: { entries?: Record<string, { id?: string; state?: string; sourceSha256?: string; sha256?: string; archiveSha256?: string; remotePath?: string; catalogHash?: string; catalogGuard?: { file: Book['file']; downloads: Book['downloads'] }; baidu?: BaiduDownload }> };
  try { journal = JSON.parse(await readFile(path.join(root, '.local/baidu/archive-journal.json'), 'utf8')) as typeof journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new BaiduError('archive journal 无法解析'); }
  const record = journal.entries?.[`${book.id}@${book.file.sha256}@${download.archive.sha256}`]
    ?? Object.values(journal.entries ?? {}).find(entry => entry.id === book.id && entry.sourceSha256 === book.file.sha256 && entry.archiveSha256 === download.archive!.sha256);
  const catalogMatches = record?.catalogHash === currentCatalogHash;
  const metadataOnly = Boolean(record?.catalogGuard && current.file.sha256 === record.sourceSha256
    && current.file.bytes === record.catalogGuard.file.bytes && current.file.filename === record.catalogGuard.file.filename
    && current.downloads.r2Key === record.catalogGuard.downloads.r2Key && current.downloads.r2Url === record.catalogGuard.downloads.r2Url
    && JSON.stringify(current.downloads.baidu) === JSON.stringify(record.baidu));
  return record?.state === 'complete' && record.sourceSha256 === book.file.sha256
    && record.archiveSha256 === download.archive.sha256 && record.remotePath === download.path
    && (catalogMatches || metadataOnly) && JSON.stringify(record.baidu) === JSON.stringify(download);
}
export async function importPilot(root: string, runner: Runner) {
  const file = path.join(root, '.local/baidu/pilot-verified.json');
  let pilot: { bookId: string; bytes: number; baidu: BaiduDownload };
  try { pilot = JSON.parse(await readFile(file, 'utf8')) as typeof pilot; } catch { return false; }
  const target = path.join(root, 'catalog/books', `${pilot.bookId}.json`); const book = await readBook(target);
  if (pilot.bookId !== 'endnotes-2' || pilot.baidu.fileSha256 !== book.file.sha256) return false;
  validateBaiduDownload(pilot.baidu, book.file.sha256);
  if (pilot.bytes !== book.file.bytes) throw new BaiduError('pilot bytes 与正式书目不符');
  const metaOut = await call(runner, ['meta', pilot.baidu.path]); const meta = parseMeta(metaOut, pilot.baidu.path);
  if (meta.bytes !== pilot.bytes || meta.fsId !== pilot.baidu.fsId) throw new BaiduError('pilot meta 与保存记录不符');
  const shareOut = await call(runner, ['share', 'list']);
  confirmShareList(shareOut, { ...pilot.baidu, path: pilot.baidu.path });
  return { book, baidu: pilot.baidu };
}
export async function runPublish(root: string, selected: Book[], run: Runner, options: { password?: string; journalPath?: string; roundtripRoot?: string; now?: () => Date } = {}) {
  const journalFile = options.journalPath ?? path.join(root, '.local/baidu/journal.json');
  const lockFile = `${journalFile}.lock`; const projectLockFile = path.join(root, '.local/baidu/project.lock');
  await mkdir(path.dirname(journalFile), { recursive: true });
  let lock; let projectLock;
  try { projectLock = await open(projectLockFile, 'wx'); } catch { throw new BaiduError('Baidu 项目操作锁已存在；确认没有活动进程后再检查锁'); }
  try { lock = await open(lockFile, 'wx'); } catch { await projectLock.close(); await import('node:fs/promises').then(fs => fs.rm(projectLockFile, { force: true })); throw new BaiduError('Baidu journal 锁已存在；确认没有活动进程后再检查锁'); }
  try {
    const journal = await loadJournal(journalFile); await persistJournalMigration(journalFile, journal); const inputs = new Map<string, { file: string; bytes: number }>();
    let pilot: Awaited<ReturnType<typeof importPilot>> = false;
    let archiveHistory: { entries?: Record<string, { id?: string; state?: string }> } = {};
    try { archiveHistory = JSON.parse(await readFile(path.join(root, '.local/baidu/archive-journal.json'), 'utf8')) as typeof archiveHistory; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BaiduError('archive journal 无法解析'); }
    let completed = 0; const unavailable: { id: string; error: string }[] = [];
    for (const book of selected) {
      console.error(`baidu: ${book.id} (${book.file.bytes} bytes) starting/resuming`);
      const target = path.join(root, 'catalog/books', `${book.id}.json`), beforeHash = await catalogHash(target), current = await readBook(target);
      if (current.file.sha256 !== book.file.sha256 || current.file.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 书目文件已变化`);
      const key = versionKey(book.id, book.file.sha256);
      const previous = getJournalEntry(journal, book.id, book.file.sha256);
      const otherVersions = Object.values(journal.entries).filter(entry => entry.id === book.id && entry.sha256 !== book.file.sha256);
      if (Object.values(archiveHistory.entries ?? {}).some(entry => entry.id === book.id && entry.state === 'uncertain')) {
        throw new BaiduError(`${book.id}: 有未确认的历史 RAR 分享结果；先通过 recover 诊断恢复，禁止新版本绕过`);
      }
      if (current.downloads.baidu?.archive) {
        if (!await archiveJournalConfirms(root, book, current, beforeHash)) throw new BaiduError(`${book.id}: RAR 记录缺少匹配的完整 archive journal，拒绝按旧 raw 分享覆盖`);
        completed++;
        continue;
      }
      if (previous?.state === 'unavailable') {
        if (current.downloads.baidu !== null || beforeHash !== previous.catalogHash) throw new BaiduError(`${book.id}: unavailable 记录对应的书目已变化，拒绝覆盖`);
        unavailable.push({ id: book.id, error: previous.error ?? '百度分享经人工核查不可用' });
        continue;
      }
      if (previous?.state === 'complete' && previous.baidu) {
        validateBaiduDownload(previous.baidu, book.file.sha256);
        if (JSON.stringify(current.downloads.baidu) !== JSON.stringify(previous.baidu)) {
          throw new BaiduError(`${book.id}: 已验证分享字段已变化，拒绝覆盖`);
        }
        if (beforeHash !== previous.catalogHash) {
          const guard = previous.catalogGuard;
          if (current.file.sha256 !== previous.sha256 || current.file.bytes !== previous.bytes || !guard
            || current.file.filename !== guard.file.filename || current.downloads.r2Key !== guard.downloads.r2Key
            || current.downloads.r2Url !== guard.downloads.r2Url || current.downloads.baidu?.fileSha256 !== previous.sha256) {
            throw new BaiduError(`${book.id}: 文件或下载字段已变化，拒绝刷新 journal fingerprint`);
          }
          previous.catalogHash = beforeHash; previous.catalogGuard = { file: current.file, downloads: current.downloads };
          journal.entries[key] = previous; await saveJournal(journalFile, journal);
        } else if (!previous.catalogGuard && JSON.stringify(current.downloads.baidu) === JSON.stringify(previous.baidu)) {
          previous.catalogGuard = { file: current.file, downloads: current.downloads };
          journal.entries[key] = previous; await saveJournal(journalFile, journal);
        }
        completed++;
        continue;
      }
      const remotePath = `/yuuko-library/books/${book.id}/${book.file.sha256}/${book.file.filename}`;
      const record: JournalEntry = previous ?? { id: book.id, sha256: book.file.sha256, bytes: book.file.bytes, source: '',
        catalogHash: beforeHash, catalogGuard: { file: current.file, downloads: current.downloads }, remotePath, state: 'ready' };
      if (otherVersions.some(entry => entry.state === 'uncertain')) throw new BaiduError(`${book.id}: 旧版本仍有未确认分享结果；先用 recover 诊断恢复，禁止新版本绕过`);
      if (record.state === 'uncertain' && !record.baidu) throw new BaiduError(`${book.id}: 该版本分享结果未知；先用 recover 诊断并接续，禁止自动创建新分享`);
      if (previous && beforeHash !== previous.catalogHash) {
        if (previous.state === 'shared' && previous.baidu && JSON.stringify(current.downloads.baidu) === JSON.stringify(previous.baidu)) {
          record.catalogHash = beforeHash; record.state = 'complete'; journal.entries[key] = record; await saveJournal(journalFile, journal); continue;
        }
        if (previous.state === 'shared' && previous.baidu && current.downloads.baidu === null && previous.catalogGuard
          && current.file.sha256 === previous.catalogGuard.file.sha256 && current.file.bytes === previous.catalogGuard.file.bytes
          && current.file.filename === previous.catalogGuard.file.filename && current.downloads.r2Key === previous.catalogGuard.downloads.r2Key
          && current.downloads.r2Url === previous.catalogGuard.downloads.r2Url) {
          record.catalogHash = beforeHash; record.catalogGuard = { file: current.file, downloads: current.downloads };
          journal.entries[key] = record; await saveJournal(journalFile, journal);
        } else
        throw new BaiduError(`${book.id}: journal 创建后书目已变化，拒绝覆盖`);
      }
      if (pilot && pilot.book.id === book.id) { record.baidu = pilot.baidu; record.state = 'shared'; }
      if (record.state === 'ready') {
        let input = inputs.get(book.id);
        if (!input) {
          if (book.id === 'endnotes-2' && !pilot) pilot = await importPilot(root, run);
          if (pilot && pilot.book.id === book.id) { record.baidu = pilot.baidu; record.state = 'shared'; }
          if (record.state === 'ready') {
            try { input = (await locateInputs(root, [book])).get(book.id); }
            catch (error) { throw new BaiduError(`${book.id}: ${error instanceof Error ? error.message : '本地 EPUB 不可用'}`); }
            if (!input) throw new BaiduError(`${book.id}: 缺少当前版本源 EPUB`);
            inputs.set(book.id, input);
            record.source = input.file;
          }
        }
        if (record.state !== 'ready') {
          // A verified local pilot share has no upload phase.
        } else {
        await ensureRemoteDirectory(run, path.posix.dirname(remotePath));
        const existing = await probeRemoteFile(run, remotePath);
        if (existing) {
          if (existing.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 已存在远端文件 bytes 不匹配`);
          record.fsId = existing.fsId;
        } else {
          if (!input) throw new BaiduError(`${book.id}: 上传前未找到当前版本 EPUB`);
          if (digest(await readFile(input.file)) !== book.file.sha256) throw new BaiduError(`${book.id}: 上传前源 EPUB SHA-256 已变化`);
          if (path.basename(book.file.filename) !== book.file.filename || /[\\/\0]/u.test(book.file.filename)) throw new BaiduError(`${book.id}: catalog 文件名不是安全的单级文件名`);
          const staging = path.join(root, '.local/baidu/staging', book.id, book.file.sha256, book.file.filename);
          await mkdir(path.dirname(staging), { recursive: true });
          try { await copyFile(input.file, staging, fsConstants.COPYFILE_EXCL); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          const staged = await readFile(staging);
          if (staged.length !== book.file.bytes || digest(staged) !== book.file.sha256) throw new BaiduError(`${book.id}: staging 副本校验失败`);
          await call(run, ['upload', '--policy', 'skip', '--retry', '0', '-p', '1', staging, path.posix.dirname(remotePath)], out => /上传文件成功|上传成功|成功上传|跳过|upload(?:ed)? successfully/iu.test(out));
          const uploaded = await probeRemoteFile(run, remotePath);
          if (!uploaded || uploaded.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 上传后远端 meta 核对失败`);
          record.fsId = uploaded.fsId;
        }
        record.state = 'uploaded'; journal.entries[key] = record; await saveJournal(journalFile, journal);
        }
      }
      if (record.state === 'uploaded') {
        const meta = parseMeta(await call(run, ['meta', remotePath]), remotePath);
        if (meta.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 远端 meta bytes 不匹配`);
        record.fsId = meta.fsId;
        const roundtripBase = path.join(options.roundtripRoot ?? path.join(root, '.local/baidu/roundtrip'), `${book.id}-${book.file.sha256}`);
        let roundtripDir = roundtripBase;
        let roundtripFile = path.join(roundtripDir, book.file.filename);
        let cached: Buffer | null = null;
        try { cached = await readFile(roundtripFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!cached || cached.length !== book.file.bytes || digest(cached) !== book.file.sha256) {
          roundtripDir = path.join(roundtripBase, `attempt-${randomUUID()}`); roundtripFile = path.join(roundtripDir, book.file.filename);
          await mkdir(roundtripDir, { recursive: true });
          await call(run, ['download', '--saveto', roundtripDir, '--mode', 'pcs', '--retry', '0', '-p', '1', remotePath], out => /下载完成|下载成功|成功下载|download(?:ed)? successfully/iu.test(out));
          cached = await readFile(roundtripFile);
        }
        const downloaded = cached;
        if (downloaded.length !== book.file.bytes || digest(downloaded) !== book.file.sha256) throw new BaiduError(`${book.id}: 完整回读 SHA-256 校验失败`);
        record.state = 'verified'; journal.entries[key] = record; await saveJournal(journalFile, journal);
      }
      if (record.state === 'verified') {
        const password = options.password ?? Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
        record.state = 'uncertain'; record.sharePassword = password; journal.entries[key] = record; await saveJournal(journalFile, journal);
        const out = await call(run, ['share', 'set', '-p', password, '--period', '0', remotePath]);
        const share = parseShare(out);
        if (share.code !== password) throw new BaiduError(`${book.id}: share set 提取码与所设密码不符，分享状态未知`);
        record.shareId = share.shareId;
        record.baidu = { url: share.url, code: share.code, fileSha256: book.file.sha256, fsId: record.fsId!, shareId: share.shareId,
          path: remotePath, expiresAt: null, verifiedAt: (options.now?.() ?? new Date()).toISOString() };
        validateBaiduDownload(record.baidu, book.file.sha256);
        journal.entries[key] = record; await saveJournal(journalFile, journal);
      }
      if (record.state === 'uncertain' && record.baidu) {
        const check = await call(run, ['share', 'list']);
        confirmShareList(check, record.baidu);
        record.state = 'shared'; journal.entries[key] = record; await saveJournal(journalFile, journal);
      }
      if (!['complete', 'shared'].includes(record.state) || !record.baidu) throw new BaiduError(`${book.id}: 状态 ${record.state} 需要人工恢复`);
      validateBaiduDownload(record.baidu, book.file.sha256);
      if (await catalogHash(target) !== beforeHash) throw new BaiduError(`${book.id}: catalog 在流程中变化，拒绝覆盖`);
      current.downloads.baidu = record.baidu;
      const tmp = `${target}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(current, null, 2) + '\n'); await replaceFileAtomically(tmp, target);
      record.catalogHash = await catalogHash(target); record.catalogGuard = { file: current.file, downloads: current.downloads };
      record.state = 'complete'; journal.entries[key] = record; await saveJournal(journalFile, journal);
      completed++;
    }
    return { selected: selected.length, completed, unavailable, unavailableCount: unavailable.length, journalFile };
  } finally {
    await lock?.close(); await import('node:fs/promises').then(fs => fs.rm(lockFile, { force: true }));
    await projectLock?.close(); await import('node:fs/promises').then(fs => fs.rm(projectLockFile, { force: true }));
  }
}

export async function recoverUnknownShare(root: string, book: Book, run: Runner, shareId: string, code: string,
  options: { journalPath?: string; roundtripRoot?: string; now?: () => Date; sourceSha256?: string } = {}) {
  if (!/^\d+$/u.test(shareId) || !/^[a-z\d]{4}$/iu.test(code)) throw new BaiduError('恢复需要精确的 share ID 和 4 位提取码');
  const journalFile = options.journalPath ?? path.join(root, '.local/baidu/journal.json');
  const lockFile = `${journalFile}.lock`; const projectLockFile = path.join(root, '.local/baidu/project.lock');
  await mkdir(path.dirname(journalFile), { recursive: true });
  let projectLock; let lock;
  try { projectLock = await open(projectLockFile, 'wx'); } catch { throw new BaiduError('Baidu 项目操作锁已存在'); }
  try { lock = await open(lockFile, 'wx'); } catch { await projectLock.close(); await import('node:fs/promises').then(fs => fs.rm(projectLockFile, { force: true })); throw new BaiduError('Baidu journal 锁已存在'); }
  try {
    const sourceSha256 = options.sourceSha256 ?? book.file.sha256;
    if (!/^[a-f\d]{64}$/iu.test(sourceSha256)) throw new BaiduError('source SHA-256 格式无效');
    const journal = await loadJournal(journalFile); await persistJournalMigration(journalFile, journal);
    const key = versionKey(book.id, sourceSha256); const record = journal.entries[key];
    if (!record || record.state !== 'uncertain') throw new BaiduError('当前版本没有待恢复的未知分享记录');
    const filename = record.remotePath.split('/').at(-1)!;
    if (record.remotePath !== `/yuuko-library/books/${book.id}/${sourceSha256}/${filename}` || record.bytes <= 0) throw new BaiduError('journal 远端路径与历史书目版本不符');
    const target = path.join(root, 'catalog/books', `${book.id}.json`); const catalogBytes = await readFile(target);
    const current = JSON.parse(catalogBytes.toString('utf8')) as Book;
    const activeVersion = current.file.sha256 === sourceSha256;
    if (activeVersion && (current.file.bytes !== record.bytes || current.file.filename !== filename || current.downloads.baidu !== null)) throw new BaiduError('当前书目已变化或已有百度记录，拒绝恢复覆盖');
    const meta = parseMeta(await call(run, ['meta', record.remotePath]), record.remotePath);
    if (meta.bytes !== record.bytes || (record.fsId && meta.fsId !== record.fsId)) throw new BaiduError('远端文件 meta 与未知分享 journal 不匹配');
    const roundtripDir = path.join(options.roundtripRoot ?? path.join(root, '.local/baidu/recovery'), `${book.id}-${sourceSha256}-${randomUUID()}`);
    await mkdir(roundtripDir, { recursive: true });
    await call(run, ['download', '--saveto', roundtripDir, '--mode', 'pcs', '--retry', '0', '-p', '1', record.remotePath],
      out => /下载完成|下载成功|成功下载|download(?:ed)? successfully/iu.test(out));
    const downloaded = await readFile(path.join(roundtripDir, filename));
    if (downloaded.length !== record.bytes || digest(downloaded) !== sourceSha256) throw new BaiduError('恢复前完整远端 SHA-256 不匹配');
    const listing = await call(run, ['share', 'list']);
    const row = listing.split(/\r?\n/u).find(line => line.trim().split(/\s+/u).includes(shareId) && line.includes(record.remotePath));
    const url = row?.match(/https:\/\/pan\.baidu\.com\/s\/[A-Za-z\d_-]+/u)?.[0];
    if (!row || !url || !row.includes(code) || !/永久/iu.test(row)) throw new BaiduError('share list 未唯一确认指定分享 ID、提取码、路径与永久期限');
    if (record.baidu && (record.baidu.shareId !== shareId || record.baidu.code !== code || record.baidu.url !== url)) {
      throw new BaiduError('传入恢复分享与 journal 已知分享记录不一致');
    }
    const baidu: BaiduDownload = { url, code, fileSha256: sourceSha256, fsId: meta.fsId, shareId,
      path: record.remotePath, expiresAt: null, verifiedAt: (options.now?.() ?? new Date()).toISOString() };
    validateBaiduDownload(baidu, sourceSha256);
    confirmShareList(listing, baidu);
    record.fsId = meta.fsId; record.shareId = shareId; record.baidu = baidu; record.state = 'shared'; journal.entries[key] = record; await saveJournal(journalFile, journal);
    if (activeVersion) {
      if (await catalogHash(target) !== digest(catalogBytes)) throw new BaiduError('恢复期间 catalog 发生竞态变化；已保存分享恢复 checkpoint，可安全续跑');
      current.downloads.baidu = baidu;
      const tmp = `${target}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 }); await replaceFileAtomically(tmp, target);
      record.catalogHash = await catalogHash(target); record.catalogGuard = { file: current.file, downloads: current.downloads };
      record.state = 'complete'; journal.entries[key] = record; await saveJournal(journalFile, journal);
    }
    return { status: activeVersion ? 'recovered' : 'historical-share-resolved', id: book.id, sha256: sourceSha256, shareId };
  } finally {
    await lock?.close(); await import('node:fs/promises').then(fs => fs.rm(lockFile, { force: true }));
    await projectLock?.close(); await import('node:fs/promises').then(fs => fs.rm(projectLockFile, { force: true }));
  }
}
