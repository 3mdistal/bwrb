import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { withLineageMutationLocks } from '../../../src/lib/lineage-lock.js';

const exclude = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/lib/lock-git-exclude.js', () => ({ excludeRuntimeLocksFromGit: exclude }));

describe('lineage lock folder preparation', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-lineage-prepare-'));
    exclude.mockClear();
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('prepares the lock folder once per call, not once per lock', async () => {
    const sources = [1, 2, 3, 4, 5].map(n => join(vaultDir, `Note ${n}.md`));
    await withLineageMutationLocks(vaultDir, sources, async () => undefined);
    expect(exclude).toHaveBeenCalledTimes(1);

    await withLineageMutationLocks(vaultDir, sources, async () => undefined);
    expect(exclude).toHaveBeenCalledTimes(2);
  });

  it('still recovers a dead owner\'s lock before a multi-lock task runs', async () => {
    const locks = join(vaultDir, '.bwrb', 'locks');
    await mkdir(locks, { recursive: true });
    const orphan = join(locks, 'lineage-source-orphan.lock');
    await writeFile(orphan, metadata(orphan, deadPid()));

    const sources = [1, 2, 3].map(n => join(vaultDir, `Note ${n}.md`));
    await withLineageMutationLocks(vaultDir, sources, async () => {
      expect(existsSync(orphan)).toBe(false);
    });
  });
});

function metadata(path: string, pid: number): string {
  const now = Date.now();
  return JSON.stringify({ version: 1, pid, token: `owner-${pid}`, createdAt: now, heartbeatAt: now, pathKey: basename(path) });
}
function deadPid(): number {
  for (const pid of [2_147_483_647, 2_000_000_000, 1_500_000_000]) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid; }
  }
  throw new Error('No unused PID available for test');
}
