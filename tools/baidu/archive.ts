import { createHash, randomInt, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import type { BaiduDownload, Book } from '../../src/lib/books.ts';
import { validateBaiduDownload } from '../../src/lib/baidu.ts';
import { replaceFileAtomically } from './atomic.ts';
import { call, confirmShareList, digest, ensureRemoteDirectory, locateInputs, parseMeta, parseShare, probeRemoteFile,
  type Runner, BaiduError } from './transfer.ts';

export type ArchiveInfo = { filename: string; sha256: string; bytes: number; password: string };
export type ArchiveManifest = { bookId: string; sourceSha256: string; localArchive: string; archive: ArchiveInfo;
  headersEncrypted?: boolean; innerEpubSha256Verified?: boolean; remotePath?: string; fsId?: string;
  roundtripVerified?: boolean; publicPasswordVerified?: boolean; baidu?: BaiduDownload; publicCheckedAt?: string };
export type ArchiveJournalEntry = { id: string; sourceSha256: string; archiveSha256: string; remotePath: string;
  catalogHash: string; state: 'ready' | 'uploaded' | 'verified' | 'uncertain' | 'shared' | 'complete';
  fsId?: string; baidu?: BaiduDownload; error?: string };
export type ArchiveJournal = { schemaVersion: 1; updatedAt: string; entries: Record<string, ArchiveJournalEntry> };
export type RarRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const archiveNamePattern = /^[^\\/:*?"<>|\u0000-\u001f]+\.rar$/iu;
export const archiveDigest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function createRarRunner(exe: string): RarRunner {
  return async args => await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true }); let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr }); });
  });
}

async function rarCall(run: RarRunner, args: string[], action: string) {
  const result = await run(args);
  if (result.code !== 0) throw new BaiduError(`WinRAR ${action} 未成功（退出码 ${result.code}）`);
  return result;
}
async function walkEpubs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkEpubs(file));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) files.push(file);
  }
  return files;
}
async function verifyArchive(archivePath: string, archive: ArchiveInfo, sourceSha256: string,
  expectedEpubName: string, rarRun: RarRunner, scratchRoot = os.tmpdir()) {
  if (!archiveNamePattern.test(archive.filename) || path.basename(archive.filename) !== archive.filename) throw new BaiduError('RAR 文件名无效');
  const bytes = await readFile(archivePath);
  if (bytes.length !== archive.bytes || archiveDigest(bytes) !== archive.sha256) throw new BaiduError('RAR 文件大小或 SHA-256 与 manifest 不符');
  const listing = await rarRun(['lb', '-p-', '-inul', archivePath]);
  if (listing.code !== 11) throw new BaiduError(`RAR 未证明文件头已加密（无密码 listing 退出码 ${listing.code}）`);
  await rarCall(rarRun, ['t', `-hp${archive.password}`, '-inul', archivePath], '完整性测试');
  const extractRoot = await mkdtemp(path.join(scratchRoot, 'yuuko-rar-'));
  try {
    await rarCall(rarRun, ['x', `-hp${archive.password}`, '-inul', '-y', archivePath, `${extractRoot}${path.sep}`], '解包校验');
    const epubs = await walkEpubs(extractRoot);
    if (epubs.length !== 1 || path.basename(epubs[0]) !== expectedEpubName) throw new BaiduError('RAR 必须只含正式文件名对应的一个 EPUB');
    const resolved = path.resolve(epubs[0]);
    if (!resolved.startsWith(path.resolve(extractRoot) + path.sep)) throw new BaiduError('RAR 解包路径超出临时目录');
    const inner = await readFile(epubs[0]);
    if (archiveDigest(inner) !== sourceSha256) throw new BaiduError('RAR 内 EPUB SHA-256 与当前原版不符');
  } finally {
    const rootResolved = path.resolve(scratchRoot); const extractResolved = path.resolve(extractRoot);
    const relative = path.relative(rootResolved, extractResolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !path.basename(extractResolved).startsWith('yuuko-rar-')) throw new BaiduError('RAR 临时解包目录超出安全清理根目录，保留文件');
    await rm(extractResolved, { recursive: true, force: true });
  }
}
async function saveJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await replaceFileAtomically(tmp, file);
}
export async function loadArchiveJournal(file: string): Promise<ArchiveJournal> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as ArchiveJournal;
    if (value.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object') throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: {} };
    throw new BaiduError('archive journal 格式无效');
  }
}
async function saveArchiveJournal(file: string, journal: ArchiveJournal) {
  journal.updatedAt = new Date().toISOString(); await saveJson(file, journal);
}
function checkArchivePassword(value: string) {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new BaiduError('RAR 密码无效');
}

