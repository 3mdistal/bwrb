/**
 * Integration tests for relative vault path handling.
 *
 * These tests verify that all CLI commands work correctly when
 * the --vault option is given a relative path instead of an absolute path.
 * This is important because users may run bwrb from various directories
 * and use relative paths like `--vault ./my-vault` or `--vault ../vaults/work`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  createTestVault,
  cleanupTestVault,
  runCLI,
  getRelativeVaultPath,
  PROJECT_ROOT,
} from '../fixtures/setup.js';

describe('relative vault path handling', () => {
  let vaultDir: string;
  let relativeVaultPath: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    // Get path relative to PROJECT_ROOT (where CLI runs from)
    relativeVaultPath = getRelativeVaultPath(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('list command', () => {
    it('should work with relative --vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'list', 'idea']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should work with subtypes using relative path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'list', 'task']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
    });

    it('should filter correctly with relative path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'list', 'idea', '--where', "status == 'raw'"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should show paths correctly with relative vault', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'list', '--paths', 'idea']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });
  });

  describe('search command', () => {
    it('should work with relative --vault path', async () => {
      // Use exact match to avoid ambiguous results
      const result = await runCLI([
        '--vault', relativeVaultPath, 'search', 'Sample Idea', '--picker', 'none',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
    });

    it('should generate wikilinks with relative vault path', async () => {
      const result = await runCLI([
        '--vault', relativeVaultPath, 'search', '--wikilink', 'Sample Idea', '--picker', 'none',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[[Sample Idea]]');
    });

    it('should show paths with relative vault path', async () => {
      const result = await runCLI([
        '--vault', relativeVaultPath, 'search', '--output', 'paths', 'Sample Task', '--picker', 'none',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/Tasks/Sample Task.md');
    });
  });

  describe('schema command', () => {
    it('should load schema with relative vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'schema', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('idea');
      expect(result.stdout).toContain('objective');
    });

    it('should show type details with relative vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'schema', 'list', 'type', 'idea']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('idea');
      expect(result.stdout).toContain('Ideas');
    });
  });

  describe('audit command', () => {
    it('should audit with relative vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'audit', 'idea']);

      // Should succeed (exit 0) or report issues (exit 1), not crash
      expect([0, 1]).toContain(result.exitCode);
      // Should not have schema loading errors
      expect(result.stderr).not.toContain('schema');
    });

    it('should audit all types with relative vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'audit', '--all']);

      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('new command (JSON mode)', () => {
    it('should create note with relative vault path', async () => {
      const json = JSON.stringify({
        'name': 'Relative Path Test Idea',
        status: 'raw',
        priority: 'low',
      });
      const result = await runCLI(['--vault', relativeVaultPath, 'new', 'idea', '--json', json]);

      expect(result.exitCode).toBe(0);
      // Parse JSON output - structure is { success: true, path: "..." }
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.path).toContain('Ideas/Relative Path Test Idea.md');

      // Verify file was created
      expect(existsSync(join(vaultDir, 'Ideas', 'Relative Path Test Idea.md'))).toBe(true);
    });

    it('should create subtype note with relative vault path', async () => {
      const json = JSON.stringify({
        'name': 'Relative Path Test Task',
        status: 'backlog',
      });
      const result = await runCLI([
        '--vault',
        relativeVaultPath,
        'new',
        'task',
        '--json',
        json,
      ]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.path).toContain('Objectives/Tasks/Relative Path Test Task.md');
    });

    it('should report validation errors with relative vault path', async () => {
      const json = JSON.stringify({
        'name': 'Bad Idea',
        status: 'invalid-status', // Invalid enum value
      });
      const result = await runCLI(['--vault', relativeVaultPath, 'new', 'idea', '--json', json]);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(false);
    });
  });

  describe('template command', () => {
    it('should list templates with relative vault path', async () => {
      const result = await runCLI(['--vault', relativeVaultPath, 'template', 'list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('idea');
    });

    it('should show template details with relative vault path', async () => {
      // template list with type and name shows template details
      const result = await runCLI([
        '--vault', relativeVaultPath, 'template', 'list', 'idea', 'default',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('default');
      expect(result.stdout).toContain('idea');
    });
  });

  describe('bulk command', () => {
    it('should preview bulk operation with relative vault path', async () => {
      const result = await runCLI([
        '--vault',
        relativeVaultPath,
        'bulk',
        'idea',
        '--all',
        '--set',
        'status=backlog',
      ]);

      expect(result.exitCode).toBe(0);
      // Dry run shows "Dry run - no changes will be made" instead of "Preview"
      expect(result.stdout).toContain('Dry run');
      expect(result.stdout).toContain('Would affect');
    });
  });
});

describe('edge cases', () => {
  describe('vault path with spaces', () => {
    let spacedVaultDir: string;

    beforeAll(async () => {
      // Create vault in temp dir with space in name
      spacedVaultDir = await mkdtemp(join(tmpdir(), 'bwrb test vault '));

      // Create minimal vault structure
      await mkdir(join(spacedVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(spacedVaultDir, 'Ideas'), { recursive: true });

      await writeFile(
        join(spacedVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            idea: {
              output_dir: 'Ideas',
              fields: {
                type: { value: 'idea' },
                status: { prompt: 'select', options: ['raw', 'done'] },
              },
              field_order: ['type', 'status'],
            },
          },
        })
      );

      await writeFile(
        join(spacedVaultDir, 'Ideas', 'Spaced Idea.md'),
        `---
type: idea
status: raw
---
`
      );
    });

    afterAll(async () => {
      await rm(spacedVaultDir, { recursive: true, force: true });
    });

    it('should handle vault path with spaces', async () => {
      const relativePath = getRelativeVaultPath(spacedVaultDir);
      const result = await runCLI(['--vault', relativePath, 'list', 'idea']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Spaced Idea');
    });
  });

  describe('error handling', () => {
    it('should error gracefully for non-existent relative path', async () => {
      const result = await runCLI(['--vault', './nonexistent/vault', 'list', 'idea']);

      expect(result.exitCode).not.toBe(0);
      // Should mention schema not found
      expect(result.stderr.toLowerCase()).toMatch(/schema|not found|enoent/);
    });

    it('should error gracefully for invalid relative path', async () => {
      const result = await runCLI(['--vault', '...///invalid', 'list', 'idea']);

      expect(result.exitCode).not.toBe(0);
    });
  });
});
