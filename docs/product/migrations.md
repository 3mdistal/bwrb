# Schema Migrations

Schema migrations enable safe evolution of vault schemas by detecting changes, generating migration plans, and applying them to existing notes.

## Core Principles

1. **Migrations are explicit** - Users must intentionally bump the schema version and execute migrations
2. **Safe by default** - Dry-run mode shows what would change before applying
3. **Backup by default** - Migrations create backups unless explicitly skipped
4. **Git handles history** - Bowerbird maintains only current and last-applied schema states; deeper history is Git's responsibility

## Schema Versioning

Schemas include a `schemaVersion` field for tracking content versions:

```json
{
  "version": 2,
  "schemaVersion": "1.0.0",
  "types": { ... }
}
```

- `version`: Format version (internal, managed by Bowerbird)
- `schemaVersion`: User-controlled semantic version for tracking schema evolution

## Commands

### `bwrb schema diff`

Shows pending changes between the current schema and the last-applied snapshot.

```bash
bwrb schema diff
bwrb schema diff --json
```

Output categorizes changes as:
- **Deterministic**: Can be auto-applied (field additions, type additions, widening a field to allow multiple values)
- **Non-deterministic**: Require user input (field removals, removed select options, fields becoming required, relation source changes, type removals)

### `bwrb schema migrate`

Applies schema changes to existing notes.

```bash
# Dry-run (default) - shows what would change
bwrb schema migrate

# Dry-run + per-note before→after changes
bwrb schema migrate --show-changes

# Execute migration - prompts for new version, creates backup, applies changes
bwrb schema migrate --execute

# Skip backup (power users)
bwrb schema migrate --execute --no-backup
```

By default the dry-run preview shows schema-level operations plus a
files-scanned / files-affected summary. Add `--show-changes` to also print the
concrete per-note before→after edits, e.g.:

```text
Per-note changes:
  Objectives/Tasks/Task A.md:
    priority: (empty) → medium
    owner: (deleted)
```

Null/missing values render as `(empty)` (consistent with the bulk change
preview). To keep output manageable on large vaults, the per-note list is
capped (currently 200 lines) with a trailing `... and N more changes` summary;
the schema-level summary always prints in full. The flag also applies to
`--execute` to echo what was applied.

> **Field renames are not auto-detected.** The schema diff engine compares two
> schema snapshots and has no way to tell an intentional rename apart from an
> unrelated drop-and-add: renaming a field in `schema.json` always surfaces as a
> separate **add field** + **remove field** pair (which deletes the old field's
> data). The `old → new: value` rename preview only appears for an explicit
> `rename-field` operation. To rename a field while preserving its values, use
> the bulk command, which moves the data in one step:
>
> ```bash
> bwrb bulk --all --rename owner=assignee --execute
> ```
>
> Canonical user-facing behavior lives in the docs-site
> [Migrations](../../docs-site/src/content/docs/concepts/migrations.md) page; see
> [issue #694](https://github.com/3mdistal/bwrb/issues/694) for background.

In `--output json` mode the per-note changes are **always** included under
`data.fileChanges` (an array of `{ relativePath, changes[] }`), uncapped, for
both dry-run and execute — no flag required.

When executing:
1. Shows pending changes
2. Prompts for new schema version (suggests based on change severity)
3. Creates backup (unless `--no-backup`)
4. Applies changes to affected notes
5. Saves schema snapshot
6. Records migration in history

### `bwrb schema history`

Shows migration history.

```bash
bwrb schema history
bwrb schema history --json
```

## Migration Types

### Field Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add field | Deterministic | No action needed (field absent in old notes is valid) |
| Remove field | Non-deterministic | Removes field from affected notes |
| Rename field | Not detected by diff | A schema rename is seen as add + remove. Use `bwrb bulk --rename old=new` to rename while preserving values |
| Add select option | Deterministic | No action needed (existing values stay valid) |
| Remove select option | Non-deterministic (`clear-invalid-options`) | Drops any note value that is no longer in the allowed set — a scalar becomes empty, an array is filtered to its still-valid members |
| Make field required | Non-deterministic (`review-field`) | Surfaced for manual review; notes missing a value are flagged but not auto-filled |
| Allow multiple values (`multiple` false → true) | Deterministic (`widen-field-to-multiple`) | Wraps an existing scalar value into a single-element array |
| Disallow multiple values (`multiple` true → false) | Non-deterministic (`review-field`) | Surfaced for manual review; collapsing an array is lossy, so notes are flagged, not changed |
| Change relation `source` | Non-deterministic (`review-field`) | Surfaced for manual review; existing links may now point at the wrong type |

### Type Operations

| Change | Classification | Migration Action |
|--------|---------------|------------------|
| Add type | Deterministic | No action needed |
| Remove type | Non-deterministic | Orphans existing notes (warning) |
| Rename type | Non-deterministic | Moves notes to new directory |
| Reparent type | Non-deterministic | May require directory restructuring |

## Workflow Example

```bash
# 1. Make schema changes (interactively add a field)
bwrb schema new field task

# 2. Check what changed
bwrb schema diff
# Output:
# Deterministic changes:
#   + Add field "assignee" to type "task"
# Suggested version: 1.0.0 -> 1.1.0

# 3. Preview migration
bwrb schema migrate
# Output:
# Dry-run mode - no changes will be made
# 0 notes would be affected (field additions don't require note changes)

# 4. Apply migration
bwrb schema migrate --execute
# ? Enter new schema version [1.1.0]: 1.1.0
# Creating backup...
# Migration complete: 1.0.0 -> 1.1.0
```

## Storage

Bowerbird stores migration-related files in `.bwrb/`:

```
.bwrb/
├── schema.json           # Current schema
├── schema.applied.json   # Last successfully migrated schema (snapshot)
└── migrations.json       # History of applied migrations
```

`schema.applied.json` is migration bookkeeping only. Schema inspection commands
(for example `bwrb schema list`) always read the current `schema.json`, even if
the snapshot is out of date. Pending migrations may be surfaced as a warning or
status line, but the displayed schema is never sourced from the snapshot.

## Version Suggestion Logic

- **Major bump** (1.0.0 -> 2.0.0): Breaking changes like type/field/enum removals
- **Minor bump** (1.0.0 -> 1.1.0): Additions (new types, fields, enum values)
- **Patch bump** (1.0.0 -> 1.0.1): No structural changes (rare)

## Best Practices

1. **Commit schema changes with migrations** - Keep schema.json and migration results in the same commit
2. **Review diffs before executing** - Always run `bwrb schema diff` or `bwrb schema migrate` (dry-run) first
3. **Use meaningful versions** - Bump major version for breaking changes that affect how notes are used
4. **Backup important vaults** - While Bowerbird creates backups, Git provides additional safety
