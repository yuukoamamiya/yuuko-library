import { rename } from 'node:fs/promises';

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
export type RenameOperation = (source: string, target: string) => Promise<void>;
export type PauseOperation = (milliseconds: number) => Promise<void>;
const pause: PauseOperation = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Retry only transient local rename failures; leave both paths intact on exhaustion. */
export async function replaceFileAtomically(source: string, target: string, renameFile: RenameOperation = rename,
  wait: PauseOperation = pause, attempts = 10, delayMs = 150): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await renameFile(source, target); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_RENAME_ERRORS.has(code) || attempt >= attempts) throw error;
      await wait(delayMs);
    }
  }
}
