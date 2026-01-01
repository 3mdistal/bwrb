import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  resolveVaultDir,
  listFilesInDir,
  isDirectory,
  isFile,
  formatValue,
  queryDynamicSource,
  getOutputDir,
} from '../../../src/lib/vault.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import type { Schema } from '../../../src/types/schema.js';

describe('vault', () => {
  let vaultDir: string;
  let schema: Schema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('resolveVaultDir', () => {
    const originalEnv = process.env['PIKA_VAULT'];

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['PIKA_VAULT'] = originalEnv;
      } else {
        delete process.env['PIKA_VAULT'];
      }
    });

    it('should use --vault option first', () => {
      process.env['PIKA_VAULT'] = '/env/path';
      const result = resolveVaultDir({ vault: '/option/path' });
      expect(result).toBe('/option/path');
    });

    it('should use env var if no option', () => {
      process.env['PIKA_VAULT'] = '/env/path';
      const result = resolveVaultDir({});
      expect(result).toBe('/env/path');
    });

    it('should use cwd as fallback', () => {
      delete process.env['PIKA_VAULT'];
      const result = resolveVaultDir({});
      expect(result).toBe(process.cwd());
    });

    it('should preserve relative path from --vault option', () => {
      delete process.env['PIKA_VAULT'];
      const result = resolveVaultDir({ vault: './my-vault' });
      expect(result).toBe('./my-vault');
    });

    it('should preserve relative path from env var', () => {
      process.env['PIKA_VAULT'] = '../other-vault';
      const result = resolveVaultDir({});
      expect(result).toBe('../other-vault');
    });

    it('should preserve dotted relative path', () => {
      delete process.env['PIKA_VAULT'];
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

  describe('queryDynamicSource', () => {
    it('should return matching notes', async () => {
      const results = await queryDynamicSource(schema, vaultDir, 'active_milestones');
      expect(results).toContain('Active Milestone');
      expect(results).not.toContain('Settled Milestone');
    });

    it('should return empty array for unknown source', async () => {
      const results = await queryDynamicSource(schema, vaultDir, 'unknown');
      expect(results).toEqual([]);
    });
  });

  describe('getOutputDir', () => {
    it('should return output_dir for leaf type', () => {
      const dir = getOutputDir(schema, 'idea');
      expect(dir).toBe('Ideas');
    });

    it('should return output_dir for nested type', () => {
      const dir = getOutputDir(schema, 'objective/task');
      expect(dir).toBe('Objectives/Tasks');
    });

    it('should compute default folder for unknown type', () => {
      // Unknown types get auto-pluralized folder names as fallback
      const dir = getOutputDir(schema, 'unknown');
      expect(dir).toBe('unknowns');
    });
  });
});
