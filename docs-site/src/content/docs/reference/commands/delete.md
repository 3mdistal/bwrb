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

Delete operates in two modes:

- **Single-file mode** (default): Delete a specific note by name/query
- **Bulk mode**: Delete multiple notes matching targeting selectors

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type |
| `-p, --path <glob>` | Filter by path glob |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <query>` | Filter by body content search |
| `-a, --all` | Select all notes (required for bulk delete without other targeting) |

### Execution

| Option | Description |
|--------|-------------|
| `-x, --execute` | Actually delete files (default is dry-run for bulk) |
| `-f, --force` | Skip confirmation prompt (single-file mode) |
| `--picker <mode>` | Selection mode: `auto`, `fzf`, `numbered`, `none` |
| `--output <format>` | Output format: `text`, `json` |

## Safety: Two-Gate Model

Bulk delete requires **two explicit gates** to prevent accidents:

1. **Targeting gate**: Must specify at least one selector (`--type`, `--path`, `--where`, `--body`) OR use `--all`
2. **Execution gate**: Must use `--execute` to actually delete (dry-run by default)

```bash
# Error: no targeting specified
bwrb delete
# "No files selected. Use --type, --path, --where, --body, or --all."

# Dry-run: shows what would be deleted
bwrb delete --type task

# Actually deletes
bwrb delete --type task --execute
```

## Examples

### Single-file Mode

```bash
# Delete specific note with confirmation
bwrb delete "My Note"

# Skip confirmation
bwrb delete "My Note" --force

# Scripting mode
bwrb delete "My Note" --output json --force
```

### Bulk Mode

```bash
# Preview deletions (dry-run)
bwrb delete --type task

# Actually delete all tasks
bwrb delete --type task --execute

# Delete all notes in Archive
bwrb delete --path "Archive/**" -x

# Delete by content
bwrb delete --body "DELETE ME" --execute

# Delete with frontmatter filter
bwrb delete --where "status=archived" --execute

# Delete ALL notes (dangerous!)
bwrb delete --all --execute
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

## See Also

- [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — `--execute` vs `--force` semantics
- [bwrb bulk](/reference/commands/bulk/) — Batch operations (non-destructive)
- [Targeting Model](/reference/targeting/) — Selector reference

