import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFile, mkdir, rm } from 'fs/promises';
import {
  resolveVaultDir,
  listFilesInDir,
  isDirectory,
  isFile,
  formatValue,
  queryByType,
  getOutputDir,
} from '../../../src/lib/vault.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import type { LoadedSchema } from '../../../src/types/schema.js';

describe('vault', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('resolveVaultDir', () => {
    const originalEnv = process.env['BWRB_VAULT'];

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['BWRB_VAULT'] = originalEnv;
      } else {
        delete process.env['BWRB_VAULT'];
      }
    });

    it('should default to fixture vault in tests (regression test for vault isolation)', () => {
      // This test verifies that tests/ts/setup.ts sets BWRB_VAULT to the fixture vault.
      // Without this, tests could accidentally read a developer's real vault.
      // See issue bwrb-smjf.
      const result = resolveVaultDir({});
      expect(result).toContain('tests/ts/fixtures/vault');
    });

    it('should use --vault option first', () => {
      process.env['BWRB_VAULT'] = '/env/path';
      const result = resolveVaultDir({ vault: '/option/path' });
      expect(result).toBe('/option/path');
    });

    it('should use env var if no option', () => {
      process.env['BWRB_VAULT'] = '/env/path';
      const result = resolveVaultDir({});
      expect(result).toBe('/env/path');
    });

    it('should use cwd as fallback', () => {
      delete process.env['BWRB_VAULT'];
      const result = resolveVaultDir({});
      expect(result).toBe(process.cwd());
    });

    it('should preserve relative path from --vault option', () => {
      delete process.env['BWRB_VAULT'];
      const result = resolveVaultDir({ vault: './my-vault' });
      expect(result).toBe('./my-vault');
    });

    it('should preserve relative path from env var', () => {
      process.env['BWRB_VAULT'] = '../other-vault';
      const result = resolveVaultDir({});
      expect(result).toBe('../other-vault');
    });

    it('should preserve dotted relative path', () => {
      delete process.env['BWRB_VAULT'];
      const result = resolveVaultDir({ vault: '../../some/nested/vault' });
      expect(result).toBe('../../some/nested/vault');
    });
  });

  describe('listFilesInDir', () => {
    it('should list .md files in directory', async () => {
      const files = await listFilesInDir(join(vaultDir, 'Ideas'));
      expect(files.length).toBeGreaterThan(0);
      expect(files.every(f => f.endsWith('.md'))).toBe(true);
    });

    it('should return empty array for nonexistent directory', async () => {
      const files = await listFilesInDir('/nonexistent/path');
      expect(files).toEqual([]);
    });
  });

  describe('isDirectory', () => {
    it('should return true for directories', async () => {
      expect(await isDirectory(join(vaultDir, 'Ideas'))).toBe(true);
    });

    it('should return false for files', async () => {
      expect(await isDirectory(join(vaultDir, 'Ideas', 'Sample Idea.md'))).toBe(false);
    });

    it('should return false for nonexistent paths', async () => {
      expect(await isDirectory('/nonexistent/path')).toBe(false);
    });
  });

  describe('isFile', () => {
    it('should return true for files', async () => {
      expect(await isFile(join(vaultDir, 'Ideas', 'Sample Idea.md'))).toBe(true);
    });

    it('should return false for directories', async () => {
      expect(await isFile(join(vaultDir, 'Ideas'))).toBe(false);
    });

    it('should return false for nonexistent paths', async () => {
      expect(await isFile('/nonexistent/path')).toBe(false);
    });
  });

  describe('formatValue', () => {
    it('should return plain value by default', () => {
      expect(formatValue('test', undefined)).toBe('test');
      expect(formatValue('test', 'plain')).toBe('test');
    });

    it('should format as wikilink', () => {
      expect(formatValue('test', 'wikilink')).toBe('[[test]]');
    });

    it('should format as quoted wikilink', () => {
      expect(formatValue('test', 'quoted-wikilink')).toBe('"[[test]]"');
    });

    it('should return empty string for empty value', () => {
      expect(formatValue('', 'wikilink')).toBe('');
    });
  });

  describe('queryByType', () => {
    it('should return notes of the specified type', async () => {
      const results = await queryByType(schema, vaultDir, 'milestone');
      expect(results).toContain('Active Milestone');
      expect(results).toContain('Settled Milestone');
    });

    it('should filter results when filter is provided', async () => {
      const results = await queryByType(schema, vaultDir, 'milestone', {
        status: { not_in: ['settled'] },
      });
      expect(results).toContain('Active Milestone');
      expect(results).not.toContain('Settled Milestone');
    });

    it('should return empty array for unknown type', async () => {
      const results = await queryByType(schema, vaultDir, 'nonexistent_type');
      expect(results).toEqual([]);
    });

    it('should include descendant types', async () => {
      // Query 'objective' should include both tasks and milestones
      const results = await queryByType(schema, vaultDir, 'objective');
      expect(results).toContain('Active Milestone');
      expect(results).toContain('Sample Task');
    });

    it('should sort results alphabetically', async () => {
      const results = await queryByType(schema, vaultDir, 'idea');
      expect(results).toEqual(['Another Idea', 'Sample Idea']);
    });

    it('should exclude owned notes (notes in owner folders)', async () => {
      // Owned notes live in their owner's folder (e.g., Ideas/Sample Idea/tasks/)
      // rather than the type's output_dir (e.g., Objectives/Tasks/).
      // This is by design - owned notes cannot be referenced by other notes.
      
      // Create an "owned" task note inside an idea's folder
      const ownerFolder = join(vaultDir, 'Ideas', 'Sample Idea');
      const ownedTasksFolder = join(ownerFolder, 'tasks');
      await mkdir(ownedTasksFolder, { recursive: true });
      
      const ownedTaskPath = join(ownedTasksFolder, 'Owned Task.md');
      await writeFile(ownedTaskPath, `---
type: task
status: active
---

This task is owned by Sample Idea and should NOT appear in queryByType results.
`);

      try {
        // Query for tasks - should NOT include the owned task
        const results = await queryByType(schema, vaultDir, 'task');
        
        // Should include the regular task in Objectives/Tasks/
        expect(results).toContain('Sample Task');
        
        // Should NOT include the owned task (it's in Ideas/Sample Idea/tasks/, not Objectives/Tasks/)
        expect(results).not.toContain('Owned Task');
      } finally {
        // Cleanup
        await rm(ownedTasksFolder, { recursive: true, force: true });
      }
    });
  });

  describe('getOutputDir', () => {
    it('should return output_dir for leaf type', () => {
      const dir = getOutputDir(schema, 'idea');
      expect(dir).toBe('Ideas');
    });

    it('should return output_dir for nested type', () => {
      const dir = getOutputDir(schema, 'task');
      expect(dir).toBe('Objectives/Tasks');
    });

    it('should compute default folder for unknown type', () => {
      // Unknown types get auto-pluralized folder names as fallback
      const dir = getOutputDir(schema, 'unknown');
      expect(dir).toBe('unknowns');
    });
  });
});
