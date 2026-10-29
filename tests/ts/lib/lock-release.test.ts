import { readFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withOwnershipFileLock } from '../../../src/lib/lineage-lock.js';

vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
const read = vi.mocked(readFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bwrb-release-errors-'));
  read.mockReset().mockImplementation(actual.readFile);
});
afterEach(async () => {
  read.mockReset().mockImplementation(actual.readFile);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('lock release errors', () => {
  it('warns without replacing a successful result when the verification read fails', async () => {
    const path = join(root, 'test.lock');
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    let releasing = false;
    let reads = 0;
    read.mockImplementation(async (file, options) => {
      if (releasing && file === path) {
        throw Object.assign(new Error('injected read error'), { code: ++reads === 1 ? 'EPERM' : 'EIO' });
      }
      return actual.readFile(file, options);
    });
    await expect(withOwnershipFileLock(path, async () => {
      releasing = true;
      return 42;
    })).resolves.toBe(42);
    expect(reads).toBe(2);
    expect(warning).toHaveBeenCalledWith(expect.any(String), { code: 'BWRB_LOCK_RELEASE_FAILED' });
    expect(await actual.readFile(path, 'utf8')).toContain('"pid"');
  });

  it('preserves the task error when cleanup itself throws', async () => {
    const path = join(root, 'test.lock');
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const taskError = new Error('original task failure');
    let releasing = false;
    read.mockImplementation(async (file, options) => {
      if (releasing && file === path) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      return actual.readFile(file, options);
    });
    await expect(withOwnershipFileLock(path, async () => {
      releasing = true;
      throw taskError;
    })).rejects.toBe(taskError);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
