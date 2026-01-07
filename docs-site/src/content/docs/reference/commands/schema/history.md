---
title: schema history
description: Show migration history
---

View the history of schema migrations applied to your vault.

## Synopsis

```bash
bwrb schema history [options]
```

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Description

Shows a log of all migrations that have been applied:

- Migration timestamp
- Changes included
- Files affected

## Examples

```bash
# Show migration history
bwrb schema history

# JSON output
bwrb schema history --output json
```

## See Also

- [bwrb schema migrate](/reference/commands/schema/migrate/) — Apply migrations
- [Migrations](/concepts/migrations/) — Migration concepts
