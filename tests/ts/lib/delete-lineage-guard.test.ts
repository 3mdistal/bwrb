import { describe, expect, it } from 'vitest';
import { assessDeleteLineage } from '../../../src/lib/delete-lineage-guard.js';
import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from '../../../src/lib/discovery.js';

const A = 'AAAAAAAA-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

function note(path: string, id?: unknown, parent?: unknown): VaultNoteSnapshotEntry {
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

describe('delete lineage guard', () => {
  it('allows a leaf and a target with a missing or malformed id', () => {
    const leaf = note('Leaf.md', B, A);
    const missing = note('Missing.md');
    const malformed = note('Malformed.md', 'not-a-uuid');

    expect(assessDeleteLineage(snapshot(leaf, missing, malformed), [
      leaf.path,
      missing.path,
      malformed.path,
    ])).toEqual({ blocked: [], missing: [] });
  });

  it('blocks direct children case-insensitively even when child ids are absent or malformed', () => {
    const parent = note('Parent.md', A);
    const missingId = note('Child A.md', undefined, A.toLowerCase());
    const malformedId = note('Child B.md', 'bad', A.toLowerCase());
    const result = assessDeleteLineage(snapshot(malformedId, parent, missingId), [parent.path]);

    expect(result.missing).toEqual([]);
    expect(result.blocked).toEqual([{
      path: 'Parent.md',
      reason: 'has-fork-children',
      id: A,
      childCount: 2,
      children: [
        { path: 'Child A.md' },
        { path: 'Child B.md' },
      ],
    }]);
  });

  it('blocks duplicate target identity without children', () => {
    const first = note('A.md', A);
    const second = note('B.md', A.toLowerCase());
    const result = assessDeleteLineage(snapshot(second, first), [first.path]);

    expect(result.blocked).toEqual([{
      path: 'A.md',
      reason: 'duplicate-identity',
      id: A,
      duplicates: ['A.md', 'B.md'],
    }]);
  });

  it('bounds self and two-note cycles while ignoring unrelated components', () => {
    const self = note('Self.md', A, A);
    const otherParent = note('Other.md', B);
    const unrelatedChild = note('Other Child.md', undefined, B);
    const result = assessDeleteLineage(
      snapshot(unrelatedChild, otherParent, self),
      [self.path]
    );

    expect(result.blocked[0]).toMatchObject({
      path: 'Self.md',
      reason: 'has-fork-children',
      childCount: 1,
    });
    expect(result.blocked[0]?.children).toEqual([{ path: 'Self.md', id: A }]);
  });

  it('reports targets that vanished from the authoritative snapshot', () => {
    expect(assessDeleteLineage(snapshot(), ['/vault/Gone.md'])).toEqual({
      blocked: [],
      missing: ['/vault/Gone.md'],
    });
  });
});
