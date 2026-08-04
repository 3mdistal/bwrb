import type { VaultNoteSnapshot } from '../discovery.js';
import { isValidNoteId } from '../note-id.js';
import type { AuditIssue } from './types.js';

/** Validate the frontmatter-v1 invariant for every parseable discovered note. */
export function collectRequiredNoteIdentityIssues(
  snapshot: VaultNoteSnapshot
): Map<string, AuditIssue[]> {
  const issuesByPath = new Map<string, AuditIssue[]>();
  for (const note of snapshot.notes) {
    if (!note.frontmatter) continue;
    const hasId = Object.prototype.hasOwnProperty.call(note.frontmatter, 'id');
    if (!hasId) {
      issuesByPath.set(note.relativePath, [{
        severity: 'error',
        code: 'missing-note-id',
        message: "Frontmatter-v1 notes must have a stable UUID 'id'",
        field: 'id',
        autoFixable: false,
      }]);
      continue;
    }
    const id = note.frontmatter.id;
    if (!isValidNoteId(id)) {
      issuesByPath.set(note.relativePath, [{
        severity: 'error',
        code: 'invalid-note-id',
        message: "Frontmatter-v1 note 'id' must be a UUID string",
        field: 'id',
        value: id,
        autoFixable: false,
      }]);
    }
  }
  return issuesByPath;
}
