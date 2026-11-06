import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPlan } from '../tools/book/plan.ts';
const planId = 'p-00000000-0000-4000-8000-000000000000';
test('shared plan reader rejects invalid book ids before deriving input paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-plan-'));
  try {
    const dir = path.join(root, '.local', 'plans', planId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({ schemaVersion: 1, id: planId, status: 'prepared', createdAt: new Date().toISOString(), baseFingerprint: 'a'.repeat(64), reviewHash: 'b'.repeat(64), inventory: {}, books: [{ id: '../escape' }], changes: [{ id: '../escape', operation: 'add', warnings: [] }] }));
    await assert.rejects(readPlan(root, planId), /书目核心字段无效|计划格式/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('shared plan reader keeps invalid plan id exit code compatible', async () => {
  await assert.rejects(readPlan(os.tmpdir(), 'invalid'), error => (error as { exitCode?: number }).exitCode === 2);
});
