import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from './discovery.js';
import { isValidNoteId, normalizeNoteId } from './note-id.js';

const FORKED_FROM_FIELD = 'forked-from';

export type LineageRelationship = 'ancestor' | 'target' | 'descendant';

export interface LineageNode {
  path: string;
  absolutePath: string;
  id: string | null;
  forkedFrom: string | null;
  depth: number;
  relationship: LineageRelationship;
}

export interface LineageWarning {
  code: 'missing-lineage-id' | 'dangling-forked-from' | 'invalid-forked-from' | 'fork-cycle';
  message: string;
  path?: string;
  id?: string;
  forked_from?: unknown;
  paths?: string[];
}

export interface LineageMaps {
  notesById: Map<string, VaultNoteSnapshotEntry[]>;
  childrenByParentId: Map<string, VaultNoteSnapshotEntry[]>;
}

export interface CollectedLineage {
  target: { path: string; id: string };
  nodes: LineageNode[];
  warnings: LineageWarning[];
}

export class DuplicateLineageIdError extends Error {
  readonly id: string;
  readonly paths: string[];

  constructor(id: string, paths: string[]) {
    const sortedPaths = [...paths].sort(comparePath);
    super(`Cannot render lineage: note id ${id} is duplicated; matches: ${sortedPaths.join(', ')}`);
    this.name = 'DuplicateLineageIdError';
    this.id = id;
    this.paths = sortedPaths;
  }
}

export function buildLineageMaps(snapshot: VaultNoteSnapshot): LineageMaps {
  const notesById = new Map<string, VaultNoteSnapshotEntry[]>();
  const childrenByParentId = new Map<string, VaultNoteSnapshotEntry[]>();

  for (const note of snapshot.notes) {
    const id = note.frontmatter?.id;
    if (isValidNoteId(id)) {
      const identity = normalizeNoteId(id);
      const matches = notesById.get(identity) ?? [];
      matches.push(note);
      notesById.set(identity, matches);
    }

    const parentId = note.frontmatter?.[FORKED_FROM_FIELD];
    if (isValidNoteId(parentId)) {
      const parentIdentity = normalizeNoteId(parentId);
      const children = childrenByParentId.get(parentIdentity) ?? [];
      children.push(note);
      childrenByParentId.set(parentIdentity, children);
    }
  }

  for (const matches of notesById.values()) {
    matches.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  }
  for (const children of childrenByParentId.values()) {
    children.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  }

  return { notesById, childrenByParentId };
}

