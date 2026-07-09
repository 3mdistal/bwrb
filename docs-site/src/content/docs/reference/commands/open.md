---
title: bwrb open (compatibility)
description: Legacy open command retained for script compatibility
---

`bwrb open` remains callable with its existing flags and output contracts, but
is hidden from the canonical top-level help and completion lists. New workflows
should resolve and open through [`bwrb list`](/reference/commands/list/).

## Mappings

| Compatibility invocation | Canonical invocation |
|---|---|
| `bwrb open "My Note"` | `bwrb list --name "My Note" --open` |
| `bwrb open "My Note" print` | `bwrb list --name "My Note" --open --app print` |
| `bwrb open --id "<uuid>" --app print` | `bwrb list --id "<uuid>" --open --app print` |
| `bwrb open --type task` | `bwrb list --type task --open` |
| `bwrb open --body "TODO"` | `bwrb list --body "TODO" --open` |

The `--app`, `--picker`, `--preview`, `--output`, local `--vault`, and composed
targeting flags remain supported on the compatibility command. New automation
should prefer `--picker none` or global `--non-interactive` to avoid prompts.
