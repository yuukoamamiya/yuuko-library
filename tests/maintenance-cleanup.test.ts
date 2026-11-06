import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, lstat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeCleanupPreview } from '../tools/maintenance/cleanup.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { try { if ((await lstat(root)).isSymbolicLink()) await unlink(root); else await rm(root, { recursive: true, force: true }); } catch { /* fixture already removed */ } } });
const now = Date.now(); const old = new Date(now - 60 * 86400000);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-share-cleanup-')); roots.push(root);
  await mkdir(path.join(root, '.local', 'plans'), { recursive: true });
  await mkdir(path.join(root, '.local', 'releases'), { recursive: true });
  await mkdir(path.join(root, '.local', 'uploads'), { recursive: true });
  await mkdir(path.join(root, '.local', 'pages'), { recursive: true });
  await writeFile(path.join(root, 'site.config.json'), JSON.stringify({ siteUrl: 'https://example.test' }));
  return root;
}
async function plan(root: string, id: string, status = 'failed', time = old) {
  const dir = path.join(root, '.local', 'plans', id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plan.json'), JSON.stringify({ schemaVersion: 1, id, status, createdAt: time.toISOString() }));
  await writeFile(path.join(dir, 'payload'), 'payload'); await utimes(path.join(dir, 'plan.json'), time, time); await utimes(path.join(dir, 'payload'), time, time); await utimes(dir, time, time); return dir;
}
async function release(root: string, id: string, planId: string, status = 'published', time = old) {
  const dir = path.join(root, '.local', 'releases', id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'release.json'), JSON.stringify({ schemaVersion: 1, id, planId, createdAt: time.toISOString() }));
  await writeFile(path.join(dir, 'deployment.json'), JSON.stringify({ status, verifiedAt: time.toISOString() }));
  await utimes(path.join(dir, 'release.json'), time, time); await utimes(path.join(dir, 'deployment.json'), time, time);
  await utimes(dir, time, time); return dir;
}
const online = async () => new Response(JSON.stringify({ schemaVersion: 2, releaseId: 'r-online', planId: 'p-online' }), { status: 200 });

test('keeps online, dependency closure and two most recent published releases; finds only unreferenced old candidate', async () => {
  const root = await fixture();
  await plan(root, 'p-online', 'published'); await plan(root, 'p-a', 'published'); await plan(root, 'p-b', 'published'); await plan(root, 'p-old', 'failed');
  await release(root, 'r-online', 'p-online'); await release(root, 'r-a', 'p-a'); await release(root, 'r-b', 'p-b');
  await release(root, 'r-old', 'p-old', 'failed');
  await writeFile(path.join(root, '.local', 'uploads', 'report.json'), JSON.stringify({ status: 'verified', planId: 'p-a' }));
  const before = await readFile(path.join(root, '.local', 'plans', 'p-old', 'payload'), 'utf8');
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.doesNotThrow(() => JSON.stringify(result));
  const byPath = new Map(result.objects.map(o => [o.path, o]));
  for (const id of ['r-online', 'r-a', 'r-b']) assert.equal(byPath.get(`.local/releases/${id}`)?.status, 'protected');
  assert.equal(byPath.get('.local/releases/r-old')?.status, 'candidate');
  for (const id of ['p-online', 'p-a', 'p-b']) assert.equal(byPath.get(`.local/plans/${id}`)?.status, 'protected');
  assert.equal(byPath.get('.local/plans/p-old')?.status, 'candidate');
  assert.equal(result.onlineRelease, 'r-online');
  assert.equal(await readFile(path.join(root, '.local', 'plans', 'p-old', 'payload'), 'utf8'), before);
});
test('keeps new/prepared projects even when their published release is old', async () => {
  const root = await fixture(); const recent = new Date();
  await plan(root, 'p-new', 'failed', recent); await release(root, 'r-new', 'p-new', 'ready', recent);
  await plan(root, 'p-prepared', 'prepared', old);
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.ok(result.objects.filter(o => o.path.includes('p-new') || o.path.includes('r-new') || o.path.includes('p-prepared')).every(o => o.status === 'protected'));
});

