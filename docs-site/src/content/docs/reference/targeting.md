---
title: Targeting Model
description: How to specify which notes commands operate on
---

Most Bowerbird commands need to know which notes to operate on. The targeting model provides a consistent way to specify this across all commands.

## Target Types

### By Type

Specify the note type:

```bash
bwrb list task
bwrb list objective/milestone
```

### By Path

Target notes in a specific directory:

```bash
bwrb list --path "Projects/"
bwrb audit --path "Archive/"
```

### By Query

Filter using expressions:

```bash
bwrb list task --where "status = 'active'"
bwrb list --where "priority = 'high' && status != 'done'"
```

## Query Syntax

Bowerbird uses a simple expression language:

| Operator | Meaning |
|----------|---------|
| `=` | Equals |
| `!=` | Not equals |
| `>`, `<`, `>=`, `<=` | Comparison |
| `&&` | And |
| `\|\|` | Or |
| `contains()` | String contains |

## Combining Targets

Targets can be combined:

```bash
bwrb list task --path "Projects/" --where "status = 'active'"
```

## Next Steps

- [Commands reference](/reference/commands/list/) — See targeting in action
