import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';

const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 1_500;
const STALE_LOCK_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const LOCK_VERSION = 1;

interface LineageLockOptions {
  retryMs: number;
  attempts: number;
  staleMs: number;
  heartbeatMs: number;
}

interface LockMetadata {
  version: number;
  pid: number;
  token: string;
  createdAt: number;
  heartbeatAt: number;
  pathKey: string;
}

interface LockSnapshot {
  raw: string;
  metadata: LockMetadata | null;
  device: number;
  inode: number;
  modifiedAt: number;
  size: number;
}

const DEFAULT_OPTIONS: LineageLockOptions = {
  retryMs: LOCK_RETRY_MS,
  attempts: LOCK_ATTEMPTS,
  staleMs: STALE_LOCK_MS,
  heartbeatMs: HEARTBEAT_MS,
};

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
  task: () => Promise<T>,
  optionOverrides: Partial<LineageLockOptions> = {}
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
  const lockPaths = Array.from(new Set(
    sourcePaths.map(sourcePath => getLineageMutationLockPath(vaultDir, sourcePath))
  )).sort((a, b) => a.localeCompare(b, 'en'));

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const lockPath of lockPaths) {
      releases.push(await acquireLock(lockPath, options));
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

async function acquireLock(
  lockPath: string,
  options: LineageLockOptions
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const recoveryPath = `${lockPath}.recovery`;

  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (await recoveryIsInProgress(recoveryPath, options)) {
      await delay(options.retryMs);
      continue;
    }

    const token = randomUUID();
    const now = Date.now();
    const metadata: LockMetadata = {
      version: LOCK_VERSION,
      pid: process.pid,
      token,
      createdAt: now,
      heartbeatAt: now,
      pathKey: basename(lockPath),
    };

    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf-8');

        // A stale-lock reaper may have started between our first recovery-marker
        // check and the exclusive create. It will re-check our live metadata and
        // leave us alone, but we do not enter the critical section until that
        // recovery pass has finished.
        if (await pathExists(recoveryPath)) {
          await handle.close().catch(() => undefined);
          await unlinkIfOwned(lockPath, token);
          await delay(options.retryMs);
          continue;
        }

        await cleanupQuarantines(lockPath);
        return createRelease(lockPath, handle, metadata, options);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlinkIfOwned(lockPath, token);
        throw error;
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const snapshot = await readLockSnapshot(lockPath);
      if (snapshot && await isRecoverable(snapshot, options.staleMs)) {
        await recoverStaleLock(lockPath, recoveryPath, options);
        continue;
      }
      await delay(options.retryMs);
    }
  }

  throw new Error('Timed out waiting for a fork-lineage mutation lock; retry the command.');
}

function createRelease(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  metadata: LockMetadata,
  options: LineageLockOptions
): () => Promise<void> {
  let released = false;
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (released || heartbeatRunning) return;
    heartbeatRunning = true;
    void heartbeatOwnedLock(lockPath, handle, metadata.token)
      .finally(() => { heartbeatRunning = false; });
  }, Math.max(1, Math.min(options.heartbeatMs, Math.max(1, options.staleMs / 3))));
  timer.unref();

  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await handle.close().catch(() => undefined);
    await unlinkIfOwned(lockPath, metadata.token);
  };
}

async function heartbeatOwnedLock(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  token: string
): Promise<void> {
  const snapshot = await readLockSnapshot(lockPath);
  if (snapshot?.metadata?.token !== token) return;

  // Touch the inode opened by this holder, not whatever might have appeared at
  // the path after the ownership check. The immutable JSON records when the
  // heartbeat began; mtime records its current pulse.
  const now = new Date();
  await handle.utimes(now, now).catch(() => undefined);
}

