---
title: template delete
description: Delete a template
---

Delete a template from your vault.

## Synopsis

```bash
bwrb template delete [options] [type] [name]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `type` | Type of template to delete |
| `name` | Template name (shows picker if omitted) |

## Options

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |
| `-o, --output <format>` | Output format: `text`, `json` |

## Examples

```bash
# Delete with confirmation
bwrb template delete task bug-report

# Delete with picker
bwrb template delete

# Skip confirmation
bwrb template delete task bug-report --force

# Scripting mode
bwrb template delete task bug-report -f -o json
```

## See Also

- [bwrb template](/reference/commands/template/) — Template command overview
