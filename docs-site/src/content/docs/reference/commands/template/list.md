---
title: template list
description: List templates
---

List templates in your vault, optionally filtered by type.

## Synopsis

```bash
bwrb template list [options] [type] [name]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `type` | Filter to templates for this type (e.g., `task`, `objective/milestone`) |
| `name` | Show details for a specific template |

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Examples

```bash
# List all templates
bwrb template list

# List templates for a specific type
bwrb template list task
bwrb template list objective/task

# Show specific template details
bwrb template list task bug-report

# JSON output
bwrb template list --output json
```

## See Also

- [bwrb template](/reference/commands/template/) — Template command overview
- [Templates Overview](/templates/overview/) — Template concepts
