import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import {
  validateFieldForType,
  applyFrontmatterFilters,
  type FileWithFrontmatter,
} from '../../../src/lib/query.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import type { Schema } from '../../../src/types/schema.js';

describe('query', () => {
  let vaultDir: string;
  let schema: Schema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('validateFieldForType', () => {
    it('should accept valid fields', () => {
      const result = validateFieldForType(schema, 'idea', 'status');
      expect(result.valid).toBe(true);
    });

    it('should reject unknown fields', () => {
      const result = validateFieldForType(schema, 'idea', 'unknown');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown field');
    });
  });

  describe('applyFrontmatterFilters', () => {
    // Helper to create test files with frontmatter
    const makeFiles = (data: Array<{ path: string; fm: Record<string, unknown> }>): FileWithFrontmatter[] =>
      data.map(d => ({ path: join(vaultDir, d.path), frontmatter: d.fm }));

    it('should filter by where expression for equality', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
        { path: 'c.md', fm: { status: 'active' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'"],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.status)).toEqual(['active', 'active']);
    });

    it('should filter by hyphenated frontmatter keys', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { 'creation-date': '2026-01-28' } },
        { path: 'b.md', fm: { 'creation-date': '2026-01-27' } },
        { path: 'c.md', fm: { status: 'active' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["creation-date == '2026-01-28'"],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter['creation-date']).toBe('2026-01-28');
    });

    it('should filter by where expression for inequality', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
        { path: 'c.md', fm: { status: 'pending' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status != 'done'"],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.status)).toEqual(['active', 'pending']);
    });

    it('should filter by numeric comparison', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { priority: 1 } },
        { path: 'b.md', fm: { priority: 3 } },
        { path: 'c.md', fm: { priority: 2 } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['priority < 3'],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.priority)).toEqual([1, 2]);
    });

    it('should combine multiple where expressions (ANDed)', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active', priority: 1 } },
        { path: 'b.md', fm: { status: 'active', priority: 3 } },
        { path: 'c.md', fm: { status: 'done', priority: 1 } },
        { path: 'd.md', fm: { status: 'active', priority: 2 } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'", 'priority < 3'],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.frontmatter).toEqual({ status: 'active', priority: 1 });
      expect(result[1]?.frontmatter).toEqual({ status: 'active', priority: 2 });
    });

    it('should return empty array when no files match', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'done' } },
        { path: 'b.md', fm: { status: 'done' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'"],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(0);
    });

    it('should return all files when no filters are specified', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: [],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(2);
    });

    it('should preserve original object references', async () => {
      const originalFile = { path: join(vaultDir, 'a.md'), frontmatter: { status: 'active' } };
      const files = [originalFile];

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: [],
        vaultDir,
        silent: true,
      });

      expect(result[0]).toBe(originalFile);
    });

    it('should handle isEmpty function in expressions', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active', deadline: '2025-01-15' } },
        { path: 'b.md', fm: { status: 'active' } },  // no deadline
        { path: 'c.md', fm: { status: 'done', deadline: '' } },  // empty deadline
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['!isEmpty(deadline)'],
        vaultDir,
        silent: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter.deadline).toBe('2025-01-15');
    });
  });
});
