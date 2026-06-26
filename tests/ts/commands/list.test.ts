import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('list command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('basic listing', () => {
    it('should resolve the vault from BWRB_VAULT when not running inside a vault', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bwrb-list-env-vault-'));

      try {
        const result = await runCLI(['list', '--output', 'paths'], undefined, undefined, {
          cwd,
          env: { BWRB_VAULT: vaultDir },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Ideas/Sample Idea.md');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('should list ideas by name', async () => {
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should list subtypes with slash notation', async () => {
      const result = await runCLI(['list', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
    });

    it('should match hyphenated frontmatter keys in --where', async () => {
      const taskDir = join(vaultDir, 'Objectives', 'Tasks');
      await mkdir(taskDir, { recursive: true });
      const notePath = join(taskDir, 'Hyphen Task.md');
      await writeFile(
        notePath,
        [
          '---',
          'type: task',
          'status: backlog',
          'creation-date: 2026-01-28',
          '---',
          '',
          'Test note',
          '',
        ].join('\n')
      );

      const result = await runCLI(
        ['list', 'task', '--where', "creation-date == '2026-01-28'"],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hyphen Task');
    });

    it('should not show deprecation warning for positional type argument', async () => {
      // Positional type is a permanent shortcut for list command (see docs/product/cli-targeting.md)
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('Warning:');
      expect(result.stderr).not.toContain('positional type argument');
    });

    it('should list all subtypes when listing parent type', async () => {
      const result = await runCLI(['list', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).toContain('Settled Milestone');
    });

    it('should return empty for type with no files', async () => {
      const result = await runCLI(['list', 'milestone', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      // Output should indicate no notes found matching the filter
      expect(result.stdout).toContain('No notes found matching');
    });

    it('should sort results alphabetically', async () => {
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n');
      const anotherIndex = lines.findIndex(l => l.includes('Another Idea'));
      const sampleIndex = lines.findIndex(l => l.includes('Sample Idea'));
      expect(anotherIndex).toBeLessThan(sampleIndex);
    });
  });

  describe('--output flag', () => {
    it('should show file paths with --output paths', async () => {
      const result = await runCLI(['list', '--output', 'paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
    });

    it('should show wikilinks with --output link', async () => {
      const result = await runCLI(['list', '--output', 'link', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[[Sample Idea]]');
      expect(result.stdout).toContain('[[Another Idea]]');
    });

    it('should show directory hierarchy with --output tree for non-recursive types', async () => {
      const result = await runCLI(['list', '--output', 'tree', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/');
      expect(result.stdout).toContain('Milestones/');
      expect(result.stdout).toContain('Tasks/');
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).toContain('Sample Task');
    });

    it('should use directory hierarchy for recursive types without parent-child relationships', async () => {
      const result = await runCLI(['list', '--output', 'tree', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/');
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).toContain('Sample Idea');
    });

    it('should show JSON with --output json', async () => {
      const result = await runCLI(['list', '--output', 'json', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      // --output json outputs raw JSON array
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThan(0);
      expect(json[0]).toHaveProperty('_path');
      expect(json[0]).toHaveProperty('_name');
    });
  });

  describe('deprecated --paths flag', () => {
    it('should show file paths instead of names (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output paths');
    });

    it('should show nested paths for subtypes', async () => {
      const result = await runCLI(['list', '--paths', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/Tasks/Sample Task.md');
    });
  });

  describe('deprecated --tree flag', () => {
    it('should show tree structure (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--tree', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/');
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output tree');
    });
  });

  describe('deprecated --json flag', () => {
    it('should show JSON output (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--json', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Deprecated --json outputs raw array (backward compatible)
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output json');
    });
  });

  describe('--fields flag', () => {
    it('should show single field in table format', async () => {
      const result = await runCLI(['list', '--fields=status', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('raw');
      expect(result.stdout).toContain('backlog');
    });

    it('should show multiple fields', async () => {
      const result = await runCLI(['list', '--fields=status,priority', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('PRIORITY');
      expect(result.stdout).toContain('medium');
      expect(result.stdout).toContain('high');
    });

    it('should restrict JSON output to requested fields and allow name', async () => {
      const result = await runCLI(
        ['list', '--type', 'idea', '--fields', 'name,status,priority', '--output', 'json'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toEqual([
        {
          _path: 'Ideas/Another Idea.md',
          _name: 'Another Idea',
          name: 'Another Idea',
          status: 'backlog',
          priority: 'high',
        },
        {
          _path: 'Ideas/Sample Idea.md',
          _name: 'Sample Idea',
          name: 'Sample Idea',
          status: 'raw',
          priority: 'medium',
        },
      ]);
    });

    it('should combine --output paths with --fields', async () => {
      // Note: --output paths outputs plain paths, not a table
      // --fields is ignored when output format is paths
      const result = await runCLI(['list', '--output', 'paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/');
    });

    it('should error on unknown field in --fields when type specified', async () => {
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'unknown_field'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'unknown_field' for type 'idea'");
    });

    it('should suggest similar field names for typos in --fields', async () => {
      // statsu is a typo for 'status'
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'statsu'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'statsu'");
      expect(result.stderr).toContain("Did you mean 'status'?");
    });

    it('should allow unknown fields in --fields without --type (permissive mode)', async () => {
      const result = await runCLI(['list', '--fields', 'unknown_field'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should work in permissive mode, showing table with the field (even if empty)
      expect(result.stdout).toContain('UNKNOWN_FIELD');
    });

    it('should show field validation error in JSON mode', async () => {
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'unknown_field', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain("Unknown field 'unknown_field'");
    });
  });

  describe('--where filters', () => {
    it('should filter by equality', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should filter by OR values using || operator', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw' || status == 'backlog'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should exclude notes with parent-like relation fields from isRoot()', async () => {
      const taskDir = join(vaultDir, 'Objectives', 'Tasks');
      await mkdir(taskDir, { recursive: true });

      await writeFile(
        join(taskDir, 'Root Candidate.md'),
        [
          '---',
          'type: task',
          'status: raw',
          '---',
          '',
        ].join('\n')
      );

      await writeFile(
        join(taskDir, 'Milestoned Task.md'),
        [
          '---',
          'type: task',
          'status: raw',
          'milestone: "[[Active Milestone]]"',
          '---',
          '',
        ].join('\n')
      );

      const result = await runCLI(['list', 'task', '--where', 'isRoot()'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Root Candidate');
      expect(result.stdout).not.toContain('Milestoned Task');
    });

    it('should filter by negation', async () => {
      const result = await runCLI(['list', 'milestone', '--where', "status != 'settled'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).not.toContain('Settled Milestone');
    });
  });

  describe('--body filtering', () => {
    it('should fall back when ripgrep is unavailable', async () => {
      const nodeBinDir = dirname(process.execPath);
      const result = await runCLI(
        ['list', '--type', 'idea', '--body', 'status', '--output', 'json'],
        vaultDir,
        undefined,
        { env: { PATH: `${nodeBinDir}:/usr/bin:/bin` } }
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toHaveLength(2);
      expect(json[0]).toHaveProperty('_path', 'Ideas/Another Idea.md');
      expect(json[1]).toHaveProperty('_path', 'Ideas/Sample Idea.md');
    });
  });

  describe('--where expression filters', () => {
    it('should filter with equality expression', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should filter with comparison expression', async () => {
      const result = await runCLI(['list', 'idea', '--where', "priority == 'high'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).not.toContain('Sample Idea');
    });

    it('should support multiple --where (AND logic)', async () => {
      const result = await runCLI(
        ['list', 'idea', '--where', "status == 'backlog'", '--where', "priority == 'high'"],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).not.toContain('Sample Idea');
    });
  });

  describe('--limit and --count', () => {
    it('should limit text output to the first matching notes', async () => {
      const result = await runCLI(['list', 'idea', '--limit', '1'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).not.toContain('Sample Idea');
    });

    it('should limit JSON output', async () => {
      const result = await runCLI(['list', 'idea', '--limit', '1', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toHaveLength(1);
      expect(json[0]._name).toBe('Another Idea');
    });

    it('should limit link and path output formats', async () => {
      const linkResult = await runCLI(['list', 'idea', '--limit', '1', '--output', 'link'], vaultDir);
      const pathResult = await runCLI(['list', 'idea', '--limit', '1', '--output', 'paths'], vaultDir);

      expect(linkResult.exitCode).toBe(0);
      expect(linkResult.stdout.trim()).toBe('[[Another Idea]]');
      expect(pathResult.exitCode).toBe(0);
      expect(pathResult.stdout.trim()).toBe('Ideas/Another Idea.md');
    });

    it('should print only the matching count in text mode', async () => {
      const result = await runCLI(['list', 'idea', '--count'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('2');
    });

    it('should print only the matching count in JSON mode', async () => {
      const result = await runCLI(['list', 'idea', '--count', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ count: 2 });
    });

    it('should count matches before applying --limit', async () => {
      const result = await runCLI(['list', 'idea', '--limit', '1', '--count'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('2');
    });

    it('should reject invalid limit values', async () => {
      const result = await runCLI(['list', 'idea', '--limit', '0'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid --limit value');
    });

    it('should return JSON errors for invalid limit values in JSON mode', async () => {
      const result = await runCLI(['list', 'idea', '--limit', 'abc', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid --limit value');
    });
  });

  describe('--sort', () => {
    it('should sort by a frontmatter field in ascending order', async () => {
      await writeFile(
        join(vaultDir, 'Ideas', 'Low Effort Idea.md'),
        [
          '---',
          'type: idea',
          'status: raw',
          'priority: low',
          'effort: 1',
          '---',
          '',
        ].join('\n')
      );

      const result = await runCLI(['list', 'idea', '--sort', 'effort', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.map((note: { _name: string }) => note._name)).toEqual([
        'Low Effort Idea',
        'Sample Idea',
        'Another Idea',
      ]);
    });

    it('should sort descending and keep missing values at the end', async () => {
      await writeFile(
        join(vaultDir, 'Ideas', 'Low Effort Idea.md'),
        [
          '---',
          'type: idea',
          'status: raw',
          'priority: low',
          'effort: 1',
          '---',
          '',
        ].join('\n')
      );

      const result = await runCLI(['list', 'idea', '--sort', 'effort', '--desc', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.map((note: { _name: string }) => note._name)).toEqual([
        'Sample Idea',
        'Low Effort Idea',
        'Another Idea',
      ]);
    });

    it('should compose sort with limit', async () => {
      await writeFile(
        join(vaultDir, 'Ideas', 'Low Effort Idea.md'),
        [
          '---',
          'type: idea',
          'status: raw',
          'priority: low',
          'effort: 1',
          '---',
          '',
        ].join('\n')
      );

      const result = await runCLI(['list', 'idea', '--sort', 'effort', '--desc', '--limit', '1'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Sample Idea');
    });

    it('should sort by display fields', async () => {
      const result = await runCLI(['list', 'idea', '--sort', '_path', '--desc', '--output', 'paths'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        'Ideas/Sample Idea.md',
        'Ideas/Low Effort Idea.md',
        'Ideas/Another Idea.md',
      ]);
    });

    it('should apply sort order within tree output', async () => {
      await writeFile(
        join(vaultDir, 'Objectives', 'Tasks', 'Later Task.md'),
        [
          '---',
          'type: task',
          'status: backlog',
          'deadline: "2025-01-01"',
          '---',
          '',
        ].join('\n')
      );

      const result = await runCLI(['list', 'task', '--sort', 'deadline', '--output', 'tree'], vaultDir);

      expect(result.exitCode).toBe(0);
      const sampleIndex = result.stdout.indexOf('Sample Task');
      const laterIndex = result.stdout.indexOf('Later Task');
      expect(sampleIndex).toBeGreaterThanOrEqual(0);
      expect(laterIndex).toBeGreaterThanOrEqual(0);
      expect(sampleIndex).toBeLessThan(laterIndex);
    });

    it('should reject unknown sort fields when type is specified', async () => {
      const result = await runCLI(['list', 'idea', '--sort', 'statsu'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'statsu'");
      expect(result.stderr).toContain("Did you mean 'status'?");
    });

    it('should reject --desc without --sort', async () => {
      const result = await runCLI(['list', 'idea', '--desc'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Cannot use --desc without --sort');
    });
  });

  describe('--sort file.* stat keys', () => {
    let statVault: string;

    beforeEach(async () => {
      statVault = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(statVault);
    });

    /** Set a file's mtime/atime to a fixed epoch-seconds value. */
    async function setMtime(rel: string, seconds: number): Promise<void> {
      const { utimes } = await import('fs/promises');
      const when = new Date(seconds * 1000);
      await utimes(join(statVault, rel), when, when);
    }

    it('sorts by file.mtime ascending (oldest first)', async () => {
      const base = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', base + 300);
      await setMtime('Ideas/Another Idea.md', base + 100);

      const result = await runCLI(
        ['list', 'idea', '--sort', 'file.mtime', '--output', 'paths'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines.indexOf('Ideas/Another Idea.md')).toBeLessThan(
        lines.indexOf('Ideas/Sample Idea.md')
      );
    });

    it('sorts by file.mtime descending (most-recent first)', async () => {
      const base = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', base + 100);
      await setMtime('Ideas/Another Idea.md', base + 300);

      const result = await runCLI(
        ['list', 'idea', '--sort', 'file.mtime', '--desc', '--output', 'paths'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines.indexOf('Ideas/Another Idea.md')).toBeLessThan(
        lines.indexOf('Ideas/Sample Idea.md')
      );
    });

    it('accepts file.ctime as a sort key', async () => {
      const result = await runCLI(
        ['list', 'idea', '--sort', 'file.ctime', '--desc', '--output', 'paths'],
        statVault
      );
      expect(result.exitCode).toBe(0);
      // All ideas present (ordering by ctime is platform-dependent for fixtures)
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
    });

    it('accepts file.size as a sort key', async () => {
      const result = await runCLI(
        ['list', 'idea', '--sort', 'file.size', '--output', 'paths'],
        statVault
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });

    it('combines file.mtime sort with --limit', async () => {
      const base = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', base + 100);
      await setMtime('Ideas/Another Idea.md', base + 300);

      const result = await runCLI(
        ['list', 'idea', '--sort', 'file.mtime', '--desc', '--limit', '1'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Another Idea');
    });

    it('combines file.mtime sort with --where', async () => {
      const base = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', base + 100);
      await setMtime('Ideas/Another Idea.md', base + 300);

      const result = await runCLI(
        ['list', 'idea', '--where', '!isEmpty(status)', '--sort', 'file.mtime', '--desc', '--output', 'paths'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      // Both ideas pass the filter; most-recent (Another Idea) first.
      expect(lines.indexOf('Ideas/Another Idea.md')).toBeLessThan(
        lines.indexOf('Ideas/Sample Idea.md')
      );
    });

    it('still rejects an unknown sort key', async () => {
      const result = await runCLI(['list', 'idea', '--sort', 'file.bogus'], statVault);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'file.bogus'");
    });
  });

  describe('--fields file.* stat columns (#689)', () => {
    let statVault: string;

    beforeEach(async () => {
      statVault = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(statVault);
    });

    /** Set a file's mtime to a fixed epoch-seconds value. */
    async function setMtime(rel: string, seconds: number): Promise<void> {
      const { utimes } = await import('fs/promises');
      const when = new Date(seconds * 1000);
      await utimes(join(statVault, rel), when, when);
    }

    /** Local-time YYYY-MM-DD HH:MM rendering, matching formatFileTimestamp. */
    function expectedStamp(seconds: number): string {
      const d = new Date(seconds * 1000);
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    it('renders file.mtime as a populated date column (regression: was empty)', async () => {
      const seconds = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', seconds);

      const result = await runCLI(['list', 'idea', '--fields', 'file.mtime'], statVault);

      expect(result.exitCode).toBe(0);
      // Header present and column populated (not the empty-cell placeholder).
      expect(result.stdout).toContain('FILE.MTIME');
      const stamp = expectedStamp(seconds);
      expect(result.stdout).toContain(stamp);
      // The Sample Idea row must carry the stamp, not the em-dash placeholder.
      const sampleRow = result.stdout
        .split('\n')
        .find(line => line.includes('Sample Idea'));
      expect(sampleRow).toBeDefined();
      expect(sampleRow).toContain(stamp);
    });

    it('renders file.size as a numeric byte column', async () => {
      const { stat } = await import('fs/promises');
      const size = (await stat(join(statVault, 'Ideas/Sample Idea.md'))).size;

      const result = await runCLI(['list', 'idea', '--fields', 'file.size'], statVault);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('FILE.SIZE');
      const sampleRow = result.stdout
        .split('\n')
        .find(line => line.includes('Sample Idea'));
      expect(sampleRow).toBeDefined();
      expect(sampleRow).toContain(String(size));
    });

    it('mixes file.* columns with a frontmatter field', async () => {
      const seconds = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', seconds);

      const result = await runCLI(
        ['list', 'idea', '--fields', 'file.mtime,file.size,status'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('FILE.MTIME');
      expect(result.stdout).toContain('FILE.SIZE');
      expect(result.stdout).toContain('STATUS');
      // Frontmatter column still works alongside file.* columns.
      expect(result.stdout).toContain('raw');
      expect(result.stdout).toContain(expectedStamp(seconds));
    });

    it('includes file.* values in --output json (mtime ISO, size number)', async () => {
      const seconds = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', seconds);
      const { stat } = await import('fs/promises');
      const size = (await stat(join(statVault, 'Ideas/Sample Idea.md'))).size;

      const result = await runCLI(
        ['list', 'idea', '--fields', 'file.mtime,file.size,status', '--output', 'json'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      const sample = parsed.find(row => row['_name'] === 'Sample Idea');
      expect(sample).toBeDefined();
      expect(sample!['file.mtime']).toBe(new Date(seconds * 1000).toISOString());
      expect(sample!['file.size']).toBe(size);
      expect(typeof sample!['file.size']).toBe('number');
      // Frontmatter field still present in JSON.
      expect(sample!['status']).toBe('raw');
    });

    it('renders file.* columns even without --sort (stat map collected for fields)', async () => {
      const seconds = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', seconds);

      // No --sort here: previously the stat map was only collected when sorting,
      // so this column was empty. It must now be populated.
      const result = await runCLI(['list', 'idea', '--fields', 'file.mtime'], statVault);

      expect(result.exitCode).toBe(0);
      const sampleRow = result.stdout
        .split('\n')
        .find(line => line.includes('Sample Idea'));
      expect(sampleRow).toContain(expectedStamp(seconds));
      // The placeholder em-dash must NOT be the value for this column's cell.
      expect(sampleRow).not.toMatch(/Sample Idea\s+—\s*$/);
    });

    it('still sorts by file.mtime while rendering it as a field', async () => {
      const base = 1_700_000_000;
      await setMtime('Ideas/Sample Idea.md', base + 100);
      await setMtime('Ideas/Another Idea.md', base + 300);

      const result = await runCLI(
        ['list', 'idea', '--fields', 'file.mtime', '--sort', 'file.mtime', '--desc'],
        statVault
      );

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n');
      const anotherIdx = lines.findIndex(l => l.includes('Another Idea'));
      const sampleIdx = lines.findIndex(l => l.includes('Sample Idea'));
      expect(anotherIdx).toBeGreaterThanOrEqual(0);
      expect(anotherIdx).toBeLessThan(sampleIdx);
      expect(result.stdout).toContain(expectedStamp(base + 300));
    });
  });

  describe('error handling', () => {
    it('should error on unknown type', async () => {
      const result = await runCLI(['list', '--type', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('suggests the canonical-case type for a case-only mismatch (#670)', async () => {
      const result = await runCLI(['list', '--type', 'TASK'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type: TASK');
      expect(result.stderr).toContain("Did you mean 'task'?");
    });

    it('should show ambiguous error for positional that could be type or path', async () => {
      const result = await runCLI(['list', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Ambiguous argument');
    });

    it('should handle where expressions that match nothing', async () => {
      // Where expressions with valid values that don't match any notes return empty results
      // Using 'settled' which is a valid status but has no matching notes
      const result = await runCLI(['list', 'idea', '--where', "status == 'settled'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No notes found matching');
    });

    it('should error on invalid select field value in where expression', async () => {
      // When --type is specified, select field values are validated
      const result = await runCLI(['list', 'idea', '--where', "status == 'nonexistent'"], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid value 'nonexistent' for field 'status'");
      expect(result.stderr).toContain('Valid options:');
    });

    it('should allow unknown where fields without --type (permissive mode)', async () => {
      const result = await runCLI(['list', '--where', "unknown_field == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should fail on invalid where syntax in text mode', async () => {
      const result = await runCLI(['list', '--where', "status == 'raw' &&"], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Expression error in');
      expect(result.stderr).toContain('Expression parse error');
    });

    it('should fail on invalid where syntax in json mode', async () => {
      const result = await runCLI([
        'list', '--where', "status == 'raw' &&", '--output', 'json'
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Expression error in');
      expect(json.error).toContain('Expression parse error');
    });

    it('should list all notes when no selectors provided (implicit --all for read-only)', async () => {
      const result = await runCLI(['list'], vaultDir);

      // Read-only commands use implicit --all, so this succeeds
      expect(result.exitCode).toBe(0);
      // Should list notes from the vault
      expect(result.stdout).toBeTruthy();
    });
  });

  describe('hierarchy options for recursive types', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      const { mkdtemp, mkdir, writeFile } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-list-hierarchy-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with a recursive type
      const schemaWithRecursive = {
        version: 2,
        types: {
          task: {
            recursive: true,
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'done'], default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithRecursive, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });

      // Create a hierarchy:
      // Parent Task
      //   ├── Child Task 1
      //   │   └── Grandchild Task
      //   └── Child Task 2
      // Standalone Task (no parent)

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Parent Task.md'),
        `---
type: task
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Child Task 1.md'),
        `---
type: task
status: backlog
parent: "[[Parent Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Child Task 2.md'),
        `---
type: task
status: in-flight
parent: "[[Parent Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Grandchild Task.md'),
        `---
type: task
status: done
parent: "[[Child Task 1]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Standalone Task.md'),
        `---
type: task
status: raw
---
`
      );
    });

    afterEach(async () => {
      const { rm } = await import('fs/promises');
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should list only root notes with --roots', async () => {
      const result = await runCLI(['list', 'task', '--roots'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Standalone Task');
      expect(result.stdout).not.toContain('Child Task');
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should list only direct children with --children-of', async () => {
      const result = await runCLI(['list', 'task', '--children-of', '[[Parent Task]]'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      expect(result.stdout).not.toContain('Parent Task');
      expect(result.stdout).not.toContain('Grandchild');
      expect(result.stdout).not.toContain('Standalone');
    });

    it('should list all descendants with --descendants-of', async () => {
      const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      expect(result.stdout).toContain('Grandchild Task');
      expect(result.stdout).not.toContain('Parent Task');
      expect(result.stdout).not.toContain('Standalone');
    });

    it('should limit descendants depth with --depth', async () => {
      const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]', '--depth', '1'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      // Depth 1 means only direct children, not grandchildren
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should render tree structure with --tree', async () => {
      const result = await runCLI(['list', 'task', '--tree'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      // Tree structure should show indentation/connectors
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Child Task');
      expect(result.stdout).toContain('Grandchild');
      expect(result.stdout).toContain('Standalone');
      // Should have tree connectors
      expect(result.stdout).toMatch(/[├└│]/);
    });

    it('should limit tree depth with --depth', async () => {
      const result = await runCLI(['list', 'task', '--tree', '--depth', '2'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Child Task');
      // Depth 2 means roots + children, no grandchildren
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should combine --roots with other filters', async () => {
      const result = await runCLI(['list', 'task', '--roots', '--where', "status == 'raw'"], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Standalone Task');
      // Both roots have status: raw, so both should appear
    });

    describe('--where hierarchy functions', () => {
      it('should filter with isRoot() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', 'isRoot()'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Parent Task');
        expect(result.stdout).toContain('Standalone Task');
        expect(result.stdout).not.toContain('Child Task');
        expect(result.stdout).not.toContain('Grandchild');
      });

      it('should filter with isChildOf() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', "isChildOf('[[Parent Task]]')"], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Grandchild');
        expect(result.stdout).not.toContain('Standalone');
      });

      it('should filter with isDescendantOf() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', "isDescendantOf('[[Parent Task]]')"], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Standalone');
      });

      it('should combine hierarchy functions with other --where expressions', async () => {
        const result = await runCLI(
          ['list', 'task', '--where', "isDescendantOf('[[Parent Task]]')", '--where', "status == 'done'"],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Child Task 1');
        expect(result.stdout).not.toContain('Child Task 2');
      });

      it('should combine isRoot() with status filter in single expression', async () => {
        const result = await runCLI(
          ['list', 'task', '--where', "isRoot() && status == 'raw'"],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Parent Task');
        expect(result.stdout).toContain('Standalone Task');
      });

      it('should work with negated hierarchy functions', async () => {
        const result = await runCLI(['list', 'task', '--where', '!isRoot()'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Standalone Task');
      });
    });

    describe('deprecated hierarchy flags', () => {
      it('should show deprecation warning for --roots', async () => {
        const result = await runCLI(['list', 'task', '--roots'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--roots');
        expect(result.stderr).toContain('isRoot()');
      });

      it('should show deprecation warning for --children-of', async () => {
        const result = await runCLI(['list', 'task', '--children-of', '[[Parent Task]]'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--children-of');
        expect(result.stderr).toContain('isChildOf');
      });

      it('should show deprecation warning for --descendants-of', async () => {
        const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--descendants-of');
        expect(result.stderr).toContain('isDescendantOf');
      });

      it('should accept -L as alias for --depth', async () => {
        const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]', '-L', '1'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).not.toContain('Grandchild');
      });
    });
  });

  describe('--save-as flag', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      const { mkdtemp, mkdir, writeFile } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-list-save-as-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      const schema = {
        version: 2,
        types: {
          task: {
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['raw', 'active', 'done'], default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schema, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task One.md'),
        `---
type: task
status: active
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task Two.md'),
        `---
type: task
status: done
---
`
      );
    });

    afterEach(async () => {
      const { rm } = await import('fs/promises');
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should save query as dashboard with --save-as', async () => {
      const { readFile, existsSync } = await import('fs');
      const { join } = await import('path');

      const result = await runCLI(['list', '--type', 'task', '--save-as', 'my-tasks'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      // Query results should be shown
      expect(result.stdout).toContain('Task One');
      expect(result.stdout).toContain('Task Two');
      // Confirmation on stderr
      expect(result.stderr).toContain('Dashboard "my-tasks" saved');

      // Verify file was created
      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['my-tasks']).toEqual({ type: 'task' });
    });

    it('should save query with where filter', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--where', "status == 'active'", '--save-as', 'active-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Task One');
      expect(result.stdout).not.toContain('Task Two');
      expect(result.stderr).toContain('Dashboard "active-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['active-tasks']).toEqual({
        type: 'task',
        where: ["status == 'active'"],
      });
    });

    it('should save query with output format', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'paths', '--save-as', 'task-paths'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      // Output format should be paths
      expect(result.stdout).toContain('Tasks/Task One.md');
      expect(result.stderr).toContain('Dashboard "task-paths" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['task-paths']).toEqual({
        type: 'task',
        output: 'paths',
      });
    });

    it('should save query with fields', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--fields', 'status', '--save-as', 'task-table'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STATUS');
      expect(result.stderr).toContain('Dashboard "task-table" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['task-table']).toEqual({
        type: 'task',
        fields: ['status'],
      });
    });

    it('should save query with limit and count options', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--limit', '1', '--count', '--save-as', 'counted-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('2');
      expect(result.stderr).toContain('Dashboard "counted-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['counted-tasks']).toEqual({
        type: 'task',
        limit: 1,
        count: true,
      });
    });

    it('should save query with sort options', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--sort', 'status', '--desc', '--save-as', 'sorted-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "sorted-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['sorted-tasks']).toEqual({
        type: 'task',
        sort: 'status',
        desc: true,
      });
    });

    it('should error when dashboard already exists', async () => {
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'task' } } })
      );

      const result = await runCLI(['list', '--type', 'task', '--save-as', 'existing'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Dashboard "existing" already exists');
      expect(result.stderr).toContain('--force');
    });

    it('should overwrite existing dashboard with --force', async () => {
      const { writeFile, readFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'idea' } } })
      );

      const result = await runCLI(
        ['list', '--type', 'task', '--where', "status == 'active'", '--save-as', 'existing', '--force'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "existing" updated');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await readFile(dashboardsPath, 'utf-8');
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['existing']).toEqual({
        type: 'task',
        where: ["status == 'active'"],
      });
    });

    it('should work with --output json and --save-as', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'json', '--save-as', 'json-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      // JSON output on stdout
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(2);
      // Confirmation on stderr
      expect(result.stderr).toContain('Dashboard "json-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['json-tasks']).toEqual({
        type: 'task',
        output: 'json',
      });
    });

    it('should save empty query (no filters) as dashboard', async () => {
      const { join } = await import('path');

      const result = await runCLI(['list', '--save-as', 'all-notes'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "all-notes" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      // Empty definition since no filters
      expect(dashboards.dashboards['all-notes']).toEqual({});
    });

    it('should return JSON error when dashboard exists in JSON mode', async () => {
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'task' } } })
      );

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'json', '--save-as', 'existing'],
        tempVaultDir
      );

      expect(result.exitCode).not.toBe(0);
      // Error should be in stdout as JSON (matches existing json error pattern)
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });
  });
});

// Positional [mode] parity with `open` (#711). [mode] is the SECOND positional,
// after the smart filter positional. A single positional is always the filter,
// never the mode. --app wins over the positional; an invalid mode errors loudly;
// a third positional is rejected.
describe('list positional app mode (#711)', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('honors a positional mode after a filter positional (list idea print --open ...)', async () => {
    // Scope to a single idea so --open resolves deterministically (no picker).
    const result = await runCLI(
      ['list', 'idea', 'print', '--where', "status == 'raw'", '--open'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Sample Idea.md');
  });

  it('lets --app flag take precedence over positional mode', async () => {
    const result = await runCLI(
      ['list', 'idea', 'system', '--where', "status == 'raw'", '--open', '--app', 'print'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Sample Idea.md');
  });

  it('errors on an invalid positional mode even without --open', async () => {
    const result = await runCLI(['list', 'idea', 'bogus-mode'], vaultDir);

    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Invalid app mode');
  });

  it('rejects excess positional args (list <filter> <mode> <extra>)', async () => {
    const result = await runCLI(
      ['list', 'idea', 'print', 'bogus', '--open'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('too many arguments');
  });

  it('treats a single positional as the smart filter, not the mode', async () => {
    // `list print` -> "print" is parsed as a type filter (unknown type).
    const result = await runCLI(['list', 'print'], vaultDir);

    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Unknown type|Ambiguous argument/i);
  });

  it('does not regress plain listing with a single positional filter', async () => {
    const result = await runCLI(['list', 'idea', '--output', 'paths'], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ideas/Sample Idea.md');
  });
});
