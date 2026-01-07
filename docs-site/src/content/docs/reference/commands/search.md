---
title: bwrb search
description: Find notes and generate wikilinks
---

Search for notes and optionally generate wikilinks.

## Usage

```bash
bwrb search [query]
```

## Examples

```bash
# Browse all notes
bwrb search

# Find and output name
bwrb search "My Note"

# Generate wikilink
bwrb search "My Note" --wikilink
# Output: [[My Note]]

# JSON output for scripting
bwrb search "My Note" --output json
```

## Options

| Option | Description |
|--------|-------------|
| `--wikilink` | Output as wikilink format |
| `--picker <mode>` | Picker: `auto`, `fzf`, `numbered`, `none` |
| `--output json` | JSON output |

## Wikilink Format

Uses shortest unambiguous form:

- Unique basename: `[[My Note]]`
- Ambiguous: `[[Ideas/My Note]]`

## See Also

- [bwrb open](/reference/commands/open/)
