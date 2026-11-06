import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yazl from 'yazl';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'tools/book/cli.ts', ...args, '--json'], { cwd: ROOT, encoding: 'utf8' });
}
test('批量准备真实快照，转录本无模型，校验通过，源文件修改不影响预览，快照篡改被拒绝', async () => {
  await mkdir(path.join(ROOT, '.local'), { recursive: true });
  const dir = await mkdtemp(path.join(ROOT, '.local', 'test-cli-'));
  let planDir: string | undefined;
  let updatePlanDir: string | undefined;
  try {
    const beforeCatalog = await readdir(path.join(ROOT, 'catalog/books'));
    const epub = path.join(dir, '测试.epub');
    const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', resolve); zip.outputStream.on('error', reject); });
    zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
    zip.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>同名书籍</dc:title><dc:creator>作者</dc:creator><dc:description>简介</dc:description></metadata></package>'), 'book.opf');
    zip.end(); await done; await writeFile(epub, Buffer.concat(chunks));
    const manifest = path.join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify([{ id: 'test-translation', epub, model: '用户指定模型', categories: ['philosophy'] }, { id: 'test-transcription', epub, kind: 'transcription', categories: ['history'] }]));
    const prepared = run(['prepare', '--manifest', manifest]);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const output = JSON.parse(prepared.stdout); const id = output.planId;
    planDir = path.join(ROOT, '.local/plans', id);
    const plan = JSON.parse(await readFile(path.join(planDir, 'plan.json'), 'utf8'));
    assert.equal(plan.books.length, 2);
    assert.deepEqual(plan.books[1].edition, { kind: 'transcription', model: null });
    assert.deepEqual(plan.books[1].categories, ['history']);
    const invalid = run(['prepare', '--id', 'test-invalid-category', '--epub', epub, '--model', '模型', '--category', 'unknown']);
    assert.equal(invalid.status, 2);
    const existing = JSON.parse(await readFile(path.join(ROOT, 'catalog/books', beforeCatalog.find(name => name.endsWith('.json'))!), 'utf8'));
    const updated = run(['prepare', '--id', existing.id, '--update', '--epub', epub, '--model', '模型']);
    assert.equal(updated.status, 0, updated.stderr + updated.stdout);
    updatePlanDir = path.join(ROOT, '.local/plans', JSON.parse(updated.stdout).planId);
    const updatedPlan = JSON.parse(await readFile(path.join(updatePlanDir, 'plan.json'), 'utf8'));
    assert.deepEqual(updatedPlan.books[0].categories, existing.categories);
    assert.deepEqual(await readdir(path.join(ROOT, 'catalog/books')), beforeCatalog);
    const validation = run(['validate', '--plan', id]);
    assert.equal(validation.status, 0, validation.stderr + validation.stdout);
    await writeFile(epub, '原文件已经变化');
    assert.equal(run(['status', '--plan', id]).status, 0);
    assert.equal(run(['publish', '--plan', id]).status, 2);
    const index = await readFile(path.join(planDir, 'site/dist/index.html'), 'utf8');
    assert.match(index, /同名书籍/u); assert.match(index, /中文出版物转录/u);
    const transcription = await readFile(path.join(planDir, 'site/dist/books/test-transcription/index.html'), 'utf8');
    assert.doesNotMatch(transcription, /<dt>翻译模型<\/dt>/u);
    await writeFile(path.join(planDir, 'site/dist/index.html'), 'modified');
    const stale = run(['status', '--plan', id]);
    assert.equal(stale.status, 3); assert.equal(JSON.parse(stale.stdout).status, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (planDir) await rm(planDir, { recursive: true, force: true });
    if (updatePlanDir) await rm(updatePlanDir, { recursive: true, force: true });
  }
});

test('book prepare no longer accepts the unused baidu plan flag', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--baidu/u);
  const result = run(['prepare', '--id', 'unused-flag-check', '--epub', 'book.epub', '--model', '模型', '--baidu', 'optional']);
  assert.notEqual(result.status, 0);
});

test('旧 schema1 分类快照仅可只读报告为 stale，不能被其他服务接受', async () => {
  const { randomUUID } = await import('node:crypto');
  const planId = `p-${randomUUID()}`;
  const dir = path.join(ROOT, '.local', 'plans', planId);
  const book = {
    schemaVersion: 1, id: 'legacy-category-check', title: '旧分类快照', authors: ['作者'], description: '', subjects: [],
    cover: null, edition: { kind: 'transcription', model: null },
    file: { sha256: 'a'.repeat(64), bytes: 17, filename: 'legacy.epub' },
    downloads: { r2Key: `books/legacy-category-check/${'a'.repeat(64)}.epub`, r2Url: null,
      baidu: { url: 'https://pan.baidu.com/s/abcdefg', code: '1234', fileSha256: 'a'.repeat(64), fsId: '123',
        shareId: 'share-1', path: '/legacy.epub', expiresAt: null, verifiedAt: '2026-01-01T00:00:00Z' } },
    publishedAt: null, updatedAt: null,
  };
  const plan = {
    schemaVersion: 1, id: planId, status: 'prepared', createdAt: '2026-01-01T00:00:00Z',
    baseFingerprint: 'b'.repeat(64), reviewHash: 'c'.repeat(64), inventory: { 'site/catalog/books/legacy-category-check.json': 'd'.repeat(64) },
    books: [book], changes: [{ id: book.id, operation: 'add', warnings: ['旧提示'] }],
  };
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan));
    const status = run(['status', '--plan', planId]);
    assert.equal(status.status, 3, status.stderr + status.stdout);
    const result = JSON.parse(status.stdout);
    assert.equal(result.status, 'stale');
    assert.equal(result.planId, planId);
    assert.equal(result.data.books, 1);
    assert.match(result.data.blockers[0], /categories.*重新 prepare/u);
    assert.deepEqual(result.warnings, ['legacy-category-check: 旧提示']);
    assert.equal(result.error, null);

    const { readPlan, requireCurrentPlan } = await import('../tools/book/plan.ts');
    await assert.rejects(readPlan(ROOT, planId), /核心字段/u);
    await assert.rejects(requireCurrentPlan(ROOT, planId), /核心字段/u);

    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({ ...plan, books: [{ ...book, id: '../invalid-id' }],
      changes: [{ id: '../invalid-id', operation: 'add', warnings: [] }] }));
    const invalid = run(['status', '--plan', planId]);
    assert.equal(invalid.status, 3);
    assert.equal(JSON.parse(invalid.stdout).status, 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
