import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import type { Book, BaiduDownload } from '../src/lib/books.ts';
import { prepareArchive, publishArchive, type RarRunner } from '../tools/baidu/archive.ts';
import { digest, runPublish, type Runner } from '../tools/baidu/transfer.ts';

const epub = Buffer.from('source epub bytes'); const epubSha = digest(epub); const rarBytes = Buffer.from('mock encrypted rar bytes');
function book(id = 'sample'): Book { return { schemaVersion: 1, id, title: '书', authors: [], description: '', subjects: [], categories: ['fiction'], cover: null,
  edition: { kind: 'transcription', model: null }, file: { sha256: epubSha, bytes: epub.length, filename: '书.epub' },
  downloads: { r2Key: `books/${id}/${epubSha}.epub`, r2Url: 'https://download.example/file.epub', baidu: null }, publishedAt: null, updatedAt: null }; }
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-archive-')); const b = book();
  await mkdir(path.join(root, 'catalog/books'), { recursive: true }); await mkdir(path.join(root, '.local/plans/p1/inputs'), { recursive: true });
  await writeFile(path.join(root, 'catalog/books/sample.json'), JSON.stringify(b));
  await writeFile(path.join(root, '.local/plans/p1/inputs/sample.epub'), epub);
  return { root, b, cleanup: () => rm(root, { recursive: true, force: true }) };
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
test('prepare refuses to regenerate a book with an already published RAR', async () => {
  const t = await setup(); let rarCalls = 0;
  try {
    const archive = { filename: 'published.rar', sha256: digest(rarBytes), bytes: rarBytes.length, password: '114514' };
    t.b.downloads.baidu = { url: 'https://pan.baidu.com/s/AbCdEF12', code: '4o9z', fileSha256: epubSha,
      fsId: '12345', shareId: '23456', path: `/yuuko-library/archives/sample/${epubSha}/${archive.sha256}/${archive.filename}`,
      expiresAt: null, verifiedAt: '2026-11-06T11:00:47.052Z', archive };
    await assert.rejects(prepareArchive(t.root, t.b, 'new-random-salt.rar', '114514', async () => {
      rarCalls++; return { code: 0, stdout: '', stderr: '' };
    }), /已发布 RAR.*原发布 manifest/);
    assert.equal(rarCalls, 0);
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
    assert.equal(archiveJournal.entries.sample.state, 'complete');
    const rawResult = await runPublish(t.root, [current], async () => { throw new Error('raw publish must not overwrite a verified archive'); });
    assert.equal(rawResult.completed, 1);
  } finally { await t.cleanup(); }
});
