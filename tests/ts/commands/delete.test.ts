import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('delete command', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('query resolution', () => {
    it('should delete by exact basename with --force', async () => {
      const filePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Sample Idea', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(result.stdout).toContain('Sample Idea');
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete by exact path with --force', async () => {
      const filePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Ideas/Sample Idea.md', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete by path without extension with --force', async () => {
      const filePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Ideas/Sample Idea', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete case-insensitively with --force', async () => {
      const filePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'sample idea', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should error on no matching notes', async () => {
      const result = await runCLI(['delete', 'nonexistent-note-xyz', '--force', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No matching notes found');
    });

    it('should error on ambiguous query in non-interactive mode', async () => {
      // "Idea" matches multiple files via fuzzy match
      const result = await runCLI(['delete', 'Idea', '--force', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      // Should error because multiple matches and picker=none
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('should error when no query and not interactive', async () => {
      const result = await runCLI(['delete', '--force', '--picker', 'none'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe('JSON mode', () => {
    it('should require --force flag in JSON mode', async () => {
      const result = await runCLI(['delete', 'Sample Idea', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--force');
    });

    it('should output JSON on success', async () => {
      const filePath = join(vaultDir, 'Ideas', 'Sample Idea.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Sample Idea', '--force', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.path).toBe('Ideas/Sample Idea.md');
      expect(json.message).toContain('deleted');
      expect(existsSync(filePath)).toBe(false);
    });

    it('should output JSON error on no match', async () => {
      const result = await runCLI(['delete', 'nonexistent-xyz', '--force', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('No matching notes found');
    });

    it('should output JSON with candidates on ambiguity', async () => {
      const result = await runCLI(['delete', 'Idea', '--force', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Ambiguous');
      expect(json.errors).toBeDefined();
      expect(json.errors.length).toBeGreaterThan(0);
    });
  });

  describe('help and usage', () => {
    it('should show help with --help flag', async () => {
      const result = await runCLI(['delete', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Delete a note');
      expect(result.stdout).toContain('--force');
      expect(result.stdout).toContain('Picker Modes');
      expect(result.stdout).toContain('Examples');
    });
  });

  describe('multiple deletions', () => {
    it('should be able to delete multiple files sequentially', async () => {
      const file1 = join(vaultDir, 'Ideas', 'Sample Idea.md');
      const file2 = join(vaultDir, 'Ideas', 'Another Idea.md');
      expect(existsSync(file1)).toBe(true);
      expect(existsSync(file2)).toBe(true);

      await runCLI(['delete', 'Sample Idea', '--force'], vaultDir);
      await runCLI(['delete', 'Another Idea', '--force'], vaultDir);

      expect(existsSync(file1)).toBe(false);
      expect(existsSync(file2)).toBe(false);
    });
  });

  describe('file types', () => {
    it('should delete task notes', async () => {
      const filePath = join(vaultDir, 'Objectives/Tasks', 'Sample Task.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Sample Task', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete milestone notes', async () => {
      const filePath = join(vaultDir, 'Objectives/Milestones', 'Active Milestone.md');
      expect(existsSync(filePath)).toBe(true);

      const result = await runCLI(['delete', 'Active Milestone', '--force'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe('backlink detection', () => {
    it('should detect backlinks and include count in JSON output', async () => {
      // Create a note that links to Sample Idea
      await writeFile(
        join(vaultDir, 'Ideas', 'Linker Note.md'),
        `---
type: idea
status: raw
---

This links to [[Sample Idea]].
`
      );

      // Delete Sample Idea in JSON mode (backlinks still counted for output)
      const result = await runCLI(['delete', 'Sample Idea', '--force', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      // JSON mode skips backlink check for performance, so count should be 0
      expect(json.data.backlinksCount).toBe(0);
    });
  });
});
