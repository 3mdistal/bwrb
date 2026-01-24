---
title: bwrb search
description: Find notes by name or content
---

Search for notes by name or content, with interactive selection and multiple output formats.

## Synopsis

```bash
bwrb search [options] [query]
```

## Modes

Search operates in two modes:

- **Name search** (default): Searches by note name, basename, or path
- **Content search** (`--body`): Full-text search across note contents using ripgrep

## Options

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `paths`, `link`, `content`, `json` |
| `--preview` | Show file preview in fzf picker |
| `--picker <mode>` | Selection mode: `auto`, `fzf`, `numbered`, `none` |

### Actions

| Option | Description |
|--------|-------------|
| `-o, --open` | Open the selected note after search |
| `--edit` | Edit the selected note's frontmatter after search |
| `--json <patch>` | JSON patch data for `--edit` mode (non-interactive) |
| `--app <mode>` | How to open: `system`, `editor`, `visual`, `obsidian`, `print` |

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Restrict search to a type |
| `-p, --path <pattern>` | Filter by file path glob pattern |
| `-w, --where <expr>` | Filter results by frontmatter expression (repeatable) |
| `-b, --body` | Enable content search mode |

### Content Search Options

| Option | Description |
|--------|-------------|
| `-C, --context <lines>` | Lines of context around matches (default: 2) |
| `--no-context` | Do not show context lines |
| `-S, --case-sensitive` | Case-sensitive search (default: case-insensitive) |
| `-E, --regex` | Treat pattern as regex (default: literal) |
| `-l, --limit <count>` | Maximum files to return (default: 100) |

## Output Formats

| Format | Description |
|--------|-------------|
| `text` | Note name (default) |
| `paths` | Vault-relative path with extension |
| `link` | Wikilink format (`[[Note Name]]`) |
| `content` | Full file contents (frontmatter + body) |
| `json` | JSON with metadata and matches |

## Examples

### Name Search

```bash
# Find by name
bwrb search "My Note"

# Output as wikilink
bwrb search "My Note" --output link
# Output: [[My Note]]

# Find and open with default app (system by default)
bwrb search "My Note" --open

# Find and open in $EDITOR
bwrb search "My Note" --open --app editor

# Find and edit frontmatter
bwrb search "My Note" --edit

# Non-interactive edit
bwrb search "My Note" --edit --json '{"status":"done"}'
```

### Content Search

```bash
# Search all notes for "deploy"
bwrb search "deploy" --body

# Search only in tasks
bwrb search "deploy" -b -t task

# Filter by frontmatter
bwrb search "TODO" -b --where "status != 'done'"

# Regex search
bwrb search "error.*log" -b --regex

# JSON output with matches
bwrb search "deploy" -b --output json

# Search and open first match
bwrb search "deploy" -b --open
```

### Piping

```bash
# Open results in VS Code
bwrb search "bug" --output paths | xargs -I {} code {}
```

## Picker Modes

| Mode | Behavior |
|------|----------|
| `auto` | Use fzf if available, else numbered select (default) |
| `fzf` | Force fzf (error if unavailable) |
| `numbered` | Force numbered select |
| `none` | Error on ambiguity (for non-interactive use) |

## Wikilink Format

Uses shortest unambiguous form:
- Unique basename: `[[My Note]]`
- Ambiguous (multiple notes with same name): `[[Ideas/My Note]]`

## App Mode Precedence

1. `--app` flag (explicit)
2. `BWRB_DEFAULT_APP` environment variable
3. `config.open_with` in `.bwrb/schema.json`
4. Fallback: `system`

## See Also

- [bwrb open](/reference/commands/open/) — Alias for `search --open`
- [bwrb edit](/reference/commands/edit/) — Alias for `search --edit`
- [Targeting Model](/reference/targeting/) — Selector reference
