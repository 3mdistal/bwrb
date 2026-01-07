---
title: schema list
description: List schema contents
---

List schema contents including types, fields, and detailed type information.

## Synopsis

```bash
bwrb schema list [options]
bwrb schema list types [options]
bwrb schema list fields [options]
bwrb schema list type [options] <name>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| (none) | Show full schema overview |
| `types` | List type names only |
| `fields` | List all fields across all types |
| `type <name>` | Show details for a specific type |

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Examples

```bash
# Show full schema overview
bwrb schema list

# List all type names
bwrb schema list types

# List all fields across types
bwrb schema list fields

# Show details for a specific type
bwrb schema list type task
bwrb schema list type objective/milestone

# JSON output for scripting
bwrb schema list --output json
bwrb schema list type task --output json
```

## See Also

- [bwrb schema](/reference/commands/schema/) — Schema command overview
- [Schema concepts](/concepts/schema/) — Schema structure
