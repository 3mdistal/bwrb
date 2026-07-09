import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from './discovery.js';
import { isValidNoteId, normalizeNoteId } from './note-id.js';

const FORKED_FROM_FIELD = 'forked-from';

export type LineageRelationship = 'ancestor' | 'target' | 'descendant' | 'related';

export interface LineageNode {
  path: string;
  absolutePath: string;
  id: string | null;
  forkedFrom: string | null;
  /** The node's tree generation minus the target's tree generation. */
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

/**
 * Collect the complete physical component connected to a target by valid
 * forked-from edges. Traversal treats those edges as undirected so asking from
 * any member returns the same family; rendering retains their authored
 * parent-to-child direction.
 */
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
    const key = `${warning.code}:${warning.path ?? ''}:${warning.paths?.join('|') ?? ''}:${String(warning.forked_from ?? '')}`;
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };

  const componentByPath = new Map<string, VaultNoteSnapshotEntry>();
  const parentByChildPath = new Map<string, VaultNoteSnapshotEntry>();
  const queue: VaultNoteSnapshotEntry[] = [targetNote];

  // Walk both sides of every valid, unambiguous edge. This is deliberately
  // iterative: real writing projects are allowed to become absurdly deep.
  for (let index = 0; index < queue.length; index++) {
    const note = queue[index]!;
    if (componentByPath.has(note.path)) continue;

    const noteId = note.frontmatter?.id;
    if (isValidNoteId(noteId)) {
      assertUniqueIdentity(normalizeNoteId(noteId), noteId, maps);
    }
    componentByPath.set(note.path, note);

    const parentValue = note.frontmatter?.[FORKED_FROM_FIELD];
    if (parentValue !== undefined) {
      if (!isValidNoteId(parentValue)) {
        addWarning({
          code: 'invalid-forked-from',
          message: `${note.relativePath} has an invalid forked-from value; ancestor traversal stopped.`,
          path: note.relativePath,
          forked_from: parentValue,
        });
      } else {
        const parentMatches = maps.notesById.get(normalizeNoteId(parentValue)) ?? [];
        if (parentMatches.length === 0) {
          addWarning({
            code: 'dangling-forked-from',
            message: `${note.relativePath} references missing parent id ${parentValue}.`,
            path: note.relativePath,
            id: parentValue,
            forked_from: parentValue,
          });
        } else if (parentMatches.length > 1) {
          throw new DuplicateLineageIdError(
            parentValue,
            parentMatches.map(match => match.relativePath)
          );
        } else {
          const parent = parentMatches[0]!;
          parentByChildPath.set(note.path, parent);
          if (!componentByPath.has(parent.path)) queue.push(parent);
        }
      }
    }

    // A note without a valid identity cannot have addressable children, so it
    // remains a visible terminal. A valid note exposes every reverse edge,
    // including siblings and cousin branches when traversal later reaches its
    // own parent.
    if (!isValidNoteId(noteId)) continue;
    const children = maps.childrenByParentId.get(normalizeNoteId(noteId)) ?? [];
    for (const child of children) {
      const childId = child.frontmatter?.id;
      if (isValidNoteId(childId)) {
        assertUniqueIdentity(normalizeNoteId(childId), childId, maps);
      } else {
        addWarning({
          code: 'missing-lineage-id',
          message: `${child.relativePath} is in the lineage but has no valid UUID id; it is shown as a terminal node.`,
          path: child.relativePath,
        });
      }
      parentByChildPath.set(child.path, note);
      if (!componentByPath.has(child.path)) queue.push(child);
    }
  }

  const componentPaths = [...componentByPath.keys()].sort((a, b) =>
    comparePath(componentByPath.get(a)!.relativePath, componentByPath.get(b)!.relativePath)
  );
  const cyclePaths = findCycle(componentPaths, parentByChildPath);
  const rootPath = selectRootPath(componentPaths, parentByChildPath, cyclePaths, componentByPath);

  if (cyclePaths.length > 0) {
    const displayCycle = rotateCycleToPath(cyclePaths, rootPath)
      .map(path => componentByPath.get(path)!.relativePath);
    addWarning({
      code: 'fork-cycle',
      message: `Fork lineage cycle detected: ${[...displayCycle, displayCycle[0]!].join(' → ')}`,
      path: componentByPath.get(rootPath)!.relativePath,
      paths: [...displayCycle, displayCycle[0]!],
    });
  }

  // Break one deterministic authored edge for rootless cycles, then calculate
  // a stable physical tree and generation for the whole component.
  const treeChildrenByParentPath = new Map<string, VaultNoteSnapshotEntry[]>();
  for (const childPath of componentPaths) {
    if (cyclePaths.length > 0 && childPath === rootPath) continue;
    const parent = parentByChildPath.get(childPath);
    if (!parent) continue;
    const children = treeChildrenByParentPath.get(parent.path) ?? [];
    children.push(componentByPath.get(childPath)!);
    treeChildrenByParentPath.set(parent.path, children);
  }
  for (const children of treeChildrenByParentPath.values()) {
    children.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  }

  const generationByPath = new Map<string, number>();
  const orderedNotes: VaultNoteSnapshotEntry[] = [];
  const traversal: Array<{ note: VaultNoteSnapshotEntry; generation: number }> = [
    { note: componentByPath.get(rootPath)!, generation: 0 },
  ];
  while (traversal.length > 0) {
    const item = traversal.pop()!;
    if (generationByPath.has(item.note.path)) continue;
    generationByPath.set(item.note.path, item.generation);
    orderedNotes.push(item.note);
    const children = treeChildrenByParentPath.get(item.note.path) ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      traversal.push({ note: children[index]!, generation: item.generation + 1 });
    }
  }

  // This should be unreachable for a connected functional graph, but keeping
  // malformed future data deterministic is kinder than silently dropping it.
  for (const path of componentPaths) {
    if (generationByPath.has(path)) continue;
    generationByPath.set(path, 0);
    orderedNotes.push(componentByPath.get(path)!);
  }

  const ancestorPaths = collectAncestorPaths(targetNote.path, parentByChildPath);
  const descendantPaths = collectDescendantPaths(targetNote.path, parentByChildPath);
  const targetGeneration = generationByPath.get(targetNote.path)!;
  const nodes = orderedNotes.map(note => {
    let relationship: LineageRelationship;
    if (note.path === targetNote.path) relationship = 'target';
    else if (ancestorPaths.has(note.path)) relationship = 'ancestor';
    else if (descendantPaths.has(note.path)) relationship = 'descendant';
    else relationship = 'related';

    return toNode(
      note,
      generationByPath.get(note.path)! - targetGeneration,
      relationship
    );
  });

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

