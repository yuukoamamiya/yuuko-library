import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { replaceFileAtomically } from '../atomic.ts';

/** The raw and archive journals share one project-wide exclusion lock and one journal-specific lock. */
export async function acquireJournalLocks(root: string, journalFile: string, kind: 'Baidu' | 'archive' = 'Baidu') {
  const journalLockFile = `${journalFile}.lock`;
  const projectLockFile = path.join(root, '.local/baidu/project.lock');
  await mkdir(path.dirname(journalFile), { recursive: true });
  let projectLock;
  try { projectLock = await open(projectLockFile, 'wx'); }
  catch { throw new Error(`${kind} 项目操作锁已存在；确认没有活动进程后再检查锁`); }
  let journalLock;
  try { journalLock = await open(journalLockFile, 'wx'); }
  catch {
    await projectLock.close(); await rm(projectLockFile, { force: true });
    throw new Error(`${kind} journal 锁已存在；确认没有活动进程后再检查锁`);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await journalLock.close(); await rm(journalLockFile, { force: true });
    await projectLock.close(); await rm(projectLockFile, { force: true });
  };
}

export async function persistSchema1Migration<T extends { schemaVersion: 1 | 2; updatedAt: string }>(
  file: string, journal: T, save: (file: string, journal: T) => Promise<void>,
) {
  let raw: { schemaVersion?: number };
  try { raw = JSON.parse(await readFile(file, 'utf8')) as typeof raw; } catch { return; }
  if (raw.schemaVersion !== 1) return;
  const backup = `${file}.schema1.bak`;
  try { await copyFile(file, backup, fsConstants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  journal.schemaVersion = 2;
  await save(file, journal);
  await writeFile(`${file}.migration.json`, JSON.stringify({ from: 1, to: 2, backup, migratedAt: new Date().toISOString() }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}

export async function saveJournalJson(file: string, value: { schemaVersion: 1 | 2; updatedAt: string }) {
  await mkdir(path.dirname(file), { recursive: true });
  value.schemaVersion = 2; value.updatedAt = new Date().toISOString();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await replaceFileAtomically(temp, file);
}
