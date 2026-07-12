# Agent change-candidate and review system

## What

Make Bowerbird a reliable durable-state substrate for stateless agent workflows without adding agent-specific record types to the CLI or turning Markdown frontmatter into an opaque workflow object.

Workflow records remain ordinary schema-defined notes—change candidates, requirements, attestations, and workflow events—connected through typed relations. Bowerbird supplies the general primitives those schemas need: safe contested edits, explainable relation-aware transitions, bounded transition effects, and retention findings.

The first production slice is **revision-checked machine edits**. `bwrb list --output json` exposes an opaque revision for each result, and `bwrb edit --json ... --expected-revision <revision>` refuses to write when the note has changed since it was read.

## Why this slice first

Revision checking is the smallest coherent behavior that proves a necessary architectural contract:

- stateless agents can read durable typed records through Bowerbird;
- they can carry forward an opaque observation token;
- contested candidate state cannot silently overwrite newer truth;
- failures are explicit and retryable by rereading;
- Markdown remains the source of truth, with no stored counter or hidden database.

Adding transition-guard schema syntax first would leave the most important shared-record mutation unsafe. Revision checks also reuse Bowerbird's existing exact-byte concurrency protection instead of creating a parallel mechanism.

## Resolved boundaries

- The revision is an opaque digest of the exact note bytes read by Bowerbird.
- It is computed, not written into frontmatter.
- Callers must not infer meaning from its algorithm or length.
- A supplied expected revision is checked against the snapshot used for validation and again under the existing note mutation lock immediately before write.
- Revision mismatch is a user/data error (exit code 2), does not write, and reports the expected and current opaque revisions in JSON output.
- JSON edit must not auto-retry a stale expected revision. The agent must list/read again and reconsider its patch.
- Interactive edit does not accept revision preconditions in this slice.
- `list` text/table output does not gain a revision column by default.
- Native body edits remain valid, but naturally invalidate a previously observed revision.

## CLI contract

```sh
# Discover a record and retain its opaque revision.
bwrb list change-candidate --where 'status = implementing' --output json

# Advance it only if nothing—including the body—changed after that read.
bwrb edit 'Candidate 417' \
  --json '{"status":"awaiting-review"}' \
  --expected-revision '<opaque revision>' \
  --output json
```

Successful JSON list rows include `revision`. Successful JSON edit output includes the new `revision`, allowing the next guarded step without a redundant read.

On mismatch:

```json
{
  "success": false,
  "error": "Note changed since it was read. Reread it and retry with the current revision.",
  "code": "REVISION_MISMATCH",
  "expectedRevision": "...",
  "currentRevision": "..."
}
```

Human-readable output says the same thing without presenting the digest as a version number.

## Implementation map

- Revision primitive: add a small helper beside `src/lib/note-write-concurrency.ts`; hash exact bytes and centralize mismatch construction.
- List projection: compute revision from the same file contents used to construct each result in `src/commands/list.ts`; expose it only in structured rows.
- Command boundary: register `--expected-revision <revision>` in `src/commands/edit.ts`, reject it unless `--json` is present, and pass it into the JSON editor.
- Edit path: in `src/lib/edit.ts`, compare the expected revision to the read snapshot before validation and to the locked current bytes immediately before write. Disable concurrent replay when the caller supplied a revision.
- Output: preserve established structured error conventions and exit code 2.
- Docs: update canonical `docs-site` list/edit references and `docs/skill/SKILL.md` for agent usage.

## Acceptance

Focused tests must prove:

1. JSON list results expose a deterministic opaque revision.
2. Editing with the matching revision succeeds and returns a different revision when bytes change.
3. Editing with a stale revision exits 2 and preserves the newer file byte-for-byte.
4. A body-only native edit invalidates the revision.
5. A stale guarded edit is not replayed across the existing concurrency retry path.
6. `--expected-revision` without `--json` fails at the command boundary.
7. Existing unguarded JSON and interactive edit concurrency behavior remains unchanged.

Run a disposable-vault CLI acceptance flow using built `dist/`: create schema and candidate note, list it, guarded-edit it, modify its body natively, demonstrate rejection with the old revision, relist, and succeed with the new revision.

## Later slices

1. Constrained relation-aware transition guards with explanatory missing/failed/stale relation output.
2. A read-only transition explanation surface before mutation.
3. Bounded related-note effects, generalized carefully from cross-type recurrence rather than overloading recurrence syntax.
4. Actor provenance inherited from a session/global runner context.
5. Retention-due audit findings and targeted explicit fixes.

Each later slice must remain general-purpose. The `teenylilthoughts` schema supplies workflow vocabulary; Bowerbird supplies typed Markdown mechanics.

## Non-goals

- No built-in change-candidate, requirement, attestation, or workflow-event types.
- No arbitrary nested workflow object.
- No authentication or authorization server.
- No hosting, preview, build, feature-flag, or PR orchestration.
- No retention deletion in the first slice.
- No generalized transition language in the first slice.
- No changes to `teenylilthoughts`.