export function collectLineage(
  targetNote: VaultNoteSnapshotEntry,
  maps: LineageMaps
): CollectedLineage {
  const targetId = targetNote.frontmatter?.id;
  if (!isValidNoteId(targetId)) {
    throw new Error(
      `Lineage target ${targetNote.relativePath} must have a valid UUID id.`
    );
  }

  const targetIdentity = normalizeNoteId(targetId);
  assertUniqueIdentity(targetIdentity, targetId, maps);

  const warnings: LineageWarning[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (warning: LineageWarning): void => {
    if (warning.code === 'fork-cycle' && warnings.some(existing => existing.code === 'fork-cycle')) {
      return;
    }
    const key = `${warning.code}:${warning.path ?? ''}:${warning.paths?.join('|') ?? ''}:${String(warning.forked_from ?? '')}`;
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };

  const targetNode = toNode(targetNote, 0, 'target');
  const ancestors: LineageNode[] = [];
  const descendants: LineageNode[] = [];
  const visitedPaths = new Set<string>([targetNote.path]);

  // Walk the single immediate-source chain upward. Duplicate identities are a
  // hard stop because choosing one source would manufacture a history.
  let current = targetNote;
  let ancestorDepth = -1;
  const upwardPaths = [targetNote.relativePath];
  while (true) {
    const parentValue = current.frontmatter?.[FORKED_FROM_FIELD];
    if (parentValue === undefined) break;
    if (!isValidNoteId(parentValue)) {
      addWarning({
        code: 'invalid-forked-from',
        message: `${current.relativePath} has an invalid forked-from value; ancestor traversal stopped.`,
        path: current.relativePath,
        forked_from: parentValue,
      });
      break;
    }

    const parentIdentity = normalizeNoteId(parentValue);
    const parentMatches = maps.notesById.get(parentIdentity) ?? [];
    if (parentMatches.length === 0) {
      addWarning({
        code: 'dangling-forked-from',
        message: `${current.relativePath} references missing parent id ${parentValue}.`,
        path: current.relativePath,
        id: parentValue,
        forked_from: parentValue,
      });
      break;
    }
    if (parentMatches.length > 1) {
      throw new DuplicateLineageIdError(
        parentValue,
        parentMatches.map(note => note.relativePath)
      );
    }

    const parent = parentMatches[0]!;
    if (visitedPaths.has(parent.path)) {
      addWarning({
        code: 'fork-cycle',
        message: `Fork lineage cycle detected: ${[...upwardPaths, parent.relativePath].join(' → ')}`,
        path: current.relativePath,
        paths: [...upwardPaths, parent.relativePath],
      });
      break;
    }

    const authoredParentId = parent.frontmatter?.id;
    assertUniqueIdentity(parentIdentity, authoredParentId, maps);
    visitedPaths.add(parent.path);
    ancestors.push(toNode(parent, ancestorDepth, 'ancestor'));
    upwardPaths.push(parent.relativePath);
    ancestorDepth -= 1;
    current = parent;
  }

  // Walk reverse edges breadth-first. This yields stable structural depths and
  // ensures a note reached by a cycle is emitted at most once.
  const queue: Array<{ note: VaultNoteSnapshotEntry; depth: number }> = [
    { note: targetNote, depth: 0 },
  ];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    const itemId = item.note.frontmatter?.id;
    if (!isValidNoteId(itemId)) continue;

    const children = maps.childrenByParentId.get(normalizeNoteId(itemId)) ?? [];
    for (const child of children) {
      if (visitedPaths.has(child.path)) {
        addWarning({
          code: 'fork-cycle',
          message: `Fork lineage cycle detected at edge ${item.note.relativePath} → ${child.relativePath}.`,
          path: item.note.relativePath,
          paths: [item.note.relativePath, child.relativePath],
        });
        continue;
      }

      const childId = child.frontmatter?.id;
      if (isValidNoteId(childId)) {
        assertUniqueIdentity(normalizeNoteId(childId), childId, maps);
      }

      visitedPaths.add(child.path);
      descendants.push(toNode(child, item.depth + 1, 'descendant'));

      if (!isValidNoteId(childId)) {
        addWarning({
          code: 'missing-lineage-id',
          message: `${child.relativePath} is in the lineage but has no valid UUID id; it is shown as a terminal node.`,
          path: child.relativePath,
        });
        continue;
      }

      queue.push({
        note: child,
        depth: item.depth + 1,
      });
    }
  }

  const nodes = [
    ...ancestors.sort(compareLineageNode),
    targetNode,
    ...descendants.sort(compareLineageNode),
  ];
  warnings.sort((a, b) =>
    a.code.localeCompare(b.code, 'en') ||
    (a.path ?? '').localeCompare(b.path ?? '', 'en')
  );

  return {
    target: { path: targetNote.relativePath, id: targetId },
    nodes,
    warnings,
  };
}

function assertUniqueIdentity(
  identity: string,
  authoredId: unknown,
  maps: LineageMaps
): void {
  const matches = maps.notesById.get(identity) ?? [];
  if (matches.length <= 1) return;
  throw new DuplicateLineageIdError(
    typeof authoredId === 'string' ? authoredId : identity,
    matches.map(note => note.relativePath)
  );
}

function toNode(
  note: VaultNoteSnapshotEntry,
  depth: number,
  relationship: LineageRelationship
): LineageNode {
  const id = note.frontmatter?.id;
  const forkedFrom = note.frontmatter?.[FORKED_FROM_FIELD];
  return {
    path: note.relativePath,
    absolutePath: note.path,
    id: isValidNoteId(id) ? id : null,
    forkedFrom: isValidNoteId(forkedFrom) ? forkedFrom : null,
    depth,
    relationship,
  };
}

function compareLineageNode(a: LineageNode, b: LineageNode): number {
  return a.depth - b.depth || comparePath(a.path, b.path);
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}
