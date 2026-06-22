import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { writeFile, rm } from 'fs/promises';
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
      });

      expect(result).toHaveLength(2);
    });

    it('should preserve original object references', async () => {
      const originalFile = { path: join(vaultDir, 'a.md'), frontmatter: { status: 'active' } };
      const files = [originalFile];

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: [],
        vaultDir,
      });

      expect(result[0]).toBe(originalFile);
    });

    it('should handle isEmpty function in expressions', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active', deadline: '2025-01-15' } },
        { path: 'b.md', fm: { status: 'active' } },
        { path: 'c.md', fm: { status: 'done', deadline: '' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['!isEmpty(deadline)'],
        vaultDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter.deadline).toBe('2025-01-15');
    });

    it('should treat parent-like relation fields as hierarchy for isRoot()', async () => {
      const files = makeFiles([
        { path: 'Objectives/Tasks/Standalone Task.md', fm: { type: 'task', status: 'raw' } },
        {
          path: 'Objectives/Tasks/Child Task.md',
          fm: { type: 'task', status: 'raw', milestone: '"[[Alpha Release]]"' },
        },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['isRoot()'],
        vaultDir,
        schema,
        typePath: 'task',
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.path).toContain('Standalone Task.md');
    });

    describe('under() operator (full-vault relation-target resolution)', () => {
      // Build a context hierarchy out of recursive `task` notes so they live in
      // the vault and are discoverable by the full-vault augmentation pass:
      //   career (root)
      //     └── Builder
      //           └── Vercel
      const contextNotes: string[] = [];

      beforeAll(async () => {
        const write = async (name: string, parent: string | null) => {
          const path = join(vaultDir, 'Objectives/Tasks', `${name}.md`);
          const parentLine = parent ? `\nparent: "[[${parent}]]"` : '';
          await writeFile(
            path,
            `---\ntype: task\nstatus: backlog${parentLine}\n---\n`
          );
          contextNotes.push(path);
        };
        await write('career', null);
        await write('Builder', 'career');
        await write('Vercel', 'Builder');
      });

      afterAll(async () => {
        await Promise.all(contextNotes.map(p => rm(p, { force: true })));
      });

      it('matches a note whose relation target is a deep descendant of the node', async () => {
        // Candidate task has NO parent of its own; its `milestone` relation
        // points at Vercel, which is under career via Builder.
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Vercel]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(1);
      });

      it('does not match when the relation target is not under the node', async () => {
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[career]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[Builder]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(0);
      });

      it('is distinct from isDescendantOf — relation chain vs the note\'s own chain', async () => {
        // The candidate has no parent, so isDescendantOf('[[career]]') is false,
        // but under(milestone, '[[career]]') follows the relation and is true.
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Vercel]]"' } },
        ]);

        const descResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(descResult).toHaveLength(0);

        const underResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(underResult).toHaveLength(1);
      });

      it('does not match (and does not crash) on a dangling relation target', async () => {
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Ghost]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(0);
      });
    });

    it('should throw on invalid expression syntax', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
      ]);

      await expect(
        applyFrontmatterFilters(files, {
          whereExpressions: ["status == 'active' &&"],
          vaultDir,
        })
      ).rejects.toThrow(/Expression error in/);
    });

    it('should throw on expression runtime errors', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
      ]);

      await expect(
        applyFrontmatterFilters(files, {
          whereExpressions: ['missingFn(status)'],
          vaultDir,
        })
      ).rejects.toThrow(/Unknown function: missingFn/);
    });
  });
});
