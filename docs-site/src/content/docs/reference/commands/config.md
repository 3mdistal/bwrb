---
title: bwrb config
description: Vault configuration settings
---

Manage vault-wide configuration options.

## Synopsis

```bash
bwrb config <subcommand>
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [list](/reference/commands/config/list/) | Show configuration values |
| [edit](/reference/commands/config/edit/) | Edit configuration values |

## Quick Examples

```bash
# Show all configuration
bwrb config list

# Show specific option
bwrb config list open_with

# Edit configuration
bwrb config edit open_with

# Set via JSON
bwrb config edit open_with --json '"editor"'
```

## Available Options

| Option | Description | Values |
|--------|-------------|--------|
| `link_format` | How relations are formatted | `wikilink`, `markdown` |
| `editor` | Terminal editor command | Path or command |
| `visual` | GUI editor command | Path or command |
| `open_with` | Default app for opening notes | `system`, `editor`, `visual`, `obsidian` |
| `obsidian_vault` | Obsidian vault name for URI scheme | String |

## Configuration Location

Configuration is stored in `.bwrb/schema.json` under the `config` key.

## See Also

- [Schema concepts](/concepts/schema/) — Schema structure
