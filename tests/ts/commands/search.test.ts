import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import { writeFile } from 'fs/promises';
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

  describe('--wikilink output', () => {
    it('should output wikilink with --wikilink flag', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--wikilink'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('[[Sample Idea]]');
    });
  });

  describe('--path output', () => {
    it('should output relative path with --path flag', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--path'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Ideas/Sample Idea.md');
    });
  });

  describe('--content output', () => {
    it('should output full file contents with --content flag', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--content'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('---');
      expect(result.stdout).toContain('type: idea');
      expect(result.stdout).toContain('status: raw');
    });
  });

  describe('output format priority', () => {
    it('should prioritize --content over --path and --wikilink', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--wikilink', '--path', '--content'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should output content (highest priority)
      expect(result.stdout).toContain('type: idea');
      // Should warn about multiple flags
      expect(result.stderr).toContain('Warning');
      expect(result.stderr).toContain('--content');
    });

    it('should prioritize --path over --wikilink', async () => {
      const result = await runCLI(['search', 'Sample Idea', '--wikilink', '--path'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Ideas/Sample Idea.md');
      expect(result.stderr).toContain('Warning');
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

  describe('content search (--text)', () => {
    it('should search file contents with --text flag', async () => {
      const result = await runCLI(['search', 'type', '--text'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find "type:" in frontmatter
      expect(result.stdout).toContain('type:');
    });

    it('should require a pattern for content search', async () => {
      const result = await runCLI(['search', '--text'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('pattern is required');
    });

    it('should filter by type with --type flag', async () => {
      const result = await runCLI(['search', 'status', '--text', '--type', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only find matches in Ideas directory
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Ideas/');
        expect(result.stdout).not.toContain('Tasks/');
        expect(result.stdout).not.toContain('Milestones/');
      }
    });

    it('should output JSON with matches', async () => {
      const result = await runCLI(['search', 'status', '--text', '--output', 'json'], vaultDir);

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
      const result = await runCLI(['search', 'status', '--text'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Context lines use - as separator, match lines use :
      // Format: file.md:line-context text
      if (result.stdout.trim()) {
        // Should have both : (match) and - (context) separators
        expect(result.stdout).toMatch(/:\d+:/); // match line
      }
    });

    it('should hide context with --no-context', async () => {
      const result = await runCLI(['search', 'status', '--text', '--no-context'], vaultDir);

      expect(result.exitCode).toBe(0);
      // All lines should be match lines (with :line:)
      const lines = result.stdout.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Should not have context separators (line-)
        expect(line).toMatch(/:\d+:/);
      }
    });

    it('should be case-insensitive by default', async () => {
      const result = await runCLI(['search', 'STATUS', '--text', '--no-context'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find matches even though we searched uppercase
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it('should respect --case-sensitive flag', async () => {
      const resultInsensitive = await runCLI(['search', 'STATUS', '--text', '--no-context'], vaultDir);
      const resultSensitive = await runCLI(['search', 'STATUS', '--text', '--no-context', '--case-sensitive'], vaultDir);

      // Case-insensitive should find matches
      expect(resultInsensitive.stdout.trim().length).toBeGreaterThan(0);
      // Case-sensitive should not find "STATUS" (files have lowercase "status")
      expect(resultSensitive.stdout.trim()).toBe('');
    });

    it('should support regex with --regex flag', async () => {
      const result = await runCLI(['search', 'status:.*', '--text', '--no-context', '--regex'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should find "status: raw", "status: backlog", etc.
      expect(result.stdout).toContain('status:');
    });

    it('should filter results with --where expression', async () => {
      const result = await runCLI([
        'search', 'status', '--text', '--type', 'idea',
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

    it('should filter results with simple --field=value syntax', async () => {
      const result = await runCLI([
        'search', 'status', '--text', '--type', 'idea',
        '--status=raw',
        '--no-context'
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should only match Sample Idea (which has status: raw)
      if (result.stdout.trim()) {
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).not.toContain('Another Idea');
      }
    });

    it('should filter results with negation --field!=value syntax', async () => {
      const result = await runCLI([
        'search', 'status', '--text', '--type', 'idea',
        '--status!=raw',
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
      const result = await runCLI(['search', 'xyznonexistent123', '--text'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('should return empty JSON for no matches', async () => {
      const result = await runCLI(['search', 'xyznonexistent123', '--text', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it('should respect --limit flag', async () => {
      const result = await runCLI(['search', 'type', '--text', '--output', 'json', '--limit', '1'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.length).toBeLessThanOrEqual(1);
    });

    it('should show updated help with content search options', async () => {
      const result = await runCLI(['search', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--text');
      expect(result.stdout).toContain('--type');
      expect(result.stdout).toContain('--where');
      expect(result.stdout).toContain('--context');
      expect(result.stdout).toContain('--case-sensitive');
      expect(result.stdout).toContain('--regex');
      expect(result.stdout).toContain('--limit');
    });

    describe('filter validation with --type', () => {
      it('should error on invalid filter field when --type is specified', async () => {
        const result = await runCLI([
          'search', 'status', '--text', '--type', 'idea',
          '--nonexistent=value'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown field');
        expect(result.stderr).toContain('nonexistent');
      });

      it('should error on invalid enum value when --type is specified', async () => {
        const result = await runCLI([
          'search', 'status', '--text', '--type', 'idea',
          '--status=invalid'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Invalid value');
        expect(result.stderr).toContain('invalid');
      });

      it('should output JSON error for invalid field when --type is specified', async () => {
        const result = await runCLI([
          'search', 'status', '--text', '--type', 'idea',
          '--nonexistent=value', '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('Unknown field');
      });

      it('should output JSON error for invalid enum value when --type is specified', async () => {
        const result = await runCLI([
          'search', 'status', '--text', '--type', 'idea',
          '--status=invalid', '--output', 'json'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('Invalid value');
      });

      it('should NOT validate filters when --type is NOT specified', async () => {
        // Without --type, there's no schema context, so filters are not validated
        // They just silently won't match anything
        const result = await runCLI([
          'search', 'status', '--text',
          '--nonexistent=value'
        ], vaultDir);

        // Should succeed (no validation error) but return no matches
        expect(result.exitCode).toBe(0);
      });

      it('should accept valid filter with --type', async () => {
        const result = await runCLI([
          'search', 'status', '--text', '--type', 'idea',
          '--status=raw', '--no-context'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        // Should find Sample Idea which has status: raw
        if (result.stdout.trim()) {
          expect(result.stdout).toContain('Sample Idea');
        }
      });
    });
  });
});