export async function prepareArchive(root: string, book: Book, name: string, password: string,
  rarRun: RarRunner, options: { manifestPath?: string; scratchRoot?: string } = {}) {
  if (!archiveNamePattern.test(name) || path.basename(name) !== name || name.endsWith('. ') || name.endsWith('.')) throw new BaiduError('--name 必须是安全的 .rar 文件名');
  checkArchivePassword(password);
  const source = (await locateInputs(root, [book])).get(book.id)!;
  const sourceBytes = await readFile(source.file);
  if (source.bytes !== book.file.bytes || archiveDigest(sourceBytes) !== book.file.sha256) throw new BaiduError(`${book.id}: 原 EPUB 校验失败`);
  const outputDir = path.join(root, '.local/baidu/archives', book.id, book.file.sha256);
  const archivePath = path.join(outputDir, name); await mkdir(outputDir, { recursive: true });
  if (path.basename(book.file.filename) !== book.file.filename || /[\\/\0]/u.test(book.file.filename)) throw new BaiduError('书目 EPUB 文件名无效');
  const inputPath = path.join(root, '.local/baidu/archive-inputs', book.id, book.file.sha256, book.file.filename);
  await mkdir(path.dirname(inputPath), { recursive: true });
  try { await copyFile(source.file, inputPath, fsConstants.COPYFILE_EXCL); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stagedInput = await readFile(inputPath);
  if (stagedInput.length !== book.file.bytes || archiveDigest(stagedInput) !== book.file.sha256) throw new BaiduError('归档输入 staging 文件 SHA-256 不匹配');
  const lockPath = `${archivePath}.lock`; let lock;
  try { lock = await open(lockPath, 'wx'); } catch { throw new BaiduError('此 RAR 正在生成；检查锁状态后重试'); }
  try {
    let cached: ArchiveInfo | null = null;
    try {
      const fileBytes = await readFile(archivePath);
      cached = { filename: name, sha256: archiveDigest(fileBytes), bytes: fileBytes.length, password };
      await verifyArchive(archivePath, cached, book.file.sha256, book.file.filename, rarRun, options.scratchRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!cached) {
      const tempArchive = path.join(outputDir, `.build-${randomUUID()}.rar`);
      try {
        await rarCall(rarRun, ['a', '-ma5', '-ep', `-hp${password}`, '-inul', '-y', tempArchive, inputPath], '加密归档');
        const fileBytes = await readFile(tempArchive);
        const archive: ArchiveInfo = { filename: name, sha256: archiveDigest(fileBytes), bytes: fileBytes.length, password };
        await verifyArchive(tempArchive, archive, book.file.sha256, book.file.filename, rarRun, options.scratchRoot);
        try { await rename(tempArchive, archivePath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const finalBytes = await readFile(archivePath);
        cached = { ...archive, sha256: archiveDigest(finalBytes), bytes: finalBytes.length };
        await verifyArchive(archivePath, cached, book.file.sha256, book.file.filename, rarRun, options.scratchRoot);
      } finally {
        // A failed build is retained for inspection; never remove a possibly useful artifact.
      }
    }
    const manifest: ArchiveManifest = { bookId: book.id, sourceSha256: book.file.sha256, localArchive: archivePath,
      archive: cached, headersEncrypted: true, innerEpubSha256Verified: true };
    const manifestPath = options.manifestPath ?? path.join(root, '.local/baidu/archive-manifests', `${book.id}-${book.file.sha256}.json`);
    await saveJson(manifestPath, manifest);
    return { manifestPath, manifest };
  } finally { await lock?.close(); await rm(lockPath, { force: true }); }
}

function archiveRemotePath(id: string, sourceSha: string, archive: ArchiveInfo) {
  return `/yuuko-library/archives/${id}/${sourceSha}/${archive.sha256}/${archive.filename}`;
}
function validateManifest(value: ArchiveManifest, book: Book) {
  checkArchivePassword(value.archive?.password ?? '');
  if (value.bookId !== book.id || value.sourceSha256 !== book.file.sha256 || !/^[a-f\d]{64}$/iu.test(value.sourceSha256)) {
    throw new BaiduError('archive manifest 与当前书目版本不匹配');
  }
  if (!value.archive || !archiveNamePattern.test(value.archive.filename) || path.basename(value.archive.filename) !== value.archive.filename
    || !/^[a-f\d]{64}$/iu.test(value.archive.sha256) || !Number.isSafeInteger(value.archive.bytes) || value.archive.bytes <= 0) {
    throw new BaiduError('archive manifest 文件元数据无效');
  }
  const remote = archiveRemotePath(book.id, book.file.sha256, value.archive);
  if (value.remotePath && value.remotePath !== remote) throw new BaiduError('archive manifest 远端路径与固定路径不符');
  if (value.baidu) {
    validateBaiduDownload(value.baidu, book.file.sha256);
    if (!value.baidu.archive || value.baidu.archive.filename !== value.archive.filename || value.baidu.archive.sha256 !== value.archive.sha256
      || value.baidu.archive.bytes !== value.archive.bytes || value.baidu.archive.password !== value.archive.password || value.baidu.path !== remote
      || (value.fsId && value.fsId !== value.baidu.fsId)) throw new BaiduError('archive manifest 分享记录与 RAR 元数据不符');
  }
  return remote;
}

export async function publishArchive(root: string, books: Book[], manifestPath: string, run: Runner, rarRun: RarRunner,
  options: { journalPath?: string; roundtripRoot?: string; now?: () => Date } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ArchiveManifest;
  const book = books.find(item => item.id === manifest.bookId);
  if (!book) throw new BaiduError(`archive manifest 指向未知书目：${manifest.bookId}`);
  const remotePath = validateManifest(manifest, book);
  const sources = await locateInputs(root, [book]); const source = sources.get(book.id)!;
  const sourceBytes = await readFile(source.file);
  if (archiveDigest(sourceBytes) !== book.file.sha256 || source.bytes !== book.file.bytes) throw new BaiduError('当前原 EPUB 版本校验失败');
  await verifyArchive(manifest.localArchive, manifest.archive, book.file.sha256, book.file.filename, rarRun);
  const target = path.join(root, 'catalog/books', `${book.id}.json`);
  const initialCatalogBytes = await readFile(target); const current = JSON.parse(initialCatalogBytes.toString('utf8')) as Book;
  const beforeHash = archiveDigest(initialCatalogBytes);
  if (current.file.sha256 !== manifest.sourceSha256 || current.file.bytes !== book.file.bytes) throw new BaiduError('catalog 原 EPUB 已变化');
  const journalFile = options.journalPath ?? path.join(root, '.local/baidu/archive-journal.json');
  const lockPath = `${journalFile}.lock`; const projectLockPath = path.join(root, '.local/baidu/journal.json.lock');
  await mkdir(path.dirname(journalFile), { recursive: true });
  let projectLock; let lock;
  try { projectLock = await open(projectLockPath, 'wx'); } catch { throw new BaiduError('Baidu 项目操作锁已存在，暂停归档发布'); }
  try { lock = await open(lockPath, 'wx'); } catch {
    await projectLock.close(); await rm(projectLockPath, { force: true }); throw new BaiduError('archive journal 锁已存在');
  }
  try {
    const journal = await loadArchiveJournal(journalFile); const previous = journal.entries[book.id];
    if (previous && (previous.sourceSha256 !== book.file.sha256 || previous.archiveSha256 !== manifest.archive.sha256)) {
      throw new BaiduError('archive journal 对应了不同的书籍或归档版本');
    }
    const reusedVerifiedRecord = Boolean(previous?.state === 'complete' && previous.baidu);
    if (reusedVerifiedRecord && previous?.baidu) {
      if (beforeHash !== previous.catalogHash || JSON.stringify(current.downloads.baidu) !== JSON.stringify(previous.baidu)) {
        throw new BaiduError('已完成归档的书目记录已变化，拒绝覆盖');
      }
    }
    let record: ArchiveJournalEntry = previous ?? { id: book.id, sourceSha256: book.file.sha256,
      archiveSha256: manifest.archive.sha256, remotePath, catalogHash: beforeHash, state: 'ready' };
    if (record.remotePath !== remotePath) throw new BaiduError('archive journal 远端路径与本次归档不符');
    if (manifest.baidu) { record.baidu = manifest.baidu; record.fsId = manifest.baidu.fsId; record.state = 'shared'; }
    else if (record.baidu && record.state === 'uncertain') {
      // A known share is only looked up again; share set is never repeated.
    }
    const remote = await probeRemoteFile(run, remotePath);
    if (!remote && record.state !== 'ready') throw new BaiduError('归档 journal 声称远端对象已存在，但 meta 查无此文件');
    if (!remote && record.state === 'ready') {
      await ensureRemoteDirectory(run, path.posix.dirname(remotePath));
      const localBytes = await readFile(manifest.localArchive);
      if (localBytes.length !== manifest.archive.bytes || archiveDigest(localBytes) !== manifest.archive.sha256) throw new BaiduError('上传前 RAR 本地哈希已变化');
      await call(run, ['upload', '--policy', 'skip', '--retry', '0', '-p', '1', manifest.localArchive, path.posix.dirname(remotePath)],
        out => /上传文件成功|上传成功|成功上传|跳过|upload(?:ed)? successfully/iu.test(out));
      const uploaded = await probeRemoteFile(run, remotePath);
      if (!uploaded || uploaded.bytes !== manifest.archive.bytes) throw new BaiduError('RAR 上传后 meta 核对失败');
      record.fsId = uploaded.fsId; record.state = 'uploaded'; journal.entries[book.id] = record; await saveArchiveJournal(journalFile, journal);
    } else if (remote) {
      if (remote.bytes !== manifest.archive.bytes || (record.fsId && remote.fsId !== record.fsId)) throw new BaiduError('远端 RAR meta 与 manifest 不匹配');
      record.fsId = remote.fsId;
      if (record.state === 'ready') { record.state = 'uploaded'; journal.entries[book.id] = record; await saveArchiveJournal(journalFile, journal); }
    }
    const meta = parseMeta(await call(run, ['meta', remotePath]), remotePath);
    if (meta.bytes !== manifest.archive.bytes || (record.fsId && meta.fsId !== record.fsId)) throw new BaiduError('远端 RAR meta 核验失败');
    record.fsId = meta.fsId;
    const roundtripBase = path.join(options.roundtripRoot ?? path.join(root, '.local/baidu/archive-roundtrip'), `${book.id}-${manifest.archive.sha256}`);
    let downloaded: Buffer | null = null;
    try { downloaded = await readFile(path.join(roundtripBase, manifest.archive.filename)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!downloaded || downloaded.length !== manifest.archive.bytes || archiveDigest(downloaded) !== manifest.archive.sha256) {
      const roundtripDir = path.join(roundtripBase, `attempt-${randomUUID()}`); await mkdir(roundtripDir, { recursive: true });
      await call(run, ['download', '--saveto', roundtripDir, '--mode', 'pcs', '--retry', '0', '-p', '1', remotePath],
        out => /下载完成|下载成功|成功下载|download(?:ed)? successfully/iu.test(out));
      downloaded = await readFile(path.join(roundtripDir, manifest.archive.filename));
    }
    if (downloaded.length !== manifest.archive.bytes || archiveDigest(downloaded) !== manifest.archive.sha256) throw new BaiduError('远端 RAR 完整回读 SHA-256 失败');
    const roundtripFile = path.join(options.roundtripRoot ?? path.join(root, '.local/baidu/archive-roundtrip'), `${book.id}-${manifest.archive.sha256}-verified-${randomUUID()}`, manifest.archive.filename);
    await mkdir(path.dirname(roundtripFile), { recursive: true }); await writeFile(roundtripFile, downloaded, { flag: 'wx' });
    await verifyArchive(roundtripFile, manifest.archive, book.file.sha256, book.file.filename, rarRun);
    if (!['uncertain', 'shared', 'complete'].includes(record.state)) record.state = 'verified';
    journal.entries[book.id] = record; await saveArchiveJournal(journalFile, journal);
    if (manifest.baidu) {
      validateBaiduDownload(manifest.baidu, book.file.sha256);
      const listed = await call(run, ['share', 'list']); confirmShareList(listed, manifest.baidu);
      if (listed.includes(manifest.baidu.shareId) && meta.fsId === manifest.baidu.fsId) record.baidu = manifest.baidu;
      else throw new BaiduError('现有RAR分享无法远端复核');
      record.state = 'shared';
    } else if (record.state === 'complete' || record.state === 'shared') {
      if (!record.baidu) throw new BaiduError('完成的归档journal缺少分享记录');
      const listed = await call(run, ['share', 'list']); confirmShareList(listed, record.baidu);
    } else if (record.state === 'uncertain') {
      if (!record.baidu) throw new BaiduError('分享结果未知且 journal 无可核对分享记录，禁止重复创建');
      const listed = await call(run, ['share', 'list']); confirmShareList(listed, record.baidu); record.state = 'shared';
    } else if (record.state === 'verified') {
      record.state = 'uncertain'; journal.entries[book.id] = record; await saveArchiveJournal(journalFile, journal);
      const password = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
      const out = await call(run, ['share', 'set', '-p', password, '--period', '0', remotePath]); const share = parseShare(out);
      if (share.code !== password) throw new BaiduError('RAR 分享提取码与请求不符，分享状态未知');
      record.baidu = { url: share.url, code: share.code, fileSha256: book.file.sha256, fsId: meta.fsId, shareId: share.shareId,
        path: remotePath, expiresAt: null, verifiedAt: (options.now?.() ?? new Date()).toISOString(), archive: manifest.archive };
      validateBaiduDownload(record.baidu, book.file.sha256); journal.entries[book.id] = record; await saveArchiveJournal(journalFile, journal);
      const listed = await call(run, ['share', 'list']); confirmShareList(listed, record.baidu); record.state = 'shared';
    }
    if (!record.baidu) throw new BaiduError('归档分享未确认，状态暂停');
    if (archiveDigest(await readFile(target)) !== beforeHash) throw new BaiduError('catalog 在归档校验期间变化，拒绝覆盖');
    const beforeBaudu = JSON.stringify(current.downloads.baidu);
    if (beforeBaudu !== JSON.stringify(record.baidu)) {
      current.downloads.baidu = record.baidu;
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(current, null, 2) + '\n'); await replaceFileAtomically(tmp, target);
    }
    record.catalogHash = archiveDigest(await readFile(target)); record.state = 'complete'; journal.entries[book.id] = record;
    await saveArchiveJournal(journalFile, journal);
    return { id: book.id, status: 'complete', reused: Boolean(manifest.baidu || reusedVerifiedRecord), remotePath };
  } finally {
    await lock?.close(); await rm(lockPath, { force: true });
    await projectLock?.close(); await rm(projectLockPath, { force: true });
  }
}
