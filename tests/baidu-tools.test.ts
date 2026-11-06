import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import type { Book } from '../src/lib/books.ts';
import { digest, recoverUnknownShare, runPublish, type Runner } from '../tools/baidu/transfer.ts';

const bytes = Buffer.from('sample epub payload'); const sha = digest(bytes);
function book(id = 'sample'): Book { return { schemaVersion: 1, id, title: '书', authors: ['作者'], description: '', subjects: [], categories: ['history'], cover: null,
  edition: { kind: 'transcription', model: null }, file: { sha256: sha, bytes: bytes.length, filename: '书.epub' },
  downloads: { r2Key: `books/${id}/${sha}.epub`, r2Url: 'https://download.example/file.epub', baidu: null }, publishedAt: '2020-01-01', updatedAt: '2024-01-01' }; }
async function setup(id = 'sample') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-tools-')); const b = book(id);
  await mkdir(path.join(root, 'catalog/books'), { recursive: true });
  await mkdir(path.join(root, '.local/plans/p1/inputs'), { recursive: true });
  await writeFile(path.join(root, 'catalog/books', `${id}.json`), JSON.stringify(b));
  await writeFile(path.join(root, '.local/plans/p1/inputs', `${id}.epub`), bytes);
  return { root, b, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
function mock(overrides: { shareExit?: number; listExit?: number; onCall?: (args: string[]) => void; wrongMeta?: boolean; wrongRoundtrip?: boolean; existing?: boolean; directoryExists?: boolean; payload?: Buffer; fileSha?: string; filename?: string; shareCode?: string } = {}): Runner {
  const payload = overrides.payload ?? bytes; const fileSha = overrides.fileSha ?? sha; const filename = overrides.filename ?? '书.epub';
  const shareCode = overrides.shareCode ?? 'a1b2';
  let uploaded = overrides.existing ?? false;
  return async args => {
    overrides.onCall?.(args);
    if (args[0] === 'mkdir') return overrides.directoryExists
      ? { code: 0, stdout: '创建目录: 遇到错误, 远端服务器返回错误, 代码: 31061, 消息: 文件已存在', stderr: '' }
      : { code: 0, stdout: '创建目录成功', stderr: '' };
    if (args[0] === 'upload') { uploaded = true; return { code: 0, stdout: '上传文件成功, 保存到网盘路径: /yuuko-library/books/sample', stderr: '' }; }
    if (args[0] === 'meta' && overrides.directoryExists && !args[1].endsWith('.epub')) return { code: 0,
      stdout: `类型      目录\n目录路径  ${args[1]}\n目录名称  ${sha}\nfs_id     654321`, stderr: '' };
    if (args[0] === 'meta' && !uploaded) return { code: 0, stdout: '遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件或目录不存在', stderr: '' };
    if (args[0] === 'meta') return { code: 0, stdout: `类型               文件\n文件路径           ${args[1]}\n文件大小          ${overrides.wrongMeta ? 12 : payload.length}, 0.02KB\nfs_id             123456`, stderr: '' };
    if (args[0] === 'download') { const dir = args[args.indexOf('--saveto') + 1]; await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, filename), overrides.wrongRoundtrip ? Buffer.from('corrupt') : payload); return { code: 0, stdout: `下载完成, 保存位置: ${filename}`, stderr: '' }; }
    if (args[0] === 'share' && args[1] === 'set') return { code: overrides.shareExit ?? 0,
      stdout: `shareID: 987654, 链接: https://pan.baidu.com/s/Abcde_12, 密码: ${shareCode}`, stderr: '' };
    if (args[0] === 'share' && args[1] === 'list') return { code: overrides.listExit ?? 0, stdout: `# SHAREID 分享链接 提取密码 特征目录 特征路径 过期时间 浏览次数\n0 987654 https://pan.baidu.com/s/Abcde_12 ${shareCode} /yuuko-library/books/sample/${fileSha} /yuuko-library/books/sample/${fileSha}/${filename} 永久 2`, stderr: '' };
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
}
test('exit 0 with upload semantic failure is rejected', async () => {
  const t = await setup(); try {
    await assert.rejects(runPublish(t.root, [t.b], async args => args[0] === 'mkdir'
      ? { code: 0, stdout: '创建目录成功', stderr: '' } : args[0] === 'meta'
        ? { code: 0, stdout: '遇到错误, 远端服务器返回错误, 代码: 31066, 消息: 文件或目录不存在', stderr: '' }
        : { code: 0, stdout: '传输中断', stderr: '' }), /结果未确认/);
  } finally { await t.cleanup(); }
});
test('valid upload, complete roundtrip and share update catalog without changing timestamps or R2', async () => {
  const t = await setup(); try {
    let uploadedBasename = '';
    await runPublish(t.root, [t.b], mock({ onCall: args => {
      if (args[0] === 'upload') uploadedBasename = path.basename(args[args.length - 2]);
    } }), { password: 'a1b2' });
    assert.equal(uploadedBasename, '书.epub');
    const actual = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.equal(actual.downloads.r2Url, t.b.downloads.r2Url); assert.equal(actual.updatedAt, t.b.updatedAt);
    assert.deepEqual(actual.downloads.baidu, { url: 'https://pan.baidu.com/s/Abcde_12', code: 'a1b2', fileSha256: sha,
      fsId: '123456', shareId: '987654', path: `/yuuko-library/books/sample/${sha}/书.epub`, expiresAt: null,
      verifiedAt: actual.downloads.baidu?.verifiedAt });
  } finally { await t.cleanup(); }
});
test('publishing a new EPUB SHA creates a new share and keeps the older version history', async () => {
  const t = await setup(); let newSets = 0;
  try {
    await runPublish(t.root, [t.b], mock(), { password: 'a1b2' });
    const nextBytes = Buffer.from('replacement epub payload'); const nextSha = digest(nextBytes);
    const next: Book = { ...t.b, title: '更新标题', file: { sha256: nextSha, bytes: nextBytes.length, filename: '更新.epub' },
      downloads: { ...t.b.downloads, r2Key: `books/sample/${nextSha}.epub`, baidu: null } };
    await writeFile(path.join(t.root, 'catalog/books/sample.json'), JSON.stringify(next));
    const sourceDir = path.join(t.root, '.local/plans/p2/inputs'); await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'sample.epub'), nextBytes);
    await runPublish(t.root, [next], mock({ payload: nextBytes, fileSha: nextSha, filename: next.file.filename, shareCode: 'c3d4',
      onCall: args => { if (args[0] === 'share' && args[1] === 'set') newSets++; } }), { password: 'c3d4' });
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(journal.entries[`sample@${sha}`].state, 'complete');
    assert.equal(journal.entries[`sample@${nextSha}`].state, 'complete'); assert.equal(newSets, 1);
    assert.notEqual(journal.entries[`sample@${sha}`].baidu.path, journal.entries[`sample@${nextSha}`].baidu.path);
    assert.equal((JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book).downloads.baidu?.fileSha256, nextSha);
  } finally { await t.cleanup(); }
});
test('existing target directory and file are verified then resumed without a second upload', async () => {
  const t = await setup(); let uploads = 0;
  try {
    await runPublish(t.root, [t.b], mock({ existing: true, directoryExists: true,
      onCall: args => { if (args[0] === 'upload') uploads++; } }), { password: 'a1b2' });
    assert.equal(uploads, 0);
  } finally { await t.cleanup(); }
});
test('share result with nonzero exit is checkpointed uncertain and never retried', async () => {
  const t = await setup(); let shareSets = 0;
  try {
    const runner = mock({ shareExit: 1, onCall: args => { if (args[0] === 'share' && args[1] === 'set') shareSets++; } });
    await assert.rejects(runPublish(t.root, [t.b], runner), /结果未确认/);
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(journal.entries[`sample@${sha}`].state, 'uncertain');
    await assert.rejects(runPublish(t.root, [t.b], runner), /recover 诊断/);
    assert.equal(shareSets, 1);
  } finally { await t.cleanup(); }
});
test('known share set with uncertain listing resumes by checking list without recreating share', async () => {
  const t = await setup(); let sets = 0;
  try {
    const uncertain = mock({ listExit: 1, onCall: args => { if (args[0] === 'share' && args[1] === 'set') sets++; } });
    await assert.rejects(runPublish(t.root, [t.b], uncertain, { password: 'a1b2' }), /结果未确认/);
    const j = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(j.entries[`sample@${sha}`].state, 'uncertain'); assert.ok(j.entries[`sample@${sha}`].baidu);
    await runPublish(t.root, [t.b], mock({ onCall: args => { if (args[0] === 'share' && args[1] === 'set') sets++; } }));
    assert.equal(sets, 1);
  } finally { await t.cleanup(); }
});
test('unknown share is explicitly adopted only after remote meta, full SHA and exact share list checks', async () => {
  const t = await setup(); let shareSets = 0;
  try {
    const runner = mock({ shareExit: 1, onCall: args => { if (args[0] === 'share' && args[1] === 'set') shareSets++; } });
    await assert.rejects(runPublish(t.root, [t.b], runner, { password: 'a1b2' }), /结果未确认/);
    const result = await recoverUnknownShare(t.root, t.b, runner, '987654', 'a1b2');
    assert.equal(result.status, 'recovered'); assert.equal(shareSets, 1);
    const current = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.equal(current.downloads.baidu?.shareId, '987654');
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(journal.entries[`sample@${sha}`].state, 'complete');
  } finally { await t.cleanup(); }
});
test('an older uncertain version can be explicitly resolved without installing its share on the newer catalog', async () => {
  const t = await setup();
  try {
    await assert.rejects(runPublish(t.root, [t.b], mock({ shareExit: 1 }), { password: 'a1b2' }), /结果未确认/);
    const target = path.join(t.root, 'catalog/books/sample.json'); const newer = JSON.parse(await readFile(target, 'utf8')) as Book;
    newer.file = { ...newer.file, sha256: 'b'.repeat(64) }; newer.downloads = { ...newer.downloads, r2Key: `books/sample/${'b'.repeat(64)}.epub`, baidu: null };
    await writeFile(target, JSON.stringify(newer));
    const result = await recoverUnknownShare(t.root, t.b, mock({ existing: true }), '987654', 'a1b2', { sourceSha256: sha });
    assert.equal(result.status, 'historical-share-resolved');
    assert.equal((JSON.parse(await readFile(target, 'utf8')) as Book).downloads.baidu, null);
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(journal.entries[`sample@${sha}`].state, 'shared');
  } finally { await t.cleanup(); }
});
test('an unresolved RAR share blocks raw publishing for that stable book ID', async () => {
  const t = await setup(); let calls = 0;
  try {
    await mkdir(path.join(t.root, '.local/baidu'), { recursive: true });
    await writeFile(path.join(t.root, '.local/baidu/archive-journal.json'), JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(),
      entries: { [`sample@${sha}@${'c'.repeat(64)}@deadbeef0000`]: { id: 'sample', state: 'uncertain' } } }));
    await assert.rejects(runPublish(t.root, [t.b], async () => { calls++; throw new Error('must stop before cloud'); }), /RAR 分享结果/);
    assert.equal(calls, 0);
  } finally { await t.cleanup(); }
});
test('wrong meta bytes and wrong roundtrip hash stop before share creation', async () => {
  const t = await setup(); let shareSets = 0;
  try {
    await assert.rejects(runPublish(t.root, [t.b], mock({ wrongMeta: true,
      onCall: args => { if (args[0] === 'share' && args[1] === 'set') shareSets++; } })), /meta|bytes/u);
    assert.equal(shareSets, 0);
  } finally { await t.cleanup(); }
});
test('wrong full roundtrip hash is refused before creating a share', async () => {
  const t = await setup(); let shareSets = 0;
  try {
    await assert.rejects(runPublish(t.root, [t.b], mock({ wrongRoundtrip: true,
      onCall: args => { if (args[0] === 'share' && args[1] === 'set') shareSets++; } })), /SHA-256/);
    assert.equal(shareSets, 0);
  } finally { await t.cleanup(); }
});
test('legacy journal migration preserves older versions while allowing a new source SHA', async () => {
  const t = await setup(); try {
    const journalPath = path.join(t.root, '.local/baidu/journal.json');
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), entries: {
      sample: { id: 'sample', sha256: 'a'.repeat(64), bytes: bytes.length, source: 'old', catalogHash: '', remotePath: '/old', state: 'complete', baidu: {} },
    } }));
    await runPublish(t.root, [t.b], mock(), { password: 'a1b2' });
    const migrated = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(migrated.schemaVersion, 2); assert.ok(migrated.entries[`sample@${'a'.repeat(64)}`]);
    assert.ok(migrated.entries[`sample@${sha}`]);
    assert.ok(await readFile(`${journalPath}.schema1.bak`));
  } finally { await t.cleanup(); }
});
test('catalog changed while sharing is stopped before an atomic overwrite', async () => {
  const t = await setup();
  try {
    const base = mock();
    const runner: Runner = async args => {
      const result = await base(args);
      if (args[0] === 'share' && args[1] === 'list') {
        const target = path.join(t.root, 'catalog/books/sample.json'); const current = JSON.parse(await readFile(target, 'utf8'));
        current.title = '外部同时修改'; await writeFile(target, JSON.stringify(current));
      }
      return result;
    };
    await assert.rejects(runPublish(t.root, [t.b], runner, { password: 'a1b2' }), /catalog 在流程中变化/);
    const actual = JSON.parse(await readFile(path.join(t.root, 'catalog/books/sample.json'), 'utf8')) as Book;
    assert.equal(actual.title, '外部同时修改'); assert.equal(actual.downloads.baidu, null);
  } finally { await t.cleanup(); }
});
test('existing checkpointed complete record is reused without a second share', async () => {
  const t = await setup(); let shareSets = 0;
  try {
    await runPublish(t.root, [t.b], mock(), { password: 'a1b2' });
    await runPublish(t.root, [t.b], mock({ onCall: args => { if (args[0] === 'share' && args[1] === 'set') shareSets++; } }));
    assert.equal(shareSets, 0);
  } finally { await t.cleanup(); }
});
test('same-SHA presentation metadata updates refresh the guard and reuse without source or cloud access', async () => {
  const t = await setup();
  try {
    await runPublish(t.root, [t.b], mock(), { password: 'a1b2' });
    const target = path.join(t.root, 'catalog/books/sample.json'); const current = JSON.parse(await readFile(target, 'utf8'));
    current.title = '修正后的展示书名'; await writeFile(target, JSON.stringify(current));
    await rm(path.join(t.root, '.local/plans'), { recursive: true, force: true });
    let calls = 0;
    await runPublish(t.root, [current], async () => { calls++; throw new Error('reuse should be local-only'); });
    assert.equal(calls, 0);
    const journal = JSON.parse(await readFile(path.join(t.root, '.local/baidu/journal.json'), 'utf8'));
    assert.equal(journal.entries[`sample@${sha}`].catalogGuard.file.sha256, sha);
  } finally { await t.cleanup(); }
});
test('unavailable record with unchanged catalog is skipped and excluded from completed count', async () => {
  const t = await setup();
  try {
    const catalog = path.join(t.root, 'catalog/books/sample.json'); const source = path.join(t.root, '.local/plans/p1/inputs/sample.epub');
    const journalPath = path.join(t.root, '.local/baidu/journal.json'); await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), entries: {
      sample: { id: 'sample', sha256: sha, bytes: bytes.length, source, catalogHash: digest(await readFile(catalog)),
        remotePath: `/yuuko-library/books/sample/${sha}/书.epub`, state: 'unavailable', error: '匿名访问返回链接不存在' },
    } }));
    let calls = 0;
    const result = await runPublish(t.root, [t.b], async () => { calls++; throw new Error('unavailable must not call BaiduPCS-Go'); });
    assert.equal(calls, 0); assert.equal(result.selected, 1); assert.equal(result.completed, 0);
    assert.equal(result.unavailableCount, 1); assert.equal(result.unavailable[0].id, 'sample');
    assert.equal(JSON.parse(await readFile(catalog, 'utf8')).downloads.baidu, null);
  } finally { await t.cleanup(); }
});
