---
title: bwrb edit
description: Modify existing note frontmatter
---

Edit the frontmatter of an existing note.

## Usage

```bash
bwrb edit <path>
bwrb edit [query]
```

## Examples

```bash
# Edit by path
bwrb edit "Projects/My Task.md"

# Edit by query (picker if ambiguous)
bwrb edit "My Task"

# JSON mode
bwrb edit "My Task" --json '{"status": "done"}'
```

## Options

| Option | Description |
|--------|-------------|
| `--json <data>` | Update fields from JSON |
| `--picker <mode>` | Picker for ambiguous matches: `auto`, `fzf`, `numbered`, `none` |
| `--output json` | Output result as JSON |

## Behavior

1. Resolves target file
2. Loads current frontmatter
3. Prompts for field updates
4. Preserves body content
5. Writes updated file

## See Also

- [bwrb open](/reference/commands/open/)
- [bwrb bulk](/reference/commands/bulk/)
