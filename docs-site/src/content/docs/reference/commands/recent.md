---
title: bwrb recent
description: List recently modified notes, most-recent first
---

List recently modified notes, ordered by file modification time (most-recent
first). This is thin sugar over [`bwrb list`](/reference/commands/list/) for the
common "what did I touch lately?" query.

## Synopsis

```bash
bwrb recent [options] [positional]
```

The positional argument is auto-detected as type, path (contains `/`), or where
expression (contains operators) — the same smart detection used by `list`.

## Recency source

`recent` orders notes by their **file modification time (mtime)** from the
filesystem. This is deterministic, requires no frontmatter convention, and is
the "useful half" of a recency command (recently *modified* notes). It does not
track an action log of edits made via the CLI — use git history for that.

There is no frontmatter fallback: every file on disk has an mtime, so the source
is always available.

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type path (e.g., `idea`, `objective/task`) |
| `-p, --path <glob>` | Filter by file path glob (e.g., `Projects/**`, `Ideas/`) |
| `-w, --where <expr>` | Filter with expression (repeatable, ANDed together) |
| `-b, --body <query>` | Filter by body content search |

### Output

| Option | Description |
|--------|-------------|
| `--limit <n>` | Show only the first `n` notes (default `20`) |
| `--output <format>` | Output format: `text`, `paths`, `link`, `json` |

## Output Formats

| Format | Description |
|--------|-------------|
| `text` | `NAME` / `MODIFIED` table (default) |
| `paths` | Vault-relative file paths |
| `link` | Wikilinks (`[[Note Name]]`) |
| `json` | Full JSON data including the modification timestamp |

## Examples

```bash
# 20 most recently modified notes
bwrb recent

# Only the 5 most recent
bwrb recent --limit 5

# Most recently modified tasks
bwrb recent --type task

# Recently modified notes under a folder
bwrb recent --path "Projects/**"

# Machine-readable output
bwrb recent --output paths
bwrb recent --output json
```

## JSON output

Each entry includes `_path`, `_name`, an ISO-8601 `_modified` timestamp (the
mtime used for ordering), and the note's frontmatter spread in — consistent with
`bwrb list --output json` plus the `_modified` field.

```bash
bwrb recent --type idea --limit 2 --output json
```

```json
[
  {
    "_path": "Ideas/Another Idea.md",
    "_name": "Another Idea",
    "_modified": "2026-06-20T14:31:07.000Z",
    "type": "idea",
    "status": "backlog",
    "priority": "high"
  },
  {
    "_path": "Ideas/Sample Idea.md",
    "_name": "Sample Idea",
    "_modified": "2026-06-19T09:12:44.000Z",
    "type": "idea",
    "status": "raw",
    "priority": "medium"
  }
]
```

Notes with identical modification times are ordered alphabetically by name so
output is deterministic.

## Equivalent `list` query

`recent` is a convenience wrapper. The closest hand-written equivalent is a
listing sorted by mtime, descending, with a limit — `recent` adds the `_modified`
field and a sensible default limit on top.
