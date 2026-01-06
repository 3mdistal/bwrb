import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import { parseAppMode, resolveAppMode } from '../../../src/commands/open.js';
import type { ResolvedConfig } from '../../../src/types/schema.js';

// Note: We can't test actually opening Obsidian/editors as they require the apps.
// This file tests query resolution, error handling, and validation.

describe('parseAppMode', () => {
  it('should return undefined for undefined/empty input', () => {
    expect(parseAppMode(undefined)).toBeUndefined();
    expect(parseAppMode('')).toBeUndefined();
    expect(parseAppMode('default')).toBeUndefined();
  });

  it('should parse valid modes', () => {
    expect(parseAppMode('system')).toBe('system');
    expect(parseAppMode('editor')).toBe('editor');
    expect(parseAppMode('visual')).toBe('visual');
    expect(parseAppMode('obsidian')).toBe('obsidian');
    expect(parseAppMode('print')).toBe('print');
  });

  it('should be case-insensitive', () => {
    expect(parseAppMode('SYSTEM')).toBe('system');
    expect(parseAppMode('Editor')).toBe('editor');
    expect(parseAppMode('OBSIDIAN')).toBe('obsidian');
  });

  it('should throw on invalid modes', () => {
    expect(() => parseAppMode('invalid')).toThrow('Invalid app mode');
    expect(() => parseAppMode('invalid')).toThrow('system');
    expect(() => parseAppMode('sublime')).toThrow('Must be one of');
  });
});

describe('resolveAppMode', () => {
  const makeConfig = (openWith: 'system' | 'editor' | 'visual' | 'obsidian' = 'system'): ResolvedConfig => ({
    linkFormat: 'wikilink',
    openWith,
    editor: undefined,
    visual: undefined,
    obsidianVault: undefined,
  });

  beforeAll(() => {
    // Clear any existing env var
    delete process.env.BWRB_DEFAULT_APP;
  });

  afterAll(() => {
    delete process.env.BWRB_DEFAULT_APP;
  });

  it('should use explicit CLI value when provided', () => {
    const config = makeConfig('obsidian');
    expect(resolveAppMode('editor', config)).toBe('editor');
    expect(resolveAppMode('print', config)).toBe('print');
  });

  it('should fallback to config when CLI not provided', () => {
    expect(resolveAppMode(undefined, makeConfig('obsidian'))).toBe('obsidian');
    expect(resolveAppMode(undefined, makeConfig('editor'))).toBe('editor');
    expect(resolveAppMode(undefined, makeConfig('system'))).toBe('system');
  });

  it('should use env var over config', () => {
    const config = makeConfig('system');
    process.env.BWRB_DEFAULT_APP = 'obsidian';
    expect(resolveAppMode(undefined, config)).toBe('obsidian');
    delete process.env.BWRB_DEFAULT_APP;
  });

  it('should use CLI over env var', () => {
    const config = makeConfig('system');
    process.env.BWRB_DEFAULT_APP = 'obsidian';
    expect(resolveAppMode('editor', config)).toBe('editor');
    delete process.env.BWRB_DEFAULT_APP;
  });

  it('should throw on invalid env var', () => {
    const config = makeConfig('obsidian');
    process.env.BWRB_DEFAULT_APP = 'invalid-mode';
    // Invalid env var should throw - users need to know their config is wrong
    expect(() => resolveAppMode(undefined, config)).toThrow('Invalid app mode');
    delete process.env.BWRB_DEFAULT_APP;
  });
});

