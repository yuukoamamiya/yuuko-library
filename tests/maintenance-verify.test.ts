import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verify } from '../tools/maintenance/verify.ts';

test('verify service accepts injected root and runners and sequences full checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verify-service-'));
  try {
    await mkdir(path.join(root, 'docs'));
    const commands: string[] = [];
    const git: string[][] = [];
    const result = await verify(root, false, async name => { commands.push(name); return { code: 0 }; }, async args => { git.push(args); return { code: 0 }; });
    assert.equal(result.status, 'passed');
    assert.deepEqual(commands, ['check', 'test', 'build']);
    assert.deepEqual(git, [['diff', '--check'], ['diff', '--cached', '--check']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('docs verification checks links through the supplied root without invoking build commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verify-docs-'));
  try {
    await mkdir(path.join(root, 'docs'));
    for (const name of ['README.md', 'AGENTS.md', 'CONTEXT.md', 'DESIGN.md']) await writeFile(path.join(root, name), '[guide](docs/guide.md)');
    await writeFile(path.join(root, 'docs/guide.md'), '# guide');
    const git: string[][] = [];
    const result = await verify(root, true, async () => { throw new Error('docs mode has no npm runner calls'); }, async args => { git.push(args); return { code: 0 }; });
    assert.equal(result.status, 'passed');
    await writeFile(path.join(root, 'README.md'), '[missing](missing.md)');
    const failed = await verify(root, true, async () => ({ code: 0 }), async () => ({ code: 0 }));
    assert.equal(failed.status, 'failed');
    assert.deepEqual(git, [['diff', '--check'], ['diff', '--cached', '--check']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
