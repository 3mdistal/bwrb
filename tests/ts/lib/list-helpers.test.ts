import { describe, it, expect } from 'vitest';
import {
  compareByName,
  getSortValue,
  isMissingSortValue,
  normalizeSortValue,
  compareSortValues,
  createFileComparator,
  isFileSortKey,
  type FileStatMap,
  extractNoteName,
  buildParentMap,
  buildChildrenMap,
  collectDescendants,
  buildTree,
  treeHasNestedNotes,
  buildDirectoryTree,
  type FileWithFrontmatter,
} from '../../../src/lib/list-helpers.js';

const VAULT = '/vault';

function file(relPath: string, frontmatter: Record<string, unknown> = {}): FileWithFrontmatter {
  return { path: `${VAULT}/${relPath}`, frontmatter };
}

/** Sort a copy of files with a comparator and return their note names. */
function sortedNames(files: FileWithFrontmatter[], comparator: (a: FileWithFrontmatter, b: FileWithFrontmatter) => number): string[] {
  return [...files]
    .sort(comparator)
    .map(f => f.path.split('/').pop()!.replace(/\.md$/, ''));
}

describe('list-helpers: sort/comparison', () => {
  describe('getSortValue', () => {
    it('returns basename for name and _name', () => {
      const f = file('Projects/Alpha.md', { title: 'x' });
      expect(getSortValue(f, VAULT, 'name')).toBe('Alpha');
      expect(getSortValue(f, VAULT, '_name')).toBe('Alpha');
    });

    it('returns vault-relative path for _path', () => {
      const f = file('Projects/Alpha.md');
      expect(getSortValue(f, VAULT, '_path')).toBe('Projects/Alpha.md');
    });

    it('reads arbitrary fields from frontmatter', () => {
      const f = file('A.md', { priority: 3 });
      expect(getSortValue(f, VAULT, 'priority')).toBe(3);
      expect(getSortValue(f, VAULT, 'missing')).toBeUndefined();
    });

    it('reads file.* stat keys from the provided stat map', () => {
      const f = file('A.md');
      const stats: FileStatMap = new Map([
        [f.path, { mtimeMs: 200, ctimeMs: 100, size: 42 }],
      ]);
      expect(getSortValue(f, VAULT, 'file.mtime', stats)).toBe(200);
      expect(getSortValue(f, VAULT, 'file.ctime', stats)).toBe(100);
      expect(getSortValue(f, VAULT, 'file.size', stats)).toBe(42);
    });

    it('returns undefined for file.* keys when the stat is missing', () => {
      const f = file('A.md');
      expect(getSortValue(f, VAULT, 'file.mtime')).toBeUndefined();
      expect(getSortValue(f, VAULT, 'file.mtime', new Map())).toBeUndefined();
    });
  });

  describe('isFileSortKey', () => {
    it('recognizes the stat-backed file.* keys', () => {
      expect(isFileSortKey('file.mtime')).toBe(true);
      expect(isFileSortKey('file.ctime')).toBe(true);
      expect(isFileSortKey('file.size')).toBe(true);
    });

    it('rejects non-stat keys', () => {
      expect(isFileSortKey('file.name')).toBe(false);
      expect(isFileSortKey('name')).toBe(false);
      expect(isFileSortKey('priority')).toBe(false);
    });
  });

  describe('createFileComparator with file.* stats', () => {
    it('sorts by file.mtime ascending and descending', () => {
      const files = [file('A.md'), file('B.md'), file('C.md')];
      const stats: FileStatMap = new Map([
        [files[0]!.path, { mtimeMs: 300, ctimeMs: 0, size: 0 }],
        [files[1]!.path, { mtimeMs: 100, ctimeMs: 0, size: 0 }],
        [files[2]!.path, { mtimeMs: 200, ctimeMs: 0, size: 0 }],
      ]);

      expect(sortedNames(files, createFileComparator(VAULT, 'file.mtime', false, stats)))
        .toEqual(['B', 'C', 'A']);
      expect(sortedNames(files, createFileComparator(VAULT, 'file.mtime', true, stats)))
        .toEqual(['A', 'C', 'B']);
    });

    it('sorts files with a missing stat to the end', () => {
      const files = [file('A.md'), file('B.md')];
      const stats: FileStatMap = new Map([
        [files[0]!.path, { mtimeMs: 100, ctimeMs: 0, size: 0 }],
        // B.md has no stat entry -> treated as missing -> sorts last
      ]);
      expect(sortedNames(files, createFileComparator(VAULT, 'file.mtime', false, stats)))
        .toEqual(['A', 'B']);
      // Even descending, missing stays last.
      expect(sortedNames(files, createFileComparator(VAULT, 'file.mtime', true, stats)))
        .toEqual(['A', 'B']);
    });
  });

  describe('isMissingSortValue', () => {
    it('treats undefined, null, empty string, and empty array as missing', () => {
      expect(isMissingSortValue(undefined)).toBe(true);
      expect(isMissingSortValue(null)).toBe(true);
      expect(isMissingSortValue('')).toBe(true);
      expect(isMissingSortValue([])).toBe(true);
    });

    it('treats present values as not missing', () => {
      expect(isMissingSortValue(0)).toBe(false);
      expect(isMissingSortValue(false)).toBe(false);
      expect(isMissingSortValue('x')).toBe(false);
      expect(isMissingSortValue(['a'])).toBe(false);
    });
  });

  describe('normalizeSortValue', () => {
    it('passes numbers and booleans through', () => {
      expect(normalizeSortValue(5)).toBe(5);
      expect(normalizeSortValue(true)).toBe(true);
    });

    it('joins arrays with ", "', () => {
      expect(normalizeSortValue(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('stringifies other values', () => {
      expect(normalizeSortValue('hello')).toBe('hello');
      const date = new Date('2024-01-01T00:00:00Z');
      expect(normalizeSortValue(date)).toBe(String(date));
    });
  });

  describe('compareSortValues', () => {
    it('compares numbers numerically', () => {
      expect(compareSortValues(2, 10)).toBeLessThan(0);
      expect(compareSortValues(10, 2)).toBeGreaterThan(0);
      expect(compareSortValues(5, 5)).toBe(0);
    });

    it('compares booleans by truthiness (false < true)', () => {
      expect(compareSortValues(false, true)).toBeLessThan(0);
      expect(compareSortValues(true, false)).toBeGreaterThan(0);
    });

    it('compares strings with numeric sensitivity', () => {
      // "2" before "10" thanks to numeric collation
      expect(compareSortValues('2', '10')).toBeLessThan(0);
    });

    it('compares date strings lexically (ISO sorts chronologically)', () => {
      expect(compareSortValues('2024-01-01', '2024-12-31')).toBeLessThan(0);
      expect(compareSortValues('2024-12-31', '2024-01-01')).toBeGreaterThan(0);
    });

    it('is case-insensitive (base sensitivity)', () => {
      expect(compareSortValues('apple', 'Apple')).toBe(0);
    });
  });

  describe('createFileComparator', () => {
    it('sorts by name when no sort field given', () => {
      const files = [file('Charlie.md'), file('alpha.md'), file('Bravo.md')];
      expect(sortedNames(files, createFileComparator(VAULT, undefined, undefined)))
        .toEqual(['alpha', 'Bravo', 'Charlie']);
    });

    it('sorts ascending by a numeric field', () => {
      const files = [
        file('A.md', { priority: 3 }),
        file('B.md', { priority: 1 }),
        file('C.md', { priority: 2 }),
      ];
      expect(sortedNames(files, createFileComparator(VAULT, 'priority', false)))
        .toEqual(['B', 'C', 'A']);
    });

    it('sorts descending by a numeric field', () => {
      const files = [
        file('A.md', { priority: 3 }),
        file('B.md', { priority: 1 }),
        file('C.md', { priority: 2 }),
      ];
      expect(sortedNames(files, createFileComparator(VAULT, 'priority', true)))
        .toEqual(['A', 'C', 'B']);
    });

    it('sorts by date field chronologically', () => {
      const files = [
        file('A.md', { deadline: '2024-06-01' }),
        file('B.md', { deadline: '2024-01-15' }),
        file('C.md', { deadline: '2024-12-31' }),
      ];
      expect(sortedNames(files, createFileComparator(VAULT, 'deadline', false)))
        .toEqual(['B', 'A', 'C']);
    });

    it('sorts by string field', () => {
      const files = [
        file('A.md', { status: 'done' }),
        file('B.md', { status: 'active' }),
        file('C.md', { status: 'blocked' }),
      ];
      expect(sortedNames(files, createFileComparator(VAULT, 'status', false)))
        .toEqual(['B', 'C', 'A']);
    });

    it('always sorts missing values last, even when descending', () => {
      const asc = [
        file('A.md', { priority: 2 }),
        file('B.md', {}),
        file('C.md', { priority: 1 }),
      ];
      expect(sortedNames(asc, createFileComparator(VAULT, 'priority', false)))
        .toEqual(['C', 'A', 'B']);

      const desc = [
        file('A.md', { priority: 2 }),
        file('B.md', {}),
        file('C.md', { priority: 1 }),
      ];
      expect(sortedNames(desc, createFileComparator(VAULT, 'priority', true)))
        .toEqual(['A', 'C', 'B']);
    });

    it('breaks ties by name (ascending) regardless of direction', () => {
      const files = [
        file('Charlie.md', { priority: 1 }),
        file('alpha.md', { priority: 1 }),
        file('Bravo.md', { priority: 1 }),
      ];
      // Equal priority -> tiebreak by name ascending
      expect(sortedNames(files, createFileComparator(VAULT, 'priority', false)))
        .toEqual(['alpha', 'Bravo', 'Charlie']);
      expect(sortedNames(files, createFileComparator(VAULT, 'priority', true)))
        .toEqual(['alpha', 'Bravo', 'Charlie']);
    });

    it('breaks ties by name when both values are missing', () => {
      const files = [file('Beta.md', {}), file('Alpha.md', {})];
      expect(sortedNames(files, createFileComparator(VAULT, 'priority', false)))
        .toEqual(['Alpha', 'Beta']);
    });
  });

  describe('compareByName', () => {
    it('orders by basename case-insensitively', () => {
      expect(compareByName(file('apple.md'), file('Banana.md'))).toBeLessThan(0);
    });
  });
});

describe('list-helpers: hierarchy/tree', () => {
  describe('extractNoteName', () => {
    it('extracts the target from a wikilink', () => {
      expect(extractNoteName('[[Project Alpha]]')).toBe('Project Alpha');
    });

    it('returns trimmed plain text', () => {
      expect(extractNoteName('  Plain Name  ')).toBe('Plain Name');
    });

    it('returns null for empty input', () => {
      expect(extractNoteName('')).toBeNull();
      expect(extractNoteName('   ')).toBeNull();
    });
  });

  describe('buildParentMap', () => {
    it('maps note name to parent name from frontmatter (wikilink and plain)', () => {
      const files = [
        file('Child A.md', { parent: '[[Root]]' }),
        file('Child B.md', { parent: 'Root' }),
        file('Root.md', {}),
      ];
      const map = buildParentMap(files);
      expect(map.get('Child A')).toBe('Root');
      expect(map.get('Child B')).toBe('Root');
      expect(map.has('Root')).toBe(false);
    });

    it('ignores notes without a parent value', () => {
      const map = buildParentMap([file('Solo.md', {})]);
      expect(map.size).toBe(0);
    });
  });

  describe('buildChildrenMap', () => {
    it('inverts a parent map into parent -> set of children', () => {
      const parentMap = new Map<string, string>([
        ['A', 'Root'],
        ['B', 'Root'],
        ['C', 'A'],
      ]);
      const children = buildChildrenMap(parentMap);
      expect([...children.get('Root')!].sort()).toEqual(['A', 'B']);
      expect([...children.get('A')!]).toEqual(['C']);
    });
  });

  describe('collectDescendants', () => {
    const childrenMap = new Map<string, Set<string>>([
      ['Root', new Set(['A', 'B'])],
      ['A', new Set(['A1'])],
      ['A1', new Set(['A1a'])],
    ]);

    it('collects all descendants unbounded', () => {
      expect([...collectDescendants('Root', childrenMap)].sort())
        .toEqual(['A', 'A1', 'A1a', 'B']);
    });

    it('respects maxDepth', () => {
      expect([...collectDescendants('Root', childrenMap, 1)].sort()).toEqual(['A', 'B']);
      expect([...collectDescendants('Root', childrenMap, 2)].sort()).toEqual(['A', 'A1', 'B']);
    });

    it('returns empty set for a leaf', () => {
      expect(collectDescendants('A1a', childrenMap).size).toBe(0);
    });
  });

  describe('buildTree', () => {
    it('nests children under parents and identifies roots', () => {
      const files = [
        file('Root.md', {}),
        file('Child.md', { parent: '[[Root]]' }),
        file('Grandchild.md', { parent: '[[Child]]' }),
      ];
      const tree = buildTree(files, buildParentMap(files));
      expect(tree).toHaveLength(1);
      expect(tree[0]!.name).toBe('Root');
      expect(tree[0]!.depth).toBe(0);
      expect(tree[0]!.children.map(c => c.name)).toEqual(['Child']);
      expect(tree[0]!.children[0]!.depth).toBe(1);
      expect(tree[0]!.children[0]!.children[0]!.name).toBe('Grandchild');
      expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
    });

    it('treats notes whose parent is absent from the set as roots (orphans)', () => {
      const files = [file('Orphan.md', { parent: '[[Missing]]' })];
      const tree = buildTree(files, buildParentMap(files));
      expect(tree.map(n => n.name)).toEqual(['Orphan']);
    });

    it('sorts roots and children by the provided comparator', () => {
      const files = [
        file('Root.md', {}),
        file('Zeta.md', { parent: '[[Root]]' }),
        file('Alpha.md', { parent: '[[Root]]' }),
      ];
      const tree = buildTree(files, buildParentMap(files));
      expect(tree[0]!.children.map(c => c.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('sorts multiple roots by comparator', () => {
      const files = [file('Zed.md', {}), file('Ann.md', {})];
      const tree = buildTree(files, buildParentMap(files));
      expect(tree.map(n => n.name)).toEqual(['Ann', 'Zed']);
    });

    it('prunes nodes beyond maxDepth', () => {
      const files = [
        file('Root.md', {}),
        file('Child.md', { parent: '[[Root]]' }),
        file('Grandchild.md', { parent: '[[Child]]' }),
      ];
      const tree = buildTree(files, buildParentMap(files), 2);
      expect(tree[0]!.children[0]!.name).toBe('Child');
      // Depth limit of 2 means grandchildren are pruned
      expect(tree[0]!.children[0]!.children).toEqual([]);
    });
  });

  describe('treeHasNestedNotes', () => {
    it('returns false for a flat list of roots', () => {
      const files = [file('A.md', {}), file('B.md', {})];
      expect(treeHasNestedNotes(buildTree(files, buildParentMap(files)))).toBe(false);
    });

    it('returns true when any node has children', () => {
      const files = [file('Root.md', {}), file('Child.md', { parent: '[[Root]]' })];
      expect(treeHasNestedNotes(buildTree(files, buildParentMap(files)))).toBe(true);
    });
  });

  describe('buildDirectoryTree', () => {
    it('groups notes under their directory segments', () => {
      const files = [
        file('Projects/Alpha.md'),
        file('Projects/Beta.md'),
        file('Ideas/Spark.md'),
      ];
      const tree = buildDirectoryTree(files, VAULT);
      // Directories sorted alphabetically: Ideas before Projects
      expect(tree.map(d => d.name)).toEqual(['Ideas', 'Projects']);
      const projects = tree.find(d => d.name === 'Projects')!;
      expect(projects.notes.map(n => n.frontmatter._displayName)).toEqual(['Alpha', 'Beta']);
    });

    it('nests subdirectories and records relative paths', () => {
      const files = [file('Projects/Web/Site.md')];
      const tree = buildDirectoryTree(files, VAULT);
      const projects = tree[0]!;
      expect(projects.name).toBe('Projects');
      const web = projects.directories[0]!;
      expect(web.name).toBe('Web');
      expect(web.notes[0]!.frontmatter._relativePath).toBe('Projects/Web/Site.md');
    });

    it('sorts notes within a directory by comparator', () => {
      const files = [
        file('Dir/charlie.md'),
        file('Dir/alpha.md'),
        file('Dir/Bravo.md'),
      ];
      const tree = buildDirectoryTree(files, VAULT);
      expect(tree[0]!.notes.map(n => n.frontmatter._displayName))
        .toEqual(['alpha', 'Bravo', 'charlie']);
    });

    it('respects maxDepth by keeping notes at the truncation boundary', () => {
      const files = [file('A/B/C/Deep.md')];
      const tree = buildDirectoryTree(files, VAULT, 1);
      // Only the first directory level is created; the note lands there.
      expect(tree[0]!.name).toBe('A');
      expect(tree[0]!.directories).toEqual([]);
      expect(tree[0]!.notes).toHaveLength(1);
    });
  });
});
