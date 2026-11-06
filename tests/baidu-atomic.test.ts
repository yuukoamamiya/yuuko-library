import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { replaceFileAtomically } from '../tools/atomic.ts';

test('transient Windows rename locks retry and then replace the target', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'baidu-atomic-'));
  try {
    const source = path.join(dir, 'journal.tmp'), target = path.join(dir, 'journal.json');
    await writeFile(source, 'new'); await writeFile(target, 'old');
    let attempts = 0; const waits: number[] = [];
    await replaceFileAtomically(source, target, async (from, to) => {
      attempts++;
      if (attempts < 3) { const error = new Error('transient') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }
      await rename(from, to);
    }, async ms => { waits.push(ms); });
    assert.equal(attempts, 3); assert.deepEqual(waits, [150, 150]);
    assert.equal(await readFile(target, 'utf8'), 'new');
    await assert.rejects(readFile(source));
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('exhausted rename retries preserve temporary data and original target', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'baidu-atomic-'));
  try {
    const source = path.join(dir, 'catalog.tmp'), target = path.join(dir, 'catalog.json');
    await writeFile(source, 'new catalog'); await writeFile(target, 'original catalog');
    let attempts = 0;
    await assert.rejects(replaceFileAtomically(source, target, async () => {
      attempts++; const error = new Error('locked') as NodeJS.ErrnoException; error.code = 'EBUSY'; throw error;
    }, async () => {}, 10, 150), { code: 'EBUSY' });
    assert.equal(attempts, 10);
    assert.equal(await readFile(source, 'utf8'), 'new catalog');
    assert.equal(await readFile(target, 'utf8'), 'original catalog');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
