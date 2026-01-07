---
title: bwrb bulk
description: Batch frontmatter operations
---

Perform batch operations on multiple notes.

## Usage

```bash
bwrb bulk <operation> [options]
```

## Examples

```bash
# Set field on all matching notes
bwrb bulk set status=done --type task --where "status = 'active'"

# Preview changes
bwrb bulk set priority=high --type task

# Apply changes
bwrb bulk set priority=high --type task --execute
```

## Operations

- `set <field>=<value>` — Set field to value
- `remove <field>` — Remove field
- `rename <old>=<new>` — Rename field

## Options

| Option | Description |
|--------|-------------|
| `--type <type>` | Target type |
| `--path <dir>` | Target directory |
| `--where <expr>` | Filter expression |
| `-x, --execute` | Apply changes |
| `--output json` | JSON output |

## Safety

- **Dry-run by default** — Shows preview
- **Backup created** — Original files preserved
- **Transaction safety** — All-or-nothing

## See Also

- [Targeting model](/reference/targeting/)
- [bwrb audit](/reference/commands/audit/)
