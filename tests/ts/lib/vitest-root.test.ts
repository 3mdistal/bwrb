import { describe, expect, it } from 'vitest';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveVitestRoot } from '../support/vitest-root.js';

describe('resolveVitestRoot', () => {
  it('returns cwd unchanged when path has no hash', () => {
    expect(resolveVitestRoot('/tmp/bwrb-no-hash')).toBe('/tmp/bwrb-no-hash');
  });

  it('creates top-level temp symlink for hash paths', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'bwrb#root-'));

    try {
      const root = resolveVitestRoot(cwd);
      expect(root.includes('#')).toBe(false);
      expect(path.dirname(root)).toBe(os.tmpdir());
      expect(await readlink(root)).toBe(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
