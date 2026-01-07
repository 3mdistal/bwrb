---
title: config list
description: Show configuration values
---

Display vault configuration values.

## Synopsis

```bash
bwrb config list [options] [option]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `option` | Specific option to show (shows all if omitted) |

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <format>` | Output format: `text`, `json` |

## Examples

```bash
# Show all configuration
bwrb config list

# Show specific option
bwrb config list open_with
bwrb config list link_format

# JSON output
bwrb config list --output json
```

## See Also

- [bwrb config](/reference/commands/config/) — Config command overview
- [config edit](/reference/commands/config/edit/) — Modify configuration
