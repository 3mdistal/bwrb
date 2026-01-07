---
title: config edit
description: Edit configuration values
---

Modify vault configuration values.

## Synopsis

```bash
bwrb config edit [options] [option]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `option` | Specific option to edit (prompts if omitted) |

## Options

| Option | Description |
|--------|-------------|
| `--json <value>` | Set value directly (JSON mode) |
| `-o, --output <format>` | Output format: `text`, `json` |

## Examples

### Interactive Editing

```bash
# Edit with picker
bwrb config edit

# Edit specific option
bwrb config edit open_with
bwrb config edit link_format
```

### Non-interactive (JSON) Mode

```bash
# Set string value
bwrb config edit open_with --json '"editor"'

# Set complex value
bwrb config edit obsidian_vault --json '"My Vault"'
```

## See Also

- [bwrb config](/reference/commands/config/) — Config command overview
- [config list](/reference/commands/config/list/) — View configuration
