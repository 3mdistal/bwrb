import { describe, expect, it } from 'vitest';
import { collectLineageIssues } from '../../../src/lib/audit/lineage.js';
import type { VaultNoteSnapshot } from '../../../src/lib/discovery.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function snapshot(
  notes: Array<{ path: string; id?: unknown; forkedFrom?: unknown }>
): VaultNoteSnapshot {
  return {
    notes: notes.map((note) => ({
      path: `/vault/${note.path}`,
      relativePath: note.path,
      frontmatter: {
        type: 'note',
        ...(note.id !== undefined ? { id: note.id } : {}),
        ...(note.forkedFrom !== undefined ? { 'forked-from': note.forkedFrom } : {}),
      },
      resolvedType: 'note',
    })),
  };
}

function codes(result: ReturnType<typeof collectLineageIssues>, path: string): string[] {
  return (result.get(path) ?? []).map((issue) => issue.code);
}

describe('fork lineage audit', () => {
  it('accepts a valid root, child, and grandchild lineage', () => {
    const result = collectLineageIssues(snapshot([
      { path: 'Notes/A.md', id: A },
      { path: 'Notes/B.md', id: B, forkedFrom: A },
      { path: 'Notes/C.md', id: C, forkedFrom: B },
    ]));

    expect(result.size).toBe(0);
  });

  it('reports dangling provenance as a flag-only warning', () => {
    const result = collectLineageIssues(snapshot([
      { path: 'Notes/B.md', id: B, forkedFrom: A },
    ]));
    const issue = result.get('Notes/B.md')?.find((item) => item.code === 'dangling-forked-from');

    expect(issue?.severity).toBe('warning');
    expect(issue?.autoFixable).toBe(false);
  });

  it('reports malformed provenance and a child without a valid id', () => {
    const result = collectLineageIssues(snapshot([
      { path: 'Notes/B.md', forkedFrom: '[[A]]' },
    ]));

    expect(codes(result, 'Notes/B.md')).toEqual(
      expect.arrayContaining(['invalid-forked-from', 'missing-lineage-id'])
    );
  });

  it('reports every note sharing a duplicate stable id', () => {
    const result = collectLineageIssues(snapshot([
      { path: 'Notes/A.md', id: A },
      { path: 'Archive/A.md', id: A },
    ]));

    expect(codes(result, 'Notes/A.md')).toContain('duplicate-note-id');
    expect(codes(result, 'Archive/A.md')).toContain('duplicate-note-id');
  });

  it('terminates on A to B to A and reports the cycle on both notes', () => {
    const result = collectLineageIssues(snapshot([
      { path: 'Notes/A.md', id: A, forkedFrom: B },
      { path: 'Notes/B.md', id: B, forkedFrom: A },
    ]));

    expect(codes(result, 'Notes/A.md')).toContain('fork-cycle');
    expect(codes(result, 'Notes/B.md')).toContain('fork-cycle');
    expect(result.get('Notes/A.md')?.find((issue) => issue.code === 'fork-cycle')?.severity).toBe('error');
  });
});
