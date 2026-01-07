---
title: schema migrate
description: Apply schema changes to notes
---

Apply schema changes to existing notes in your vault.

## Synopsis

```bash
bwrb schema migrate [options]
```

## Options

| Option | Description |
|--------|-------------|
| `-x, --execute` | Actually apply the migration (default is dry-run) |
| `--no-backup` | Skip backup creation (not recommended) |
| `-o, --output <format>` | Output format: `text`, `json` |

## Description

Migrations update existing notes when the schema changes:

- Add new required fields with default values
- Remove deleted fields
- Rename fields
- Update enum values
- Move files to new output directories

## Safety

- **Dry-run by default**: Shows what would change without modifying files
- **Automatic backup**: Creates a backup before applying changes
- **Atomic operations**: All changes succeed or none are applied

## Examples

```bash
# Preview migration (dry-run)
bwrb schema migrate

# Apply migration with backup
bwrb schema migrate --execute

# Apply without backup (not recommended)
bwrb schema migrate --execute --no-backup
```

## Workflow

1. Make changes to `.bwrb/schema.json`
2. Run `bwrb schema diff` to preview changes
3. Run `bwrb schema migrate` to preview note updates
4. Run `bwrb schema migrate --execute` to apply

## See Also

- [bwrb schema diff](/reference/commands/schema/diff/) — Preview schema changes
- [Migrations](/concepts/migrations/) — Migration concepts
