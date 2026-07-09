import { resolve } from 'path';
import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from './discovery.js';
import { buildLineageMaps } from './lineage.js';
import { isValidNoteId, normalizeNoteId } from './note-id.js';

export type DeleteLineageBlockReason = 'has-fork-children' | 'duplicate-identity';

export interface DeleteLineageChild {
  path: string;
  id?: string;
}

export interface DeleteLineageBlock {
  path: string;
  reason: DeleteLineageBlockReason;
  id?: string;
  childCount?: number;
  children?: DeleteLineageChild[];
  duplicates?: string[];
}

export interface DeleteLineageAssessment {
  blocked: DeleteLineageBlock[];
  missing: string[];
}

/**
 * Assess direct fork edges for delete targets using one coherent vault
 * snapshot. This deliberately does not traverse: a direct child is enough to
 * refuse, and cycles therefore remain finite (a self-edge blocks itself).
 */
export function assessDeleteLineage(
  snapshot: VaultNoteSnapshot,
  targetPaths: string[]
): DeleteLineageAssessment {
  const maps = buildLineageMaps(snapshot);
  const notesByPath = new Map(
    snapshot.notes.map(note => [resolve(note.path), note] as const)
  );
  const blocked: DeleteLineageBlock[] = [];
  const missing: string[] = [];

  for (const targetPath of [...targetPaths].sort(comparePath)) {
    const target = notesByPath.get(resolve(targetPath));
    if (!target) {
      missing.push(targetPath);
      continue;
    }

    const id = target.frontmatter?.id;
    if (!isValidNoteId(id)) continue;

    const identity = normalizeNoteId(id);
    const identityMatches = maps.notesById.get(identity) ?? [];
    if (identityMatches.length > 1) {
      blocked.push({
        path: target.relativePath,
        reason: 'duplicate-identity',
        id,
        duplicates: identityMatches.map(note => note.relativePath).sort(comparePath),
      });
      continue;
    }

    const children = (maps.childrenByParentId.get(identity) ?? []).map(toChild);
    if (children.length > 0) {
      blocked.push({
        path: target.relativePath,
        reason: 'has-fork-children',
        id,
        childCount: children.length,
        children,
      });
    }
  }

  blocked.sort((a, b) => comparePath(a.path, b.path));
  return { blocked, missing };
}

function toChild(note: VaultNoteSnapshotEntry): DeleteLineageChild {
  const id = note.frontmatter?.id;
  return {
    path: note.relativePath,
    ...(isValidNoteId(id) ? { id } : {}),
  };
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}
