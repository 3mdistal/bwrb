---
title: bwrb edit
description: Modify existing note frontmatter
---

Edit the frontmatter of an existing note after resolving it by query or filters.

## Synopsis

```bash
bwrb edit [options] [query] [mode]
```

The optional second positional `[mode]` is the app mode used with `--open`
(`system`, `editor`, `visual`, `obsidian`, `print`) — parity with
[`bwrb list --open`](/reference/commands/list/). For example,
`bwrb edit "My Note" --open print` edits the note and then prints its path. An
explicit `--app` flag always takes precedence over the positional `[mode]`, an
invalid mode value is rejected with a clear error (even without `--open`), and a
third excess positional is rejected.

## Options

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by note type |
| `-p, --path <glob>` | Filter by path pattern |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <pattern>` | Filter by Markdown body content; YAML frontmatter is excluded |
| `--json <patch>` | Non-interactive patch/merge mode |
| `--expected-revision <revision>` | Require an opaque revision from `list --output json`; requires `--json` |
| `--patches <file>` | Preview a manifest that gives each named note its own patch (see [Patch batches](#patch-batches)) |
| `--execute` | Apply the `--patches` manifest: every patch, or none |
| `-o, --open` | Open the note after editing |
| `--app <mode>` | App mode for `--open`: `system`, `editor`, `visual`, `obsidian`, `print` |
| `--picker <mode>` | Picker mode: `fzf`, `numbered`, `none` |

## Examples

### Interactive Editing

```bash
# Find and edit interactively
bwrb edit "My Note"

# Edit a task by name
bwrb edit -t task "Review"

# Edit within Projects folder
bwrb edit --path "Projects/**" "Design"
```

### Non-interactive JSON Mode

For scripting and automation:

```bash
# Update a single field
bwrb edit "My Task" --json '{"status":"settled"}'

# Update multiple fields
bwrb edit -t task --where "status == 'active'" "Deploy" --json '{"priority":"high"}'
```

`--json` mode rejects patch fields that are not defined for the resolved note type. Existing legacy or unknown fields in the note are preserved unless the patch changes them.

After validation, a patch that makes no semantic change is a byte-preserving
no-op: Bowerbird still checks the expected revision, mutation lock, and current
raw bytes, but it does not reserialize or rewrite the note. The returned
revision therefore remains the revision of the original bytes.

### Guarded JSON edits

For a contested record, retain the opaque `revision` returned by `bwrb list
--output json` and send it back with the patch:

```bash
bwrb edit "Candidate 417" --json '{"status":"awaiting-review"}' \
  --expected-revision '<revision from list>' --output json
```

Bowerbird compares it to the read snapshot and again immediately before the
write under its mutation lock. A mismatch exits `2`, leaves the note untouched,
and returns `REVISION_MISMATCH` plus `expectedRevision` and `currentRevision`.
It never replays a guarded patch: list/read again and reconsider the change.
Successful JSON edits return the note's new opaque `revision`. Interactive edits
do not accept revision preconditions.

### Relation-backed transition guards

Traits can declare `transition_guards` that require direct related notes to be
satisfied before a field enters a configured value. Both JSON and interactive
edits reject a blocked transition without writing and JSON reports
`TRANSITION_GUARD_FAILED` with the complete explanation DTO. Use
`bwrb explain "Candidate 417" --transition accepted --output json` to inspect
the same result before attempting the edit.

### Related-note transition effects

When an entered trait transition has `transition_effects`, `edit` applies its
validated flat patch to the configured scalar relation target in the same
guarded commit. Empty relations are no-ops. Effects do not cascade from the
target into more effects or recurrence; cross-type creation remains recurrence.

### Patch batches

To give many notes each their own patch in one run, write a manifest and pass
it with `--patches`. Each entry names one note exactly: by vault-relative
`path`, by stable `id`, or by both, which must agree. An entry can carry the
`expectedRevision` from `list --output json`.

```json
{
  "notes": [
    { "path": "Tasks/Ship it.md", "patch": { "status": "done" } },
    { "id": "<uuid>", "expectedRevision": "<revision>", "patch": { "priority": "high" } }
  ]
}
```

```bash
# Preview: check every patch and report what would change; writes nothing
bwrb edit --patches plan.json