async function recoverStaleLock(
  lockPath: string,
  recoveryPath: string,
  options: LineageLockOptions
): Promise<void> {
  const recovery = await acquireRecoveryMarker(recoveryPath, options);
  if (!recovery) return;

  try {
    const snapshot = await readLockSnapshot(lockPath);
    if (!snapshot || !await isRecoverable(snapshot, options.staleMs)) return;

    // The fixed recovery marker prevents acquisitions and competing reapers
    // while the stale inode is atomically moved out of the lock pathname.
    const quarantinePath = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, quarantinePath);
      await unlink(quarantinePath).catch(() => undefined);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
    }
    await cleanupQuarantines(lockPath);
  } finally {
    await recovery();
  }
}

async function acquireRecoveryMarker(
  recoveryPath: string,
  options: LineageLockOptions
): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  const now = Date.now();
  const metadata: LockMetadata = {
    version: LOCK_VERSION,
    pid: process.pid,
    token,
    createdAt: now,
    heartbeatAt: now,
    pathKey: basename(recoveryPath),
  };

  try {
    const handle = await open(recoveryPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf-8');
    } finally {
      await handle.close();
    }
    return async () => {
      await unlinkIfOwned(recoveryPath, token);
    };
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const snapshot = await readLockSnapshot(recoveryPath);
    if (snapshot && await isRecoverable(snapshot, options.staleMs)) {
      await unlinkIfUnchanged(recoveryPath, snapshot);
    }
    return null;
  }
}

async function recoveryIsInProgress(
  recoveryPath: string,
  options: LineageLockOptions
): Promise<boolean> {
  const snapshot = await readLockSnapshot(recoveryPath);
  if (!snapshot) return false;
  if (await isRecoverable(snapshot, options.staleMs)) {
    await unlinkIfUnchanged(recoveryPath, snapshot);
    return pathExists(recoveryPath);
  }
  return true;
}

async function isRecoverable(snapshot: LockSnapshot, staleMs: number): Promise<boolean> {
  if (Date.now() - snapshot.modifiedAt <= staleMs) return false;

  // Corrupt/missing owner data is recoverable only once the TTL expires. For
  // valid metadata, a live PID wins over timestamps: an active process must not
  // lose a long critical section because its event loop paused or mtime changed.
  if (!snapshot.metadata) return true;
  return !isProcessAlive(snapshot.metadata.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user. Unknown
    // platform errors are also treated as live: local vault locking prefers a
    // deterministic timeout over stealing another process's lock. PID reuse can
    // therefore cause a conservative false-positive, never concurrent owners.
    return true;
  }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  try {
    const [raw, info] = await Promise.all([
      readFile(lockPath, 'utf-8'),
      stat(lockPath),
    ]);
    return {
      raw,
      metadata: parseLockMetadata(raw),
      device: info.dev,
      inode: info.ino,
      modifiedAt: info.mtimeMs,
      size: info.size,
    };
  } catch (error) {
    if (isFileMissingError(error)) return null;
    return null;
  }
}

function parseLockMetadata(raw: string): LockMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<LockMetadata>;
    if (
      value.version !== LOCK_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== 'string' || value.token.length === 0 ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
      typeof value.heartbeatAt !== 'number' || !Number.isFinite(value.heartbeatAt) ||
      typeof value.pathKey !== 'string' || value.pathKey.length === 0
    ) return null;
    return value as LockMetadata;
  } catch {
    return null;
  }
}

async function unlinkIfOwned(lockPath: string, token: string): Promise<boolean> {
  const snapshot = await readLockSnapshot(lockPath);
  if (snapshot?.metadata?.token !== token) return false;
  return unlinkIfUnchanged(lockPath, snapshot);
}

async function unlinkIfUnchanged(lockPath: string, expected: LockSnapshot): Promise<boolean> {
  const current = await readLockSnapshot(lockPath);
  if (!current || !snapshotsMatch(current, expected)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

function snapshotsMatch(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.raw === right.raw &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.modifiedAt === right.modifiedAt &&
    left.size === right.size;
}

async function cleanupQuarantines(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.quarantine-`;
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(entries
    .filter(entry => entry.startsWith(prefix))
    .map(entry => unlink(resolve(directory, entry)).catch(() => undefined)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
