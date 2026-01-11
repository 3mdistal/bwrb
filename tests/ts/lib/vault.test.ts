import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { join, relative } from 'path';
import { writeFile, mkdir, rm, mkdtemp, realpath } from 'fs/promises';
import { tmpdir } from 'os';
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
    const originalCwd = process.cwd();

    afterEach(() => {
      process.chdir(originalCwd);

      if (originalEnv !== undefined) {
        process.env['BWRB_VAULT'] = originalEnv;
      } else {
        delete process.env['BWRB_VAULT'];
      }
    });

    it('should default to test fixture vault via BWRB_VAULT (regression test for vault isolation)', () => {
      // tests/ts/setup.ts pins BWRB_VAULT to a fixture vault as a safety net.
      const result = resolveVaultDir({});
      expect(result).toContain('tests/fixtures/vault');
    });

    it('should prefer --vault over find-up and env', async () => {
      const optionVaultDir = await createTestVault();
      try {
        process.env['BWRB_VAULT'] = vaultDir;
        process.chdir(join(vaultDir, 'Ideas'));

        const relativeOptionVault = relative(process.cwd(), optionVaultDir);
        const result = resolveVaultDir({ vault: relativeOptionVault });
        expect(result).toBe(relativeOptionVault);
      } finally {
        await cleanupTestVault(optionVaultDir);
      }
    });

    it('should use find-up when running under a vault', async () => {
      process.env['BWRB_VAULT'] = vaultDir;
      process.chdir(join(vaultDir, 'Ideas'));

      const result = resolveVaultDir({});
      expect(result).toBe(await realpath(vaultDir));
    });

    it('should resolve to nearest nested vault', async () => {
      const nestedVaultDir = join(vaultDir, 'nested-vault');
      await mkdir(join(nestedVaultDir, '.bwrb'), { recursive: true });
      await writeFile(join(nestedVaultDir, '.bwrb', 'schema.json'), '{}');

      try {
        process.chdir(join(nestedVaultDir, '.bwrb'));
        const result = resolveVaultDir({});
        expect(result).toBe(await realpath(nestedVaultDir));
      } finally {
        await rm(nestedVaultDir, { recursive: true, force: true });
      }
    });

    it('should use env var if find-up fails', async () => {
      const nonVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-nonvault-'));
      try {
        process.chdir(nonVaultDir);
        process.env['BWRB_VAULT'] = vaultDir;

        const result = resolveVaultDir({});
        expect(result).toBe(vaultDir);
      } finally {
        await rm(nonVaultDir, { recursive: true, force: true });
      }
    });

    it('should preserve relative path from --vault option', async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'bwrb-rel-vault-'));
      try {
        const relativeVault = './my-vault';

        await mkdir(join(baseDir, 'my-vault', '.bwrb'), { recursive: true });
        await writeFile(join(baseDir, 'my-vault', '.bwrb', 'schema.json'), '{}');

        process.chdir(baseDir);
        delete process.env['BWRB_VAULT'];

        const result = resolveVaultDir({ vault: relativeVault });
        expect(result).toBe(relativeVault);
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });

    it('should preserve relative path from env var', async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'bwrb-rel-env-'));
      try {
        await mkdir(join(baseDir, 'other-vault', '.bwrb'), { recursive: true });
        await writeFile(join(baseDir, 'other-vault', '.bwrb', 'schema.json'), '{}');

        await mkdir(join(baseDir, 'work'), { recursive: true });
        process.chdir(join(baseDir, 'work'));
        process.env['BWRB_VAULT'] = '../other-vault';

        const result = resolveVaultDir({});
        expect(result).toBe('../other-vault');
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });

    it('should error when --vault does not contain a schema', async () => {
      const nonVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-bad-vault-'));
      try {
        expect(() => resolveVaultDir({ vault: nonVaultDir })).toThrow(/Invalid --vault path/);
        expect(() => resolveVaultDir({ vault: nonVaultDir })).toThrow(/\.bwrb\/schema\.json/);
      } finally {
        await rm(nonVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when BWRB_VAULT is invalid and find-up fails', async () => {
      const nonVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-bad-env-'));
      const cwdDir = await mkdtemp(join(tmpdir(), 'bwrb-bad-env-cwd-'));
      try {
        process.chdir(cwdDir);
        process.env['BWRB_VAULT'] = nonVaultDir;

        expect(() => resolveVaultDir({})).toThrow(/Invalid BWRB_VAULT/);
      } finally {
        await rm(nonVaultDir, { recursive: true, force: true });
        await rm(cwdDir, { recursive: true, force: true });
      }
    });

    it('should error with helpful message when no vault can be resolved', async () => {
      const nonVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-no-vault-'));
      try {
        process.chdir(nonVaultDir);
        delete process.env['BWRB_VAULT'];

        expect(() => resolveVaultDir({})).toThrow(/searched upward/);
        expect(() => resolveVaultDir({})).toThrow(/\.bwrb\/schema\.json/);
        expect(() => resolveVaultDir({})).toThrow(/--vault/);
        expect(() => resolveVaultDir({})).toThrow(/bwrb init/);
      } finally {
        await rm(nonVaultDir, { recursive: true, force: true });
      }
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
    it('should format as wikilink by default', () => {
      // Default is now wikilink (quoted for YAML safety)
      expect(formatValue('test')).toBe('"[[test]]"');
      expect(formatValue('test', 'wikilink')).toBe('"[[test]]"');
    });

    it('should format as markdown link', () => {
      expect(formatValue('test', 'markdown')).toBe('"[test](test.md)"');
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