function collectAncestorPaths(
  targetPath: string,
  parentByChildPath: Map<string, VaultNoteSnapshotEntry>
): Set<string> {
  const ancestors = new Set<string>();
  let currentPath = targetPath;
  while (true) {
    const parent = parentByChildPath.get(currentPath);
    if (!parent || parent.path === targetPath || ancestors.has(parent.path)) break;
    ancestors.add(parent.path);
    currentPath = parent.path;
  }
  return ancestors;
}

function collectDescendantPaths(
  targetPath: string,
  parentByChildPath: Map<string, VaultNoteSnapshotEntry>
): Set<string> {
  const childrenByParentPath = new Map<string, string[]>();
  for (const [childPath, parent] of parentByChildPath) {
    const children = childrenByParentPath.get(parent.path) ?? [];
    children.push(childPath);
    childrenByParentPath.set(parent.path, children);
  }
  for (const children of childrenByParentPath.values()) children.sort(comparePath);

  const descendants = new Set<string>();
  const queue = [targetPath];
  for (let index = 0; index < queue.length; index++) {
    for (const childPath of childrenByParentPath.get(queue[index]!) ?? []) {
      if (childPath === targetPath || descendants.has(childPath)) continue;
      descendants.add(childPath);
      queue.push(childPath);
    }
  }
  return descendants;
}

function findCycle(
  paths: string[],
  parentByChildPath: Map<string, VaultNoteSnapshotEntry>
): string[] {
  const completed = new Set<string>();
  for (const start of paths) {
    if (completed.has(start)) continue;
    const chain: string[] = [];
    const indexByPath = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !completed.has(current)) {
      const existingIndex = indexByPath.get(current);
      if (existingIndex !== undefined) return chain.slice(existingIndex);
      indexByPath.set(current, chain.length);
      chain.push(current);
      current = parentByChildPath.get(current)?.path;
    }
    for (const path of chain) completed.add(path);
  }
  return [];
}

function selectRootPath(
  paths: string[],
  parentByChildPath: Map<string, VaultNoteSnapshotEntry>,
  cyclePaths: string[],
  componentByPath: Map<string, VaultNoteSnapshotEntry>
): string {
  const candidates = cyclePaths.length > 0
    ? cyclePaths
    : paths.filter(path => !parentByChildPath.has(path));
  return [...(candidates.length > 0 ? candidates : paths)].sort((a, b) =>
    comparePath(componentByPath.get(a)!.relativePath, componentByPath.get(b)!.relativePath)
  )[0]!;
}

function rotateCycleToPath(paths: string[], firstPath: string): string[] {
  const index = paths.indexOf(firstPath);
  return index < 0 ? paths : [...paths.slice(index), ...paths.slice(0, index)];
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

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}