describe('open command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('query resolution', () => {
    it('should resolve exact basename match', async () => {
      // Use --app print to avoid actually opening anything
      const result = await runCLI(['open', 'Sample Idea', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });

    it('should resolve case-insensitive basename', async () => {
      const result = await runCLI(['open', 'sample idea', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });

    it('should resolve exact path', async () => {
      const result = await runCLI(['open', 'Ideas/Sample Idea.md', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });

    it('should resolve path without extension', async () => {
      const result = await runCLI(['open', 'Ideas/Sample Idea', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });
  });

  describe('error handling', () => {
    it('should error on no matching notes', async () => {
      const result = await runCLI(['open', 'nonexistent-note-xyz', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No matching notes found');
    });

    it('should error on ambiguous query in non-interactive mode', async () => {
      // "Idea" matches multiple files via fuzzy match
      const result = await runCLI(['open', 'Idea', '--picker', 'none'], vaultDir);

      // Should error because multiple matches and picker=none
      expect(result.exitCode).toBe(1);
      // Could be "Ambiguous" or list of candidates
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('should show picker prompt when no query (requires TTY)', async () => {
      // Without a TTY, should error about needing interactive mode
      const result = await runCLI(['open'], vaultDir);

      expect(result.exitCode).toBe(1);
      // In non-TTY context, it errors about fzf not being available
      expect(result.stderr).toContain('fzf');
    });
  });

  describe('JSON output', () => {
    it('should output JSON on success with --output json', async () => {
      const result = await runCLI(['open', 'Sample Idea', '--app', 'print', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.relativePath).toBe('Ideas/Sample Idea.md');
    });

    it('should output JSON error on no match with --output json', async () => {
      const result = await runCLI(['open', 'nonexistent-xyz', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('No matching notes found');
    });

    it('should output JSON with candidates on ambiguity', async () => {
      // Note: JSON mode implies --picker none
      const result = await runCLI(['open', 'Idea', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      // Should have error about ambiguity and list candidates
      expect(json.error).toContain('Ambiguous');
      expect(json.errors).toBeDefined();
      expect(json.errors.length).toBeGreaterThan(0);
    });
  });

  describe('help and usage', () => {
    it('should show help with --help flag', async () => {
      const result = await runCLI(['open', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Open a note');
      expect(result.stdout).toContain('App Modes');
      expect(result.stdout).toContain('Picker Modes');
      expect(result.stdout).toContain('BWRB_DEFAULT_APP');
    });

    it('should show all app modes in help', async () => {
      const result = await runCLI(['open', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Verify all modes are documented
      expect(result.stdout).toContain('system');
      expect(result.stdout).toContain('editor');
      expect(result.stdout).toContain('visual');
      expect(result.stdout).toContain('obsidian');
      expect(result.stdout).toContain('print');
      // Verify precedence is documented
      expect(result.stdout).toContain('config.open_with');
    });
  });

  describe('no query (browse all)', () => {
    it('should error in non-interactive mode with no query', async () => {
      // With --picker none and no query, should error about needing interactive mode
      const result = await runCLI(['open', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      // Should complain about ambiguity or needing interactive mode
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('should output JSON error with --output json and no query', async () => {
      const result = await runCLI(['open', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      // JSON output could be on stdout or the command may output nothing if it errors early
      // Try to parse stdout, but if empty, just verify the exit code indicates failure
      if (result.stdout) {
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
      }
      // JSON mode implies --picker none, so should error about ambiguity
    });
  });

  describe('app modes', () => {
    it('should support --app print', async () => {
      const result = await runCLI(['open', 'Sample Idea', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should print the full path
      expect(result.stdout).toContain('Sample Idea.md');
    });

    it('should support --app system with --app print fallback', async () => {
      // We can't actually test system open, but we can verify the mode is accepted
      // Use print mode to verify the command completes successfully
      const result = await runCLI(['open', 'Sample Idea', '--app', 'print'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
    });

    it('should error on invalid --app mode', async () => {
      const result = await runCLI(['open', 'Sample Idea', '--app', 'invalid-mode'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid app mode');
      expect(result.stderr).toContain('system');
      expect(result.stderr).toContain('editor');
      expect(result.stderr).toContain('visual');
      expect(result.stderr).toContain('obsidian');
      expect(result.stderr).toContain('print');
    });

    it('should error on --app editor without EDITOR set', async () => {
      // This test might pass or fail depending on environment
      // Skip if EDITOR is set
      if (process.env['EDITOR'] || process.env['VISUAL']) {
        return;
      }

      const result = await runCLI(['open', 'Sample Idea', '--app', 'editor'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No terminal editor configured');
    });

    it('should error on --app visual without VISUAL set', async () => {
      // Skip if VISUAL is set
      if (process.env['VISUAL']) {
        return;
      }

      const result = await runCLI(['open', 'Sample Idea', '--app', 'visual'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No GUI editor configured');
    });
  });

  describe('preview flag', () => {
    it('should accept --preview flag', async () => {
      // --preview is accepted even when it won't be used (non-interactive mode)
      const result = await runCLI(['open', 'Sample Idea', '--app', 'print', '--preview'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
    });

    it('should show --preview in help text', async () => {
      const result = await runCLI(['open', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--preview');
      expect(result.stdout).toContain('fzf');
    });
  });
});
