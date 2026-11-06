import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import type { Book, BaiduDownload } from '../src/lib/books.ts';
import { archiveVersionKey, prepareArchive, publishArchive, recoverUnknownArchiveShare, type ArchiveManifest, type RarRunner } from '../tools/baidu/archive.ts';
import { digest, runPublish, type Runner } from '../tools/baidu/transfer.ts';

const epub = Buffer.from('source epub bytes'); const epubSha = digest(epub); const rarBytes = Buffer.from('mock encrypted rar bytes');
function book(id = 'sample'): Book { return { schemaVersion: 1, id, title: '书', authors: [], description: '', subjects: [], categories: ['history'], cover: null,
  edition: { kind: 'transcription', model: null }, file: { sha256: epubSha, bytes: epub.length, filename: '书.epub' },
  downloads: { r2Key: `books/${id}/${epubSha}.epub`, r2Url: 'https://download.example/file.epub', baidu: null }, publishedAt: null, updatedAt: null }; }
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-archive-')); const b = book();
  await mkdir(path.join(root, 'catalog/books'), { recursive: true }); await mkdir(path.join(root, '.local/plans/p1/inputs'), { recursive: true });
  await writeFile(path.join(root, 'catalog/books/sample.json'), JSON.stringify(b));
  await writeFile(path.join(root, '.local/plans/p1/inputs/sample.epub'), epub);
  return { root, b, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
function rarMock(listingCode = 11): { runner: RarRunner; creates: () => number } {
  let createCount = 0;
  return { creates: () => createCount, runner: async args => {
    if (args[0] === 'a') { createCount++; await writeFile(args.at(-2)!, rarBytes); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'lb') return { code: listingCode, stdout: '', stderr: '' };
    if (args[0] === 't') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'x') { const dest = args.at(-1)!; await mkdir(dest, { recursive: true }); await writeFile(path.join(dest, '书.epub'), epub); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected RAR command ${args[0]}`);
  } };
}
test('prepare-archive uses encrypted-header options, verifies the inner EPUB and reuses cache', async () => {
  const t = await setup(); const rar = rarMock();
  try {
    const first = await prepareArchive(t.root, t.b, '普兰查斯著作01.rar', '114514', rar.runner);
    assert.equal(first.manifest.archive.sha256, digest(rarBytes)); assert.equal(first.manifest.archive.bytes, rarBytes.length);
    assert.equal(first.manifest.headersEncrypted, true); assert.equal(first.manifest.innerEpubSha256Verified, true);
    const second = await prepareArchive(t.root, t.b, '普兰查斯著作01.rar', '114514', rar.runner);
    assert.equal(rar.creates(), 1); assert.equal(second.manifest.archive.sha256, first.manifest.archive.sha256);
  } finally { await t.cleanup(); }
});
test('an archive that can be listed without a password is refused', async () => {
  const t = await setup(); const rar = rarMock(0);
  try {
    await assert.rejects(prepareArchive(t.root, t.b, 'plain.rar', '114514', rar.runner), /未证明文件头已加密/);
  } finally { await t.cleanup(); }
});
test('same source can explicitly prepare a second named RAR while preserving the published artifact', async () => {
  const t = await setup(); const rar = rarMock();
  try {
    const archive = { filename: 'published.rar', sha256: digest(rarBytes), bytes: rarBytes.length, password: '114514' };
    t.b.downloads.baidu = { url: 'https://pan.baidu.com/s/AbCdEF12', code: '4o9z', fileSha256: epubSha,
      fsId: '12345', shareId: '23456', path: `/yuuko-library/archives/sample/${epubSha}/${archive.sha256}/${archive.filename}`,
      expiresAt: null, verifiedAt: '2026-11-06T11:00:47.052Z', archive };
    const next = await prepareArchive(t.root, t.b, 'new-random-salt.rar', '114514', rar.runner);
    assert.notEqual(next.manifest.archive.filename, archive.filename);
    assert.equal(next.manifest.archive.sha256, digest(rarBytes));
  } finally { await t.cleanup(); }
});
test('unknown RAR share recovery checks entity SHA and exact share row before updating the current pointer', async () => {
  const t = await setup();
  try {
    const archive = { filename: 'hidden.rar', sha256: digest(rarBytes), bytes: rarBytes.length, password: '114514' };
    const remotePath = `/yuuko-library/archives/sample/${epubSha}/${archive.sha256}/${archive.filename}`;
    const manifest: ArchiveManifest = { bookId: 'sample', sourceSha256: epubSha, localArchive: '/unused', archive };
    const manifestPath = path.join(t.root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    const journalPath = path.join(t.root, '.local/baidu/archive-journal.json'); await mkdir(path.dirname(journalPath), { recursive: true });
    const entry = { id: 'sample', sourceSha256: epubSha, archiveSha256: archive.sha256, archiveBytes: archive.bytes,
      remotePath, catalogHash: '', state: 'uncertain', fsId: '12345' };
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(),
      entries: { [archiveVersionKey('sample', epubSha, archive.sha256, archive.filename)]: entry } }));
    const runner: Runner = async args => {
      if (args[0] === 'meta') return { code: 0, stdout: `类型 文件\n文件路径 ${remotePath}\n文件大小 ${rarBytes.length}, 0.3KB\nfs_id 12345`, stderr: '' };
      if (args[0] === 'download') { const dir = args[args.indexOf('--saveto') + 1]; await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, archive.filename), rarBytes); return { code: 0, stdout: '下载完成', stderr: '' }; }
      if (args[0] === 'share' && args[1] === 'list') return { code: 0,
        stdout: `# SHAREID 分享链接 提取密码 特征目录 特征路径 过期时间 浏览次数\n0 456789 https://pan.baidu.com/s/RarLink 7x9q /yuuko-library/archives/sample/${epubSha}/${archive.sha256} ${remotePath} 永久 1`, stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };
    const result = await recoverUnknownArchiveShare(t.root, [t.b], manifestPath, runner, '456789', '7x9q');
    assert.equal(result.status, 'recovered');
    const current = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.equal(current.downloads.baidu?.archive?.sha256, archive.sha256);
  } finally { await t.cleanup(); }
});
test('new EPUB SHA gets a separate RAR archive share while the older archive record stays intact', async () => {
  const t = await setup(); let shareSerial = 0;
  const makeRar = (payload: Buffer, epubName: string): RarRunner => async args => {
    if (args[0] === 'a') { await writeFile(args.at(-2)!, rarBytes); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'lb') return { code: 11, stdout: '', stderr: '' };
    if (args[0] === 't') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'x') { await mkdir(args.at(-1)!, { recursive: true }); await writeFile(path.join(args.at(-1)!, epubName), payload); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected RAR command ${args[0]}`);
  };
  const makeCloud = (manifest: ArchiveManifest): Runner => {
    let uploaded = false; let shareId = ''; let code = '';
    const remotePath = `/yuuko-library/archives/sample/${manifest.sourceSha256}/${manifest.archive.sha256}/${manifest.archive.filename}`;
    return async args => {
      if (args[0] === 'mkdir') return { code: 0, stdout: '创建目录成功', stderr: '' };
      if (args[0] === 'upload') { uploaded = true; return { code: 0, stdout: '上传文件成功', stderr: '' }; }
      if (args[0] === 'meta' && !uploaded) return { code: 0, stdout: '遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件不存在', stderr: '' };
      if (args[0] === 'meta') return { code: 0, stdout: `类型 文件\n文件路径 ${remotePath}\n文件大小 ${manifest.archive.bytes}, 0.3KB\nfs_id 12345`, stderr: '' };
      if (args[0] === 'download') { const dir = args[args.indexOf('--saveto') + 1]; await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, manifest.archive.filename), rarBytes); return { code: 0, stdout: '下载完成', stderr: '' }; }
      if (args[0] === 'share' && args[1] === 'set') {
        code = args[args.indexOf('-p') + 1]; shareId = String(++shareSerial);
        return { code: 0, stdout: `shareID: ${shareId}, 链接: https://pan.baidu.com/s/${shareId}Link, 密码: ${code}`, stderr: '' };
      }
      if (args[0] === 'share' && args[1] === 'list') return { code: 0,
        stdout: `# SHAREID 分享链接 提取密码 特征目录 特征路径 过期时间 浏览次数\n0 ${shareId} https://pan.baidu.com/s/${shareId}Link ${code} /yuuko-library/archives/sample/${manifest.sourceSha256}/${manifest.archive.sha256} ${remotePath} 永久 1`, stderr: '' };
      throw new Error(`unexpected command ${args.join(' ')}`);
    };
  };
  try {
    const firstPrepared = await prepareArchive(t.root, t.b, 'v1.rar', '114514', makeRar(epub, '书.epub'));
    await publishArchive(t.root, [t.b], firstPrepared.manifestPath, makeCloud(firstPrepared.manifest), makeRar(epub, '书.epub'));
    const nextEpub = Buffer.from('replacement source epub'); const nextSha = digest(nextEpub);
    const current = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    const next: Book = { ...current, title: '新版', file: { sha256: nextSha, bytes: nextEpub.length, filename: '新版.epub' },
      downloads: { ...current.downloads, r2Key: `books/sample/${nextSha}.epub`, baidu: null } };
    await writeFile(path.join(t.root, 'catalog/books/sample.json'), JSON.stringify(next));
    const inputDir = path.join(t.root, '.local/plans/p2/inputs'); await mkdir(inputDir, { recursive: true }); await writeFile(path.join(inputDir, 'sample.epub'), nextEpub);
    const secondRar = makeRar(nextEpub, '新版.epub');
    const secondPrepared = await prepareArchive(t.root, next, 'v2.rar', '114514', secondRar);
    await publishArchive(t.root, [next], secondPrepared.manifestPath, makeCloud(secondPrepared.manifest), secondRar);
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/archive-journal.json'), 'utf8'));
    const firstKey = `sample@${epubSha}@${firstPrepared.manifest.archive.sha256}@${digest('v1.rar').slice(0, 12)}`;
    const secondKey = `sample@${nextSha}@${secondPrepared.manifest.archive.sha256}@${digest('v2.rar').slice(0, 12)}`;
    assert.equal(journal.entries[firstKey].state, 'complete'); assert.equal(journal.entries[secondKey].state, 'complete');
    assert.notEqual(journal.entries[firstKey].baidu.path, journal.entries[secondKey].baidu.path);
    const final = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.equal(final.downloads.baidu?.fileSha256, nextSha); assert.equal(final.downloads.baidu?.archive?.filename, 'v2.rar');
  } finally { await t.cleanup(); }
});
test('an unresolved raw share blocks RAR publishing for the same stable book ID', async () => {
  const t = await setup(); let calls = 0;
  try {
    const rar = rarMock(); const prepared = await prepareArchive(t.root, t.b, 'blocked.rar', '114514', rar.runner);
    const rawJournal = path.join(t.root, '.local/baidu/journal.json'); await mkdir(path.dirname(rawJournal), { recursive: true });
    await writeFile(rawJournal, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(),
      entries: { [`sample@${epubSha}`]: { id: 'sample', sha256: epubSha, state: 'uncertain' } } }));
    await assert.rejects(publishArchive(t.root, [t.b], prepared.manifestPath, async () => { calls++; throw new Error('must stop before cloud'); }, rar.runner), /原 EPUB 分享结果/);
    assert.equal(calls, 0);
  } finally { await t.cleanup(); }
});
test('verified archive manifest imports after remote meta, full download, inner hash and share list checks without share.set', async () => {
  const t = await setup(); const rar = rarMock(); let writes = 0;
  try {
    const archiveDir = path.join(t.root, '.local/baidu/archive-source'); await mkdir(archiveDir, { recursive: true });
    const localArchive = path.join(archiveDir, '普兰查斯著作01.rar'); await writeFile(localArchive, rarBytes);
    const archive = { filename: '普兰查斯著作01.rar', sha256: digest(rarBytes), bytes: rarBytes.length, password: '114514' };
    const remotePath = `/yuuko-library/archives/sample/${epubSha}/${archive.sha256}/${archive.filename}`;
    const baidu: BaiduDownload = { url: 'https://pan.baidu.com/s/AbCdEF12', code: '4o9z', fileSha256: epubSha,
      fsId: '1014886564607325', shareId: '14132849062', path: remotePath, expiresAt: null,
      verifiedAt: '2026-11-06T11:00:47.052Z', archive };
    const manifest = { bookId: 'sample', sourceSha256: epubSha, localArchive, archive, remotePath,
      fsId: baidu.fsId, baidu, headersEncrypted: true, innerEpubSha256Verified: true, roundtripVerified: true, publicPasswordVerified: true };
    const manifestPath = path.join(archiveDir, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    const cloud: Runner = async args => {
      if (args[0] === 'meta') return { code: 0, stdout: `类型       文件\n文件路径   ${remotePath}\n文件大小   ${rarBytes.length}, 0.3KB\nfs_id      ${baidu.fsId}`, stderr: '' };
      if (args[0] === 'download') { const dir = args[args.indexOf('--saveto') + 1]; await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, archive.filename), rarBytes); return { code: 0, stdout: '下载完成, 保存位置: archive', stderr: '' }; }
      if (args[0] === 'share' && args[1] === 'list') return { code: 0,
        stdout: `# SHAREID 分享链接 提取密码 特征目录 特征路径 过期时间 浏览次数\n0 ${baidu.shareId} ${baidu.url} ${baidu.code} /yuuko-library/archives/sample/${epubSha}/${archive.sha256} ${remotePath} 永久 1`, stderr: '' };
      if (args[0] === 'share' && args[1] === 'set' || args[0] === 'upload') { writes++; throw new Error('existing manifest must not create or upload'); }
      throw new Error(`unexpected cloud command ${args[0]}`);
    };
    const result = await publishArchive(t.root, [t.b], manifestPath, cloud, rar.runner);
    assert.equal(result.status, 'complete'); assert.equal(writes, 0);
    const current = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.deepEqual(current.downloads.baidu, baidu);
    const archiveJournal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/archive-journal.json'), 'utf8'));
    assert.equal(archiveJournal.entries[`sample@${epubSha}@${archive.sha256}@${digest(archive.filename).slice(0, 12)}`].state, 'complete');
    current.title = '归档同SHA展示元数据更新'; await writeFile(path.join(t.root, 'catalog/books/sample.json'), JSON.stringify(current));
    const metadataReuse = await runPublish(t.root, [current], async () => { throw new Error('same-SHA RAR reuse should not call cloud'); });
    assert.equal(metadataReuse.completed, 1);
    const rawResult = await runPublish(t.root, [current], async () => { throw new Error('raw publish must not overwrite a verified archive'); });
    assert.equal(rawResult.completed, 1);
  } finally { await t.cleanup(); }
});
