import type { VaultNoteSnapshot, VaultNoteSnapshotEntry } from '../discovery.js';
import { isValidNoteId, normalizeNoteId } from '../note-id.js';
import type { AuditIssue } from './types.js';

const FORKED_FROM_FIELD = 'forked-from';

function addIssue(
  issuesByPath: Map<string, AuditIssue[]>,
  relativePath: string,
  issue: AuditIssue
): void {
  const existing = issuesByPath.get(relativePath) ?? [];
  existing.push(issue);
  issuesByPath.set(relativePath, existing);
}

function getValidId(note: VaultNoteSnapshotEntry): string | undefined {
  const value = note.frontmatter?.id;
  return isValidNoteId(value) ? value : undefined;
}

function getValidParentId(note: VaultNoteSnapshotEntry): string | undefined {
  const value = note.frontmatter?.[FORKED_FROM_FIELD];
  return isValidNoteId(value) ? value : undefined;
}

function getIdIdentity(note: VaultNoteSnapshotEntry): string | undefined {
  const id = getValidId(note);
  return id ? normalizeNoteId(id) : undefined;
}

function getParentIdIdentity(note: VaultNoteSnapshotEntry): string | undefined {
  const parentId = getValidParentId(note);
  return parentId ? normalizeNoteId(parentId) : undefined;
}

/**
 * Audit hand-authored document lineage metadata across a vault snapshot.
 *
 * Findings are flag-only. In particular, dangling provenance is retained: the
 * source may be restored later, while clearing it would silently discard
 * authorship history. Cycle traversal is bounded by per-walk visited maps.
 */
export function collectLineageIssues(
  snapshot: VaultNoteSnapshot
): Map<string, AuditIssue[]> {
  const issuesByPath = new Map<string, AuditIssue[]>();
  const notes = snapshot.notes.filter(
    (note): note is VaultNoteSnapshotEntry & { frontmatter: Record<string, unknown> } =>
      note.frontmatter !== undefined
  );

  const notesById = new Map<string, VaultNoteSnapshotEntry[]>();
  for (const note of notes) {
    const idIdentity = getIdIdentity(note);
    if (!idIdentity) continue;
    const matches = notesById.get(idIdentity) ?? [];
    matches.push(note);
    notesById.set(idIdentity, matches);
  }

  for (const matches of notesById.values()) {
    if (matches.length < 2) continue;
    const paths = matches.map((note) => note.relativePath).sort();
    for (const note of matches) {
      const id = getValidId(note)!;
      addIssue(issuesByPath, note.relativePath, {
        severity: 'error',
        code: 'duplicate-note-id',
        message: `Duplicate note id '${id}' is also used by ${paths.filter((path) => path !== note.relativePath).join(', ')}`,
        field: 'id',
        value: id,
        autoFixable: false,
        meta: { paths },
      });
    }
  }

  for (const note of notes) {
    if (!(FORKED_FROM_FIELD in note.frontmatter)) continue;

    const parentValue = note.frontmatter[FORKED_FROM_FIELD];
    if (!isValidNoteId(parentValue)) {
      addIssue(issuesByPath, note.relativePath, {
        severity: 'error',
        code: 'invalid-forked-from',
        message: `'${FORKED_FROM_FIELD}' must be a UUID string referencing the immediate source note`,
        field: FORKED_FROM_FIELD,
        value: parentValue,
        autoFixable: false,
      });
    }

    if (!getValidId(note)) {
      addIssue(issuesByPath, note.relativePath, {
        severity: 'error',
        code: 'missing-lineage-id',
        message: `A note with '${FORKED_FROM_FIELD}' must also have a valid UUID 'id'`,
        field: 'id',
        autoFixable: false,
      });
    }

    if (
      isValidNoteId(parentValue) &&
      !notesById.has(normalizeNoteId(parentValue))
    ) {
      addIssue(issuesByPath, note.relativePath, {
        severity: 'warning',
        code: 'dangling-forked-from',
        message: `'${FORKED_FROM_FIELD}' references missing note id '${parentValue}'`,
        field: FORKED_FROM_FIELD,
        value: parentValue,
        autoFixable: false,
      });
    }
  }

  const uniqueNotesById = new Map<string, VaultNoteSnapshotEntry>();
  for (const [idIdentity, matches] of notesById) {
    if (matches.length === 1) uniqueNotesById.set(idIdentity, matches[0]!);
  }

  const reportedCycles = new Set<string>();
  for (const startId of uniqueNotesById.keys()) {
    const seenAt = new Map<string, number>();
    const walk: string[] = [];
    let currentId: string | undefined = startId;

    while (currentId && uniqueNotesById.has(currentId)) {
      const cycleStart = seenAt.get(currentId);
      if (cycleStart !== undefined) {
        const cycleIds = walk.slice(cycleStart);
        const signature = [...cycleIds].sort().join('|');
        if (!reportedCycles.has(signature)) {
          reportedCycles.add(signature);
          const cyclePaths = cycleIds.map(
            (id) => uniqueNotesById.get(id)!.relativePath
          );
          const displayCycle = [...cyclePaths, cyclePaths[0]!];
          for (const id of cycleIds) {
            const note = uniqueNotesById.get(id)!;
            addIssue(issuesByPath, note.relativePath, {
              severity: 'error',
              code: 'fork-cycle',
              message: `Fork lineage cycle detected: ${displayCycle.join(' → ')}`,
              field: FORKED_FROM_FIELD,
              autoFixable: false,
              cyclePath: displayCycle,
            });
          }
        }
        break;
      }

      seenAt.set(currentId, walk.length);
      walk.push(currentId);
      const currentNote = uniqueNotesById.get(currentId)!;
      const parentIdIdentity = getParentIdIdentity(currentNote);
      currentId =
        parentIdIdentity && uniqueNotesById.has(parentIdIdentity)
          ? parentIdIdentity
          : undefined;
    }
  }

  return issuesByPath;
}
