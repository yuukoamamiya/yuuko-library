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
  try {
    const beforeCatalog = await readdir(path.join(ROOT, 'catalog/books'));
    const epub = path.join(dir, '测试.epub');
    const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', resolve); zip.outputStream.on('error', reject); });
    zip.addBuffer(Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'META-INF/container.xml');
    zip.addBuffer(Buffer.from('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>同名书籍</dc:title><dc:creator>作者</dc:creator><dc:description>简介</dc:description></metadata></package>'), 'book.opf');
    zip.end(); await done; await writeFile(epub, Buffer.concat(chunks));
    const manifest = path.join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify([{ id: 'test-translation', epub, model: '用户指定模型' }, { id: 'test-transcription', epub, kind: 'transcription' }]));
    const prepared = run(['prepare', '--manifest', manifest]);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const output = JSON.parse(prepared.stdout); const id = output.planId;
    planDir = path.join(ROOT, '.local/plans', id);
    const plan = JSON.parse(await readFile(path.join(planDir, 'plan.json'), 'utf8'));
    assert.equal(plan.books.length, 2);
    assert.deepEqual(plan.books[1].edition, { kind: 'transcription', model: null });
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
  }
});
