---
title: bwrb search (compatibility)
description: Legacy search command retained for script compatibility
---

`bwrb search` remains callable for existing scripts, but is hidden from the
canonical top-level help and completion lists. New workflows should use
[`bwrb list`](/reference/commands/list/), which provides the same name-resolution,
fuzzy-search, content-search, picker, and opening capabilities.

Existing `search` flags and output contracts have not been reinterpreted. In
particular, `search --edit --json <patch>` still means a frontmatter edit; it
does **not** mean JSON query output.

## Mappings

| Compatibility invocation | Canonical invocation |
|---|---|
| `bwrb search "Note"` | `bwrb list --name "Note"` |
| `bwrb search "Note" --output link` | `bwrb list --name "Note" --output link` |
| `bwrb search "Name" --fuzzy` | `bwrb list --fuzzy "Name"` |
| `bwrb search "TODO" --body` | `bwrb list --body "TODO" --matches` |
| `bwrb search "Note" --open --app editor` | `bwrb list --name "Note" --open --app editor` |
| `bwrb search "Note" --edit --json '{...}'` | `bwrb edit "Note" --json '{...}'` |

The deprecated `--wikilink`, `--path-output`, `--content`, `--text`, and
`--path-glob` flags continue to behave exactly as they did on `search`. Prefer
`list`'s `--output`, `--body`, and `--path` forms in new code.
