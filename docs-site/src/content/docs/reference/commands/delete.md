---
title: bwrb delete
description: Remove notes from the vault
---

Delete notes from your vault with safety checks and bulk mode support.

## Synopsis

```bash
bwrb delete [options] [query]
```

## Modes

Delete operates in three modes:

- **Single-file mode** (default): Delete a specific note by name/query
- **Bulk mode**: Delete multiple notes matching targeting selectors
- **Scoped mode**: Use a query with targeting selectors to narrow the selection

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type |
| `-p, --path <glob>` | Filter by path glob |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <query>` | Filter by Markdown body content; YAML frontmatter is excluded |
| `--id <uuid>` | Filter by stable note id |
| `-a, --all` | Select all notes (required for bulk delete without other targeting) |

### Execution

| Option | Description |
|--------|-------------|
| `-x, --execute` | Actually delete files (default is dry-run for bulk) |
| `--dry-run` | Preview deletions without removing files |
| `-f, --force` | Skip confirmation prompt (single-file or multi-delete) |
| `--picker <mode>` | Selection mode: `auto`, `fzf`, `numbered`, `none` |
| `--output <format>` | Output format: `text`, `json` |

## Safety: Two-Gate Model

Bulk delete requires **two explicit gates** to prevent accidents:

1. **Targeting gate**: Must specify at least one selector (`--type`, `--path`, `--where`, `--body`) OR use `--all`
2. **Execution gate**: Must use `--execute` to actually delete (dry-run by default)
3. **Confirmation**: Deleting more than one file requires explicit confirmation (or `--force`)

```bash
# No query or selectors: enter single-file picker mode
bwrb delete
# Browse notes and select one to preview/delete

# Dry-run: shows what would be deleted
bwrb delete --type task

# Actually deletes
bwrb delete --type task --execute

# Query scoped to targeting (still requires --execute)
bwrb delete --type idea "Specific Name" --execute
```

### Fork-lineage safety

Without `--force`, delete refuses any note that has a direct document fork. The
check applies to single, scoped, bulk, execute, and dry-run modes; bulk deletion
is all-or-nothing when any selected note is blocked. Duplicate stable IDs also
refuse deletion because the parent identity is ambiguous.

```text
Error: Refusing to delete Ideas/Launch Brief.md: fork lineage would be orphaned
  Ideas/Launch Brief.md: 1 direct fork child
    - Ideas/Launch Brief — concise.md
Use --force to delete anyway; child fork provenance will be left dangling.
```

JSON refusals include a machine-readable `reason` (`has-fork-children` or
`duplicate-identity`) and the affected paths:

```json
{
  "success": false,
  "error": "Refusing to delete Ideas/Launch Brief.md: fork lineage would be orphaned",
  "code": 1,
  "data": {
    "path": "Ideas/Launch Brief.md",
    "reason": "has-fork-children",
    "childCount": 1,
    "children": [{ "path": "Ideas/Launch Brief — concise.md" }]
  }
}
```

`--force` is the sole override. It deletes only the selected note: children are
not deleted or reparented, and their `forked-from` value stays intact. A later
`bwrb audit` reports that retained provenance as `dangling-forked-from`, so the
source can still be restored deliberately.

### Concurrent target disappearance

Without `--force`, bwrb selects the requested notes and then rechecks them while
holding the same lineage locks used by fork and adoption. If another process
deletes a selected target before that authoritative recheck, the command stops
without deleting any of the remaining selected notes and returns exit code `2`:

```text
Error: Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Launch Brief.md
```

JSON output keeps the numeric exit-code contract and adds stable retry context:

```json
{
  "success": false,
  "error": "Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Launch Brief.md",
  "data": {
    "reason": "target-disappeared",
    "retryable": true,
    "paths": ["Ideas/Launch Brief.md"]
  },
  "code": 2
}
```

Re-resolve the target set before retrying. This is distinct from an initial
not-found result: the note existed during selection but vanished while the
command was coordinating its write.

## Examples

### Single-file Mode

```bash
# Delete specific note with confirmation
bwrb delete "My Note"

# Skip confirmation
bwrb delete "My Note" --force

# Scripting mode
bwrb delete "My Note" --output json --force

# Preview delete without removing (no --force needed)
bwrb delete "My Note" --dry-run --output json
```

When a note is actually deleted, bwrb also removes the matching path from `.bwrb/ids.jsonl`.

### Bulk Mode

```bash
# Preview deletions (dry-run)
bwrb delete --type task

# Actually delete all tasks
bwrb delete --type task --execute

# Explicit dry-run preview
bwrb delete --type task --dry-run

# Delete all notes in Archive
bwrb delete --path "Archive/**" -x

# Delete by content
bwrb delete --body "DELETE ME" --execute

# Delete with frontmatter filter
bwrb delete --where "status=archived" --execute

# Delete ALL notes (dangerous!)
bwrb delete --all --execute

# Scoped delete (query + targeting)
bwrb delete --type idea "Sample Idea" --execute
```

## Picker Modes

When query is ambiguous (single-file mode):

| Mode | Behavior |
|------|----------|
| `auto` | Use fzf if available, else numbered select (default) |
| `fzf` | Force fzf (error if unavailable) |
| `numbered` | Force numbered select |
| `none` | Error on ambiguity (for non-interactive use) |

## Recovery

Deletion is permanent. Use version control (git) to recover deleted notes if needed.

`bwrb audit --fix` can offer a delete action for specific issue classes, but it remains interactive-only and never runs in `--auto` mode. For non-interactive or scripted deletion workflows, use `bwrb delete`.

## See Also

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — `--execute` vs `--force` semantics
- [bwrb bulk](/reference/commands/bulk/) — Batch operations (non-destructive)
- [Targeting Model](/reference/targeting/) — Selector reference
