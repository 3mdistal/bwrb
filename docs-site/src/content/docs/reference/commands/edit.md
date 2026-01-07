---
title: bwrb edit
description: Modify existing note frontmatter
---

Edit the frontmatter of an existing note. This is an alias for `search --edit`.

## Synopsis

```bash
bwrb edit [options] [query]
```

## Options

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by note type |
| `-p, --path <glob>` | Filter by path pattern |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <pattern>` | Filter by body content |
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
bwrb edit "My Task" --json '{"status":"done"}'

# Update multiple fields
bwrb edit -t task --where "status == 'active'" "Deploy" --json '{"priority":"high"}'
```

### Edit and Open

```bash
# Open the note after editing
bwrb edit "My Note" --open

# Edit then open in $EDITOR
bwrb edit "My Note" --open --app editor
```

## Targeting

Edit supports all four targeting selectors. See [Targeting Model](/reference/targeting/) for details.

```bash
# Combine selectors to narrow results
bwrb edit -t task -p "Work/**" -w "status == 'active'" "Deploy"
```

## Picker Modes

When multiple notes match your query:

| Mode | Behavior |
|------|----------|
| `fzf` | Interactive fuzzy finder (default) |
| `numbered` | Numbered list selection |
| `none` | Error on ambiguity (for scripting) |

## See Also

- [bwrb search](/reference/commands/search/) — Full search command (edit is an alias)
- [bwrb open](/reference/commands/open/) — Open notes without editing
- [bwrb bulk](/reference/commands/bulk/) — Batch frontmatter changes
- [Targeting Model](/reference/targeting/) — Selector reference
