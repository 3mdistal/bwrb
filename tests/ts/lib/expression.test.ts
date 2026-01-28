import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import {
  parseExpression,
  evaluateExpression,
  matchesExpression,
  parseDuration,
  buildEvalContext,
  type EvalContext,
} from '../../../src/lib/expression.js';
import { normalizeWhereExpression } from '../../../src/lib/where-normalize.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';

describe('expression', () => {
  const makeContext = (frontmatter: Record<string, unknown>): EvalContext => ({
    frontmatter,
    file: {
      name: 'Test File',
      path: 'Ideas/Test File.md',
      folder: 'Ideas',
      ext: '.md',
    },
  });

  describe('parseExpression', () => {
    it('should parse simple comparison', () => {
      const expr = parseExpression("status == 'done'");
      expect(expr.type).toBe('BinaryExpression');
    });

    it('should parse boolean expressions', () => {
      const expr = parseExpression("a && b || c");
      expect(expr.type).toBe('BinaryExpression');
    });

    it('should parse function calls', () => {
      const expr = parseExpression("isEmpty(status)");
      expect(expr.type).toBe('CallExpression');
    });

    it('should throw on invalid syntax', () => {
      expect(() => parseExpression("status ==")).toThrow();
    });
  });

  describe('evaluateExpression - comparisons', () => {
    it('should evaluate equality', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status == 'done'", ctx)).toBe(true);
      expect(matchesExpression("status == 'pending'", ctx)).toBe(false);
    });

    it('should evaluate hyphenated keys after normalization', () => {
      const ctx = makeContext({ 'creation-date': '2026-01-28' });
      const normalized = normalizeWhereExpression(
        "creation-date == '2026-01-28'",
        new Set(['creation-date'])
      );
      expect(matchesExpression(normalized, ctx)).toBe(true);
    });

    it('should evaluate inequality', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status != 'pending'", ctx)).toBe(true);
      expect(matchesExpression("status != 'done'", ctx)).toBe(false);
    });

    it('should evaluate numeric comparisons', () => {
      const ctx = makeContext({ priority: 2 });
      expect(matchesExpression("priority < 3", ctx)).toBe(true);
      expect(matchesExpression("priority > 1", ctx)).toBe(true);
      expect(matchesExpression("priority <= 2", ctx)).toBe(true);
      expect(matchesExpression("priority >= 2", ctx)).toBe(true);
      expect(matchesExpression("priority < 2", ctx)).toBe(false);
    });
  });

  describe('evaluateExpression - boolean logic', () => {
    it('should evaluate AND', () => {
      const ctx = makeContext({ status: 'done', priority: 1 });
      expect(matchesExpression("status == 'done' && priority == 1", ctx)).toBe(true);
      expect(matchesExpression("status == 'done' && priority == 2", ctx)).toBe(false);
    });

    it('should evaluate OR', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status == 'done' || status == 'pending'", ctx)).toBe(true);
      expect(matchesExpression("status == 'open' || status == 'pending'", ctx)).toBe(false);
    });

    it('should evaluate NOT', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("!isEmpty(status)", ctx)).toBe(true);
      expect(matchesExpression("!(status == 'done')", ctx)).toBe(false);
    });
  });

  describe('evaluateExpression - functions', () => {
    it('should evaluate contains for strings', () => {
      const ctx = makeContext({ title: 'Hello World' });
      expect(matchesExpression("contains(title, 'World')", ctx)).toBe(true);
      expect(matchesExpression("contains(title, 'Foo')", ctx)).toBe(false);
    });

    it('should evaluate contains for arrays', () => {
      const ctx = makeContext({ tags: ['urgent', 'bug'] });
      expect(matchesExpression("contains(tags, 'urgent')", ctx)).toBe(true);
      expect(matchesExpression("contains(tags, 'feature')", ctx)).toBe(false);
    });

    it('should evaluate isEmpty', () => {
      expect(matchesExpression("isEmpty(status)", makeContext({}))).toBe(true);
      expect(matchesExpression("isEmpty(status)", makeContext({ status: '' }))).toBe(true);
      expect(matchesExpression("isEmpty(tags)", makeContext({ tags: [] }))).toBe(true);
      expect(matchesExpression("isEmpty(status)", makeContext({ status: 'done' }))).toBe(false);
    });

    it('should evaluate isEmpty for hyphenated keys after normalization', () => {
      const ctx = makeContext({ 'creation-date': '' });
      const normalized = normalizeWhereExpression(
        'isEmpty(creation-date)',
        new Set(['creation-date'])
      );
      expect(matchesExpression(normalized, ctx)).toBe(true);
    });

    it('should evaluate startsWith and endsWith', () => {
      const ctx = makeContext({ title: 'WIP: Feature' });
      expect(matchesExpression("startsWith(title, 'WIP')", ctx)).toBe(true);
      expect(matchesExpression("endsWith(title, 'Feature')", ctx)).toBe(true);
    });

    it('should evaluate today()', () => {
      const ctx = makeContext({});
      const expr = parseExpression("today()");
      const result = evaluateExpression(expr, ctx);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should evaluate hasTag', () => {
      const ctx = makeContext({ tags: ['urgent', 'bug'] });
      expect(matchesExpression("hasTag('urgent')", ctx)).toBe(true);
      expect(matchesExpression("hasTag('feature')", ctx)).toBe(false);
    });
  });

  describe('parseDuration', () => {
    it('should parse day durations', () => {
      expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseDuration("'7d'")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse week durations', () => {
      expect(parseDuration('1w')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse hour durations', () => {
      expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('should return null for invalid durations', () => {
      expect(parseDuration('invalid')).toBeNull();
      expect(parseDuration('7')).toBeNull();
    });
  });

  describe('date arithmetic', () => {
    it('should compare dates', () => {
      const ctx = makeContext({ deadline: '2025-01-01' });
      expect(matchesExpression("deadline < '2025-01-15'", ctx)).toBe(true);
      expect(matchesExpression("deadline > '2024-12-01'", ctx)).toBe(true);
    });
  });

  describe('member expressions', () => {
    it('should access file properties', () => {
      const ctx = makeContext({});
      expect(matchesExpression("file.folder == 'Ideas'", ctx)).toBe(true);
      expect(matchesExpression("file.name == 'Test File'", ctx)).toBe(true);
    });

    it('should access nested frontmatter', () => {
      const ctx = makeContext({ metadata: { author: 'alice' } });
      expect(matchesExpression("metadata.author == 'alice'", ctx)).toBe(true);
    });
  });

  describe('complex expressions', () => {
    it('should handle complex boolean logic', () => {
      const ctx = makeContext({ status: 'in-progress', priority: 1, deadline: '2025-01-15' });
      expect(matchesExpression(
        "(status == 'in-progress' || status == 'backlog') && priority < 3",
        ctx
      )).toBe(true);
    });

    it('should handle combined function calls', () => {
      const ctx = makeContext({ status: 'done', tags: ['complete'] });
      expect(matchesExpression(
        "status == 'done' && !isEmpty(tags)",
        ctx
      )).toBe(true);
    });
  });

  describe('hierarchy functions', () => {
    // Helper to create context with hierarchy data
    const makeHierarchyContext = (
      fileName: string,
      parentMap: Map<string, string>,
      childrenMap: Map<string, Set<string>>
    ): EvalContext => ({
      frontmatter: {},
      file: {
        name: fileName,
        path: `Tasks/${fileName}.md`,
        folder: 'Tasks',
        ext: '.md',
      },
      hierarchyData: { parentMap, childrenMap },
    });

    // Build a simple hierarchy:
    // Epic (root)
    //   ├── Feature A
    //   │     └── Task 1
    //   └── Feature B
    //         └── Task 2
    const parentMap = new Map([
      ['Feature A', 'Epic'],
      ['Feature B', 'Epic'],
      ['Task 1', 'Feature A'],
      ['Task 2', 'Feature B'],
    ]);

    const childrenMap = new Map([
      ['Epic', new Set(['Feature A', 'Feature B'])],
      ['Feature A', new Set(['Task 1'])],
      ['Feature B', new Set(['Task 2'])],
    ]);

    describe('isRoot()', () => {
      it('should return true for notes with no parent', () => {
        const ctx = makeHierarchyContext('Epic', parentMap, childrenMap);
        expect(matchesExpression('isRoot()', ctx)).toBe(true);
      });

      it('should return false for notes with a parent', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression('isRoot()', ctx)).toBe(false);
      });

      it('should return false when hierarchyData is missing', () => {
        const ctx: EvalContext = {
          frontmatter: {},
          file: { name: 'Epic', path: 'Epic.md', folder: '', ext: '.md' },
        };
        expect(matchesExpression('isRoot()', ctx)).toBe(false);
      });
    });

    describe('isChildOf()', () => {
      it('should return true for direct children', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression("isChildOf('[[Epic]]')", ctx)).toBe(true);
      });

      it('should return false for non-children', () => {
        const ctx = makeHierarchyContext('Task 1', parentMap, childrenMap);
        // Task 1's parent is Feature A, not Epic
        expect(matchesExpression("isChildOf('[[Epic]]')", ctx)).toBe(false);
      });

      it('should return false for root notes', () => {
        const ctx = makeHierarchyContext('Epic', parentMap, childrenMap);
        expect(matchesExpression("isChildOf('[[Feature A]]')", ctx)).toBe(false);
      });

      it('should handle plain text argument without wikilink', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression("isChildOf('Epic')", ctx)).toBe(true);
      });

      it('should return false when hierarchyData is missing', () => {
        const ctx: EvalContext = {
          frontmatter: {},
          file: { name: 'Feature A', path: 'Feature A.md', folder: '', ext: '.md' },
        };
        expect(matchesExpression("isChildOf('[[Epic]]')", ctx)).toBe(false);
      });
    });

    describe('isDescendantOf()', () => {
      it('should return true for direct children', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('[[Epic]]')", ctx)).toBe(true);
      });

      it('should return true for grandchildren', () => {
        const ctx = makeHierarchyContext('Task 1', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('[[Epic]]')", ctx)).toBe(true);
      });

      it('should return false for non-descendants', () => {
        const ctx = makeHierarchyContext('Epic', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('[[Feature A]]')", ctx)).toBe(false);
      });

      it('should return false for siblings', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('[[Feature B]]')", ctx)).toBe(false);
      });

      it('should return false for cousins', () => {
        const ctx = makeHierarchyContext('Task 1', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('[[Feature B]]')", ctx)).toBe(false);
      });

      it('should handle plain text argument without wikilink', () => {
        const ctx = makeHierarchyContext('Task 1', parentMap, childrenMap);
        expect(matchesExpression("isDescendantOf('Epic')", ctx)).toBe(true);
      });

      it('should return false when hierarchyData is missing', () => {
        const ctx: EvalContext = {
          frontmatter: {},
          file: { name: 'Task 1', path: 'Task 1.md', folder: '', ext: '.md' },
        };
        expect(matchesExpression("isDescendantOf('[[Epic]]')", ctx)).toBe(false);
      });

      it('should handle cyclic parent references without infinite loop', () => {
        // Create a cycle: A -> B -> C -> A
        const cyclicParentMap = new Map([
          ['Note A', 'Note C'],
          ['Note B', 'Note A'],
          ['Note C', 'Note B'],
        ]);
        const cyclicChildrenMap = new Map([
          ['Note A', new Set(['Note B'])],
          ['Note B', new Set(['Note C'])],
          ['Note C', new Set(['Note A'])],
        ]);
        const ctx = makeHierarchyContext('Note A', cyclicParentMap, cyclicChildrenMap);
        // Should return false (not find 'NonExistent') without hanging
        expect(matchesExpression("isDescendantOf('[[NonExistent]]')", ctx)).toBe(false);
      });
    });

    describe('hierarchy functions composability', () => {
      it('should combine with other expressions using AND', () => {
        const ctx: EvalContext = {
          ...makeHierarchyContext('Task 1', parentMap, childrenMap),
          frontmatter: { status: 'done' },
        };
        expect(matchesExpression("isDescendantOf('[[Epic]]') && status == 'done'", ctx)).toBe(true);
        expect(matchesExpression("isDescendantOf('[[Epic]]') && status == 'pending'", ctx)).toBe(false);
      });

      it('should combine with other expressions using OR', () => {
        const ctx = {
          ...makeHierarchyContext('Epic', parentMap, childrenMap),
          frontmatter: { status: 'done' },
        };
        expect(matchesExpression("isRoot() || status == 'pending'", ctx)).toBe(true);
      });

      it('should work with NOT', () => {
        const ctx = makeHierarchyContext('Feature A', parentMap, childrenMap);
        expect(matchesExpression('!isRoot()', ctx)).toBe(true);
      });
    });
  });

  describe('buildEvalContext', () => {
    let vaultDir: string;
    let testFilePath: string;

    beforeAll(async () => {
      vaultDir = await createTestVault();
      // Create a test file for the buildEvalContext tests
      const notesDir = join(vaultDir, 'Notes');
      await mkdir(notesDir, { recursive: true });
      testFilePath = join(notesDir, 'Test Note.md');
      await writeFile(testFilePath, '---\nstatus: active\n---\nContent');
    });

    afterAll(async () => {
      await cleanupTestVault(vaultDir);
    });

    it('should build context with file metadata', async () => {
      const frontmatter = { status: 'active', priority: 1 };
      const ctx = await buildEvalContext(testFilePath, vaultDir, frontmatter);

      expect(ctx.frontmatter).toBe(frontmatter);
      expect(ctx.file?.name).toBe('Test Note');
      expect(ctx.file?.path).toBe('Notes/Test Note.md');
      expect(ctx.file?.folder).toBe('Notes');
      expect(ctx.file?.ext).toBe('.md');
    });

    it('should include file stats when file exists', async () => {
      const ctx = await buildEvalContext(testFilePath, vaultDir, {});

      expect(ctx.file?.size).toBeGreaterThan(0);
      expect(ctx.file?.ctime).toBeInstanceOf(Date);
      expect(ctx.file?.mtime).toBeInstanceOf(Date);
    });

    it('should handle non-existent files gracefully', async () => {
      const nonExistentPath = join(vaultDir, 'Does Not Exist.md');
      const ctx = await buildEvalContext(nonExistentPath, vaultDir, { test: true });

      expect(ctx.frontmatter).toEqual({ test: true });
      expect(ctx.file?.name).toBe('Does Not Exist');
      expect(ctx.file?.path).toBe('Does Not Exist.md');
      // Stats should be undefined for non-existent files
      expect(ctx.file?.size).toBeUndefined();
    });

    it('should work with nested folders', async () => {
      const nestedPath = join(vaultDir, 'Projects', 'Active', 'My Task.md');
      const ctx = await buildEvalContext(nestedPath, vaultDir, {});

      expect(ctx.file?.name).toBe('My Task');
      expect(ctx.file?.path).toBe('Projects/Active/My Task.md');
      expect(ctx.file?.folder).toBe('Projects/Active');
    });

    it('should produce context usable with matchesExpression', async () => {
      const frontmatter = { status: 'done', priority: 1 };
      const ctx = await buildEvalContext(testFilePath, vaultDir, frontmatter);

      expect(matchesExpression("status == 'done'", ctx)).toBe(true);
      expect(matchesExpression("priority < 3", ctx)).toBe(true);
      expect(matchesExpression("file.folder == 'Notes'", ctx)).toBe(true);
    });
  });
});
