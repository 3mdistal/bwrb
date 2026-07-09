import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
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
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
