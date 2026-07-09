import { createHash } from 'crypto';
import { mkdir, open, stat, unlink } from 'fs/promises';
import { dirname, relative, resolve } from 'path';

const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 1_500;
const STALE_LOCK_MS = 30_000;

/**
 * Serialize mutations that can create or remove fork edges for a source file.
 *
 * The key is the source's canonical vault-relative path rather than its UUID:
 * legacy notes without IDs must participate in the same critical section as
 * the fork that may assign their first ID.
 */
export async function withLineageMutationLocks<T>(
  vaultDir: string,
  sourcePaths: string[],
  task: () => Promise<T>
): Promise<T> {
  const lockPaths = Array.from(new Set(
    sourcePaths.map(sourcePath => getLineageMutationLockPath(vaultDir, sourcePath))
  )).sort((a, b) => a.localeCompare(b, 'en'));

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const lockPath of lockPaths) {
      releases.push(await acquireLock(lockPath));
    }
    return await task();
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) {
      await releases[index]!();
    }
  }
}

export function getLineageMutationLockPath(vaultDir: string, sourcePath: string): string {
  const vaultRoot = resolve(vaultDir);
  const absoluteSource = resolve(sourcePath);
  const relativeSource = relative(vaultRoot, absoluteSource).replace(/\\/g, '/');
  if (
    relativeSource === '' ||
    relativeSource === '..' ||
    relativeSource.startsWith('../') ||
    relativeSource.startsWith('/')
  ) {
    throw new Error(`Lineage lock source must be a file inside the vault: ${sourcePath}`);
  }

  // Lower-casing intentionally over-serializes case-only path variants. That
  // is safer on case-insensitive filesystems and the digest remains portable.
  const key = createHash('sha256').update(relativeSource.normalize('NFC').toLowerCase()).digest('hex');
  return resolve(vaultRoot, '.bwrb', 'locks', `lineage-source-${key}.lock`);
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf-8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  throw new Error('Timed out waiting for a fork-lineage mutation lock; retry the command.');
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
