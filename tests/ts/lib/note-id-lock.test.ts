import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  withNoteIdAssignmentLock,
  withNoteIdRegistryLock,
} from '../../../src/lib/note-id.js';
import type { OwnershipFileLockOptions } from '../../../src/lib/lineage-lock.js';

const TEST_LOCK_OPTIONS: Partial<OwnershipFileLockOptions> = {
  retryMs: 2,
  attempts: 250,
  staleMs: 45,
  heartbeatMs: 5,
};

const LOCKS = [
  {
    name: 'note-ID assignment',
    path: '.bwrb/locks/fork-source-id.lock',
    run: withNoteIdAssignmentLock,
  },
  {
    name: 'note-ID registry',
    path: '.bwrb/locks/id-registry.lock',
    run: withNoteIdRegistryLock,
  },
] as const;

describe.each(LOCKS)('$name lock', ({ path, run }) => {
  let vaultDir: string;
  let lockPath: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-note-id-lock-'));
    lockPath = join(vaultDir, path);
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('heartbeats a live holder and does not reap it after the stale threshold', async () => {
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;
    const first = run(vaultDir, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await firstBarrier;
      active--;
    }, TEST_LOCK_OPTIONS);

    await waitFor(() => existsSync(lockPath));
    const initialMtime = (await stat(lockPath)).mtimeMs;
    await delay(70);
    const heartbeatMtime = (await stat(lockPath)).mtimeMs;
    expect(heartbeatMtime).toBeGreaterThan(initialMtime);
    expect(Date.now() - heartbeatMtime).toBeLessThan(45);

    let secondEntered = false;
    const second = run(vaultDir, async () => {
      secondEntered = true;
      active++;
      maxActive = Math.max(maxActive, active);
      active--;
    }, TEST_LOCK_OPTIONS);
    await delay(25);
    expect(secondEntered).toBe(false);
    expect(maxActive).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps a successor owned after replacement and serializes a third holder behind it', async () => {
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = run(vaultDir, async () => {
      await firstBarrier;
    }, TEST_LOCK_OPTIONS);
    await waitFor(() => existsSync(lockPath));

    // Simulate stale-owner recovery moving the old inode out of the lock path.
    // The successor then acquires that same fixed coordination pathname.
    await unlink(lockPath);
    let releaseSecond!: () => void;
    const secondBarrier = new Promise<void>(resolve => { releaseSecond = resolve; });
    let active = 0;
    let maxActive = 0;
    let secondEntered = false;
    const second = run(vaultDir, async () => {
      secondEntered = true;
      active++;
      maxActive = Math.max(maxActive, active);
      await secondBarrier;
      active--;
    }, TEST_LOCK_OPTIONS);
    await waitFor(() => secondEntered);
    const successorMetadata = await readFile(lockPath, 'utf-8');

    releaseFirst();
    await first;
    expect(await readFile(lockPath, 'utf-8')).toBe(successorMetadata);

    let thirdEntered = false;
    const third = run(vaultDir, async () => {
      thirdEntered = true;
      active++;
      maxActive = Math.max(maxActive, active);
      active--;
    }, TEST_LOCK_OPTIONS);
    await delay(25);
    expect(thirdEntered).toBe(false);
    expect(maxActive).toBe(1);

    releaseSecond();
    await Promise.all([second, third]);
    expect(thirdEntered).toBe(true);
    expect(maxActive).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('Timed out waiting for lock test condition');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
