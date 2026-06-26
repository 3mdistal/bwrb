---
title: bwrb recent
description: List recently modified notes, most-recent first
---

List recently modified notes, ordered by file modification time (most-recent
first). This is thin sugar over [`bwrb list`](/reference/commands/list/) for the
common "what did I touch lately?" query.

## Synopsis

```bash
bwrb recent [options] [positional] [mode]
```

The first positional argument is auto-detected as type, path (contains `/`), or
where expression (contains operators) — the same smart detection used by `list`.

The optional second positional `[mode]` is the app mode used with `--open`
(`system`, `editor`, `visual`, `obsidian`, `print`) — parity with
[`bwrb open`](/reference/commands/open/). Because `[mode]` is the **second**
positional, a lone positional is always treated as the smart filter, never the
mode: use `bwrb recent task print --open`, not `bwrb recent print --open` (which
would treat `print` as a type filter). To set the mode without a filter
positional, use the `--app` flag. An explicit `--app` flag always takes
precedence over the positional `[mode]`, and an invalid mode value is rejected
with a clear error. Excess positional arguments beyond `[positional] [mode]` are
rejected.

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

### Actions

| Option | Description |
|--------|-------------|
| `-o, --open` | Open the most recent note (picker if several, in a TTY) |
| `--app <mode>` | How to open: `system`, `editor`, `visual`, `obsidian`, `print` |
| `--save-as <name>` | Save this recency query as a dashboard |
| `--force` | Overwrite an existing dashboard when using `--save-as` |

These mirror the equivalent [`bwrb list`](/reference/commands/list/) flags. With
`--open`, a single result opens directly; in a TTY with several results you get
an interactive picker; non-interactively the most recent note (the top result)
is opened. `--save-as` persists the query as a dashboard stored in the canonical
`list --sort file.mtime --desc` form (with the effective `--limit`), so running
the saved dashboard reproduces the recency view.

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

# Open the most recent note (or the most recent task, in your editor)
bwrb recent --open
bwrb recent --type task --open --app editor

# Positional app mode (the filter positional comes first, then the mode)
bwrb recent task print --open

# Save a recency view as a reusable dashboard
bwrb recent --type task --save-as "recent-tasks"
bwrb dashboard recent-tasks
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

`recent` is a convenience wrapper. The hand-written equivalent is:

```bash
bwrb list --sort file.mtime --desc --limit 20
```

`recent` adds the `_modified` field to JSON output, a `NAME` / `MODIFIED` default
table, and a sensible default limit on top. The `file.mtime` / `file.ctime` /
`file.size` sort keys it relies on are also available directly on `list`.
