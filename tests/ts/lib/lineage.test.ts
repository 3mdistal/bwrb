import { describe, expect, it } from 'vitest';
import {
  buildLineageMaps,
  collectLineage,
  DuplicateLineageIdError,
} from '../../../src/lib/lineage.js';
import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from '../../../src/lib/discovery.js';

const A = 'abcdef12-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = 'eeeeeeee-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';

function note(path: string, id: unknown, parent?: unknown): VaultNoteSnapshotEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    frontmatter: {
      type: 'idea',
      ...(id !== undefined ? { id } : {}),
      ...(parent !== undefined ? { 'forked-from': parent } : {}),
    },
  };
}

function snapshot(...notes: VaultNoteSnapshotEntry[]): VaultNoteSnapshot {
  return { notes };
}

describe('lineage graph', () => {
  it('returns the same complete branched component from root, middle, or either leaf', () => {
    const a = note('A.md', A);
    const b = note('B.md', B, A);
    const c = note('C.md', C, B);
    const d = note('D.md', D, B);
    const e = note('E.md', E, A);
    const f = note('F.md', F, E);
    const maps = buildLineageMaps(snapshot(f, d, c, e, b, a));
    const expectedPaths = ['A.md', 'B.md', 'C.md', 'D.md', 'E.md', 'F.md'];

    const root = collectLineage(a, maps);
    const middle = collectLineage(b, maps);
    const firstLeaf = collectLineage(c, maps);
    const otherLeaf = collectLineage(f, maps);

    for (const graph of [root, middle, firstLeaf, otherLeaf]) {
      expect(graph.nodes.map(node => node.path)).toEqual(expectedPaths);
      expect(graph.warnings).toEqual([]);
    }
    expect(middle.nodes.map(({ path, depth, relationship }) => ({ path, depth, relationship })))
      .toEqual([
        { path: 'A.md', depth: -1, relationship: 'ancestor' },
        { path: 'B.md', depth: 0, relationship: 'target' },
        { path: 'C.md', depth: 1, relationship: 'descendant' },
        { path: 'D.md', depth: 1, relationship: 'descendant' },
        { path: 'E.md', depth: 0, relationship: 'related' },
        { path: 'F.md', depth: 1, relationship: 'related' },
      ]);
    expect(firstLeaf.nodes.map(({ path, depth, relationship }) => ({ path, depth, relationship })))
      .toEqual([
        { path: 'A.md', depth: -2, relationship: 'ancestor' },
        { path: 'B.md', depth: -1, relationship: 'ancestor' },
        { path: 'C.md', depth: 0, relationship: 'target' },
        { path: 'D.md', depth: 0, relationship: 'related' },
        { path: 'E.md', depth: -1, relationship: 'related' },
        { path: 'F.md', depth: 0, relationship: 'related' },
      ]);
    expect(otherLeaf.nodes.map(({ path, depth, relationship }) => ({ path, depth, relationship })))
      .toEqual([
        { path: 'A.md', depth: -2, relationship: 'ancestor' },
        { path: 'B.md', depth: -1, relationship: 'related' },
        { path: 'C.md', depth: 0, relationship: 'related' },
        { path: 'D.md', depth: 0, relationship: 'related' },
        { path: 'E.md', depth: -1, relationship: 'ancestor' },
        { path: 'F.md', depth: 0, relationship: 'target' },
      ]);
  });

  it('compares UUID identity case-insensitively while preserving authored values', () => {
    const a = note('A.md', A.toUpperCase());
    const b = note('B.md', B, A.toLowerCase());
    const graph = collectLineage(b, buildLineageMaps(snapshot(a, b)));

    expect(graph.nodes[0]).toMatchObject({ id: A.toUpperCase() });
    expect(graph.nodes[1]).toMatchObject({ forkedFrom: A.toLowerCase() });
  });

  it('includes a missing or malformed-id child once as a terminal node', () => {
    const a = note('A.md', A);
    const missing = note('Missing.md', undefined, A);
    const malformed = note('Malformed.md', 'not-a-uuid', A);
    const hiddenGrandchild = note('Hidden.md', D, C);
    const graph = collectLineage(
      a,
      buildLineageMaps(snapshot(a, missing, malformed, hiddenGrandchild))
    );

    expect(graph.nodes.map(node => [node.path, node.id])).toEqual([
      ['A.md', A],
      ['Malformed.md', null],
      ['Missing.md', null],
    ]);
    expect(graph.warnings.map(warning => warning.code)).toEqual([
      'missing-lineage-id',
      'missing-lineage-id',
    ]);
  });

  it('bounds cycles and emits each physical note once', () => {
    const a = note('A.md', A, C);
    const b = note('B.md', B, A);
    const c = note('C.md', C, B);
    const graph = collectLineage(b, buildLineageMaps(snapshot(a, b, c)));

    expect(new Set(graph.nodes.map(node => node.path)).size).toBe(3);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.warnings.some(warning => warning.code === 'fork-cycle')).toBe(true);
  });

  it('uses a deterministic cycle root even when a branch sorts before the cycle', () => {
    const a = note('Z-A.md', A, C);
    const b = note('Z-B.md', B, A);
    const c = note('Z-C.md', C, B);
    const branch = note('A-branch.md', D, B);
    const maps = buildLineageMaps(snapshot(branch, c, b, a));

    const fromCycle = collectLineage(a, maps);
    const fromBranch = collectLineage(branch, maps);

    expect(fromCycle.nodes.map(node => node.path)).toEqual([
      'Z-A.md', 'Z-B.md', 'A-branch.md', 'Z-C.md',
    ]);
    expect(fromBranch.nodes.map(node => node.path)).toEqual(
      fromCycle.nodes.map(node => node.path)
    );
    expect(fromBranch.warnings).toMatchObject([{ code: 'fork-cycle', path: 'Z-A.md' }]);
  });

  it('warns and stops at dangling and invalid parent values', () => {
    const dangling = note('Dangling.md', A, B);
    const invalid = note('Invalid.md', C, 'nope');

    const danglingGraph = collectLineage(dangling, buildLineageMaps(snapshot(dangling)));
    expect(danglingGraph.warnings).toMatchObject([{ code: 'dangling-forked-from' }]);
    const invalidGraph = collectLineage(invalid, buildLineageMaps(snapshot(invalid)));
    expect(invalidGraph.warnings).toMatchObject([{ code: 'invalid-forked-from' }]);
  });

  it('hard-errors for a duplicate identity only when that identity is reached', () => {
    const a = note('A.md', A);
    const b = note('B.md', B, A);
    const duplicate = note('Elsewhere/B duplicate.md', B.toUpperCase(), D);
    const unrelatedOne = note('Elsewhere/U1.md', C);
    const unrelatedTwo = note('Elsewhere/U2.md', C.toUpperCase());

    expect(() => collectLineage(
      a,
      buildLineageMaps(snapshot(a, b, duplicate, unrelatedOne, unrelatedTwo))
    )).toThrow(DuplicateLineageIdError);

    const isolated = collectLineage(a, buildLineageMaps(snapshot(a, unrelatedOne, unrelatedTwo)));
    expect(isolated.nodes.map(node => node.path)).toEqual(['A.md']);
  });

  it('rejects a target without a valid id', () => {
    const target = note('No ID.md', undefined);
    expect(() => collectLineage(target, buildLineageMaps(snapshot(target))))
      .toThrow('must have a valid UUID id');
  });

  it('terminates on a large deep graph without recursive traversal', () => {
    const notes: VaultNoteSnapshotEntry[] = [];
    let parent: string | undefined;
    for (let index = 0; index < 2_000; index++) {
      const suffix = index.toString(16).padStart(12, '0');
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
      notes.push(note(`Deep/${index.toString().padStart(4, '0')}.md`, id, parent));
      parent = id;
    }

    const graph = collectLineage(notes[0]!, buildLineageMaps(snapshot(...notes)));
    expect(graph.nodes).toHaveLength(2_000);
    expect(graph.nodes.at(-1)).toMatchObject({ depth: 1_999 });
  });
});