test('active and lock markers preserve old release/plan and their unfinished upload dependency', async () => {
  const root = await fixture(); await plan(root, 'p-active'); await release(root, 'r-active', 'p-active', 'failed');
  await writeFile(path.join(root, '.local', 'pages', 'active.json'), JSON.stringify({ releaseId: 'r-active', planId: 'p-active' }));
  await writeFile(path.join(root, '.local', 'pages', 'publish.lock'), JSON.stringify({ releaseId: 'r-active' }));
  await writeFile(path.join(root, '.local', 'uploads', 'pending.json'), JSON.stringify({ schemaVersion: 1, command: 'upload', planId: 'p-active', status: 'running' }));
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.equal(result.objects.find(o => o.path.endsWith('r-active'))?.status, 'protected');
  assert.equal(result.objects.find(o => o.path.endsWith('p-active'))?.status, 'protected');
  assert.ok(result.objects.find(o => o.path.endsWith('pending.json'))?.reason.includes('未完成'));
});

test('unknown report and missing dependency prevent candidates', async () => {
  const root = await fixture(); await plan(root, 'p-x'); await release(root, 'r-x', 'p-missing', 'failed');
  await writeFile(path.join(root, '.local', 'uploads', 'remote-inventory.json'), JSON.stringify({ command: 'remote-inventory', files: [] }));
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.equal(result.objects.find(o => o.path.endsWith('r-x'))?.status, 'protected');
  assert.ok(result.unknown.some(x => x.path.includes('remote-inventory')));
  assert.ok(result.unknown.length > 0);
});

test('bad report protects snapshots; failed online fetch keeps inventory visible but conservative', async () => {
  const root = await fixture(); await plan(root, 'p-x'); await release(root, 'r-x', 'p-x', 'failed');
  await writeFile(path.join(root, '.local', 'uploads', 'bad.json'), '{');
  const badReport = await makeCleanupPreview(root, online as typeof fetch);
  assert.equal(badReport.objects.find(o => o.path.endsWith('r-x'))?.status, 'protected');
  const offline = await makeCleanupPreview(root, (async () => { throw new Error('offline'); }) as typeof fetch);
  assert.equal(offline.onlineRelease, null);
  assert.ok(offline.objects.length > 0);
  assert.ok(offline.objects.every(o => o.status === 'protected'));
});

test('does not traverse an external symlink and reports it unknown (where symlinks are supported)', async t => {
  const root = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), 'book-share-outside-')); roots.push(outside);
  await mkdir(path.join(outside, 'plans')); await writeFile(path.join(outside, 'sentinel'), 'external');
  try { const { symlink } = await import('node:fs/promises'); await symlink(outside, path.join(root, '.local', 'plans', 'linked'), 'junction'); }
  catch { t.skip('Windows symlink/junction creation is unavailable'); return; }
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.ok(result.unknown.some(x => x.path.includes('linked')));
  assert.ok(!result.objects.some(x => x.path.includes('sentinel')));
});

test('workspace root and .local junctions stop before scanning the external tree', async t => {
  const realRoot = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), 'book-share-outside-root-')); roots.push(outside);
  await mkdir(path.join(outside, '.local', 'plans'), { recursive: true });
  await writeFile(path.join(outside, '.local', 'plans', 'sentinel'), 'external');
  const { symlink } = await import('node:fs/promises');
  const rootLink = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-junction`);
  try { await symlink(realRoot, rootLink, 'junction'); roots.push(rootLink); }
  catch { t.skip('Windows junction creation is unavailable'); return; }
  const rootResult = await makeCleanupPreview(rootLink, online as typeof fetch);
  assert.equal(rootResult.objects.length, 0);
  assert.ok(rootResult.unknown.some(x => x.path === '.'));

  const localPath = path.join(realRoot, '.local'); await rm(localPath, { recursive: true, force: true });
  try { await symlink(path.join(outside, '.local'), localPath, 'junction'); }
  catch { t.skip('.local junction creation is unavailable'); return; }
  const localResult = await makeCleanupPreview(realRoot, online as typeof fetch);
  assert.equal(localResult.objects.length, 0);
  assert.ok(localResult.unknown.some(x => x.path === '.local'));
});

test('an internal metadata file symlink is unknown and cannot become a candidate', async t => {
  const root = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), 'book-share-meta-')); roots.push(outside);
  const external = path.join(outside, 'plan.json');
  await writeFile(external, JSON.stringify({ schemaVersion: 1, id: 'p-linked', status: 'failed', createdAt: old.toISOString() }));
  const dir = path.join(root, '.local', 'plans', 'p-linked'); await mkdir(dir);
  const { symlink } = await import('node:fs/promises');
  try { await symlink(external, path.join(dir, 'plan.json'), 'file'); }
  catch { t.skip('Windows file symlink creation is unavailable'); return; }
  const result = await makeCleanupPreview(root, online as typeof fetch);
  assert.ok(result.unknown.some(x => x.path.includes('p-linked')));
  assert.notEqual(result.objects.find(x => x.path.endsWith('p-linked'))?.status, 'candidate');
});
