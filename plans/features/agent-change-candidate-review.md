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

## Remaining production slices

Each slice remains general-purpose. The `teenylilthoughts` schema supplies
workflow vocabulary; Bowerbird supplies typed Markdown mechanics.

### Relation-aware transition guards

Traits may declare direct-relation requirements for a field transition:

```json
{
  "transition_guards": [
    {
      "on": "status = accepted",
      "requires": [
        {
          "relation": "requirements",
          "min": 1,
          "all": { "field": "status", "equals": "satisfied" },
          "failed_when": { "field": "status", "in": ["failed", "needs-revision"] },
          "stale_when": { "field": "status", "in": ["stale", "superseded"] }
        }
      ]
    }
  ]
}
```

- `on` reuses recurrence's constrained `<field> = <value>` grammar.
- `relation` names one effective `prompt: "relation"` field. Its `source`
  remains the target-type contract.
- `min` defaults to `1`; every resolved target must satisfy `all`.
- Predicates are deliberately limited to one target field and `equals` or
  `in`. No arbitrary expressions, reverse traversal, or nested joins.
- `failed_when` and `stale_when` classify failures using schema vocabulary.
- Missing, unresolved, stale, failed, and satisfied results are all reported;
  evaluation never stops at the first failure.
- A transition is checked only when its field enters the configured value.
- Duplicate guards for the same effective field/value are invalid schema.

JSON edit and interactive edit must reject blocked transitions without writing.
Bulk must report each blocked file explicitly and leave that file unchanged.

### Read-only transition explanation

```sh
bwrb explain "Candidate 417" --transition "status = accepted"
bwrb explain "Candidate 417" --transition accepted --output json
```

Value-only shorthand is valid only when it identifies exactly one configured
guard. A valid but blocked explanation exits `0`: blocked is useful workflow
state, not a command failure. Invalid targeting, grammar, or schema remains an
error. The explanation DTO is the single source used by both `explain` and
mutation errors (`TRANSITION_GUARD_FAILED`).

### Bounded related-note transition effects

Cross-type creation remains the existing recurrence primitive: it already
creates from a named template and carries an audit backstop. Related-note state
changes use a separate trait property:

```json
{
  "transition_effects": [
    {
      "on": "status = accepted",
      "relation": "task",
      "set": { "status": "done" }
    }
  ]
}
```

- The relation must be scalar and direct; an empty value is a no-op.
- The patch is flat and literal, with `$ACTOR`, `$NOW`, and `$TODAY` as the only
  dynamic values.
- Effects do not cascade into more effects or recurrence.
- Source and target are prepared and validated before writing, then re-read
  under ordered shared mutation locks.
- The implementation must roll back its own earlier write when a later write
  fails, without erasing a newer writer.
- Native edits have no effect backstop because a static snapshot cannot prove
  that a transition occurred.

### Session-level logical actor provenance

Actor identity is provenance, not authentication. Resolve it once per process:

1. root `--actor <value>` administrative override;
2. `BWRB_ACTOR` supplied by the runner/session;
3. literal `unknown`.

Do not infer a human from the OS user, Git identity, or hostname. Schemas opt in
with a static field value:

```json
{ "actor": { "value": "$ACTOR" } }
```

`$ACTOR` behaves like `$NOW` and `$TODAY`: it materializes on creation or when a
missing static field is deliberately restored. It does not overwrite an
attestation's original actor on every later edit. Transition-effect patches may
also use `$ACTOR`. Runner identity is global/session-level; vault schemas do not
declare which runner is active.

### Retention findings and explicit remediation

Retention belongs to a type and is evaluated by audit:

```json
{
  "retention": {
    "when": { "status": { "in": ["accepted", "rejected"] } },
    "clock": { "field": "resolved-at", "after": "180d" },
    "resolved_when": { "retention-state": { "in": ["archived", "tombstoned"] } },
    "actions": [
      { "kind": "archive", "directory": "Archive/Change Candidates" },
      {
        "kind": "tombstone",
        "set": {
          "retention-state": "tombstoned",
          "tombstoned-at": "$TODAY"
        }
      },
      { "kind": "delete" }
    ]
  }
}
```

- The clock is an explicit day-granularity date field; file timestamps never
  drive retention.
- Due is inclusive: local `today >= clock + after` using one audit-run clock.
- Missing or invalid clocks are diagnostics, never guessed deadlines.
- `retention-due` is a warning with available action metadata.
- Remediation requires `--only retention-due`, explicit targeting or `--all`,
  `--retention-action`, and `--execute`; otherwise it is a dry-run.
- Archive moves to the configured directory and updates links. Tombstone applies
  only the configured schema-valid patch. Delete reuses canonical lineage and
  relation safety and never occurs through ordinary automatic audit fixing.
- Every action re-reads the live note and confirms it is still due immediately
  before mutation.

## Non-goals

- No built-in change-candidate, requirement, attestation, or workflow-event types.
- No arbitrary nested workflow object.
- No authentication or authorization server.
- No hosting, preview, build, feature-flag, or PR orchestration.
- No retention deletion in the first slice.
- No generalized transition language in the first slice.
- No changes to `teenylilthoughts`.
