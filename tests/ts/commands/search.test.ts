import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('search command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('default output (name)', () => {
    it('should output name by default', async () => {
      const result = await runCLI(['search', 'Sample Idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Sample Idea');
    });

    it('should resolve case-insensitive', async () => {
      const result = await runCLI(['search', 'sample idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Sample Idea');
    });

    it('should resolve by path', async () => {
      const result = await runCLI(['search', 'Ideas/Sample Idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Sample Idea');
    });
  });

  describe('--output flag', () => {
    it('should output wikilink with --output link', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'link'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('[[Sample Idea]]');
    });

    it('should output relative path with --output paths', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'paths'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Ideas/Sample Idea.md');
    });

    it('should output full file contents with --output content', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'content'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('---');
      expect(result.stdout).toContain('type: idea');
      expect(result.stdout).toContain('status: raw');
    });

    it('should output JSON with --output json', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  describe('deprecated --wikilink flag', () => {
    it('should output wikilink with --wikilink flag (with deprecation warning)', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--wikilink'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('[[Sample Idea]]');
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--output link');
    });
  });

  describe('deprecated --path-output flag', () => {
    it('should output relative path with --path-output flag (with deprecation warning)', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--path-output'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Ideas/Sample Idea.md');
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--output paths');
    });
  });

  describe('deprecated --content flag', () => {
    it('should output full file contents with --content flag (with deprecation warning)', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--content'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('---');
      expect(result.stdout).toContain('type: idea');
      expect(result.stdout).toContain('status: raw');
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--output content');
    });
  });

  describe('deprecated output format priority', () => {
    it('should prioritize --content over --wikilink', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--wikilink', '--content'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should output content (highest priority)
      expect(result.stdout).toContain('type: idea');
      // Should warn about multiple flags
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--content');
    });
  });

  describe('--path targeting (renamed from --path-glob)', () => {
    it('should filter by file path pattern with -p', async () => {
      const result = await runCLI(['search', 'Idea', '-p', 'Ideas/*', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      // Should only find ideas in Ideas/ directory
      for (const item of json.data) {
        expect(item.path).toMatch(/^Ideas\//);
      }
    });

    it('should filter by file path pattern with --path (targeting)', async () => {
      const result = await runCLI(['search', 'Task', '--path', 'Objectives/**/*', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });
  });

  describe('deprecated --path-glob flag', () => {
    it('should still work with deprecation warning', async () => {
      const result = await runCLI(['search', 'Idea', '--path-glob', 'Ideas/*', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--path');
    });
  });

  describe('ambiguous basenames', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();

      // Create duplicate basenames in different directories
      await writeFile(join(tempVaultDir, 'Ideas', 'Duplicate.md'), `---
type: idea
status: raw
---
`);
      await writeFile(join(tempVaultDir, 'Objectives/Tasks', 'Duplicate.md'), `---
type: objective
objective-type: task
status: backlog
---
`);
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should use full path for non-unique basename in wikilink', async () => {
      // Query by full path to get unambiguous match
      const result = await runCLI(['search', 'Ideas/Duplicate.md', '--picker', 'none', '--wikilink'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      // Should use path since basename is not unique
      expect(result.stdout.trim()).toBe('[[Ideas/Duplicate]]');
    });

    it('should error on ambiguous basename in non-interactive mode (text)', async () => {
      const result = await runCLI(['search', 'Duplicate', '--picker', 'none'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Ambiguous');
    });
  });

  describe('discovery consistency with list command (issue #149)', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should respect .gitignore for type directories', async () => {
      await writeFile(join(tempVaultDir, '.gitignore'), 'Ideas/\n');

      const result = await runCLI(['search', 'Idea', '--picker', 'none'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No matching notes found');
    });

    it('should return JSON error when matches are excluded', async () => {
      await writeFile(join(tempVaultDir, '.gitignore'), 'Ideas/\n');

      const result = await runCLI(['search', 'Idea', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('No matching notes found');
    });

    it('should exclude unmanaged files in gitignored directories', async () => {
      // Create an unmanaged file outside type directories
        await mkdir(join(tempVaultDir, 'Drafts'), { recursive: true });
      await writeFile(join(tempVaultDir, 'Drafts', 'WIP Note.md'), `---
title: WIP Note
---
Work in progress
`);

      // Gitignore the Drafts directory
      await writeFile(join(tempVaultDir, '.gitignore'), 'Drafts/\n');

      // Search should NOT find the unmanaged file in gitignored directory
      const result = await runCLI(['search', 'WIP Note', '--picker', 'none'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No matching notes found');
    });

    it('should find unmanaged files NOT in gitignored directories', async () => {
      // Create an unmanaged file outside type directories
        await mkdir(join(tempVaultDir, 'Notes'), { recursive: true });
      await writeFile(join(tempVaultDir, 'Notes', 'Random Note.md'), `---
title: Random Note
---
Some content
`);

      // Search should find the unmanaged file
      const result = await runCLI(['search', 'Random Note', '--picker', 'none'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Random Note');
    });
  });

  describe('error handling', () => {
    it('should error on no matching notes', async () => {
      const result = await runCLI(['search', 'nonexistent-note-xyz', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No matching notes found');
    });

    it('should show picker prompt when no query (requires TTY)', async () => {
      // Without a TTY, should error about needing interactive mode
      const result = await runCLI(['search'], vaultDir);

      expect(result.exitCode).toBe(1);
      // In non-TTY context, it errors about needing a terminal
      expect(result.stderr).toContain('terminal');
    });
  });

  describe('JSON output', () => {
    it('should output JSON array on success', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(1);
      expect(json.data[0].name).toBe('Sample Idea');
      expect(json.data[0].wikilink).toBe('[[Sample Idea]]');
      expect(json.data[0].path).toBe('Ideas/Sample Idea.md');
      expect(json.data[0].absolutePath).toContain('Ideas/Sample Idea.md');
    });

    it('should not include content by default in JSON mode', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data[0].content).toBeUndefined();
    });

    it('should include content in JSON when --content flag is set', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--output', 'json', '--content'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data[0].content).toBeDefined();
      expect(json.data[0].content).toContain('type: idea');
    });

    it('should return all matches in JSON mode with ambiguous query', async () => {
      const result = await runCLI(['search', 'Idea', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThan(1);
      // Should have both ideas
      const names = json.data.map((d: { name: string }) => d.name);
      expect(names).toContain('Sample Idea');
      expect(names).toContain('Another Idea');
    });

    it('should output JSON error on no match', async () => {
      const result = await runCLI(['search', 'nonexistent-xyz', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('No matching notes found');
    });
  });

  describe('help and usage', () => {
    it('should show help with --help flag', async () => {
      const result = await runCLI(['search', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Search for notes');
      expect(result.stdout).toContain('Picker Modes');
      expect(result.stdout).toContain('--wikilink');
      expect(result.stdout).toContain('--path');
      expect(result.stdout).toContain('--content');
    });

    it('should show --preview in help text', async () => {
      const result = await runCLI(['search', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--preview');
      expect(result.stdout).toContain('fzf picker');
    });

    it('should not advertise unsupported simple filter options', async () => {
      const result = await runCLI(['search', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--status!=done');
      expect(result.stdout).toContain('--where "status !=');
    });
  });

  describe('argument validation', () => {
    it('should reject extra positional arguments', async () => {
      const result = await runCLI(['search', 'TODO', '--body', 'status!=done', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/too many arguments/i);
    });
  });

  describe('--preview flag', () => {
    it('should accept --preview flag', async () => {
      // With --picker none, preview is ignored but flag should be accepted
      const result = await runCLI(['search', 'Sample Idea', '--preview', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Sample Idea');
    });
  });

  describe('no query (browse all)', () => {
    it('should error in non-interactive mode with no query', async () => {
      const result = await runCLI(['search', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('should return all files with --output json and no query', async () => {
      const result = await runCLI(['search', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      // Should return all notes in the vault
      expect(json.data.length).toBeGreaterThan(0);
    });
  });

  describe('content search (--body)', () => {
    it('should search file contents with --body flag', async () => {
      const result = await runCLI(['search', 'type', '--body'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find "type:" in frontmatter
      expect(result.stdout).toContain('type:');
    });

    it('should require a pattern for content search', async () => {
      const result = await runCLI(['search', '--body'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('pattern is required');
    });

    it('should filter by type with --type flag', async () => {
      const result = await runCLI(['search', 'status', '--body', '--type', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only find matches in Ideas directory
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Ideas/');
        expect(result.stdout).not.toContain('Tasks/');
        expect(result.stdout).not.toContain('Milestones/');
      }
    });

    it('should output JSON with matches', async () => {
      const result = await runCLI(['search', 'status', '--body', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      if (json.data.length > 0) {
        expect(json.data[0].path).toBeDefined();
        expect(json.data[0].matches).toBeDefined();
        expect(Array.isArray(json.data[0].matches)).toBe(true);
      }
    });

    it('should show context lines by default', async () => {
      const result = await runCLI(['search', 'status', '--body'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Context lines use - as separator, match lines use :
      // Format: file.md:line-context text
      if (result.stdout.trim()) {
        // Should have both : (match) and - (context) separators
        expect(result.stdout).toMatch(/:\d+:/); // match line
      }
    });

    it('should hide context with --no-context', async () => {
      const result = await runCLI(['search', 'status', '--body', '--no-context'], vaultDir);

      expect(result.exitCode).toBe(0);
      // All lines should be match lines (with :line:)
      const lines = result.stdout.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Should not have context separators (line-)
        expect(line).toMatch(/:\d+:/);
      }
    });

    it('should be case-insensitive by default', async () => {
      const result = await runCLI(['search', 'STATUS', '--body', '--no-context'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find matches even though we searched uppercase
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it('should respect --case-sensitive flag', async () => {
      const resultInsensitive = await runCLI(['search', 'STATUS', '--body', '--no-context'], vaultDir);
      const resultSensitive = await runCLI(['search', 'STATUS', '--body', '--no-context', '--case-sensitive'], vaultDir);

      // Case-insensitive should find matches
      expect(resultInsensitive.stdout.trim().length).toBeGreaterThan(0);
      // Case-sensitive should not find "STATUS" (files have lowercase "status")
      expect(resultSensitive.stdout.trim()).toBe('');
    });

    it('should support regex with --regex flag', async () => {
      const result = await runCLI(['search', 'status:.*', '--body', '--no-context', '--regex'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find "status: raw", "status: backlog", etc.
      expect(result.stdout).toContain('status:');
    });

    it('should filter results with --where expression', async () => {
      const result = await runCLI([
        'search', 'status', '--body', '--type', 'idea',
        '--where', "status == 'raw'",
        '--no-context'
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only match Sample Idea (which has status: raw)
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).not.toContain('Another Idea');
      }
    });

    it('should filter results with --where expression', async () => {
      const result = await runCLI([
        'search', 'status', '--body', '--type', 'idea',
        '--where', "status == 'raw'",
        '--no-context'
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only match Sample Idea (which has status: raw)
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).not.toContain('Another Idea');
      }
    });

    it('should filter results with negation using --where', async () => {
      const result = await runCLI([
        'search', 'status', '--body', '--type', 'idea',
        '--where', "status != 'raw'",
        '--no-context'
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only match Another Idea (which has status: backlog)
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Another Idea');
        expect(result.stdout).not.toContain('Sample Idea');
      }
    });

    it('should return empty for no matches', async () => {
      const result = await runCLI(['search', 'xyznonexistent123', '--body'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('should return empty JSON for no matches', async () => {
      const result = await runCLI(['search', 'xyznonexistent123', '--body', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it('should respect --limit flag', async () => {
      const result = await runCLI(['search', 'type', '--body', '--output', 'json', '--limit', '1'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.length).toBeLessThanOrEqual(1);
    });

    it('should show updated help with content search options', async () => {
      const result = await runCLI(['search', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--body');
      expect(result.stdout).toContain('--type');
      expect(result.stdout).toContain('--where');
      expect(result.stdout).toContain('--context');
      expect(result.stdout).toContain('--case-sensitive');
      expect(result.stdout).toContain('--regex');
      expect(result.stdout).toContain('--limit');
    });

    describe('--path filtering with --body (issue #675)', () => {
      it('should filter content-search results with canonical --path', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '--path', 'Ideas/*', '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        // Matches inside the glob are kept...
        expect(json.data.length).toBeGreaterThan(0);
        for (const item of json.data) {
          expect(item.path).toMatch(/^Ideas\//);
        }
        // ...and matches outside the glob are excluded.
        const paths = json.data.map((d: { path: string }) => d.path);
        expect(paths.some((p: string) => p.startsWith('Objectives/'))).toBe(false);
      });

      it('should support -p short flag with --body', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '-p', 'Ideas/*', '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        for (const item of json.data) {
          expect(item.path).toMatch(/^Ideas\//);
        }
      });

      it('should still filter with deprecated --path-glob alias', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '--path-glob', 'Ideas/*', '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        for (const item of json.data) {
          expect(item.path).toMatch(/^Ideas\//);
        }
        const paths = json.data.map((d: { path: string }) => d.path);
        expect(paths.some((p: string) => p.startsWith('Objectives/'))).toBe(false);
        // Deprecation warning still emitted for the alias.
        expect(result.stderr).toContain('Warning');
        expect(result.stderr).toContain('--path');
      });

      it('should produce identical results for --path and --path-glob', async () => {
        const withPath = await runCLI([
          'search', 'status', '--body', '--path', 'Objectives/**', '--output', 'json'
        ], vaultDir);
        const withGlob = await runCLI([
          'search', 'status', '--body', '--path-glob', 'Objectives/**', '--output', 'json'
        ], vaultDir);

        expect(withPath.exitCode).toBe(0);
        expect(withGlob.exitCode).toBe(0);
        const pathData = JSON.parse(withPath.stdout).data
          .map((d: { path: string }) => d.path).sort();
        const globData = JSON.parse(withGlob.stdout).data
          .map((d: { path: string }) => d.path).sort();
        expect(pathData).toEqual(globData);
        expect(pathData.length).toBeGreaterThan(0);
      });
    });

    describe('--where validation with --type', () => {
      it('should accept valid --where with --type', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '--type', 'idea',
          '--where', "status == 'raw'", '--no-context'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        // Should find Sample Idea which has status: raw
        if (result.stdout.trim()) {
          expect(result.stdout).toContain('Sample Idea');
        }
      });

      it('should fail for invalid field in --where when --type is provided', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '--type', 'idea',
          '--where', "unknown_field == 'raw'"
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unknown field 'unknown_field'");
        expect(result.stderr).toContain("for type 'idea'");
      });

      it('should return JsonError for invalid field in --where with --output json', async () => {
        const result = await runCLI([
          'search', 'status', '--body', '--type', 'idea',
          '--where', "unknown_field == 'raw'",
          '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain("Unknown field 'unknown_field'");
      });

      it('should allow unknown where fields without --type (permissive mode)', async () => {
        const result = await runCLI([
          'search', 'status', '--body',
          '--where', "unknown_field == 'raw'"
        ], vaultDir);

        expect(result.exitCode).toBe(0);
      });

      it('should fail on invalid where syntax in text mode', async () => {
        const result = await runCLI([
          'search', 'status', '--body',
          '--where', "status == 'raw' &&"
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Expression error in');
        expect(result.stderr).toContain('Expression parse error');
      });

      it('should fail on where runtime errors in json mode', async () => {
        const result = await runCLI([
          'search', 'status', '--body',
          '--where', 'missingFn(status)',
          '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('Expression error in');
        expect(json.error).toContain('Unknown function: missingFn');
      });
    });
  });
});

describe('nested subdir discovery (#619)', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('lists a note in a nested subdir under output_dir with the parent type', async () => {
    await mkdir(join(vaultDir, 'Ideas', 'Sub'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Ideas', 'Sub', 'Nested Idea.md'),
      '---\ntype: idea\nstatus: raw\n---\n'
    );

    const result = await runCLI(['list', '--type', 'idea', '--output', 'paths'], vaultDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ideas/Sub/Nested Idea.md');
  });

  it('finds a nested note via plain search', async () => {
    await mkdir(join(vaultDir, 'Ideas', 'Sub'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Ideas', 'Sub', 'Nested Idea.md'),
      '---\ntype: idea\nstatus: raw\n---\n'
    );

    const result = await runCLI(
      ['search', 'Nested Idea', '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Ideas/Sub/Nested Idea.md');
  });

  it('finds a deeply nested note via fuzzy search', async () => {
    await mkdir(join(vaultDir, 'Ideas', 'A', 'B'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Ideas', 'A', 'B', 'Deeply Nested Idea.md'),
      '---\ntype: idea\nstatus: raw\n---\n'
    );

    const result = await runCLI(
      ['search', 'Deeply Nestd Idea', '--fuzzy', '--output', 'json'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.data.some((d: { name: string }) => d.name === 'Deeply Nested Idea')).toBe(true);
  });

  it('does not misassign a nested note under one type to another type', async () => {
    // A nested idea under Ideas must not show up when listing tasks.
    await mkdir(join(vaultDir, 'Ideas', 'Sub'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Ideas', 'Sub', 'Nested Idea.md'),
      '---\ntype: idea\nstatus: raw\n---\n'
    );

    const tasks = await runCLI(['list', '--type', 'task', '--output', 'paths'], vaultDir);
    expect(tasks.exitCode).toBe(0);
    expect(tasks.stdout).not.toContain('Nested Idea');
  });

  it('excludes hidden subdirectories under a type output_dir', async () => {
    await mkdir(join(vaultDir, 'Ideas', '.hidden'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Ideas', '.hidden', 'Secret Idea.md'),
      '---\ntype: idea\nstatus: raw\n---\n'
    );

    const result = await runCLI(['list', '--type', 'idea', '--output', 'paths'], vaultDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Secret Idea');
  });
});