# Apply every patch, or none
bwrb edit --patches plan.json --execute
```

Each patch gets the same checks as `--json`: known fields, options, defaults,
relations, relative dates, parent cycles, transition guards and the expected
revision. The batch reads the vault once rather than once per note, so a
manifest of a hundred notes takes seconds instead of minutes.

- **All or nothing.** If any entry is blocked (a missing, ambiguous or repeated
  target, a validation error, a stale revision), nothing is written and every
  blocker is reported together. `--execute` builds every note's new contents
  and rechecks each note under its mutation lock before the first write. If a
  write fails partway, the notes this run already wrote are restored, unless
  something else has changed them since (`RESTORE_SKIPPED`). A restore that
  itself fails is reported as `RESTORE_FAILED`. The locks hold off other
  `bwrb` edits of the same notes, but not other programs, and not yet
  `bwrb bulk --move`.
- **Safe to rerun.** A note that already holds its patched values is reported
  `unchanged` and left alone, even when its revision has moved on. After an
  interruption, rerun the same manifest to finish the rest.
- **Frontmatter only.** `_body` is rejected; use `--json` to replace a body. A
  patch that would enter a transition with related-note effects, or create the
  next note of a recurrence, is blocked as well; edit that note on its own.

The output is one JSON value; `--output text` prints one line per note instead.

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "counts": { "notes": 1, "planned": 0, "unchanged": 0, "blocked": 0, "applied": 1, "restored": 0, "failed": 0, "not-attempted": 0 },
    "notes": [{
      "index": 0,
      "id": "<uuid>",
      "path": "Tasks/Ship it.md",
      "status": "applied",
      "updated": ["status"],
      "beforeRevision": "<revision read>",
      "revision": "<revision written>",
      "changes": { "status": { "from": "active", "to": "done" } }
    }]
  }
}
```

A blocked or failed batch returns `success: false` with an `error` and the
same `data`. Each affected note lists `errors`, each with a `code` such as
`TARGET_NOT_FOUND`, `DUPLICATE_TARGET`, `VALIDATION_FAILED`,
`TRANSITION_GUARD_FAILED` or `REVISION_MISMATCH`. The command exits `1` for
validation blockers, and `2` when the only blockers are changed or unreadable
notes, or when a write or a lock release failed. `--patches` cannot be
combined with a query, targeting options,
`--json`, `--expected-revision` or `--open`.

## Concurrent lineage changes

The final edit commit shares the note's lineage mutation lock with `new --fork`
and `lineage adopt`. Bowerbird compares the note's exact raw bytes after taking
the lock. A JSON patch that became stale is retried against the latest note for
up to three total attempts, so a concurrent `id` backfill or `forked-from` edge
is preserved.
Interactive answers are never replayed against unseen values; the command asks
you to retry instead.

If all three JSON attempts become stale, JSON output uses numeric exit code `2`
and stable retry context:

```json
{
  "success": false,
  "error": "Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.",
  "code": 2,
  "data": {
    "reason": "note-modified-concurrently",
    "retryable": true,
    "path": "Ideas/My Note.md",
    "attempts": 3
  }
}
```

This coordination covers Bowerbird edit, fork, and adoption processes. The
raw-byte check also detects an external editor change that lands before the
guarded comparison, but Bowerbird cannot lock unrelated editors; retry if an
external writer remains active.

### Edit and Open

```bash
# Open the note after editing
bwrb edit "My Note" --open

# Edit then open in $EDITOR
bwrb edit "My Note" --open --app editor

# Edit then open with a positional app mode (parity with `open`)
bwrb edit "My Note" --open print
```

## Targeting

Edit supports all four targeting selectors. See [Targeting Model](/reference/targeting/) for details.

```bash
# Combine selectors to narrow results
bwrb edit -t task -p "Work/**" -w "status == 'active'" "Deploy"
```

## Query Resolution

When you pass a note query and omit `--type`, `edit` resolves exact
vault-relative paths, filename basenames, and declared aliases before using its
interactive query fallback:

- **1 match:** edit proceeds
- **0 matches:** error
- **>1 match with `--picker none` or JSON mode:** error listing candidates and
  an exact-path retry; disambiguate with `--type`, `--path`, or one listed
  vault-relative path

An arbitrary frontmatter `name` is not an edit identity unless the schema
declares it as an alias. Read-only `list --name` may display several name
matches, but a mutating edit never chooses one of them silently. If the selected
file has malformed YAML, the error names that path and asks you to repair the
frontmatter before retrying.

## Picker Modes

When multiple notes match your query:

| Mode | Behavior |
|------|----------|
| `fzf` | Interactive fuzzy finder (default) |
| `numbered` | Numbered list selection |
| `none` | Error on ambiguity (for scripting) |

## See Also

- [bwrb list](/reference/commands/list/) — Find or open notes without editing
- [bwrb bulk](/reference/commands/bulk/) — Batch frontmatter changes
- [bwrb lineage](/reference/commands/lineage/) — Guarded document provenance
- [Targeting Model](/reference/targeting/) — Selector reference
