import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, relative, sep } from 'path';
import { tmpdir } from 'os';
import { withLineageMutationLocks } from '../../../src/lib/lineage-lock.js';
import { resolveSchema } from '../../../src/lib/schema.js';
import { sanitizeFilenameBase } from '../../../src/lib/filename.js';
import { runAutoFix } from '../../../src/lib/audit/fix.js';
import { runRetentionRemediation } from '../../../src/lib/audit/retention.js';
import type { AuditIssue } from '../../../src/lib/audit/types.js';

// Pass-through mock, so a test can see which notes a repair locks.
vi.mock('../../../src/lib/lineage-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/lineage-lock.js')>();
  return { ...actual, withLineageMutationLocks: vi.fn(actual.withLineageMutationLocks) };
});

const actualLocks = await vi.importActual<typeof import('../../../src/lib/lineage-lock.js')>(
  '../../../src/lib/lineage-lock.js'
);
const locks = vi.mocked(withLineageMutationLocks);

describe('audit repairs that move notes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bwrb-repair-locks-'));
    locks.mockReset().mockImplementation(actualLocks.withLineageMutationLocks);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    locks.mockReset().mockImplementation(actualLocks.withLineageMutationLocks);
    await rm(tempDir, { recursive: true, force: true });
  });

  /** The vault-relative paths a repair's nth lock acquisition covered. */
  function lockedPaths(call: number): string[] {
    return locks.mock.calls[call]![1]
      .map(path => relative(tempDir, path).split(sep).join('/'))
      .sort();
  }

  /** Runs the next lock acquisition after `before`, as if another writer acted first. */
  function beforeNextLock(before: () => Promise<void>): void {
    locks.mockImplementationOnce(async (...args) => {
      await before();
      return actualLocks.withLineageMutationLocks(...args);
    });
  }

  describe('unsafe filename repair', () => {
    // Over Bowerbird's filename byte budget, and legal on every platform.
    const longBase = `${'Long title '.repeat(18)}end`;
    const safeBase = sanitizeFilenameBase(longBase).sanitized;
    const schema = resolveSchema({ version: 2, types: {
      idea: { fields: { status: { prompt: 'select', options: ['raw', 'settled'] } }, output_dir: 'Ideas' },
    } });

    beforeEach(async () => {
      await mkdir(join(tempDir, 'Ideas'));
      await writeFile(join(tempDir, 'Ideas', `${longBase}.md`), '---\ntype: idea\nstatus: raw\n---\nBody\n');
      await writeFile(join(tempDir, 'Linker.md'), `See [[${longBase}]].`);
    });

    function repair(options?: { dryRun?: boolean }) {
      const issue: AuditIssue = { severity: 'warning', code: 'unsafe-filename', message: 'Unsafe filename', autoFixable: true };
      return runAutoFix(
        [{ path: join(tempDir, 'Ideas', `${longBase}.md`), relativePath: `Ideas/${longBase}.md`, issues: [issue] }],
        schema,
        tempDir,
        options
      );
    }

    // The repair moves to an absolute folder, which fails on Windows before it
    // writes anything until the link-separator fix lands.
    it.skipIf(process.platform === 'win32')('locks the note under both names and every note whose links it rewrites', async () => {
      beforeNextLock(() => writeFile(join(tempDir, 'Late.md'), `Also [[${longBase}]].`));

      const summary = await repair();

      expect(summary.fixed).toBe(1);
      expect(locks).toHaveBeenCalledTimes(2);
      expect(lockedPaths(0)).toEqual([`Ideas/${longBase}.md`, `Ideas/${safeBase}.md`, 'Linker.md'].sort());
      expect(lockedPaths(1)).toEqual([`Ideas/${longBase}.md`, `Ideas/${safeBase}.md`, 'Late.md', 'Linker.md'].sort());
      expect(await readFile(join(tempDir, 'Linker.md'), 'utf-8')).toBe(`See [[${safeBase}]].`);
      expect(await readFile(join(tempDir, 'Late.md'), 'utf-8')).toBe(`Also [[${safeBase}]].`);
      expect(await readFile(join(tempDir, 'Ideas', `${safeBase}.md`), 'utf-8')).toContain(`name: ${longBase}`);
    });

    it('takes no locks and changes nothing in a dry run', async () => {
      const summary = await repair({ dryRun: true });

      expect(summary.fixed).toBe(1);
      expect(locks).not.toHaveBeenCalled();
      await expect(access(join(tempDir, 'Ideas', `${longBase}.md`))).resolves.toBeUndefined();
      expect(await readFile(join(tempDir, 'Linker.md'), 'utf-8')).toBe(`See [[${longBase}]].`);
    });
  });

  describe('retention archive', () => {
    const schema = resolveSchema({ version: 2, types: {
      candidate: {
        output_dir: 'Candidates',
        fields: {
          status: { prompt: 'select', options: ['accepted', 'open'] },
          'resolved-at': { prompt: 'date', granularity: 'day' },
        },
        retention: {
          when: { status: { in: ['accepted'] } },
          clock: { field: 'resolved-at', after: '1d' },
          actions: [{ kind: 'archive', directory: 'Archive/Candidates' }],
        },
      },
    } });
    const old = () => join(tempDir, 'Candidates', 'Old.md');

    beforeEach(async () => {
      await mkdir(join(tempDir, 'Candidates'));
      await writeFile(old(), '---\ntype: candidate\nstatus: accepted\nresolved-at: 2000-01-01\n---\n');
      // A second Old makes the archived note's links need a path.
      await mkdir(join(tempDir, 'Other'));
      await writeFile(join(tempDir, 'Other', 'Old.md'), '# Other Old');
      await writeFile(join(tempDir, 'Linker.md'), 'See [[Old]].');
    });

    function archive() {
      const issue: AuditIssue = { severity: 'warning', code: 'retention-due', message: 'Retention due', autoFixable: false };
      return runRetentionRemediation({
        results: [{ path: old(), relativePath: 'Candidates/Old.md', issues: [issue] }],
        schema,
        vaultDir: tempDir,
        action: 'archive',
        execute: true,
      });
    }

    it('locks the note at its old and new path and every note whose links it rewrites', async () => {
      beforeNextLock(() => writeFile(join(tempDir, 'Late.md'), 'Also [[Old]].'));

      const outcome = await archive();

      expect(outcome).toMatchObject({ applied: 1, skipped: 0 });
      expect(locks).toHaveBeenCalledTimes(2);
      expect(lockedPaths(0)).toEqual(['Archive/Candidates/Old.md', 'Candidates/Old.md', 'Linker.md']);
      expect(lockedPaths(1)).toEqual(['Archive/Candidates/Old.md', 'Candidates/Old.md', 'Late.md', 'Linker.md']);
      expect(await readFile(join(tempDir, 'Linker.md'), 'utf-8')).toMatch(/^See \[\[Archive[\\/]Candidates[\\/]Old\]\]\.$/);
      expect(await readFile(join(tempDir, 'Late.md'), 'utf-8')).toMatch(/^Also \[\[Archive[\\/]Candidates[\\/]Old\]\]\.$/);
    });

    it('rechecks the note under the locks and moves nothing once it is no longer due', async () => {
      beforeNextLock(() => writeFile(old(), '---\ntype: candidate\nstatus: open\nresolved-at: 2000-01-01\n---\n'));

      const outcome = await archive();

      expect(outcome).toMatchObject({ applied: 0, skipped: 1, messages: ['Candidates/Old.md: no longer due'] });
      await expect(access(old())).resolves.toBeUndefined();
      await expect(access(join(tempDir, 'Archive', 'Candidates', 'Old.md'))).rejects.toThrow();
      expect(await readFile(join(tempDir, 'Linker.md'), 'utf-8')).toBe('See [[Old]].');
    });
  });
});
