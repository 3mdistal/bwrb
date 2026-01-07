---
title: schema diff
description: Show pending schema changes
---

Show changes to the schema since the last migration.

## Synopsis

```bash
bwrb schema diff [options]
```

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Description

Compares the current schema.json against the last migration snapshot to show:

- New types added
- Types removed
- Fields added to types
- Fields removed from types
- Field definitions changed
- Enum values changed

## Examples

```bash
# Show what changed
bwrb schema diff

# JSON output for scripting
bwrb schema diff --output json
```

## Workflow

1. Make changes to `.bwrb/schema.json`
2. Run `bwrb schema diff` to preview changes
3. Run `bwrb schema migrate` to apply changes to existing notes

## See Also

- [bwrb schema migrate](/reference/commands/schema/migrate/) — Apply schema changes
- [Migrations](/concepts/migrations/) — Migration workflow
