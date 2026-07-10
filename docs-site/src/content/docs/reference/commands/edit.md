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

When you pass a note query and omit `--type`, `edit` uses the same name/path matching behavior as `search`:

- **1 match:** edit proceeds
- **0 matches:** error
- **>1 match with `--picker none` or JSON mode:** error listing candidates; disambiguate with `--type`, `--path`, or a vault-relative path

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
