---
title: bwrb schema
description: Schema introspection and management
---

Inspect and manage your vault's schema definition.

## Synopsis

```bash
bwrb schema <subcommand>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [list](/reference/commands/schema/list/) | List schema contents |
| [validate](/reference/commands/schema/validate/) | Validate schema structure |
| [diff](/reference/commands/schema/diff/) | Show pending schema changes |
| [migrate](/reference/commands/schema/migrate/) | Apply schema changes to notes |
| [history](/reference/commands/schema/history/) | Show migration history |

## Quick Examples

```bash
# List all types
bwrb schema list

# Show specific type details
bwrb schema list type task

# Validate schema structure
bwrb schema validate

# Preview migration
bwrb schema diff

# Apply migration
bwrb schema migrate --execute
```

## See Also

- [Schema concepts](/concepts/schema/) — Understanding schema structure
- [Migrations](/concepts/migrations/) — Migration workflow
