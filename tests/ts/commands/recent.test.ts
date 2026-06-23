import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, utimes, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

/**
 * Set the mtime of a file to a fixed point in time.
 * `seconds` is an absolute epoch-seconds value; larger = more recent.
 */
async function setMtime(path: string, seconds: number): Promise<void> {
  const when = new Date(seconds * 1000);
  await utimes(path, when, when);
}

describe('recent command', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('ordering by mtime', () => {
    it('lists notes most-recent first by file mtime', async () => {
      // Base epoch (2024-01-01ish), spaced an hour apart
      const base = 1_700_000_000;
      await setMtime(join(vaultDir, 'Ideas', 'Sample Idea.md'), base + 100);
      await setMtime(join(vaultDir, 'Ideas', 'Another Idea.md'), base + 300);
      await setMtime(join(vaultDir, 'Objectives/Tasks', 'Sample Task.md'), base + 200);

      const result = await runCLI(['recent', '--output', 'paths'], vaultDir);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      // Most recent (Another Idea, +300) first, then Sample Task (+200),
      // then Sample Idea (+100). Milestones use whatever mtime they have
      // (created during vault setup, likely older or newer — we only assert
      // the relative order of the three we control).
      const idxAnother = lines.indexOf('Ideas/Another Idea.md');
      const idxTask = lines.indexOf('Objectives/Tasks/Sample Task.md');
      const idxSample = lines.indexOf('Ideas/Sample Idea.md');
      expect(idxAnother).toBeGreaterThanOrEqual(0);
      expect(idxAnother).toBeLessThan(idxTask);
      expect(idxTask).toBeLessThan(idxSample);
    });

    it('breaks mtime ties alphabetically by note name', async () => {
      const tie = 1_700_000_500;
      await setMtime(join(vaultDir, 'Ideas', 'Sample Idea.md'), tie);
      await setMtime(join(vaultDir, 'Ideas', 'Another Idea.md'), tie);
      // Push everything else older so the tied pair sorts first
      await setMtime(join(vaultDir, 'Objectives/Tasks', 'Sample Task.md'), tie - 1000);
      await setMtime(join(vaultDir, 'Objectives/Milestones', 'Active Milestone.md'), tie - 1000);
      await setMtime(join(vaultDir, 'Objectives/Milestones', 'Settled Milestone.md'), tie - 1000);

      const result = await runCLI(['recent', '--output', 'paths', '--limit', '2'], vaultDir);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      // Same mtime -> alphabetical: "Another Idea" before "Sample Idea"
      expect(lines).toEqual(['Ideas/Another Idea.md', 'Ideas/Sample Idea.md']);
    });
  });

  describe('--limit', () => {
    it('caps the number of results', async () => {
      const result = await runCLI(['recent', '--output', 'paths', '--limit', '2'], vaultDir);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('rejects a non-positive limit', async () => {
      const result = await runCLI(['recent', '--limit', '0'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Invalid --limit value');
    });
  });

  describe('--type filtering', () => {
    it('only includes notes of the given type', async () => {
      const result = await runCLI(['recent', '--type', 'idea', '--output', 'paths'], vaultDir);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toContain('Ideas/Sample Idea.md');
      expect(lines).toContain('Ideas/Another Idea.md');
      expect(lines.some(l => l.includes('Task'))).toBe(false);
      expect(lines.some(l => l.includes('Milestone'))).toBe(false);
    });

    it('errors on an unknown type', async () => {
      const result = await runCLI(['recent', '--type', 'nonsense'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown type: nonsense');
    });

    it('suggests a close match for a misspelled type', async () => {
      // 'taks' is a transposition of the real type 'task'
      const result = await runCLI(['recent', '--type', 'taks'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown type: taks');
      expect(result.stderr).toContain("Did you mean 'task'?");
    });

    it('does not suggest for a wildly-unknown type', async () => {
      const result = await runCLI(['recent', '--type', 'nonsense'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain('Did you mean');
    });

    it('includes the suggestion in the JSON error payload', async () => {
      const result = await runCLI(['recent', '--type', 'taks', '--output', 'json'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.error).toContain('Unknown type: taks');
      expect(json.error).toContain("Did you mean 'task'?");
    });
  });

  describe('--output json', () => {
    it('emits an array with _path, _name, _modified, and frontmatter', async () => {
      // Make "Another Idea" decisively the most recent of the ideas.
      await setMtime(join(vaultDir, 'Ideas', 'Sample Idea.md'), 1_700_000_000);
      await setMtime(join(vaultDir, 'Ideas', 'Another Idea.md'), 1_700_009_999);

      const result = await runCLI(['recent', '--type', 'idea', '--output', 'json'], vaultDir);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      const first = parsed[0];
      expect(first._name).toBe('Another Idea');
      expect(first._path).toBe('Ideas/Another Idea.md');
      expect(typeof first._modified).toBe('string');
      // _modified is an ISO timestamp
      expect(() => new Date(first._modified).toISOString()).not.toThrow();
      // frontmatter is spread in
      expect(first.type).toBe('idea');
    });

    it('emits an empty array for an empty result set', async () => {
      const result = await runCLI(
        ['recent', '--path', 'NoSuchDir/**', '--output', 'json'],
        vaultDir
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    });
  });

  describe('default output', () => {
    it('shows a NAME / MODIFIED table', async () => {
      const result = await runCLI(['recent', '--type', 'idea'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('MODIFIED');
      expect(result.stdout).toContain('Sample Idea');
    });
  });

  describe('--open / --app', () => {
    it('opens the most recent note (top result) in non-interactive mode', async () => {
      const base = 1_700_000_000;
      await setMtime(join(vaultDir, 'Ideas', 'Sample Idea.md'), base + 100);
      await setMtime(join(vaultDir, 'Ideas', 'Another Idea.md'), base + 999);

      // --app print resolves to printing the path of the opened note.
      const result = await runCLI(
        ['recent', '--type', 'idea', '--open', '--app', 'print'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toContain('Ideas/Another Idea.md');
      // Only the single most-recent note is opened.
      expect(result.stdout.trim()).not.toContain('Sample Idea');
    });

    it('opens the selected note resolved from --type filtering', async () => {
      const result = await runCLI(
        ['recent', '--type', 'task', '--limit', '1', '--open', '--app', 'print'],
        vaultDir
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Task');
    });

    it('prints nothing and exits 0 when --open finds no notes', async () => {
      const result = await runCLI(
        ['recent', '--path', 'NoSuchDir/**', '--open', '--app', 'print'],
        vaultDir
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No notes found');
    });
  });

  describe('--save-as', () => {
    it('saves a recency query as a dashboard (sort file.mtime --desc)', async () => {
      const result = await runCLI(
        ['recent', '--type', 'task', '--save-as', 'recent-tasks'],
        vaultDir
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "recent-tasks" saved.');

      const { readFile } = await import('fs/promises');
      const raw = await readFile(join(vaultDir, '.bwrb', 'dashboards.json'), 'utf8');
      const data = JSON.parse(raw);
      const def = data.dashboards['recent-tasks'];
      expect(def).toBeDefined();
      expect(def.sort).toBe('file.mtime');
      expect(def.desc).toBe(true);
      expect(def.type).toBe('task');
      // recent always limits; the default limit is persisted.
      expect(def.limit).toBe(20);
    });

    it('errors if the dashboard exists without --force', async () => {
      await runCLI(['recent', '--save-as', 'dup'], vaultDir);
      const result = await runCLI(['recent', '--save-as', 'dup'], vaultDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('already exists');
    });

    it('overwrites an existing dashboard with --force', async () => {
      await runCLI(['recent', '--save-as', 'forced'], vaultDir);
      const result = await runCLI(
        ['recent', '--type', 'idea', '--save-as', 'forced', '--force'],
        vaultDir
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "forced" updated.');

      const { readFile } = await import('fs/promises');
      const raw = await readFile(join(vaultDir, '.bwrb', 'dashboards.json'), 'utf8');
      const def = JSON.parse(raw).dashboards['forced'];
      expect(def.type).toBe('idea');
    });
  });

  describe('empty vault', () => {
    it('reports no notes found', async () => {
      const emptyVault = await createTestVault();
      // Remove all managed notes by pointing recent at a type with no notes
      // is covered above; here we exercise the genuinely-empty path filter.
      const result = await runCLI(
        ['recent', '--path', 'DoesNotExist/**', '--output', 'paths'],
        emptyVault
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      await cleanupTestVault(emptyVault);
    });

    it('handles a vault with no managed notes at all', async () => {
      // Build a minimal vault with a schema but no notes.
      const { mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const bare = await mkdtemp(join(tmpdir(), 'bwrb-recent-empty-'));
      await mkdir(join(bare, '.bwrb'), { recursive: true });
      await writeFile(
        join(bare, '.bwrb', 'schema.json'),
        JSON.stringify({ version: 1, types: { idea: { plural: 'Ideas' } } }, null, 2)
      );

      const result = await runCLI(['recent'], bare);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No notes found');
      await cleanupTestVault(bare);
    });
  });
});
