import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile, rename, open, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import type { Book, BaiduDownload } from '../../src/lib/books.ts';
import { validateBaiduDownload } from '../../src/lib/baidu.ts';

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type JournalEntry = { id: string; sha256: string; bytes: number; source: string; catalogHash: string; remotePath: string;
  state: 'ready' | 'uploaded' | 'verified' | 'shared' | 'complete' | 'uncertain'; fsId?: string; shareId?: string; baidu?: BaiduDownload; error?: string };
export type Journal = { schemaVersion: 1; updatedAt: string; entries: Record<string, JournalEntry> };
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
async function call(run: Runner, args: string[], semantic?: (out: string) => boolean) {
  const result = await run(args); const out = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || /(?:遇到错误|远端服务器返回错误|以下文件上传失败|操作失败)/u.test(out) || (semantic && !semantic(out))) {
    throw new BaiduError(`BaiduPCS-Go ${args[0]} 结果未确认（退出码 ${result.code}）；检查远端与 journal 后恢复，禁止盲目重试`);
  }
  return out;
}
function parseMeta(out: string, filename: string) {
  const size = out.match(/^\s*文件大小\s+([\d,]+)(?:\s|$)/imu)?.[1]?.replaceAll(',', '');
  const fsId = out.match(/^\s*fs_id\s+(\d+)\s*$/imu)?.[1];
  const remotePath = out.match(/^\s*文件路径\s+(.+?)\s*$/imu)?.[1]?.trim();
  if (!size || !fsId || !/^\s*类型\s+文件\s*$/imu.test(out) || remotePath !== filename) throw new BaiduError('meta 输出缺少匹配完整路径、文件类型、字节数或 fs_id');
  return { bytes: Number(size), fsId };
}
async function ensureRemoteDirectory(run: Runner, dir: string) {
  const result = await run(['mkdir', dir]); const out = `${result.stdout}\n${result.stderr}`;
  if (/代码\s*[:：]?\s*31061/u.test(out)) {
    const meta = await call(run, ['meta', dir]);
    const actualPath = meta.match(/^\s*目录路径\s+(.+?)\s*$/imu)?.[1]?.trim();
    if (/^\s*类型\s+目录\s*$/imu.test(meta) && actualPath === dir) return;
  }
  if (result.code === 0 && /创建目录成功|创建目录完成|mkdir.*success/iu.test(out)) return;
  throw new BaiduError('远端目录状态未确认；检查 journal 与远端后人工恢复');
}
async function probeRemoteFile(run: Runner, remotePath: string): Promise<{ bytes: number; fsId: string } | null> {
  const result = await run(['meta', remotePath]); const out = `${result.stdout}\n${result.stderr}`;
  if (/代码\s*[:：]?\s*31066/u.test(out) && /文件或目录不存在|文件不存在|没有这个文件/u.test(out)) return null;
  if (result.code === 0) return parseMeta(out, remotePath);
  throw new BaiduError('远端文件 meta 状态未知，停止避免覆盖');
}
function parseShare(out: string): { url: string; code: string; shareId: string } {
  const url = out.match(/https:\/\/pan\.baidu\.com\/s\/[A-Za-z\d_-]+/u)?.[0];
  const code = out.match(/(?:提取码|密码)\s*[:：]\s*([A-Za-z\d]{4})/iu)?.[1];
  const shareId = out.match(/(?:分享ID|share_id|shareId)\s*[:：]\s*(\d+)/iu)?.[1];
  if (!url || !code || !shareId) throw new BaiduError('share set 输出不完整，分享状态未知');
  return { url, code, shareId };
}
function confirmShareList(out: string, record: { shareId: string; url: string; code: string; path: string }) {
  const row = out.split(/\r?\n/u).find(line => line.includes(record.shareId) && line.includes(record.url));
  if (!row || !row.includes(record.code) || !row.includes(record.path) || !/永久/iu.test(row)) {
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
    if (value.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object') throw new Error(); return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: {} }; throw new BaiduError('journal 格式无效'); }
}
async function saveJournal(file: string, journal: Journal) {
  await mkdir(path.dirname(file), { recursive: true }); journal.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, file);
}
async function readBook(file: string): Promise<Book> { return JSON.parse(await readFile(file, 'utf8')) as Book; }
async function catalogHash(file: string) { return digest(await readFile(file)); }
export async function importPilot(root: string, runner: Runner) {
  const file = path.join(root, '.local/baidu/pilot-verified.json');
  let pilot: { bookId: string; bytes: number; baidu: BaiduDownload };
  try { pilot = JSON.parse(await readFile(file, 'utf8')) as typeof pilot; } catch { return false; }
  const target = path.join(root, 'catalog/books', `${pilot.bookId}.json`); const book = await readBook(target);
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
  const lockFile = `${journalFile}.lock`; await mkdir(path.dirname(journalFile), { recursive: true });
  let lock;
  try { lock = await open(lockFile, 'wx'); } catch { throw new BaiduError('Baidu 操作锁已存在；确认没有活动进程后再检查锁'); }
  try {
    const journal = await loadJournal(journalFile); const inputs = await locateInputs(root, selected);
    const pilot = selected.some(book => book.id === 'endnotes-2') ? await importPilot(root, run) : false;
    for (const book of selected) {
      console.error(`baidu: ${book.id} (${book.file.bytes} bytes) starting/resuming`);
      const target = path.join(root, 'catalog/books', `${book.id}.json`), beforeHash = await catalogHash(target), current = await readBook(target);
      if (current.file.sha256 !== book.file.sha256 || current.file.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 书目文件已变化`);
      const previous = journal.entries[book.id];
      if (previous && previous.sha256 !== book.file.sha256) throw new BaiduError(`${book.id}: journal 哈希变化，旧分享记录作废，须人工检查`);
      if (previous?.state === 'complete' && previous.baidu) {
        validateBaiduDownload(previous.baidu, book.file.sha256);
        if (JSON.stringify(current.downloads.baidu) !== JSON.stringify(previous.baidu) || beforeHash !== previous.catalogHash) {
          throw new BaiduError(`${book.id}: 完成后的书目已变化，拒绝覆盖`);
        }
        continue;
      }
      const input = inputs.get(book.id)!; const remotePath = `/yuuko-library/books/${book.id}/${book.file.sha256}/${book.file.filename}`;
      const record: JournalEntry = previous ?? { id: book.id, sha256: book.file.sha256, bytes: book.file.bytes, source: input.file,
        catalogHash: beforeHash, remotePath, state: 'ready' };
      if (previous && beforeHash !== previous.catalogHash) {
        if (previous.state === 'shared' && previous.baidu && JSON.stringify(current.downloads.baidu) === JSON.stringify(previous.baidu)) {
          record.catalogHash = beforeHash; record.state = 'complete'; journal.entries[book.id] = record; await saveJournal(journalFile, journal); continue;
        }
        throw new BaiduError(`${book.id}: journal 创建后书目已变化，拒绝覆盖`);
      }
      if (pilot && pilot.book.id === book.id) { record.baidu = pilot.baidu; record.state = 'shared'; }
      if (record.state === 'ready') {
        await ensureRemoteDirectory(run, path.posix.dirname(remotePath));
        const existing = await probeRemoteFile(run, remotePath);
        if (existing) {
          if (existing.bytes !== book.file.bytes) throw new BaiduError(`${book.id}: 已存在远端文件 bytes 不匹配`);
          record.fsId = existing.fsId;
        } else {
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
        record.state = 'uploaded'; journal.entries[book.id] = record; await saveJournal(journalFile, journal);
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
        record.state = 'verified'; journal.entries[book.id] = record; await saveJournal(journalFile, journal);
      }
      if (record.state === 'verified') {
        const password = options.password ?? Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
        record.state = 'uncertain'; journal.entries[book.id] = record; await saveJournal(journalFile, journal);
        const out = await call(run, ['share', 'set', '-p', password, '--period', '0', remotePath]);
        const share = parseShare(out);
        if (share.code !== password) throw new BaiduError(`${book.id}: share set 提取码与所设密码不符，分享状态未知`);
        record.shareId = share.shareId;
        record.baidu = { url: share.url, code: share.code, fileSha256: book.file.sha256, fsId: record.fsId!, shareId: share.shareId,
          path: remotePath, expiresAt: null, verifiedAt: (options.now?.() ?? new Date()).toISOString() };
        validateBaiduDownload(record.baidu, book.file.sha256);
        journal.entries[book.id] = record; await saveJournal(journalFile, journal);
      }
      if (record.state === 'uncertain' && record.baidu) {
        const check = await call(run, ['share', 'list']);
        confirmShareList(check, record.baidu);
        record.state = 'shared'; journal.entries[book.id] = record; await saveJournal(journalFile, journal);
      }
      if (!['complete', 'shared'].includes(record.state) || !record.baidu) throw new BaiduError(`${book.id}: 状态 ${record.state} 需要人工恢复`);
      validateBaiduDownload(record.baidu, book.file.sha256);
      if (await catalogHash(target) !== beforeHash) throw new BaiduError(`${book.id}: catalog 在流程中变化，拒绝覆盖`);
      current.downloads.baidu = record.baidu;
      const tmp = `${target}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(current, null, 2) + '\n'); await rename(tmp, target);
      record.catalogHash = await catalogHash(target); record.state = 'complete'; journal.entries[book.id] = record; await saveJournal(journalFile, journal);
    }
    return { completed: selected.length, journalFile };
  } finally { await lock?.close(); await import('node:fs/promises').then(fs => fs.rm(lockFile, { force: true })); }
}
