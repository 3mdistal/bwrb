---
title: bwrb open
description: Open notes in editor or Obsidian
---

Open a note by query in your preferred application.

## Usage

```bash
bwrb open [query]
```

## Examples

```bash
# Browse all notes with picker
bwrb open

# Open specific note
bwrb open "My Note"

# Open in editor
bwrb open "My Note" --app editor

# Just print the path
bwrb open "My Note" --app print
```

## Options

| Option | Description |
|--------|-------------|
| `--app <mode>` | App mode: `system`, `editor`, `visual`, `obsidian`, `print` |
| `--picker <mode>` | Picker: `auto`, `fzf`, `numbered`, `none` |
| `--output json` | JSON output (implies `--app print`) |

## App Modes

- `system` — OS default handler (default)
- `editor` — `$EDITOR` environment variable
- `visual` — `$VISUAL` environment variable
- `obsidian` — Obsidian via URI scheme
- `print` — Just print the resolved path

## See Also

- [bwrb search](/reference/commands/search/)
