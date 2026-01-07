---
title: bwrb open
description: Open notes in editor or Obsidian
---

Open a note by query in your preferred application. This is an alias for `search --open`.

## Synopsis

```bash
bwrb open [options] [query]
```

## Options

| Option | Description |
|--------|-------------|
| `-a, --app <mode>` | Application to open with |
| `--picker <mode>` | Picker mode: `fzf`, `numbered`, `none` |
| `-o, --output <format>` | Output format: `text`, `json` |
| `--preview` | Show preview in fzf picker |
| `-t, --type <type>` | Filter by note type |
| `-p, --path <glob>` | Filter by path pattern |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <pattern>` | Filter by body content pattern |

## App Modes

| Mode | Description |
|------|-------------|
| `system` | Open with OS default handler (default) |
| `editor` | Open in terminal editor (`$EDITOR` or `config.editor`) |
| `visual` | Open in GUI editor (`$VISUAL` or `config.visual`) |
| `obsidian` | Open in Obsidian via URI scheme |
| `print` | Print path to stdout (for scripting) |

## Examples

### Basic Usage

```bash
# Browse all notes with picker
bwrb open

# Open specific note (uses config default)
bwrb open "My Note"

# Open in Obsidian
bwrb open "My Note" --app obsidian

# Open in $EDITOR
bwrb open "My Note" --app editor
```

### With Targeting

```bash
# Pick from all tasks
bwrb open --type task

# Pick from active notes
bwrb open --where "status=active"

# Open high-priority task
bwrb open -t task -w "priority=high"

# Find and open note containing TODO
bwrb open --body "TODO"
```

## App Mode Precedence

The default app is determined by:

1. `--app` flag (explicit)
2. `BWRB_DEFAULT_APP` environment variable
3. `config.open_with` in `.bwrb/schema.json`
4. Fallback: `system`

```bash
# Set default via environment
export BWRB_DEFAULT_APP=editor
bwrb open "My Note"  # Opens in $EDITOR
```

## Picker Modes

| Mode | Behavior |
|------|----------|
| `fzf` | Interactive fuzzy finder (default) |
| `numbered` | Numbered list selection |
| `none` | No picker - fail if ambiguous |

## See Also

- [bwrb search](/reference/commands/search/) — Full search command
- [bwrb edit](/reference/commands/edit/) — Edit note frontmatter
- [Targeting Model](/reference/targeting/) — Selector reference
