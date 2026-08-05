import { buildNoteContent, parseNoteContent } from './frontmatter.js';
import { noteRevision } from './note-revision.js';

const PROCESS_METADATA = new Set([
  'priority-rank', 'priority-override', 'priority-reason', 'priority-algorithm',
  'priority-as-of', 'priority-basis-revision', 'priority-reviewed', 'priority-approval-id',
  'codex-thread-id', 'codex-host-id', 'codex-thread-updated-at', 'codex-last-reconciled-at',
  'codex-checkpoint', 'codex-lifecycle-stage', 'codex-attention',
]);

export function semanticEvidenceRevision(raw: string): string {
  const parsed = parseNoteContent(raw); const evidence = { ...parsed.frontmatter };
  for (const key of PROCESS_METADATA) delete evidence[key];
  return noteRevision(buildNoteContent(evidence, parsed.body));
}
