import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import {
  getLineageMutationLockPath,
  withLineageMutationLocks,
} from '../../../src/lib/lineage-lock.js';

describe('lineage mutation lock', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-lineage-lock-'));
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('uses a stable vault-relative path key and cleans up after success and failure', async () => {
    const source = join(vaultDir, 'Ideas', 'Source.md');
    const sameSource = join(vaultDir, 'Ideas', '.', 'Source.md');
    expect(getLineageMutationLockPath(vaultDir, source))
      .toBe(getLineageMutationLockPath(vaultDir, sameSource));

    const lockPath = getLineageMutationLockPath(vaultDir, source);
    await withLineageMutationLocks(vaultDir, [source], async () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);

    await expect(withLineageMutationLocks(vaultDir, [source], async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('acquires multiple locks in deterministic order without deadlock', async () => {
    const a = join(vaultDir, 'A.md');
    const b = join(vaultDir, 'B.md');
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withLineageMutationLocks(vaultDir, [b, a], async () => {
      order.push('first-start');
      await firstBarrier;
      order.push('first-end');
    });
    while (!order.includes('first-start')) await delay(1);

    const second = withLineageMutationLocks(vaultDir, [a, b], async () => {
      order.push('second');
    });
    await delay(50);
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('removes a lock older than the shared 30-second stale threshold', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    await mkdir(join(vaultDir, '.bwrb', 'locks'), { recursive: true });
    await writeFile(lockPath, 'stale\n');
    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath, old, old);

    await withLineageMutationLocks(vaultDir, [source], async () => undefined);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('never steals an active lock whose mtime was forced beyond the stale threshold', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    let releaseFirst!: () => void;
    const barrier = new Promise<void>(resolve => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;

    const first = withLineageMutationLocks(vaultDir, [source], async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await barrier;
      active--;
    });
    while (!existsSync(lockPath)) await delay(1);

    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath, old, old);
    const second = withLineageMutationLocks(vaultDir, [source], async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      active--;
    });

    await delay(75);
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it('heartbeats a held lock well below a configurable stale threshold', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);

    await withLineageMutationLocks(vaultDir, [source], async () => {
      const initial = (await stat(lockPath)).mtimeMs;
      await delay(80);
      const heartbeat = (await stat(lockPath)).mtimeMs;
      expect(heartbeat).toBeGreaterThan(initial);
      expect(Date.now() - heartbeat).toBeLessThan(60);
    }, { staleMs: 90, heartbeatMs: 10 });
  });

  it('recovers stale locks owned by dead PIDs and stale corrupt locks', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    await mkdir(join(vaultDir, '.bwrb', 'locks'), { recursive: true });
    await writeFile(lockPath, lockMetadata(lockPath, deadPid(), 'dead-owner'));
    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath, old, old);

    await withLineageMutationLocks(vaultDir, [source], async () => undefined);
    expect(existsSync(lockPath)).toBe(false);

    await writeFile(lockPath, 'not-json\n');
    await utimes(lockPath, old, old);
    await withLineageMutationLocks(vaultDir, [source], async () => undefined);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not recover a fresh corrupt lock', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    await mkdir(join(vaultDir, '.bwrb', 'locks'), { recursive: true });
    await writeFile(lockPath, 'not-json\n');

    await expect(withLineageMutationLocks(
      vaultDir,
      [source],
      async () => undefined,
      { attempts: 8, retryMs: 2, staleMs: 100 }
    )).rejects.toThrow('Timed out waiting for a fork-lineage mutation lock');
    expect(await readFile(lockPath, 'utf-8')).toBe('not-json\n');
  });

  it.skipIf(process.platform === 'win32')('fails closed when an existing lock cannot be read', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    await mkdir(join(vaultDir, '.bwrb', 'locks'), { recursive: true });
    await writeFile(lockPath, lockMetadata(lockPath, deadPid(), 'unreadable-owner'));
    await chmod(lockPath, 0o000);

    try {
      await expect(withLineageMutationLocks(
        vaultDir,
        [source],
        async () => undefined,
        { attempts: 8, retryMs: 2, staleMs: 1 }
      )).rejects.toThrow('Timed out waiting for a fork-lineage mutation lock');
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await chmod(lockPath, 0o600);
    }
  });

  it('does not let an old holder release a replacement lock with another token', async () => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    const replacement = lockMetadata(lockPath, process.pid, 'replacement-owner');

    await withLineageMutationLocks(vaultDir, [source], async () => {
      await unlink(lockPath);
      await writeFile(lockPath, replacement);
    });

    expect(await readFile(lockPath, 'utf-8')).toBe(replacement);
    await unlink(lockPath);
  });

  it.each([2, 10])('admits only one of %i contenders after stale-owner recovery and leaves no artifacts', async contenderCount => {
    const source = join(vaultDir, 'Source.md');
    const lockPath = getLineageMutationLockPath(vaultDir, source);
    const lockDirectory = join(vaultDir, '.bwrb', 'locks');
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, lockMetadata(lockPath, deadPid(), 'crashed-owner'));
    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath, old, old);

    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: contenderCount }, () =>
      withLineageMutationLocks(vaultDir, [source], async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active--;
      }, { retryMs: 2 })
    ));

    expect(maxActive).toBe(1);
    const artifacts = (await readdir(lockDirectory))
      .filter(entry => entry.startsWith(basename(lockPath)));
    expect(artifacts).toEqual([]);
  });
});

function lockMetadata(lockPath: string, pid: number, token: string): string {
  const now = Date.now() - 31_000;
  return `${JSON.stringify({
    version: 1,
    pid,
    token,
    createdAt: now,
    heartbeatAt: now,
    pathKey: basename(lockPath),
  })}\n`;
}

function deadPid(): number {
  const candidates = [2_147_483_647, 2_000_000_000, 1_500_000_000];
  for (const pid of candidates) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('Could not find an unused PID for stale-lock testing');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
