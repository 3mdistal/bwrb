import { readFile } from 'fs/promises';
import { relative } from 'path';
import { ConcurrentNoteModificationError } from './errors.js';
import { writeFileAtomic } from './frontmatter.js';

/** Assert that a note still has the exact bytes used to prepare a mutation. */
export async function assertNoteBytesUnchanged(
  filePath: string,
  expectedRaw: string,
  attempts = 1
): Promise<void> {
  const currentRaw = await readFile(filePath, 'utf-8');
  if (currentRaw !== expectedRaw) {
    throw new ConcurrentNoteModificationError(filePath, attempts);
  }
}

/**
 * Restore a prior snapshot only when the file still contains this command's
 * own write. A newer writer always wins; rollback must never erase it.
 */
export async function rollbackNoteIfUnchanged(
  filePath: string,
  writtenRaw: string,
  originalRaw: string
): Promise<boolean> {
  const currentRaw = await readFile(filePath, 'utf-8');
  if (currentRaw !== writtenRaw) return false;
  await writeFileAtomic(filePath, originalRaw);
  return true;
}

/** Stable agent-facing details shared by every guarded note writer. */
export function concurrentModificationData(
  vaultDir: string,
  error: ConcurrentNoteModificationError
): { reason: string; retryable: true; path: string; attempts: number } {
  return {
    reason: 'note-modified-concurrently',
    retryable: true,
    path: relative(vaultDir, error.path).replace(/\\/g, '/'),
    attempts: error.attempts,
  };
}
