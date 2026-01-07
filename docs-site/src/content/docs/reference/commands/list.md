---
title: bwrb list
description: Query and filter notes by type and fields
---

List notes matching type and filter criteria.

## Usage

```bash
bwrb list [type] [options]
```

## Examples

```bash
# List all notes of a type
bwrb list task
bwrb list objective/milestone

# With field columns
bwrb list task --fields=status,priority

# Filter with expressions
bwrb list task --where "status = 'active'"

# Output paths
bwrb list task --output paths

# JSON output
bwrb list task --output json
```

## Options

| Option | Description |
|--------|-------------|
| `--type <type>` | Filter by type |
| `--path <dir>` | Filter by directory |
| `--where <expr>` | Filter expression |
| `--fields <list>` | Columns to display |
| `--output <format>` | Output format: `names`, `paths`, `json` |
| `--save-as <name>` | Save query as dashboard |

## Output Formats

- `names` — Note names only (default)
- `paths` — Vault-relative paths
- `json` — Full JSON data

## See Also

- [Targeting model](/reference/targeting/)
- [bwrb dashboard](/reference/commands/dashboard/)
